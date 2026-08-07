// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * simulation-kernel.ts — the single transport-owning orchestrator (Plan 194 §2.1).
 *
 * The `SimulationKernel` holds exactly ONE active `SimulationExecutor` at a time
 * — the public `ContinuousRunner` (default) or, when the private side registers
 * one, the `DESRunner`. It is the static form of the old dynamic
 * `_physicsPluginActive` mutex: `handlesTransport` is a const `true` because the
 * active executor (continuous OR des) is always exactly one, and that one always
 * drives transport (Plan 194 §2.7 / §11.3).
 *
 * `setMode()` is **Reset-on-Switch** (Plan 194 §3.3, F8): `clearMUs()` on the
 * outgoing executor, then `start()` on the incoming one (fresh, empty — Sources
 * re-spawn with the same PRNG seed). There is NO `KernelSnapshot` / reconcile in
 * v1. The switch is guarded against rapid re-entry (W4/W5) and wrapped in
 * try/catch so a half-finished switch can never wedge the toggle.
 *
 * DES availability is injected, never imported: `registerDesRunnerFactory()`
 * takes the factory the private side provides (the public build's
 * `des-runner-stub` exports `null`), and `hasDesRunner()` reports it. The public
 * UI toggle reads `hasDesRunner()` and hides DES when false — `SimModeToggle`
 * (P6) never imports `DESRunner` directly (Plan 194 V7).
 */

import type { MaterialFlowDefinition } from './define-material-flow';
import type {
  SimulationExecutor,
  SimulationTopology,
} from './simulation-executor';
import type { CoreSubsystems } from '../engine/rv-core-subsystems';
import { ContinuousRunner } from './continuous-runner';

export type SimulationMode = 'continuous' | 'des';

/**
 * DES sub-mode (Plan 194 §3.2 / F10). Declared here on the PUBLIC kernel surface
 * so `SimModeToggle` (and any public UI) can drive the second toolbar row WITHOUT
 * importing the private `DESRunner`. The private `DESRunner.DesSubMode` is the
 * same string-union — it satisfies this structurally.
 */
export type SimSubMode = 'animated' | 'hybrid' | 'fastforward' | 'step';

/**
 * KPI snapshot the FastForward analysis panel reads (Plan 194 §4.2). Pure data —
 * no private types — so the public KPI panel can render throughput / bottleneck /
 * per-component utilization without reaching into `rv-des-statistics`.
 */
export interface SimKpiSnapshot {
  /** Canonical simulation time in seconds. */
  readonly simTimeSeconds: number;
  /** Aggregate throughput (parts per hour) across the model. */
  readonly throughputPerHour: number;
  /** Highest-utilization component, or null when nothing is loaded yet. */
  readonly bottleneck: { readonly name: string; readonly utilization: number } | null;
  /** Per-component utilization rows for the bar list (0–100%). */
  readonly components: ReadonlyArray<{ readonly name: string; readonly utilization: number }>;
}

/**
 * Lightweight DES clock + event counters the top toolbar reads every poll
 * (Plan 194). Pure data, all O(1) on the manager — so the toolbar can show the
 * sim time (DD:HH:MM:SS), the processed/pending counts and the next-event time
 * without snapshotting the whole queue (that's the Event Queue window's job, and
 * it lives on the private side). No private types cross the boundary.
 */
export interface SimEventStats {
  /** Canonical simulation time in seconds. */
  readonly currentTime: number;
  /** Total events processed since the run started. */
  readonly processed: number;
  /** Number of pending events in the queue (including cancelled). */
  readonly pending: number;
  /** Time of the next event in seconds, or +Infinity when the queue is empty. */
  readonly nextEventTime: number;
}

/**
 * Per-component runtime snapshot for inspection / debugging (MCP `web_des_*`).
 * Pure data, no private types — the public side (MCP bridge, debug panels) reads
 * the live material-flow topology + load without touching the private adapters.
 */
export interface SimDesComponentState {
  /** Component node name (e.g. 'RollConveyor-2m'). */
  readonly name: string;
  /** Definition type (e.g. 'Conveyor', 'Turntable', 'Source'). */
  readonly type: string;
  /** Material-flow kind ('source' | 'conveyor' | 'sink' | 'router' | …). */
  readonly kind: string;
  /** Entity id assigned by the DES manager (-1 before registration). */
  readonly entityId: number;
  /** MUs currently held (occupancy). */
  readonly load: number;
  /** Capacity (MaxCapacity). */
  readonly maxCapacity: number;
  /** MUs in transit (scheduled arrival), when the component tracks it. */
  readonly inTransit: number;
  /** MUs parked waiting for a downstream slot (back-pressure), when tracked. */
  readonly blocked: number;
  /** True while exit is back-pressured. */
  readonly isBlocked: boolean;
  /** Downstream neighbour node names (material-flow wiring). */
  readonly next: ReadonlyArray<string>;
  /** Upstream neighbour node names. */
  readonly prev: ReadonlyArray<string>;
}

/** Per-component utilization statistics (for MCP / analysis). Percentages 0–100. */
export interface SimDesComponentStat {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly working: number;
  readonly setup: number;
  readonly blocked: number;
  readonly empty: number;
  readonly failure: number;
  /** Utilization 0–100 (100 − free-state time). */
  readonly utilization: number;
  readonly outputPerHour: number;
  readonly totalProcessed: number;
  readonly currentState: string;
}

/** DES statistics snapshot (per-component in material-flow order + aggregate). */
export interface SimDesStatistics {
  readonly simTime: number;
  /** Per-component, ordered by material flow (sources first, sinks last). */
  readonly components: ReadonlyArray<SimDesComponentStat>;
  /** The constraining component (highest Working%); null when nothing is active. */
  readonly bottleneck: { readonly path: string; readonly name: string; readonly working: number } | null;
  readonly meanUtilization: number;
  readonly throughputPerHour: number;
}

/**
 * The DES sub-mode / KPI control surface the public UI consumes. The active DES
 * executor (the private `DESRunner`) implements this STRUCTURALLY — the public
 * side only ever sees this interface, never the concrete class (Plan 194 V7). The
 * kernel exposes it via `desControl()`, returning `null` outside DES mode.
 */
export interface SimDesControl {
  /** Current sub-mode. */
  readonly subMode: SimSubMode;
  /** Switch the sub-mode (Animated / Hybrid / FastForward / Step). */
  setSubMode(m: SimSubMode): void;
  /** Sub-mode active before the last switch into FastForward (never
   *  'fastforward'). The FF toggle returns to this mode directly — no dropdown
   *  re-pick. Kept on the executor so it survives UI remounts and covers every
   *  FF entry path (toolbar, MCP, persisted mode). */
  readonly preFastForwardSubMode?: SimSubMode;
  /** HybridSynced multiplier (≥ 1). */
  readonly multiplier: number;
  /** Set the HybridSynced multiplier. */
  setMultiplier(n: number): void;
  /** Canonical sim time in seconds (for displays / KPI). */
  readonly simTime: number;
  /** Process exactly one event (Step mode). Returns false when nothing ran. */
  step(): boolean;
  /** FastForward progress 0–1 when a FF run is in flight; undefined otherwise. */
  readonly ffProgress?: number;
  /** Run FastForward to completion; resolves true when done, false if cancelled. */
  runFastForward?(): Promise<boolean>;
  /** Cancel an in-flight FastForward run. */
  cancelFastForward?(): void;
  /** Current KPI snapshot (throughput / bottleneck / utilization). */
  kpiSnapshot?(): SimKpiSnapshot;
  /** Lightweight clock + event counters for the toolbar (O(1), polled). */
  eventStats?(): SimEventStats;
  /** Sim END time in seconds (the run stops past it); Infinity = run until empty. */
  readonly endTime?: number;
  /** Set the sim end time; pass Infinity for "infinite" (run until the queue empties). */
  setEndTime?(seconds: number): void;
  /** Sim time at which component statistics reset (warmup); 0 = off. */
  readonly statResetTime?: number;
  /** Set the statistics-reset (warmup) time; 0 disables it. */
  setStatResetTime?(seconds: number): void;
  /** Per-component runtime states for inspection / debugging (MCP `web_des_*`). */
  componentStates?(): SimDesComponentState[];
  /** Per-component utilization statistics + bottleneck (MCP `web_des_stats` /
   *  `web_des_bottleneck`), ordered by material flow. */
  statistics?(): SimDesStatistics;
  /** Serialize the DES manager state to JSON (Save Snapshot). */
  snapshotJson?(): string;
  /** Restore the DES manager state from a JSON snapshot (Load Snapshot). */
  restoreJson?(json: string): void;

  // ── Experiment / snapshot management (plan-261) ────────────────────────
  // REPO-BOUNDARY RULE (plan-261 B3): everything below transports STRINGS and
  // primitives only — the manifest crosses as a JSON string (like
  // `snapshotJson`), NEVER as a private type. The private repo does not exist
  // at public build time; a private type in a signature would be a
  // compilability break, not a style issue.

  /** Master PRNG seed of the DES manager. */
  readonly masterSeed?: number;
  /** Set the master seed (takes effect for RNG streams from the next reset). */
  setMasterSeed?(seed: number): void;

  /** All stored {model, experiment} pairs (optionally filtered by model). */
  listExperiments?(model?: string): Promise<Array<{ model: string; experiment: string }>>;
  /** The experiment manifest as a JSON string (null when absent). */
  readManifestJson?(model: string, exp: string): Promise<string | null>;
  /** Snapshot the CURRENT sim state into the store at the current sim time. */
  saveSnapshot?(scope: { model: string; exp: string; repl: number }, label?: string): Promise<void>;
  /** Load a stored snapshot and restore the sim to it (synchronous restore). */
  loadSnapshot?(scope: { model: string; exp: string; repl: number; t: number }): Promise<void>;
  /** Delete one stored snapshot. */
  deleteSnapshot?(scope: { model: string; exp: string; repl: number; t: number }): Promise<void>;
  /** Delete a replication with all its snapshots (cascading). */
  deleteReplication?(scope: { model: string; exp: string; repl: number }): Promise<void>;
  /** Delete an experiment with all replications + snapshots (cascading). */
  deleteExperiment?(model: string, exp: string): Promise<void>;
  /** Rename an experiment (moves all snapshot records). */
  renameExperiment?(model: string, exp: string, newName: string): Promise<void>;
  /** Export one experiment as a portable NDJSON.gz blob. */
  exportExperiment?(model: string, exp: string): Promise<Blob>;
  /** Import an NDJSON.gz experiment; returns the (collision-safe) identity. */
  importExperiment?(file: Blob): Promise<{ model: string; exp: string }>;
  /** Browser storage usage estimate (warn threshold / quota UI). */
  estimateStorage?(): Promise<{ usedBytes: number; quotaBytes: number }>;

  // ── Simulation runs (plan-260) — same string/primitive transport rule ────

  /** JSON of the CURRENT (not yet archived) run — `{ runId, seed, startedAt }`
   *  — or `null` when no run is in flight. Parse with `parseActiveRunInfo`
   *  (rv-run-history-store). */
  activeRunInfoJson?(): string | null;
  /** Create-or-patch an experiment manifest with PUBLIC metadata. `patchJson`
   *  is a JSON object with optional `projectId` / `glbHash` / `baseSeed` —
   *  the project manager tags experiments with their comparison scope this
   *  way (F5/F6/F11) without a private type crossing the seam. */
  patchExperimentMetaJson?(model: string, exp: string, patchJson: string): Promise<void>;

  // ── Experiment batch execution (plan-265) — same string/primitive rule ──
  // The experiment matrix drives N replications per experiment; parameter
  // overrides / replicationCount / paramScript / enabled travel through the
  // manifest JSON via `patchExperimentMetaJson` (never a private type here).

  /** Run N replications of ONE experiment (parameters applied before each run,
   *  seeds derived deterministically; `crn` uses the shared per-slot seed). */
  runExperimentBatch?(scope: { model: string; exp: string },
                      opts: { replications: number; crn: boolean }): Promise<void>;
  /** Run every ENABLED experiment of a model sequentially, N replications each. */
  runAllExperiments?(model: string, opts: { crn: boolean }): Promise<void>;
  /** Cancel an in-flight batch; already-finished replications stay archived. */
  cancelBatch?(): void;
  /** JSON of the current batch progress — `{ exp, replIndex, total, phase }` —
   *  or null when no batch is running (drives the per-column running indicator). */
  batchProgressJson?(): string | null;
}

/**
 * Factory the private DES side provides; `null` in the public build. Same shape
 * as `private-stubs/des-runner-stub.ts` `CreateDesRunner`. The optional `core`
 * is the viewer's CoreSubsystems pipeline the DES runner composes into its
 * tick (drives/visuals keep running at 60 Hz while the event queue advances).
 */
export type DesRunnerFactory =
  | ((defs: MaterialFlowDefinition[], topology: SimulationTopology, core?: CoreSubsystems) => SimulationExecutor)
  | null;

/** Construction dependencies — the viewer's EXISTING continuous runner + topology. */
export interface SimulationKernelOptions {
  /** The continuous executor (wrapping the viewer's shared transport + behaviours). */
  readonly continuousRunner: ContinuousRunner;
  /** Topology handed to an executor on `start()` (scene root). */
  readonly topology: SimulationTopology;
  /** Material-flow definitions in play (continuous discovery already binds them). */
  readonly defs?: MaterialFlowDefinition[];
  /** DES runner factory; defaults to the stub (`null`) → continuous-only public build. */
  readonly desRunnerFactory?: DesRunnerFactory;
  /** The viewer's CoreSubsystems pipeline, forwarded to the DES runner factory
   *  (the continuous runner receives it directly at construction). */
  readonly core?: CoreSubsystems;
  /**
   * Optional callback fired AFTER a successful mode switch (Plan 194 P6). The
   * viewer wires this to emit a `'simulation-mode-changed'` event so the
   * `SimModeToggle` UI re-renders. Pure notification — never mutates the kernel.
   */
  readonly onModeChanged?: (mode: SimulationMode) => void;
}

/**
 * The single transport-owning simulation orchestrator. Drives exactly one
 * `SimulationExecutor` and switches mode via Reset-on-Switch.
 */
export class SimulationKernel {
  /**
   * Static transport mutex — the kernel ALWAYS handles transport because its one
   * active executor always does. Replaces the dynamic `_physicsPluginActive`
   * flag (Plan 194 §2.7 / §11.3).
   */
  static readonly handlesTransport = true;

  /** The continuous executor (always present — the default and the fallback). */
  readonly continuousRunner: ContinuousRunner;

  private readonly topology: SimulationTopology;
  private readonly defs: MaterialFlowDefinition[];
  private desRunnerFactory: DesRunnerFactory;
  private readonly core?: CoreSubsystems;
  private readonly onModeChanged?: (mode: SimulationMode) => void;

  /** The currently active executor (continuous by default). */
  private _active: SimulationExecutor;
  /** Current mode tag. */
  private _mode: SimulationMode = 'continuous';
  /** Re-entrancy guard for `setMode` (W4/W5 rapid-toggle). */
  private _switching = false;
  /** Lazily-built DES executor (kept so a continuous↔des round-trip reuses it). */
  private _desRunner: SimulationExecutor | null = null;

  constructor(opts: SimulationKernelOptions) {
    this.continuousRunner = opts.continuousRunner;
    this.topology = opts.topology;
    this.defs = opts.defs ?? [];
    this.desRunnerFactory = opts.desRunnerFactory ?? null;
    this.core = opts.core;
    this.onModeChanged = opts.onModeChanged;
    this._active = this.continuousRunner;
  }

  // ─── Read accessors ───────────────────────────────────────────────────

  /** The active executor (continuous or des). */
  get activeExecutor(): SimulationExecutor {
    return this._active;
  }

  /** Current mode ('continuous' | 'des'). */
  get mode(): SimulationMode {
    return this._mode;
  }

  /** True while a mode switch is in progress (rapid-toggle guard exposes it for the UI). */
  get isSwitching(): boolean {
    return this._switching;
  }

  /**
   * True when a DES runner factory is registered (i.e. the private side is
   * present). The public build's stub registers `null` → `false`, so the
   * Realtime/DES toggle is hidden (Plan 194 §4.1 / P1).
   */
  hasDesRunner(): boolean {
    return this.desRunnerFactory !== null;
  }

  /**
   * The DES sub-mode / KPI control surface, or `null` when not in DES mode (or
   * the active executor does not expose one). The public UI drives the
   * sub-mode row + reads KPIs through this STRUCTURAL interface — it never sees
   * the concrete (private) `DESRunner` (Plan 194 V7). The cast is purely
   * structural; in the continuous mode (or with the public stub) there is no
   * DES executor, so this returns `null` and the sub-mode row stays hidden.
   */
  desControl(): SimDesControl | null {
    if (this._mode !== 'des') return null;
    const exec = this._active as unknown as Partial<SimDesControl>;
    // Minimal duck-type: a real DES executor exposes setSubMode + subMode.
    if (typeof exec.setSubMode === 'function' && typeof exec.subMode === 'string') {
      return exec as SimDesControl;
    }
    return null;
  }

  // ─── DES registration (injection, never import) ───────────────────────

  /**
   * Register (or clear) the DES runner factory. Called once at wiring time with
   * the factory the private side exports (`des-runner-stub` exports `null` in
   * the public build). Idempotent.
   */
  registerDesRunnerFactory(factory: DesRunnerFactory): void {
    this.desRunnerFactory = factory;
  }

  // ─── Mode switch (Reset-on-Switch) ────────────────────────────────────

  /**
   * Switch the active simulation mode (Plan 194 §3.3 Reset-on-Switch, F8).
   *
   * Guards (W4/W5): no-op when already in `m` OR a switch is in flight. The body
   * is wrapped in try/catch so a failed half-switch never leaves `_switching`
   * latched (which would wedge the toggle permanently).
   *
   * Sequence: `clearMUs()` on the outgoing executor (removes all live MUs) →
   * select/build the incoming executor → `start(defs, topology)` (fresh, empty).
   * Sources re-spawn with the same seed so both modes stay comparable.
   *
   * Switching to 'des' with no registered runner is a guarded no-op (the toggle
   * is hidden in that case anyway).
   */
  setMode(m: SimulationMode): void {
    // Rapid-toggle / re-entrancy guard (W5).
    if (this._mode === m || this._switching) return;

    // Public build: no DES runner → DES is unavailable, ignore the request.
    if (m === 'des' && !this.hasDesRunner()) {
      console.warn('[SimulationKernel] setMode("des") ignored — no DES runner registered (public build).');
      return;
    }

    this._switching = true;
    try {
      const incoming = this._resolveExecutor(m);
      if (!incoming) {
        // Could not build the target executor — stay in the current mode.
        return;
      }

      // Reset-on-Switch: drop the outgoing MUs, then start the incoming fresh.
      // Commit `_active`/`_mode` only AFTER `start()` succeeds, so a throwing
      // start() leaves the kernel cleanly in the ORIGINAL mode (not a half-
      // switched target with a broken executor).
      this._active.clearMUs();
      incoming.start(this.defs, this.topology);
      this._active = incoming;
      this._mode = m;
      // Notify AFTER the commit so a subscriber that reads `mode`/`desControl()`
      // synchronously sees the new mode. Guarded so a throwing listener cannot
      // wedge the switch (the latch is released in `finally`).
      try { this.onModeChanged?.(m); } catch (e) { console.error('[SimulationKernel] onModeChanged listener threw:', e); }
    } catch (e) {
      console.error(`[SimulationKernel] setMode("${m}") failed — staying in '${this._mode}':`, e);
    } finally {
      this._switching = false;
    }
  }

  /** Resolve the executor for a mode, lazily building the DES runner once. */
  private _resolveExecutor(m: SimulationMode): SimulationExecutor | null {
    if (m === 'continuous') return this.continuousRunner;
    // m === 'des'
    if (this._desRunner) return this._desRunner;
    if (!this.desRunnerFactory) return null;
    this._desRunner = this.desRunnerFactory(this.defs, this.topology, this.core);
    return this._desRunner;
  }

  // ─── Per-tick delegation ──────────────────────────────────────────────

  /** Pre-PRE pass on the active executor (CoreSubsystems early stage). */
  earlyTick(dt: number): void {
    this._active.earlyTick?.(dt);
  }

  /** Advance the active executor one fixed tick. */
  tick(dt: number): void {
    this._active.tick(dt);
  }

  /** Optional post-tick pass on the active executor. */
  lateTick(dt: number): void {
    this._active.lateTick?.(dt);
  }

  /** Reset the active executor (delegated from `RVViewer.resetSimulation`, K3). */
  reset(): void {
    this._active.reset();
  }

  /** Tear down both executors (viewer dispose). */
  dispose(): void {
    try { this.continuousRunner.dispose(); } catch { /* ignore */ }
    if (this._desRunner) {
      try { this._desRunner.dispose(); } catch { /* ignore */ }
      this._desRunner = null;
    }
  }
}

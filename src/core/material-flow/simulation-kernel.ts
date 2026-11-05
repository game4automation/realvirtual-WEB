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
 * takes the factory the on-demand DES feature hands over
 * (`plugins/des/register-des-runner`, plan-680), and `hasDesRunner()` reports it.
 * The UI toggle reads `hasDesRunner()` and hides DES when false — `SimModeToggle`
 * (P6) never imports `DESRunner` directly (Plan 194 V7).
 */

import type { MaterialFlowDefinition } from './define-material-flow';
import type {
  SimulationExecutor,
  SimulationTopology,
} from './simulation-executor';
import type { CoreSubsystems } from '../engine/rv-core-subsystems';
import type { ScriptHookDispatcher, SdkScheduler } from '../sdk/rv-script-hook';
import { ContinuousRunner } from './continuous-runner';
import { setActiveTrafficKernel } from '../engine/rv-traffic-registries';

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
  /** Time share driving between stops (vehicles), 0–100. Absent for producers that do not track it. */
  readonly transport?: number;
  /** plan-558: time share driving below the free profile because of traffic (vehicles), 0–100. */
  readonly slowed?: number;
  /** plan-558: time share standing at a traffic stop (vehicles, free time), 0–100. */
  readonly stopped?: number;
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
 * DES lifecycle event kinds (plan-645 L2). `bound` = a run is bound and started
 * (first start, after `reset()` / `rebindScene()`); `reset` = the bound run ends
 * (reset, rebind, clearMUs, suspend, dispose) — delivered BEFORE the runner tears
 * its instances down; `restored` = a snapshot restore changed the state (no state
 * change, but a new generation); `disposed` = the runner is gone (terminal).
 */
export type DesLifecycleEventType = 'bound' | 'reset' | 'restored' | 'disposed';

/** One DES lifecycle event. The generation is the runner's own monotone counter (never an entity id, N5). */
export interface DesLifecycleEvent {
  readonly type: DesLifecycleEventType;
  /** Service generation AFTER this event (+1 per event). */
  readonly generation: number;
  /** Process-unique id of the emitting runner. */
  readonly runnerId: number;
}

/** Listener of {@link SimDesControl.onLifecycle} / {@link SimulationKernel.onDesLifecycle}. */
export type DesLifecycleListener = (e: DesLifecycleEvent) => void;

/** Handle of a scheduled DES callback (plan-645 Phase 2): generation + callback key. */
export interface DesCallbackHandle {
  readonly generation: number;
  readonly key: number;
}

/** Reason recorded at the model run's completion edge. */
export type DesRunCompleteReason = 'duration-reached' | 'queue-drained' | 'queue-empty-before-end';

/** Model events in dispatch order, sampled on demand. */
export interface DesPeekResult {
  events: Array<{ time: number; component: string; componentPath: string; action: string; muId: number; priority: number }>;
  total: number;
  truncated: boolean;
}

/**
 * The DES sub-mode / KPI control surface the public UI consumes. The active DES
 * executor (the private `DESRunner`) implements this STRUCTURALLY — the public
 * side only ever sees this interface, never the concrete class (Plan 194 V7). The
 * kernel exposes it via `desControl()`, returning `null` outside DES mode.
 */
export interface SimDesControl {
  readonly cycleTime?: number;
  setCycleTime?(seconds: number): void;
  /** Lifecycle generation, incremented on reset/restart and restore. */
  readonly lifecycleGeneration?: number;
  /** Pause state of the DES manager. */
  readonly paused?: boolean;
  /** Last completion edge; null while the current run has not completed. */
  readonly runComplete?: { reason: DesRunCompleteReason; simTime: number } | null;
  /** Inspect pending model events without advancing the simulation. */
  peekEvents?(n: number, filter?: { component?: string; action?: string }): DesPeekResult;
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
  /** Render clock (s): the time-lapsed sim time the tweens interpolate to (plan-629 horizon). */
  readonly renderClock?: number;
  /** Time (s) of the next pending event; +Infinity when the queue is empty. Read-only peek (plan-629). */
  readonly nextEventTime?: number;
  /**
   * Observe the event loop (plan-629): `fn(t)` runs once per distinct event time
   * `t`, BEFORE the first event at `t` is dequeued — every event before `t` is
   * processed. Survives a DES reset. Returns the unsubscribe function.
   */
  addTimeAdvanceListener?(fn: (time: number) => void): () => void;
  /** Process exactly one event (Step mode). Returns false when nothing ran. */
  step(): boolean;
  /** FastForward progress 0–1 when a FF run is in flight; undefined otherwise. */
  readonly ffProgress?: number;
  /** Run FastForward to completion; resolves true when done, false if cancelled. */
  runFastForward?(): Promise<boolean>;
  /** Run through a temporary sim-time target (or natural end), restore speed and pause. */
  fastForwardUntil?(seconds: number): Promise<boolean>;
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
  /** Continue a finished (end reached) run: end += one more run length, clock runs on, no reset.
   *  False when there is nothing to continue. Reset restores the original end. */
  continueRun?(): boolean;
  /** Sim time at which component statistics reset (warmup); 0 = off. */
  readonly statResetTime?: number;
  /** Set the statistics-reset (warmup) time; 0 disables it. */
  setStatResetTime?(seconds: number): void;
  /** Per-component runtime states for inspection / debugging (MCP `web_des_*`). */
  componentStates?(): SimDesComponentState[];
  /** Runtime counters of the DES components a KPI can read (`TotalProcessed`, numeric prop entries). */
  kpiRuntimeFields?(): Array<{ address: string; path: string; component: string; field: string; value: number }>;
  /** Per-component utilization statistics + bottleneck (MCP `web_des_stats` /
   *  `web_des_bottleneck`), ordered by material flow. */
  statistics?(): SimDesStatistics;
  /** Serialize the DES manager state to JSON (Save Snapshot). */
  snapshotJson?(): string;
  /** Restore the DES manager state from a JSON snapshot (Load Snapshot). */
  restoreJson?(json: string): void;
  /** Resolves once no snapshot gate refuses (scripts loading, PLC deploy pending); awaited before an async restore. */
  whenCycleOwnersReady?(): Promise<void>;

  // ── Lifecycle service + callback scheduler (plan-645 Phase 2) ──────────
  // Optional members: an older runner without them stays a valid SimDesControl.

  /**
   * Subscribe to the runner's lifecycle events (synchronous dispatch over a copy
   * of the listener list; unsubscribing while it fires is allowed; a throwing
   * listener is logged and does not stop the others). `replay: true` delivers
   * `bound` with the current generation at once when the runner is bound.
   * Prefer {@link SimulationKernel.onDesLifecycle}: it holds `bound` back until
   * a mode switch has committed. Returns the unsubscribe function.
   */
  onLifecycle?(fn: DesLifecycleListener, opts?: { replay?: boolean }): () => void;
  /**
   * plan-2212: the DES-clock scheduler for ONE script component - `self.in/at`
   * become `Script.Hook` events on the DES queue, `now` is the DES clock. Pass
   * the component's kernel adapter as `dispatcher`. Structural: the web-component
   * plugin reaches DES through this contract only.
   */
  makeScriptScheduler?(dispatcher: ScriptHookDispatcher): SdkScheduler;
  /**
   * Run `fn` once at sim time `t` (s, clamped to now) as a DES queue event
   * (`DES.Callback`) — exact time order with the model events, FastForward too.
   * Callbacks are NOT persistable: snapshots never contain them, and every
   * lifecycle event (reset / bound / restored / disposed) drops the pending ones
   * — after `restored` the consumer plans again.
   */
  scheduleCallback?(t: number, fn: () => void, opts: { afterModelEvents?: boolean; origin: { owner: string; kind: 'ui' | 'replan' } }): DesCallbackHandle;
  /** Cancel a pending callback; a handle of an older generation is ignored. */
  cancelCallback?(h: DesCallbackHandle | null | undefined): void;

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
  /** Encoded series for selected references belonging to this column's current manifest. */
  readColumnSeriesJson?(model: string, exp: string, refs: readonly string[]): Promise<string>;
  /** The experiment manifest as a JSON string (null when absent). */
  readManifestJson?(model: string, exp: string): Promise<string | null>;
  /** Snapshot the CURRENT sim state into the store at the current sim time. */
  saveSnapshot?(scope: { model: string; exp: string; repl: number; runId?: string }, label?: string): Promise<void>;
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
  /** Why an experiment batch cannot start now (LogicSteps, PLC programs or IK paths in the model), as user text; null = it may. */
  batchBlockReason?(): string | null;
  /** Cancel an in-flight batch; already-finished replications stay archived. */
  cancelBatch?(): void;
  /** JSON of the current batch progress — `{ exp, replIndex, total, phase }` —
   *  or null when no batch is running (drives the per-column running indicator). */
  batchProgressJson?(): string | null;
  /** JSON array of the final progress of every column of the LAST batch (reset when a batch
   *  starts), so a caller judges the whole batch, not only its last column (plan-2208). */
  batchOutcomeJson?(): string | null;

  // ── Planning re-config (plan-630 §2.14, Phase 8) ───────────────────────

  /**
   * Re-seed every bound instance's configuration from its node's rv_extras, so the next
   * reset runs with values that were written there. The `component` planning owner calls
   * it after its one writer, at a standstill, before the structural reset's single runner
   * reset (`des-extras` re-config path). Idempotent; never touches MU or runtime state.
   */
  reconfigureFromExtras?(): void;
}

/**
 * Factory the DES feature provides (`plugins/des/register-des-runner`); `null`
 * until the feature is activated. The optional `core`
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

  // ── DES lifecycle forwarding (plan-645 L1 / R2-1) ──
  private readonly _lcListeners: DesLifecycleListener[] = [];
  /** `bound` events held back while `setMode` runs; released after the commit, dropped on rollback. */
  private readonly _lcPendingBound: DesLifecycleEvent[] = [];
  /** True while a failed switch rolls back: the failed runner's events are swallowed. */
  private _lcRollingBack = false;
  /** Last forwarded `bound` (generation updated by `restored`); null when not bound. */
  private _lcBound: DesLifecycleEvent | null = null;
  private _lcUnsubscribeRunner: (() => void) | null = null;

  constructor(opts: SimulationKernelOptions) {
    this.continuousRunner = opts.continuousRunner;
    this.topology = opts.topology;
    this.defs = opts.defs ?? [];
    this.desRunnerFactory = opts.desRunnerFactory ?? null;
    this.core = opts.core;
    this.onModeChanged = opts.onModeChanged;
    this._active = this.continuousRunner;
    // plan-648 §2.1: the kernel starts continuous — its vehicle instances own the ids.
    setActiveTrafficKernel('continuous');
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
   * the factory the DES feature hands over (`null` clears it). Idempotent.
   */
  registerDesRunnerFactory(factory: DesRunnerFactory): void {
    this.desRunnerFactory = factory;
  }

  // ─── DES lifecycle (plan-645 L1 / R2-1) ───────────────────────────────

  /**
   * Subscribe to the DES runner's lifecycle — the kernel is the emitter (L1).
   * Ending events (`reset`, `disposed`) arrive synchronously BEFORE the runner
   * tears its instances down, also inside `setMode`; a listener must not reach
   * for `desControl()` there (the event carries generation and runner id).
   * Activating events (`bound`) are held back while a mode switch runs and are
   * delivered after `_active`/`_mode` committed, so a listener sees
   * `desControl() !== null` and the new mode; a failed switch drops them.
   * `replay: true` delivers `bound` with the current generation at once when
   * the kernel is in DES mode and its runner is bound. A runner without
   * `onLifecycle` (older private build) never emits — callers keep their
   * fallback (S9). Returns the unsubscribe function.
   */
  onDesLifecycle(fn: DesLifecycleListener, opts?: { replay?: boolean }): () => void {
    this._lcListeners.push(fn);
    if (opts?.replay && this._lcBound && this._mode === 'des' && !this._switching) {
      this._lcDeliver(fn, this._lcBound);
    }
    return () => {
      const i = this._lcListeners.indexOf(fn);
      if (i >= 0) this._lcListeners.splice(i, 1);
    };
  }

  /** True when the DES runner offers the lifecycle service (plan-645). */
  hasDesLifecycle(): boolean {
    const r = this._desRunner as unknown as Partial<SimDesControl> | null;
    return !!r && typeof r.onLifecycle === 'function';
  }

  private _lcDeliver(fn: DesLifecycleListener, e: DesLifecycleEvent): void {
    try { fn(e); } catch (err) { console.error('[SimulationKernel] DES lifecycle listener threw:', err); }
  }

  private _lcEmit(e: DesLifecycleEvent): void {
    for (const fn of this._lcListeners.slice()) this._lcDeliver(fn, e);
  }

  /** Runner → kernel: buffer `bound` during a switch, everything else at once. */
  private _onRunnerLifecycle(e: DesLifecycleEvent): void {
    if (this._lcRollingBack) return;
    if (e.type === 'bound') {
      this._lcBound = e;
      if (this._switching) { this._lcPendingBound.push(e); return; }
    } else if (e.type === 'restored') {
      if (this._lcBound) this._lcBound = { ...this._lcBound, generation: e.generation };
    } else {
      this._lcBound = null;
      // An ending event supersedes a bound that was never delivered.
      this._lcPendingBound.length = 0;
    }
    this._lcEmit(e);
  }

  private _attachRunnerLifecycle(runner: SimulationExecutor): void {
    const r = runner as unknown as Partial<SimDesControl>;
    if (typeof r.onLifecycle !== 'function') return;
    this._lcUnsubscribeRunner = r.onLifecycle((e) => this._onRunnerLifecycle(e));
  }

  private _flushPendingBound(): void {
    if (this._lcPendingBound.length === 0) return;
    const pending = this._lcPendingBound.splice(0);
    for (const e of pending) this._lcEmit(e);
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
      //
      // plan-648 §2.4 — vehicle ownership is handed over explicitly:
      // clearMUs → old.suspend (releases its ids) → active traffic kernel = m →
      // incoming.start (its instances restart from the start pose and acquire).
      const old = this._active;
      old.clearMUs();
      old.suspend?.();
      setActiveTrafficKernel(m);
      try {
        incoming.start(this.defs, this.topology);
      } catch (e) {
        this._rollbackSwitch(old, incoming);
        throw e;
      }
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
      // plan-645 R2-1: `bound` of the committed (or rolled-back-to) executor is
      // delivered now that `_active`/`_mode` are final.
      this._flushPendingBound();
    }
  }

  /**
   * Failed switch (plan-648 §2.4 / G6): the half-started incoming executor gives
   * up everything it acquired or scheduled, the active traffic kernel goes back
   * to the old mode (even when that release throws), and the old executor
   * starts again — a functional restart from the start pose, not a resume (its
   * MUs and queue were already cleared). Errors of the rollback are logged; the
   * original start() error is what `setMode` reports.
   */
  private _rollbackSwitch(old: SimulationExecutor, incoming: SimulationExecutor): void {
    // plan-645 R2-1: the failed start's held-back `bound` is dropped, and the
    // failed runner's own ending events are swallowed (nobody saw it bound).
    this._lcPendingBound.length = 0;
    if (incoming === this._desRunner) this._lcBound = null;
    this._lcRollingBack = incoming === this._desRunner;
    try {
      incoming.suspend?.();
    } catch (e) {
      console.error('[SimulationKernel] suspend of the failed incoming executor threw:', e);
    } finally {
      this._lcRollingBack = false;
      setActiveTrafficKernel(old.mode);
    }
    try {
      old.start(this.defs, this.topology);
    } catch (e) {
      console.error(`[SimulationKernel] restart of '${old.mode}' after the failed switch threw:`, e);
    }
  }

  /** Resolve the executor for a mode, lazily building the DES runner once. */
  private _resolveExecutor(m: SimulationMode): SimulationExecutor | null {
    if (m === 'continuous') return this.continuousRunner;
    // m === 'des'
    if (this._desRunner) return this._desRunner;
    if (!this.desRunnerFactory) return null;
    this._desRunner = this.desRunnerFactory(this.defs, this.topology, this.core);
    this._attachRunnerLifecycle(this._desRunner);
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

  /**
   * The scene changed under the active executor (deferred placements arrived
   * after it started): rediscover via `rebindScene()` when the executor offers
   * it, else `reset()` as before. Not the user's reset — see `reset()`.
   */
  rebindScene(): void {
    const active = this._active;
    if (active.rebindScene) active.rebindScene();
    else active.reset();
  }

  /**
   * plan-2212 review #2: archive the active executor's open run before the
   * viewer's plugin / model teardown disposes what the run reads (script KPI
   * rows). No-op for executors without runs (continuous).
   */
  archiveActiveRun(): void {
    try { this._active.archiveOpenRun?.(); } catch (e) {
      console.error('[SimulationKernel] archiving the open run failed:', e);
    }
  }

  /** Tear down both executors (viewer dispose). */
  dispose(): void {
    try { this.continuousRunner.dispose(); } catch { /* ignore */ }
    if (this._desRunner) {
      try { this._desRunner.dispose(); } catch { /* ignore */ }
      this._desRunner = null;
    }
    // After the runner's `disposed` went out (plan-645).
    this._lcUnsubscribeRunner?.();
    this._lcUnsubscribeRunner = null;
    this._lcBound = null;
    this._lcPendingBound.length = 0;
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * continuous-runner.ts — the public continuous `SimulationExecutor` (Plan 194 §2.6 / §6 R1).
 *
 * `ContinuousRunner` is the default engine behind the `SimulationKernel`. It is a
 * thin DELEGATION over the viewer's EXISTING `RVTransportManager` +
 * `BehaviorManager` — it does NOT own a new copy of either. The kernel and the
 * runner reuse the very instances the `RVViewer` already created (so transport
 * ownership never relocates, and the BehaviorManager keeps every current
 * subscription / bind context).
 *
 * Tick order — verified against the live `fixedUpdate` orchestration
 * (rv-viewer.ts): the kinematic transport pass runs BEFORE the
 * behaviour/material-flow fixedUpdate fan-out:
 *
 *   rv-viewer.ts:3254   transportManager.update(dt)   ← transport FIRST
 *   rv-viewer.ts:3288   behaviors.tick(dt)            ← behaviour fixedUpdate AFTER
 *
 * `tick(dt)` reproduces exactly that pair-order (transport.update → behaviors.tick).
 * Texture animation (rv-viewer.ts:3259) and the `_physicsPluginActive` skip
 * (rv-viewer.ts:3253) stay in the viewer; this runner only owns the
 * transport→behaviour core that R1 guards against re-ordering.
 *
 * `handlesTransport` is a const `true`: the continuous runner ALWAYS drives
 * `transport.update`. This is the static form of the old dynamic
 * `_physicsPluginActive` mutex (Plan 194 §2.7 / §11.3) — same result, just
 * declared once instead of re-evaluated per model load.
 */

import type { RVTransportManager } from '../engine/rv-transport-manager';
import type { BehaviorManager } from '../behaviors';
import type { CoreSubsystems } from '../engine/rv-core-subsystems';
import type { MaterialFlowDefinition } from './define-material-flow';
import type {
  SimulationExecutor,
  SimulationTopology,
  MaterialFlowInstance,
} from './simulation-executor';

/** Minimal slice of `RVTransportManager` the runner drives (lets tests pass a mock). */
export interface TransportManagerLike {
  update(dt: number): void;
  reset(): void;
}

/** Minimal slice of `BehaviorManager` the runner drives (lets tests pass a mock). */
export interface BehaviorManagerLike {
  tick(dt: number): void;
}

/**
 * The public continuous executor. Wraps the viewer's EXISTING transport +
 * behaviour managers (passed in, never re-instantiated).
 */
export class ContinuousRunner implements SimulationExecutor {
  /** Static mode tag — the continuous runner is always 'continuous'. */
  readonly mode = 'continuous' as const;

  /**
   * The continuous runner ALWAYS handles transport (drives `transport.update`).
   * Static const — replaces the old dynamic `_physicsPluginActive` flag
   * (Plan 194 §2.7 / §11.3). Mirrored by `SimulationKernel.handlesTransport`.
   */
  static readonly handlesTransport = true;

  /** The viewer's transport manager (shared — NOT owned anew). */
  private readonly transport: TransportManagerLike;
  /** The viewer's behaviour manager (shared — NOT owned anew). */
  private readonly behaviors: BehaviorManagerLike;
  /** Optional core subsystem pipeline (drives/visuals/early — Phase B unification).
   *  Absent in minimal/unit-test setups: tick() then degrades to the historical
   *  transport → behaviors pair. */
  private readonly core: CoreSubsystems | null;
  /** Optional transport gate — `false` skips transport+behaviors this tick (the
   *  old `_physicsPluginActive` bypass, now evaluated per tick inside the runner
   *  so the drive loop + visuals keep running while a physics plugin owns transport). */
  private readonly transportGate: (() => boolean) | null;

  /**
   * @param transport     The RVViewer's existing `RVTransportManager`.
   * @param behaviors     The RVViewer's existing `BehaviorManager`.
   * @param core          The viewer's CoreSubsystems pipeline (optional for tests).
   * @param transportGate Per-tick gate; `false` = a physics plugin owns transport.
   */
  constructor(
    transport: RVTransportManager | TransportManagerLike,
    behaviors: BehaviorManager | BehaviorManagerLike,
    core?: CoreSubsystems,
    transportGate?: () => boolean,
  ) {
    this.transport = transport;
    this.behaviors = behaviors;
    this.core = core ?? null;
    this.transportGate = transportGate ?? null;
  }

  /** Live MU count — reads through to the shared transport manager. */
  get muCount(): number {
    // The shared transport manager owns the MU list. A mock without `mus`
    // (the minimal `TransportManagerLike`) reports 0.
    const t = this.transport as Partial<RVTransportManager>;
    return t.mus ? t.mus.length : 0;
  }

  /**
   * Begin simulating. In continuous mode the BehaviorManager binds material-flow
   * definitions on `model-loaded` (it already owns discovery), and the transport
   * manager is populated by the scene loader, so `start()` is intentionally a
   * no-op coordination point: nothing is re-instantiated, ownership stays in the
   * viewer. The signature satisfies `SimulationExecutor` so the kernel can call
   * it uniformly across continuous and DES.
   *
   * TODO(P5): when the kernel switches FROM des back TO continuous, this is where
   * the continuous topology is (re)seeded from `defs` + `topology`.
   */
  start(_defs: MaterialFlowDefinition[], _topology: SimulationTopology): void {
    // No-op: continuous discovery/binding is owned by the BehaviorManager and
    // the scene loader. See jsdoc above.
  }

  /**
   * Pre-PRE pass — the CoreSubsystems early stage (playback → logic → IK →
   * replay). No-op in minimal setups without a core pipeline.
   */
  earlyTick(dt: number): void {
    this.core?.early(dt);
  }

  /**
   * Advance one fixed tick — EXACT legacy fixedUpdate order:
   * drive loop (+ dirty flags + MU diff) → `transport.update(dt)` →
   * behaviour/material-flow `fixedUpdate` fan-out (`behaviors.tick`) →
   * visual managers (texture anims, tank, gizmo, pipe).
   * R1 regression guard: the transport → behaviors pair-order must never be
   * swapped. When the transport gate reports `false` (physics plugin owns
   * transport) that pair is skipped but drives + visuals still run — matching
   * the old viewer-level `_physicsPluginActive` bypass.
   */
  tick(dt: number): void {
    this.core?.drives(dt);
    if (this.transportGate?.() !== false) {
      this.transport.update(dt);
      this.behaviors.tick(dt);
    }
    this.core?.visuals(dt);
  }

  /**
   * Optional post-tick pass. The continuous path has no separate late-transport
   * stage today (lateFixedUpdate is chained inside the behaviour fixedUpdate by
   * the shim, see define-material-flow.ts), so this is a no-op. Declared so the
   * kernel can call `lateTick` uniformly.
   */
  lateTick(_dt: number): void {
    // No-op — see jsdoc. TODO(P6): wire a dedicated late-transport phase if one
    // is introduced when the default flips to the kernel path.
  }

  /**
   * Remove all MUs (Reset-on-Switch outgoing step) WITHOUT tearing the executor
   * down. The shared transport manager's `reset()` disposes every live MU and
   * zeroes the spawn/consume counters; the behaviour binds (and thus the scene)
   * stay intact, so the runner can immediately resume.
   */
  clearMUs(): void {
    this.transport.reset();
  }

  /**
   * Reset to the initial state. For the continuous runner this is the same as
   * `clearMUs()` — disposing the live MUs returns the transport sim to its
   * freshly-loaded state (signals/drives are intentionally left untouched, matching
   * the viewer's existing `resetSimulation()` contract).
   */
  reset(): void {
    this.transport.reset();
  }

  /**
   * Tear down. The transport + behaviour managers are owned by the RVViewer
   * (their real lifecycle is `model-cleared` / viewer dispose), so the runner
   * must NOT dispose them here — doing so would detach the viewer's own
   * subscriptions. We only clear live MUs so a disposed runner leaves no
   * dangling instances.
   */
  dispose(): void {
    this.transport.reset();
  }

  /**
   * Enumerate live instances. The continuous path does not maintain a
   * `MaterialFlowInstance[]` (the BehaviorManager owns bind contexts), so this
   * is empty for now — the DES runner (P5) populates it.
   */
  instances(): ReadonlyArray<MaterialFlowInstance> {
    return [];
  }
}

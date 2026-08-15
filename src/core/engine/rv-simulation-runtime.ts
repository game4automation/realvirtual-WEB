// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimulationRuntime — the single facade over "is simulation time integrating
 * at all, and under which execution mode".
 *
 * Unifies four previously fragmented state axes behind one owner:
 *
 * 1. **Attachment** — workspace-mode driven. Modes registered with
 *    `runtime: 'detached'` (e.g. the asset editor) fully disable time
 *    integration via {@link SimulationLoop.setIntegrationEnabled}: no
 *    fixedUpdate scheduling, accumulator drained, rendering untouched.
 *    Deliberately NOT a pause reason — `clearPauseReasons()` can never
 *    resurrect simulation inside a detached workspace, and pause state
 *    survives an editor round-trip untouched.
 *
 *    ONE sanctioned exception (plan-410 F5): the editor's in-place test run,
 *    via {@link beginEditorTest}/{@link endEditorTest}. It does not weaken the
 *    invariant, it names it — workspace modes remain the only driver of the
 *    BASELINE attachment, and the test run is a scoped, owned override that
 *    restores exactly what the mode descriptor implied. `_setAttached` stays
 *    internal, and there is at most one test owner at a time.
 * 2. **Pause reasons** — delegated to the loop's refcounted pause set
 *    (unchanged semantics; `RVViewer.setSimulationPaused` keeps working).
 * 3. **Execution mode** — `'continuous' | 'discrete'`, mapped onto the
 *    SimulationKernel's `'continuous' | 'des'` executor modes.
 * 4. **Connection state** — `'Connected' | 'Disconnected'` (gates ActiveOnly
 *    subsystems); state lives here, orchestration (plugin notification +
 *    event emission) stays in RVViewer.
 *
 * The derived {@link state} is for UI/diagnostics:
 * `detached` → `paused` → `running` (in that precedence).
 */

import type { SimulationLoop } from './rv-simulation-loop';
import type { SimulationKernel, SimDesControl } from '../material-flow/simulation-kernel';

/** Derived runtime lifecycle state (see class doc for precedence). */
export type RuntimeState = 'detached' | 'running' | 'paused';

/** Execution mode — `'discrete'` maps to the kernel's `'des'` executor. */
export type RuntimeMode = 'continuous' | 'discrete';

/** Global connection state gating ActiveOnly subsystems. */
export type RuntimeConnectionState = 'Connected' | 'Disconnected';

/**
 * Narrow host the runtime drives — implemented by RVViewer. Keeps the runtime
 * free of a direct RVViewer dependency so it can be unit-tested with a mock.
 */
export interface RuntimeHost {
  /** Lazy loop accessor — the viewer constructs the loop after this host is
   *  built, so the reference must be resolved per call, not captured. */
  getLoop(): SimulationLoop;
  /** Lazy kernel accessor (null before a model is loaded). */
  getKernel(): SimulationKernel | null;
  /** Emit a viewer event (typed on the RVViewer side). */
  emit(event: 'runtime-attach-changed', data: { attached: boolean }): void;
}

export class SimulationRuntime {
  private readonly host: RuntimeHost;
  private _attached = true;
  private _connectionState: RuntimeConnectionState = 'Connected';

  constructor(host: RuntimeHost) {
    this.host = host;
  }

  // ─── Axis 1: attachment (workspace-mode driven) ────────────────────

  /** True while the runtime integrates time (non-detached workspace mode). */
  get isAttached(): boolean { return this._attached; }

  /**
   * Attach/detach time integration. Called by RVViewer on `'mode-changed'`
   * based on the target mode's `ModeDescriptor.runtime`. Internal — workspace
   * modes are the only sanctioned driver of attachment.
   */
  _setAttached(attached: boolean): void {
    if (attached === this._attached) return;
    this._attached = attached;
    this.host.getLoop().setIntegrationEnabled(attached);
    this.host.emit('runtime-attach-changed', { attached });
  }

  // ─── Axis 1b: editor test run (scoped attach override) ─────────────

  /** True while an editor test run holds the attachment. */
  private _editorTest = false;
  /** Attachment as the workspace mode left it, restored by endEditorTest. */
  private _preEditorTestAttached = true;

  /**
   * Attach the runtime for an EDITOR TEST RUN inside a detached workspace
   * (plan-410 F5) — kinematics, signals and LogicSteps run in place, without a
   * save-and-switch round trip.
   *
   * Owner semantics: exactly one active test owner. A second `begin` without an
   * `end` is a bug in the caller's state machine, so it warns and is otherwise
   * ignored (the first owner keeps the attachment, and the single `end` that
   * follows still restores correctly). {@link endEditorTest} restores the
   * attachment the mode descriptor implied when the test started — it does not
   * simply attach or detach.
   */
  beginEditorTest(): void {
    if (this._editorTest) {
      console.warn('[SimulationRuntime] beginEditorTest ignored — a test run is already active');
      return;
    }
    this._editorTest = true;
    this._preEditorTestAttached = this._attached;
    this._setAttached(true);
  }

  /** End the test run and restore the pre-test attachment. Idempotent. */
  endEditorTest(): void {
    if (!this._editorTest) return;
    this._editorTest = false;
    this._setAttached(this._preEditorTestAttached);
  }

  /** True while an editor test run is attached. */
  get isEditorTestActive(): boolean { return this._editorTest; }

  // ─── Axis 2: pause reasons (delegated to the loop) ─────────────────

  /**
   * Request or release a pause (refcounted by reason).
   * @returns `true` if the overall idle ↔ paused state flipped.
   */
  setPaused(reason: string, paused: boolean): boolean {
    return this.host.getLoop().setPaused(reason, paused);
  }

  /** True if any reason is currently holding the simulation paused. */
  get isPaused(): boolean { return this.host.getLoop().isPaused; }

  /** Snapshot of active pause reasons. */
  get pauseReasons(): readonly string[] { return this.host.getLoop().pauseReasons; }

  // ─── Axis 3: execution mode ────────────────────────────────────────

  /** Current execution mode. `'continuous'` when no kernel exists yet. */
  get mode(): RuntimeMode {
    return this.host.getKernel()?.mode === 'des' ? 'discrete' : 'continuous';
  }

  /**
   * Switch the execution mode (Reset-on-Switch, see SimulationKernel.setMode).
   * No-op with a warning when no kernel exists (no model loaded) or the
   * discrete runner is unavailable (public build).
   */
  setMode(mode: RuntimeMode): void {
    const kernel = this.host.getKernel();
    if (!kernel) {
      console.warn(`[SimulationRuntime] setMode('${mode}') ignored — no kernel (no model loaded).`);
      return;
    }
    kernel.setMode(mode === 'discrete' ? 'des' : 'continuous');
  }

  /** DES sub-mode control surface (step / fast-forward / stats), null outside discrete mode. */
  get desControl(): SimDesControl | null {
    return this.host.getKernel()?.desControl() ?? null;
  }

  /** True when a discrete-event runner is registered (private build). */
  hasDiscreteRunner(): boolean {
    return this.host.getKernel()?.hasDesRunner() ?? false;
  }

  // ─── Axis 4: connection state ──────────────────────────────────────

  /** Current global connection state. */
  get connectionState(): RuntimeConnectionState { return this._connectionState; }

  /**
   * Update the connection state. Returns `true` if it actually changed —
   * RVViewer uses this to keep its plugin-notification + event orchestration.
   */
  _setConnectionState(state: RuntimeConnectionState): boolean {
    if (state === this._connectionState) return false;
    this._connectionState = state;
    return true;
  }

  // ─── Derived state ─────────────────────────────────────────────────

  /** Derived lifecycle state: detached > paused > running. */
  get state(): RuntimeState {
    if (!this._attached) return 'detached';
    return this.isPaused ? 'paused' : 'running';
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MaintenancePlugin — Core plugin that manages maintenance mode.
 *
 * State machine: idle → dialog → flythrough | stepbystep → completed → idle
 *
 * Orchestrates camera animation, 3D highlighting, and emits events
 * for the React MaintenancePanel UI to subscribe to.
 *
 * Events emitted:
 *   'maintenance-mode-changed'  — { active, mode, procedure, currentStep, stepResults, isLive, renderModeLocked }
 *   'maintenance-step-changed'  — { stepIndex, step }
 *
 *   'maintenance-due-changed'   — a trigger counter moved or a procedure became due (plan-522 Phase 6)
 *
 * Events listened to:
 *   'enter-maintenance'         — Triggered by TileCard/Button clicks; payload
 *                                 `{ procedure?: string }` picks a procedure by name
 *   'camera-animation-done'     — Used to know when camera fly is complete
 *   'simulation-reset'          — Ends a running guide terminally (plan-522)
 *   'interface-connected' / 'interface-disconnected' — live detection (plan-522)
 *
 * plan-522 — the machine follows the guide:
 *   - A registered {@link MaintenanceRuntime} (private feature, open seam in
 *     `maintenance-runtime-registry.ts`) animates the machine to state(k).
 *     Without one, the guide behaves as before (text, camera, highlight).
 *   - Not live: the cell freezes (`setSimulationPaused('maintenance')`) while a
 *     scenario runs. Live (an industrial interface is connected): no freeze,
 *     no runtime — a PLC cannot be frozen from the browser.
 *   - Safety barrier: no Next, stepper jump or resume passes an unconfirmed
 *     `ConfirmWarning` step ({@link MaintenancePlugin.clampToBarrier}); the
 *     flythrough preview is exempt.
 *   - Exit / completion / model clear / dispose are terminal, in this order:
 *     abort navigation + flythrough, `runtime.end()`, release the pause,
 *     clear the highlight. A simulation reset does the same with
 *     `runtime.end('reset')`, synchronously inside the event.
 *
 * plan-522 Phase 6 — reachable from every model and mode:
 *   - Core plugin (main.ts), not a demo-model plugin.
 *   - A procedure with `Message: Always` or a trigger gets a tile in the
 *     message panel (`MaintenanceMessages`); clicking it opens that procedure.
 *
 * plan-522 Phase 7a — flexible triggers ({@link MaintenanceTriggerHost}):
 *   - Trigger child nodes (`LogicStep_MaintenanceTrigger`: Signal, Count,
 *     RunTime, Travel, Threshold, Interval) plus the Phase-6 fields as an
 *     implicit Travel / RunTime trigger; combined Any / All into the levels
 *     ok → upcoming → due → overdue, written to optional output signals.
 *   - Completing the procedure step by step resets its triggers; a simulation
 *     reset does not (E7.3). Kept in memory only until Phase 7b.
 *   - Procedures inside placements are reported, not evaluated (G11).
 */

import { Vector3 } from 'three';
import { BaseViewerPlugin } from '../../core/rv-base-plugin';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import type { RVViewer } from '../../core/rv-viewer';
import {
  parseMaintenanceProcedures,
  type MaintenanceProcedure,
  type MaintenanceStep,
} from '../../core/maintenance-parser';
import {
  loadMaintenanceProgress,
  saveMaintenanceProgress,
  clearMaintenanceProgress,
} from '../../core/hmi/maintenance-progress-store';
import { activateContext, deactivateContext } from '../../core/hmi/ui-context-store';
import { waitForCameraAndDwell } from '../tour-utils';
import type { Object3D } from 'three';
import type { StepSeverity } from '../../core/maintenance-parser';
import {
  getMaintenanceRuntime,
  setMaintenanceRenderLock,
  type MaintenanceEndReason,
  type MaintenanceRuntime,
  type StepDirection,
} from '../../core/maintenance-runtime-registry';

// Re-export shared types from core (canonical source of truth)
export type { MaintenanceMode, StepResult, MaintenanceState } from '../../core/types/plugin-types';
import type { StepResult, MaintenanceState, MaintenanceMessageEntry } from '../../core/types/plugin-types';
import { MAINTENANCE_MESSAGES_UI } from '../../core/hmi/MaintenanceMessages';
import { MaintenanceTriggerHost, unitOfRun } from './maintenance-trigger-host';
import { MAINTENANCE_LEVEL_NAMES } from '../../core/maintenance-trigger-eval';

// ─── Live detection ─────────────────────────────────────────────────────

/** The part of an industrial interface the live check reads (duck-typed, no runtime import). */
interface LiveInterfaceLike {
  readonly isConnected: boolean;
  connect: unknown;
  disconnect: unknown;
}

function isConnectedInterface(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  const i = x as Partial<LiveInterfaceLike>;
  return typeof i.connect === 'function' && typeof i.disconnect === 'function' && i.isConnected === true;
}

// ─── Attention markers ──────────────────────────────────────────────────

/** Aux-emphasis set of the step markers. */
const MARKER_AUX_ID = 'maintenance-step';
/** The alarm outline pulses for as long as the step is shown (the flash channel expires otherwise). */
const MARKER_DURATION_MS = 24 * 60 * 60 * 1000;

/** Marker colour per step severity — matches the panel's severity accents. */
const MARKER_COLOR: Record<StepSeverity, number> = {
  Info: 0x29b6f6,
  Warning: 0xffa726,
  Error: 0xff2020,
  Success: 0x66bb6a,
};

// ─── Plugin ─────────────────────────────────────────────────────────────

export class MaintenancePlugin extends BaseViewerPlugin {
  readonly id = 'maintenance';
  readonly order = 200;
  /** Always active, also in selective mode (plan-522 Phase 6): idle it costs one length check per step. */
  readonly core = true;

  private viewer: RVViewer | null = null;
  private _procedures: MaintenanceProcedure[] = [];
  private _state: MaintenanceState = MaintenancePlugin._idleState();

  /** AbortController for cancelling the flythrough async loop (standard Web API). */
  private _flythroughAbort: AbortController | null = null;

  /** AbortController of the current step navigation (runtime.applyStep); one per `_goToStep`. */
  private _navAbort: AbortController | null = null;

  /** The runtime begun for the running guide; null without runtime, in live mode and after the end. */
  private _runtime: MaintenanceRuntime | null = null;

  /** The current step's highlight targets (marked through aux emphasis + flash). */
  private _markerRoots: Object3D[] = [];
  private _markerColor = 0;

  /** Dwell time in ms for each step during flythrough mode. */
  private _flythroughDwellMs = 2500;

  /** Timeout (ms) to wait for 'camera-animation-done' before forcing continue. */
  private _flythroughCameraTimeoutMs = 5000;

  /** Triggers (plan-522 Phase 7a): counters, levels, output signals. */
  private readonly _triggers = new MaintenanceTriggerHost();
  private _messagesUiRegistered = false;

  private static _idleState(): MaintenanceState {
    return {
      mode: 'idle',
      procedure: null,
      currentStep: 0,
      stepResults: [],
      isCameraAnimating: false,
      isLive: false,
      renderModeLocked: false,
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;

    // Parse maintenance procedures from GLB scene
    const root = viewer.scene.children.find(c => c !== null);
    if (root) {
      this._procedures = parseMaintenanceProcedures(viewer.scene, { registry: viewer.registry });
    }

    // Listen for enter-maintenance event (optional payload: { procedure: name })
    this.sub(
      viewer.on('enter-maintenance' as string, (data: unknown) => {
        const name = (data as { procedure?: unknown } | undefined)?.procedure;
        this.enterMaintenance(typeof name === 'string' ? name : undefined);
      })
    );

    this._setupTriggers(viewer);
    // plan-522 Phase 7 (G11): procedures inside placements are a stated limit.
    this.sub(viewer.on('layout-content-added' as string, (e: unknown) => {
      const root = (e as { root?: Object3D } | undefined)?.root;
      if (root) this._triggers.onPlacementContent(root);
    }));

    // plan-522 SOL R2-F1: the reset is emitted BEFORE the drive reset — end the
    // guide synchronously so no later restore writes a stale baseline back.
    this.sub(viewer.on('simulation-reset', () => this._onSimulationReset()));

    // plan-522: live detection follows the interfaces (connect / disconnect).
    this.sub(viewer.on('interface-connected', () => this._onInterfaceChange()));
    this.sub(viewer.on('interface-disconnected', () => this._onInterfaceChange()));
    const unsubMode = viewer.connectionMode?.subscribe?.(() => this._onInterfaceChange());
    if (unsubMode) this.sub(unsubMode);
  }

  override onModelCleared(viewer: RVViewer): void {
    this.exitMaintenance();
    this._procedures = [];
    this._triggers.clear();
    this._setMessagesUi(viewer, false);
    super.onModelCleared(viewer);
  }

  override dispose(): void {
    this.exitMaintenance();
    if (this.viewer) this._setMessagesUi(this.viewer, false);
    this._triggers.clear();
    super.dispose();
    this.viewer = null;
  }

  /** Trigger counters, debounce and overdue time (plan-522 Phase 7a), allocation-free. */
  onFixedUpdatePost(dt: number): void {
    this._triggers.fixedUpdate(dt);
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Get the current maintenance state (read-only snapshot). */
  getState(): MaintenanceState {
    return { ...this._state, renderModeLocked: this._isRenderModeLocked() };
  }

  /** Get all discovered maintenance procedures. */
  getProcedures(): MaintenanceProcedure[] {
    return this._procedures;
  }

  /**
   * Re-read the procedures from the scene. For procedure nodes added at runtime
   * after the model load (e.g. by a project's model plugin, whose
   * `onModelLoaded` runs after this plugin's). A running guide ends first;
   * triggers and message tiles are set up again for the new list.
   */
  rescanProcedures(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    if (this._state.mode !== 'idle') this.exitMaintenance();
    this._procedures = parseMaintenanceProcedures(viewer.scene, { registry: viewer.registry });
    this._setupTriggers(viewer);
    viewer.emit('maintenance-due-changed' as string, undefined);
  }

  /**
   * The message-panel tiles (plan-522 Phase 6/7): every procedure with
   * `Message: Always`, plus every procedure whose triggers reached at least
   * "upcoming". The deciding trigger names value, interval and unit.
   */
  getMessageEntries(): MaintenanceMessageEntry[] {
    const out: MaintenanceMessageEntry[] = [];
    for (const procedure of this._procedures) {
      const { level, deciding } = this._triggers.viewOf(procedure);
      if (procedure.message !== 'Always' && level < 1) continue;
      const unit = unitOfRun(deciding);
      const counting = unit !== null && deciding !== null;
      out.push({
        procedure,
        due: level >= 2,
        level,
        levelName: MAINTENANCE_LEVEL_NAMES[level],
        value: counting ? deciding.state.value : 0,
        interval: counting ? deciding.rules.interval : 0,
        unit: counting ? unit : null,
        triggerName: deciding && !deciding.def.legacy ? deciding.def.name : '',
        sourcePath: deciding ? (deciding.def.signalPath || deciding.def.drivePath) : (procedure.trigger?.drivePath ?? ''),
        liveBrowserCount: this._triggers.live && counting,
      });
    }
    return out;
  }

  /** Set the first counter of a procedure (tests, MCP, demos); the levels follow. */
  setTriggerValue(procedureName: string, value: number): void {
    this._triggers.setCounterValue(procedureName, value);
  }

  /** The trigger runtime (tests, diagnostics). */
  get triggers(): MaintenanceTriggerHost {
    return this._triggers;
  }

  /**
   * True while at least one registered industrial interface reports
   * `isConnected === true`. Deliberately NOT `viewer.connectionState`, which
   * starts as `'Connected'` on every fresh viewer.
   */
  isLive(): boolean {
    const v = this.viewer;
    if (!v) return false;
    const manager = v.getPlugin?.<{ id: string; getRegistered?(): ReadonlyMap<string, unknown> }>('interface-manager');
    const registered = manager?.getRegistered?.();
    if (registered) {
      for (const iface of registered.values()) if (isConnectedInterface(iface)) return true;
    }
    for (const p of v.getPlugins?.() ?? []) if (isConnectedInterface(p)) return true;
    // Interfaces outside the manager (e.g. CONNECT's own stream) report to the
    // connection-mode controller. Only a TAKEOVER counts there (plan-522 Phase 5,
    // 2026-10-21): the dev server's stream to a local CONNECT connects on every
    // load without sourcing a single model output — the cell still runs on its
    // own logic, so the guide must freeze and move it like in standalone.
    return v.connectionMode?.state?.takeover === true;
  }

  /**
   * Clamp a target step to the safety barrier: `min(target, b)`, `b` = the
   * first `ConfirmWarning` step whose result is not `'pass'`. Used by Next,
   * the stepper jump and resume; the flythrough preview is exempt.
   */
  clampToBarrier(target: number): number {
    const proc = this._state.procedure;
    if (!proc) return target;
    const n = Math.min(target, proc.steps.length);
    for (let i = 0; i < n; i++) {
      if (proc.steps[i].completionType === 'ConfirmWarning' && this._state.stepResults[i] !== 'pass') {
        return i;
      }
    }
    return target;
  }

  /** Enter maintenance mode — show the mode selection dialog (first procedure, or the named one). */
  enterMaintenance(procedureName?: string): void {
    if (!this.viewer) return;
    if (this._procedures.length === 0) {
      console.warn('[MaintenancePlugin] No maintenance procedures found in model');
      return;
    }

    const procedure = (procedureName ? this._procedures.find((p) => p.name === procedureName) : undefined)
      ?? this._procedures[0];
    this._state = {
      ...MaintenancePlugin._idleState(),
      mode: 'dialog',
      procedure,
      stepResults: new Array(procedure.steps.length).fill(null),
    };

    this._emitModeChanged();
  }

  /**
   * Start a maintenance scenario in the specified mode.
   * @param procedure  The procedure to execute (or uses current if null).
   * @param mode       'flythrough' or 'stepbystep'.
   */
  startScenario(procedure: MaintenanceProcedure | null, mode: 'flythrough' | 'stepbystep'): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const proc = procedure ?? this._state.procedure;
    if (!proc) return;

    // A scenario still running (restart) ends first — never two runtimes.
    if (this._runtime || this._navAbort || this._flythroughAbort) this._terminate('exit');

    // Try to restore saved progress for stepbystep mode
    let savedStep = 0;
    let stepResults: StepResult[] = new Array(proc.steps.length).fill(null);

    if (mode === 'stepbystep') {
      const saved = loadMaintenanceProgress(proc.name);
      if (saved && saved.stepResults.length > 0) {
        stepResults = saved.stepResults.slice(0, proc.steps.length);
        while (stepResults.length < proc.steps.length) stepResults.push(null);
        savedStep = Math.min(saved.currentStep, proc.steps.length - 1);
      }
    }

    const live = this.isLive();
    this._state = {
      mode,
      procedure: proc,
      currentStep: 0,
      stepResults,
      isCameraAnimating: false,
      isLive: live,
      renderModeLocked: false,
    };
    // Resume never lands behind an unconfirmed safety step.
    const startStep = Math.max(0, this.clampToBarrier(savedStep));
    this._state.currentStep = startStep;

    if (!live) {
      viewer.setSimulationPaused('maintenance', true);
      const rt = getMaintenanceRuntime();
      if (rt) {
        try {
          rt.begin(proc, viewer);
          this._runtime = rt;
        } catch (e) {
          console.warn('[MaintenancePlugin] Maintenance runtime failed to begin:', e);
        }
      }
    }

    // Fresh AbortController per flythrough invocation (abort is one-way).
    this._flythroughAbort = mode === 'flythrough' ? new AbortController() : null;

    this._emitModeChanged();

    if (mode === 'flythrough') {
      // The loop applies step 0 synchronously before its first await.
      void this._runFlythrough();
    } else {
      void this._goToStep(startStep, startStep === 0 ? 'forward' : 'jump');
    }
  }

  /** Navigate to a specific step (stepper jump; clamped to the safety barrier). */
  goToStep(stepIndex: number): void {
    if (!this._state.procedure) return;
    if (stepIndex < 0 || stepIndex >= this._state.procedure.steps.length) return;
    this._navigate(this.clampToBarrier(stepIndex), 'jump');
  }

  /** Advance to the next step; a no-op on an unconfirmed safety step. */
  nextStep(): void {
    if (!this._state.procedure) return;
    const current = this._state.currentStep;
    const next = current + 1;
    if (this.clampToBarrier(next) <= current) return; // safety barrier
    if (next >= this._state.procedure.steps.length) {
      // All steps done — transition to completed
      this._complete();
      return;
    }
    this._navigate(next, 'forward');
  }

  /** Go back to the previous step. */
  prevStep(): void {
    if (!this._state.procedure) return;
    const prev = this._state.currentStep - 1;
    if (prev < 0) return;
    this._navigate(prev, 'back');
  }

  /** Mark a step as completed with a result. */
  completeStep(stepIndex: number, result: 'pass' | 'fail' = 'pass'): void {
    if (!this._state.procedure) return;
    if (stepIndex < 0 || stepIndex >= this._state.stepResults.length) return;
    this._state.stepResults[stepIndex] = result;
    this._persistProgress();
    this._emitModeChanged();
  }

  /** Exit maintenance mode — clean up everything (terminal). */
  exitMaintenance(): void {
    this._terminate('exit');

    // If exiting from completed state, clear persisted progress
    // Otherwise keep it so user can resume later
    if (this._state.mode === 'completed' && this._state.procedure) {
      clearMaintenanceProgress(this._state.procedure.name);
    }

    this._state = MaintenancePlugin._idleState();
    this._emitModeChanged();
  }

  /** Restore progress from a saved state (e.g., localStorage). */
  restoreProgress(stepResults: StepResult[]): void {
    if (!this._state.procedure) return;
    this._state.stepResults = stepResults.slice(0, this._state.procedure.steps.length);
    // Pad with nulls if shorter
    while (this._state.stepResults.length < this._state.procedure.steps.length) {
      this._state.stepResults.push(null);
    }
    this._emitModeChanged();
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private _isGuideRunning(): boolean {
    return this._state.mode === 'stepbystep' || this._state.mode === 'flythrough';
  }

  /** Locked while a runtime is engaged for the running guide (it swaps materials). */
  private _isRenderModeLocked(): boolean {
    return this._runtime !== null && this._isGuideRunning();
  }

  /** Set the current step, apply it, persist and notify. */
  private _navigate(stepIndex: number, direction: StepDirection): void {
    this._state.currentStep = stepIndex;
    void this._goToStep(stepIndex, direction);
    this._persistProgress();
    this._emitModeChanged();
  }

  /**
   * Navigate camera and highlight for a step and let the runtime animate the
   * machine to state(stepIndex). Each call supersedes the previous one (its
   * AbortSignal is aborted). Resolves when the runtime is done or superseded;
   * never rejects.
   */
  private _goToStep(stepIndex: number, direction: StepDirection): Promise<void> {
    if (!this.viewer || !this._state.procedure) return Promise.resolve();
    const step: MaintenanceStep | undefined = this._state.procedure.steps[stepIndex];
    if (!step) return Promise.resolve();

    this._navAbort?.abort();
    const nav = new AbortController();
    this._navAbort = nav;

    this.viewer.clearHighlight();
    this._showMarkers(step.highlightPaths, step.severity);

    // Animate camera if bookmark exists
    if (step.camera) {
      const pos = new Vector3(step.camera.px, step.camera.py, step.camera.pz);
      const target = new Vector3(step.camera.tx, step.camera.ty, step.camera.tz);
      this._state.isCameraAnimating = true;
      this.viewer.animateCameraTo(pos, target, step.cameraDuration);

      // Wait for camera animation to complete
      this.viewer.once('camera-animation-done', () => {
        this._state.isCameraAnimating = false;
        this._emitModeChanged();
      });
    }

    // Emit step changed event
    this.viewer.emit('maintenance-step-changed' as string, {
      stepIndex,
      step,
    });

    // The machine follows — in parallel to camera and highlight.
    const rt = this._runtime;
    if (!rt) return Promise.resolve();
    const warn = (e: unknown): void => {
      if (!nav.signal.aborted) console.warn('[MaintenancePlugin] Maintenance runtime step failed:', e);
    };
    try {
      return rt.applyStep(stepIndex, direction, nav.signal)
        .then(() => { if (!nav.signal.aborted) this._refreshMarkers(); })
        .catch(warn);
    } catch (e) {
      warn(e);
      return Promise.resolve();
    }
  }

  /** End the runtime of the running guide once (idempotent). */
  private _endRuntime(reason: MaintenanceEndReason): void {
    const rt = this._runtime;
    if (!rt) return;
    this._runtime = null;
    try {
      rt.end(reason);
    } catch (e) {
      console.warn('[MaintenancePlugin] Maintenance runtime failed to end:', e);
    }
  }

  /**
   * Terminal sequence (plan-522 §2.4.3): (1) abort navigation and flythrough,
   * create no new controller; (2) `runtime.end(reason)`; (3) release the
   * pause; (4) clear the highlight. Leaves the mode to the caller.
   */
  private _terminate(reason: MaintenanceEndReason): void {
    this._navAbort?.abort();
    this._navAbort = null;
    this._flythroughAbort?.abort();
    this._flythroughAbort = null;
    this._endRuntime(reason);
    this.viewer?.setSimulationPaused('maintenance', false);
    this.viewer?.clearHighlight();
    this._clearMarkers();
  }

  /**
   * Mark the step's highlight targets the way an error message or a collision
   * warning marks its part: a steady overlay in the step's severity colour
   * (aux emphasis) plus the pulsing alarm outline (flash channel), held for as
   * long as the step is shown. Both reach baked parts. Paths that do not
   * resolve are skipped.
   */
  private _showMarkers(paths: readonly string[], severity: StepSeverity): void {
    const viewer = this.viewer;
    if (!viewer) return;
    this._clearMarkers();
    const roots: Object3D[] = [];
    for (const path of paths) {
      const node = viewer.registry?.getNode(path);
      if (node) roots.push(node);
    }
    if (roots.length === 0) return;
    const color = MARKER_COLOR[severity] ?? MARKER_COLOR.Info;
    viewer.highlighter.setAuxEmphasis(MARKER_AUX_ID, roots, { color });
    viewer.highlighter.flash(roots, { color, durationMs: MARKER_DURATION_MS });
    this._markerRoots = roots;
    this._markerColor = color;
    viewer.markRenderDirty();
  }

  /** Rebuild the markers at the targets' current pose (after the step's motion). */
  private _refreshMarkers(): void {
    const viewer = this.viewer;
    if (!viewer || this._markerRoots.length === 0) return;
    viewer.highlighter.setAuxEmphasis(MARKER_AUX_ID, this._markerRoots, { color: this._markerColor });
    viewer.highlighter.flash(this._markerRoots, { color: this._markerColor, durationMs: MARKER_DURATION_MS });
  }

  private _clearMarkers(): void {
    if (this._markerRoots.length === 0) return;
    this._markerRoots = [];
    this.viewer?.highlighter.setAuxEmphasis(MARKER_AUX_ID, null);
    this.viewer?.highlighter.clearFlash();
    this.viewer?.markRenderDirty();
  }

  /** All steps done: restore the baseline, let the cell run, show the summary. */
  private _complete(): void {
    this._terminate('exit');
    // A completed procedure is no longer due: its counter starts again (plan-522 Phase 6).
    // The flythrough is a preview and resets nothing.
    if (this._state.mode === 'stepbystep') this._triggers.complete(this._state.procedure);
    this._state.mode = 'completed';
    this._emitModeChanged();
  }

  // ─── Triggers + message tiles (plan-522 Phase 6) ──────────────────

  /** Resolve the triggers once per model load and register the tiles when needed. */
  private _setupTriggers(viewer: RVViewer): void {
    this._triggers.live = this.isLive();
    this._triggers.onChange = () => this.viewer?.emit('maintenance-due-changed' as string, undefined);
    this._triggers.setup(viewer, this._procedures);
    const wantsTiles = this._procedures.some((p) => p.message === 'Always' || (p.triggers?.length ?? 0) > 0);
    this._setMessagesUi(viewer, wantsTiles);
  }

  private _setMessagesUi(viewer: RVViewer, on: boolean): void {
    if (on === this._messagesUiRegistered) return;
    this._messagesUiRegistered = on;
    if (on) viewer.uiRegistry.register(MAINTENANCE_MESSAGES_UI);
    else viewer.uiRegistry.unregister(MAINTENANCE_MESSAGES_UI.id);
  }

  /** `simulation-reset` during a guide: end terminally WITHOUT restore, back to the overview. */
  private _onSimulationReset(): void {
    // E7.3: counters stay; G3: baselines restart after the reset.
    this._triggers.onSimulationReset();
    if (!this._isGuideRunning()) return;
    this._terminate('reset');
    this.exitMaintenance();
  }

  /** An interface connected/disconnected: hand the machine over to the PLC when it goes live. */
  private _onInterfaceChange(): void {
    const live = this.isLive();
    this._triggers.live = live; // G4: live counts wall time, re-based on the switch
    if (this._state.mode === 'idle') return;
    if (live === this._state.isLive) return;
    this._state.isLive = live;
    if (live && this._isGuideRunning()) {
      // The guide continues without actions: visuals restored, no signal writes.
      this._navAbort?.abort();
      this._navAbort = null;
      this._endRuntime('live-handover');
      this.viewer?.setSimulationPaused('maintenance', false);
    }
    this._emitModeChanged();
  }

  /** Run flythrough mode — auto-advance through all steps (preview: no barrier). */
  private async _runFlythrough(): Promise<void> {
    if (!this._state.procedure || !this.viewer) return;
    const steps = this._state.procedure.steps;
    const signal = this._flythroughAbort?.signal;
    if (!signal) return;

    for (let i = 0; i < steps.length; i++) {
      if (signal.aborted) break;

      this._state.currentStep = i;
      const applied = this._goToStep(i, 'forward');
      this._emitModeChanged();

      // Wait for camera animation + dwell time AND the machine (shared tour-utils helper)
      await Promise.all([
        waitForCameraAndDwell(
          this.viewer,
          this._flythroughDwellMs,
          this._flythroughCameraTimeoutMs,
          signal,
        ),
        applied,
      ]);

      if (signal.aborted || !this.viewer) break;
    }

    if (!signal.aborted) {
      // Flythrough complete — transition to completed
      this._complete();
    }
  }

  /** Persist current progress to localStorage (stepbystep mode only). */
  private _persistProgress(): void {
    if (this._state.mode !== 'stepbystep' || !this._state.procedure) return;
    saveMaintenanceProgress(
      this._state.procedure.name,
      this._state.stepResults,
      this._state.currentStep,
    );
  }

  /** Emit the maintenance-mode-changed event (and publish the render-mode lock). */
  private _emitModeChanged(): void {
    const locked = this._isRenderModeLocked();
    this._state.renderModeLocked = locked;
    setMaintenanceRenderLock(locked);
    if (!this.viewer) return;
    const active = this._state.mode !== 'idle';

    // Update UI context so context-aware elements react to maintenance mode
    if (active) {
      activateContext('maintenance');
    } else {
      deactivateContext('maintenance');
    }

    this.viewer.emit('maintenance-mode-changed' as string, {
      active,
      mode: this._state.mode,
      procedure: this._state.procedure,
      currentStep: this._state.currentStep,
      stepResults: [...this._state.stepResults],
      isCameraAnimating: this._state.isCameraAnimating,
      isLive: this._state.isLive,
      renderModeLocked: locked,
    });
  }
}

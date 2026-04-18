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
 *   'maintenance-mode-changed'  — { active, mode, procedure, currentStep, stepResults }
 *   'maintenance-step-changed'  — { stepIndex, step }
 *
 * Events listened to:
 *   'enter-maintenance'         — Triggered by TileCard/Button clicks
 *   'camera-animation-done'     — Used to know when camera fly is complete
 */

import { Vector3 } from 'three';
import type { RVViewerPlugin } from '../../core/rv-plugin';
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

// Re-export shared types from core (canonical source of truth)
export type { MaintenanceMode, StepResult, MaintenanceState } from '../../core/types/plugin-types';
import type { MaintenanceMode, StepResult, MaintenanceState } from '../../core/types/plugin-types';

// ─── Plugin ─────────────────────────────────────────────────────────────

export class MaintenancePlugin implements RVViewerPlugin {
  readonly id = 'maintenance';
  readonly order = 200;

  private viewer: RVViewer | null = null;
  private _procedures: MaintenanceProcedure[] = [];
  private _state: MaintenanceState = {
    mode: 'idle',
    procedure: null,
    currentStep: 0,
    stepResults: [],
    isCameraAnimating: false,
  };

  /** AbortController for cancelling the flythrough async loop (standard Web API). */
  private _flythroughAbort: AbortController | null = null;

  /** Dwell time in ms for each step during flythrough mode. */
  private _flythroughDwellMs = 2500;

  /** Timeout (ms) to wait for 'camera-animation-done' before forcing continue. */
  private _flythroughCameraTimeoutMs = 5000;

  /** Unsubscribe functions for event listeners. */
  private _unsubs: (() => void)[] = [];

  // ─── Lifecycle ──────────────────────────────────────────────────────

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;

    // Parse maintenance procedures from GLB scene
    const root = viewer.scene.children.find(c => c !== null);
    if (root) {
      this._procedures = parseMaintenanceProcedures(viewer.scene);
    }

    // Listen for enter-maintenance event
    this._unsubs.push(
      viewer.on('enter-maintenance' as string, () => {
        this.enterMaintenance();
      })
    );
  }

  onModelCleared(_viewer: RVViewer): void {
    this.exitMaintenance();
    this._procedures = [];
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
  }

  dispose(): void {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    this.viewer = null;
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Get the current maintenance state (read-only snapshot). */
  getState(): MaintenanceState {
    return { ...this._state };
  }

  /** Get all discovered maintenance procedures. */
  getProcedures(): MaintenanceProcedure[] {
    return this._procedures;
  }

  /** Enter maintenance mode — show the mode selection dialog. */
  enterMaintenance(): void {
    if (!this.viewer) return;
    if (this._procedures.length === 0) {
      console.warn('[MaintenancePlugin] No maintenance procedures found in model');
      return;
    }

    // Use the first procedure by default
    const procedure = this._procedures[0];
    this._state = {
      mode: 'dialog',
      procedure,
      currentStep: 0,
      stepResults: new Array(procedure.steps.length).fill(null),
      isCameraAnimating: false,
    };

    this._emitModeChanged();
  }

  /**
   * Start a maintenance scenario in the specified mode.
   * @param procedure  The procedure to execute (or uses current if null).
   * @param mode       'flythrough' or 'stepbystep'.
   */
  startScenario(procedure: MaintenanceProcedure | null, mode: 'flythrough' | 'stepbystep'): void {
    if (!this.viewer) return;
    const proc = procedure ?? this._state.procedure;
    if (!proc) return;

    // Try to restore saved progress for stepbystep mode
    let startStep = 0;
    let stepResults: StepResult[] = new Array(proc.steps.length).fill(null);

    if (mode === 'stepbystep') {
      const saved = loadMaintenanceProgress(proc.name);
      if (saved && saved.stepResults.length > 0) {
        stepResults = saved.stepResults.slice(0, proc.steps.length);
        while (stepResults.length < proc.steps.length) stepResults.push(null);
        startStep = Math.min(saved.currentStep, proc.steps.length - 1);
      }
    }

    this._state = {
      mode,
      procedure: proc,
      currentStep: startStep,
      stepResults,
      isCameraAnimating: false,
    };
    // Fresh AbortController per flythrough invocation (abort is one-way).
    this._flythroughAbort?.abort();
    this._flythroughAbort = new AbortController();

    this._emitModeChanged();
    this._goToStep(startStep);

    if (mode === 'flythrough') {
      this._runFlythrough();
    }
  }

  /** Navigate to a specific step. */
  goToStep(stepIndex: number): void {
    if (!this._state.procedure) return;
    if (stepIndex < 0 || stepIndex >= this._state.procedure.steps.length) return;

    this._state.currentStep = stepIndex;
    this._goToStep(stepIndex);
    this._persistProgress();
    this._emitModeChanged();
  }

  /** Advance to the next step. */
  nextStep(): void {
    if (!this._state.procedure) return;
    const next = this._state.currentStep + 1;
    if (next >= this._state.procedure.steps.length) {
      // All steps done — transition to completed
      this._state.mode = 'completed';
      this._emitModeChanged();
      return;
    }
    this.goToStep(next);
  }

  /** Go back to the previous step. */
  prevStep(): void {
    if (!this._state.procedure) return;
    const prev = this._state.currentStep - 1;
    if (prev < 0) return;
    this.goToStep(prev);
  }

  /** Mark a step as completed with a result. */
  completeStep(stepIndex: number, result: 'pass' | 'fail' = 'pass'): void {
    if (!this._state.procedure) return;
    if (stepIndex < 0 || stepIndex >= this._state.stepResults.length) return;
    this._state.stepResults[stepIndex] = result;
    this._persistProgress();
    this._emitModeChanged();
  }

  /** Exit maintenance mode — clean up everything. */
  exitMaintenance(): void {
    this._flythroughAbort?.abort();
    if (this.viewer) {
      this.viewer.clearHighlight();
    }

    // If exiting from completed state, clear persisted progress
    // Otherwise keep it so user can resume later
    if (this._state.mode === 'completed' && this._state.procedure) {
      clearMaintenanceProgress(this._state.procedure.name);
    }

    this._state = {
      mode: 'idle',
      procedure: null,
      currentStep: 0,
      stepResults: [],
      isCameraAnimating: false,
    };
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

  /** Navigate camera and highlight for a step. */
  private _goToStep(stepIndex: number): void {
    if (!this.viewer || !this._state.procedure) return;
    const step = this._state.procedure.steps[stepIndex];
    if (!step) return;

    // Clear existing highlights
    this.viewer.clearHighlight();

    // Apply highlights for this step
    for (const path of step.highlightPaths) {
      this.viewer.highlightByPath(path, true);
    }

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
  }

  /** Run flythrough mode — auto-advance through all steps. */
  private async _runFlythrough(): Promise<void> {
    if (!this._state.procedure || !this.viewer) return;
    const steps = this._state.procedure.steps;
    const signal = this._flythroughAbort?.signal;
    if (!signal) return;

    for (let i = 0; i < steps.length; i++) {
      if (signal.aborted) break;

      this._state.currentStep = i;
      this._goToStep(i);
      this._emitModeChanged();

      // Wait for camera animation + dwell time (shared tour-utils helper)
      await waitForCameraAndDwell(
        this.viewer,
        this._flythroughDwellMs,
        this._flythroughCameraTimeoutMs,
        signal,
      );

      if (signal.aborted) break;
    }

    if (!signal.aborted) {
      // Flythrough complete — transition to completed
      this._state.mode = 'completed';
      this._emitModeChanged();
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

  /** Emit the maintenance-mode-changed event. */
  private _emitModeChanged(): void {
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
    });
  }
}

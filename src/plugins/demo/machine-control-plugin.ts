// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MachineControlPlugin — Demo machine control panel with PackML-inspired state machine.
 *
 * Provides a demo-first HMI operator interface for sales demos and trade shows.
 * Features:
 *   - 5-state machine: STOPPED | IDLE | RUNNING | HELD | ERROR
 *   - 3 modes: AUTO | MANUAL | MAINTENANCE (purely visual)
 *   - Auto-discovers drives and sensors from loaded 3D model
 *   - 3D integration: hover → highlight, click → fly-to, 3D click → scroll panel
 *   - ISA-101 inspired colors
 *
 * Events emitted:
 *   'machine-control-changed' — { state, mode, components, errorComponentIdx }
 */

import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import type { RVViewer } from '../../core/rv-viewer';

// Re-export shared types from core (canonical source of truth)
export type { MachineState, MachineMode, ComponentType, ComponentStatus, MachineComponent, MachineControlState } from '../../core/types/plugin-types';
import type { MachineState, MachineMode, MachineComponent, MachineControlState } from '../../core/types/plugin-types';

// ─── Plugin ─────────────────────────────────────────────────────────────

export class MachineControlPlugin implements RVViewerPlugin {
  readonly id = 'machine-control';
  readonly order = 210;

  private _viewer: RVViewer | null = null;
  private _state: MachineState = 'STOPPED';
  private _mode: MachineMode = 'AUTO';
  private _components: MachineComponent[] = [];
  private _errorComponentIdx = -1;
  private _unsubs: (() => void)[] = [];
  private _transitionCancelled = false;
  private _transitionTimer: ReturnType<typeof setTimeout> | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────────

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;
    this._resetState();
    this._discoverComponents(viewer);
    this._updateComponentStatuses();
    this._emitChanged();
  }

  onModelCleared(_viewer: RVViewer): void {
    this._cancelTransition();
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    this._resetState();
    this._components = [];
    this._emitChanged();
  }

  dispose(): void {
    this._cancelTransition();
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    this._viewer = null;
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Get current state snapshot. */
  getState(): MachineControlState {
    return {
      state: this._state,
      mode: this._mode,
      components: [...this._components],
      errorComponentIdx: this._errorComponentIdx,
    };
  }

  get machineState(): MachineState { return this._state; }
  get machineMode(): MachineMode { return this._mode; }
  get components(): MachineComponent[] { return this._components; }
  get errorComponentIdx(): number { return this._errorComponentIdx; }

  /** Reset: STOPPED -> IDLE */
  reset(): void {
    if (this._state !== 'STOPPED' && this._state !== 'ERROR') return;
    this._cancelTransition();
    if (this._state === 'ERROR') {
      this._clearError();
    }
    this._setState('IDLE');
  }

  /** Start: any non-running state -> RUNNING */
  start(): void {
    if (this._state === 'RUNNING') return;
    if (this._state === 'ERROR') this._clearError();
    this._setState('RUNNING');
    this._updateComponentStatuses();
  }

  /** Stop: RUNNING | HELD -> IDLE */
  stop(): void {
    if (this._state !== 'RUNNING' && this._state !== 'HELD') return;
    this._cancelTransition();
    this._setState('IDLE');
    this._updateComponentStatuses();
  }

  /** Hold: RUNNING -> HELD */
  hold(): void {
    if (this._state !== 'RUNNING') return;
    this._setState('HELD');
    this._updateComponentStatuses();
  }

  /** Resume: HELD -> RUNNING */
  resume(): void {
    if (this._state !== 'HELD') return;
    this._setState('RUNNING');
    this._updateComponentStatuses();
  }

  /** Emergency Stop: any state -> ERROR */
  emergencyStop(): void {
    if (this._state === 'ERROR') return;
    this._cancelTransition();
    this._setState('ERROR');
    // Pick a random component for the demo error effect
    if (this._components.length > 0) {
      this._errorComponentIdx = Math.floor(Math.random() * this._components.length);
      this._components[this._errorComponentIdx].status = 'error';
      // Show error glow in 3D
      const path = this._components[this._errorComponentIdx].path;
      if (this._viewer && path) {
        this._viewer.highlightByPath(path, true);
      }
    }
    this._updateComponentStatuses();
    this._emitChanged();
  }

  /** Clear error: ERROR -> STOPPED */
  clearError(): void {
    if (this._state !== 'ERROR') return;
    this._clearError();
    this._setState('STOPPED');
  }

  /** Set mode (purely visual in demo). */
  setMode(mode: MachineMode): void {
    if (this._mode === mode) return;
    this._mode = mode;
    this._emitChanged();
  }

  /** Hover a component — highlight in 3D. */
  hoverComponent(path: string): void {
    if (!path || !this._viewer) return;
    try {
      this._viewer.highlightByPath(path, true);
    } catch { /* silently ignore invalid paths */ }
  }

  /** Click a component — fly to in 3D. */
  clickComponent(path: string): void {
    if (!path || !this._viewer) return;
    try {
      this._viewer.focusByPath(path);
    } catch { /* silently ignore invalid paths */ }
  }

  /** Leave component — clear highlight. */
  leaveComponent(): void {
    if (!this._viewer) return;
    // Only clear if not in error state (error glow should persist)
    if (this._state !== 'ERROR') {
      this._viewer.clearHighlight();
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private _resetState(): void {
    this._state = 'RUNNING';
    this._mode = 'AUTO';
    this._errorComponentIdx = -1;
    this._transitionCancelled = false;
  }

  private _setState(state: MachineState): void {
    this._state = state;
    this._emitChanged();
  }

  private _clearError(): void {
    if (this._errorComponentIdx >= 0 && this._errorComponentIdx < this._components.length) {
      // Reset the error component status
      const comp = this._components[this._errorComponentIdx];
      comp.status = comp.type === 'drive' ? 'stopped' : 'inactive';
    }
    this._errorComponentIdx = -1;
    if (this._viewer) {
      this._viewer.clearHighlight();
    }
  }

  private _cancelTransition(): void {
    this._transitionCancelled = true;
    if (this._transitionTimer !== null) {
      clearTimeout(this._transitionTimer);
      this._transitionTimer = null;
    }
  }

  private _updateComponentStatuses(): void {
    const isRunning = this._state === 'RUNNING';
    const isError = this._state === 'ERROR';

    for (let i = 0; i < this._components.length; i++) {
      if (isError && i === this._errorComponentIdx) continue; // keep error status
      const comp = this._components[i];
      if (comp.type === 'drive') {
        comp.status = isRunning ? 'running' : 'stopped';
      } else {
        // Sensors: active when running, inactive otherwise
        comp.status = isRunning ? 'active' : 'inactive';
      }
    }
  }

  /** Patterns for drives to exclude from the component list. */
  private static readonly _EXCLUDE_PATTERNS = /grip|finger|clamp|jaw/i;
  /** Patterns for robot axis drives to group into a single "Robot" entry. */
  private static readonly _ROBOT_AXIS_PATTERN = /^axis\d|^a\d|^j\d/i;

  private _discoverComponents(viewer: RVViewer): void {
    this._components = [];

    // Collect drives, grouping robot axes and filtering grippers
    let robotPath = '';
    let hasRobotAxes = false;

    for (const drive of viewer.drives) {
      const name = drive.name;
      // Skip gripper/finger drives
      if (MachineControlPlugin._EXCLUDE_PATTERNS.test(name)) continue;
      // Group robot axes into one entry
      if (MachineControlPlugin._ROBOT_AXIS_PATTERN.test(name)) {
        if (!hasRobotAxes) {
          hasRobotAxes = true;
          // Use the parent path as robot path (e.g. "Cell/Robot" from "Cell/Robot/Axis1")
          const fullPath = viewer.registry?.getPathForNode(drive.node) ?? '';
          const parts = fullPath.split('/');
          robotPath = parts.length > 1 ? parts.slice(0, -1).join('/') : fullPath;
        }
        continue;
      }
      const path = viewer.registry?.getPathForNode(drive.node) ?? '';
      this._components.push({ name, path, type: 'drive', status: 'stopped' });
    }

    // Add grouped robot entry at the beginning
    if (hasRobotAxes) {
      this._components.unshift({ name: 'Robot', path: robotPath, type: 'drive', status: 'stopped' });
    }

    // Add all sensors
    const sensors = viewer.transportManager?.sensors ?? [];
    for (const sensor of sensors) {
      const path = viewer.registry?.getPathForNode(sensor.node) ?? '';
      this._components.push({ name: sensor.node.name, path, type: 'sensor', status: 'inactive' });
    }
  }

  private _emitChanged(): void {
    if (!this._viewer) return;
    this._viewer.emit('machine-control-changed' as string, {
      state: this._state,
      mode: this._mode,
      components: this._components,
      errorComponentIdx: this._errorComponentIdx,
    });
  }
}

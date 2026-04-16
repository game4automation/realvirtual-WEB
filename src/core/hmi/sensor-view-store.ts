// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * sensor-view-store — persists the Web Sensor panel UI state
 * (visible / shapeOverride / isolate) across reloads via localStorage.
 */

import type { GizmoShape } from '../engine/rv-gizmo-manager';

export interface SensorViewState {
  visible: boolean;
  shapeOverride: GizmoShape | null;
  isolate: boolean;
}

const STORAGE_KEY = 'rv-sensor-view-state';

class SensorViewStore {
  private _state: SensorViewState;
  private _listeners = new Set<() => void>();

  constructor() {
    this._state = this.load();
  }

  /** Read state from localStorage (exposed for tests + external reloads). */
  load(): SensorViewState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this._defaults();
      const parsed = JSON.parse(raw) as Partial<SensorViewState>;
      return {
        visible: parsed.visible ?? true,
        shapeOverride: parsed.shapeOverride ?? null,
        isolate: parsed.isolate ?? false,
      };
    } catch {
      return this._defaults();
    }
  }

  private _defaults(): SensorViewState {
    return { visible: true, shapeOverride: null, isolate: false };
  }

  getSnapshot = (): SensorViewState => this._state;

  subscribe = (l: () => void): (() => void) => {
    this._listeners.add(l);
    return () => { this._listeners.delete(l); };
  };

  setIsolate(v: boolean): void {
    this._state = { ...this._state, isolate: v };
    this._persist();
  }

  setVisible(v: boolean): void {
    this._state = { ...this._state, visible: v };
    this._persist();
  }

  setShapeOverride(s: GizmoShape | null): void {
    this._state = { ...this._state, shapeOverride: s };
    this._persist();
  }

  private _persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._state));
    } catch { /* quota/disabled storage */ }
    for (const l of this._listeners) l();
  }
}

export const sensorViewStore = new SensorViewStore();

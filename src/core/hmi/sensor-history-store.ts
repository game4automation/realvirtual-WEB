// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * sensor-history-store — Module-level store for the floating SensorHistoryPanel.
 *
 * Single-instance: open() replaces any currently-shown sensor (no stacking).
 * Used via useSyncExternalStore in SensorHistoryPanel. Show-buttons in pinned
 * WebSensor tooltips call open() with a SensorHistoryRef to trigger the panel.
 *
 * Layout (position + size) is persisted in sessionStorage so panels restore
 * within the same browser tab.
 */

import { useSyncExternalStore } from 'react';
import type { WebSensorState } from '../engine/rv-web-sensor';

// ─── Types ─────────────────────────────────────────────────────────────

export type SensorHistoryMode = 'single' | 'all';
export type SensorHistoryWindow = '1m' | '5m' | '15m' | '1h';

/** Minimal sensor reference shown in the history panel. */
export interface SensorHistoryRef {
  /** Stable hierarchy path (seeds the PRNG). */
  path: string;
  /** Display label (WebSensor.Label, or fallback). */
  label: string;
  /** Whether the underlying sensor can emit warning/error (true) or only low/high (false). */
  isInt: boolean;
  /** Optional int→state map (for future use with int-driven sensors). */
  intMap?: Map<number, WebSensorState>;
}

/** Persisted panel layout (position + size in CSS pixels). */
export interface SensorHistoryPanelLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Full state shape. */
export interface SensorHistoryState {
  activeSensor: SensorHistoryRef | null;
  mode: SensorHistoryMode;
  window: SensorHistoryWindow;
  layout: SensorHistoryPanelLayout;
}

// ─── Storage (sessionStorage — persists for the tab session) ───────────

/** Storage key — listed in ALL_RV_STORAGE_KEYS for consistency. */
const STORAGE_KEY = 'rv-sensor-history';

/** Default layout — bottom-right, 640×420. Fits DemoRealvirtualWeb comfortably. */
export const DEFAULT_LAYOUT: SensorHistoryPanelLayout = {
  x: 0,
  y: 0,
  w: 640,
  h: 420,
};

/** Clamp a layout so the panel is always reachable inside the current viewport. */
function clampToViewport(layout: SensorHistoryPanelLayout): SensorHistoryPanelLayout {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
  return {
    x: Math.max(0, Math.min(layout.x, vw - 80)),
    y: Math.max(0, Math.min(layout.y, vh - 60)),
    w: Math.max(240, layout.w),
    h: Math.max(160, layout.h),
  };
}

/** Build a sensible default bottom-right position for the initial panel mount. */
function defaultBottomRightLayout(): SensorHistoryPanelLayout {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 720;
  const w = DEFAULT_LAYOUT.w;
  const h = DEFAULT_LAYOUT.h;
  // Safely clamped — leaves a 16 px margin to the right and 80 px above the BottomBar.
  const x = Math.max(0, vw - w - 16);
  const y = Math.max(0, vh - h - 80);
  return { x, y, w, h };
}

function loadLayout(): SensorHistoryPanelLayout {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultBottomRightLayout();
    const parsed = JSON.parse(raw) as Partial<SensorHistoryPanelLayout>;
    if (
      typeof parsed.x !== 'number' || typeof parsed.y !== 'number' ||
      typeof parsed.w !== 'number' || typeof parsed.h !== 'number'
    ) {
      return defaultBottomRightLayout();
    }
    return clampToViewport({ x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h });
  } catch {
    return defaultBottomRightLayout();
  }
}

function saveLayout(layout: SensorHistoryPanelLayout): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Private-mode or quota — ignore.
  }
}

// ─── Internal state ────────────────────────────────────────────────────

let _state: SensorHistoryState = {
  activeSensor: null,
  mode: 'single',
  window: '5m',
  layout: loadLayout(),
};

/** Reference-stable snapshot — handed out unchanged until _state is mutated. */
let _snapshot: SensorHistoryState = _state;

const _listeners = new Set<() => void>();

function notify(): void {
  _snapshot = _state;
  for (const l of _listeners) l();
}

// ─── Store API ─────────────────────────────────────────────────────────

export interface SensorHistoryStore {
  getSnapshot(): SensorHistoryState;
  subscribe(cb: () => void): () => void;
  open(sensor: SensorHistoryRef): void;
  close(): void;
  setMode(mode: SensorHistoryMode): void;
  setWindow(window: SensorHistoryWindow): void;
  setLayout(layout: Partial<SensorHistoryPanelLayout>): void;
}

export const sensorHistoryStore: SensorHistoryStore = {
  getSnapshot: () => _snapshot,

  subscribe(cb) {
    _listeners.add(cb);
    return () => { _listeners.delete(cb); };
  },

  /**
   * Single-instance open: replaces any currently-shown sensor.
   * When re-opened with the same sensor, this is a no-op (snapshot stays stable).
   */
  open(sensor) {
    if (_state.activeSensor?.path === sensor.path && _state.activeSensor) {
      // Same sensor already open — nothing changed.
      return;
    }
    _state = { ..._state, activeSensor: sensor };
    notify();
  },

  close() {
    if (_state.activeSensor === null) return;
    _state = { ..._state, activeSensor: null };
    notify();
  },

  setMode(mode) {
    if (_state.mode === mode) return;
    _state = { ..._state, mode };
    notify();
  },

  setWindow(window) {
    if (_state.window === window) return;
    _state = { ..._state, window };
    notify();
  },

  setLayout(layout) {
    const merged: SensorHistoryPanelLayout = {
      x: layout.x ?? _state.layout.x,
      y: layout.y ?? _state.layout.y,
      w: layout.w ?? _state.layout.w,
      h: layout.h ?? _state.layout.h,
    };
    // Short-circuit if nothing actually changed (snapshot stability).
    const cur = _state.layout;
    if (
      cur.x === merged.x && cur.y === merged.y &&
      cur.w === merged.w && cur.h === merged.h
    ) {
      return;
    }
    _state = { ..._state, layout: merged };
    saveLayout(merged);
    notify();
  },
};

/** React hook — subscribe to the sensor-history store. */
export function useSensorHistory(): SensorHistoryState {
  return useSyncExternalStore(
    sensorHistoryStore.subscribe,
    sensorHistoryStore.getSnapshot,
    sensorHistoryStore.getSnapshot,
  );
}

// ─── Test helper (non-exported in public API docs) ─────────────────────

/** Reset the store to defaults — used only by unit tests. */
export function __resetSensorHistoryStore(): void {
  _state = {
    activeSensor: null,
    mode: 'single',
    window: '5m',
    layout: defaultBottomRightLayout(),
  };
  _snapshot = _state;
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  for (const l of _listeners) l();
}

/** Storage key — exported for rv-storage-keys consistency. */
export const SENSOR_HISTORY_STORAGE_KEY = STORAGE_KEY;

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from './rv-safe-storage';

/**
 * trace-settings-store.ts — the time range of the congestion trace (plan-629).
 *
 * One setting for both trace views ("Spur Blockierung" / "Spur Auslastung"):
 * the last hour / the last day of sim time (default: last hour) or "since start" (total), plus the window
 * length. The Display panel's chip, the MCP tool `web_trace_set` and the
 * `PathTracePlugin` read and write it here; a change re-colours the bands
 * independently of any counter change (gate R1-9).
 *
 * VANILLA module (no react import), the same layering as
 * `overlay-visibility-store.ts`: a stable snapshot that changes reference on
 * every mutation (useSyncExternalStore-safe), persisted under its own
 * localStorage key `rv-trace-settings` (read / write in try/catch).
 */

import {
  TRACE_WINDOW_DAY_SEC, TRACE_WINDOW_HOUR_SEC, snapTraceWindowSec, type TraceRange, type TraceView,
} from './engine/rv-path-trace';

export interface TraceSettings {
  /** 'window' = sliding window of `windowSec`, 'start' = since the start of the run. */
  readonly range: TraceRange;
  /** Window length (s sim time): 3600 (last hour) or 86400 (last day). */
  readonly windowSec: number;
  /** Bumped on every mutation. */
  readonly version: number;
}

const STORAGE_KEY = 'rv-trace-settings';

/** Clamp a window length to the supported range (default for non-finite input). */
export function clampTraceWindowSec(sec: number): number {
  return snapTraceWindowSec(sec);
}

/** Parse a persisted blob (pure, exported for tests); invalid fields fall back to the defaults. */
export function parseStoredTraceSettings(raw: string | null): { range: TraceRange; windowSec: number } {
  const out = { range: 'window' as TraceRange, windowSec: TRACE_WINDOW_HOUR_SEC };
  if (!raw) return out;
  try {
    const p = JSON.parse(raw) as { range?: unknown; windowSec?: unknown };
    if (p.range === 'window' || p.range === 'start') out.range = p.range;
    if (typeof p.windowSec === 'number') out.windowSec = clampTraceWindowSec(p.windowSec);
  } catch {
    /* defaults */
  }
  return out;
}

function load(): { range: TraceRange; windowSec: number } {
  try {
    return parseStoredTraceSettings(readLocalStorage(STORAGE_KEY));
  } catch {
    return parseStoredTraceSettings(null);
  }
}

const initial = load();
let snapshot: TraceSettings = { range: initial.range, windowSec: initial.windowSec, version: 0 };
const listeners = new Set<() => void>();

function persist(): void {
  try {
    writeLocalStorage(STORAGE_KEY, JSON.stringify({ range: snapshot.range, windowSec: snapshot.windowSec }));
  } catch {
    /* ignore quota / unavailable */
  }
}

function commit(range: TraceRange, windowSec: number): void {
  snapshot = { range, windowSec, version: snapshot.version + 1 };
  persist();
  for (const cb of listeners) cb();
}

/** Current settings — stable reference until the next change. */
export function getTraceSettings(): TraceSettings {
  return snapshot;
}

/** Switch the time range. No-op when unchanged. */
export function setTraceRange(range: TraceRange): void {
  if (range !== 'window' && range !== 'start') return;
  if (range === snapshot.range) return;
  commit(range, snapshot.windowSec);
}

/** Set the window length (clamped 60–3600 s). No-op when unchanged. */
export function setTraceWindowSec(sec: number): void {
  const s = clampTraceWindowSec(sec);
  if (s === snapshot.windowSec) return;
  commit(snapshot.range, s);
}

/** Chip label of the window ("Letzte Stunde", "Letzter Tag"). */
export function traceWindowLabel(sec: number): string {
  return snapTraceWindowSec(sec) === TRACE_WINDOW_DAY_SEC ? 'Letzter Tag' : 'Letzte Stunde';
}

/** The three "Zeitraum" choices of the Display panel. */
export type TracePreset = 'hour' | 'day' | 'total';

/** Preset of the current settings. */
export function tracePresetOf(s: Pick<TraceSettings, 'range' | 'windowSec'>): TracePreset {
  if (s.range === 'start') return 'total';
  return snapTraceWindowSec(s.windowSec) === TRACE_WINDOW_DAY_SEC ? 'day' : 'hour';
}

/** Pick a preset in ONE change (range + window). No-op when unchanged. */
export function setTracePreset(preset: TracePreset): void {
  const range: TraceRange = preset === 'total' ? 'start' : 'window';
  const windowSec = preset === 'day' ? TRACE_WINDOW_DAY_SEC : preset === 'hour' ? TRACE_WINDOW_HOUR_SEC : snapshot.windowSec;
  if (range === snapshot.range && windowSec === snapshot.windowSec) return;
  commit(range, windowSec);
}

/** Subscribe to any change. Returns the unsubscribe function. */
export function subscribeTraceSettings(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Back to the defaults (tests). Notifies like a normal change. */
export function resetTraceSettings(): void {
  commit('window', TRACE_WINDOW_HOUR_SEC);
}

// ── Legend (the colour range of the current run) ─────────────────────────

/** Range of the loaded buckets of one view: `lo` is drawn yellow, `hi` red; null = no load yet. */
export interface TraceLegendRange { readonly lo: number; readonly hi: number }
export type TraceLegend = Readonly<Record<TraceView, TraceLegendRange | null>>;

let legend: TraceLegend = { blocked: null, utilization: null };
const legendListeners = new Set<() => void>();

/** Current legend — stable reference until the next change. */
export function getTraceLegend(): TraceLegend {
  return legend;
}

/**
 * Publish the colour range of one view (the trace plugin, on every re-colour).
 * Changes below 0.1 percentage points are ignored, so the panel does not
 * re-render twice a second for noise. Separate listeners from the settings:
 * a legend change must not re-colour the bands.
 */
export function setTraceLegend(view: TraceView, lo: number | null, hi: number | null): void {
  const cur = legend[view];
  const next = lo === null || hi === null ? null : { lo, hi };
  const same = cur === null || next === null
    ? cur === next
    : Math.abs(cur.lo - next.lo) < 1e-3 && Math.abs(cur.hi - next.hi) < 1e-3;
  if (same) return;
  legend = { ...legend, [view]: next };
  for (const cb of legendListeners) cb();
}

/** Subscribe to legend changes. Returns the unsubscribe function. */
export function subscribeTraceLegend(cb: () => void): () => void {
  legendListeners.add(cb);
  return () => {
    legendListeners.delete(cb);
  };
}

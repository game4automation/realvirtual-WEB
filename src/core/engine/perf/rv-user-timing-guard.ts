// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-user-timing-guard.ts — DEV ONLY: bound the User-Timing buffer the React dev build fills.
 *
 * React 19.2's development build logs its "Components ⚛" performance track through
 * `performance.measure(name, { detail: { devtools: { properties } } })` for every component that
 * re-rendered with changed props — `properties` is the serialised props diff. The User-Timing
 * buffer has no limit (`performance.getEntriesByType('measure')` grows until the page is
 * unloaded), so every such measure is retained for the life of the tab: Blink keeps the entry
 * (embedder heap) plus the structured-cloned `detail`. A component tree that re-renders often
 * turns that into a memory leak of the dev server session only — the production build has no
 * performance track. Measured 2026-11-03 (DES Experiments window, realvirtual WEB dev build):
 * ~2000 entries and ~0.6 MB of props diffs per 2-second refresh, 113k entries after 45 s,
 * +0.2 GB/min of renderer private bytes; `performance.clearMeasures()` released it at once.
 *
 * The guard polls the buffer and clears React's own measures (names React prefixes with
 * U+200B) once they exceed `limit`; other measures (the viewer's own diagnostics) stay. It is
 * installed from the `import.meta.env.DEV` block of main.ts, so it is 0 bytes in production.
 * The fix for a component that re-renders without a change is still to stop that re-render
 * (the experiment matrix keeps its previous state when a poll re-reads equal content); this
 * guard keeps a long dev session alive while the tree DOES change (a running batch).
 */

/** The subset of `Performance` the guard uses (injectable for tests). */
export interface UserTimingLike {
  getEntriesByType(type: string): ReadonlyArray<{ name: string; detail?: unknown }>;
  clearMeasures(name?: string): void;
}

export interface UserTimingGuardOptions {
  /** Entries above which the React measures are cleared. */
  limit?: number;
  /** Poll interval in milliseconds. */
  intervalMs?: number;
  performance?: UserTimingLike;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  /** Called once per clear with the number of entries dropped. */
  onClear?: (dropped: number) => void;
}

/** React's dev performance track prefixes every component measure with a zero-width space. */
export const REACT_MEASURE_PREFIX = '​';

/**
 * React's measure, by two independent marks: the component measures carry the U+200B name prefix,
 * and every entry of the performance track (also the unprefixed `Update`, `Mount`, `Recovered`,
 * `Errored` …) carries `detail.devtools.track` / `trackGroup` named with the atom sign (⚛).
 */
export function isReactMeasure(entry: { name: string; detail?: unknown }): boolean {
  if (entry.name.startsWith(REACT_MEASURE_PREFIX)) return true;
  const devtools = (entry.detail as { devtools?: { track?: unknown; trackGroup?: unknown } } | null | undefined)?.devtools;
  return !!devtools && [devtools.track, devtools.trackGroup].some(t => typeof t === 'string' && t.includes('⚛'));
}

/**
 * One sweep: when the buffer holds more than `limit` entries (all measures count — the limit bounds
 * the buffer, not React's share), clear every name React's entries use. `clearMeasures` works by
 * name, so a non-React measure that shares a name with a React trigger (`Update`) goes with it; the
 * viewer's own diagnostics use distinct names. Returns the number of entries dropped.
 */
export function sweepReactMeasures(perf: UserTimingLike, limit: number): number {
  const entries = perf.getEntriesByType('measure');
  if (entries.length <= limit) return 0;
  const names = new Set<string>();
  for (const entry of entries) if (isReactMeasure(entry)) names.add(entry.name);
  for (const name of names) perf.clearMeasures(name);
  return entries.length - perf.getEntriesByType('measure').length;
}

/** Install the polling guard; returns the uninstall function. No-op where User Timing is unavailable. */
export function installUserTimingGuard(options: UserTimingGuardOptions = {}): () => void {
  const perf = options.performance ?? (globalThis.performance as unknown as UserTimingLike | undefined);
  if (!perf || typeof perf.getEntriesByType !== 'function' || typeof perf.clearMeasures !== 'function') return () => {};
  const limit = options.limit ?? 20_000;
  const setTimer = options.setInterval ?? globalThis.setInterval;
  const clearTimer = options.clearInterval ?? globalThis.clearInterval;
  const timer = setTimer(() => {
    const dropped = sweepReactMeasures(perf, limit);
    if (dropped > 0) options.onClear?.(dropped);
  }, options.intervalMs ?? 5000);
  return () => clearTimer(timer);
}

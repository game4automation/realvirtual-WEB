// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Dev-only User-Timing buffer guard (2026-11-03 DES Experiments leak): React's dev build retains
 * one `performance.measure` with a props diff per re-rendered component in the unbounded
 * User-Timing buffer. The guard clears React's measures (U+200B prefix) above a limit and leaves
 * the viewer's own measures alone.
 */
import { describe, it, expect, vi } from 'vitest';
import { installUserTimingGuard, sweepReactMeasures, isReactMeasure, REACT_MEASURE_PREFIX, type UserTimingLike } from '../src/core/engine/perf/rv-user-timing-guard';

type Entry = { name: string; detail?: unknown };
function fakePerformance(initial: Array<string | Entry> = []): UserTimingLike & { names: string[]; entries: Entry[] } {
  const perf = {
    entries: initial.map(e => typeof e === 'string' ? { name: e } : e),
    get names() { return perf.entries.map(e => e.name); },
    set names(names: string[]) { perf.entries = names.map(name => ({ name })); },
    getEntriesByType(type: string) { return type === 'measure' ? perf.entries : []; },
    clearMeasures(name?: string) { perf.entries = name === undefined ? [] : perf.entries.filter(e => e.name !== name); },
  };
  return perf;
}
/** React's unprefixed track entries (`Update`, `Recovered` …) carry the atom-signed track in `detail`. */
const reactTrigger = (name: string): Entry => ({ name, detail: { devtools: { track: 'Components ⚛' } } });

describe('rv-user-timing-guard', () => {
  it('recognises React entries by the U+200B prefix or the atom-signed devtools track', () => {
    expect(isReactMeasure({ name: `${REACT_MEASURE_PREFIX}Box` })).toBe(true);
    expect(isReactMeasure(reactTrigger('Update'))).toBe(true);
    expect(isReactMeasure({ name: 'Recovered', detail: { devtools: { trackGroup: 'Scheduler ⚛' } } })).toBe(true);
    expect(isReactMeasure({ name: 'Update' })).toBe(false);
    expect(isReactMeasure({ name: 'rv-highlight', detail: { devtools: { track: 'realvirtual' } } })).toBe(false);
    expect(isReactMeasure({ name: 'rv-pick', detail: null })).toBe(false);
  });

  it('clears the unprefixed React triggers too, and keeps the viewer measure of a similar shape', () => {
    const perf = fakePerformance([reactTrigger('Update'), reactTrigger('Mount'), { name: 'rv-bake', detail: { devtools: { track: 'realvirtual' } } }, 'rv-highlight']);
    expect(sweepReactMeasures(perf, 1)).toBe(2);
    expect(perf.names).toEqual(['rv-bake', 'rv-highlight']);
  });

  it('leaves the buffer alone below the limit', () => {
    const perf = fakePerformance([`${REACT_MEASURE_PREFIX}Box`, 'rv-highlight']);
    expect(sweepReactMeasures(perf, 10)).toBe(0);
    expect(perf.names).toHaveLength(2);
  });

  it('clears only React measures once the buffer exceeds the limit', () => {
    const names = ['rv-highlight', 'rv-pick'];
    for (let i = 0; i < 50; i++) names.push(`${REACT_MEASURE_PREFIX}${i % 2 ? 'Box' : 'Typography'}`);
    const perf = fakePerformance(names);
    expect(sweepReactMeasures(perf, 20)).toBe(50);
    expect(perf.names).toEqual(['rv-highlight', 'rv-pick']);
  });

  it('polls on the interval, reports what it dropped and stops on uninstall', () => {
    vi.useFakeTimers();
    try {
      const perf = fakePerformance(Array.from({ length: 30 }, (_, i) => `${REACT_MEASURE_PREFIX}C${i}`));
      const onClear = vi.fn();
      const uninstall = installUserTimingGuard({ performance: perf, limit: 10, intervalMs: 1000, onClear });
      vi.advanceTimersByTime(999);
      expect(perf.names).toHaveLength(30);
      vi.advanceTimersByTime(1);
      expect(perf.names).toHaveLength(0);
      expect(onClear).toHaveBeenCalledWith(30);
      uninstall();
      perf.names = Array.from({ length: 30 }, (_, i) => `${REACT_MEASURE_PREFIX}C${i}`);
      vi.advanceTimersByTime(5000);
      expect(perf.names).toHaveLength(30);
      expect(onClear).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('is a no-op where User Timing is unavailable', () => {
    expect(() => installUserTimingGuard({ performance: {} as UserTimingLike })()).not.toThrow();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useThrottledSignalValue } from '../src/hooks/use-throttled-signal';
import type { SignalStore } from '../src/core/engine/rv-signal-store';

/** Minimal fake SignalStore: get + subscribe + a test-only emit. */
function makeStore(initial: Record<string, boolean | number> = {}) {
  const values = new Map<string, boolean | number>(Object.entries(initial));
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const store = {
    get: (name: string) => values.get(name),
    subscribe: (name: string, cb: (v: boolean | number) => void) => {
      let set = subs.get(name);
      if (!set) { set = new Set(); subs.set(name, set); }
      set.add(cb);
      return () => { set!.delete(cb); };
    },
    /** test helper — push a new value and notify subscribers (mirrors _apply). */
    emit(name: string, v: boolean | number) {
      values.set(name, v);
      subs.get(name)?.forEach(cb => cb(v));
    },
    /** test helper — active subscriber count for a signal. */
    subCount: (name: string) => subs.get(name)?.size ?? 0,
  };
  return store;
}

describe('useThrottledSignalValue', () => {
  beforeEach(() => vi.useFakeTimers());
  // cleanup() unmounts hooks first (releasing the shared ticker) so the module-global
  // timer/liveCount don't leak into the next test — otherwise the acquire guard would
  // keep a dead timer and no new (fake) interval would ever fire.
  afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

  it('returns the current value on mount', () => {
    const store = makeStore({ sig: 5 });
    const { result } = renderHook(() =>
      useThrottledSignalValue(store as unknown as SignalStore, 'sig'));
    expect(result.current).toBe(5);
  });

  it('does not update before the flush interval, then commits the latest value', () => {
    const store = makeStore({ sig: false });
    const { result } = renderHook(() =>
      useThrottledSignalValue(store as unknown as SignalStore, 'sig'));

    act(() => { store.emit('sig', true); });
    // No timer advance yet → still the initial value (change is only queued).
    expect(result.current).toBe(false);

    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current).toBe(true);
  });

  it('coalesces many rapid changes into a single committed value', () => {
    const store = makeStore({ sig: 0 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useThrottledSignalValue(store as unknown as SignalStore, 'sig');
    });
    const rendersBefore = renders;

    act(() => {
      store.emit('sig', 1);
      store.emit('sig', 2);
      store.emit('sig', 3); // three changes within one interval
    });
    expect(result.current).toBe(0); // nothing flushed yet

    act(() => { vi.advanceTimersByTime(200); });
    expect(result.current).toBe(3);            // only the last value wins
    expect(renders - rendersBefore).toBeLessThanOrEqual(1); // one batched re-render, not three
  });

  it('does not re-commit when the value returns to the committed value within an interval', () => {
    const store = makeStore({ sig: 10 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useThrottledSignalValue(store as unknown as SignalStore, 'sig');
    });
    const rendersBefore = renders;

    act(() => {
      store.emit('sig', 99);
      store.emit('sig', 10); // back to committed within the same window
    });
    act(() => { vi.advanceTimersByTime(200); });

    expect(result.current).toBe(10);
    expect(renders - rendersBefore).toBe(0); // no re-render at all (latest === committed)
  });

  it('is disabled with a null store and never subscribes', () => {
    const store = makeStore({ sig: 1 });
    const { result } = renderHook(() =>
      useThrottledSignalValue(null, 'sig'));
    expect(result.current).toBeUndefined();
    expect(store.subCount('sig')).toBe(0);
  });

  it('unsubscribes on unmount', () => {
    const store = makeStore({ sig: 1 });
    const { unmount } = renderHook(() =>
      useThrottledSignalValue(store as unknown as SignalStore, 'sig'));
    expect(store.subCount('sig')).toBe(1);
    unmount();
    expect(store.subCount('sig')).toBe(0);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { createElement, StrictMode, type ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RVLogicEngine, StepStateInfo } from '../src/core/engine/rv-logic-engine';
import { StepState } from '../src/core/engine/rv-logic-step';
import { clearDirty, markDirty, subscribeTick } from '../src/hooks/shared-ui-ticker';
import { useStepState } from '../src/hooks/use-step-state';

function stepInfo(overrides: Partial<StepStateInfo> = {}): StepStateInfo {
  return {
    state: StepState.Idle,
    name: 'Step',
    type: 'LogicStep_Delay',
    progress: 0,
    ...overrides,
  };
}

function makeEngine(initial: Record<string, StepStateInfo | null>) {
  const values = new Map(Object.entries(initial));
  let calls = 0;
  const engine = {
    getStepInfo(path: string) {
      calls++;
      const value = values.get(path) ?? null;
      return value ? { ...value } : null;
    },
  } as unknown as RVLogicEngine;

  return {
    engine,
    calls: () => calls,
    set: (path: string, value: StepStateInfo | null) => values.set(path, value),
  };
}

describe('shared-ui-ticker and useStepState', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('uses one timer for push batches and persistent pull subscribers', () => {
    const push = vi.fn();
    const pull = vi.fn();
    markDirty(push);
    const unsubscribe = subscribeTick(pull);

    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(200); });
    expect(push).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledTimes(1);

    unsubscribe();
    clearDirty(push);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not acquire the ticker or poll when either argument is null', () => {
    const fake = makeEngine({ '/step': stepInfo() });
    const { rerender, result } = renderHook(
      ({ engine, path }: { engine: RVLogicEngine | null; path: string | null }) =>
        useStepState(engine, path),
      {
        initialProps: {
          engine: null as RVLogicEngine | null,
          path: '/step' as string | null,
        },
      },
    );

    expect(result.current).toBeNull();
    expect(fake.calls()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    rerender({ engine: fake.engine, path: null });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(fake.calls()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('polls once per shared tick and stops after unmount', () => {
    const fake = makeEngine({ '/step': stepInfo() });
    const { unmount } = renderHook(() => useStepState(fake.engine, '/step'));
    const initialCalls = fake.calls();

    act(() => { vi.advanceTimersByTime(600); });
    expect(fake.calls() - initialCalls).toBe(3);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the same result reference when only non-material fields change', () => {
    const fake = makeEngine({
      '/step': stepInfo({ state: StepState.Active, elapsed: 1.04, duration: 3, progress: 10 }),
    });
    const { result } = renderHook(() => useStepState(fake.engine, '/step'));
    const first = result.current;

    fake.set('/step', stepInfo({
      state: StepState.Active,
      elapsed: 1.049,
      duration: 3,
      progress: 80,
      name: 'Renamed without a material state change',
    }));
    act(() => { vi.advanceTimersByTime(200); });

    expect(result.current).toBe(first);
    expect(result.current?.elapsed).toBe(1);
  });

  it('commits state, duration, and elapsed changes with elapsed rounded to 0.1 seconds', () => {
    const fake = makeEngine({
      '/step': stepInfo({ state: StepState.Idle, elapsed: 0, duration: 2 }),
    });
    const { result } = renderHook(() => useStepState(fake.engine, '/step'));
    const first = result.current;

    fake.set('/step', stepInfo({ state: StepState.Active, elapsed: 0.26, duration: 2 }));
    act(() => { vi.advanceTimersByTime(200); });

    expect(result.current).not.toBe(first);
    expect(result.current).toMatchObject({
      state: StepState.Active,
      elapsed: 0.3,
      duration: 2,
    });
  });

  it('switches sources immediately and disables polling again with null arguments', () => {
    const first = makeEngine({ '/a': stepInfo({ name: 'A' }) });
    const second = makeEngine({ '/b': stepInfo({ name: 'B', state: StepState.Waiting }) });
    const { result, rerender } = renderHook(
      ({ engine, path }: { engine: RVLogicEngine | null; path: string | null }) =>
        useStepState(engine, path),
      {
        initialProps: {
          engine: first.engine as RVLogicEngine | null,
          path: '/a' as string | null,
        },
      },
    );

    rerender({ engine: second.engine, path: '/b' });
    expect(result.current?.name).toBe('B');
    expect(result.current?.state).toBe(StepState.Waiting);
    expect(vi.getTimerCount()).toBe(1);

    rerender({ engine: null, path: null });
    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('survives non-logic to logic to non-logic rerenders without changing hook order', () => {
    const fake = makeEngine({ '/step': stepInfo({ state: StepState.Active }) });
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useStepState(
        enabled ? fake.engine : null,
        enabled ? '/step' : null,
      ),
      { initialProps: { enabled: false } },
    );

    expect(result.current).toBeNull();
    rerender({ enabled: true });
    expect(result.current?.state).toBe(StepState.Active);
    rerender({ enabled: false });
    expect(result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tracks Idle to Active to Waiting to Finished transitions', () => {
    const fake = makeEngine({ '/step': stepInfo({ state: StepState.Idle }) });
    const { result } = renderHook(() => useStepState(fake.engine, '/step'));

    for (const state of [StepState.Active, StepState.Waiting, StepState.Finished]) {
      fake.set('/step', stepInfo({ state }));
      act(() => { vi.advanceTimersByTime(200); });
      expect(result.current?.state).toBe(state);
    }
  });

  it('does not leak duplicate subscriptions under React StrictMode', () => {
    const fake = makeEngine({ '/step': stepInfo() });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(StrictMode, null, children);
    renderHook(() => useStepState(fake.engine, '/step'), { wrapper });
    const callsBeforeTick = fake.calls();

    expect(vi.getTimerCount()).toBe(1);
    act(() => { vi.advanceTimersByTime(200); });
    expect(fake.calls() - callsBeforeTick).toBe(1);
  });
});

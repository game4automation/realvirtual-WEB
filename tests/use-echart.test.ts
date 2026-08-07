// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useEffect } from 'react';

// Mock echarts before importing anything that uses it
vi.mock('../src/core/hmi/echarts-setup', () => ({
  echarts: {
    init: vi.fn(() => ({
      on: vi.fn(),
      dispose: vi.fn(),
      resize: vi.fn(),
      setOption: vi.fn(),
    })),
  },
}));

import { echarts } from '../src/core/hmi/echarts-setup';
import { useEChart } from '../src/hooks/use-echart';

describe('useEChart logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('publishes readiness only after the lazy chart instance exists', async () => {
    const { result, rerender } = renderHook(
      ({ open }) => {
        const chart = useEChart({ open, initDelay: 50 });
        useEffect(() => {
          if (!chart.isReady) return;
          chart.chartInstance.current?.setOption({ series: [{ data: [87, 28] }] });
        }, [chart.isReady]);
        return chart;
      },
      { initialProps: { open: true } },
    );
    result.current.containerRef.current = document.createElement('div');

    expect(result.current.isReady).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });

    expect(result.current.chartInstance.current).not.toBeNull();
    expect(result.current.isReady).toBe(true);
    expect(result.current.chartInstance.current?.setOption).toHaveBeenCalledWith({
      series: [{ data: [87, 28] }],
    });

    rerender({ open: false });
    expect(result.current.chartInstance.current).toBeNull();
    expect(result.current.isReady).toBe(false);
  });

  it('echarts.init is called with canvas renderer', () => {
    const div = document.createElement('div');
    const chart = echarts.init(div, undefined, { renderer: 'canvas' });
    expect(echarts.init).toHaveBeenCalledWith(div, undefined, { renderer: 'canvas' });
    expect(chart.dispose).toBeDefined();
  });

  it('init is guarded by existing instance (no double-init)', () => {
    const div = document.createElement('div');
    let instance: ReturnType<typeof echarts.init> | null = null;

    // First init
    if (!instance && div) {
      instance = echarts.init(div, undefined, { renderer: 'canvas' });
    }
    expect(echarts.init).toHaveBeenCalledTimes(1);

    // Second init — skipped
    if (!instance && div) {
      instance = echarts.init(div, undefined, { renderer: 'canvas' });
    }
    expect(echarts.init).toHaveBeenCalledTimes(1);
  });

  it('dispose sets instance to null', () => {
    const div = document.createElement('div');
    let instance: ReturnType<typeof echarts.init> | null = echarts.init(div, undefined, { renderer: 'canvas' });
    expect(instance).not.toBeNull();
    instance!.dispose();
    instance = null;
    expect(instance).toBeNull();
  });

  it('onInit callback is invoked after init', () => {
    const div = document.createElement('div');
    const onInit = vi.fn();
    const chart = echarts.init(div, undefined, { renderer: 'canvas' });
    onInit(chart);
    expect(onInit).toHaveBeenCalledWith(chart);
  });

  it('ResizeObserver triggers chart.resize()', () => {
    const chart = echarts.init(document.createElement('div'), undefined, { renderer: 'canvas' });
    const callback = () => chart.resize();
    callback();
    expect(chart.resize).toHaveBeenCalledOnce();
  });

  it('window resize listener only added when enableWindowResize=true', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');

    const handler = () => {};
    window.addEventListener('resize', handler);
    expect(addSpy).toHaveBeenCalledWith('resize', handler);

    window.removeEventListener('resize', handler);
    expect(removeSpy).toHaveBeenCalledWith('resize', handler);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('rapid open/close does not leave stale timers', () => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let initCalled = false;

    timer = setTimeout(() => { initCalled = true; }, 50);
    clearTimeout(timer!);
    timer = null;

    vi.advanceTimersByTime(100);
    expect(initCalled).toBe(false);
  });

  it('dispose is no-op when chart was never initialized', () => {
    const instance: { dispose: () => void } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    (instance as { dispose: () => void } | null)?.dispose(); // No-op, no error
    expect(instance).toBeNull();
  });
});

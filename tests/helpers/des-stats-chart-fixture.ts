// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Shared fakes for the DESStatsChart tests (fake echarts instance, fake runner + viewer). */
import { vi } from 'vitest';
import { act } from '@testing-library/react';
import { Object3D, Scene } from 'three';

export class FakeChart {
  handlers = new Map<string, Array<(p: unknown) => void>>();
  calls: Array<{ opt: any; flags?: any }> = [];
  setOption = (opt: any, flags?: any) => { this.calls.push({ opt, flags }); };
  isDisposed = () => false;
  getOption = () => {
    let merged: Record<string, any[]> = {};
    for (const { opt, flags } of this.calls) {
      if (flags?.notMerge) merged = {};
      for (const key of ['xAxis', 'yAxis', 'series', 'legend']) {
        if (opt[key] === undefined) continue;
        const entries = Array.isArray(opt[key]) ? opt[key] : [opt[key]];
        const previous = flags?.replaceMerge?.includes(key) ? [] : (merged[key] ?? []);
        merged[key] = entries.map((entry: any, index: number) => ({ ...previous[index], ...entry }));
      }
    }
    return merged;
  };
  convertToPixel = (finder: { xAxisIndex?: number; yAxisIndex?: number }, value: number): number => {
    const option = this.getOption();
    const axis = finder.xAxisIndex !== undefined
      ? option.xAxis?.[finder.xAxisIndex]
      : option.yAxis?.[finder.yAxisIndex ?? 0];
    return axis?.type === 'category' ? 50 + value * 40 : 10 + value * 2;
  };
  on = (ev: string, cb: (p: unknown) => void) => {
    const l = this.handlers.get(ev) ?? []; l.push(cb); this.handlers.set(ev, l);
  };
  emit(ev: string, p: unknown) { for (const cb of this.handlers.get(ev) ?? []) cb(p); }
  dispose = () => {};
  resize = () => {};
}

export const chartMock = {
  charts: [] as FakeChart[],
  create() { const c = new FakeChart(); this.charts.push(c); return c; },
  last() { return this.charts[this.charts.length - 1]; },
  reset() { this.charts = []; },
};

export function makeRunner(names: string[], kindOf: (n: string) => string = () => 'conveyor') {
  const comps = names.map((n) => ({
    path: `Yard/${n}`,
    def: { kind: kindOf(n) },
    nextComponents: [] as unknown[],
    previousComponents: [] as unknown[],
    getStatistics: () => ({
      workingPercent: 40, setupPercent: 0, blockedPercent: 10, emptyPercent: 0, failurePercent: 0,
      outputPerHour: 12, totalProcessed: 3, currentState: 'Working',
    }),
  }));
  return { instances: () => comps.map((c) => ({ adapter: c })), liveInstances: comps.map((c) => ({ adapter: c })) };
}

export function makeViewer(runner: unknown): any {
  let selected: string[] = [];
  const listeners = new Set<() => void>();
  const fire = () => { for (const l of [...listeners]) l(); };
  return {
    simulationKernel: { mode: 'des', activeExecutor: runner },
    registry: { getNode: () => new Object3D() },
    highlighter: { highlight() {}, clear() {}, highlightSelection() {}, clearSelection() {} },
    selectionManager: {
      select: (p: string) => { selected = [p]; fire(); },
      clear: () => { selected = []; fire(); },
      subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
      get selectedPaths() { return selected; },
    },
    scene: new Scene(),
    on: () => () => {},
  };
}

/** Let the lazy echarts import + initDelay timer + ticks run. */
export async function flush(ms = 120): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

/** Poll until a chart instance exists and has received its first setOption (lazy echarts chunk). */
export async function chartReady(timeoutMs = 20000): Promise<FakeChart> {
  await vi.waitFor(() => {
    const c = chartMock.last();
    if (!c || c.calls.length === 0) throw new Error('chart never initialised');
  }, { timeout: timeoutMs, interval: 50 });
  return chartMock.last();
}

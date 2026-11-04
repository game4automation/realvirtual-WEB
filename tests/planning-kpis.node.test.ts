// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import type { SimDesControl } from '../src/core/material-flow/simulation-kernel';
import { StatsRegistry } from '../src/core/stats/rv-stats-registry';
import { closeStatsHub, openStatsHub, resetStatsHubStore, setStatsHubSection } from '../src/core/stats/stats-hub-store';
import { measuredHeapMb, measuredRate, registerPerformanceStats } from '../src/core/planning/rv-planning-kpis';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(off => off()); resetStatsHubStore(); vi.unstubAllGlobals(); });

function harness() {
  let wall = 0;
  const control = { subMode: 'fastforward', simTime: 10, lifecycleGeneration: 1,
    eventStats: () => ({ processed: count }) };
  let count = 100;
  let active: typeof control | null = control;
  const listeners = new Map<string, Set<() => void>>();
  const stats = new StatsRegistry({ loadSetting: () => undefined, saveSetting: () => {} });
  const register = vi.spyOn(stats, 'register');
  const viewer = {
    stats, currentModelRoot: {} as object | null, currentFps: 57, rendererKind: 'webgl',
    renderer: { info: { render: { calls: 12, drawCalls: 7 }, memory: { geometries: 23 } } } as object | undefined,
    simulationKernel: { desControl: () => active as unknown as SimDesControl | null },
    on: (event: string, cb: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => { listeners.get(event)!.delete(cb); };
    },
  };
  const off = registerPerformanceStats(viewer as unknown as RVViewer, () => wall);
  cleanups.push(off);
  const section = stats.list()[0];
  const rows = () => section.rows!();
  const values = () => Object.fromEntries(rows().map(row => [row.key, row.value]));
  return { viewer, stats, register, section, rows, values, control, off, listeners,
    emit: (event: string) => listeners.get(event)?.forEach(cb => cb()),
    advance: (ms = 1000) => { wall += ms; count += 25; control.simTime += 50; },
    removeDes: () => { active = null; },
  };
}

describe('measured performance statistics', () => {
  it('registers one marked section with public FPS and WebGL counts, then unregisters cleanly', () => {
    const h = harness();
    expect(h.register).toHaveBeenCalledTimes(1);
    // The "measured" marking is the section caption — visible without grouping and without a tab bar.
    expect(h.section).toMatchObject({
      id: 'system.performance', title: 'Performance', order: 80, owner: 'system',
      description: expect.stringMatching(/^Measured — not deterministic/),
    });
    expect(h.values()).toMatchObject({ fps: 57, 'draw-calls': 12, geometries: 23 });
    expect(h.rows().every(row => row.group === undefined)).toBe(true);
    h.off();
    expect(h.stats.list()).toEqual([]);
    expect([...h.listeners.values()].every(set => set.size === 0)).toBe(true);
  });

  it('measures events and FF sim seconds using the injected millisecond clock', () => {
    const h = harness();
    expect(h.values()).toMatchObject({ 'events-per-second': null, 'fastforward-rate': null });
    h.advance(2000);
    expect(h.values()).toMatchObject({ 'events-per-second': 12.5, 'fastforward-rate': 25 });
    h.control.subMode = 'animated';
    h.advance();
    expect(h.values()['fastforward-rate']).toBeNull();
    h.control.subMode = 'fastforward';
    h.advance();
    expect(h.values()['fastforward-rate']).toBeNull();
    h.advance();
    expect(h.values()['fastforward-rate']).toBe(50);
    h.control.lifecycleGeneration++;
    h.advance();
    expect(h.values()).toMatchObject({ 'events-per-second': null, 'fastforward-rate': null });
  });

  it('starts fresh on reopen, tab changes and model changes; availability follows the model', () => {
    const h = harness();
    openStatsHub('system.performance');
    h.values(); h.advance();
    expect(h.values()['events-per-second']).toBe(25);
    closeStatsHub(); openStatsHub(); h.advance();
    expect(h.values()['events-per-second']).toBeNull();
    h.advance();
    expect(h.values()['events-per-second']).toBe(25);
    setStatsHubSection('scripts'); setStatsHubSection('system.performance'); h.advance();
    expect(h.values()['events-per-second']).toBeNull();
    const notify = vi.fn();
    const off = h.stats.subscribe(notify);
    h.viewer.currentModelRoot = null; h.emit('model-cleared');
    expect(h.stats.available()).toEqual([]);
    h.viewer.currentModelRoot = {}; h.emit('model-loaded');
    expect(h.stats.available()).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(h.values()['events-per-second']).toBeNull();
    off();
  });

  it('omits DES rows without a control and tolerates an absent event counter', () => {
    const h = harness();
    h.control.eventStats = undefined as never;
    h.values(); h.advance();
    expect(h.values()['events-per-second']).toBeNull();
    h.removeDes();
    expect(h.rows().map(row => row.key)).toEqual(['fps', 'heap-mb', 'draw-calls', 'geometries']);
  });

  it('uses WebGPU per-frame drawCalls and reports unavailable renderer information as null', () => {
    const h = harness();
    h.viewer.rendererKind = 'webgpu';
    expect(h.values()).toMatchObject({ 'draw-calls': 7, geometries: 23 });
    h.viewer.renderer = undefined;
    expect(h.values()).toMatchObject({ 'draw-calls': null, geometries: null });
  });

  it('reports optional heap memory in MB, rounded to one decimal', () => {
    vi.stubGlobal('performance', {});
    expect(measuredHeapMb()).toBeNull();
    expect(harness().values()['heap-mb']).toBeNull();
    expect(measuredHeapMb({ memory: { usedJSHeapSize: 12.34 * 2 ** 20 } })).toBe(12.3);
  });

  it('rejects reset counters, invalid samples and non-positive wall deltas', () => {
    expect(measuredRate(1, 2, 1000)).toBeNull();
    expect(measuredRate(2, 1, 0)).toBeNull();
    expect(measuredRate(2, 1, -1)).toBeNull();
    expect(measuredRate(Infinity, 1, 1000)).toBeNull();
    expect(measuredRate(3, 1, 3000)).toBe(0.7);
  });
});

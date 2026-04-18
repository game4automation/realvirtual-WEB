// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  RESOURCE_COLORS,
  UNKNOWN_COLOR,
  MAX_SAMPLES,
  assignDashStyles,
  pickColor,
  pushCappedSample,
  sampleTank,
  TankFillHistoryPlugin,
  type Sample,
} from '../src/plugins/tank-fill-history-plugin';
import type { ProcessIndustryPlugin } from '../src/plugins/processindustry-plugin';
import type { RVTank } from '../src/core/engine/rv-tank';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

describe('tank-fill-history-plugin helpers', () => {
  describe('sampleTank', () => {
    it('returns percent fill from amount / capacity', () => {
      const s = sampleTank({ amount: 250, capacity: 1000 }, 42);
      expect(s.pct).toBe(25);
      expect(s.liters).toBe(250);
      expect(s.t).toBe(42);
    });

    it('returns 0% (not NaN) for zero-capacity tanks', () => {
      const s = sampleTank({ amount: 50, capacity: 0 });
      expect(s.pct).toBe(0);
      expect(Number.isNaN(s.pct)).toBe(false);
    });

    it('uses now() by default', () => {
      const before = Date.now();
      const s = sampleTank({ amount: 100, capacity: 1000 });
      const after = Date.now();
      expect(s.t).toBeGreaterThanOrEqual(before);
      expect(s.t).toBeLessThanOrEqual(after);
    });
  });

  describe('pushCappedSample (ring buffer)', () => {
    it('appends samples while under cap', () => {
      const buf: Sample[] = [];
      pushCappedSample(buf, { t: 1, pct: 10, liters: 100 });
      pushCappedSample(buf, { t: 2, pct: 20, liters: 200 });
      expect(buf).toHaveLength(2);
      expect(buf[1].pct).toBe(20);
    });

    it('caps length at MAX_SAMPLES and drops the oldest', () => {
      const buf: Sample[] = [];
      for (let i = 0; i < MAX_SAMPLES + 100; i++) {
        pushCappedSample(buf, { t: i, pct: i % 100, liters: i });
      }
      expect(buf).toHaveLength(MAX_SAMPLES);
      // Oldest retained sample is the one inserted at step 100.
      expect(buf[0].t).toBe(100);
      expect(buf[buf.length - 1].t).toBe(MAX_SAMPLES + 99);
    });
  });

  describe('pickColor', () => {
    it('maps each known fluid to its palette color', () => {
      for (const [name, color] of Object.entries(RESOURCE_COLORS)) {
        expect(pickColor(name)).toBe(color);
      }
    });

    it('falls back to UNKNOWN_COLOR for unknown / empty names', () => {
      expect(pickColor('Mercury')).toBe(UNKNOWN_COLOR);
      expect(pickColor('')).toBe(UNKNOWN_COLOR);
    });
  });

  describe('assignDashStyles', () => {
    it('assigns solid style to the first occurrence of each medium', () => {
      const dashes = assignDashStyles([
        { resourceName: 'Water' },
        { resourceName: 'Oil' },
        { resourceName: 'Milk' },
      ]);
      expect(dashes).toEqual(['solid', 'solid', 'solid']);
    });

    it('cycles solid → dashed for same-medium tanks (no dotted)', () => {
      const dashes = assignDashStyles([
        { resourceName: 'Water' },
        { resourceName: 'Water' },
      ]);
      expect(dashes).toEqual(['solid', 'dashed']);
    });

    it('wraps after 2 same-medium tanks', () => {
      const dashes = assignDashStyles([
        { resourceName: 'Water' },
        { resourceName: 'Water' },
        { resourceName: 'Water' },
        { resourceName: 'Water' },
      ]);
      expect(dashes).toEqual(['solid', 'dashed', 'solid', 'dashed']);
    });

    it('tracks dash counters per medium independently', () => {
      const dashes = assignDashStyles([
        { resourceName: 'Water' },
        { resourceName: 'Oil' },
        { resourceName: 'Water' },
        { resourceName: 'Oil' },
      ]);
      expect(dashes).toEqual(['solid', 'solid', 'dashed', 'dashed']);
    });
  });
});

describe('TankFillHistoryPlugin', () => {
  it('has the expected id and plugin order', () => {
    const plugin = new TankFillHistoryPlugin();
    expect(plugin.id).toBe('tank-fill-history');
    expect(plugin.order).toBe(160);
  });

  it('declares a single button-group UI slot', () => {
    const plugin = new TankFillHistoryPlugin();
    expect(plugin.slots).toHaveLength(1);
    expect(plugin.slots?.[0].slot).toBe('button-group');
  });

  it('getTanks() returns [] before onModelLoaded', () => {
    const plugin = new TankFillHistoryPlugin();
    expect(plugin.getTanks()).toEqual([]);
  });

  it('getTanks() passes through to the sibling ProcessIndustryPlugin', () => {
    const plugin = new TankFillHistoryPlugin();
    const fakeTanks = [{ id: 'tank-1' }, { id: 'tank-2' }, { id: 'tank-3' }] as unknown as RVTank[];
    const mockProcess = {
      id: 'processindustry',
      getTanks: () => fakeTanks,
    } as unknown as ProcessIndustryPlugin;

    const viewer = {
      getPlugin: <T>(id: string) =>
        (id === 'processindustry' ? mockProcess : undefined) as T | undefined,
    } as unknown as RVViewer;

    plugin.onModelLoaded({} as LoadResult, viewer);
    expect(plugin.getTanks()).toBe(fakeTanks);
    expect(plugin.getTanks()).toHaveLength(3);
  });

  it('onModelCleared releases the sibling reference', () => {
    const plugin = new TankFillHistoryPlugin();
    const mockProcess = {
      id: 'processindustry',
      getTanks: () => [{} as RVTank],
    } as unknown as ProcessIndustryPlugin;
    const viewer = {
      getPlugin: <T>() => mockProcess as unknown as T,
    } as unknown as RVViewer;

    plugin.onModelLoaded({} as LoadResult, viewer);
    expect(plugin.getTanks()).toHaveLength(1);
    plugin.onModelCleared();
    expect(plugin.getTanks()).toEqual([]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect } from 'vitest';
import { KpiDemoPlugin } from '../src/plugins/demo/kpi-demo-plugin';

describe('KpiDemoPlugin', () => {
  test('OEE data has 48 buckets (30min × 24h)', () => {
    const plugin = new KpiDemoPlugin();
    expect(plugin.oeeData).toHaveLength(48);
  });

  test('OEE categories sum to 100% per bucket', () => {
    const plugin = new KpiDemoPlugin();
    for (const bucket of plugin.oeeData) {
      const sum = bucket.production + bucket.waiting + bucket.blocked
                + bucket.loading + bucket.toolchange + bucket.downtime;
      expect(sum).toBeCloseTo(100, 1);
    }
  });

  test('OEE all category values are non-negative', () => {
    const plugin = new KpiDemoPlugin();
    for (const b of plugin.oeeData) {
      expect(b.production).toBeGreaterThanOrEqual(0);
      expect(b.waiting).toBeGreaterThanOrEqual(0);
      expect(b.blocked).toBeGreaterThanOrEqual(0);
      expect(b.loading).toBeGreaterThanOrEqual(0);
      expect(b.toolchange).toBeGreaterThanOrEqual(0);
      expect(b.downtime).toBeGreaterThanOrEqual(0);
    }
  });

  test('OEE time labels cover full 24h', () => {
    const plugin = new KpiDemoPlugin();
    expect(plugin.oeeData[0].time).toBe('00:00');
    expect(plugin.oeeData[47].time).toBe('23:30');
  });

  test('Parts data has 24 hourly values', () => {
    const plugin = new KpiDemoPlugin();
    expect(plugin.partsData).toHaveLength(24);
  });

  test('Parts values are all non-negative', () => {
    const plugin = new KpiDemoPlugin();
    plugin.partsData.forEach(b => expect(b.parts).toBeGreaterThanOrEqual(0));
  });

  test('Cycle time data has 100 values, all positive', () => {
    const plugin = new KpiDemoPlugin();
    expect(plugin.cycleTimeData).toHaveLength(100);
    plugin.cycleTimeData.forEach(v => expect(v).toBeGreaterThan(0));
  });

  test('Cycle times within plausible range (80s to 300s)', () => {
    const plugin = new KpiDemoPlugin();
    plugin.cycleTimeData.forEach(v => {
      expect(v).toBeGreaterThanOrEqual(80000);
      expect(v).toBeLessThanOrEqual(300000);
    });
  });

  test('Data is deterministic (seeded PRNG)', () => {
    const a = new KpiDemoPlugin();
    const b = new KpiDemoPlugin();
    expect(a.oeeData).toEqual(b.oeeData);
    expect(a.partsData).toEqual(b.partsData);
    expect(a.cycleTimeData).toEqual(b.cycleTimeData);
  });
});

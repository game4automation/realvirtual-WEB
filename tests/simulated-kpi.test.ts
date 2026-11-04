// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect, beforeEach } from 'vitest';
import {
  DEFAULT_HISTORY_HOURS,
  DEFAULT_HISTORY_INTERVALS,
  HISTORY_BLEND_SEC,
  MAX_HISTORY_POINTS,
  formatSimulatedKpi,
  simulatedKpiBand,
  simulatedKpiCalmValue,
  simulatedKpiHistory,
  simulatedKpiSeries,
  simulatedKpiValue,
  smoothNoise1D,
  type SimulatedKpiDef,
} from '../src/core/hmi/simulated-kpi';
import { SimulatedKpiPlugin, kpiBarRuleShowingModes } from '../src/plugins/simulated-kpi-plugin';
import { KPI_BAR_DEFAULT_RULE } from '../src/core/hmi/KpiBar';
import {
  _resetStore,
  activateContext,
  getActiveContexts,
  getUIElementRule,
  isUIElementVisible,
  registerUIElement,
} from '../src/core/hmi/ui-context-store';

const OUTPUT: SimulatedKpiDef = { label: 'Output', base: 45, amplitude: 2, period: 30, unit: 'pcs/h', seed: 2 };

describe('simulated KPI source', () => {
  test('stays inside base ± amplitude over a long run', () => {
    let min = Infinity, max = -Infinity;
    for (let t = 0; t < 36000; t += 3.7) {
      const v = simulatedKpiValue(OUTPUT, t);
      min = Math.min(min, v); max = Math.max(max, v);
    }
    expect(min).toBeGreaterThanOrEqual(43);
    expect(max).toBeLessThanOrEqual(47);
    // It really moves (not stuck at base).
    expect(max - min).toBeGreaterThan(1.5);
  });

  test('is deterministic: same definition and time give the same value', () => {
    expect(simulatedKpiValue(OUTPUT, 1234.5)).toBe(simulatedKpiValue({ ...OUTPUT }, 1234.5));
  });

  test('is smooth: one second moves far less than the full band', () => {
    let maxStep = 0;
    for (let t = 0; t < 3600; t += 1) {
      maxStep = Math.max(maxStep, Math.abs(simulatedKpiValue(OUTPUT, t + 1) - simulatedKpiValue(OUTPUT, t)));
    }
    // band is 4 pcs/h wide; smoothstep slope ≤ 1.5 × lattice delta (≤ 2 × amp) / period
    expect(maxStep).toBeLessThan(0.25);
  });

  test('different seeds do not move in lockstep', () => {
    const other = { ...OUTPUT, seed: 7 };
    let same = 0;
    for (let t = 0; t < 600; t += 10) if (simulatedKpiValue(OUTPUT, t) === simulatedKpiValue(other, t)) same++;
    expect(same).toBeLessThan(3);
  });

  test('amplitude 0 is a constant; noise is continuous at lattice points', () => {
    expect(simulatedKpiValue({ label: 'OEE', base: 95, unit: '%' }, 999)).toBe(95);
    expect(smoothNoise1D(5 - 1e-9, 3)).toBeCloseTo(smoothNoise1D(5, 3), 6);
  });

  test('series ends at the current value and formatting honours decimals', () => {
    const s = simulatedKpiSeries(OUTPUT, 500, 15, 7.5);
    expect(s).toHaveLength(15);
    expect(s[14]).toBe(simulatedKpiValue(OUTPUT, 500));
    expect(formatSimulatedKpi({ ...OUTPUT, decimals: 2 }, 8.4999)).toBe('8.50');
    expect(formatSimulatedKpi(OUTPUT, 44.6)).toBe('45');
  });
});

describe('simulated KPI history (trend window)', () => {
  const NOW = 1_761_730_000; // a fixed wall-clock second

  test('is deterministic and ends at the chip value at "now"', () => {
    const a = simulatedKpiHistory(OUTPUT, NOW);
    const b = simulatedKpiHistory({ ...OUTPUT }, NOW);
    expect(a).toEqual(b);
    expect(a.t[a.t.length - 1]).toBe(NOW);
    expect(a.v[a.v.length - 1]).toBe(simulatedKpiValue(OUTPUT, NOW));
    // Before the blend window every sample is the calm shift curve of the same seed.
    expect(a.v[50]).toBe(simulatedKpiCalmValue(OUTPUT, a.t[50]));
  });

  test('covers historyHours on an absolute 5-min grid, refined in the blend window, ends at "now"', () => {
    const h = simulatedKpiHistory(OUTPUT, NOW);
    const span = DEFAULT_HISTORY_HOURS * 3600;
    expect(h.step).toBe(span / DEFAULT_HISTORY_INTERVALS);
    expect(h.t[0]).toBeGreaterThanOrEqual(NOW - span);
    expect(h.t[0] - (NOW - span)).toBeLessThan(h.step);
    const blend = NOW - HISTORY_BLEND_SEC;
    const coarse = h.t.filter((t) => t < blend);
    const fine = h.t.filter((t) => t >= blend && t < NOW);
    expect(coarse.length).toBeGreaterThanOrEqual(DEFAULT_HISTORY_INTERVALS - HISTORY_BLEND_SEC / h.step - 1);
    for (let k = 1; k < coarse.length; k++) expect(coarse[k] - coarse[k - 1]).toBeCloseTo(h.step, 6);
    for (const t of coarse) expect(Math.abs(t / h.step - Math.round(t / h.step))).toBeLessThan(1e-6);
    // Fine grid inside the ramp window: 30 s.
    for (let k = 1; k < fine.length; k++) expect(fine[k] - fine[k - 1]).toBeCloseTo(30, 6);
    expect(h.t[h.t.length - 1]).toBe(NOW);

    // Following "now" does not resample the coarse grid.
    const later = simulatedKpiHistory(OUTPUT, NOW + 1);
    const i = later.t.indexOf(h.t[50]);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(later.v[i]).toBe(h.v[50]);
    expect(later.v[later.v.length - 1]).toBe(simulatedKpiValue(OUTPUT, NOW + 1));

    // historyHours and the interval count are honoured; the count is capped.
    expect(simulatedKpiHistory({ ...OUTPUT, historyHours: 1 }, NOW, 12).step).toBe(300);
    expect(simulatedKpiHistory(OUTPUT, NOW, 1e6).step).toBe(span / MAX_HISTORY_POINTS);
  });

  test('is a calm shift curve: small steps between neighbours, touches the band edge rarely', () => {
    for (const seed of [1, 2, 3, 4, 17]) {
      const def = { ...OUTPUT, seed };
      const tol = 2;
      const h = simulatedKpiHistory(def, NOW);
      const coarse = h.v.filter((_, k) => h.t[k] < NOW - HISTORY_BLEND_SEC);
      let maxStep = 0, min = Infinity, max = -Infinity;
      for (let k = 0; k < coarse.length; k++) {
        if (k > 0) maxStep = Math.max(maxStep, Math.abs(coarse[k] - coarse[k - 1]));
        min = Math.min(min, coarse[k]); max = Math.max(max, coarse[k]);
      }
      expect(maxStep).toBeLessThanOrEqual(tol * 0.3);
      expect(max - 45).toBeLessThanOrEqual(tol * 0.7 + 1e-9);
      expect(45 - min).toBeLessThanOrEqual(tol * 0.7 + 1e-9);
      expect(max - min).toBeGreaterThan(tol * 0.3); // it does wander
    }
  });

  test('glides into the chip value: the ramp has no jump', () => {
    for (const seed of [1, 2, 3, 4, 17]) {
      const def = { ...OUTPUT, seed };
      const h = simulatedKpiHistory(def, NOW);
      const tol = 2;
      // ramp window: 30 s samples, at most ~1.7 tol over 15 min with smoothstep -> small steps
      for (let k = h.t.length - 1; k > 0 && h.t[k - 1] >= NOW - HISTORY_BLEND_SEC; k--) {
        expect(Math.abs(h.v[k] - h.v[k - 1])).toBeLessThanOrEqual(tol * 0.3);
      }
      expect(h.v[h.v.length - 1]).toBe(simulatedKpiValue(def, NOW));
    }
  });

  test('historySmoothing 0 shows the raw source', () => {
    const h = simulatedKpiHistory({ ...OUTPUT, historySmoothing: 0 }, NOW);
    for (let k = 0; k < h.t.length; k += 7) expect(h.v[k]).toBe(simulatedKpiValue(OUTPUT, h.t[k]));
  });

  test('stays inside the tolerance band (default = amplitude); tolerance is configurable', () => {
    const band = simulatedKpiBand(OUTPUT);
    expect(band).toEqual({ target: 45, low: 43, high: 47 });
    const h = simulatedKpiHistory(OUTPUT, NOW);
    for (const v of h.v) {
      expect(v).toBeGreaterThanOrEqual(band.low);
      expect(v).toBeLessThanOrEqual(band.high);
    }
    expect(simulatedKpiBand({ ...OUTPUT, tolerance: 3 })).toEqual({ target: 45, low: 42, high: 48 });
    expect(simulatedKpiBand({ label: 'x', base: 1, unit: '' })).toEqual({ target: 1, low: 1, high: 1 });
  });
});

describe('SimulatedKpiPlugin', () => {
  beforeEach(() => _resetStore());

  test('one kpi-bar slot per KPI, in order, plus one overlay slot for the trend window', () => {
    const p = new SimulatedKpiPlugin({ kpis: [OUTPUT, { ...OUTPUT, label: 'OEE' }] });
    expect(p.slots.map((s) => s.slot)).toEqual(['kpi-bar', 'kpi-bar', 'overlay']);
    expect(p.slots[0].order).toBeLessThan(p.slots[1].order!);
  });

  test('showInModes lifts only those modes and dispose restores the previous rule', () => {
    registerUIElement('kpi-bar', KPI_BAR_DEFAULT_RULE);
    activateContext('mode:commissioning');
    expect(isUIElementVisible('kpi-bar', getActiveContexts())).toBe(false);

    const p = new SimulatedKpiPlugin({ kpis: [OUTPUT], showInModes: ['commissioning'] });
    p.init();
    expect(isUIElementVisible('kpi-bar', getActiveContexts())).toBe(true);
    expect(getUIElementRule('kpi-bar')!.hiddenIn).toContain('mode:editor');

    p.dispose();
    expect(getUIElementRule('kpi-bar')).toBe(KPI_BAR_DEFAULT_RULE);
    expect(isUIElementVisible('kpi-bar', getActiveContexts())).toBe(false);
  });

  test('without showInModes the rule is left alone', () => {
    const p = new SimulatedKpiPlugin({ kpis: [OUTPUT] });
    p.init();
    expect(getUIElementRule('kpi-bar')).toBeUndefined();
    expect(kpiBarRuleShowingModes({ hiddenIn: ['mode:viewer'] }, ['commissioning']).hiddenIn).toEqual(['mode:viewer']);
  });
});

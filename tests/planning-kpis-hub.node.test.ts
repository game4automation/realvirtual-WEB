// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { createPlanningRegistry } from '../src/core/planning/rv-planning-registry';
import { StatsRegistry } from '../src/core/stats/rv-stats-registry';
import { planningKpiSectionTitle, registerPlanningKpiSections } from '../src/plugins/planning-parameters/planning-kpis-hub';

describe('planning key-figure tab title', () => {
  it('drops the "Planning · " prefix of the planning window title', () => {
    expect(planningKpiSectionTitle('Planning · PalletYard')).toBe('PalletYard');
    expect(planningKpiSectionTitle('Planning Yard')).toBe('Planning Yard');
    expect(planningKpiSectionTitle('Planning · ')).toBe('Planning · ');
  });
});

function harness() {
  const registry = createPlanningRegistry();
  const stats = new StatsRegistry({ loadSetting: () => undefined, saveSetting: () => {} });
  const dispose = registerPlanningKpiSections(registry, stats);
  return { registry, stats, dispose };
}

describe('planning key figures in the Statistics hub', () => {
  it('groups by owner, marks measured rows, rounds only declared decimals and reads fresh values', () => {
    const { registry, stats, dispose } = harness();
    let value = 12.345;
    const handle = registry.declare({ owner: 'yard', title: 'Planning Yard', params: [], kpis: [
      { key: 'rate', label: 'Rate', unit: 'Pal/h', kind: 'sim', decimals: 1, read: () => value },
      { key: 'peak', label: 'Peak', kind: 'sim', read: () => value },
      { key: 'fps', label: 'FPS', kind: 'measured', decimals: 0, read: () => 58.7 },
    ] });
    registry.declare({ owner: 'empty', title: 'No figures', params: [] });
    expect(stats.list()).toHaveLength(1);
    const section = stats.list()[0];
    expect(section).toMatchObject({ id: 'planning.kpis:yard', title: 'Planning Yard', order: 30,
      description: 'Some values are measured — not deterministic.' });
    expect(section.isAvailable!()).toBe(true);
    expect(section.rows!()).toEqual([
      { key: 'yard.rate', label: 'Rate', value: 12.3, unit: 'Pal/h' },
      { key: 'yard.peak', label: 'Peak', value: 12.345, unit: undefined },
      { key: 'yard.fps', label: 'FPS (measured)', value: 59, unit: undefined },
    ]);
    value = 25.678;
    expect(section.rows!()[0].value).toBe(25.7);
    handle.dispose();
    expect(stats.list()).toEqual([]);
    expect(section.isAvailable!()).toBe(false);
    dispose();
  });

  it('reconciles replacements, independent owners, resets and disposal without duplicates', () => {
    const { registry, stats, dispose } = harness();
    const kpis = [{ key: 'count', label: 'Count', kind: 'sim' as const, read: () => null }];
    const old = registry.declare({ owner: 'one', title: 'First', params: [], kpis });
    registry.declare({ owner: 'one', title: 'Replacement', params: [], kpis });
    old.dispose();
    expect(stats.list()).toHaveLength(1);
    expect(stats.list()[0].title).toBe('Replacement');
    expect(stats.list()[0].description).toBeUndefined();
    expect(stats.list()[0].rows!()[0].value).toBeNull();
    registry.declare({ owner: 'one', title: 'Replacement', params: [], kpis: [
      { key: 'fps', label: 'FPS', kind: 'measured', read: () => 60 },
    ] });
    expect(stats.list()).toHaveLength(1);
    expect(stats.list()[0].description).toBe('Some values are measured — not deterministic.');
    registry.declare({ owner: 'two', title: 'Second', params: [], kpis });
    registry.notifySimulationReset();
    expect(stats.list().map(s => s.id)).toEqual(['planning.kpis:one', 'planning.kpis:two']);
    registry.declare({ owner: 'one', title: 'Without KPIs', params: [] });
    expect(stats.list().map(s => s.id)).toEqual(['planning.kpis:two']);
    dispose();
    dispose();
    expect(stats.list()).toEqual([]);
    registry.declare({ owner: 'later', title: 'After disposal', params: [], kpis });
    expect(stats.list()).toEqual([]);
  });

  it('discovers owners declared before the bridge starts', () => {
    const registry = createPlanningRegistry();
    registry.declare({ owner: 'existing', title: 'Existing', params: [], kpis: [
      { key: 'count', label: 'Count', kind: 'sim', read: () => 3 },
    ] });
    const stats = new StatsRegistry({ loadSetting: () => undefined, saveSetting: () => {} });
    const dispose = registerPlanningKpiSections(registry, stats);
    expect(stats.available().map(s => s.id)).toEqual(['planning.kpis:existing']);
    dispose();
    expect(stats.available()).toEqual([]);
  });
});

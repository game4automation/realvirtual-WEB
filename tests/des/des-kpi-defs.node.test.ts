// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import {
  componentSuggestions, defaultLabel, evaluateKpiDef, normalizeKpiDefs, parseKpiTrack, rowDisplayLabel, seriesSourceOptions, suggestKind,
  trackKeyOf, trackKpis, trackedSourcesOf, uniqueDefId, type KpiDef,
} from '../../src/plugins/sim-controller/des-kpi-defs';
import { KpiTracker } from '../../src/plugins/des/des-kpi-track';

const P = 'PalletYard/PalletYardRoot';
const kpis: Record<string, number> = {
  throughput: 100, utilization: 50,
  [`component:${P}/Stapler_1/failure`]: 4, [`component:${P}/Stapler_2/failure`]: 6, [`component:${P}/Stapler_3/failure`]: 8,
  [`component:${P}/Stapler_1/stopped`]: 1,
  [`component:${P}/Sink_V1/outputPerHour`]: 30, [`component:${P}/Sink_V2/outputPerHour`]: 20,
  [`component:${P}/Conveyor_A/failure`]: 99,
  'row:scripts/["Cell/Script","Late orders"]': 3,
};
const def = (source: KpiDef['source'], extra: Partial<KpiDef> = {}): KpiDef => ({ id: 'def:x', label: 'X', source, ...extra });

describe('des-kpi-defs', () => {
  it('matches a name glob on the last path segment and aggregates', () => {
    expect(evaluateKpiDef(def({ match: 'Stapler_*', metric: 'failure', aggregate: 'mean' }), kpis)).toBe(6);
    expect(evaluateKpiDef(def({ match: 'Stapler_*', metric: 'failure', aggregate: 'sum' }), kpis)).toBe(18);
    expect(evaluateKpiDef(def({ match: 'Stapler_*', metric: 'failure', aggregate: 'min' }), kpis)).toBe(4);
    expect(evaluateKpiDef(def({ match: 'Stapler_*', metric: 'failure', aggregate: 'max' }), kpis)).toBe(8);
    expect(evaluateKpiDef(def({ match: 'Sink_*', metric: 'outputPerHour', aggregate: 'sum' }), kpis)).toBe(50);
  });
  it('matches a full path exactly and a bare name; nothing matching is undefined', () => {
    expect(evaluateKpiDef(def({ match: `${P}/Stapler_2`, metric: 'failure', aggregate: 'mean' }), kpis)).toBe(6);
    expect(evaluateKpiDef(def({ match: 'Stapler_3', metric: 'failure', aggregate: 'mean' }), kpis)).toBe(8);
    expect(evaluateKpiDef(def({ match: 'Robot_*', metric: 'failure', aggregate: 'mean' }), kpis)).toBeUndefined();
    expect(evaluateKpiDef(def({ match: 'Stapler_*', metric: 'slowed', aggregate: 'mean' }), kpis)).toBeUndefined();
  });
  it('warm-up 1 h, run 3 h: a counter counts only the last 2 h, per hour divides by 2 h', () => {
    const tracker = new KpiTracker(3600);
    let count = 0;
    tracker.add('prop:#sink|Sink|TotalProcessed', () => count, 0);
    // Events every 30 min add 5 parts; the advance edge runs BEFORE the events of its time.
    for (const t of [0, 1800, 3600, 5400, 7200, 9000]) { tracker.advance(t); count += 5; }
    const track = parseKpiTrack(JSON.parse(JSON.stringify(tracker.finish(10800))))!;
    expect(track.values['prop:#sink|Sink|TotalProcessed']).toMatchObject({ warm: 10, end: 30 });
    const map = trackKpis(track);
    expect(map['track:hours']).toBe(2);
    const counter = (perHour: boolean): KpiDef => def({ property: { address: '#sink', component: 'Sink', field: 'TotalProcessed' }, kind: 'counter', ...(perHour ? { perHour } : {}) });
    expect(evaluateKpiDef(counter(false), map)).toBe(20);
    expect(evaluateKpiDef(counter(true), map)).toBe(10);
  });
  it('a state KPI is the time-weighted mean / max / end over the measured window only', () => {
    const tracker = new KpiTracker(3600);
    let level = 100; // high during the warm-up, must not count
    tracker.add('row:scripts/["Cell/Script","Buffer"]', () => level, 0);
    // The advance edge reads the state held since the previous edge, then that time's events run.
    tracker.advance(0);
    tracker.advance(3600); level = 2; // [0,3600) held 100 -> warm-up, outside the window
    tracker.advance(5400); level = 6; // [3600,5400) held 2
    const v = tracker.finish(7200)!.values['row:scripts/["Cell/Script","Buffer"]']; // [5400,7200) held 6
    expect(v).toMatchObject({ warm: 100, end: 6, mean: 4, max: 6 });
    const map = trackKpis(tracker.finish(7200));
    const state = (stat?: 'max' | 'end'): KpiDef => def({ series: 'row:scripts/["Cell/Script","Buffer"]', kind: 'state', ...(stat ? { stat } : {}) });
    expect(evaluateKpiDef(state(), map)).toBe(4);
    expect(evaluateKpiDef(state('max'), map)).toBe(6);
    expect(evaluateKpiDef(state('end'), map)).toBe(6);
  });
  it('a property KPI without recorded points (run older than the KPI) has no value', () => {
    expect(evaluateKpiDef(def({ property: { match: 'Sink_*', component: 'Sink', field: 'TotalProcessed' }, kind: 'counter' }), kpis)).toBeUndefined();
    expect(trackKeyOf({ property: { match: 'Sink_*', component: 'Sink', field: 'TotalProcessed' }, kind: 'counter' })).toBe('prop:*Sink_*|Sink|TotalProcessed');
    expect(suggestKind('TotalProcessed')).toBe('counter');
    expect(suggestKind('Level')).toBe('state');
  });
  it('suggests patterns for shared stems, then single components; live names without runs', () => {
    const s = componentSuggestions(Object.keys(kpis));
    expect(s.patterns).toEqual([{ match: 'Sink_V*', count: 2 }, { match: 'Stapler_*', count: 3 }]);
    expect(s.components.map(c => c.name)).toEqual(['Conveyor_A', 'Sink_V1', 'Sink_V2', 'Stapler_1', 'Stapler_2', 'Stapler_3']);
    expect(componentSuggestions([], ['Robot1', 'Robot2', 'Robot2', 'Press']).patterns).toEqual([{ match: 'Robot*', count: 2 }]);
  });
  it('normalizes untrusted defs: drops invalid entries and duplicates, caps at 32', () => {
    const good = { id: 'def:a', label: ' A ', better: 'lower', unit: '%', source: { match: 'Stapler_*', metric: 'failure', aggregate: 'bogus' } };
    const out = normalizeKpiDefs([good, { ...good }, { id: 'nope', label: 'B', source: { match: 'x', metric: 'failure' } },
      { id: 'def:c', label: 'C', source: { match: 'x', metric: 'nonsense' } }, { id: 'def:d', label: 'D', source: { series: 'row:scripts/x', kind: 'counter', perHour: true } },
      { id: 'def:e', label: 'E', source: { property: { address: '#n', component: 'Buffer', field: 'Level' }, kind: 'state', stat: 'max' } },
      { id: 'def:f', label: 'F', source: { property: { component: 'Buffer', field: 'Level' } } }, null]);
    expect(out).toEqual([
      { id: 'def:a', label: 'A', unit: '%', better: 'lower', source: { match: 'Stapler_*', metric: 'failure', aggregate: 'mean' } },
      { id: 'def:d', label: 'D', source: { series: 'row:scripts/x', kind: 'counter', perHour: true } },
      { id: 'def:e', label: 'E', source: { property: { address: '#n', component: 'Buffer', field: 'Level' }, kind: 'state', stat: 'max' } },
    ]);
    expect(trackedSourcesOf(out)).toEqual(['row:scripts/x', 'prop:#n|Buffer|Level']);
    expect(normalizeKpiDefs(Array.from({ length: 40 }, (_, i) => ({ ...good, id: `def:k${i}` })))).toHaveLength(32);
    expect(normalizeKpiDefs('x')).toEqual([]);
  });
  it('labels: defaults, script rows, unique ids', () => {
    expect(defaultLabel({ source: { match: 'Stapler_*', metric: 'failure', aggregate: 'mean' } })).toBe('Stapler breakdown share');
    expect(defaultLabel({ source: { match: 'Sink_*', metric: 'outputPerHour', aggregate: 'sum' } })).toBe('Sum Sink output');
    expect(defaultLabel({ source: { match: `${P}/Stapler_2`, metric: 'stopped', aggregate: 'mean' } })).toBe('Stapler_2 traffic stop share');
    expect(rowDisplayLabel('row:scripts/["Cell/Line/Script","Late orders"]')).toBe('Late orders · Script');
    expect(rowDisplayLabel('row:palletyard/orders', 'Orders')).toBe('Orders');
    expect(uniqueDefId('AGV breakdown', ['def:agv-breakdown'])).toBe('def:agv-breakdown-2');
    expect(seriesSourceOptions([
      { id: 'row:system.performance/fps', label: 'FPS' }, { id: 'row:palletyard/late', label: 'Late', unit: 'pcs' },
      { id: 'row:scripts/["A/S","Late orders"]', label: 'Late orders', unit: 'pcs' },
    ]).map(o => [o.group, o.label])).toEqual([['Model values', 'Late'], ['Script values', 'Late orders · S']]);
  });
});

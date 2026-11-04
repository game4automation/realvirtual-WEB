// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-630 Phase 3 — the `PlanningScenarios` block, pure: reading (drops are named, never
 * repaired), naming rules, writing only deviations, and what a save collects.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCENARIO_NAME, RV_PLANNING_SCENARIOS_KEY, checkScenarioName, collectScenarioValues,
  emptyScenarioBlock, isEmptyScenarioBlock, parsePlanningScenarios, planningScenariosPayload,
  sameScenarioValues, withActiveScenario, withScenario,
} from '../../src/core/planning/rv-planning-scenario';
import { createPlanningRegistry } from '../../src/core/planning/rv-planning-registry';
import type { PlanningParamDef } from '../../src/core/planning/rv-planning-params';

const rv = (block: unknown) => ({ [RV_PLANNING_SCENARIOS_KEY]: block });

describe('parsePlanningScenarios', () => {
  it('absent block → null without issues (every Unity export)', () => {
    expect(parsePlanningScenarios({})).toEqual({ block: null, issues: [] });
    expect(parsePlanningScenarios(undefined)).toEqual({ block: null, issues: [] });
  });

  it('reads a valid block unchanged', () => {
    const block = { version: 1, active: 'High load', scenarios: { Basis: {}, 'High load': { 'palletYard.production.A1.ratePerHour': 60, 'script.on': true } } };
    const r = parsePlanningScenarios(rv(block));
    expect(r.issues).toEqual([]);
    expect(r.block).toEqual(block);
  });

  it('another version is not read at all', () => {
    const r = parsePlanningScenarios(rv({ version: 2, active: 'Basis', scenarios: { Basis: { 'a.b': 1 } } }));
    expect(r.block).toBeNull();
    expect(r.issues.map((i) => i.code)).toEqual(['version-unsupported']);
  });

  it('drops malformed keys, non-scalar values and bad names — each one named', () => {
    const r = parsePlanningScenarios(rv({
      version: 1, active: 'Basis',
      scenarios: {
        Basis: { 'noDot': 1, 'o.k': { nested: true }, 'o.n': Number.NaN, 'o.ok': 5 },
        '   ': { 'o.x': 1 },
        __proto__x: 3,
      },
    }));
    expect(r.block!.scenarios).toEqual({ Basis: { 'o.ok': 5 } });
    expect(r.issues.map((i) => i.code).sort()).toEqual(
      ['key-invalid', 'scenario-invalid', 'scenario-name-invalid', 'value-invalid', 'value-invalid'].sort());
  });

  it('an active name that is not stored falls back to the first scenario, reported', () => {
    const r = parsePlanningScenarios(rv({ version: 1, active: 'Gone', scenarios: { A: { 'o.x': 1 } } }));
    expect(r.block!.active).toBe('A');
    expect(r.issues.map((i) => i.code)).toEqual(['active-missing']);
  });

  it('a block that is not an object is ignored, reported', () => {
    expect(parsePlanningScenarios(rv('x')).issues.map((i) => i.code)).toEqual(['block-invalid']);
    expect(parsePlanningScenarios(rv({ version: 1, scenarios: [] })).issues.map((i) => i.code)).toEqual(['block-invalid']);
  });
});

describe('scenario names', () => {
  it('trims and accepts ordinary names; refuses empty, too long, control characters, __proto__', () => {
    expect(checkScenarioName('  High load ')).toEqual({ ok: true, name: 'High load' });
    expect(checkScenarioName('').ok).toBe(false);
    expect(checkScenarioName('x'.repeat(65)).ok).toBe(false);
    expect(checkScenarioName('a\nb').ok).toBe(false);
    expect(checkScenarioName('__proto__').ok).toBe(false);
    expect(checkScenarioName('constructor')).toEqual({ ok: true, name: 'constructor' });
  });

  it('"constructor" is an ordinary scenario, not a prototype member', () => {
    const block = emptyScenarioBlock();
    expect(withActiveScenario(block, 'constructor')).toBe(block);
    const r = parsePlanningScenarios(rv({ version: 1, active: 'constructor', scenarios: { Basis: {} } }));
    expect(r.block!.active).toBe('Basis');
  });
});

describe('block building', () => {
  it('the empty default block is "empty" and writes nothing', () => {
    expect(isEmptyScenarioBlock(emptyScenarioBlock())).toBe(true);
    expect(isEmptyScenarioBlock(withScenario(emptyScenarioBlock(), DEFAULT_SCENARIO_NAME, { 'o.a': 1 }))).toBe(false);
    expect(isEmptyScenarioBlock(withScenario(emptyScenarioBlock(), 'B', {}))).toBe(false);
  });

  it('withScenario keeps other scenarios, sorts keys, activates; payload is stable', () => {
    const a = withScenario(emptyScenarioBlock(), 'Hoch', { 'z.b': 2, 'a.c': true, bad: 1 });
    expect(a.active).toBe('Hoch');
    expect(Object.keys(a.scenarios)).toEqual([DEFAULT_SCENARIO_NAME, 'Hoch']);
    expect(Object.keys(a.scenarios.Hoch)).toEqual(['a.c', 'z.b']);
    expect(JSON.stringify(planningScenariosPayload(a)))
      .toBe('{"version":1,"active":"Hoch","scenarios":{"Basis":{},"Hoch":{"a.c":true,"z.b":2}}}');
    expect(withScenario(a, 'x', {}, false).active).toBe('Hoch');
  });

  it('sameScenarioValues is order-free', () => {
    expect(sameScenarioValues({ 'a.b': 1, 'c.d': true }, { 'c.d': true, 'a.b': 1 })).toBe(true);
    expect(sameScenarioValues({ 'a.b': 1 }, { 'a.b': 2 })).toBe(false);
    expect(sameScenarioValues({ 'a.b': 1 }, {})).toBe(false);
  });
});

describe('collectScenarioValues — what a save writes', () => {
  const params: PlanningParamDef[] = [
    { key: 'rate', label: 'R', type: 'number', min: 0, max: 120, default: 40, group: 'g', apply: 'live' },
    { key: 'size', label: 'S', type: 'integer', min: 1, max: 16, default: 2, group: 'g', apply: 'reset' },
    { key: 'trace', label: 'T', type: 'boolean', default: false, group: 'Anzeige', apply: 'live', role: 'display' },
  ];

  it('only factor deviations — pending values included, display never, defaults never', () => {
    const registry = createPlanningRegistry({ problems: { report: () => {}, clear: () => {} } });
    registry.declare({ owner: 'yard', title: 'Y', params });
    registry.setMany({ 'yard.rate': 70, 'yard.size': 4, 'yard.trace': true }, 'ui');
    expect(collectScenarioValues(registry)).toEqual({ 'yard.rate': 70, 'yard.size': 4 });
    registry.setMany({ 'yard.rate': 40 }, 'ui');
    expect(collectScenarioValues(registry)).toEqual({ 'yard.size': 4 });
  });

  it('keeps undeclared values (another model, or instance keys of a pending rebuild); drops rejected values', () => {
    const registry = createPlanningRegistry({ problems: { report: () => {}, clear: () => {} } });
    registry.loadScenario({ 'script.speed': 3, 'yard.station.A3.active': false, 'yard.rate': 90, 'yard.size': 99 });
    registry.declare({ owner: 'yard', title: 'Y', params });
    expect(collectScenarioValues(registry)).toEqual({ 'script.speed': 3, 'yard.rate': 90, 'yard.station.A3.active': false });
  });
});

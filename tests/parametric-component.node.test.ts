// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-650 Phase 1 (§9.1) — ParametricComponent parse / validate / normalize.
 * Pure logic, no scene: the RM 8110 schema from the plan is the fixture.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeValues,
  parseParametricComponent,
  type ParamDef,
} from '../src/core/engine/rv-parametric-component';
import { getCapabilities } from '../src/core/engine/rv-component-registry';

/** RM 8110 parameter schema (plan-650 §3.1). */
const RM8110_PARAMS = [
  { Name: 'BF', Label: 'Nennbreite', Type: 'enum', Unit: 'mm', Enum: [420, 620, 840], Default: 420 },
  { Name: 'ML', Label: 'Modullaenge', Type: 'number', Unit: 'mm', Min: 0, Max: 4320, Step: 10, Default: 2160 },
  { Name: 'P', Label: 'Rollenteilung', Type: 'enum', Unit: 'mm', Enum: [60, 90, 120, 150], Default: 90 },
  { Name: 'HSG', Label: 'Hoehe SF', Type: 'number', Unit: 'mm', Min: 35, Max: 80, Default: 68 },
];

function rm8110(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ApiVersion: 1,
    Params: RM8110_PARAMS,
    Values: { BF: 420, ML: 2160, P: 90, HSG: 68 },
    Code: 'function generate(values, parts){ return { instances: [] }; }',
    CodeHash: 'abc123',
    ...extra,
  };
}

function defs(): ParamDef[] {
  const r = parseParametricComponent(rm8110());
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.value.Params;
}

function errorsOf(params: unknown[]): string[] {
  const r = parseParametricComponent(rm8110({ Params: params }));
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors;
}

describe('parseParametricComponent', () => {
  it('accepts the RM 8110 schema', () => {
    const r = parseParametricComponent(rm8110());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.ApiVersion).toBe(1);
    expect(r.value.Params.map((p) => p.Name)).toEqual(['BF', 'ML', 'P', 'HSG']);
    expect(r.value.Params[0]).toEqual(RM8110_PARAMS[0]);
    expect(r.value.Params[1]).toEqual(RM8110_PARAMS[1]);
    expect(r.value.Values).toEqual({ BF: 420, ML: 2160, P: 90, HSG: 68 });
    expect(r.value.CodeHash).toBe('abc123');
  });

  it('fills PartsRoot / GeneratedRoot defaults and ignores unknown fields', () => {
    const r = parseParametricComponent(rm8110({ SomethingNew: 42 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.PartsRoot).toBe('_Parts');
    expect(r.value.GeneratedRoot).toBe('_Generated');
    expect('SomethingNew' in r.value).toBe(false);
    expect(r.value.BakedInputHash).toBeUndefined();
    expect(r.value.DesignResource).toBeUndefined();
  });

  it('keeps explicit roots and optional hashes', () => {
    const r = parseParametricComponent(rm8110({
      PartsRoot: 'Base', GeneratedRoot: 'Out', BakedInputHash: 'h1', DesignResource: 'd1',
    }));
    expect(r.ok && r.value.PartsRoot).toBe('Base');
    expect(r.ok && r.value.GeneratedRoot).toBe('Out');
    expect(r.ok && r.value.BakedInputHash).toBe('h1');
    expect(r.ok && r.value.DesignResource).toBe('d1');
  });

  it('defaults a minimal record (fixed family without parameters)', () => {
    const r = parseParametricComponent({});
    expect(r).toEqual({
      ok: true,
      value: {
        ApiVersion: 1, Params: [], Values: {}, Code: '', CodeHash: '',
        PartsRoot: '_Parts', GeneratedRoot: '_Generated',
      },
    });
  });

  it('rejects a non-object and an unsupported ApiVersion', () => {
    expect(parseParametricComponent(null).ok).toBe(false);
    expect(parseParametricComponent([]).ok).toBe(false);
    const r = parseParametricComponent(rm8110({ ApiVersion: 2 }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join()).toMatch(/ApiVersion/);
  });

  it('rejects duplicate parameter names', () => {
    const errs = errorsOf([...RM8110_PARAMS, { Name: 'ML', Type: 'number', Default: 1 }]);
    expect(errs.join()).toMatch(/"ML".*duplicate/);
  });

  it('rejects Min > Max', () => {
    const errs = errorsOf([{ Name: 'L', Type: 'number', Min: 100, Max: 50, Default: 70 }]);
    expect(errs.join()).toMatch(/"L".*Min \(100\) is greater than Max \(50\)/);
  });

  it('rejects a Default outside Min/Max, off the Step grid or not in Enum', () => {
    expect(errorsOf([{ Name: 'L', Type: 'number', Min: 0, Max: 10, Default: 11 }]).join()).toMatch(/"L".*outside/);
    expect(errorsOf([{ Name: 'L', Type: 'number', Min: 0, Max: 100, Step: 10, Default: 15 }]).join()).toMatch(/"L".*Step grid/);
    expect(errorsOf([{ Name: 'N', Type: 'int', Default: 2.5 }]).join()).toMatch(/"N".*not an integer/);
    expect(errorsOf([{ Name: 'BF', Type: 'enum', Enum: [420, 620], Default: 500 }]).join()).toMatch(/"BF".*not one of Enum/);
  });

  it('rejects an empty Enum, Enum on a non-enum type and Step <= 0', () => {
    expect(errorsOf([{ Name: 'BF', Type: 'enum', Enum: [], Default: 420 }]).join()).toMatch(/"BF".*non-empty/);
    expect(errorsOf([{ Name: 'L', Type: 'number', Enum: [1], Default: 1 }]).join()).toMatch(/"L".*Enum is only allowed/);
    expect(errorsOf([{ Name: 'L', Type: 'number', Step: 0, Default: 1 }]).join()).toMatch(/"L".*Step must be > 0/);
  });

  it('rejects unknown types and bad bool defaults', () => {
    expect(errorsOf([{ Name: 'X', Type: 'vector', Default: 1 }]).join()).toMatch(/"X".*Type must be one of/);
    expect(errorsOf([{ Name: 'On', Type: 'bool', Default: 'yes' }]).join()).toMatch(/"On".*true or false/);
  });

  it('rejects signal-bound parameters (F14)', () => {
    const signal = /cannot be bound to signals/;
    expect(errorsOf([{ Name: 'Speed', Type: 'signal', Default: 0 }]).join()).toMatch(signal);
    expect(errorsOf([{ Name: 'Speed', Type: 'PLCOutputFloat', Default: 0 }]).join()).toMatch(signal);
    expect(errorsOf([{ Name: 'Speed', Type: 'number', Default: 0, Signal: 'PLC/Speed' }]).join()).toMatch(signal);
    expect(errorsOf([{ Name: 'Speed', Type: 'number', Default: 0, SignalBinding: { path: 'PLC/Speed' } }]).join())
      .toMatch(signal);
    expect(errorsOf([{
      Name: 'Speed', Type: 'number',
      Default: { type: 'ComponentReference', path: 'PLC/Speed', componentType: 'PLCOutputFloat' },
    }]).join()).toMatch(signal);
  });

  it('reports every problem, not just the first', () => {
    const errs = errorsOf([
      { Name: 'A', Type: 'number', Min: 5, Max: 1, Default: 3 },
      { Name: 'B', Type: 'enum', Enum: [], Default: 1 },
    ]);
    expect(errs.some((e) => e.includes('"A"'))).toBe(true);
    expect(errs.some((e) => e.includes('"B"'))).toBe(true);
  });
});

describe('normalizeValues', () => {
  it('rejects an enum value outside Enum, naming the parameter', () => {
    expect(() => normalizeValues(defs(), { BF: 500 })).toThrow(/BF/);
  });

  it('rounds to Step and fills defaults', () => {
    expect(normalizeValues(defs(), { ML: 2161.4 })).toEqual({ BF: 420, ML: 2160, P: 90, HSG: 68 });
  });

  it('clamps at Min / Max', () => {
    expect(normalizeValues(defs(), { ML: 9000, HSG: 10 })).toMatchObject({ ML: 4320, HSG: 35 });
    expect(normalizeValues(defs(), { ML: -5, HSG: 99 })).toMatchObject({ ML: 0, HSG: 80 });
  });

  it('keeps the grid inside the bounds when Max is off-grid', () => {
    const d: ParamDef[] = [{ Name: 'L', Type: 'number', Min: 0, Max: 25, Step: 10, Default: 0 }];
    expect(normalizeValues(d, { L: 24 })).toEqual({ L: 20 });
  });

  it('snaps relative to Min and avoids floating-point noise', () => {
    const d: ParamDef[] = [{ Name: 'X', Type: 'number', Min: 0.05, Max: 1, Step: 0.1, Default: 0.05 }];
    expect(normalizeValues(d, { X: 0.36 })).toEqual({ X: 0.35 });
    const e: ParamDef[] = [{ Name: 'Y', Type: 'number', Step: 0.1, Default: 0 }];
    expect(normalizeValues(e, { Y: 0.3 })).toEqual({ Y: 0.3 });
  });

  it('rounds int values', () => {
    const d: ParamDef[] = [{ Name: 'N', Type: 'int', Min: 1, Max: 10, Default: 1 }];
    expect(normalizeValues(d, { N: 3.6 })).toEqual({ N: 4 });
    expect(normalizeValues(d, { N: '7' })).toEqual({ N: 7 });
  });

  it('accepts bool from true / false only', () => {
    const d: ParamDef[] = [{ Name: 'On', Type: 'bool', Default: false }];
    expect(normalizeValues(d, {})).toEqual({ On: false });
    expect(normalizeValues(d, { On: true })).toEqual({ On: true });
    expect(normalizeValues(d, { On: 'false' })).toEqual({ On: false });
    expect(() => normalizeValues(d, { On: 1 })).toThrow(/On/);
  });

  it('maps a numeric string onto a number enum entry', () => {
    expect(normalizeValues(defs(), { BF: '620' })).toMatchObject({ BF: 620 });
  });

  it('rejects a non-numeric value for a number parameter', () => {
    expect(() => normalizeValues(defs(), { ML: 'long' })).toThrow(/ML/);
  });

  it('orders keys by definition and ignores unknown keys', () => {
    const out = normalizeValues(defs(), { HSG: 50, Unknown: 1, P: 120, ML: 1000, BF: 840 });
    expect(Object.keys(out)).toEqual(['BF', 'ML', 'P', 'HSG']);
    expect(out).toEqual({ BF: 840, ML: 1000, P: 120, HSG: 50 });
    expect(JSON.stringify(out)).toBe(JSON.stringify(normalizeValues(defs(), { BF: 840, ML: 1000, P: 120, HSG: 50 })));
  });
});

describe('ParametricComponent capabilities', () => {
  it('claims its node and is provisionally not authorable (plan-650 Phase 4)', () => {
    const caps = getCapabilities('ParametricComponent');
    expect(caps.authorable).toBe(false);
    expect(caps.claimsNode).toBe(true);
  });
});

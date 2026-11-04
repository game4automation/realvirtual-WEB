// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-630 test 9.1 — declaration model: defensive parse, coercion, value validation.
 */
import { describe, expect, it } from 'vitest';
import {
  checkPlanningValue,
  coercePlanningValue,
  parsePlanningDeclaration,
  validatePlanningValue,
} from '../../src/core/planning/rv-planning-params';
import type { PlanningParamDef } from '../../src/core/planning/rv-planning-params';

describe('parsePlanningDeclaration', () => {
  it('rejects duplicate keys and out-of-range defaults without throwing', () => {
    const r = parsePlanningDeclaration({ owner: 'o', title: 't', params: [
      { key: 'a', label: 'A', type: 'number', min: 0, max: 10, default: 20, group: 'g', apply: 'live' },
      { key: 'a', label: 'A2', type: 'boolean', default: true, group: 'g', apply: 'reset' },
    ] });
    expect(r.errors.map((e) => e.code)).toEqual(['default-out-of-range', 'duplicate-key']);
    expect(r.declaration?.params).toEqual([]);
  });

  it('keeps valid parameters next to invalid ones', () => {
    const r = parsePlanningDeclaration({ owner: 'o', title: 't', params: [
      { key: 'ok', label: 'Ok', type: 'integer', min: 0, max: 5, default: 2, group: 'g', apply: 'reset' },
      { key: 'e', label: 'E', type: 'enum', default: 'x', group: 'g', apply: 'reset' },
      { key: 'bad key', label: 'B', type: 'number', default: 1, group: 'g', apply: 'live' },
      { key: 't', label: 'T', type: 'text', default: 'x', group: 'g', apply: 'live' },
      { key: 'ap', label: 'Ap', type: 'number', default: 1, group: 'g', apply: 'sometimes' },
      { key: 'r', label: 'R', type: 'number', min: 5, max: 1, default: 3, group: 'g', apply: 'live' },
      { key: 'i', label: 'I', type: 'integer', default: 1.5, group: 'g', apply: 'live' },
      { key: 's', label: 'S', type: 'number', default: '40', group: 'g', apply: 'live' },
    ] });
    expect(r.declaration?.params.map((p) => p.key)).toEqual(['ok']);
    expect(r.errors.map((e) => e.code)).toEqual([
      'enum-without-options', 'invalid-key', 'invalid-type', 'invalid-apply', 'invalid-range',
      'default-invalid', 'default-invalid',
    ]);
  });

  it('returns no declaration for an unusable owner and never throws on garbage', () => {
    expect(parsePlanningDeclaration(null).declaration).toBeNull();
    expect(parsePlanningDeclaration({ owner: 'a.b', params: [] }).errors[0].code).toBe('invalid-owner');
    expect(parsePlanningDeclaration({ owner: 'o', params: 'x' }).errors[0].code).toBe('invalid-declaration');
    expect(parsePlanningDeclaration({ owner: 'o', params: [42] }).errors[0].code).toBe('invalid-param');
  });

  it('falls back to the owner as title', () => {
    expect(parsePlanningDeclaration({ owner: 'o', params: [] }).declaration?.title).toBe('o');
  });
});

describe('coercion and validation', () => {
  it('coerces "90" to 90 and "true" to true', () => {
    expect(coercePlanningValue({ type: 'integer' } as PlanningParamDef, '90')).toBe(90);
    expect(coercePlanningValue({ type: 'boolean' } as PlanningParamDef, 'true')).toBe(true);
  });

  it('refuses inputs that are not of the type', () => {
    expect(coercePlanningValue({ type: 'number' }, 'abc')).toBeUndefined();
    expect(coercePlanningValue({ type: 'number' }, '')).toBeUndefined();
    expect(coercePlanningValue({ type: 'number' }, Number.NaN)).toBeUndefined();
    expect(coercePlanningValue({ type: 'boolean' }, 'yes')).toBeUndefined();
    expect(coercePlanningValue({ type: 'boolean' }, 0)).toBe(false);
    expect(coercePlanningValue({ type: 'enum' }, 3)).toBeUndefined();
  });

  it('checks range, integrality and option membership', () => {
    const rate: PlanningParamDef = { key: 'r', label: 'R', type: 'integer', min: 0, max: 120, default: 40, group: 'g', apply: 'live' };
    expect(validatePlanningValue(rate, 121)?.code).toBe('out-of-range');
    expect(validatePlanningValue(rate, 1.5)?.code).toBe('not-integer');
    expect(validatePlanningValue(rate, 60)).toBeNull();
    const strat: PlanningParamDef = {
      key: 's', label: 'S', type: 'enum', default: 'a', group: 'g', apply: 'reset',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    };
    expect(validatePlanningValue(strat, 'c')?.code).toBe('unknown-option');
    expect(checkPlanningValue(strat, 'b')).toEqual({ ok: true, value: 'b' });
    expect(checkPlanningValue(rate, '200').ok).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-504 §9.4 — the limits form's parser and validation, pure.
 *
 * The Mechanism section's limits form (private) and the `mechanism.setLimits`
 * rule speak one text: a field that does not parse says so, `lower >= upper`
 * answers {@link LIMITS_ORDER} — the same string `enabled()` returns to an
 * agent. Fields are text with `inputMode="decimal"`, so a decimal COMMA must
 * parse like a point, and a switched-off limit is valid whatever the fields say.
 */

import { describe, expect, it } from 'vitest';
import {
  LIMITS_NUMBER,
  LIMITS_ORDER,
  parseDecimalInput,
  validateLimitsInput,
} from '../src/core/hmi/mechanism-command-descriptors';

describe('parseDecimalInput', () => {
  it('accepts a decimal point and a decimal comma alike', () => {
    expect(parseDecimalInput('12.5')).toBe(12.5);
    expect(parseDecimalInput('12,5')).toBe(12.5);
    expect(parseDecimalInput('-90')).toBe(-90);
    expect(parseDecimalInput(' -0,25 ')).toBe(-0.25);
    expect(parseDecimalInput(45)).toBe(45);
  });

  it('refuses what is not ONE finite number', () => {
    expect(parseDecimalInput('')).toBeNull();
    expect(parseDecimalInput('abc')).toBeNull();
    expect(parseDecimalInput('1.000,5')).toBeNull(); // thousands separators are not guessed
    expect(parseDecimalInput('1,2,3')).toBeNull();
    expect(parseDecimalInput(null)).toBeNull();
    expect(parseDecimalInput(Number.NaN)).toBeNull();
    expect(parseDecimalInput('Infinity')).toBeNull();
  });

  it('rounds away float noise (1e-6)', () => {
    expect(parseDecimalInput('0,1')! + parseDecimalInput('0,2')!).toBeCloseTo(0.3, 9);
    expect(parseDecimalInput('1.23456789')).toBe(1.234568);
    expect(parseDecimalInput(0.1 + 0.2)).toBe(0.3);
  });
});

describe('validateLimitsInput', () => {
  it('lower < upper is valid and returns the parsed bounds', () => {
    expect(validateLimitsInput({ useLimits: true, lower: '-90', upper: '90,5' }))
      .toEqual({ ok: true, useLimits: true, lower: -90, upper: 90.5 });
  });

  it('lower >= upper is LIMITS_ORDER — equal bounds included', () => {
    expect(validateLimitsInput({ useLimits: true, lower: '10', upper: '5' }))
      .toEqual({ ok: false, reason: LIMITS_ORDER, field: 'order' });
    expect(validateLimitsInput({ useLimits: true, lower: '5', upper: '5,0' }))
      .toEqual({ ok: false, reason: LIMITS_ORDER, field: 'order' });
  });

  it('an unparseable field names the field', () => {
    expect(validateLimitsInput({ useLimits: true, lower: 'x', upper: '5' }))
      .toEqual({ ok: false, reason: LIMITS_NUMBER, field: 'lower' });
    expect(validateLimitsInput({ useLimits: true, lower: '1', upper: '' }))
      .toEqual({ ok: false, reason: LIMITS_NUMBER, field: 'upper' });
  });

  it('useLimits=false ignores the bounds entirely', () => {
    expect(validateLimitsInput({ useLimits: false, lower: '10', upper: '5' })).toEqual({ ok: true, useLimits: false });
    expect(validateLimitsInput({ useLimits: false, lower: 'garbage', upper: '' })).toEqual({ ok: true, useLimits: false });
  });
});

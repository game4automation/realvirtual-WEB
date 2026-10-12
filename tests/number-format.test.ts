// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-510 §9.1 — the one decimal parser/formatter of the HMI
 * (`rv-number-format.ts`): comma and dot, no thousands separators, lossless
 * round trip of `String(value)` drafts, noise-free read-only display.
 */

import { describe, it, expect } from 'vitest';
import {
  parseDecimal,
  isCompleteDecimal,
  isInvalidDecimalDraft,
  formatDecimal,
  formatUnit,
} from '../src/core/hmi/rv-number-format';

describe('parseDecimal', () => {
  it('accepts dot and comma', () => {
    expect(parseDecimal('0.5')).toBe(0.5);
    expect(parseDecimal('0,5')).toBe(0.5);
    expect(parseDecimal('-9,81')).toBe(-9.81);
    expect(parseDecimal('.5')).toBe(0.5);
    expect(parseDecimal('-3')).toBe(-3);
    expect(parseDecimal(' 9,81 ')).toBe(9.81);
  });

  it('accepts exponent notation (drafts seeded from tiny/huge values)', () => {
    expect(parseDecimal('1e-7')).toBe(1e-7);
    expect(parseDecimal('1,5e3')).toBe(1500);
    expect(parseDecimal('1e+21')).toBe(1e21);
  });

  it('round-trips String(value) losslessly (editor drafts)', () => {
    for (const v of [0, -0.5, 1e-7, 123456789.123, 0.000001, 9.81, 1.23456789012345, 1e21, -1e-12, 5e-324]) {
      expect(parseDecimal(String(v))).toBe(v);
    }
  });

  it('rejects ambiguous or invalid input', () => {
    expect(parseDecimal('1.000,5')).toBeNull();
    expect(parseDecimal('1,000.5')).toBeNull();
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('-')).toBeNull();
    expect(parseDecimal('1e')).toBeNull();
    expect(parseDecimal('Infinity')).toBeNull();
    expect(parseDecimal('0x10')).toBeNull();
  });

  it('treats a trailing separator as incomplete (but parseable)', () => {
    expect(isCompleteDecimal('1,')).toBe(false);
    expect(isCompleteDecimal('1.')).toBe(false);
    expect(parseDecimal('1,')).toBe(1);
    expect(isCompleteDecimal('1,5')).toBe(true);
    expect(isCompleteDecimal('-')).toBe(false);
    expect(isCompleteDecimal('')).toBe(false);
    expect(isCompleteDecimal('1e-7')).toBe(true);
  });

  it('flags only drafts that can never become a number', () => {
    for (const partial of ['', '-', ',', '-.', '1e', '1e-', '1,', '9,8']) {
      expect(isInvalidDecimalDraft(partial)).toBe(false);
    }
    for (const bad of ['1.000,5', '1,000.5', 'abc', '--1', '1..2']) {
      expect(isInvalidDecimalDraft(bad)).toBe(true);
    }
  });
});

describe('formatDecimal', () => {
  it('formats with dot and without float noise', () => {
    expect(formatDecimal(0.1 + 0.2)).toBe('0.3');
    expect(formatDecimal(34.2345, 2)).toBe('34.23');
    expect(formatDecimal(-9.81)).toBe('-9.81');
  });

  it('keeps integers exact and normalises -0', () => {
    expect(formatDecimal(123456789012345)).toBe('123456789012345');
    expect(formatDecimal(-0)).toBe('0');
  });

  it('non-finite values pass through', () => {
    expect(formatDecimal(Number.NaN)).toBe('NaN');
  });
});

describe('formatUnit', () => {
  it('writes exponents as superscripts', () => {
    expect(formatUnit('m/s2')).toBe('m/s²');
    expect(formatUnit('m2')).toBe('m²');
    expect(formatUnit('m3')).toBe('m³');
    expect(formatUnit('kg.m2')).toBe('kg.m²');
  });

  it('leaves other units alone', () => {
    expect(formatUnit('mm')).toBe('mm');
    expect(formatUnit('m/s')).toBe('m/s');
    expect(formatUnit('K')).toBe('K');
    expect(formatUnit(undefined)).toBeUndefined();
  });
});

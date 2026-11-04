// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 — the SignalConnector conversion kernel against the canonical
 * vectors (`tests/fixtures/signal-conversion-vectors.json`). The same file
 * drives the Unity and CONNECT copies of the kernel, so every case here is a
 * cross-runtime promise: signed-32 storage, Bit 31, Byte signed/unsigned,
 * clamp, rounding ±x.5, NaN/±∞ and float32 targets (`Math.fround`).
 */

import { describe, expect, it } from 'vitest';
import vectors from './fixtures/signal-conversion-vectors.json';
import {
  DEFAULT_CONVERSION_OPTIONS,
  connectSignalConvert,
  convertValue,
  interpretWord,
  selectSlots,
  wordFromBits,
  type ConnectorSlot,
  type ConversionOptions,
  type SignalConnectorMode,
  type ValueKind,
  type WordWidth,
} from '../src/core/engine/rv-signal-conversion';

type Raw = boolean | number | string;

function input(v: Raw): boolean | number {
  if (v === 'NaN') return Number.NaN;
  if (v === 'Infinity') return Number.POSITIVE_INFINITY;
  if (v === '-Infinity') return Number.NEGATIVE_INFINITY;
  return v as boolean | number;
}

/** Distance in float32 ULPs (both values are float32-representable). */
function ulpDistance(a: number, b: number): number {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat32(0, a);
  buf.setFloat32(4, b);
  const ia = buf.getInt32(0);
  const ib = buf.getInt32(4);
  const ka = ia < 0 ? 0x80000000 - ia : ia;
  const kb = ib < 0 ? 0x80000000 - ib : ib;
  return Math.abs(ka - kb);
}

function expectSame(actual: boolean | number | undefined, expected: boolean | number | null, target: ValueKind): void {
  if (expected === null) {
    expect(actual).toBeUndefined();
    return;
  }
  if (target === 'real' && typeof expected === 'number') {
    expect(typeof actual).toBe('number');
    // The result itself must be a float32 value — the ULP check below converts
    // its inputs and would otherwise let a raw double (16777217) pass.
    expect(actual).toBe(Math.fround(actual as number));
    expect(ulpDistance(actual as number, expected)).toBeLessThanOrEqual(1);
    return;
  }
  expect(actual).toBe(expected);
  // -0 is not a signed-32 value; it must never leak into an INT target.
  if (target === 'int') expect(Object.is(actual, -0)).toBe(false);
}

describe('signal conversion kernel — canonical vectors', () => {
  it('covers every mode and the mandatory edge cases', () => {
    const modes = new Set(vectors.convert.map((c) => c.mode));
    for (const m of ['Copy', 'IntToBool', 'BoolToInt', 'BitFromWord', 'BitToWord', 'Scale']) expect(modes.has(m)).toBe(true);
    const inputs = vectors.convert.map((c) => c.input);
    for (const v of [-2147483648, -1, 1e39, -1e39, 2147483647.5, -2147483648.5, 16777217, 'NaN']) {
      expect(inputs).toContain(v);
    }
  });

  for (const c of vectors.convert) {
    it(`convert: ${c.name}`, () => {
      const options: ConversionOptions = {
        ...DEFAULT_CONVERSION_OPTIONS,
        ...((c as { options?: Partial<ConversionOptions> }).options ?? {}),
        Mode: c.mode as SignalConnectorMode,
      };
      const out = convertValue(input(c.input as Raw), c.source as ValueKind, c.target as ValueKind, options);
      expectSame(out, c.expect as boolean | number | null, c.target as ValueKind);
    });
  }

  for (const w of vectors.word) {
    it(`word: ${w.name}`, () => {
      expect(wordFromBits(w.bits, w.width as WordWidth, w.signed)).toBe(w.expect);
    });
  }

  for (const c of vectors.connectSignal) {
    it(`ConnectSignal legacy: ${c.name}`, () => {
      expect(connectSignalConvert(input(c.input as Raw), c.source as ValueKind, c.target as ValueKind)).toBe(c.expect);
    });
  }
});

describe('signal conversion kernel — helpers', () => {
  it('interprets Byte/Word/DWord signed and unsigned', () => {
    expect(interpretWord(0xff, 'Byte', true)).toBe(-1);
    expect(interpretWord(0xff, 'Byte', false)).toBe(255);
    expect(interpretWord(-1, 'Word', false)).toBe(65535);
    expect(interpretWord(0x8000, 'Word', true)).toBe(-32768);
    expect(interpretWord(-2147483648, 'DWord', true)).toBe(-2147483648);
    expect(interpretWord(-1, 'DWord', false)).toBe(4294967295);
  });

  it('selects the active slot pair per mode and reports set inactive slots', () => {
    const set = (...slots: ConnectorSlot[]) => (s: ConnectorSlot) => slots.includes(s);
    expect(selectSlots('IntToBool', set('SourceInt', 'TargetBool'))).toEqual({ source: 'SourceInt', target: 'TargetBool', inactiveSet: [] });
    expect(selectSlots('Copy', set('SourceInt', 'TargetFloat'))).toEqual({ source: 'SourceInt', target: 'TargetFloat', inactiveSet: [] });
    expect(selectSlots('Scale', set('SourceFloat', 'TargetInt'))).toEqual({ source: 'SourceFloat', target: 'TargetInt', inactiveSet: [] });
    const leftover = selectSlots('BitToWord', set('SourceBool', 'TargetInt', 'TargetBool'));
    expect(leftover).toEqual({ source: 'SourceBool', target: 'TargetInt', inactiveSet: ['TargetBool'] });
    // Nothing set: the mode's first pair is the (empty) active pair.
    expect(selectSlots('BoolToInt', set())).toEqual({ source: 'SourceBool', target: 'TargetInt', inactiveSet: [] });
    // Half filled: the missing side is the mode's partner slot.
    expect(selectSlots('BitFromWord', set('SourceInt'))).toEqual({ source: 'SourceInt', target: 'TargetBool', inactiveSet: [] });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { seedKey64, scriptSeed32 } from '../../src/core/rv-rng-streams';
import fixture from './fixtures/rng-v2/seedkey-vectors.json';

describe('seedKey64 version contract', () => {
  it('derives nonzero uint32 script seeds with stable golden values', () => {
    expect(scriptSeed32(41, '#ScriptStation@Script')).toBe(3928043435);
    expect(scriptSeed32(42, 'other')).toBe(1520397029);
    for (let seed = 0; seed < 100; seed++) {
      const value = scriptSeed32(seed, 'script');
      expect(value).toBe(scriptSeed32(seed, 'script'));
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).not.toBe(scriptSeed32(seed + 1, 'script'));
      expect(value).not.toBe(scriptSeed32(seed, 'other'));
    }
  });
  for (const [i, v] of fixture.vectors.entries()) it(`Python golden tuple ${i}`, () => {
    expect(seedKey64(v.masterSeed, v.id, v.purpose)).toBe(BigInt(v.expected));
  });
  it('normalizes NFC and frames each field independently', () => {
    expect(seedKey64(42, 'Linie/Ä', 'default')).toBe(seedKey64(42, 'Linie/A\u0308', 'default'));
    expect(seedKey64(7, 'ab', 'c')).not.toBe(seedKey64(7, 'a', 'bc'));
  });
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite seed %s', seed => {
    expect(() => seedKey64(seed, '', '')).toThrow();
  });
  it('has no collisions in 10,000 IDs x four purposes (sample, not proof)', () => {
    const keys = new Set<bigint>();
    for (let i = 0; i < 10_000; i++) {
      for (const purpose of ['default', 'downtime:mtbf', 'downtime:mttr', 'takt']) {
        keys.add(seedKey64(42, `Line/Station${i}`, purpose));
      }
    }
    expect(keys.size).toBe(40_000);
  });
});

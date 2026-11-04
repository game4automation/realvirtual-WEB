// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * parametric-hash.node.test.ts — plan-650 phase 2: canonical JSON + the one
 * InputHash / PartsHash contract (§2.3).
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalJSON,
  sha256Hex,
  computePartsHash,
  computeInputHash,
  type PartHashEntry,
} from '../src/core/engine/rv-parametric-hash';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function parts(): PartHashEntry[] {
  return [
    { name: 'Profile', localMatrix: IDENTITY, geometryHash: 'g-profile', materialKey: 'silver' },
    { name: 'Roller', localMatrix: IDENTITY, geometryHash: 'g-roller', materialKey: 'black' },
  ];
}

async function inputHash(p: PartHashEntry[], values: Record<string, number | boolean | string>): Promise<string> {
  return computeInputHash({ ApiVersion: 1, CodeHash: 'c0de', Values: values, PartsHash: await computePartsHash(p) });
}

describe('canonicalJSON (RFC 8785 subset)', () => {
  it('sorts keys by code units and ignores insertion order', () => {
    expect(canonicalJSON({ b: 1, a: [true, null, 'x'], A: 2 })).toBe('{"A":2,"a":[true,null,"x"],"b":1}');
    expect(canonicalJSON({ y: { b: 1, a: 2 }, x: 0 })).toBe(canonicalJSON({ x: 0, y: { a: 2, b: 1 } }));
  });
  it('formats numbers like ECMAScript and folds -0', () => {
    expect(canonicalJSON([1e21, 0.1, -0, 2160])).toBe('[1e+21,0.1,0,2160]');
  });
  it('rejects values JSON cannot represent exactly', () => {
    expect(() => canonicalJSON({ a: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJSON({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJSON({ a: () => 1 })).toThrow(/unsupported/);
  });
});

describe('sha256Hex', () => {
  it('matches the known digest of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('InputHash / PartsHash', () => {
  const values = { BF: 420, ML: 2160, P: 90, HSG: 68 };

  it('equal inputs give equal hashes, independent of key and part order', async () => {
    const a = await inputHash(parts(), values);
    const b = await inputHash([...parts()].reverse(), { HSG: 68, P: 90, ML: 2160, BF: 420 });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('different values give a different hash', async () => {
    expect(await inputHash(parts(), { ...values, ML: 2170 })).not.toBe(await inputHash(parts(), values));
  });

  it('renaming, moving or recolouring a base part changes the hash', async () => {
    const base = await inputHash(parts(), values);
    const renamed = parts(); renamed[1].name = 'Roller420';
    const moved = parts(); moved[1].localMatrix = [...IDENTITY.slice(0, 12), 5, 0, 0, 1];
    const recoloured = parts(); recoloured[1].materialKey = 'yellow';
    const reshaped = parts(); reshaped[1].geometryHash = 'g-roller-2';
    for (const p of [renamed, moved, recoloured, reshaped]) {
      const h = await inputHash(p, values);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(h).not.toBe(base);
    }
  });

  it('rejects duplicate part names and malformed matrices', async () => {
    const dup = parts(); dup[1].name = 'Profile';
    expect(() => computePartsHash(dup)).toThrow(/duplicate/);
    const bad = parts(); bad[0].localMatrix = [1, 0];
    expect(() => computePartsHash(bad)).toThrow(/16 numbers/);
  });
});

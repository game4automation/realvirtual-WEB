// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-2013 test 9.2 (model half) — the Variants block, the target op set, the diff rows. */

import { describe, expect, it } from 'vitest';
import {
  diffRows, emptyVariantsBlock, freezeVariant, parseVariantsBlock, serializeVariantsBlock, targetOps, MAX_VARIANT_DESCRIPTION,
  type Variant, type VariantsBlock,
} from '../../src/core/variants/rv-variant-model';

const A = { address: '#src', component: 'Source', field: 'Interval' };
const B = { address: '#m3', component: 'Module', field: 'Rate' };

const v = (id: string, overrides: Variant['overrides'], revision = 1): Variant => ({ id, name: id, revision, overrides });

describe('parse / serialize', () => {
  it('round-trips; an empty block serialises to null (block removed)', () => {
    const b: VariantsBlock = { version: 1, active: 'x', variants: [v('x', [{ ...A, value: 4 }])] };
    const raw = serializeVariantsBlock(b)!;
    expect(parseVariantsBlock({ Variants: raw })).toEqual({ block: b, issues: [] });
    expect(serializeVariantsBlock(emptyVariantsBlock())).toBeNull();
  });

  it('a version > 1 is not read', () => {
    const r = parseVariantsBlock({ Variants: { version: 2, variants: [] } });
    expect(r.block).toBeNull();
    expect(r.issues[0].code).toBe('variants-version');
  });

  it('duplicate ids, names and fields are dropped and reported; an unknown active falls back to Base', () => {
    const r = parseVariantsBlock({
      version: 1, active: 'gone',
      variants: [
        { id: 'a', name: 'Fast', revision: 2, overrides: [{ ...A, value: 4 }, { ...A, value: 5 }, { ...B, value: null }] },
        { id: 'a', name: 'Other', overrides: [] },
        { id: 'b', name: 'Fast', overrides: [] },
      ],
    });
    expect(r.block!.variants).toEqual([{ ...v('a', [{ ...A, value: 4 }], 2), name: 'Fast' }]);
    expect(r.block!.active).toBeNull();
    expect(r.issues.map((i) => i.code).sort()).toEqual(['variant-duplicate', 'variant-duplicate', 'variant-duplicate', 'variant-override-invalid']);
  });

  it('freezeVariant is a deep frozen copy', () => {
    const src = v('a', [{ ...A, value: 4 }]);
    const f = freezeVariant(src);
    expect(f).toEqual(src);
    expect(Object.isFrozen(f) && Object.isFrozen(f.overrides) && Object.isFrozen(f.overrides[0])).toBe(true);
    expect(f.overrides).not.toBe(src.overrides);
  });
});

describe('target op set X → Y (§2.5)', () => {
  it('Y values plus base restores for X \\ Y; an absent base is an unset; no cache entry = no restore', () => {
    const X = v('x', [{ ...A, value: 4 }, { ...B, value: 9 }, { address: '#new', component: 'Module', field: 'Rate', value: 2 }]);
    const Y = v('y', [{ ...B, value: 5 }]);
    const base = new Map([['#src|Source|Interval', { kind: 'absent' as const }]]);
    expect(targetOps(X, Y, (k) => base.get(k))).toEqual([
      { ...B, op: 'set', value: 5 },
      { ...A, op: 'unset' },
    ]);
    const base2 = new Map([['#src|Source|Interval', { kind: 'value' as const, value: 10 }]]);
    expect(targetOps(X, null, (k) => base2.get(k))).toEqual([{ ...A, op: 'set', value: 10 }]);
  });
});

describe('diffRows', () => {
  it('one row per varied field, base first, "not in this configuration" as null', () => {
    const b: VariantsBlock = { version: 1, active: null, variants: [v('x', [{ ...A, value: 4 }]), v('y', [{ ...A, value: 6 }, { ...B, value: 2 }])] };
    const rows = diffRows(b, (k) => (k.address === '#src' ? { kind: 'value', value: 10 } : null));
    expect(rows).toEqual([
      { ...A, base: { kind: 'value', value: 10 }, values: { x: 4, y: 6 } },
      { ...B, base: null, values: { y: 2 } },
    ]);
  });
});

it('round-trips descriptions and caps them at MAX_VARIANT_DESCRIPTION', () => {
  const b = { version: 1 as const, active: null, baseDescription: 'Base text',
    variants: [{ id: 'v1', name: 'A', revision: 0, overrides: [], description: 'Variant text' }] };
  expect(parseVariantsBlock({ Variants: serializeVariantsBlock(b)! })).toEqual({ block: b, issues: [] });
  const long = parseVariantsBlock({ Variants: { version: 1, active: null, baseDescription: 'x'.repeat(900),
    variants: [{ id: 'v1', name: 'A', revision: 0, overrides: [], description: 42 }] } }).block!;
  expect(long.baseDescription).toHaveLength(MAX_VARIANT_DESCRIPTION);
  expect(long.variants[0].description).toBeUndefined();
});

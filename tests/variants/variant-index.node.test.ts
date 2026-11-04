// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2013 Concept D — the field index that makes the inspector icons cheap.
 *
 * What is asserted: the three states (`overridden` / `elsewhere` / `none`), that `sync` is
 * INCREMENTAL (only variants whose revision moved are re-walked — a rename costs nothing
 * and does not bump the version), that a removed variant's fields fall back, and that
 * `infoOf` never depends on how many variants or overrides the block has.
 */

import { describe, expect, it } from 'vitest';
import { VariantFieldIndex } from '../../src/core/variants/rv-variant-index';
import { overrideKey, type FieldKey, type Variant, type VariantsBlock } from '../../src/core/variants/rv-variant-model';

const A: FieldKey = { address: '#src', component: 'Source', field: 'Interval' };
const B: FieldKey = { address: '#src', component: 'Source', field: 'MaxMUs' };
const C: FieldKey = { address: '#m1', component: 'Module', field: 'Rate' };

function variant(id: string, name: string, revision: number, overrides: Array<[FieldKey, number]>): Variant {
  return { id, name, revision, overrides: overrides.map(([k, value]) => ({ ...k, value })) };
}

function block(...variants: Variant[]): VariantsBlock {
  return { version: 1, active: null, variants };
}

describe('VariantFieldIndex', () => {
  it('answers the three states of Concept D', () => {
    const index = new VariantFieldIndex();
    const fast = variant('fast', 'Fast', 1, [[A, 4]]);
    const slow = variant('slow', 'Slow', 1, [[A, 12], [B, 3]]);
    index.sync(block(fast, slow), 'fast');

    expect(index.infoOf(A).state).toBe('overridden');
    expect(index.infoOf(A).value).toBe(4);
    expect(index.infoOf(A).variants).toEqual(['fast', 'slow']);
    // Inherited here, but another variant differs → the half icon.
    expect(index.infoOf(B).state).toBe('elsewhere');
    expect(index.infoOf(B).variants).toEqual(['slow']);
    expect(index.infoOf(C).state).toBe('none');

    // In Base everything varied reads as `elsewhere` — that is the point of the middle state.
    index.sync(block(fast, slow), null);
    expect(index.infoOf(A).state).toBe('elsewhere');
    expect(index.infoOf(B).state).toBe('elsewhere');
  });

  it('a value equal to Base is still an override (the index does not judge values)', () => {
    const index = new VariantFieldIndex();
    index.sync(block(variant('fast', 'Fast', 1, [[A, 10]])), 'fast');
    expect(index.infoOf(A).state).toBe('overridden');
    expect(index.valueOf(A, 'fast')).toBe(10);
  });

  it('syncs incrementally: only a changed revision is re-walked, a rename costs nothing', () => {
    const index = new VariantFieldIndex();
    const fast = variant('fast', 'Fast', 1, [[A, 4]]);
    const slow = variant('slow', 'Slow', 1, [[C, 7]]);
    index.sync(block(fast, slow), null);
    const afterFirst = index.version;

    // A rename does not bump the model's revision → nothing to do, no version change.
    index.sync(block({ ...fast, name: 'Faster' }, slow), null);
    expect(index.version).toBe(afterFirst);

    // An override write bumps the revision of ONE variant.
    const walked: string[] = [];
    const spy = block(
      { ...fast, revision: 2, get overrides() { walked.push('fast'); return [{ ...A, value: 5 }]; } } as Variant,
      { ...slow, get overrides() { walked.push('slow'); return [{ ...C, value: 7 }]; } } as Variant,
    );
    index.sync(spy, null);
    expect(walked).toEqual(['fast']);
    expect(index.version).toBe(afterFirst + 1);
    expect(index.valueOf(A, 'fast')).toBe(5);
  });

  it('a deleted variant releases its fields; clear() drops everything', () => {
    const index = new VariantFieldIndex();
    index.sync(block(variant('fast', 'Fast', 1, [[A, 4]]), variant('slow', 'Slow', 1, [[A, 12], [B, 2]])), null);
    expect(index.variedFieldCount).toBe(2);

    index.sync(block(variant('fast', 'Fast', 1, [[A, 4]])), null);
    expect(index.infoOf(B).state).toBe('none');
    expect(index.infoOf(A).variants).toEqual(['fast']);
    expect(index.variedFields()).toEqual([overrideKey(A)]);

    index.clear();
    expect(index.infoOf(A).state).toBe('none');
    expect(index.variedFieldCount).toBe(0);
  });

  it('an override taken back out of a variant leaves no trace', () => {
    const index = new VariantFieldIndex();
    index.sync(block(variant('fast', 'Fast', 1, [[A, 4], [B, 1]])), 'fast');
    index.sync(block(variant('fast', 'Fast', 2, [[A, 4]])), 'fast');
    expect(index.infoOf(B).state).toBe('none');
    expect(index.valueOf(B, 'fast')).toBeUndefined();
  });

  it('the active variant alone decides between overridden and elsewhere', () => {
    const index = new VariantFieldIndex();
    const b = block(variant('fast', 'Fast', 1, [[A, 4]]), variant('slow', 'Slow', 1, [[B, 2]]));
    index.sync(b, 'slow');
    expect(index.infoOf(A).state).toBe('elsewhere');
    expect(index.infoOf(B).state).toBe('overridden');
    const before = index.version;
    index.sync(b, 'fast');
    expect(index.version).toBe(before + 1);
    expect(index.infoOf(A).state).toBe('overridden');
    expect(index.infoOf(B).state).toBe('elsewhere');
  });
});

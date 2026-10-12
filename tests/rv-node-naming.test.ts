// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-758 §9.1 — the shared naming helper: start index 1, first-free (gap
 * filling, not max+1), no strip in `uniqueName`, strip-last-block-only in
 * `copyName`, the empty fallback, and the sibling scope.
 */
import { describe, it, expect } from 'vitest';
import {
  DEDUP_SUFFIX_RE,
  EMPTY_NAME_FALLBACK,
  copyName,
  siblingNames,
  stripDedupSuffix,
  uniqueName,
} from '../src/core/engine/rv-node-naming';

describe('rv-node-naming', () => {
  it('uniqueName: base, then _1, _2 (start index 1, first free)', () => {
    expect(uniqueName(new Set(), 'Belt')).toBe('Belt');
    expect(uniqueName(new Set(['Belt']), 'Belt')).toBe('Belt_1');
    expect(uniqueName(new Set(['Belt', 'Belt_1']), 'Belt')).toBe('Belt_2');
    // A gap is filled — first free, not max+1.
    expect(uniqueName(new Set(['Belt', 'Belt_2']), 'Belt')).toBe('Belt_1');
    // The base itself is free even though a suffixed sibling exists.
    expect(uniqueName(new Set(['Belt_1']), 'Belt')).toBe('Belt');
  });

  it('uniqueName never strips and never returns empty', () => {
    expect(uniqueName(new Set(), 'Conveyor_2000')).toBe('Conveyor_2000');
    expect(uniqueName(new Set(), 'Foo_part2')).toBe('Foo_part2');
    // A fresh placement of a catalog entry that is itself called Belt_2.
    expect(uniqueName(new Set(['Belt_2']), 'Belt_2')).toBe('Belt_2_1');
    expect(uniqueName(new Set(), '')).toBe(EMPTY_NAME_FALLBACK);
    expect(uniqueName(new Set([EMPTY_NAME_FALLBACK]), '  ')).toBe(`${EMPTY_NAME_FALLBACK}_1`);
  });

  it('stripDedupSuffix strips the last block only', () => {
    expect(stripDedupSuffix('Belt_2')).toBe('Belt');
    expect(stripDedupSuffix('Belt_1_2')).toBe('Belt_1');
    expect(stripDedupSuffix('Belt (copy)')).toBe('Belt (copy)');
    expect(stripDedupSuffix('Belt')).toBe('Belt');
    expect(stripDedupSuffix('Conveyor_2000')).toBe('Conveyor');
    expect(stripDedupSuffix('_5')).toBe('');
    expect(DEDUP_SUFFIX_RE.test('Belt_x1')).toBe(false);
  });

  it('copyName: strip, then first free', () => {
    expect(copyName(new Set(['Belt', 'Belt_1', 'Belt_2']), 'Belt_2')).toBe('Belt_3');
    // The stripped base is free → the copy takes the plain name.
    expect(copyName(new Set(['Belt_1']), 'Belt_1')).toBe('Belt');
    expect(copyName(new Set(['Belt']), 'Belt')).toBe('Belt_1');
    // Decision 3: an asset whose catalog name ends in digits loses that block
    // on copy — accepted. The copy of `Conveyor_2000` is `Conveyor` when that
    // is free, then `Conveyor_1`.
    expect(copyName(new Set(['Conveyor_2000']), 'Conveyor_2000')).toBe('Conveyor');
    expect(copyName(new Set(['Conveyor_2000', 'Conveyor']), 'Conveyor_2000')).toBe('Conveyor_1');
    // Decision 6: legacy "(copy)" names are opaque to the strip rule.
    expect(copyName(new Set(['Belt (copy)']), 'Belt (copy)')).toBe('Belt (copy)_1');
    // A purely numeric suffix name strips to nothing → the empty fallback.
    expect(copyName(new Set(), '_5')).toBe(EMPTY_NAME_FALLBACK);
  });

  it('a copy series never accumulates suffixes', () => {
    const taken = new Set(['Belt']);
    let last = 'Belt';
    for (let i = 1; i <= 5; i++) {
      last = copyName(taken, last);
      taken.add(last);
      expect(last).toBe(`Belt_${i}`);
    }
  });

  it('siblingNames excludes the clone itself and tolerates a null parent', () => {
    const a = { name: 'Belt' };
    const b = { name: 'Belt_1' };
    expect([...siblingNames({ children: [a, b] }, b)]).toEqual(['Belt']);
    expect([...siblingNames({ children: [a, b] })].sort()).toEqual(['Belt', 'Belt_1']);
    expect(siblingNames(null).size).toBe(0);
    expect(siblingNames(undefined).size).toBe(0);
  });
});

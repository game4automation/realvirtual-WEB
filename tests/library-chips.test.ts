// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the Library window chip helpers — collection-first faceting with a
 * category fallback, and the matching entry filter.
 */
import { describe, test, expect } from 'vitest';
import { deriveChips, filterByChip } from '../src/core/library/library-chips';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';

function entry(
  id: string,
  category: LibraryCatalogEntry['category'],
  collections?: string[],
): LibraryCatalogEntry {
  return { id, name: id, category, glbUrl: `${id}.glb`, collections };
}

describe('deriveChips', () => {
  test('returns no chips for an empty catalog', () => {
    expect(deriveChips([])).toEqual([]);
  });

  test('uses collections as the facet when any entry has them', () => {
    const chips = deriveChips([
      entry('a', 'custom', ['PalletHandling']),
      entry('b', 'custom', ['PalletHandling', 'Line A']),
      entry('c', 'robot', ['Line A']),
    ]);
    // Alphabetical (case-insensitive); counts are per-collection membership.
    expect(chips).toEqual([
      { key: 'Line A', label: 'Line A', count: 2 },
      { key: 'PalletHandling', label: 'PalletHandling', count: 2 },
    ]);
  });

  test('collection mode ignores entries without collections in counts', () => {
    const chips = deriveChips([
      entry('a', 'custom', ['Cell 1']),
      entry('b', 'custom'), // no collection — contributes to no chip
    ]);
    expect(chips).toEqual([{ key: 'Cell 1', label: 'Cell 1', count: 1 }]);
  });

  test('falls back to category facet when no entry has collections', () => {
    const chips = deriveChips([
      entry('a', 'robot'),
      entry('b', 'conveyor'),
      entry('c', 'robot'),
    ]);
    // Ordered by CATEGORY_ORDER (conveyor before robot), labelled.
    expect(chips).toEqual([
      { key: 'conveyor', label: 'Conveyors', count: 1 },
      { key: 'robot', label: 'Robots', count: 2 },
    ]);
  });
});

describe('filterByChip', () => {
  const entries = [
    entry('a', 'custom', ['Cell 1']),
    entry('b', 'robot', ['Cell 2']),
    entry('c', 'robot'),
  ];

  test('null returns every entry', () => {
    expect(filterByChip(entries, null)).toHaveLength(3);
  });

  test('matches a collection key', () => {
    expect(filterByChip(entries, 'Cell 1').map(e => e.id)).toEqual(['a']);
  });

  test('matches a category key (fallback facet)', () => {
    // Both the collection-tagged robot and the bare robot share category.
    expect(filterByChip(entries, 'robot').map(e => e.id)).toEqual(['b', 'c']);
  });
});

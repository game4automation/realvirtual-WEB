// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-chips — pure helpers that drive the Library window's filter chips.
 *
 * A "chip" is a single-click filter shown above the catalog grid. Collections
 * (free-form subfolder / Asset-Manager group names) are the primary facet; when
 * no entry carries a collection the category enum is used as the fallback facet
 * so every catalog — remote URL, GitHub scan, Local Folder — gets a consistent
 * chip row. Kept free of React / Three.js so they are unit-testable in isolation.
 */

import type { LibraryCatalogEntry } from './library-types';

/** Category order used both for chip ordering and (historically) accordions. */
export const CATEGORY_ORDER: LibraryCatalogEntry['category'][] = [
  'des', 'conveyor', 'robot', 'machine', 'fixture', 'custom', 'splat',
];

/** Human-readable labels for the fixed category enum. */
export const CATEGORY_LABELS: Record<string, string> = {
  des: 'DES Simulation',
  conveyor: 'Conveyors',
  robot: 'Robots',
  machine: 'Machines',
  fixture: 'Fixtures',
  custom: 'Custom',
  splat: 'Gaussian Splats',
};

export interface LibraryChip {
  /** Filter key — a collection name or a category enum value. */
  key: string;
  /** Display label — collection names pass through, categories are humanized. */
  label: string;
  /** Number of entries matching this chip. */
  count: number;
}

/**
 * Build the chip list for a set of catalog entries.
 *
 * - If ANY entry carries a `collections` array, chips are the unique collection
 *   names (alphabetical, case-insensitive) with their entry counts.
 * - Otherwise chips fall back to the categories actually present, ordered by
 *   {@link CATEGORY_ORDER} and labelled via {@link CATEGORY_LABELS}.
 */
export function deriveChips(entries: LibraryCatalogEntry[]): LibraryChip[] {
  const hasCollections = entries.some(e => (e.collections?.length ?? 0) > 0);

  if (hasCollections) {
    const counts = new Map<string, number>();
    for (const e of entries) {
      for (const c of e.collections ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([key, count]) => ({ key, label: key, count }));
  }

  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  const chips: LibraryChip[] = [];
  for (const cat of CATEGORY_ORDER) {
    const count = counts.get(cat);
    if (count) chips.push({ key: cat, label: CATEGORY_LABELS[cat] ?? cat, count });
  }
  return chips;
}

/**
 * Filter entries by a selected chip key. `null` returns everything. An entry
 * matches when the key is one of its collections OR equals its category — the
 * single predicate that serves both the collection facet and the category
 * fallback.
 */
export function filterByChip(
  entries: LibraryCatalogEntry[],
  selectedChip: string | null,
): LibraryCatalogEntry[] {
  if (selectedChip === null) return entries;
  return entries.filter(e =>
    (e.collections ?? []).includes(selectedChip) || e.category === selectedChip,
  );
}

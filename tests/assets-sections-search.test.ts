// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-702 §9.4 — search never rewrites the persisted collapse state.
 *
 * A user who collapses a noisy section to get it out of the way of ONE query
 * must find it exactly as they left it once the search box is empty again.
 * That is why there is a transient layer at all (§2.6 point 3, S4) rather than
 * just an effectiveCollapsed computed at read time.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { buildAssetGroups } from '../src/core/hmi/projects/assets-library-groups';
import {
  clearTransient,
  isSectionCollapsed,
  isSectionCollapsedEffective,
  resetAssetsSectionsForTests,
  toggleSection,
} from '../src/core/hmi/projects/assets-sections-store';
import { ASSETS_SECTIONS_COLLAPSED_KEY } from '../src/core/hmi/rv-storage-keys';
import type {
  LibrarySource,
  RegisteredLibrarySource,
} from '../src/core/library/library-source-registry';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';

function entry(id: string, name = id): LibraryCatalogEntry {
  return { id, name, category: 'custom', glbUrl: id + '.glb' };
}

function source(id: string, entries: LibraryCatalogEntry[]): RegisteredLibrarySource {
  const byId = new Map(entries.map(e => [e.id, e]));
  const s: LibrarySource = {
    id,
    label: id,
    kind: 'url',
    writable: false,
    loaded: true,
    listEntries: () => entries,
    getEntry: (a: string) => byId.get(a) ?? null,
    resolveAsset: async (a: string) => ({ url: 'blob:' + a }),
  };
  return { providerId: 'global', source: s };
}

beforeEach(() => {
  localStorage.removeItem(ASSETS_SECTIONS_COLLAPSED_KEY);
  resetAssetsSectionsForTests();
});

describe('Assets-tab search vs. collapse state', () => {
  test('hides groups with no match while a search is active', () => {
    const sources = [
      source('conveyors', [entry('belt', 'Belt Conveyor')]),
      source('robots', [entry('arm', 'Robot Arm')]),
    ];

    const groups = buildAssetGroups({ sources, searchTerm: 'belt', onSelect: () => {} });
    expect(groups.map(g => g.sourceId)).toEqual(['conveyors']);
    expect(groups[0].cards).toHaveLength(1);
    expect(groups[0].totalCount).toBe(1);
  });

  test('keeps empty groups visible when NO search is active', () => {
    const groups = buildAssetGroups({
      sources: [source('empty', [])],
      searchTerm: '',
      onSelect: () => {},
    });
    expect(groups).toHaveLength(1);
  });

  test('routes a toggle during an active search to the transient map, not localStorage', () => {
    toggleSection('global:a', true);

    expect(isSectionCollapsedEffective('global:a', true)).toBe(true);
    expect(isSectionCollapsed('global:a')).toBe(false);
    expect(localStorage.getItem(ASSETS_SECTIONS_COLLAPSED_KEY)).toBeNull();
  });

  test('restores the persisted collapse state when the search term is cleared', () => {
    toggleSection('global:a');
    toggleSection('global:a', true);
    expect(isSectionCollapsedEffective('global:a', true)).toBe(true);

    clearTransient();
    expect(isSectionCollapsedEffective('global:a', false)).toBe(true);
    expect(isSectionCollapsed('global:a')).toBe(true);
  });

  test('a collapsed section opens for a search hit without losing its stored state', () => {
    toggleSection('global:a');
    expect(isSectionCollapsedEffective('global:a', true)).toBe(false);
    expect(isSectionCollapsed('global:a')).toBe(true);
  });
});

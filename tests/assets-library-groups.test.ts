// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-702 §9.2 — the Assets-tab grouping.
 *
 * `buildAssetGroups` is deliberately a free function (§9, T1): there is no
 * precedent for mounting `ProjectsDashboardHost`, so keeping the grouping,
 * the type conversions and the error tolerance out of a `useMemo` body is what
 * makes any of it testable.
 *
 * The last test is the important one. `listEntries()` belongs to a foreign
 * provider; a throw inside the loop used to be able to blank the entire Assets
 * tab, including every healthy library (R4).
 */
import { describe, test, expect, vi } from 'vitest';
import {
  buildAssetGroups,
  assetGroupKey,
} from '../src/core/hmi/projects/assets-library-groups';
import type {
  LibrarySource,
  RegisteredLibrarySource,
} from '../src/core/library/library-source-registry';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';

function entry(id: string, name = id): LibraryCatalogEntry {
  return { id, name, category: 'custom', glbUrl: id + '.glb' };
}

function fakeSource(
  id: string,
  entries: LibraryCatalogEntry[],
  over: Partial<LibrarySource> = {},
): LibrarySource {
  const byId = new Map(entries.map(e => [e.id, e]));
  return {
    id,
    label: id,
    kind: 'url',
    writable: false,
    loaded: true,
    listEntries: () => entries,
    getEntry: (assetId: string) => byId.get(assetId) ?? null,
    resolveAsset: async (assetId: string) => ({ url: 'blob:' + assetId }),
    ...over,
  };
}

function registered(providerId: string, source: LibrarySource): RegisteredLibrarySource {
  return { providerId, source };
}

const noop = () => {};

describe('buildAssetGroups', () => {
  test('groups cards into one group per (providerId, sourceId)', () => {
    const groups = buildAssetGroups({
      sources: [
        registered('project', fakeSource('halle3', [entry('a'), entry('b')])),
        registered('global', fakeSource('https://x/catalog.json', [entry('c')])),
      ],
      searchTerm: '',
      onSelect: noop,
    });

    expect(groups).toHaveLength(2);
    expect(groups[0].groupKey).toBe('project:halle3');
    expect(groups[0].cards.map(c => c.entry.id)).toEqual(['a', 'b']);
    expect(groups[1].groupKey).toBe('global:https://x/catalog.json');
    expect(groups[1].cards.map(c => c.entry.id)).toEqual(['c']);
  });

  test('converts needsPermission undefined -> false and error null -> undefined', () => {
    const groups = buildAssetGroups({
      sources: [registered('global', fakeSource('s', [], { error: null }))],
      searchTerm: '',
      onSelect: noop,
    });

    expect(groups[0].needsPermission).toBe(false);
    // `undefined`, not `null` — a null would render as a truthy-looking empty
    // status row in `{group.error && …}` guards downstream.
    expect(groups[0].error).toBeUndefined();
    expect('error' in groups[0] ? groups[0].error : undefined).toBeUndefined();
  });

  test('sets removable from the presence of source.remove', () => {
    const groups = buildAssetGroups({
      sources: [
        registered('global', fakeSource('removable', [], { remove: async () => {} })),
        registered('global', fakeSource('fixed', [])),
      ],
      searchTerm: '',
      onSelect: noop,
    });

    expect(groups[0].removable).toBe(true);
    expect(groups[1].removable).toBe(false);
  });

  test('keeps two sources with the same label distinguishable by groupKey', () => {
    const groups = buildAssetGroups({
      sources: [
        registered('project', fakeSource('one', [], { label: 'Library' })),
        registered('global', fakeSource('two', [], { label: 'Library' })),
      ],
      searchTerm: '',
      onSelect: noop,
    });

    expect(groups[0].label).toBe(groups[1].label);
    expect(groups[0].groupKey).not.toBe(groups[1].groupKey);
    expect(groups[0].groupKey).toBe(assetGroupKey('project', 'one'));
  });

  test('survives a source whose listEntries() throws and still returns the other groups', () => {
    const broken = fakeSource('broken', []);
    broken.listEntries = () => { throw new Error('catalog is corrupt'); };

    const groups = buildAssetGroups({
      sources: [
        registered('global', broken),
        registered('project', fakeSource('healthy', [entry('a')])),
      ],
      searchTerm: '',
      onSelect: noop,
    });

    expect(groups).toHaveLength(2);
    expect(groups[0].cards).toEqual([]);
    expect(groups[0].error).toBe('catalog is corrupt');
    // The healthy library is untouched — that is the whole point of R4.
    expect(groups[1].cards).toHaveLength(1);
  });

  test('marks a card selected only for the exact (providerId, sourceId, assetId) triple', () => {
    const groups = buildAssetGroups({
      sources: [
        registered('project', fakeSource('p', [entry('a')])),
        registered('global', fakeSource('p', [entry('a')])),
      ],
      searchTerm: '',
      selectedAsset: { providerId: 'global', sourceId: 'p', assetId: 'a' },
      onSelect: noop,
    });

    expect(groups[0].cards[0].selected).toBe(false);
    expect(groups[1].cards[0].selected).toBe(true);
  });

  test('reports the selection through onSelect with the full identity', () => {
    const onSelect = vi.fn();
    const groups = buildAssetGroups({
      sources: [registered('global', fakeSource('s', [entry('a')]))],
      searchTerm: '',
      onSelect,
    });

    groups[0].cards[0].onSelect();
    expect(onSelect).toHaveBeenCalledWith({
      providerId: 'global', sourceId: 's', assetId: 'a',
    });
  });

  test('tags bundled sources as the bundled tier and everything else as user', () => {
    const groups = buildAssetGroups({
      sources: [
        registered('global', fakeSource('b', [entry('a')], { kind: 'bundled' })),
        registered('project', fakeSource('p', [entry('a')], { kind: 'project' })),
      ],
      searchTerm: '',
      onSelect: noop,
    });

    expect(groups[0].cards[0].tier).toBe('bundled');
    expect(groups[1].cards[0].tier).toBe('user');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-723 §9.1 — the planner library dropdown, fed from the library registry.
 *
 * Everything interesting about this feature is a decision about a LIST: which
 * sources appear, in what order, which one is active when nothing is stored,
 * which entries a catalog tab still shows once the project has claimed them,
 * and where a selection is written. None of that needs a rendered tree, and
 * mounting the panel would mostly exercise MUI — which is why
 * `buildLibraryTabs` / `resolveDefaultTab` / `storeTabUrlOf` are pure and
 * exported.
 *
 * Fakes follow `tests/library-source-registry.test.ts`.
 */
import { describe, it, expect } from 'vitest';

import {
  buildLibraryTabs,
  resolveDefaultTab,
  normalizePersistedTab,
  storeTabUrlOf,
  projectDedupKeys,
  dedupedEntries,
  registryTabId,
  type AmConnectionLike,
} from '../src/plugins/layout-planner/LayoutLibraryPanel';
import type {
  LibrarySource,
  RegisteredLibrarySource,
} from '../src/core/library/library-source-registry';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

function entry(over: Partial<LibraryCatalogEntry> & { id: string }): LibraryCatalogEntry {
  return { name: over.id, category: 'custom', ...over };
}

function fakeSource(over: Partial<LibrarySource> & { id: string }): LibrarySource {
  // `listEntries` is spread in verbatim and never called here: one of the cases
  // hands in a THROWING listing, and a fixture that pre-called it would blow up
  // at construction instead of where the rule under test lives.
  const listEntries = over.listEntries ?? (() => []);
  return {
    label: over.id,
    kind: 'url',
    writable: false,
    loaded: true,
    error: null,
    getEntry: (assetId: string) => listEntries().find(e => e.id === assetId) ?? null,
    resolveAsset: async () => ({ url: 'blob:' + over.id }),
    ...over,
    listEntries,
  };
}

function registered(providerId: string, source: LibrarySource): RegisteredLibrarySource {
  return { providerId, source };
}

function projectSource(over: Partial<LibrarySource> = {}): RegisteredLibrarySource {
  return registered('project', fakeSource({
    id: 'proj-1',
    label: 'MeinProjekt',
    kind: 'project',
    writable: true,
    ...over,
  }));
}

function globalSource(url: string, entries: LibraryCatalogEntry[] = []): RegisteredLibrarySource {
  return registered('global', fakeSource({
    id: url,
    label: url,
    kind: 'url',
    listEntries: () => entries,
  }));
}

function amConn(id: string, label: string): AmConnectionLike {
  return { conn: { id, label }, connected: true, connecting: false };
}

const CATALOG_URL = 'https://example.com/catalog.json';

// ─── Order + default ────────────────────────────────────────────────────

describe('plan-723 §9.1 — planner library tabs from registry', () => {
  it('lists the project source first and makes it the default active tab', () => {
    // Registration order deliberately puts the project LAST: display order is
    // a property of this function, not of the registry.
    const tabs = buildLibraryTabs([globalSource(CATALOG_URL), projectSource()], []);

    expect(tabs.map(t => t.id)).toEqual([
      registryTabId('project', 'proj-1'),
      registryTabId('global', CATALOG_URL),
    ]);
    expect(tabs[0].kind).toBe('project');
    expect(tabs[0].label).toBe('MeinProjekt');
    expect(resolveDefaultTab(tabs, null)).toBe('project:proj-1');
  });

  it('falls back to the first tab when no project source is registered (no active project)', () => {
    const tabs = buildLibraryTabs([globalSource(CATALOG_URL)], []);
    expect(resolveDefaultTab(tabs, null)).toBe(registryTabId('global', CATALOG_URL));
  });

  it('resolves to null when there is nothing to pick at all', () => {
    expect(resolveDefaultTab([], null)).toBeNull();
    expect(resolveDefaultTab([], 'project:gone')).toBeNull();
  });

  it('filters the unity-asset-manager provider out of the registry feed', () => {
    // The private cloud provider registers its connections in the registry AS
    // WELL, and the panel renders them from `cloudStore` (it needs the
    // connection state the registry does not carry). Without the filter every
    // connection would appear twice.
    const tabs = buildLibraryTabs(
      [projectSource(), registered('unity-asset-manager', fakeSource({ id: 'c1', label: 'AM One', kind: 'cloud' }))],
      [amConn('c1', 'AM One')],
    );

    expect(tabs.map(t => t.id)).toEqual(['project:proj-1', 'am:c1']);
    expect(tabs.filter(t => t.label === 'AM One')).toHaveLength(1);
    expect(tabs[1].kind).toBe('cloud');
    expect(tabs[1].cloudStatus).toBe('connected');
  });

  it('lists every store catalog exactly once (no store+registry double listing)', () => {
    const sources = [
      globalSource(CATALOG_URL, [entry({ id: 'a' })]),
      globalSource('https://example.com/other.json', [entry({ id: 'b' })]),
    ];
    const tabs = buildLibraryTabs(sources, []);

    const ids = tabs.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      registryTabId('global', CATALOG_URL),
      registryTabId('global', 'https://example.com/other.json'),
    ]);
  });

  it('carries loaded / error state onto the tab', () => {
    const tabs = buildLibraryTabs([
      globalSource(CATALOG_URL),
      registered('global', fakeSource({ id: 'broken', loaded: false, error: 'boom' })),
      registered('global', fakeSource({ id: 'pending', loaded: false, error: null })),
    ], []);

    expect(tabs.find(t => t.sourceId === 'broken')?.error).toBe('boom');
    expect(tabs.find(t => t.sourceId === 'pending')?.loaded).toBe(false);
    expect(tabs.find(t => t.sourceId === CATALOG_URL)?.loaded).toBe(true);
  });

  it('survives a source whose listEntries() throws', () => {
    const exploding = registered('global', fakeSource({
      id: 'explodes',
      listEntries: () => { throw new Error('provider broke'); },
    }));
    expect(() => buildLibraryTabs([projectSource(), exploding], [])).not.toThrow();
    expect(buildLibraryTabs([projectSource(), exploding], []).map(t => t.sourceId))
      .toEqual(['proj-1', 'explodes']);
  });
});

// ─── Dedup (F6) ─────────────────────────────────────────────────────────

describe('plan-723 §9.1 — deploy dedup, project wins', () => {
  const belt = entry({ id: 'project:library/Conveyors/Belt.glb', localPath: 'library/Conveyors/Belt.glb' });
  const deployedBelt = entry({ id: 'cat:belt', glbUrl: '/library/Conveyors/Belt.glb' });
  const deployedRobot = entry({ id: 'cat:robot', glbUrl: '/library/Robots/Arm.glb' });

  it('hides catalog entries colliding with a project entry via crossSourceKeyOf, and hides fully-deduped tabs', () => {
    const project = projectSource({ listEntries: () => [belt] });
    const catalog = globalSource(CATALOG_URL, [deployedBelt, deployedRobot]);
    const mirror = globalSource('https://example.com/mirror.json', [deployedBelt]);

    const keys = projectDedupKeys([project, catalog, mirror]);
    expect(keys).toEqual(new Set(['conveyors/belt.glb']));

    // The colliding card is gone, the unrelated one stays.
    expect(dedupedEntries(catalog, keys).map(e => e.id)).toEqual(['cat:robot']);
    // The project's own entries are never deduplicated against themselves.
    expect(dedupedEntries(project, keys).map(e => e.id)).toEqual([belt.id]);

    // A catalog that has NOTHING left is not a tab any more.
    const tabs = buildLibraryTabs([project, catalog, mirror], []);
    expect(tabs.map(t => t.sourceId)).toEqual(['proj-1', CATALOG_URL]);
  });

  it('applies NO dedup while the project source is still loading (loaded:false)', () => {
    // Deduplicating against a half-filled project source would make catalog
    // cards blink out and back in during the async listing.
    const loadingProject = projectSource({ loaded: false, listEntries: () => [] });
    const mirror = globalSource('https://example.com/mirror.json', [deployedBelt]);

    expect(projectDedupKeys([loadingProject, mirror])).toBeNull();
    expect(dedupedEntries(mirror, null).map(e => e.id)).toEqual(['cat:belt']);
    expect(buildLibraryTabs([loadingProject, mirror], []).map(t => t.sourceId))
      .toEqual(['proj-1', 'https://example.com/mirror.json']);
  });

  it('applies no dedup at all when there is no project source', () => {
    const catalog = globalSource(CATALOG_URL, [deployedBelt]);
    expect(projectDedupKeys([catalog])).toBeNull();
    expect(dedupedEntries(catalog, null)).toHaveLength(1);
  });

  it('keeps a still-loading catalog tab even though it has zero entries', () => {
    const project = projectSource({ listEntries: () => [belt] });
    const loadingCatalog = registered('global', fakeSource({ id: 'slow', loaded: false }));
    expect(buildLibraryTabs([project, loadingCatalog], []).map(t => t.sourceId))
      .toEqual(['proj-1', 'slow']);
  });
});

// ─── Persistence (read + write) ─────────────────────────────────────────

describe('plan-723 §9.1 — tab persistence', () => {
  it('keeps a legacy persisted catalog URL selection when that catalog still exists, else falls back to the project tab', () => {
    const tabs = buildLibraryTabs([projectSource(), globalSource(CATALOG_URL)], []);

    // Legacy value is a BARE url — the store could never hold anything else.
    const migrated = normalizePersistedTab(null, CATALOG_URL);
    expect(migrated).toBe(registryTabId('global', CATALOG_URL));
    expect(resolveDefaultTab(tabs, migrated)).toBe(registryTabId('global', CATALOG_URL));

    // A catalog that is gone falls through to the default, which is the project.
    const stale = normalizePersistedTab(null, 'https://example.com/removed.json');
    expect(resolveDefaultTab(tabs, stale)).toBe('project:proj-1');
  });

  it('prefers the panel key over the legacy store value, and passes an already-prefixed value through', () => {
    expect(normalizePersistedTab('project:proj-1', CATALOG_URL)).toBe('project:proj-1');
    expect(normalizePersistedTab('am:c1', CATALOG_URL)).toBe('am:c1');
    expect(normalizePersistedTab(null, `global:${CATALOG_URL}`)).toBe(`global:${CATALOG_URL}`);
    expect(normalizePersistedTab(null, null)).toBeNull();
    expect(normalizePersistedTab(null, undefined)).toBeNull();
  });

  it('selection write path: global: tab writes store.setActiveTab (unprefixed), project:/am: tabs do NOT touch the store', () => {
    // `LibraryStore.setActiveTab` silently ignores anything that is not a known
    // catalog URL, so handing it a project id would leave the store pointing at
    // the PREVIOUS catalog — a selection that looks persisted and is not.
    expect(storeTabUrlOf(registryTabId('global', CATALOG_URL))).toBe(CATALOG_URL);
    expect(storeTabUrlOf('project:proj-1')).toBeNull();
    expect(storeTabUrlOf('am:c1')).toBeNull();
  });
});

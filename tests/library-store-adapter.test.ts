// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-372 §9.6 — the `LayoutStore` ↔ `LibraryStore` adapter contract (§2.6.2).
 *
 * The failure this guards against is subtle and silent: a getter-only adapter
 * compiles, renders and passes a smoke test, but every library change made
 * outside the planner is invisible to the planner UI, and every planner-side
 * mutation writes into a copy nobody reads.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { LibraryStore } from '../src/core/library/library-store';
import { LayoutStore } from '../src/plugins/layout-planner/rv-layout-store';
import {
  getLibraryStore,
  resetLibraryStoreForTests,
} from '../src/core/library/library-store-singleton';
import type { LibraryCatalog } from '../src/core/library/library-types';

const CATALOG: LibraryCatalog = {
  version: '1.0',
  name: 'Test',
  entries: [{ id: 'belt', name: 'Belt', category: 'conveyor', glbUrl: 'belt.glb' }],
};

beforeEach(() => {
  localStorage.clear();
  resetLibraryStoreForTests();
});

describe('LayoutStore ↔ LibraryStore adapter', () => {
  test('a DIRECT library mutation produces exactly ONE LayoutStore notification', () => {
    const library = new LibraryStore();
    const layout = new LayoutStore(library);
    let calls = 0;
    layout.subscribe(() => { calls++; });

    library.addCatalogDirect('bundled://test', CATALOG);

    expect(calls).toBe(1);
  });

  test('the combined snapshot carries the library change', () => {
    const library = new LibraryStore();
    const layout = new LayoutStore(library);
    const before = layout.getSnapshot();

    library.addCatalogDirect('bundled://test', CATALOG);

    const after = layout.getSnapshot();
    expect(after).not.toBe(before);              // fresh identity → React repaints
    expect(after.catalogUrls).toEqual(['bundled://test']);
    expect(after.catalogs.get('bundled://test')?.entries[0].id).toBe('belt');
    expect(after.activeTabUrl).toBe('bundled://test');
    // …and the planner half of the same snapshot is untouched.
    expect(after.placed).toEqual(before.placed);
    expect(after.gridSizeMm).toBe(before.gridSizeMm);
  });

  test('delegated mutators write into the LibraryStore, not a local copy', () => {
    const library = new LibraryStore();
    const layout = new LayoutStore(library);

    layout.addCatalogDirect('bundled://test', CATALOG);
    expect(library.catalogUrls).toEqual(['bundled://test']);

    layout.setEntryThumbnail('belt', 'data:image/png;base64,AAA');
    expect(library.catalogs.get('bundled://test')?.entries[0].thumbnailUrl)
      .toBe('data:image/png;base64,AAA');

    layout.setThumbnailPending('belt', true);
    expect(library.thumbnailPending.has('belt')).toBe(true);
    expect(layout.getSnapshot().thumbnailPending.has('belt')).toBe(true);

    layout.removeCatalog('bundled://test');
    expect(library.catalogUrls).toEqual([]);
  });

  test('setActiveTab delegates', () => {
    const library = new LibraryStore();
    const layout = new LayoutStore(library);
    layout.addCatalogDirect('a', CATALOG);
    layout.addCatalogDirect('b', CATALOG);
    layout.setActiveTab('b');
    expect(library.activeTabUrl).toBe('b');
  });

  test('autoSave() serializes the DELEGATED catalog urls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: '1.0', name: 'T', entries: [] })),
    );
    const library = new LibraryStore();
    const layout = new LayoutStore(library);
    await library.addCatalog('https://example.com/catalog.json');

    layout.autoSave();
    const saved = JSON.parse(localStorage.getItem('rv-layout-autosave') ?? '{}');
    expect(saved.catalogUrls).toEqual(['https://example.com/catalog.json']);
    vi.restoreAllMocks();
  });

  test('dispose() detaches the bridge', () => {
    const library = new LibraryStore();
    const layout = new LayoutStore(library);
    let calls = 0;
    library.subscribe(() => { calls++; });

    layout.dispose();
    library.addCatalogDirect('bundled://test', CATALOG);

    // The library still notifies its own subscribers…
    expect(calls).toBe(1);
    // …but the disposed adapter no longer rebuilds its snapshot.
    expect(layout.getSnapshot().catalogUrls).toEqual([]);
  });

  test('two adapters over one library both see the change (the singleton case)', () => {
    const library = getLibraryStore();
    const planner = new LayoutStore(library);
    const dashboard = new LayoutStore(library);

    planner.addCatalogDirect('bundled://test', CATALOG);

    expect(dashboard.getSnapshot().catalogUrls).toEqual(['bundled://test']);
    planner.dispose();
    dashboard.dispose();
  });

  test('an un-injected LayoutStore keeps its own library (test isolation seam)', () => {
    const a = new LayoutStore();
    const b = new LayoutStore();
    a.addCatalogDirect('bundled://test', CATALOG);
    expect(b.getSnapshot().catalogUrls).toEqual([]);
  });

  test('getLibraryStore() is a singleton, resettable for tests', () => {
    const first = getLibraryStore();
    expect(getLibraryStore()).toBe(first);
    resetLibraryStoreForTests();
    expect(getLibraryStore()).not.toBe(first);
  });
});

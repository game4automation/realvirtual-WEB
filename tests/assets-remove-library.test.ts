// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-702 §9.5 — detaching a library (F6).
 *
 * Two rules, both easy to regress:
 *   1. The REMOVE ROUTE comes from the provider (`source.remove`), never from
 *      a UI guess about `kind` or `origin`. A project library and a bundled
 *      catalog therefore offer none, without the UI knowing what either means.
 *   2. A selection pointing into the removed library must be cleared, or the
 *      detail pane keeps describing a source that no longer exists (R5).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { selectionPointsIntoGroup } from '../src/core/hmi/projects/assets-library-groups';
import {
  listLibrarySources,
  resetLibrarySourceRegistryForTests,
} from '../src/core/library/library-source-registry';
import {
  installGlobalLibraryProvider,
  uninstallGlobalLibraryProvider,
  type LibraryStoreLike,
} from '../src/core/library/global-library-provider';
import {
  installProjectLibraryProvider,
  uninstallProjectLibraryProvider,
  type ProjectStoreLike,
} from '../src/core/library/project-library-provider';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';

class FakeLibraryStore implements LibraryStoreLike {
  catalogUrls: string[] = [];
  catalogs = new Map<string, { name?: string; entries: LibraryCatalogEntry[] }>();
  catalogErrors = new Map<string, string>();
  origins = new Map<string, string>();
  private _listeners = new Set<() => void>();
  subscribe(l: () => void) { this._listeners.add(l); return () => { this._listeners.delete(l); }; }
  getOrigin(url: string) { return this.origins.get(url) ?? null; }
  removeCatalog(url: string) { this.catalogUrls = this.catalogUrls.filter(u => u !== url); }
}

/** Minimal project store whose backend lists an empty library folder. */
function fakeProjectStore(): ProjectStoreLike {
  const backend = {
    kind: 'folder',
    writable: true,
    listLibrary: async () => [],
  } as unknown as ProjectBackend;
  return {
    subscribe: () => () => {},
    getBackend: () => backend,
    getProject: () => ({ id: 'halle3', name: 'Halle 3' }),
  };
}

beforeEach(() => resetLibrarySourceRegistryForTests());
afterEach(() => {
  uninstallGlobalLibraryProvider();
  uninstallProjectLibraryProvider();
  resetLibrarySourceRegistryForTests();
});

describe('removing a library', () => {
  test('offers no remove route for project or bundled sources', async () => {
    const store = new FakeLibraryStore();
    store.catalogUrls = ['bundled://standard', 'https://user.example/catalog.json'];
    store.catalogs.set('bundled://standard', { name: 'Standard', entries: [] });
    store.origins.set('https://user.example/catalog.json', 'user');

    installGlobalLibraryProvider(store);
    installProjectLibraryProvider(fakeProjectStore());
    // The project provider fills its source asynchronously.
    await new Promise(r => setTimeout(r, 0));

    // Read the registry DIRECTLY. The grouping layer this used to go through
    // was deleted with the Assets tab (plan-709 phase 6), and it only ever
    // copied `typeof source.remove === 'function'` into a `removable` field —
    // asking the source itself is the same rule with one fewer indirection.
    const byKind = Object.fromEntries(
      listLibrarySources().map(({ source }) => [source.kind, typeof source.remove === 'function']),
    );

    expect(byKind.bundled).toBe(false);
    expect(byKind.project).toBe(false);
    expect(byKind.url).toBe(true);
  });

  test('clears an asset selection that pointed into the removed library', () => {
    const group = { providerId: 'global', sourceId: 'https://x/catalog.json' };

    expect(selectionPointsIntoGroup(
      { kind: 'asset', providerId: 'global', sourceId: 'https://x/catalog.json' }, group,
    )).toBe(true);
  });

  test('keeps a selection that points at a DIFFERENT library', () => {
    const group = { providerId: 'global', sourceId: 'https://x/catalog.json' };

    expect(selectionPointsIntoGroup(
      { kind: 'asset', providerId: 'global', sourceId: 'https://other/catalog.json' }, group,
    )).toBe(false);
    // Same source id under another provider is a different library entirely —
    // identity is the PAIR.
    expect(selectionPointsIntoGroup(
      { kind: 'asset', providerId: 'project', sourceId: 'https://x/catalog.json' }, group,
    )).toBe(false);
    expect(selectionPointsIntoGroup({ kind: 'document' }, group)).toBe(false);
    expect(selectionPointsIntoGroup({ kind: 'none' }, group)).toBe(false);
  });
});

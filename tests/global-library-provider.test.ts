// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-702 §9.1 — the bridge from `library-store` into the source registry.
 *
 * This provider is the reason the whole plan works: without it the global
 * catalogs (URL / GitHub / local folder / bundled) never reach a registry
 * consumer, so the Assets tab could show the project's own library and nothing
 * else, and "Add library" would add something invisible.
 *
 * The two contracts worth guarding are the ones a later refactor would break
 * silently: a bundled catalog must have NO `remove` (that is how the UI knows
 * it cannot be detached), and `listEntries()` must return `[]` — never throw —
 * while a catalog is still loading.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  listLibrarySources,
  resetLibrarySourceRegistryForTests,
} from '../src/core/library/library-source-registry';
import {
  installGlobalLibraryProvider,
  uninstallGlobalLibraryProvider,
  GLOBAL_LIBRARY_PROVIDER_ID,
  type LibraryStoreLike,
} from '../src/core/library/global-library-provider';
import { LOCAL_NEEDS_PERMISSION, type LibraryCatalogEntry } from '../src/core/library/library-types';

function entry(id: string): LibraryCatalogEntry {
  return { id, name: id, category: 'custom', glbUrl: id + '.glb' };
}

/** Minimal stand-in for `LibraryStore` — only what the provider reads. */
class FakeLibraryStore implements LibraryStoreLike {
  catalogUrls: string[] = [];
  catalogs = new Map<string, { name?: string; entries: LibraryCatalogEntry[] }>();
  catalogErrors = new Map<string, string>();
  origins = new Map<string, string>();
  removedCatalogs: string[] = [];
  removedLocalFolders = 0;
  refreshedLocalFolders = 0;

  private _listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  notify(): void { for (const l of this._listeners) l(); }

  getOrigin(url: string): string | null { return this.origins.get(url) ?? null; }

  removeCatalog(url: string): void {
    this.removedCatalogs.push(url);
    this.catalogUrls = this.catalogUrls.filter(u => u !== url);
    this.notify();
  }

  async removeLocalFolder(): Promise<void> { this.removedLocalFolders++; }
  async refreshLocalFolder(): Promise<void> { this.refreshedLocalFolders++; }
}

let store: FakeLibraryStore;

beforeEach(() => {
  resetLibrarySourceRegistryForTests();
  store = new FakeLibraryStore();
});

afterEach(() => {
  uninstallGlobalLibraryProvider();
  resetLibrarySourceRegistryForTests();
});

function globalSources() {
  return listLibrarySources().filter(s => s.providerId === GLOBAL_LIBRARY_PROVIDER_ID);
}

describe('global-library-provider', () => {
  test('exposes one LibrarySource per catalog url', () => {
    store.catalogUrls = ['https://a.example/catalog.json', 'https://b.example/catalog.json'];
    store.origins.set('https://a.example/catalog.json', 'user');
    store.origins.set('https://b.example/catalog.json', 'user');
    store.catalogs.set('https://a.example/catalog.json', { name: 'Alpha', entries: [entry('x')] });
    installGlobalLibraryProvider(store);

    const sources = globalSources();
    expect(sources.map(s => s.source.id)).toEqual([
      'https://a.example/catalog.json',
      'https://b.example/catalog.json',
    ]);
    expect(sources[0].source.label).toBe('Alpha');
    expect(sources[0].source.listEntries()).toHaveLength(1);
  });

  test('marks bundled catalogs as kind "bundled" and gives them NO remove()', () => {
    // A catalog injected via `addCatalogDirect` never records an origin — that
    // is the observable proxy for the store's private `_bundledUrls` set.
    store.catalogUrls = ['bundled://standard'];
    store.catalogs.set('bundled://standard', { name: 'realvirtual Standard', entries: [] });
    installGlobalLibraryProvider(store);

    const source = globalSources()[0].source;
    expect(source.kind).toBe('bundled');
    expect(source.remove).toBeUndefined();
  });

  test('gives user-added catalogs a remove() that calls removeCatalog', async () => {
    const url = 'https://c.example/catalog.json';
    store.catalogUrls = [url];
    store.origins.set(url, 'user');
    installGlobalLibraryProvider(store);

    const source = globalSources()[0].source;
    expect(typeof source.remove).toBe('function');
    await source.remove!();
    expect(store.removedCatalogs).toEqual([url]);
  });

  test('routes a local folder to removeLocalFolder / refreshLocalFolder', async () => {
    store.catalogUrls = ['local:Work/library'];
    store.catalogs.set('local:Work/library', { name: 'Local: Work/library', entries: [] });
    installGlobalLibraryProvider(store);

    const source = globalSources()[0].source;
    expect(source.kind).toBe('local');
    expect(source.label).toBe('Work/library');
    await source.remove!();
    await source.refresh!();
    expect(store.removedLocalFolders).toBe(1);
    expect(store.refreshedLocalFolders).toBe(1);
    expect(store.removedCatalogs).toEqual([]);
  });

  test('returns [] from listEntries while the catalog is still loading', () => {
    const url = 'https://slow.example/catalog.json';
    store.catalogUrls = [url];
    store.origins.set(url, 'user');
    installGlobalLibraryProvider(store);

    const source = globalSources()[0].source;
    expect(() => source.listEntries()).not.toThrow();
    expect(source.listEntries()).toEqual([]);
    expect(source.loaded).toBe(false);
  });

  test('surfaces catalogErrors as source.error', () => {
    const url = 'https://bad.example/catalog.json';
    store.catalogUrls = [url];
    store.origins.set(url, 'user');
    store.catalogErrors.set(url, 'HTTP 404');
    installGlobalLibraryProvider(store);

    const source = globalSources()[0].source;
    expect(source.error).toBe('HTTP 404');
    expect(source.loaded).toBe(false);
    expect(source.needsPermission).toBe(false);
  });

  test('splits the permission sentinel out of error into needsPermission', () => {
    const url = 'local:Work/library';
    store.catalogUrls = [url];
    store.catalogs.set(url, { name: 'Local: Work/library', entries: [entry('a')] });
    store.catalogErrors.set(url, LOCAL_NEEDS_PERMISSION);
    installGlobalLibraryProvider(store);

    const source = globalSources()[0].source;
    expect(source.needsPermission).toBe(true);
    // Not "failed to load" — the folder is fine, the browser just forgot.
    expect(source.error).toBeNull();
    expect(source.listEntries()).toEqual([]);
  });

  test('republishes when the store notifies', () => {
    installGlobalLibraryProvider(store);
    expect(globalSources()).toHaveLength(0);

    store.catalogUrls = ['https://late.example/catalog.json'];
    store.origins.set('https://late.example/catalog.json', 'user');
    store.notify();

    expect(globalSources()).toHaveLength(1);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-702 §9.1 — the bridge from `library-store` into the source registry.
 *
 * This provider is the reason the whole plan works: without it the global
 * catalogs (URL / GitHub / bundled) never reach a registry
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
import { type LibraryCatalogEntry } from '../src/core/library/library-types';

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
  });

  // There used to be a third state between "loaded" and "error": a remembered
  // local folder whose browser permission had lapsed. That source kind went
  // with the working folder (plan-709 §2.6), and with it the sentinel that
  // encoded the state inside `catalogErrors` — so an error here is now always
  // an error.
  test('has no permission limbo left between loaded and error', () => {
    const url = 'https://c.example/catalog.json';
    store.catalogUrls = [url];
    store.origins.set(url, 'user');
    store.catalogs.set(url, { name: 'C', entries: [entry('a')] });
    installGlobalLibraryProvider(store);

    const source = globalSources()[0].source;
    expect(source.error).toBeNull();
    expect(source.loaded).toBe(true);
    expect(source.listEntries()).toHaveLength(1);
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

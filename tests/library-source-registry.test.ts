// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-372 §9.5 — the library source registry and the active project as a
 * provider. Covers the two contracts that are easy to get wrong: identity is
 * the PAIR (providerId, sourceId), and the snapshot is a version COUNTER.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerLibrarySourceProvider,
  listLibrarySources,
  getLibrarySource,
  subscribeLibrarySources,
  getLibrarySourcesSnapshot,
  resolveAsset,
  resetLibrarySourceRegistryForTests,
  type LibrarySource,
  type LibrarySourceProvider,
} from '../src/core/library/library-source-registry';
import {
  installProjectLibraryProvider,
  uninstallProjectLibraryProvider,
  PROJECT_LIBRARY_PROVIDER_ID,
  type ProjectStoreLike,
} from '../src/core/library/project-library-provider';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { FolderBackend } from '../src/core/project/backends/folder-backend';

function entry(id: string): LibraryCatalogEntry {
  return { id, name: id, category: 'custom', glbUrl: id + '.glb' };
}

function fakeSource(id: string, entries: LibraryCatalogEntry[] = []): LibrarySource {
  const byId = new Map(entries.map(e => [e.id, e]));
  return {
    id,
    label: id,
    kind: 'url',
    writable: false,
    loaded: true,
    listEntries: () => entries,
    getEntry: (assetId: string) => byId.get(assetId) ?? null,
    resolveAsset: async (assetId: string) => {
      if (!byId.has(assetId)) throw new Error('unknown asset ' + assetId);
      return { url: 'blob:' + assetId };
    },
  };
}

function fakeProvider(id: string, sources: LibrarySource[]): LibrarySourceProvider {
  const listeners = new Set<() => void>();
  return {
    id,
    listSources: () => sources,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}

beforeEach(() => resetLibrarySourceRegistryForTests());
afterEach(() => { uninstallProjectLibraryProvider(); resetLibrarySourceRegistryForTests(); });

describe('library source registry', () => {
  test('register / list / get / unregister', () => {
    const dispose = registerLibrarySourceProvider(fakeProvider('p1', [fakeSource('a')]));
    expect(listLibrarySources().map(s => s.source.id)).toEqual(['a']);
    expect(getLibrarySource('p1', 'a')?.label).toBe('a');
    dispose();
    expect(listLibrarySources()).toEqual([]);
    expect(getLibrarySource('p1', 'a')).toBeNull();
  });

  test('two providers accumulate', () => {
    registerLibrarySourceProvider(fakeProvider('p1', [fakeSource('a')]));
    registerLibrarySourceProvider(fakeProvider('p2', [fakeSource('b')]));
    expect(listLibrarySources()).toHaveLength(2);
  });

  test('identical source ids in two providers do not collide', () => {
    const s1 = fakeSource('library', [entry('one')]);
    const s2 = fakeSource('library', [entry('two')]);
    registerLibrarySourceProvider(fakeProvider('p1', [s1]));
    registerLibrarySourceProvider(fakeProvider('p2', [s2]));
    expect(getLibrarySource('p1', 'library')?.listEntries()[0].id).toBe('one');
    expect(getLibrarySource('p2', 'library')?.listEntries()[0].id).toBe('two');
  });

  test('snapshot is a version counter, not an object', () => {
    const before = getLibrarySourcesSnapshot();
    expect(typeof before).toBe('number');
    registerLibrarySourceProvider(fakeProvider('p1', [fakeSource('a')]));
    expect(getLibrarySourcesSnapshot()).toBeGreaterThan(before);
    // Repeated reads without a mutation are identical — no render loop.
    expect(getLibrarySourcesSnapshot()).toBe(getLibrarySourcesSnapshot());
  });

  test('subscribers are notified on register and unregister', () => {
    let calls = 0;
    const unsub = subscribeLibrarySources(() => { calls++; });
    const dispose = registerLibrarySourceProvider(fakeProvider('p1', [fakeSource('a')]));
    expect(calls).toBe(1);
    dispose();
    expect(calls).toBe(2);
    unsub();
  });

  test('getEntry on an unknown id returns null instead of throwing', () => {
    registerLibrarySourceProvider(fakeProvider('p1', [fakeSource('a', [entry('x')])]));
    expect(getLibrarySource('p1', 'a')?.getEntry('nope')).toBeNull();
  });

  test('resolveAsset propagates the provider error', async () => {
    registerLibrarySourceProvider(fakeProvider('p1', [fakeSource('a', [entry('x')])]));
    await expect(resolveAsset('p1', 'a', 'missing', 'edit')).rejects.toThrow(/unknown asset/);
    await expect(resolveAsset('p1', 'gone', 'x', 'edit')).rejects.toThrow(/not registered/);
  });
});

// ─── The active project as a provider ─────────────────────────────────

interface FakeProjectStore extends ProjectStoreLike {
  set(project: { id: string; name: string } | null, library: { path: string; label?: string }[]): void;
  released: number;
}

function fakeProjectStore(): FakeProjectStore {
  const listeners = new Set<() => void>();
  let project: { id: string; name: string } | null = null;
  let library: { path: string; label?: string }[] = [];
  const api: FakeProjectStore = {
    released: 0,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    getProject: () => project,
    getBackend: () => (project ? ({
      kind: 'folder',
      writable: true,
      listLibrary: async () => library,
      readBlobUrl: async (relPath: string) => ({
        url: 'blob:' + relPath,
        release: () => { api.released++; },
      }),
    } as never) : null),
    set(p, lib) {
      project = p;
      library = lib;
      for (const l of listeners) l();
    },
  };
  return api;
}

/** Wait for the provider's async refresh to land. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('active project as a library source', () => {
  test('appears with kind "project" and lists its library entries', async () => {
    const store = fakeProjectStore();
    store.set({ id: 'prj_a', name: 'Customer A' }, [{ path: 'conveyor/belt.glb' }]);
    installProjectLibraryProvider(store);
    await settle();

    const sources = listLibrarySources();
    expect(sources).toHaveLength(1);
    expect(sources[0].providerId).toBe(PROJECT_LIBRARY_PROVIDER_ID);
    expect(sources[0].source.kind).toBe('project');
    expect(sources[0].source.id).toBe('prj_a');
    expect(sources[0].source.listEntries().map(e => e.name)).toEqual(['belt']);
    // The parent folder becomes a collection chip, exactly like a local folder.
    expect(sources[0].source.listEntries()[0].collections).toEqual(['conveyor']);
  });

  test('a project switch REPLACES the source instead of adding one', async () => {
    const store = fakeProjectStore();
    store.set({ id: 'prj_a', name: 'A' }, [{ path: 'a.glb' }]);
    installProjectLibraryProvider(store);
    await settle();
    expect(listLibrarySources().map(s => s.source.id)).toEqual(['prj_a']);

    store.set({ id: 'prj_b', name: 'B' }, [{ path: 'b.glb' }]);
    await settle();
    const sources = listLibrarySources();
    expect(sources).toHaveLength(1);
    expect(sources[0].source.id).toBe('prj_b');
    expect(sources[0].source.listEntries().map(e => e.name)).toEqual(['b']);
  });

  test('closing the project empties the provider', async () => {
    const store = fakeProjectStore();
    store.set({ id: 'prj_a', name: 'A' }, [{ path: 'a.glb' }]);
    installProjectLibraryProvider(store);
    await settle();
    store.set(null, []);
    await settle();
    expect(listLibrarySources()).toEqual([]);
  });

  test('resolveAsset hands out a volatile URL whose revokeUrl releases it', async () => {
    const store = fakeProjectStore();
    store.set({ id: 'prj_a', name: 'A' }, [{ path: 'conveyor/belt.glb' }]);
    installProjectLibraryProvider(store);
    await settle();

    const source = getLibrarySource(PROJECT_LIBRARY_PROVIDER_ID, 'prj_a')!;
    const resolved = await source.resolveAsset('project:conveyor/belt.glb', 'edit');
    expect(resolved.url).toBe('blob:conveyor/belt.glb');
    expect(store.released).toBe(0);
    resolved.revokeUrl?.();
    expect(store.released).toBe(1);
  });

  test('resolveAsset on an unknown asset throws (no silent empty document)', async () => {
    const store = fakeProjectStore();
    store.set({ id: 'prj_a', name: 'A' }, [{ path: 'a.glb' }]);
    installProjectLibraryProvider(store);
    await settle();
    const source = getLibrarySource(PROJECT_LIBRARY_PROVIDER_ID, 'prj_a')!;
    await expect(source.resolveAsset('project:nope.glb', 'edit')).rejects.toThrow();
  });

  test('a failing listing surfaces as an error, not a throw', async () => {
    const listeners = new Set<() => void>();
    const store: ProjectStoreLike = {
      subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
      getProject: () => ({ id: 'prj_x', name: 'X' }),
      getBackend: () => ({
        kind: 'folder',
        writable: true,
        listLibrary: async () => { throw new Error('disk gone'); },
        readBlobUrl: async () => null,
      } as never),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installProjectLibraryProvider(store);
    await settle();
    const source = getLibrarySource(PROJECT_LIBRARY_PROVIDER_ID, 'prj_x')!;
    expect(source.loaded).toBe(false);
    expect(source.error).toContain('disk gone');
    warn.mockRestore();
  });
});

// ─── Real backend, real folder shape (the DemoRealvirtual regression) ──────

describe('a real FolderBackend feeds the project library source', () => {
  test('lists the project library/ tree, not the manifest', async () => {
    const root = new FakeDir('demo-realvirtual');
    root.seedText('project.json', JSON.stringify({
      schemaVersion: 1, id: 'prj_sample', name: 'DemoRealvirtual',
    }));
    // Exactly the shipped layout: library/ NEXT TO models/, no library[] in
    // the manifest — which is what used to leave the Assets tab empty.
    const library = root.seedDir('library');
    library.seedText('catalog.json', '{}');
    const palletHandling = library.seedDir('PalletHandling');
    palletHandling.seedText('RollConveyor-1m.glb', 'GLB');
    palletHandling.seedText('Turntable.glb', 'GLB');
    root.seedDir('models').seedText('DemoRealvirtualWeb.glb', 'GLB');

    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    const store: ProjectStoreLike = {
      subscribe: () => () => {},
      getBackend: () => backend,
      getProject: () => ({ id: 'prj_sample', name: 'DemoRealvirtual' }),
    };
    installProjectLibraryProvider(store);
    // Real FS work, not a resolved promise: microtask draining is not enough,
    // this needs macrotasks. (Getting this wrong reads as "the provider is
    // broken" when it is merely not finished.)
    for (let i = 0; i < 100 && listLibrarySources().length === 0; i++) {
      await new Promise(r => setTimeout(r, 5));
    }

    const sources = listLibrarySources();
    expect(sources).toHaveLength(1);
    expect(sources[0].source.listEntries().map(e => e.name).sort())
      .toEqual(['RollConveyor 1m', 'Turntable']);
  });
});

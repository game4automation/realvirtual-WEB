// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * reference-resolver-pending-library — an asset id must not fall through to
 * the stored `path` while the catalog that knows the id is still loading.
 *
 * The finding (2026-10-25): the Projects dashboard composes the bundled demo's
 * planner scenes for their card previews right after the project switch, while
 * the demo's `libraries[]` catalog (then the bundled library `catalog.json`; since
 * plan-778 any URL catalog — the realvirtual library itself is a project) is still
 * being fetched. Every id missed, the resolver fell back to `path`
 * (`library/PalletHandling/…` relative to `/demo-realvirtual/DemoPlanner.glb`)
 * and the browser logged a 404 per placement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerLibrarySourceProvider,
  resetLibrarySourceRegistryForTests,
  whenLibrarySourcesSettled,
  type LibrarySource,
  type LibrarySourceProvider,
} from '../src/core/library/library-source-registry';
import { createReferenceResolver } from '../src/core/engine/rv-glb-reference-resolver';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';

const LIBRARY_URL = 'http://host/library/PalletHandling/Turntable.glb';
const STALE_PATH_URL = 'http://host/demo-realvirtual/library/PalletHandling/Turntable.glb';

/** A catalog source whose listing arrives when `finishLoading()` is called. */
function loadingCatalog(): { provider: LibrarySourceProvider; finishLoading(): void } {
  const listeners = new Set<() => void>();
  const entry: LibraryCatalogEntry = {
    id: 'pallethandling-turntable',
    name: 'Turntable',
    category: 'conveyor',
    glbUrl: LIBRARY_URL,
  };
  let loaded = false;
  const source: LibrarySource = {
    id: '/catalogs/partner/catalog.json',
    label: 'realvirtual Library',
    kind: 'url',
    writable: false,
    get loaded() { return loaded; },
    listEntries: () => (loaded ? [entry] : []),
    getEntry: (id) => (loaded && id === entry.id ? entry : null),
    resolveAsset: async () => ({ url: LIBRARY_URL }),
  };
  return {
    provider: {
      id: 'global',
      listSources: () => [source],
      subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    },
    finishLoading() {
      loaded = true;
      for (const l of listeners) l();
    },
  };
}

describe('reference resolver — catalog still loading', () => {
  const fetched: string[] = [];

  beforeEach(() => {
    fetched.length = 0;
    resetLibrarySourceRegistryForTests();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      fetched.push(url);
      if (url === LIBRARY_URL) return new Response(new Uint8Array([1, 2, 3, 4]));
      return new Response('not found', { status: 404 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetLibrarySourceRegistryForTests();
  });

  it('waits for the listing and resolves by id instead of fetching the stale path', async () => {
    const catalog = loadingCatalog();
    registerLibrarySourceProvider(catalog.provider);

    const pending = createReferenceResolver()(
      { assetId: 'pallethandling-turntable', path: 'library/PalletHandling/Turntable.glb' },
      { baseUrl: 'http://host/demo-realvirtual/DemoPlanner.glb', occurrence: 'root/0', depth: 0, resolvedPath: STALE_PATH_URL },
    );
    // Let the resolver reach its wait before the listing lands.
    await new Promise((r) => setTimeout(r, 10));
    catalog.finishLoading();

    const resolved = await pending;
    expect(resolved).not.toBeNull();
    expect(resolved!.url).toBe(LIBRARY_URL);
    expect(fetched).toEqual([LIBRARY_URL]);
  });

  it('settles at once when nothing is loading', async () => {
    const catalog = loadingCatalog();
    catalog.finishLoading();
    registerLibrarySourceProvider(catalog.provider);
    await expect(whenLibrarySourcesSettled(50)).resolves.toBeUndefined();
  });

  it('settles after the timeout when a catalog never finishes', async () => {
    registerLibrarySourceProvider(loadingCatalog().provider); // never finishes
    vi.useFakeTimers();
    try {
      const settled = whenLibrarySourcesSettled(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(settled).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

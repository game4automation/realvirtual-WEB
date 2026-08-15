// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-717 §9.3 — collections, all the way round.
 *
 * Setting collections used to be a write into `library/library.json` that
 * nothing read back: `resolveAssetMeta()` had zero production callers, so the
 * Collections editor was a form with no consumer. This file pins the loop it is
 * replaced by, one hop at a time:
 *
 *   editor → `setAssetCollections` → manifest ROW
 *          → `toCatalogEntry` (row ∪ folder chips)
 *          → chip row and filter in the Layout Planner library panel
 *
 * Plus one NEGATIVE pin. `LibraryCatalogEntry.collections` is also carried by
 * remote catalogs, and `normalizeCatalogEntry` is a different channel with a
 * different source of truth. Nothing here may reach it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  LIBRARY_FOLDER,
  setAssetCollections,
  type DocumentRowWriter,
} from '../src/core/library/library-asset-ops';
import {
  installProjectLibraryProvider,
  uninstallProjectLibraryProvider,
  PROJECT_LIBRARY_PROVIDER_ID,
  type ProjectStoreLike,
} from '../src/core/library/project-library-provider';
import {
  listLibrarySources,
  resetLibrarySourceRegistryForTests,
} from '../src/core/library/library-source-registry';
import { deriveChips, filterByChip } from '../src/core/library/library-chips';
import { normalizeCatalogEntry } from '../src/core/library/library-store';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

const BELT = `${LIBRARY_FOLDER}/conveyor/belt.glb`;
const ROLL = `${LIBRARY_FOLDER}/conveyor/roll.glb`;

function row(path: string, extra: Partial<RvDocumentEntry> = {}): RvDocumentEntry {
  const stem = (path.split('/').pop() ?? path).replace(/\.glb$/, '');
  return { id: `doc_${stem}`, path, name: stem, section: 'library', ...extra };
}

function project(documents: RvDocumentEntry[]): RvProject {
  return {
    schemaVersion: 3, id: 'prj_collections', name: 'Collections project', documents,
  } as unknown as RvProject;
}

/**
 * A store double that is BOTH halves of the loop: the row writer
 * `setAssetCollections` commits through, and the provider feed the catalog
 * reads. One object, so what the write produced is literally what the read
 * sees — a second fixture in the middle would let the two drift apart and the
 * test would still pass.
 */
class LoopStore implements DocumentRowWriter, ProjectStoreLike {
  private _listeners = new Set<() => void>();
  constructor(public manifest: RvProject) {}

  // ── DocumentRowWriter ──
  async applyManifestDelta(apply: (current: RvProject) => RvProject): Promise<RvProject | null> {
    this.manifest = apply(this.manifest);
    for (const l of this._listeners) l();
    return this.manifest;
  }

  // ── ProjectStoreLike ──
  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }
  getProject() { return { id: 'prj_collections', name: 'Collections project' }; }
  getBackend() {
    return {
      kind: 'folder',
      writable: true,
      listDocuments: async () => this.manifest.documents ?? [],
      listLibrary: async () => [],
      readBlobUrl: async (relPath: string) => ({ url: `blob:${relPath}`, release: () => {} }),
    } as never;
  }

  rowFor(path: string): RvDocumentEntry | undefined {
    return (this.manifest.documents ?? []).find(d => d.path === path);
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function catalogOf(store: LoopStore): Promise<LibraryCatalogEntry[]> {
  uninstallProjectLibraryProvider();
  resetLibrarySourceRegistryForTests();
  installProjectLibraryProvider(store);
  await settle();
  const source = listLibrarySources()
    .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source;
  expect(source).toBeDefined();
  return source!.listEntries();
}

afterEach(() => {
  uninstallProjectLibraryProvider();
  resetLibrarySourceRegistryForTests();
});

// ─── Hop 1: the editor's write lands on the row ─────────────────────────

describe('plan-717 F4 — the Collections editor writes the manifest row', () => {
  it('the value the dialog submits becomes the row value, cleaned', async () => {
    const store = new LoopStore(project([row(BELT)]));
    // Exactly what `submitAssetDialog` passes: the raw text, split on commas.
    const result = await setAssetCollections(store, 'conveyor/belt.glb', ' Favourites , Q3 line ,'.split(','));

    expect(result.kind).toBe('ok');
    expect(store.rowFor(BELT)?.collections).toEqual(['Favourites', 'Q3 line']);
  });

  it('the dialog re-opens on the ROW value, not on the catalog union', async () => {
    // The dashboard reads `documentByPath.get(...)?.collections` for the field's
    // initial value. Offering the union would invite the user to delete
    // "library/conveyor", a chip derived from where the file lives that would
    // come straight back on the next render.
    const store = new LoopStore(project([row(BELT)]));
    await setAssetCollections(store, 'conveyor/belt.glb', ['Favourites']);

    const rowValue = (store.rowFor(BELT)?.collections ?? []).join(', ');
    expect(rowValue).toBe('Favourites');

    const [entry] = await catalogOf(store);
    expect(entry.collections).toContain('library/conveyor');   // shown…
    expect(rowValue).not.toContain('library/conveyor');        // …but not offered for editing
  });
});

// ─── Hop 2: the catalog reads it ────────────────────────────────────────

describe('plan-717 F5/§2.6 — the catalog is the row ∪ the folder chips', () => {
  it('a written collection appears on the entry, before the place chips', async () => {
    const store = new LoopStore(project([row(BELT)]));
    await setAssetCollections(store, 'conveyor/belt.glb', ['Favourites']);

    const [entry] = await catalogOf(store);
    expect(entry.collections).toEqual(['Favourites', 'library', 'library/conveyor']);
  });

  it('clearing the collections leaves the place chips standing', async () => {
    const store = new LoopStore(project([row(BELT, { collections: ['Favourites'] })]));
    await setAssetCollections(store, 'conveyor/belt.glb', []);

    const [entry] = await catalogOf(store);
    expect(entry.collections).toEqual(['library', 'library/conveyor']);
  });
});

// ─── Hop 3: the panel's chip row and filter ─────────────────────────────

describe('plan-717 F5 — the Layout Planner filter matches row collections', () => {
  it('a user collection becomes a chip with its count and filters to its entries', async () => {
    const store = new LoopStore(project([
      row(BELT, { collections: ['Favourites'] }),
      row(ROLL),
    ]));
    const entries = await catalogOf(store);

    // `deriveChips`/`filterByChip` are the panel's whole filtering surface —
    // unchanged by this plan, which is the point: it needed real data, not new
    // code.
    const chips = deriveChips(entries);
    expect(chips.find(c => c.key === 'Favourites')).toMatchObject({ label: 'Favourites', count: 1 });
    expect(chips.find(c => c.key === 'library')).toMatchObject({ count: 2 });

    expect(filterByChip(entries, 'Favourites').map(e => e.localPath)).toEqual([BELT]);
    expect(filterByChip(entries, 'library/conveyor').map(e => e.localPath)).toEqual([BELT, ROLL]);
    expect(filterByChip(entries, null)).toHaveLength(2);
  });

  it('the round trip end to end: set, list, filter', async () => {
    const store = new LoopStore(project([row(BELT), row(ROLL)]));
    await setAssetCollections(store, 'conveyor/roll.glb', ['Rollers']);

    const entries = await catalogOf(store);
    expect(filterByChip(entries, 'Rollers').map(e => e.localPath)).toEqual([ROLL]);
  });
});

// ─── Negative pin: the remote catalog channel is untouched ──────────────

describe('plan-717 §2.6 — the remote catalog `collections` is a DIFFERENT channel', () => {
  it('normalizeCatalogEntry still passes the catalog author\'s value through verbatim', () => {
    const entry = normalizeCatalogEntry(
      { glbUrl: 'parts/Roll2m.glb', collections: ['Vendor set'] },
      'https://example.test/library/',
    );
    // No folder chips, no row lookup, no union: a remote catalog states its own
    // collections and this plan does not touch that.
    expect(entry.collections).toEqual(['Vendor set']);
  });

  it('an entry without collections stays without them — no derivation creeps in', () => {
    const entry = normalizeCatalogEntry(
      { glbUrl: 'conveyor/rollers/Roll2m.glb' },
      'https://example.test/library/',
    );
    expect(entry.collections).toBeUndefined();
  });
});

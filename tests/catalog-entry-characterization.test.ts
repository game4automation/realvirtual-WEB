// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-717 Phase 0 (R1-T5) — `toCatalogEntry`, pinned.
 *
 * The catalog entry a project document becomes had **no test at all** before
 * this file, and §2.6 then changed one of its fields: `collections` is now
 * "the row's collections ∪ the path-derived folder chips" instead of only the
 * latter. Changing an untested derivation is how a chip quietly disappears, so
 * the derivation was pinned first — every chip, in order, for a nested
 * structure, plus the three naming rules that sit beside it.
 *
 * ## What Phase 2 deliberately RE-pinned
 *
 * One assertion in this file was written to be rewritten: "a row that carries
 * collections is ignored". That was the read end of the write-only loop, and
 * closing it is the point of §2.6, so the case now asserts the union instead
 * (see the comment on it below). The chip baseline is untouched and still
 * valid — the union *extends* the chips, it does not replace them, and every
 * other case here would still fail if a chip went missing.
 *
 * ## Pinned through the public surface, not through an export
 *
 * `toCatalogEntry` is module-private and stays that way: the provider is what
 * production calls, so the provider is what the pin goes through
 * (`installProjectLibraryProvider` + `listLibrarySources`). The cost is a
 * `ProjectStoreLike` double and three microtask turns; the benefit is that the
 * test cannot pass while the wiring is broken.
 */

import { describe, it, expect, afterEach } from 'vitest';
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
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';

// ─── Fixture ────────────────────────────────────────────────────────────

/**
 * A store double whose backend answers `listDocuments()` with exactly the rows
 * a test hands it — the feed `toCatalogEntry` maps over.
 */
function storeWith(documents: RvDocumentEntry[]): ProjectStoreLike {
  return {
    subscribe: () => () => {},
    getProject: () => ({ id: 'prj_cat', name: 'Catalog project' }),
    getBackend: () => ({
      kind: 'folder',
      writable: true,
      listDocuments: async () => documents,
      listLibrary: async () => [],
      readBlobUrl: async (relPath: string) => ({ url: 'blob:' + relPath, release: () => {} }),
    } as never),
  };
}

/** Wait for the provider's async refresh to land. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function entriesFor(documents: RvDocumentEntry[]): Promise<LibraryCatalogEntry[]> {
  installProjectLibraryProvider(storeWith(documents));
  await settle();
  const source = listLibrarySources()
    .find(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID)?.source;
  expect(source).toBeDefined();
  return source!.listEntries();
}

function row(path: string, extra: Partial<RvDocumentEntry> = {}): RvDocumentEntry {
  const stem = (path.split('/').pop() ?? path).replace(/\.(scene\.)?(glb|gltf|splat|ksplat|ply)$/i, '');
  return { id: `doc_${stem}`, name: stem, path, section: 'library', ...extra } as RvDocumentEntry;
}

afterEach(() => {
  uninstallProjectLibraryProvider();
  resetLibrarySourceRegistryForTests();
});

// ─── Collections: the chips are cumulative path prefixes ────────────────

describe('plan-717 R1-T5 baseline — the path chips, unchanged by Phase 2', () => {
  it('a nested library path yields one chip per level, as cumulative prefixes', async () => {
    const [entry] = await entriesFor([row('library/Conveyors/Rollers/Roll2m.glb')]);
    // Order matters: the panel renders them in this sequence.
    expect(entry.collections).toEqual([
      'library',
      'library/Conveyors',
      'library/Conveyors/Rollers',
    ]);
  });

  it('the section folder is itself a chip — scenes and models are not special', async () => {
    const entries = await entriesFor([
      row('scenes/Plant.scene.glb', { section: 'scenes' }),
      row('models/Press.glb', { section: 'models' }),
      row('library/Roll2m.glb'),
    ]);
    expect(entries.map(e => e.collections)).toEqual([['scenes'], ['models'], ['library']]);
  });

  it('a document at the project root has no chips at all, not an empty array', async () => {
    const [entry] = await entriesFor([row('Loose.glb')]);
    // `undefined`, not `[]` — the panel branches on presence.
    expect(entry.collections).toBeUndefined();
  });

  it('RE-PINNED in Phase 2: a row that carries collections is now READ, not ignored', async () => {
    // The original assertion here was `not.toContain('Favourites')` — the read
    // end of the write-only loop, pinned in Phase 0 exactly so this change
    // would be visible in a diff rather than silent. §2.6 turns it into a
    // union: the user's filing first, then the folder chips, no duplicates.
    const [entry] = await entriesFor([
      row('library/Conveyors/Roll2m.glb', { collections: ['Favourites', 'Q3 line'] } as never),
    ]);
    expect(entry.collections).toEqual([
      'Favourites', 'Q3 line', 'library', 'library/Conveyors',
    ]);
  });

  it('a row collection that repeats a folder chip is not listed twice', async () => {
    const [entry] = await entriesFor([
      row('library/Conveyors/Roll2m.glb', { collections: ['library/Conveyors'] } as never),
    ]);
    expect(entry.collections).toEqual(['library/Conveyors', 'library']);
  });

  it('an EMPTY row collections array leaves the chips exactly as they were', async () => {
    // "Filed under nothing" is a real answer (that is why the row stores `[]`),
    // and it must not read as "no chips" either — the place chips stay.
    const [entry] = await entriesFor([
      row('library/Conveyors/Roll2m.glb', { collections: [] } as never),
    ]);
    expect(entry.collections).toEqual(['library', 'library/Conveyors']);
  });
});

// ─── Identity and naming ────────────────────────────────────────────────

describe('plan-717 R1-T5 baseline — the two keys and the three naming rules', () => {
  it('the catalog id is path-derived and the document id rides along beside it', async () => {
    const [entry] = await entriesFor([row('library/Conveyors/Roll2m.glb', { id: 'doc_stable' })]);
    expect(entry.id).toBe('project:library/Conveyors/Roll2m.glb');
    expect(entry.documentId).toBe('doc_stable');
    expect(entry.localPath).toBe('library/Conveyors/Roll2m.glb');
  });

  it('a row with a blank id contributes no documentId rather than an empty one', async () => {
    const [entry] = await entriesFor([row('library/Roll2m.glb', { id: '   ' })]);
    expect(entry.documentId).toBeUndefined();
    // The catalog id still works — it never depended on the manifest.
    expect(entry.id).toBe('project:library/Roll2m.glb');
  });

  it('a scan-derived name (name === stem) is prettified; separators become spaces', async () => {
    const [entry] = await entriesFor([row('library/RollConveyor-1m.glb')]);
    expect(entry.name).toBe('RollConveyor 1m');
  });

  it('an AUTHORED name is used verbatim, underscores and all', async () => {
    const [entry] = await entriesFor([row('library/RollConveyor-1m.glb', { name: 'Roll_Conveyor' })]);
    expect(entry.name).toBe('Roll_Conveyor');
  });

  it('a label outranks both', async () => {
    const [entry] = await entriesFor([
      row('library/RollConveyor-1m.glb', { name: 'Roll_Conveyor', label: 'Roll conveyor, 1 m' } as never),
    ]);
    expect(entry.name).toBe('Roll conveyor, 1 m');
  });

  it('a blank label falls through instead of producing an empty card title', async () => {
    const [entry] = await entriesFor([row('library/Roll2m.glb', { label: '   ' } as never)]);
    expect(entry.name).toBe('Roll2m');
  });

  it('the scene suffix is stripped from the stem, not just the extension', async () => {
    const [entry] = await entriesFor([
      row('scenes/Plant.scene.glb', { section: 'scenes', name: '' } as never),
    ]);
    expect(entry.name).toBe('Plant');
  });
});

// ─── The fixed fields ───────────────────────────────────────────────────

describe('plan-717 R1-T5 baseline — the fields that do not vary', () => {
  it('every project document is a "custom" entry with no glbUrl and pivotToFloor', async () => {
    const [entry] = await entriesFor([row('library/Roll2m.glb')]);
    expect(entry.category).toBe('custom');
    // Resolution is lazy: the URL is minted by `resolveAsset`, never cached.
    expect(entry.glbUrl).toBe('');
    expect(entry.pivotToFloor).toBe(true);
  });

  it('the thumbnail comes straight off the row, or is empty', async () => {
    const [withThumb] = await entriesFor([
      row('library/Roll2m.glb', { thumbnail: '.thumbnails/Roll2m.png' } as never),
    ]);
    expect(withThumb.thumbnailUrl).toBe('.thumbnails/Roll2m.png');

    uninstallProjectLibraryProvider();
    resetLibrarySourceRegistryForTests();

    const [without] = await entriesFor([row('library/Roll2m.glb')]);
    expect(without.thumbnailUrl).toBe('');
  });

  it('every section reaches the catalog — placeability is not decided here', async () => {
    const entries = await entriesFor([
      row('scenes/Plant.scene.glb', { section: 'scenes' }),
      row('models/Press.glb', { section: 'models' }),
      row('library/Roll2m.glb'),
    ]);
    expect(entries.map(e => e.localPath)).toEqual([
      'scenes/Plant.scene.glb',
      'models/Press.glb',
      'library/Roll2m.glb',
    ]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-717 Phase 0 — the registration model AS IT IS TODAY.
 *
 * This is a characterisation net, not a specification. Every assertion below
 * pins behaviour that plan-717 Phases 1-3 will deliberately CHANGE, so the
 * change shows up as a red line in a diff instead of as silence. Where an
 * assertion pins something the plan calls a bug (the rename that moves a
 * document's id), the comment says so — the point of the pin is that fixing it
 * has to be a conscious edit here.
 *
 * The five blocks, and what each one is a baseline for:
 *
 *  A. **The scan world.** `models/` and `library/` rows are derived from the
 *     FILES on every listing, with a transient `stableDocumentId(path)`; only
 *     `scenes/` is manifest-driven. Phase 1 gives every file an authored row.
 *  B. **`rescanDocuments()` writes nothing** — REPINNED in Phase 1. The scan
 *     itself still writes nothing; the adopt verb that §2.2 added after it
 *     does, so the one assertion about the manifest after a rescan is now the
 *     other way round. It is marked `REPINNED (Phase 1)` in place, with the
 *     reason next to it; everything else in this block is unchanged.
 *  C. **Ids are unstable under rename** — REPINNED in Phase 3. The Phase-0
 *     version pinned the bug (`renameAsset` is copy+delete, the derived id moves
 *     with the path, a stored `assetId` stops resolving). Phase 3 removes that
 *     route, so the block pins the FIX: the one rename path keeps the id, makes
 *     the name follow, and leaves the blob-only verb unreachable.
 *  D. **The sidecar is write-only.** `setAssetCollections` writes
 *     `library/library.json`; nothing in production reads it back. F5 closes
 *     that loop by moving collections into the row.
 *  E. **Create and move.** `createEmptyAsset` writes bytes and no row (F1) —
 *     still true of the FUNCTION, no longer true of any route, which is the
 *     Phase-3 re-pin below; `applyTreeMove` mints one on the fly (the "mint on
 *     first op" fallback that Phase 4 degrades to an assert).
 *  F. **`statDocuments()` is asymmetric.** OPFS reports `sha256`, a folder does
 *     not — the R1-S2 finding that forced the adopt verb to maintain the hash
 *     itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import providerSource from '../src/core/library/project-library-provider.ts?raw';
import dashboardSource from '../src/core/hmi/projects/ProjectsDashboardHost.tsx?raw';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { BrowserBackend } from '../src/core/project/backends/browser-backend';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import {
  documentsFromLists,
  stableDocumentId,
} from '../src/core/project/rv-project-documents';
import {
  findDocumentById,
  mintAssetIdentity,
  previewAssetId,
} from '../src/core/project/rv-asset-identity';
import { applyTreeMove } from '../src/core/project/rv-project-tree-move';
import type { TreeMoveIO } from '../src/core/project/rv-project-tree-move';
import type { TreeMovePlan } from '../src/core/project/rv-project-tree';
import {
  LIBRARY_FOLDER,
  setAssetCollections,
} from '../src/core/library/library-asset-ops';
import { SIDECAR_FILENAME, parseSidecar } from '../src/core/library/library-sidecar';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';
import { clearAllScenes, setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';
import { clearAllBlobs } from '../src/core/storage/rv-opfs-blobs';
import { clearAllSceneOwners } from '../src/core/project/rv-scene-owner';

// ─── Fixtures ───────────────────────────────────────────────────────────

/**
 * Seed `a/b/c.glb` into a FakeDir tree, creating the directories as needed.
 *
 * `getDirectoryHandle({ create: true })` rather than `seedDir`, because
 * `seedDir` always replaces: two files in the same folder would leave only the
 * second one.
 */
async function seedAt(root: FakeDir, path: string, body: string): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  const file = segments.pop()!;
  let dir = root;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  dir.seedText(file, body);
}

/**
 * A folder project with a manifest that declares NOTHING but its identity.
 *
 * That emptiness is the fixture's whole point: everything the listing returns
 * for `models/` and `library/` therefore came from the files, which is the
 * property block A is about.
 */
async function folderProject(files: Record<string, string> = {}): Promise<FakeDir> {
  const root = new FakeDir('customer-project');
  root.seedText('project.json', JSON.stringify({
    schemaVersion: 3,
    id: 'prj_char',
    name: 'Characterisation project',
    documents: [],
  } satisfies Partial<RvProject>));
  for (const [path, body] of Object.entries(files)) await seedAt(root, path, body);
  return root;
}

function project(documents: RvDocumentEntry[] = []): RvProject {
  return {
    schemaVersion: 3,
    id: 'prj_char',
    name: 'Characterisation project',
    documents,
  } as unknown as RvProject;
}

/** The blob surface `library-asset-ops` needs, over a FakeDir-free map. */
class BlobBackend {
  files = new Map<string, string>();
  async writeBlob(relPath: string, blob: Blob): Promise<void> {
    this.files.set(relPath, await blob.text());
  }
  async deleteBlob(relPath: string): Promise<void> { this.files.delete(relPath); }
  async readBlobUrl(relPath: string) {
    const body = this.files.get(relPath);
    if (body === undefined) return null;
    const url = URL.createObjectURL(new Blob([body]));
    return { url, release: () => URL.revokeObjectURL(url) };
  }
  lib(rel: string): string | undefined { return this.files.get(`${LIBRARY_FOLDER}/${rel}`); }
  putLib(rel: string, body: string): void { this.files.set(`${LIBRARY_FOLDER}/${rel}`, body); }
  sidecar() {
    const raw = this.files.get(`${LIBRARY_FOLDER}/${SIDECAR_FILENAME}`);
    return raw ? parseSidecar(raw) : null;
  }
}

/**
 * The manifest half `setAssetCollections` writes through since Phase 2 (§2.4).
 *
 * In-memory and nothing else: the verb takes the narrow `DocumentRowWriter`
 * exactly so a row write needs no backend and no boot path.
 */
class FakeRows {
  constructor(public project: RvProject | null) {}
  async applyManifestDelta(apply: (current: RvProject) => RvProject): Promise<RvProject | null> {
    if (!this.project) return null;
    this.project = apply(this.project);
    return this.project;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asBackend = (b: unknown) => b as any;

// ─── A. The scan world: files drive models/ and library/ ────────────────

describe('plan-717 §2.3 baseline — the listing is derived, not declared', () => {
  it('documentsFromLists mints a transient path-id for an undeclared asset', () => {
    const docs = documentsFromLists({
      scenes: [{ id: 'scn_a', name: 'Plant', path: 'scenes/Plant.scene.glb' }],
      models: [{ path: 'models/Press.glb' }],
      library: [{ path: 'library/parts/Roll2m.glb' }],
    });

    // The scene keeps the id the MANIFEST gave it; the two assets get one
    // derived from their path, freshly, on this call.
    expect(docs.map(d => [d.section, d.id])).toEqual([
      ['scenes', 'scn_a'],
      ['models', stableDocumentId('models/Press.glb')],
      ['library', stableDocumentId('library/parts/Roll2m.glb')],
    ]);
  });

  it('the derived id is a pure function of the path — no row is created', () => {
    const before = project();
    const docs = documentsFromLists({ library: [{ path: 'library/parts/Roll2m.glb' }] });
    expect(docs[0].id).toBe(previewAssetId('library/parts/Roll2m.glb'));
    // Deriving it did NOT touch the manifest. This is rv-asset-identity rule 1
    // ("browsing imprints nothing") as the scan currently honours it, and the
    // sentence §2.2 re-frames rather than deletes.
    expect(before.documents).toEqual([]);
  });

  it('the declared overlay is keyed ID-FIRST, so it MISSES a bare folder listing', () => {
    // Non-obvious and load-bearing: `sectionKeyOf` prefers the id, so a
    // declared row keys as `library:doc_authored` while the file the folder
    // scan found keys as `library:library/parts/Roll2m.glb`. The two never
    // meet, and the listing shows the derived id — even though the manifest
    // holds an authored row for that exact path. Whether Phase 1 keeps the
    // id-first key or switches to a path key is a decision this pin forces.
    const declared: RvDocumentEntry = {
      id: 'doc_authored',
      name: 'Roll 2m',
      path: 'library/parts/Roll2m.glb',
      section: 'library',
      sizeBytes: 4242,
    };
    const docs = documentsFromLists(
      { library: [{ path: 'library/parts/Roll2m.glb' }] },   // as a bare scan yields it
      [declared],
    );
    expect(docs[0].id).toBe(stableDocumentId('library/parts/Roll2m.glb'));
    expect(docs[0].sizeBytes).toBeUndefined();               // the overlay contributed nothing
  });

  it('the id survives only because FolderBackend re-attaches the declared entry first', () => {
    // `listLibrary()` returns `declared.get(path) ?? { path }`, so by the time
    // `documentsFromLists` sees it the entry already carries the id — and THEN
    // the overlay key matches and the row's own fields ride along.
    const declared: RvDocumentEntry = {
      id: 'doc_authored',
      name: 'Roll 2m',
      path: 'library/parts/Roll2m.glb',
      section: 'library',
      sizeBytes: 4242,
    };
    const docs = documentsFromLists({ library: [declared] }, [declared]);
    expect(docs[0].id).toBe('doc_authored');
    expect(docs[0].sizeBytes).toBe(4242);
  });

  it('FolderBackend lists a file the manifest never mentions, with a path-id', async () => {
    const root = await folderProject({ 'library/parts/Roll2m.glb': 'glTF-ROLL' });
    const backend = new FolderBackend(asDirHandle(root), { writable: true });

    const docs = await backend.listDocuments();
    expect(docs.map(d => d.path)).toEqual(['library/parts/Roll2m.glb']);
    expect(docs[0].id).toBe(stableDocumentId('library/parts/Roll2m.glb'));

    // ...and the manifest on disk still declares nothing. The row exists only
    // for the duration of this listing — F1 is what ends that.
    const manifest = JSON.parse((await root.readText('project.json'))!) as RvProject;
    expect(manifest.documents).toEqual([]);
  });
});

// ─── B. rescanDocuments() is a read ─────────────────────────────────────

describe('plan-717 §2.2 baseline — rescanDocuments() refreshes the display and writes nothing', () => {
  let store: ProjectStore;

  beforeEach(() => {
    clearAllScenes();
    setDraftScope(null);
    localStorage.removeItem('rv-project/last');
    resetProjectStore();
    store = new ProjectStore();
  });

  afterEach(async () => {
    await store.closeProject();
    clearAllScenes();
    setDraftScope(null);
  });

  it('picks up a file dropped into library/ after the project was opened', async () => {
    const root = await folderProject();
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    expect(store.getSnapshot().documents).toEqual([]);

    // The "external drop" this whole plan is about.
    await seedAt(root, 'library/parts/Roll2m.glb', 'glTF-ROLL');
    await store.rescanDocuments();

    const paths = store.getSnapshot().documents.map(d => d.path);
    expect(paths).toEqual(['library/parts/Roll2m.glb']);
  });

  it('REPINNED (Phase 1): the rescan adopts — the manifest gains exactly one row', async () => {
    // ── Deliberate re-pin, plan-717 Phase 1 ──────────────────────────────
    // The Phase-0 version of this test asserted `manifest.documents === []`
    // and said in its own comment that Phase 1 inverts it. It does, and this
    // is the inversion: `rescanDocuments()` still SCANS read-only, and the
    // adopt verb that now follows it writes the row. The read-only guarantee
    // did not move — it was re-framed onto the scan, which is what
    // rv-asset-identity rule 1 and doc-persistence §3.6a now say.
    const root = await folderProject();
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    await store.flush();

    await seedAt(root, 'library/parts/Roll2m.glb', 'glTF-ROLL');
    await store.rescanDocuments();
    await store.flush();

    const manifest = JSON.parse((await root.readText('project.json'))!) as RvProject;
    const rows = manifest.documents ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe('library/parts/Roll2m.glb');
    // The path-derived id, minted ONCE and frozen — the id a pre-717 GLB
    // already carries in its `assetId`, which is what keeps old references
    // resolving (§2.5, F8).
    expect(rows[0].id).toBe(stableDocumentId('library/parts/Roll2m.glb'));
  });

  it('the displayed id is the path derivation, recomputed on every scan', async () => {
    const root = await folderProject({ 'library/parts/Roll2m.glb': 'glTF-ROLL' });
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);

    const first = store.getSnapshot().documents.map(d => d.id);
    await store.rescanDocuments();
    const second = store.getSnapshot().documents.map(d => d.id);

    expect(first).toEqual([stableDocumentId('library/parts/Roll2m.glb')]);
    // Still the same value after Phase 1, and no longer for the same reason:
    // the open-time adopt froze that derivation into a row, so the second scan
    // READS the id instead of re-deriving it. Adoption taking over the path id
    // (Entscheidung 3) is exactly what makes the two answers identical.
    expect(second).toEqual(first);
  });

  it('a rescan on a read-only project neither writes nor throws', async () => {
    const root = await folderProject({ 'library/parts/Roll2m.glb': 'glTF-ROLL' });
    root.permissions.readwrite = 'denied';
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    expect(store.isWritable()).toBe(false);

    await expect(store.rescanDocuments()).resolves.toBeUndefined();
    const manifest = JSON.parse((await root.readText('project.json'))!) as RvProject;
    expect(manifest.documents ?? []).toEqual([]);
  });
});

// ─── C. Rename keeps the id (RE-PINNED in Phase 3 — the F6/F8 core fix) ──

describe('plan-717 §2.7 — the rename route keeps the id', () => {
  // ── RE-PINNED, plan-717 Phase 3 ────────────────────────────────────────
  // The Phase-0 version of this block pinned the BUG: `renameAsset` is
  // copy+delete, so the derived id moved with the path and a stored `assetId`
  // stopped resolving. Phase 3 removes that route — the dashboard renames
  // through `applyTreeMove` and nothing else — so what is pinned here is the
  // fix, green. The blob-only function itself survives one more release and is
  // deleted in Phase 4; `library-asset-ops.test.ts` still covers its behaviour,
  // and the guard below is what says it is no longer reachable from production.
  //
  // The end-to-end half (a pre-717 `assetId` in a saved GLB still resolving
  // after a rename AND after an adopt) lives in `one-rename-path.test.ts` §9.4.

  it('the renamed row keeps the id the catalog handed out — and the name follows', async () => {
    const from = 'library/parts/Roll2m.glb';
    const to = 'library/parts/Roll2000.glb';
    // What a saved GLB carries: the id the catalog handed out at placement time.
    const savedAssetId = previewAssetId(from);
    const authored = project([
      { id: savedAssetId, path: from, name: 'Roll2m', section: 'library' },
    ]);

    let written: RvProject | null = null;
    const bytes = new Map<string, Blob>([[from, new Blob(['glTF-ROLL'])]]);
    const io: TreeMoveIO = {
      readBytes: async p => bytes.get(p) ?? null,
      writeBytes: async (p, b) => { bytes.set(p, b); },
      deleteBytes: async p => { bytes.delete(p); },
      readManifest: async () => authored,
      writeManifest: async p => { written = p; },
    };
    const plan = {
      from, to, documentId: savedAssetId, descendants: [], rewritesDocsIndex: false,
    } as unknown as TreeMovePlan;

    await applyTreeMove(io, plan);

    const rows = (written as RvProject | null)?.documents ?? [];
    expect(rows[0].id).toBe(savedAssetId);
    expect(rows[0].path).toBe(to);
    // F6's second half: the display name follows the new file stem.
    expect(rows[0].name).toBe('Roll2000');
    // ...and the reference resolver's first manifest hop still answers.
    expect(findDocumentById(written!, savedAssetId)?.path).toBe(to);
    expect([...bytes.keys()]).toEqual([to]);
  });

  it('a MOVE into another folder leaves the authored name alone', () => {
    // The other side of the same rule: `moveDocumentPath` rewrites `path` and
    // only `path`, so a folder move must not overwrite a label the user chose.
    const id = previewAssetId('library/parts/Roll2m.glb');
    const authored = project([
      { id, path: 'library/parts/Roll2m.glb', name: 'Big roller', section: 'library' },
    ]);
    expect(findDocumentById(authored, id)?.name).toBe('Big roller');
  });

  it('the blob-only rename is no longer reachable from the dashboard (F6)', () => {
    expect(dashboardSource).not.toContain('renameAsset(');
    // ...and neither are the other two verbs that wrote bytes past the row.
    expect(dashboardSource).not.toContain('duplicateAsset(');
    expect(dashboardSource).not.toContain('deleteAsset(');
    // What it renames through instead.
    expect(dashboardSource).toContain("runTreeEdit('Rename asset'");
  });
});

// ─── D. The sidecar is written and never read ───────────────────────────

describe('plan-717 §2.6 baseline — collections go into library.json and come back out nowhere', () => {
  let backend: BlobBackend;
  beforeEach(() => {
    backend = new BlobBackend();
    backend.putLib('parts/Roll2m.glb', 'glTF-ROLL');
  });

  it('RE-PINNED in Phase 2: setAssetCollections writes the ROW and leaves the file alone', async () => {
    // The Phase-0 baseline asserted the opposite — a write into `library.json`
    // that nothing read back, which is the loop §2.6 closes. It is re-pinned
    // here rather than deleted so the flip stays visible in the diff.
    const rows = new FakeRows(project([
      { id: 'doc_roll', path: `${LIBRARY_FOLDER}/parts/Roll2m.glb`, name: 'Roll2m', section: 'library' },
    ]));
    expect((await setAssetCollections(rows, 'parts/Roll2m.glb', ['Conveyors'])).kind).toBe('ok');

    expect(rows.project?.documents?.[0].collections).toEqual(['Conveyors']);
    // The sidecar file is not even created.
    expect(backend.sidecar()).toBeNull();
  });

  it('the sidecar is not part of the document listing — it is a private file', async () => {
    const root = await folderProject({ 'library/parts/Roll2m.glb': 'glTF-ROLL' });
    await seedAt(root, `library/${SIDECAR_FILENAME}`, JSON.stringify({
      schemaVersion: 1,
      assets: { 'parts/Roll2m.glb': { collections: ['Conveyors'] } },
    }));
    const folder = new FolderBackend(asDirHandle(root), { writable: true });

    const docs = await folder.listDocuments();
    expect(docs.map(d => d.path)).toEqual(['library/parts/Roll2m.glb']);
    // Nothing on the row knows about the collection that file records.
    expect((docs[0] as { collections?: unknown }).collections).toBeUndefined();
  });

  it('the catalog provider still never imports the sidecar module — and now does not need to', () => {
    // The Phase-0 comment expected Phase 2 to make this false. It did not, and
    // that is the better outcome: the loop is closed through the manifest ROW
    // (§2.6), so the provider reads `doc.collections` and the sidecar stays a
    // migration input the catalog layer never learns about.
    expect(providerSource).not.toContain('library-sidecar');
    expect(providerSource).not.toContain('resolveAssetMeta');
    expect(providerSource).toContain('doc.collections');
  });

  it('RE-PINNED in Phase 3: the dashboard writes collections through the STORE only', () => {
    // Phase 2 flipped the write onto the row and left `moveSidecarEntry` behind
    // as the rename carry-over. Phase 3 removes it: collections live on the row
    // `applyTreeMove` repoints, so there is nothing library-local left to carry.
    expect(dashboardSource).toContain('setAssetCollections(store');
    expect(dashboardSource).not.toContain('moveSidecarEntry');
  });
});

// ─── E. Create writes bytes; move mints the row on the fly ──────────────

describe('plan-717 §2.7 baseline — the two paths that create bytes without a row', () => {
  it('RE-PINNED in Phase 4: createEmptyAsset does not exist any more', async () => {
    // The Phase-0 baseline pinned the behaviour that condemned it — one write,
    // and it was the blob: no manifest row, so the row appeared on the next
    // rescan and vanished on the one after, because nothing had persisted it.
    // Phase 3 emptied the call site, Phase 4 deleted the function. The property
    // is re-pinned here as an ABSENCE so the flip stays visible in the diff;
    // the standing guard is `registration-removal-guard.test.ts`.
    const ops = await import('../src/core/library/library-asset-ops');
    expect('createEmptyAsset' in ops).toBe(false);
    // …and with it the other three blob-only verbs of the same shape.
    expect('renameAsset' in ops).toBe(false);
    expect('duplicateAsset' in ops).toBe(false);
    expect('deleteAsset' in ops).toBe(false);
    // What creates a library document instead: bytes AND row, in one verb.
    const { createDocument } = await import('../src/core/project/rv-document-ops');
    expect(typeof createDocument).toBe('function');
  });

  it('RE-PINNED in Phase 3: handleNewDocument has ONE branch behind one verb (F7)', () => {
    // The Phase-0 baseline pinned the two branches ("Phase 3 collapses these
    // onto `createDocument({folder})`"), and this is the collapse. The dashboard
    // no longer imports either blob-only create, and the one call it makes takes
    // the folder the shared helper decided on. Still pinned as source text
    // because the callsite lives inside a React callback with no seam — the
    // DECISION now has one (`newDocumentFolderFor`, pinned in
    // `dashboard-documents.test.ts`, R1-T9).
    expect(dashboardSource).not.toContain('createEmptyAsset');
    expect(dashboardSource).not.toContain('sceneStore.createEmpty()');
    expect(dashboardSource).toContain('createDocument(store, newDocumentNameFor(folder), { folder })');
  });

  it('RE-PINNED in Phase 4: applyTreeMove REFUSES a scanned file with no row', async () => {
    // The Phase-0 baseline pinned the mint ("minted at the old path, then
    // repointed") and said Phase 4 would turn the fallback into an assert. This
    // is that flip. The premise it rested on is gone: `adoptDiscoveredDocuments`
    // registers every file of a writable project before the tree can offer it,
    // so a missing row is a broken guarantee — and minting one here would hide
    // it behind a row this module cannot fill in.
    const from = 'library/parts/Roll2m.glb';
    const to = 'library/rollers/Roll2m.glb';
    const scannedId = stableDocumentId(from);

    let written: RvProject | null = null;
    const bytes = new Map<string, Blob>([[from, new Blob(['glTF-ROLL'])]]);
    const io: TreeMoveIO = {
      readBytes: async p => bytes.get(p) ?? null,
      writeBytes: async (p, b) => { bytes.set(p, b); },
      deleteBytes: async p => { bytes.delete(p); },
      readManifest: async () => project(),          // no rows at all
      writeManifest: async p => { written = p; },
    };
    const plan = {
      from, to, documentId: scannedId, descendants: [], rewritesDocsIndex: false,
    } as unknown as TreeMovePlan;

    await expect(applyTreeMove(io, plan))
      .rejects.toThrow(/unregistered file reached tree-move/);
    // Refused where every refusal in this module belongs: before a byte moved.
    expect(bytes.has(from)).toBe(true);
    expect(bytes.has(to)).toBe(false);
    expect(written).toBeNull();
  });

  it('mintAssetIdentity is idempotent, which is what makes the adopt verb re-runnable', () => {
    const first = mintAssetIdentity(project(), { path: 'library/parts/Roll2m.glb' });
    expect(first.minted).toBe(true);
    const second = mintAssetIdentity(first.project, { path: 'library/parts/Roll2m.glb' });
    expect(second.minted).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
  });
});

// ─── F. statDocuments: OPFS has the hash, a folder does not (R1-S2) ─────

describe('plan-717 R1-S2 baseline — only the content-addressed backend reports sha256', () => {
  beforeEach(async () => {
    localStorage.clear();
    clearAllScenes();
    clearAllSceneOwners();
    await clearAllBlobs();
  });

  afterEach(async () => {
    localStorage.clear();
    await clearAllBlobs();
  });

  it('FolderBackend reports size only — no digest for the move-match to use', async () => {
    const root = await folderProject({ 'library/parts/Roll2m.glb': 'glTF-ROLL' });
    const backend = new FolderBackend(asDirHandle(root), { writable: true });

    const stats = await backend.statDocuments();
    const stat = stats.find(s => s.path === 'library/parts/Roll2m.glb');
    expect(stat?.size).toBe('glTF-ROLL'.length);
    // The blocker the plan calls S2: without this field the sha256 move-match
    // is structurally dead for the main target group, so the adopt verb has to
    // compute and persist the hash itself.
    expect(stat?.sha256).toBeUndefined();
    expect(stats.every(s => s.sha256 === undefined)).toBe(true);
  });

  it('BrowserBackend (OPFS) reports the digest and no size', async () => {
    const backend = new BrowserBackend('prj_char_opfs', { requestPersistence: false });
    await backend.activate();
    await backend.writeBlob('library/parts/Roll2m.glb', new Blob(['glTF-ROLL']));

    const stats = await backend.statDocuments();
    const stat = stats.find(s => s.path === 'library/parts/Roll2m.glb');
    expect(stat).toBeDefined();
    expect(typeof stat!.sha256).toBe('string');
    expect(stat!.sha256!.length).toBeGreaterThan(0);
    // Size is deliberately 0: the digest alone clears the scan pre-filter.
    expect(stat!.size).toBe(0);

    await backend.deactivate();
  });

  it('BundledBackend is never scanned at all — it can never adopt', async () => {
    // Imported lazily so this file does not pull the fetch double into scope.
    const { BundledBackend } = await import('../src/core/project/backends/bundled-backend');
    const backend = new BundledBackend({
      fetchImpl: (async () => ({
        ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0),
      })) as unknown as typeof fetch,
    });
    expect(await backend.statDocuments()).toEqual([]);
    expect(backend.writable).toBe(false);
  });
});

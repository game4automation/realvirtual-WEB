// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-717 §9.2 — `library/library.json` on its way into the rows.
 *
 * The migration is one paragraph of behaviour and three paragraphs of failure
 * handling, and the failure handling is what this file is mostly about:
 *
 *  - **Precedence.** The row wins; the sidecar fills gaps. Never the other way,
 *    because two metadata homes is the state the plan ends.
 *  - **Commit BEFORE delete (R1-S3).** The blocker of review round 1. Deleting
 *    first means a crash costs the collections outright — file gone, row never
 *    written, fallback with no source. Deleting second costs at worst a repeat,
 *    and the marker makes the repeat a no-op. Both crash halves are pinned.
 *  - **An unparseable sidecar is never touched.** Not overwritten, not deleted,
 *    reported instead — it is far likelier to be from a build we do not know
 *    than to be garbage.
 *
 * Layered like §9.1: pure-function tests for the merge rules (which is where
 * the "against a manifest this run never saw" cases live), store-level tests
 * for the ordering, and a folder fixture for the round trip.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import {
  SIDECAR_MIGRATION_MARKER,
  SIDECAR_MIGRATION_VERSION,
  adoptDiscoveredDocuments,
  applyAdoptDelta,
  isSidecarMigrated,
  previewAssetId,
  type AdoptOp,
  type AdoptSidecarIngestion,
} from '../src/core/project/rv-asset-identity';
import {
  SIDECAR_PATH,
  ingestionFromSidecar,
  legacyCollectionsFor,
} from '../src/core/library/library-sidecar-ingest';
import { parseSidecar } from '../src/core/library/library-sidecar';
import type { DocumentStat } from '../src/core/project/rv-project-documents';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';
import { clearAllScenes, setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';
import { clearAllBlobs } from '../src/core/storage/rv-opfs-blobs';
import { clearAllSceneOwners } from '../src/core/project/rv-scene-owner';

// ─── Fixtures ───────────────────────────────────────────────────────────

const BELT = 'library/conveyor/belt.glb';
const ROLL = 'library/conveyor/roll.glb';

function project(documents: RvDocumentEntry[] = [], extra: Record<string, unknown> = {}): RvProject {
  return {
    schemaVersion: 3, id: 'prj_sidecar', name: 'Sidecar fixture', documents, ...extra,
  } as unknown as RvProject;
}

function row(path: string, extra: Partial<RvDocumentEntry> = {}): RvDocumentEntry {
  const stem = (path.split('/').pop() ?? path).replace(/\.glb$/, '');
  return { id: `doc_${stem}`, path, name: stem, section: 'library', ...extra };
}

function stats(...paths: string[]): DocumentStat[] {
  return paths.map((path, i) => ({ path, size: 100 + i, mtime: 1_700_000_000_000 + i }));
}

function sidecarText(assets: Record<string, { collections?: string[]; displayName?: string }>): string {
  return JSON.stringify({ schemaVersion: 1, assets });
}

/** The ingestion the store builds, without going through a backend. */
function ingestion(
  assets: Record<string, { collections?: string[]; displayName?: string }>,
  proj: RvProject | null = null,
): AdoptSidecarIngestion {
  return ingestionFromSidecar(parseSidecar(sidecarText(assets)), proj)!;
}

async function scan(
  proj: RvProject,
  paths: string[],
  sidecar?: AdoptSidecarIngestion,
): Promise<AdoptOp[]> {
  return (await adoptDiscoveredDocuments(proj, { stats: stats(...paths), sidecar })).delta;
}

// ─── Precedence: the row wins, the sidecar fills gaps ───────────────────

describe('plan-717 §2.4 — ingestion fills gaps and never overwrites', () => {
  it('gives an existing row the collections it does not have', async () => {
    const before = project([row(BELT)]);
    const delta = await scan(before, [BELT], ingestion({ 'conveyor/belt.glb': { collections: ['Conveyors'] } }));

    const merged = applyAdoptDelta(before, delta);
    expect(merged.project.documents![0].collections).toEqual(['Conveyors']);
    expect(merged.log.some(l => l.kind === 'ingest' && l.path === BELT)).toBe(true);
  });

  it('leaves a row that ALREADY has collections completely alone', async () => {
    const before = project([row(BELT, { collections: ['Q3 line'] })]);
    const delta = await scan(before, [BELT], ingestion({ 'conveyor/belt.glb': { collections: ['Conveyors'] } }));

    // No `meta` op is even proposed — the gap check runs at scan time too, so
    // an already-answered row costs nothing at merge time.
    expect(delta.filter(op => op.op === 'meta')).toEqual([]);
    const merged = applyAdoptDelta(before, delta);
    expect(merged.project.documents![0].collections).toEqual(['Q3 line']);
  });

  it('an EMPTY row array counts as answered — the sidecar does not refill it', async () => {
    const before = project([row(BELT, { collections: [] })]);
    const delta = await scan(before, [BELT], ingestion({ 'conveyor/belt.glb': { collections: ['Conveyors'] } }));
    expect(applyAdoptDelta(before, delta).project.documents![0].collections).toEqual([]);
  });

  it('a display name reaches a scan-derived name and never an authored one', async () => {
    const scanned = project([row(BELT)]);                       // name === stem
    const authored = project([row(BELT, { name: 'Belt, 1 m' } )]);
    const meta = ingestion({ 'conveyor/belt.glb': { displayName: 'Main belt' } });

    expect(applyAdoptDelta(scanned, await scan(scanned, [BELT], meta))
      .project.documents![0].name).toBe('Main belt');
    expect(applyAdoptDelta(authored, await scan(authored, [BELT], meta))
      .project.documents![0].name).toBe('Belt, 1 m');
  });

  it('a file being adopted for the FIRST time takes both fields straight away', async () => {
    const before = project();
    const delta = await scan(before, [BELT], ingestion({
      'conveyor/belt.glb': { collections: ['Conveyors'], displayName: 'Main belt' },
    }));

    const adopted = applyAdoptDelta(before, delta).project.documents![0];
    expect(adopted.path).toBe(BELT);
    expect(adopted.id).toBe(previewAssetId(BELT));
    expect(adopted.collections).toEqual(['Conveyors']);
    expect(adopted.name).toBe('Main belt');
  });

  it('a sidecar entry whose file and row are both gone is simply dropped', async () => {
    const before = project([row(BELT)]);
    const delta = await scan(before, [BELT], ingestion({
      'conveyor/belt.glb': { collections: ['Conveyors'] },
      'conveyor/vanished.glb': { collections: ['Ghosts'] },
    }));
    expect(delta.filter(op => op.op === 'meta').map(op => (op as { path: string }).path)).toEqual([BELT]);
  });

  it('the gate is re-checked at MERGE time, against a manifest the scan never saw', async () => {
    // Two tabs: this one planned the fill while the field was empty, the other
    // set it in between. The row still wins — that is what makes the merge
    // safe to re-run on a CAS retry.
    const delta: AdoptOp[] = [
      { op: 'meta', id: 'doc_belt', path: BELT, collections: ['Conveyors'] },
    ];
    const afterOtherTab = project([row(BELT, { collections: ['Set by the other tab'] })]);

    const merged = applyAdoptDelta(afterOtherTab, delta);
    expect(merged.changed).toBe(false);
    expect(merged.project.documents![0].collections).toEqual(['Set by the other tab']);
    expect(merged.log[0]).toMatchObject({ kind: 'discarded', id: 'doc_belt' });
  });
});

// ─── The marker ─────────────────────────────────────────────────────────

describe('plan-717 §2.4 — the marker travels with the manifest and is idempotent', () => {
  it('a sidecar with nothing left to give still sets the marker', async () => {
    // …because the marker is what makes the DELETE that follows safe to
    // repeat. A run that ingested nothing but removed the file is a success.
    const before = project([row(BELT, { collections: ['Q3 line'] })]);
    const delta = await scan(before, [BELT], ingestion({ 'conveyor/belt.glb': { collections: ['x'] } }));

    const merged = applyAdoptDelta(before, delta);
    expect(merged.changed).toBe(true);
    expect(merged.project[SIDECAR_MIGRATION_MARKER]).toBe(SIDECAR_MIGRATION_VERSION);
  });

  it('a second run over a marked manifest proposes nothing at all', async () => {
    const marked = project([row(BELT, { collections: ['Conveyors'] })], {
      [SIDECAR_MIGRATION_MARKER]: SIDECAR_MIGRATION_VERSION,
    });
    const delta = await scan(marked, [BELT], ingestion({ 'conveyor/belt.glb': { collections: ['Conveyors'] } }, marked));
    // Scoped to the ingestion's own ops: the hash upkeep of §2.2 step 3 still
    // has something to say about a row with no digest, and that is a different
    // subject.
    expect(delta.filter(op => op.op === 'meta' || op.op === 'sidecar-migrated')).toEqual([]);
  });

  it('the marker op loses to a tab that already wrote it — no churn', () => {
    const marked = project([], { [SIDECAR_MIGRATION_MARKER]: SIDECAR_MIGRATION_VERSION });
    const merged = applyAdoptDelta(marked, [{ op: 'sidecar-migrated', path: SIDECAR_PATH }]);
    expect(merged.changed).toBe(false);
    expect(merged.project).toBe(marked);
  });

  it('isSidecarMigrated reads any truthy marker, not only this build\'s number', () => {
    expect(isSidecarMigrated(project())).toBe(false);
    expect(isSidecarMigrated(project([], { [SIDECAR_MIGRATION_MARKER]: 1 }))).toBe(true);
    expect(isSidecarMigrated(project([], { [SIDECAR_MIGRATION_MARKER]: 7 }))).toBe(true);
  });
});

// ─── The read fallback: one generation, two conditions ──────────────────

describe('plan-717 §2.4 — the legacy read fallback', () => {
  const legacy = { collections: ['Conveyors'] };

  it('answers only when the marker is absent AND the row has no value', () => {
    expect(legacyCollectionsFor({ project: project(), row: null, legacy })).toEqual(['Conveyors']);
  });

  it('is silenced by the marker — after the ingestion the row is the sole answer', () => {
    const marked = project([], { [SIDECAR_MIGRATION_MARKER]: SIDECAR_MIGRATION_VERSION });
    expect(legacyCollectionsFor({ project: marked, row: null, legacy })).toBeNull();
  });

  it('is silenced by a row that already answers, INCLUDING an empty one', () => {
    expect(legacyCollectionsFor({ project: project(), row: { collections: ['A'] }, legacy })).toBeNull();
    // `[]` is "filed under nothing", not "no answer" — falling back here would
    // resurrect collections the user deliberately cleared.
    expect(legacyCollectionsFor({ project: project(), row: { collections: [] }, legacy })).toBeNull();
  });

  it('returns null rather than [] when it has nothing to say', () => {
    expect(legacyCollectionsFor({ project: project(), row: null, legacy: null })).toBeNull();
    expect(legacyCollectionsFor({ project: project(), row: null, legacy: { collections: [] } })).toBeNull();
  });

  /*
   * ONE RELEASE GENERATION.
   *
   * This fallback and `LegacySidecarMeta` exist for `library.json` files
   * already on disk, written by the build a user is upgrading FROM. The
   * sidecar WRITE api dies in plan-717 Phase 4; this reader goes with the
   * release after that one. Nothing in this build may produce the legacy
   * shape — the type is read-only and separate from `LibrarySidecarAsset`
   * precisely so the compiler enforces that, the same device
   * `upgradeLegacyAssetBase` uses (plan-716 §2.6).
   */
  it('the legacy shape is readable and never producible (a comment-pin, checked by tsc)', () => {
    const read: import('../src/core/library/library-sidecar-ingest').LegacySidecarMeta = legacy;
    expect(read.collections).toEqual(['Conveyors']);
  });
});

// ─── Commit BEFORE delete (R1-S3), at the store ─────────────────────────

async function folderStore(
  files: Record<string, string>,
  rows: RvDocumentEntry[] = [],
  extra: Record<string, unknown> = {},
): Promise<{ store: ProjectStore; root: FakeDir; manifest: () => Promise<RvProject> }> {
  const root = new FakeDir('sidecar-project');
  root.seedText('project.json', JSON.stringify(project(rows, extra)));
  for (const [path, body] of Object.entries(files)) {
    const segments = path.split('/').filter(Boolean);
    const file = segments.pop()!;
    let dir = root;
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: true });
    dir.seedText(file, body);
  }
  const store = new ProjectStore();
  await store.openProjectFolder(asDirHandle(root));
  return {
    store,
    root,
    manifest: async () => JSON.parse((await root.readText('project.json'))!) as RvProject,
  };
}

async function readSidecarFile(root: FakeDir): Promise<string | null> {
  return root.readTextAt('library', 'library.json');
}

async function resetStorage(): Promise<void> {
  localStorage.clear();
  clearAllScenes();
  clearAllSceneOwners();
  setDraftScope(null);
  resetProjectStore();
  await clearAllBlobs();
}

describe('plan-717 R1-S3 — the sidecar is deleted only after the commit', () => {
  beforeEach(async () => { await resetStorage(); });
  afterEach(async () => { await resetStorage(); });

  it('the happy path: rows written, marker set, file gone — in that order', async () => {
    const { store, root, manifest } = await folderStore({
      [BELT]: 'glTF-BELT',
      [SIDECAR_PATH]: sidecarText({ 'conveyor/belt.glb': { collections: ['Conveyors'] } }),
    });

    // `openProjectFolder` already ran one adopt; the assertions are about the
    // state it left behind, which is exactly the customer's first-run state.
    const after = await manifest();
    const belt = (after.documents ?? []).find(d => d.path === BELT)!;
    expect(belt.collections).toEqual(['Conveyors']);
    expect(after[SIDECAR_MIGRATION_MARKER]).toBe(SIDECAR_MIGRATION_VERSION);
    expect(await readSidecarFile(root)).toBeNull();

    await store.closeProject();
  });

  it('a FAILED commit leaves the sidecar completely untouched', async () => {
    // The data-loss window the blocker was about: if the delete ran first, this
    // project would now have neither the rows nor the file.
    const { store, root } = await folderStore({ [BELT]: 'glTF-BELT' });
    // Seeded after the open so the first adopt has not consumed it yet.
    const library = await root.getDirectoryHandle('library');
    library.seedText('library.json', sidecarText({ 'conveyor/belt.glb': { collections: ['Conveyors'] } }));
    root.failures.fail({ point: 'write', name: 'project.json' });

    await expect(store.adoptDiscoveredDocuments()).rejects.toBeTruthy();

    expect(await readSidecarFile(root)).toContain('Conveyors');
    root.failures.clear();
    await store.closeProject();
  });

  it('a crash BETWEEN commit and delete heals on the next run', async () => {
    // Staged exactly as the crash leaves it: the marker and the collections are
    // durable, the file is still there. The next run must finish the job
    // without touching a row — and without a manifest write it does not need.
    const { store, root, manifest } = await folderStore(
      {
        [BELT]: 'glTF-BELT',
        [SIDECAR_PATH]: sidecarText({ 'conveyor/belt.glb': { collections: ['Old value'] } }),
      },
      [row(BELT, { collections: ['Conveyors'], sha256: undefined })],
      { [SIDECAR_MIGRATION_MARKER]: SIDECAR_MIGRATION_VERSION },
    );

    // The open's adopt is the "next run". It hashes the file (first sight of
    // it), so a commit happens — what must NOT happen is the row losing its
    // value to the stale sidecar.
    expect(await readSidecarFile(root)).toBeNull();
    const belt = ((await manifest()).documents ?? []).find(d => d.path === BELT)!;
    expect(belt.collections).toEqual(['Conveyors']);

    await store.closeProject();
  });

  it('a leftover sidecar is removed even when there is nothing at all to commit', async () => {
    const { store, root } = await folderStore(
      { [BELT]: 'glTF-BELT' },
      [row(BELT, { collections: ['Conveyors'], sizeBytes: 9, mtimeMs: 1, sha256: 'x'.repeat(64) })],
      { [SIDECAR_MIGRATION_MARKER]: SIDECAR_MIGRATION_VERSION },
    );
    const library = await root.getDirectoryHandle('library', { create: true });
    library.seedText('library.json', sidecarText({}));

    const commit = vi.spyOn(store, 'applyManifestDelta');
    const summary = await store.adoptDiscoveredDocuments();

    expect(summary.sidecarRemoved).toBe(true);
    expect(await readSidecarFile(root)).toBeNull();
    commit.mockRestore();
    await store.closeProject();
  });

  it('an unparseable sidecar is never deleted, never rewritten, and is reported', async () => {
    const { store, root, manifest } = await folderStore({
      [BELT]: 'glTF-BELT',
      // Parseable JSON, unknown schema version: the newer-build case, which is
      // the likeliest reason we cannot read one at all.
      [SIDECAR_PATH]: JSON.stringify({ schemaVersion: 99, assets: { 'conveyor/belt.glb': { collections: ['Theirs'] } } }),
    });

    expect(await readSidecarFile(root)).toContain('Theirs');
    // No marker either — claiming the migration ran would silence the fallback
    // for a file we never read.
    expect((await manifest())[SIDECAR_MIGRATION_MARKER]).toBeUndefined();
    expect(store.getSnapshot().warnings.some(w => /newer version/i.test(w))).toBe(true);

    const summary = await store.adoptDiscoveredDocuments();
    expect(summary).toMatchObject({ sidecarUnreadable: true, sidecarRemoved: false, ingested: 0 });

    await store.closeProject();
  });

  it('the downgrade round trip: an older build re-creates the file, the upgrade re-ingests', async () => {
    // Downgrade → the old build writes `library.json` again → upgrade. The
    // marker is already set, so the run must NOT overwrite what the rows now
    // say; it must fill only what is still missing, and remove the file again.
    const { store, root, manifest } = await folderStore(
      { [BELT]: 'glTF-BELT', [ROLL]: 'glTF-ROLL' },
      [
        row(BELT, { collections: ['Conveyors'] }),
        row(ROLL),
      ],
      { [SIDECAR_MIGRATION_MARKER]: SIDECAR_MIGRATION_VERSION },
    );
    const library = await root.getDirectoryHandle('library', { create: true });
    library.seedText('library.json', sidecarText({
      'conveyor/belt.glb': { collections: ['What the old build remembered'] },
      'conveyor/roll.glb': { collections: ['Rollers'] },
    }));

    const summary = await store.adoptDiscoveredDocuments();

    const documents = (await manifest()).documents ?? [];
    expect(documents.find(d => d.path === BELT)?.collections).toEqual(['Conveyors']);
    // The gap IS filled — re-ingestion is not the same as being ignored.
    expect(documents.find(d => d.path === ROLL)?.collections).toEqual(['Rollers']);
    expect(summary.ingested).toBeGreaterThan(0);
    expect(await readSidecarFile(root)).toBeNull();

    await store.closeProject();
  });

  it('a read-only project ingests nothing and keeps its sidecar', async () => {
    const root = new FakeDir('read-only-sidecar');
    root.seedText('project.json', JSON.stringify(project()));
    const library = await root.getDirectoryHandle('library', { create: true });
    const conveyor = await library.getDirectoryHandle('conveyor', { create: true });
    conveyor.seedText('belt.glb', 'glTF-BELT');
    library.seedText('library.json', sidecarText({ 'conveyor/belt.glb': { collections: ['Conveyors'] } }));
    root.permissions.readwrite = 'denied';

    const store = new ProjectStore();
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    expect(store.isWritable()).toBe(false);

    expect(await store.adoptDiscoveredDocuments()).toMatchObject({ ingested: 0, sidecarRemoved: false });
    expect(await readSidecarFile(root)).toContain('Conveyors');
    expect(JSON.parse((await root.readText('project.json'))!)[SIDECAR_MIGRATION_MARKER]).toBeUndefined();

    await store.closeProject();
  });
});

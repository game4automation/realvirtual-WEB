// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-717 §9.1 — the adopt verb.
 *
 * The scan reads; this verb writes. Everything below is about the second half
 * of that sentence: which files become rows, which rows survive a file that
 * moved, which rows are dropped and when, and — the part that took two review
 * rounds — what happens when two tabs do it at once.
 *
 * Three layers, deliberately:
 *
 *  - **`describe.each` over both writable backends** for the contract. The two
 *    have genuinely different merge semantics (a folder listing is a scan with
 *    the manifest as an overlay, a browser listing IS the manifest), so a
 *    contract that only held for one of them would be worth very little.
 *  - **Pure-function tests for the merge invariants** (`applyAdoptDelta`). They
 *    are about a manifest the scanning tab never saw, which is exactly what a
 *    fixture cannot stage.
 *  - **Store-level tests for the ordering guarantees** — durable-first,
 *    single-flight, the contained failure — because those are properties of the
 *    wiring, not of the algorithm.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { BrowserBackend } from '../src/core/project/backends/browser-backend';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { previewAssetId } from '../src/core/project/rv-asset-identity';
import {
  ADOPT_QUARANTINE_MS,
  adoptDiscoveredDocuments,
  applyAdoptDelta,
  isAdoptablePath,
  type AdoptLogEntry,
  type AdoptOp,
} from '../src/core/project/rv-asset-identity';
import { SIDECAR_PATH } from '../src/core/library/library-sidecar-ingest';
import { stableDocumentId } from '../src/core/project/rv-project-documents';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';
import { clearAllScenes, setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';
import { clearAllBlobs } from '../src/core/storage/rv-opfs-blobs';
import { clearAllSceneOwners } from '../src/core/project/rv-scene-owner';

// ─── Fixtures ───────────────────────────────────────────────────────────

const ROLL = 'library/parts/Roll2m.glb';
const BELT = 'library/parts/Belt1m.glb';
const PRESS = 'models/Press.glb';

async function seedAt(root: FakeDir, path: string, body: string): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  const file = segments.pop()!;
  let dir = root;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: true });
  dir.seedText(file, body);
}

async function dropAt(root: FakeDir, path: string): Promise<void> {
  const segments = path.split('/').filter(Boolean);
  const file = segments.pop()!;
  let dir = root;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
  await dir.removeEntry(file);
}

function manifestText(documents: RvDocumentEntry[] = []): string {
  return JSON.stringify({
    schemaVersion: 3,
    id: 'prj_adopt',
    name: 'Adopt fixture',
    documents,
  });
}

function project(documents: RvDocumentEntry[] = []): RvProject {
  return {
    schemaVersion: 3, id: 'prj_adopt', name: 'Adopt fixture', documents,
  } as unknown as RvProject;
}

/** The uniform surface the contract tests drive, over either writable backend. */
interface AdoptFixture {
  readonly kind: 'folder' | 'browser';
  readonly store: ProjectStore;
  backend(): ProjectBackend;
  seed(path: string, body: string): Promise<void>;
  drop(path: string): Promise<void>;
  /** The rows as they are DURABLY stored — never the in-memory copy. */
  storedRows(): Promise<RvDocumentEntry[]>;
  /** What the backend's own listing answers, after the adopt. */
  listed(): Promise<RvDocumentEntry[]>;
  dispose(): Promise<void>;
}

interface StorePrivates { _backend: ProjectBackend | null; _project: RvProject | null }

async function folderFixture(
  files: Record<string, string> = {},
  opts: { writable?: boolean; rows?: RvDocumentEntry[] } = {},
): Promise<AdoptFixture> {
  const root = new FakeDir('adopt-project');
  root.seedText('project.json', manifestText(opts.rows ?? []));
  if (opts.writable === false) root.permissions.readwrite = 'denied';

  const store = new ProjectStore();
  await store.openProjectFolder(asDirHandle(root));
  // Seeded AFTER the open on purpose: opening now adopts, and a test that
  // wants to observe the adopt has to be the one that triggers it. This is
  // also the shape of the case the plan is about — a file appearing in a
  // project that is already open.
  for (const [path, body] of Object.entries(files)) await seedAt(root, path, body);
  return {
    kind: 'folder',
    store,
    backend: () => store.getBackend()!,
    seed: (path, body) => seedAt(root, path, body),
    drop: path => dropAt(root, path),
    async storedRows() {
      const raw = await root.readText('project.json');
      return ((JSON.parse(raw!) as RvProject).documents ?? []) as RvDocumentEntry[];
    },
    listed: () => store.getBackend()!.listDocuments(),
    async dispose() { await store.closeProject(); },
  };
}

let browserSeq = 0;

async function browserFixture(
  files: Record<string, string> = {},
  opts: { rows?: RvDocumentEntry[] } = {},
): Promise<AdoptFixture> {
  const id = `prj_adopt_opfs_${browserSeq++}`;
  const backend = new BrowserBackend(id, { requestPersistence: false });
  await backend.activate();
  const manifest = { ...project(opts.rows ?? []), id } as RvProject;
  await backend.writeManifest(manifest);
  for (const [path, body] of Object.entries(files)) {
    await backend.writeBlob(path, new Blob([body]));
  }

  // The same injection seam `fake-document-project` uses: a browser project is
  // adopted through the boot path, and dragging OPFS discovery, the migration
  // and the conflict prompt into a test about one verb would buy nothing.
  const store = new ProjectStore();
  const privates = store as unknown as StorePrivates;
  privates._backend = backend;
  privates._project = manifest;

  return {
    kind: 'browser',
    store,
    backend: () => backend,
    async seed(path, body) { await backend.writeBlob(path, new Blob([body])); },
    async drop(path) { await backend.deleteBlob(path); },
    async storedRows() {
      return ((await backend.readManifest())?.documents ?? []) as RvDocumentEntry[];
    },
    listed: () => backend.listDocuments(),
    async dispose() { await backend.deactivate(); },
  };
}

const BACKENDS: Array<[string, (
  files?: Record<string, string>,
  opts?: { rows?: RvDocumentEntry[] },
) => Promise<AdoptFixture>]> = [
  ['folder', (files, opts) => folderFixture(files, opts)],
  ['browser', (files, opts) => browserFixture(files, opts)],
];

/**
 * The paths a `readBlobBytes` spy saw, minus the sidecar probe.
 *
 * `library/library.json` is read once per run since Phase 2 (§2.4). It is not
 * a document and it does not scale with the library, so the hash-budget
 * assertions below are about everything except it.
 */
function documentReads(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .map(c => String(c[0]))
    .filter(path => path !== SIDECAR_PATH);
}

async function resetStorage(): Promise<void> {
  localStorage.clear();
  clearAllScenes();
  clearAllSceneOwners();
  setDraftScope(null);
  resetProjectStore();
  await clearAllBlobs();
}

// ─── The contract, over both writable backends ──────────────────────────

describe.each(BACKENDS)('adoptDiscoveredDocuments — %s backend', (kind, makeFixture) => {
  let fx: AdoptFixture;

  beforeEach(async () => { await resetStorage(); });
  afterEach(async () => { await fx?.dispose(); await resetStorage(); });

  it('gives every unregistered file a row with the path-derived id', async () => {
    fx = await makeFixture({ [ROLL]: 'glTF-ROLL', [BELT]: 'glTF-BELT', [PRESS]: 'glTF-PRESS' });
    const log: AdoptLogEntry[] = [];
    fx.store.setAdoptOptions({ log: e => log.push(e) });

    const summary = await fx.store.adoptDiscoveredDocuments();
    expect(summary.adopted).toBe(3);

    const rows = await fx.storedRows();
    expect(rows.map(r => r.path).sort()).toEqual([BELT, ROLL, PRESS].sort());
    for (const row of rows) expect(row.id).toBe(previewAssetId(row.path));
    expect(rows.find(r => r.path === PRESS)?.section).toBe('models');
    expect(rows.find(r => r.path === ROLL)?.section).toBe('library');
    // Auditable, not silent — one line per adoption (Zotero-Negativpraezedenz).
    expect(log.filter(l => l.kind === 'adopt').map(l => l.path).sort())
      .toEqual([BELT, ROLL, PRESS].sort());
  });

  it('commits ONCE per run, and the second run does not commit at all', async () => {
    fx = await makeFixture({ [ROLL]: 'glTF-ROLL', [BELT]: 'glTF-BELT' });
    const commit = vi.spyOn(fx.store, 'applyManifestDelta');

    await fx.store.adoptDiscoveredDocuments();
    expect(commit).toHaveBeenCalledTimes(1);

    // Idempotence is the whole no-op guard (R1-I1): nothing changed, so nothing
    // is written — a customer's project.json stays byte-identical forever after.
    commit.mockClear();
    const second = await fx.store.adoptDiscoveredDocuments();
    expect(commit).not.toHaveBeenCalled();
    expect(second).toMatchObject({ adopted: 0, moved: 0, removed: 0 });
    commit.mockRestore();
  });

  it('the listing shows the ROW id and the row fields once adopted', async () => {
    // The overlay trap: `documentsFromLists` keys its overlay id-first, so a
    // written row does NOT by itself make a listing id-true. It becomes true
    // because the folder backend re-attaches the row BY PATH before the overlay
    // runs — and the browser backend lists the manifest directly. Both halves
    // are asserted here because both are load-bearing.
    fx = await makeFixture({ [ROLL]: 'glTF-ROLL' });
    await fx.store.adoptDiscoveredDocuments();

    const rowId = (await fx.storedRows())[0].id;
    const listed = await fx.listed();
    expect(listed.map(d => d.id)).toContain(rowId);
    const row = listed.find(d => d.id === rowId)!;
    expect(row.path).toBe(ROLL);
    expect(typeof row.sha256).toBe('string');

    // …and the store's own snapshot, which is what the dashboard renders.
    await fx.store.rescanDocuments();
    const shown = fx.store.getSnapshot().documents.find(d => d.path === ROLL);
    expect(shown?.id).toBe(rowId);
    expect(shown?.sha256).toBe(row.sha256);
  });

  it('moves the row when the file moved: same id, same collections, new path', async () => {
    fx = await makeFixture({ [ROLL]: 'glTF-ROLL' });
    await fx.store.adoptDiscoveredDocuments();
    const before = (await fx.storedRows())[0];

    // Collections ride on the row now — surviving an external rename is the
    // point of the whole plan.
    await fx.store.applyManifestDelta(current => ({
      ...current,
      documents: (current.documents ?? []).map(
        d => d.id === before.id ? { ...d, collections: ['Conveyors'] } : d),
    }));

    await fx.drop(ROLL);
    await fx.seed('library/rollers/Roll2000.glb', 'glTF-ROLL');   // same bytes
    const log: AdoptLogEntry[] = [];
    fx.store.setAdoptOptions({ log: e => log.push(e) });
    const summary = await fx.store.adoptDiscoveredDocuments();

    expect(summary).toMatchObject({ moved: 1, adopted: 0 });
    const rows = await fx.storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].path).toBe('library/rollers/Roll2000.glb');
    expect(rows[0].collections).toEqual(['Conveyors']);
    expect(log.find(l => l.kind === 'move')?.from).toBe(ROLL);
  });

  it('a COPY gets its own id — the old position is still occupied', async () => {
    fx = await makeFixture({ [ROLL]: 'glTF-ROLL' });
    await fx.store.adoptDiscoveredDocuments();
    const before = (await fx.storedRows())[0];

    await fx.seed('library/parts/Roll2m copy.glb', 'glTF-ROLL');   // identical bytes
    const summary = await fx.store.adoptDiscoveredDocuments();

    expect(summary).toMatchObject({ adopted: 1, moved: 0 });
    const rows = await fx.storedRows();
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.path === ROLL)?.id).toBe(before.id);
    expect(rows.find(r => r.path === 'library/parts/Roll2m copy.glb')?.id)
      .toBe(previewAssetId('library/parts/Roll2m copy.glb'));
  });

  it('a row with no sha256 cannot mis-match — the newcomer is adopted instead', async () => {
    // R1-T2: the pre-717 manifest has no digests at all, so this is the state
    // of every customer project on the first run after the upgrade.
    const legacy: RvDocumentEntry = {
      id: 'doc_legacy', path: ROLL, name: 'Roll 2m', section: 'library',
    };
    fx = await makeFixture({ 'library/rollers/Roll2000.glb': 'glTF-ROLL' }, { rows: [legacy] });

    const summary = await fx.store.adoptDiscoveredDocuments();
    expect(summary).toMatchObject({ adopted: 1, moved: 0, quarantined: 1 });

    const rows = await fx.storedRows();
    expect(rows.find(r => r.id === 'doc_legacy')?.path).toBe(ROLL);      // untouched
    expect(rows.find(r => r.path === 'library/rollers/Roll2000.glb')?.id)
      .toBe(previewAssetId('library/rollers/Roll2000.glb'));
  });

  it('quarantines a missing row, and removes it only after the window', async () => {
    // BELT stays throughout: an EMPTY scan result is "the scan learnt nothing"
    // and is never evidence that a file is gone (pinned separately below).
    fx = await makeFixture({ [ROLL]: 'glTF-ROLL', [BELT]: 'glTF-BELT' });
    let now = Date.parse('2026-08-13T10:00:00.000Z');
    const log: AdoptLogEntry[] = [];
    fx.store.setAdoptOptions({ now: () => now, log: e => log.push(e) });
    await fx.store.adoptDiscoveredDocuments();
    const id = (await fx.storedRows()).find(r => r.path === ROLL)!.id;
    await fx.store.applyManifestDelta(current => ({
      ...current,
      documents: (current.documents ?? []).map(
        d => d.id === id ? { ...d, collections: ['Conveyors'] } : d),
    }));

    // Run 1: the file is gone. Marked, never removed — a half-copied folder or
    // a lagging cloud sync must not cost the user their row.
    await fx.drop(ROLL);
    expect(await fx.store.adoptDiscoveredDocuments()).toMatchObject({ quarantined: 1, removed: 0 });
    const marked = (await fx.storedRows()).find(r => r.path === ROLL)!;
    expect(marked.missingSince).toBe(new Date(now).toISOString());

    // Run 2, one minute later: still inside the window, still nothing removed.
    // The save cascade fires a rescan every few seconds, so a pure two-run rule
    // would have collapsed here (R2-F4).
    now += 60_000;
    expect(await fx.store.adoptDiscoveredDocuments()).toMatchObject({ removed: 0 });
    expect(await fx.storedRows()).toHaveLength(2);

    // Run 3, past the window.
    now += ADOPT_QUARANTINE_MS;
    expect(await fx.store.adoptDiscoveredDocuments()).toMatchObject({ removed: 1 });
    expect((await fx.storedRows()).map(r => r.path)).toEqual([BELT]);
    expect(log.find(l => l.kind === 'remove')?.path).toBe(ROLL);
  });

  it('an empty scan result never quarantines — it is not evidence of anything', async () => {
    fx = await makeFixture({ [ROLL]: 'glTF-ROLL' });
    await fx.store.adoptDiscoveredDocuments();

    await fx.drop(ROLL);   // the project's LAST file — the stat list is now empty
    expect(await fx.store.adoptDiscoveredDocuments())
      .toMatchObject({ quarantined: 0, removed: 0 });
    expect(await fx.storedRows()).toHaveLength(1);
  });

  it('a file that comes back clears the mark and keeps id and collections', async () => {
    fx = await makeFixture({ [ROLL]: 'glTF-ROLL', [BELT]: 'glTF-BELT' });
    let now = Date.parse('2026-08-13T10:00:00.000Z');
    fx.store.setAdoptOptions({ now: () => now });
    await fx.store.adoptDiscoveredDocuments();
    const id = (await fx.storedRows()).find(r => r.path === ROLL)!.id;
    await fx.store.applyManifestDelta(current => ({
      ...current,
      documents: (current.documents ?? []).map(
        d => d.id === id ? { ...d, collections: ['Conveyors'] } : d),
    }));

    await fx.drop(ROLL);
    await fx.store.adoptDiscoveredDocuments();
    expect((await fx.storedRows()).find(r => r.path === ROLL)?.missingSince).toBeTruthy();

    now += 60_000;
    await fx.seed(ROLL, 'glTF-ROLL');
    expect(await fx.store.adoptDiscoveredDocuments()).toMatchObject({ restored: 1, adopted: 0 });

    const back = (await fx.storedRows()).find(r => r.path === ROLL)!;
    expect(back.id).toBe(id);
    expect(back.missingSince).toBeUndefined();
    expect(back.collections).toEqual(['Conveyors']);
  });

  it('never adopts a sidecar, a thumbnail or anything in a dot-folder', async () => {
    fx = await makeFixture({
      [ROLL]: 'glTF-ROLL',
      'library/library.json': '{"schemaVersion":1,"assets":{}}',
      '.trash/Old.glb': 'glTF-OLD',
    });
    await fx.store.adoptDiscoveredDocuments();
    expect((await fx.storedRows()).map(r => r.path)).toEqual([ROLL]);
  });
});

// ─── Read-only backends never adopt (F3) ────────────────────────────────

describe('plan-717 F3 — a project that cannot be written cannot own rows', () => {
  beforeEach(async () => { await resetStorage(); });
  afterEach(async () => { await resetStorage(); });

  it('a folder without a readwrite grant adopts nothing and writes nothing', async () => {
    const root = new FakeDir('read-only-project');
    root.seedText('project.json', manifestText());
    await seedAt(root, ROLL, 'glTF-ROLL');
    root.permissions.readwrite = 'denied';

    const store = new ProjectStore();
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    expect(store.isWritable()).toBe(false);

    expect(await store.adoptDiscoveredDocuments()).toMatchObject({ adopted: 0 });
    expect(JSON.parse((await root.readText('project.json'))!).documents).toEqual([]);
    // …and the file is still SHOWN, as the transient display row §2.3 allows.
    expect(store.getSnapshot().documents.map(d => d.path)).toEqual([ROLL]);
    await store.closeProject();
  });

  it('the bundled/HTTP backend is not even scannable', async () => {
    const backend = new BundledBackend({
      fetchImpl: (async () => ({
        ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0),
      })) as unknown as typeof fetch,
    });
    expect(backend.writable).toBe(false);
    expect(await backend.statDocuments()).toEqual([]);

    const store = new ProjectStore();
    const privates = store as unknown as StorePrivates;
    privates._backend = backend as unknown as ProjectBackend;
    privates._project = project();
    const commit = vi.spyOn(store, 'applyManifestDelta');

    expect(await store.adoptDiscoveredDocuments()).toMatchObject({ adopted: 0 });
    expect(commit).not.toHaveBeenCalled();
    // The rescan path refuses one step earlier, on `kind`.
    await expect(store.rescanDocuments()).resolves.toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
    commit.mockRestore();
  });
});

// ─── Hash upkeep (R1-S2) ────────────────────────────────────────────────

describe('plan-717 §2.2 step 2 — the adopt verb maintains sha256 itself', () => {
  beforeEach(async () => { await resetStorage(); });
  afterEach(async () => { await resetStorage(); });

  it('a folder adopt computes the digest once and the next run hashes nothing', async () => {
    const fx = await folderFixture({ [ROLL]: 'glTF-ROLL', [BELT]: 'glTF-BELT' });
    const backend = fx.backend();
    const reads = vi.spyOn(backend, 'readBlobBytes');

    const first = await fx.store.adoptDiscoveredDocuments();
    expect(first.hashed).toBe(2);
    const rows = await fx.storedRows();
    expect(rows.every(r => typeof r.sha256 === 'string' && r.sha256!.length === 64)).toBe(true);

    reads.mockClear();
    const second = await fx.store.adoptDiscoveredDocuments();
    expect(second.hashed).toBe(0);
    // Same `(size, mtime)` pre-filter `reconcileClassificationCache` uses: an
    // unchanged library performs zero DOCUMENT byte reads, which is what keeps
    // the follow-up run inside its 2s budget.
    //
    // Phase 2 note: the run additionally probes `library/library.json` once
    // (§2.4) — a single O(1) read that does not scale with the library, and
    // the reason it cannot be skipped is the crash-heal case, where the marker
    // is already set and only the file is left over. It is excluded here
    // rather than silently swallowed by the assertion.
    expect(documentReads(reads)).toEqual([]);

    reads.mockRestore();
    await fx.dispose();
  });

  it('the size pre-filter keeps a move-match from hashing non-candidates', async () => {
    const fx = await folderFixture({ [ROLL]: 'glTF-ROLL' });
    await fx.store.adoptDiscoveredDocuments();
    const backend = fx.backend();

    await fx.drop(ROLL);
    // Three newcomers; only one has the right size, so only one may be hashed.
    await fx.seed('library/parts/A.glb', 'a-very-different-body-entirely!!');
    await fx.seed('library/parts/B.glb', 'another-differently-sized-body-x');
    await fx.seed('library/parts/C.glb', 'glTF-ROLL');

    const reads = vi.spyOn(backend, 'readBlobBytes');
    const summary = await fx.store.adoptDiscoveredDocuments();
    const hashedForMatch = documentReads(reads);

    expect(summary.moved).toBe(1);
    expect(hashedForMatch).toContain('library/parts/C.glb');
    // A and B are hashed later, as ADOPTIONS — never as move candidates. The
    // assertion that matters is that the match did not have to hash them to
    // find C: C is the first read.
    expect(hashedForMatch[0]).toBe('library/parts/C.glb');
    expect((await fx.storedRows()).find(r => r.path === 'library/parts/C.glb')?.id)
      .toBe(previewAssetId(ROLL));

    reads.mockRestore();
    await fx.dispose();
  });
});

// ─── The merge invariants (R1-T1, R2-F2, R1-T6) ─────────────────────────

describe('plan-717 §2.2 step 5 — applyAdoptDelta merges into a manifest it never saw', () => {
  it('two overlapping runs converge: neither tab loses a row', () => {
    // Tab A scanned a manifest with no rows and wants to adopt Roll. Tab B got
    // there first and its row for Belt is already on disk. A's delta is applied
    // to B's state — the CAS retry — and both rows must survive.
    const tabADelta: AdoptOp[] = [
      { op: 'adopt', path: ROLL, section: 'library', name: 'Roll2m', sha256: 'a'.repeat(64) },
    ];
    const afterTabB = project([
      { id: previewAssetId(BELT), path: BELT, name: 'Belt1m', section: 'library' },
    ]);

    const merged = applyAdoptDelta(afterTabB, tabADelta);
    expect(merged.changed).toBe(true);
    expect((merged.project.documents ?? []).map(d => d.path).sort()).toEqual([BELT, ROLL].sort());
  });

  it('one path, one row: an adopt onto an owned path is discarded and logged', () => {
    const owned = project([
      { id: 'doc_authored_first', path: ROLL, name: 'Roll 2m', section: 'library' },
    ]);
    const delta: AdoptOp[] = [{ op: 'adopt', path: ROLL, section: 'library', name: 'Roll2m' }];

    const merged = applyAdoptDelta(owned, delta);
    expect(merged.changed).toBe(false);
    expect(merged.project.documents).toHaveLength(1);
    expect(merged.project.documents![0].id).toBe('doc_authored_first');
    expect(merged.log).toEqual([
      expect.objectContaining({ kind: 'discarded', path: ROLL, id: 'doc_authored_first' }),
    ]);
  });

  it('one path, one row: a move onto a path another tab adopted loses to the older id', () => {
    // The copy+delete transition window: tab B saw both paths and adopted the
    // new one, tab A saw only the new one and read it as a move.
    const afterTabB = project([
      { id: 'doc_moving', path: ROLL, name: 'Roll 2m', section: 'library', sha256: 'a'.repeat(64) },
      { id: 'doc_adopted_by_b', path: BELT, name: 'Belt1m', section: 'library' },
    ]);
    const delta: AdoptOp[] = [{ op: 'move', id: 'doc_moving', from: ROLL, to: BELT }];

    const merged = applyAdoptDelta(afterTabB, delta);
    expect(merged.changed).toBe(false);
    expect((merged.project.documents ?? []).map(d => d.path)).toEqual([ROLL, BELT]);
    expect(merged.log[0]).toMatchObject({ kind: 'discarded', id: 'doc_adopted_by_b' });
  });

  it('an id collision against an existing row takes the deterministic suffix', () => {
    // The pathological case the type system cannot rule out: another row
    // already claims the id this path derives to.
    const taken = project([
      { id: previewAssetId(ROLL), path: 'library/elsewhere/Other.glb', name: 'Other', section: 'library' },
    ]);
    const merged = applyAdoptDelta(taken, [
      { op: 'adopt', path: ROLL, section: 'library', name: 'Roll2m' },
    ]);

    const adopted = (merged.project.documents ?? []).find(d => d.path === ROLL)!;
    expect(adopted.id).toBe(stableDocumentId(`${ROLL}#2`));
    expect(adopted.id).not.toBe(previewAssetId(ROLL));
  });

  it('an intra-batch collision is resolved too — the second op sees the first row', () => {
    const first: AdoptOp = {
      op: 'adopt', path: 'library/a/X.glb', section: 'library', name: 'X',
    };
    // A second file whose derived id would be the first one's: impossible to
    // stage through the hash, so it is staged through the manifest — the row
    // the FIRST op just added is what the second collides with.
    const merged = applyAdoptDelta(project(), [
      first,
      { op: 'adopt', path: 'library/a/X.glb', section: 'library', name: 'X duplicate' },
    ]);
    expect(merged.project.documents).toHaveLength(1);
    expect(merged.log.filter(l => l.kind === 'discarded')).toHaveLength(1);
  });

  it('a removal is dropped when the row lost its quarantine mark meanwhile', () => {
    const healed = project([
      { id: 'doc_back', path: ROLL, name: 'Roll 2m', section: 'library' },
    ]);
    const merged = applyAdoptDelta(healed, [{ op: 'remove', id: 'doc_back', path: ROLL }]);
    expect(merged.changed).toBe(false);
    expect(merged.log[0]).toMatchObject({ kind: 'discarded', detail: expect.stringContaining('back') });
  });

  it('an empty stat list is "nothing was learnt", not "the project is empty"', async () => {
    const rows = [{ id: 'doc_a', path: ROLL, name: 'Roll', section: 'library' as const }];
    const scan = await adoptDiscoveredDocuments(project(rows), { stats: [] });
    expect(scan.delta).toEqual([]);
  });

  it('isAdoptablePath refuses sidecars, dot-folders and non-assets', () => {
    expect(isAdoptablePath(ROLL)).toBe(true);
    expect(isAdoptablePath('library/parts/Cloud.ply')).toBe(true);
    expect(isAdoptablePath('library/library.json')).toBe(false);
    expect(isAdoptablePath('.trash/Old.glb')).toBe(false);
    expect(isAdoptablePath('library/.thumbnails/Roll2m.png')).toBe(false);
  });
});

// ─── Store wiring: ordering, single flight, contained failure ───────────

describe('plan-717 §2.2 — the wiring guarantees', () => {
  beforeEach(async () => { await resetStorage(); });
  afterEach(async () => { await resetStorage(); });

  it('durable-first: a failing write leaves the manifest and the UI untouched', async () => {
    const root = new FakeDir('adopt-project');
    root.seedText('project.json', manifestText());
    await seedAt(root, ROLL, 'glTF-ROLL');
    const store = new ProjectStore();
    await store.openProjectFolder(asDirHandle(root));
    await store.adoptDiscoveredDocuments();          // the healthy first run

    await seedAt(root, BELT, 'glTF-BELT');
    const before = store.getProject();
    const shownBefore = store.getSnapshot().documents.map(d => d.id);
    root.failures.fail({ point: 'write', name: 'project.json' });

    await expect(store.adoptDiscoveredDocuments()).rejects.toBeTruthy();

    // R2-F3: no phantom row anywhere. `_project` is the same object, and the
    // snapshot never saw the row that did not reach disk.
    expect(store.getProject()).toBe(before);
    expect(store.getSnapshot().documents.map(d => d.id)).toEqual(shownBefore);
    expect(((JSON.parse((await root.readText('project.json'))!) as RvProject).documents ?? []))
      .toHaveLength(1);
    root.failures.clear();
    await store.closeProject();
  });

  it('a failing adopt during open degrades to a warning — the project still opens', async () => {
    const root = new FakeDir('adopt-project');
    root.seedText('project.json', manifestText());
    await seedAt(root, ROLL, 'glTF-ROLL');
    // The FSA grant evaporating mid-batch: every manifest write from now on
    // throws NotAllowedError.
    root.failures.fail({ point: 'write', name: 'project.json' });

    const store = new ProjectStore();
    expect(await store.openProjectFolder(asDirHandle(root))).toBe(true);
    expect(store.getSnapshot().documents.map(d => d.path)).toEqual([ROLL]);
    expect(store.getSnapshot().warnings.some(w => /could not be registered/i.test(w))).toBe(true);

    root.failures.clear();
    await store.closeProject();
  });

  it('overlapping calls join the run in flight instead of starting a second', async () => {
    const fx = await folderFixture({ [ROLL]: 'glTF-ROLL', [BELT]: 'glTF-BELT' });
    const commit = vi.spyOn(fx.store, 'applyManifestDelta');

    const [a, b, c] = await Promise.all([
      fx.store.adoptDiscoveredDocuments(),
      fx.store.adoptDiscoveredDocuments(),
      fx.store.adoptDiscoveredDocuments(),
    ]);

    expect(commit).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.adopted).toBe(2);
    commit.mockRestore();
    await fx.dispose();
  });

  it('applyManifestDelta re-applies on a CAS conflict instead of re-writing a stale snapshot', async () => {
    // The S1 blocker, end to end: somebody else writes project.json between
    // our read and our write. `replaceManifest` would push its captured
    // snapshot again and lose their row; the delta merge must not.
    const root = new FakeDir('adopt-project');
    root.seedText('project.json', manifestText());
    const store = new ProjectStore();
    await store.openProjectFolder(asDirHandle(root));

    const foreign: RvDocumentEntry = {
      id: 'doc_from_the_other_tab', path: BELT, name: 'Belt1m', section: 'library',
    };
    let attempts = 0;
    await store.applyManifestDelta((current) => {
      attempts++;
      if (attempts === 1) {
        // The other tab lands after our read and before our write.
        root.seedText('project.json', manifestText([foreign]));
      }
      return {
        ...current,
        documents: [
          ...(current.documents ?? []),
          { id: 'doc_ours', path: ROLL, name: 'Roll 2m', section: 'library' },
        ],
      };
    });

    expect(attempts).toBeGreaterThan(1);
    const rows = ((JSON.parse((await root.readText('project.json'))!) as RvProject).documents ?? []);
    expect(rows.map(r => r.id).sort()).toEqual(['doc_from_the_other_tab', 'doc_ours']);
    await store.closeProject();
  });

  it('rescanDocuments adopts what it found — one publish for the whole cycle', async () => {
    const root = new FakeDir('adopt-project');
    root.seedText('project.json', manifestText());
    const store = new ProjectStore();
    await store.openProjectFolder(asDirHandle(root));

    let publishes = 0;
    const unsubscribe = store.subscribe(() => { publishes++; });
    await seedAt(root, ROLL, 'glTF-ROLL');
    await store.rescanDocuments();
    unsubscribe();

    expect(publishes).toBe(1);
    const rows = ((JSON.parse((await root.readText('project.json'))!) as RvProject).documents ?? []);
    expect(rows.map(r => r.path)).toEqual([ROLL]);
    expect(store.getSnapshot().documents[0].id).toBe(previewAssetId(ROLL));
    await store.closeProject();
  });
});

// ─── OPFS sweep (§2.3) ──────────────────────────────────────────────────

describe('plan-717 §2.3 — the browser sweep adopts row-less legacy blobs', () => {
  beforeEach(async () => { await resetStorage(); });
  afterEach(async () => { await resetStorage(); });

  it('a blob written by the pre-717 createEmptyAsset becomes a first-class document', async () => {
    // Exactly what `createEmptyAsset` left behind: bytes in `library/`, no row
    // anywhere. One sweep, and it can never happen again structurally.
    const fx = await browserFixture({ 'library/parts/New asset.glb': 'glTF-NEW' });

    expect(await fx.storedRows()).toEqual([]);
    const summary = await fx.store.adoptDiscoveredDocuments();
    expect(summary.adopted).toBe(1);

    const [row] = await fx.storedRows();
    expect(row.path).toBe('library/parts/New asset.glb');
    expect(row.id).toBe(previewAssetId('library/parts/New asset.glb'));
    expect(row.name).toBe('New asset');
    // OPFS is content-addressed, so the digest came free — no byte read at all.
    expect(row.sha256).toHaveLength(64);
    expect(summary.hashed).toBe(0);
    await fx.dispose();
  });
});

// ─── NFR measurement (§9.1, R1-S2) ──────────────────────────────────────

describe('plan-717 NFR — 200 library files', () => {
  beforeEach(async () => { await resetStorage(); });
  afterEach(async () => { await resetStorage(); });

  it('first run under 10s including every hash, follow-up run under 2s', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) files[`library/parts/Part${i}.glb`] = `glTF-BODY-${i}`;
    const fx = await folderFixture(files);

    // The fixture's `openProjectFolder` already adopted — measure a clean
    // first run by starting from an empty manifest again.
    await fx.store.applyManifestDelta(current => ({ ...current, documents: [] }));

    const firstStart = performance.now();
    const first = await fx.store.adoptDiscoveredDocuments();
    const firstMs = performance.now() - firstStart;

    const secondStart = performance.now();
    const second = await fx.store.adoptDiscoveredDocuments();
    const secondMs = performance.now() - secondStart;

    // Logged, as §9.1 asks: the numbers are the deliverable, the thresholds are
    // only the alarm.
    console.info(
      `[plan-717 NFR] 200 files — first run ${firstMs.toFixed(0)}ms (${first.hashed} hashed), `
      + `follow-up ${secondMs.toFixed(0)}ms (${second.hashed} hashed)`,
    );

    expect(first.adopted).toBe(200);
    expect(first.hashed).toBe(200);
    expect(firstMs).toBeLessThan(10_000);
    expect(second.hashed).toBe(0);
    expect(secondMs).toBeLessThan(2_000);
    await fx.dispose();
  }, 40_000);
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-716 Phase 2 (§2.3 / F3 / §9.1) — the eager scene→document migration.
 *
 * This is the riskiest change of the plan: it runs once, awaited, in the boot,
 * over data the user has no copy of. So the net is built around the ways it can
 * go wrong rather than around the happy path, and three of those deserve naming
 * here because the assertions below only make sense with them in mind.
 *
 * ## Resume is asserted in TWO halves, always (R2-S1)
 *
 * A crash test that only checks "no duplicates after the re-run" passes for the
 * exact bug R2 found: the alias pre-check used to skip the whole per-row block,
 * so a crash between the alias write and the draft move left the user's autosave
 * stranded under an id nothing addresses — no duplicate, no error, no draft. So
 * every crash case below asserts both **no duplication** and **the draft is
 * reachable afterwards**.
 *
 * ## Crashes are simulated by REPLAYING, not by throwing
 *
 * A thrown error mid-run would test the catch block. What has to be tested is
 * the state a killed tab leaves behind, so each crash case builds that state
 * literally — run the migration, undo the steps that "did not happen", run it
 * again — which is the same storage the second boot would actually find.
 *
 * ## The cache-row case is a safety net, not a feature (R2-I1b, Risiko 12)
 *
 * `rv-scenes-index` carries folder-project cache rows in the same keyspace, and
 * `rv-project-conflict.ts` hangs its "never a silent overwrite" check on them.
 * Retiring one would disable that check with nothing going red anywhere. The
 * case below asserts the row is untouched in ALL of its parts — index, body,
 * owner marker — because "not migrated" and "not retired" are two separate
 * promises and only both together keep the net alive.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  runWorkspaceScenesMigration,
  isScenesMigrationDone,
  listRetiredKeys,
  retiredGlbKey,
  retiredRowKey,
  __resetWorkspaceMigrationForTests,
  SCENES_MIGRATION_MARKER_KEY,
  type MigrationBackend,
} from '../src/core/project/rv-workspace-migration';
import {
  resolveDocumentAlias,
  readAllDocumentAliases,
  clearAllDocumentAliases,
  writeDocumentAlias,
} from '../src/core/project/rv-doc-alias';
import {
  clearAllScenes,
  listMetas,
  writeScene,
} from '../src/core/hmi/scene/rv-scene-storage';
import {
  listSceneGlbIds,
  readSceneGlb,
  readSceneGlbPointer,
  writeSceneGlb,
} from '../src/core/storage/rv-scene-glb-store';
import {
  clearAllSceneOwners,
  readSceneOwner,
  setCachedFrom,
} from '../src/core/project/rv-scene-owner';
import { openWorkspaceDefaultBackend, WORKSPACE_DEFAULT_PROJECT_ID } from '../src/core/project/rv-workspace-default';
import { browserManifestKey, browserBlobIndexKey } from '../src/core/project/backends/browser-backend';
import { documentsOf } from '../src/core/project/rv-project-documents';
import { RV_SCENE_SCHEMA_VERSION, type RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { RvProject } from '../src/core/project/rv-project-types';
import { writeBlobDocument } from './helpers/document-io';

// ─── Fixtures ───────────────────────────────────────────────────────────

const LS_KEY_SCENE_GLB_PREFIX = 'rv-scene-glb/';
const LS_KEY_SCENE_PREFIX = 'rv-scenes/';

function sceneFixture(id: string, name: string): RvScene {
  return {
    id,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-02T00:00:00.000Z',
    schemaVersion: RV_SCENE_SCHEMA_VERSION,
    base: { kind: 'empty' },
    edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 100 } },
  };
}

function bodyBytes(id: string): Uint8Array {
  return new TextEncoder().encode(`glTF-stand-in:${id}`);
}

/** Seed one catalogue row with a body — the ordinary pre-migration scene. */
async function seedScene(id: string, name: string): Promise<void> {
  writeScene(sceneFixture(id, name));
  await writeSceneGlb(id, bodyBytes(id));
}

/** Seed a Form-C autosave draft slot for a scene. */
async function seedDraft(sceneId: string): Promise<void> {
  await writeSceneGlb(`draft/${sceneId}`, bodyBytes(`draft:${sceneId}`));
}

function draftSlotExists(id: string): boolean {
  return readSceneGlbPointer(`draft/${id}`) !== null;
}

async function readWorkspaceManifest(): Promise<RvProject | null> {
  return openWorkspaceDefaultBackend({ requestPersistence: false }).readManifest();
}

async function workspaceDocuments(): Promise<{ id: string; path: string; name: string }[]> {
  return documentsOf(await readWorkspaceManifest()).map(d => ({ id: d.id, path: d.path, name: d.name }));
}

/** A backend that never asks for persistent storage — no prompt in a test run. */
function testBackend(): MigrationBackend {
  return openWorkspaceDefaultBackend({ requestPersistence: false });
}

function wipe(): void {
  clearAllScenes();
  clearAllSceneOwners();
  clearAllDocumentAliases();
  __resetWorkspaceMigrationForTests();
  for (const key of [...Array(localStorage.length).keys()].map(i => localStorage.key(i))) {
    if (!key) continue;
    if (
      key.startsWith(LS_KEY_SCENE_GLB_PREFIX)
      || key.startsWith(LS_KEY_SCENE_PREFIX)
      || key === browserManifestKey(WORKSPACE_DEFAULT_PROJECT_ID)
      || key === browserBlobIndexKey(WORKSPACE_DEFAULT_PROJECT_ID)
    ) {
      localStorage.removeItem(key);
    }
  }
}

beforeEach(() => { wipe(); });
afterEach(() => { wipe(); vi.restoreAllMocks(); });

// ─── The whole walk ─────────────────────────────────────────────────────

describe('the catalogue becomes documents', () => {
  it('converts N rows into N documents, N aliases, N retired rows and a marker', async () => {
    await seedScene('scn_a', 'Line A');
    await seedScene('scn_b', 'Line B');
    await seedScene('scn_c', 'Line C');

    const result = await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(result.outcome).toBe('migrated');
    expect(result.migrated).toHaveLength(3);
    expect(result.migrated.every(m => m.fresh)).toBe(true);

    // Three documents, each holding the bytes its row held.
    const docs = await workspaceDocuments();
    expect(docs.map(d => d.path).sort()).toEqual([
      'scenes/Line A.glb', 'scenes/Line B.glb', 'scenes/Line C.glb',
    ]);

    // Three aliases, each pointing at the matching document.
    const aliases = readAllDocumentAliases();
    expect(Object.keys(aliases).sort()).toEqual(['scn_a', 'scn_b', 'scn_c']);
    for (const row of result.migrated) {
      expect(docs.find(d => d.id === aliases[row.sceneId])).toBeTruthy();
    }

    // The catalogue is gone — retired, never deleted.
    expect(listMetas()).toEqual([]);
    expect(listRetiredKeys()).toContain(retiredRowKey('scn_a'));
    expect(listRetiredKeys()).toContain(retiredGlbKey('scn_a'));
    expect(localStorage.getItem(LS_KEY_SCENE_PREFIX + 'scn_a')).toBeNull();
    expect(localStorage.getItem(LS_KEY_SCENE_GLB_PREFIX + 'scn_a')).toBeNull();

    expect(isScenesMigrationDone()).toBe(true);
  });

  it('keeps the BYTES, not merely the row — a converted document opens', async () => {
    await seedScene('scn_a', 'Line A');
    await runWorkspaceScenesMigration({ backend: testBackend() });

    const backend = testBackend();
    const bytes = (await backend.readDocument('scenes/Line A.glb'))?.bytes ?? null;
    expect(bytes).not.toBeNull();
    expect(new Uint8Array(bytes!)).toEqual(bodyBytes('scn_a'));
  });

  it('is idempotent: a second run converts nothing and duplicates nothing', async () => {
    await seedScene('scn_a', 'Line A');
    const first = await runWorkspaceScenesMigration({ backend: testBackend() });
    const second = await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(first.outcome).toBe('migrated');
    expect(second.outcome).toBe('already');
    expect(await workspaceDocuments()).toHaveLength(1);
    expect(Object.keys(readAllDocumentAliases())).toEqual(['scn_a']);
  });

  it('marks an empty catalogue done rather than re-walking it every boot', async () => {
    const result = await runWorkspaceScenesMigration({ backend: testBackend() });
    expect(result.outcome).toBe('skipped');
    expect(isScenesMigrationDone()).toBe(true);
    expect(await workspaceDocuments()).toEqual([]);
  });

  it('reports progress once per row, so the overlay can count', async () => {
    await seedScene('scn_a', 'A');
    await seedScene('scn_b', 'B');
    const seen: string[] = [];
    await runWorkspaceScenesMigration({
      backend: testBackend(),
      onProgress: (done, total) => seen.push(`${done}/${total}`),
    });
    expect(seen).toEqual(['1/2', '2/2']);
  });
});

// ─── Crash mid-run, one case per step (§9.1) ────────────────────────────

describe('a crash mid-run is repaired by the next boot', () => {
  /**
   * Crash after step c (bytes written, no alias).
   *
   * The re-run must NOT create a second document. It cannot see an alias, so it
   * walks b–d again — and lands on the same derived id and the same path,
   * because both come from the row rather than from a clock or a counter. The
   * create-only write is what proves it: a second, different target would have
   * succeeded silently.
   */
  it('c: bytes written, alias not — the re-run reuses the same document', async () => {
    await seedScene('scn_a', 'Line A');
    await runWorkspaceScenesMigration({ backend: testBackend() });

    // Rewind to "after c, before d". The manifest goes back too, and that is
    // the faithful part: the manifest is written ONCE, after the whole walk, so
    // a crash inside the first row cannot have left a row in it. Leaving it
    // would make the re-run see the path as claimed and place a duplicate
    // beside it — a state the real crash never produces.
    const documentId = resolveDocumentAlias('scn_a')!;
    clearAllDocumentAliases();
    localStorage.removeItem(browserManifestKey(WORKSPACE_DEFAULT_PROJECT_ID));
    localStorage.setItem(
      LS_KEY_SCENE_GLB_PREFIX + 'scn_a',
      localStorage.getItem(retiredGlbKey('scn_a'))!,
    );
    writeScene(sceneFixture('scn_a', 'Line A'));
    __resetWorkspaceMigrationForTests();

    await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(await workspaceDocuments()).toHaveLength(1);
    expect(resolveDocumentAlias('scn_a')).toBe(documentId);
    expect(listMetas()).toEqual([]);
  });

  /**
   * Crash after step d (alias written, draft not moved) — the R2-S1 case.
   *
   * This is the one the original design got wrong. The alias is there, so the
   * pre-check short-circuits b–d; if it short-circuited e as well the draft
   * would stay under `draft/scn_a` forever, addressed by nothing.
   */
  it('d: alias written, draft not moved — the re-run STILL moves the draft', async () => {
    await seedScene('scn_a', 'Line A');
    await seedDraft('scn_a');
    await runWorkspaceScenesMigration({ backend: testBackend() });
    const documentId = resolveDocumentAlias('scn_a')!;

    // Rewind to "after d, before e": the draft is back under the old id.
    await seedDraft('scn_a');
    localStorage.removeItem(LS_KEY_SCENE_GLB_PREFIX + `draft/${documentId}`);
    writeScene(sceneFixture('scn_a', 'Line A'));
    __resetWorkspaceMigrationForTests();

    await runWorkspaceScenesMigration({ backend: testBackend() });

    // Half one: nothing duplicated.
    expect(await workspaceDocuments()).toHaveLength(1);
    expect(Object.keys(readAllDocumentAliases())).toEqual(['scn_a']);
    // Half two: the draft is REACHABLE under the new identity.
    expect(draftSlotExists(documentId)).toBe(true);
    expect(draftSlotExists('scn_a')).toBe(false);
    expect(await readSceneGlb(`draft/${documentId}`)).toEqual(bodyBytes('draft:scn_a'));
  });

  /** Crash after step e (draft moved, body not retired). */
  it('e: draft moved, body not retired — the re-run retires it', async () => {
    await seedScene('scn_a', 'Line A');
    await seedDraft('scn_a');
    await runWorkspaceScenesMigration({ backend: testBackend() });
    const documentId = resolveDocumentAlias('scn_a')!;

    // Rewind to "after e, before f": the old body pointer is back.
    localStorage.setItem(
      LS_KEY_SCENE_GLB_PREFIX + 'scn_a',
      localStorage.getItem(retiredGlbKey('scn_a'))!,
    );
    localStorage.removeItem(retiredGlbKey('scn_a'));
    writeScene(sceneFixture('scn_a', 'Line A'));
    __resetWorkspaceMigrationForTests();

    await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(await workspaceDocuments()).toHaveLength(1);
    expect(localStorage.getItem(LS_KEY_SCENE_GLB_PREFIX + 'scn_a')).toBeNull();
    expect(localStorage.getItem(retiredGlbKey('scn_a'))).not.toBeNull();
    expect(draftSlotExists(documentId)).toBe(true);
  });

  /**
   * Crash INSIDE step f, between the two operations of the retire.
   *
   * There is no rename primitive (R2), so this window exists by construction.
   * Both keys present is not loss — the retired copy and the original name the
   * same content-addressed blob — and the re-run's job is to remove the old one.
   */
  it('f: both keys present after a half-done retire — the re-run removes the old one', async () => {
    await seedScene('scn_a', 'Line A');
    await runWorkspaceScenesMigration({ backend: testBackend() });

    // Rewind to "retired key written, old key not yet removed".
    const retired = localStorage.getItem(retiredGlbKey('scn_a'))!;
    localStorage.setItem(LS_KEY_SCENE_GLB_PREFIX + 'scn_a', retired);
    writeScene(sceneFixture('scn_a', 'Line A'));
    __resetWorkspaceMigrationForTests();
    localStorage.setItem(retiredGlbKey('scn_a'), retired);

    await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(localStorage.getItem(LS_KEY_SCENE_GLB_PREFIX + 'scn_a')).toBeNull();
    expect(localStorage.getItem(retiredGlbKey('scn_a'))).toBe(retired);
    expect(await workspaceDocuments()).toHaveLength(1);
  });

  /**
   * Crash between the marker and the row retirement.
   *
   * The marker is written first of the two, so this state says "done" while the
   * catalogue is still populated. The residue check is what stops the cheap
   * `already` answer from believing the marker over the storage.
   */
  it('marker set, rows still there — the re-run finishes the retirement', async () => {
    await seedScene('scn_a', 'Line A');
    await runWorkspaceScenesMigration({ backend: testBackend() });

    // Rewind to "marker set, rows not retired". The alias survives, as it would.
    localStorage.setItem(
      LS_KEY_SCENE_PREFIX + 'scn_a',
      localStorage.getItem(retiredRowKey('scn_a'))!,
    );
    writeScene(sceneFixture('scn_a', 'Line A'));
    expect(isScenesMigrationDone()).toBe(true);
    expect(listMetas()).toHaveLength(1);

    const result = await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(result.outcome).toBe('migrated');
    expect(result.migrated[0]!.fresh).toBe(false);   // recognised, not re-created
    expect(listMetas()).toEqual([]);
    expect(await workspaceDocuments()).toHaveLength(1);
  });
});

// ─── Rows that are not ordinary ─────────────────────────────────────────

describe('rows the walk must treat specially', () => {
  it('leaves a folder-project CACHE row completely alone (R2-I1b, Risiko 12)', async () => {
    await seedScene('scn_cached', 'From folder');
    setCachedFrom('scn_cached', 'folder:prj_customer', 'sha-of-the-folder-file');
    await seedScene('scn_mine', 'My scene');

    const result = await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(result.skipped).toContainEqual({ sceneId: 'scn_cached', reason: 'cache-row' });
    // Not migrated…
    expect(resolveDocumentAlias('scn_cached')).toBeNull();
    expect(await workspaceDocuments()).toHaveLength(1);
    // …and not retired, in every part the conflict check reads.
    expect(listMetas().map(m => m.id)).toEqual(['scn_cached']);
    expect(localStorage.getItem(LS_KEY_SCENE_PREFIX + 'scn_cached')).not.toBeNull();
    expect(readSceneGlbPointer('scn_cached')).not.toBeNull();
    expect(readSceneOwner('scn_cached')?.cachedFrom).toBe('folder:prj_customer');
    expect(readSceneOwner('scn_cached')?.cachedRevision).toBe('sha-of-the-folder-file');
    // The ordinary row beside it still converted.
    expect(resolveDocumentAlias('scn_mine')).not.toBeNull();
  });

  it('retires a row that never had a body, without inventing an empty document', async () => {
    writeScene(sceneFixture('scn_ghost', 'Ghost'));

    const result = await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(result.skipped).toContainEqual({ sceneId: 'scn_ghost', reason: 'no-body' });
    expect(await workspaceDocuments()).toEqual([]);
    expect(resolveDocumentAlias('scn_ghost')).toBeNull();
    expect(listMetas()).toEqual([]);
    expect(localStorage.getItem(retiredRowKey('scn_ghost'))).not.toBeNull();
    // Still `migrated`, not `partial`: a row with nothing in it is not a failure.
    expect(result.outcome).toBe('migrated');
    expect(isScenesMigrationDone()).toBe(true);
  });

  it('adopts a body with no row as a Recovered document (R1-S5)', async () => {
    await writeSceneGlb('scn_orphan', bodyBytes('scn_orphan'));
    await seedScene('scn_a', 'Line A');

    const result = await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]!.sceneId).toBe('scn_orphan');
    const docs = await workspaceDocuments();
    expect(docs.map(d => d.name).sort()).toEqual(['Line A', 'Recovered scn_orphan']);
    expect(resolveDocumentAlias('scn_orphan')).toBe(result.recovered[0]!.documentId);
  });

  it('never adopts a DRAFT slot as a recovered document', async () => {
    // `listSceneGlbIds()` returns `draft/…` tails looking exactly like ids, so
    // an unfiltered sweep would turn every unsaved autosave into a document.
    await seedDraft('scn_gone');
    await writeSceneGlb('draft/empty', bodyBytes('draft:empty'));

    const result = await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(result.recovered).toEqual([]);
    expect(await workspaceDocuments()).toEqual([]);
    expect(listSceneGlbIds().sort()).toEqual(['draft/empty', 'draft/scn_gone']);
  });

  it('gives a folder project only aliases, and moves none of its bytes', async () => {
    const folderProject = {
      schemaVersion: 2,
      id: 'prj_customer',
      name: 'CustomerX',
      documents: [
        { id: 'scn_folder1', path: 'scenes/Cell.glb', name: 'Cell', section: 'scenes' },
        { id: 'doc_model', path: 'models/line.glb', name: 'line', section: 'models' },
      ],
    } as unknown as RvProject;

    const result = await runWorkspaceScenesMigration({ backend: testBackend(), folderProject });

    // The `scn_`-shaped scene document gets a SELF-alias; the model does not.
    expect(resolveDocumentAlias('scn_folder1')).toBe('scn_folder1');
    expect(resolveDocumentAlias('doc_model')).toBeNull();
    // Nothing was written into My Workspace on its behalf.
    expect(await workspaceDocuments()).toEqual([]);
    expect(result.migrated).toEqual([]);
  });
});

// ─── Collisions ─────────────────────────────────────────────────────────

describe('collisions never overwrite (R2-T)', () => {
  it('two rows with the same name get probed, deterministic paths', async () => {
    await seedScene('scn_a', 'Line');
    await seedScene('scn_b', 'Line');
    await seedScene('scn_c', 'Line');

    await runWorkspaceScenesMigration({ backend: testBackend() });

    const docs = await workspaceDocuments();
    expect(docs.map(d => d.path).sort()).toEqual([
      'scenes/Line 2.glb', 'scenes/Line 3.glb', 'scenes/Line.glb',
    ]);
    // Three distinct ids, three distinct aliases — nothing collapsed.
    expect(new Set(docs.map(d => d.id)).size).toBe(3);
    expect(new Set(Object.values(readAllDocumentAliases())).size).toBe(3);
  });

  it('does not overwrite a document that is already at the target path', async () => {
    const backend = testBackend();
    await backend.activate();
    await writeBlobDocument(backend, 
      'scenes/Line.glb',
      new Blob([bodyBytes('pre-existing') as unknown as BlobPart]),
    );
    await backend.writeManifest({
      schemaVersion: 2,
      id: WORKSPACE_DEFAULT_PROJECT_ID,
      name: 'My Workspace',
      documents: [{ id: 'doc_pre', path: 'scenes/Line.glb', name: 'Line', section: 'scenes' }],
    } as unknown as RvProject);
    await backend.deactivate();

    await seedScene('scn_a', 'Line');
    await runWorkspaceScenesMigration({ backend: testBackend() });

    // The incumbent kept its bytes; the migrated row went beside it.
    const kept = await testBackend().readDocument('scenes/Line.glb');
    expect(kept!.bytes).toEqual(bodyBytes('pre-existing'));
    const moved = await testBackend().readDocument('scenes/Line 2.glb');
    expect(moved!.bytes).toEqual(bodyBytes('scn_a'));
  });
});

// ─── Quota ──────────────────────────────────────────────────────────────

describe('quota failures abort a row and retire nothing (R1-S3)', () => {
  it('a refused ALIAS write leaves the row completely intact', async () => {
    await seedScene('scn_a', 'Line A');
    await seedScene('scn_b', 'Line B');

    // Fail only the alias write for scn_a. Everything else — the blob index,
    // the manifest, the retire — must keep working, or the test would pass for
    // the wrong reason.
    const realSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage, key: string, value: string,
    ) {
      if (key === 'rv-doc-alias/scn_a') throw new DOMException('quota', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });

    const result = await runWorkspaceScenesMigration({ backend: testBackend() });
    vi.restoreAllMocks();

    expect(result.outcome).toBe('partial');
    expect(result.skipped.find(s => s.sceneId === 'scn_a')?.reason).toBe('alias-failed');

    // The failed row keeps EVERYTHING: no alias, no retire, still in the index.
    expect(resolveDocumentAlias('scn_a')).toBeNull();
    expect(listMetas().map(m => m.id)).toEqual(['scn_a']);
    expect(localStorage.getItem(LS_KEY_SCENE_GLB_PREFIX + 'scn_a')).not.toBeNull();
    expect(localStorage.getItem(retiredRowKey('scn_a'))).toBeNull();

    // The marker is NOT set, so the next boot tries again.
    expect(isScenesMigrationDone()).toBe(false);

    // Its neighbour still converted — one bad row does not stop the walk.
    expect(resolveDocumentAlias('scn_b')).not.toBeNull();
  });

  it('the aborted row converts on the next run, once storage frees up', async () => {
    await seedScene('scn_a', 'Line A');
    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage, key: string, value: string,
    ) {
      if (key === 'rv-doc-alias/scn_a') throw new DOMException('quota', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });
    await runWorkspaceScenesMigration({ backend: testBackend() });
    spy.mockRestore();

    const retry = await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(retry.outcome).toBe('migrated');
    expect(resolveDocumentAlias('scn_a')).not.toBeNull();
    expect(listMetas()).toEqual([]);
    // The first run's bytes were reused rather than written twice.
    expect(await workspaceDocuments()).toHaveLength(1);
  });

  it('a refused OPFS write aborts its row too, and retires nothing', async () => {
    await seedScene('scn_a', 'Line A');
    const backend = testBackend();
    vi.spyOn(backend, 'writeDocument').mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));

    const result = await runWorkspaceScenesMigration({ backend });

    expect(result.outcome).toBe('partial');
    expect(result.skipped.find(s => s.sceneId === 'scn_a')?.reason).toBe('write-failed');
    expect(listMetas().map(m => m.id)).toEqual(['scn_a']);
    expect(resolveDocumentAlias('scn_a')).toBeNull();
    expect(isScenesMigrationDone()).toBe(false);
  });
});

// ─── Two tabs (§2.3 step 1 — Web Locks, NEW infrastructure) ─────────────

describe('two tabs', () => {
  it('the second tab does not migrate while the first holds the lock', async () => {
    await seedScene('scn_a', 'Line A');

    // Hold `rv-migration-716` the way another tab would, then let the migration
    // ask for it. `ifAvailable` means it is handed `null` rather than queued.
    let releaseHolder!: () => void;
    const holderHasIt = new Promise<void>(resolve => {
      void navigator.locks.request('rv-migration-716', async () => {
        resolve();
        await new Promise<void>(r => { releaseHolder = r; });
      });
    });
    await holderHasIt;

    const result = await runWorkspaceScenesMigration({
      backend: testBackend(),
      // The other "tab" never broadcasts here, so the wait must end on its
      // deadline rather than hanging the boot.
      waitForOtherTabMs: 50,
    });
    releaseHolder();

    expect(result.outcome).toBe('deferred');
    // Nothing was touched by the tab that did not hold the lock.
    expect(listMetas().map(m => m.id)).toEqual(['scn_a']);
    expect(resolveDocumentAlias('scn_a')).toBeNull();
    expect(isScenesMigrationDone()).toBe(false);
  });

  it('migrates normally once the lock is free again', async () => {
    await seedScene('scn_a', 'Line A');
    const result = await runWorkspaceScenesMigration({ backend: testBackend() });
    expect(result.outcome).toBe('migrated');
    expect(resolveDocumentAlias('scn_a')).not.toBeNull();
  });
});

// ─── Performance (NFR / Risiko 10) ──────────────────────────────────────

describe('the boot cost is bounded', () => {
  it('converts 50 rows in under 10 seconds', async () => {
    for (let i = 0; i < 50; i++) await seedScene(`scn_${i}`, `Scene ${i}`);

    const started = performance.now();
    const result = await runWorkspaceScenesMigration({ backend: testBackend() });
    const elapsed = performance.now() - started;

    expect(result.migrated).toHaveLength(50);
    expect(await workspaceDocuments()).toHaveLength(50);
    // Logged so the number is in the run output, not only in the assertion.
    console.info(`[plan-716 §9.1] 50-row migration took ${Math.round(elapsed)} ms (budget 10000 ms)`);
    expect(elapsed).toBeLessThan(10_000);
    expect(result.durationMs).toBeLessThan(10_000);
  }, 30_000);

  it('a migrated profile costs two reads on every later boot', async () => {
    await seedScene('scn_a', 'Line A');
    await runWorkspaceScenesMigration({ backend: testBackend() });

    const started = performance.now();
    const result = await runWorkspaceScenesMigration();
    expect(result.outcome).toBe('already');
    expect(performance.now() - started).toBeLessThan(100);
  });
});

// ─── The marker's own contract ──────────────────────────────────────────

describe('the marker', () => {
  it('is written LAST — never before the final row', async () => {
    await seedScene('scn_a', 'Line A');
    await seedScene('scn_b', 'Line B');

    const markerAt: (string | null)[] = [];
    await runWorkspaceScenesMigration({
      backend: testBackend(),
      onProgress: () => markerAt.push(localStorage.getItem(SCENES_MIGRATION_MARKER_KEY)),
    });

    expect(markerAt).toEqual([null, null]);
    expect(localStorage.getItem(SCENES_MIGRATION_MARKER_KEY)).not.toBeNull();
  });

  it('an alias that already points elsewhere is refused rather than repointed', async () => {
    writeDocumentAlias('scn_a', 'doc_somewhere_else');
    await seedScene('scn_a', 'Line A');

    // The pre-check sees the alias and treats b–d as done, so the row is
    // recognised rather than re-created — and the existing alias survives.
    const result = await runWorkspaceScenesMigration({ backend: testBackend() });

    expect(resolveDocumentAlias('scn_a')).toBe('doc_somewhere_else');
    expect(result.migrated[0]!.fresh).toBe(false);
    expect(await workspaceDocuments()).toEqual([]);
  });
});

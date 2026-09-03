// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * browser-backend.test — plan-372 Phase 2, §2.5 and the M2 finding of §5.1.
 *
 * `BrowserBackend` is the first **writable** backend that needs no filesystem,
 * and it writes into a keyspace that predates it. Two properties therefore
 * carry the whole design and are pinned here first:
 *
 *  1. **The scene keyspace is not changed.** Saving through the backend
 *     produces the same `rv-scenes/*` bytes as saving through the storage
 *     module directly — no prefix, no rename, no migration.
 *  2. **Several browser projects share that flat keyspace safely** (§5.1, M2).
 *     Bodies cannot collide because scene ids are unique; membership comes
 *     from the 1:n `rv-scene-owner` marker; a shared id is sharing, not
 *     overwriting; and `cachedFrom` is never written — setting it would arm
 *     the "folder wins" default against a browser project's only copy.
 *
 * The rest covers the `ProjectBackend` contract (activation gate, listing,
 * blobs through the real OPFS store).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BrowserBackend,
  browserBlobIndexKey,
  browserManifestKey,
  sceneIdOfPath,
} from '../src/core/project/backends/browser-backend';
import { BackendNotWritableError } from '../src/core/project/backends/project-backend';
import {
  clearAllSceneOwners,
  noteSceneMembership,
  readSceneOwner,
  setCachedFrom,
} from '../src/core/project/rv-scene-owner';
import {
  clearAllScenes,
  listMetas,
  readScene,
  writeScene as writeSceneBody,
} from '../src/core/hmi/scene/rv-scene-storage';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import { clearAllBlobs, sha256OfBlob } from '../src/core/storage/rv-opfs-blobs';
import { listSceneGlbIds, readSceneGlbPointer } from '../src/core/storage/rv-scene-glb-store';
import { glbWrite } from './helpers/scene-write';
import { sceneDocumentsOf } from '../src/core/project/rv-project-documents';
import { writeSceneDocument, writeBlobDocument } from './helpers/document-io';

// ─── Fixtures ───────────────────────────────────────────────────────────

const P1 = 'prj_browser_one';
const P2 = 'prj_browser_two';

function scene(id: string, name = id): RvScene {
  return {
    id,
    name,
    createdAt: '2025-01-01T00:00:00.000Z',
    modifiedAt: '2025-01-01T00:00:00.000Z',
    schemaVersion: 3,
    base: { kind: 'empty' },
    edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
  };
}

/** An activated backend — the only state in which writes are allowed. */
async function open(projectId: string, opts = {}): Promise<BrowserBackend> {
  const backend = new BrowserBackend(projectId, { requestPersistence: false, ...opts });
  await backend.activate();
  return backend;
}

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

// ─── Identity + contract ────────────────────────────────────────────────

describe('BrowserBackend — identity', () => {
  it('is a writable browser backend', () => {
    const backend = new BrowserBackend(P1);
    expect(backend.kind).toBe('browser');
    expect(backend.writable).toBe(true);
    expect(backend.id).toBe(`browser:${P1}`);
  });

  it('refuses to exist without a project id', () => {
    expect(() => new BrowserBackend('')).toThrow();
  });

  it('is inert until activated (§2.2.1b)', async () => {
    const backend = new BrowserBackend(P1, { requestPersistence: false });
    expect(backend.isActive).toBe(false);
    await expect(writeSceneDocument(backend, 'scn_x', glbWrite('scn_x'))).rejects.toBeInstanceOf(
      BackendNotWritableError,
    );
    await expect(backend.deleteDocument('scn_x')).rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(writeBlobDocument(backend, 'models/a.glb', new Blob(['x']))).rejects.toBeInstanceOf(
      BackendNotWritableError,
    );
  });

  it('reading works before activation — discovery must not need a write gate', async () => {
    writeSceneBody(scene('scn_r'));
    noteSceneMembership('scn_r', P1);
    const backend = new BrowserBackend(P1, { requestPersistence: false });

    expect(await backend.listDocuments()).toEqual([]);
    // A row with no GLB body has no body at all since plan-413 phase 6: the
    // op-log fallback is gone, and `readScene` says so by answering null.
    expect(await backend.readDocument('scn_r')).toBeNull();
  });

  it('deactivate closes the gate again and is idempotent', async () => {
    const backend = await open(P1);
    await backend.deactivate();
    await backend.deactivate();
    expect(backend.isActive).toBe(false);
    await expect(writeSceneDocument(backend, 'scn_x', glbWrite('scn_x'))).rejects.toBeInstanceOf(
      BackendNotWritableError,
    );
  });

  it('addresses a scene by id, `scenes/<id>` or `<id>.scene.glb` alike', () => {
    expect(sceneIdOfPath('scn_a')).toBe('scn_a');
    expect(sceneIdOfPath('scenes/scn_a')).toBe('scn_a');
    expect(sceneIdOfPath('scenes/scn_a.scene.glb')).toBe('scn_a');
    expect(sceneIdOfPath('')).toBe('');
  });

  it('refuses a path that addresses a different scene', async () => {
    const backend = await open(P1);
    await expect(writeSceneDocument(backend, 'scn_other', glbWrite('scn_a'))).rejects.toThrow(/scn_a/);
  });
});

// ─── The keyspace is not migrated (§2.5) ────────────────────────────────

describe('BrowserBackend — the scene keyspace is untouched', () => {
  it('leaves a pre-397 body at its historic key untouched (plan-397 phase 5)', async () => {
    // The scene as an older build wrote it.
    writeSceneBody(scene('scn_a', 'Cell 1'));
    const before = localStorage.getItem('rv-scenes/scn_a');

    const backend = await open(P1);
    await writeSceneDocument(backend, 'scn_a', glbWrite('scn_a', 'Cell 1'));

    // The GLB write goes to OPFS + its own pointer. The op-log record is not
    // rewritten, not deleted and not migrated — phase 7 owns that decision,
    // and until then it is the fallback a rollback depends on.
    expect(localStorage.getItem('rv-scenes/scn_a')).toBe(before);
    expect(readScene('scn_a')?.name).toBe('Cell 1');
    expect(listMetas().map(m => m.id)).toEqual(['scn_a']);
  });

  it('stores the GLB body in OPFS and keeps only a pointer in localStorage', async () => {
    const backend = await open(P1);
    const revision = await writeSceneDocument(backend, 'scn_a', glbWrite('scn_a', 'Cell 1'));

    const pointer = readSceneGlbPointer('scn_a');
    expect(pointer?.sha).toBe(revision);
    // The pointer is metadata; nothing that could pass for a body is in
    // localStorage under it.
    expect(pointer?.size).toBeGreaterThan(0);

    const record = await backend.readDocument('scn_a');
    expect(record?.revision).toBe(revision);
    expect(new TextDecoder().decode(record!.bytes)).toContain('scn_a');
  });

  it('a GLB write leaves the body and the marker, and no index row', async () => {
    const backend = await open(P1);
    await writeSceneDocument(backend, 'scn_glb_only', glbWrite('scn_glb_only'));
    // `writeScene` puts bytes in OPFS and a membership marker beside them; it
    // never touched `rv-scenes-index`, and since Phase 6 nothing derives a
    // listing from that index either.
    expect(listMetas()).toEqual([]);
    expect(readSceneGlbPointer('scn_glb_only')).not.toBeNull();
    expect(readSceneOwner('scn_glb_only')?.projectIds).toEqual([P1]);
  });

  it('introduces no key outside its own additive namespace', async () => {
    const backend = await open(P1);
    await writeSceneDocument(backend, 'scn_a', glbWrite('scn_a'));
    await backend.writeManifest({
      schemaVersion: 1,
      id: P1,
      name: 'One',
      models: [{ path: 'models/a.glb' }],
    });

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      const known =
        key.startsWith('rv-scenes') ||
        key.startsWith('rv-scene-glb/') ||
        key.startsWith('rv-scene-owner/') ||
        key.startsWith('rv-project/browser/');
      expect(known, `unexpected key "${key}"`).toBe(true);
    }
    expect(localStorage.getItem(browserManifestKey(P1))).not.toBeNull();
  });

  it('records membership but never provenance', async () => {
    const backend = await open(P1);
    await writeSceneDocument(backend, 'scn_a', glbWrite('scn_a'));

    const owner = readSceneOwner('scn_a');
    expect(owner?.projectIds).toEqual([P1]);
    // localStorage IS the store here, not a mirror of a file. Claiming an
    // origin would make a folder project treat the only copy as a stale cache.
    expect(owner?.cachedFrom).toBeNull();
  });
});

// ─── Several browser projects, one flat keyspace (§5.1 M2) ──────────────

describe('BrowserBackend — two browser projects share the keyspace safely', () => {
  it('each body carries its own project marker', async () => {
    const one = await open(P1);
    const two = await open(P2);
    await writeSceneDocument(one, 'scn_1', glbWrite('scn_1', 'Line A'));
    await writeSceneDocument(two, 'scn_2', glbWrite('scn_2', 'Line B'));

    // Both bodies are in the one store — the separation is the marker, not
    // the keyspace.
    expect(listSceneGlbIds().sort()).toEqual(['scn_1', 'scn_2']);
    expect(readSceneOwner('scn_1')?.projectIds).toEqual([P1]);
    expect(readSceneOwner('scn_2')?.projectIds).toEqual([P2]);
  });

  it('neither can overwrite the other: distinct ids are distinct bodies', async () => {
    const one = await open(P1);
    const two = await open(P2);
    await writeSceneDocument(one, 'scn_1', glbWrite('scn_1', 'Line A'));
    await writeSceneDocument(two, 'scn_2', glbWrite('scn_2', 'Line B'));

    expect(new TextDecoder().decode((await one.readDocument('scn_1'))!.bytes!)).toContain('Line A');
    expect(new TextDecoder().decode((await two.readDocument('scn_2'))!.bytes!)).toContain('Line B');
  });

  it('a shared scene id is sharing, and both projects list it', async () => {
    const one = await open(P1);
    const two = await open(P2);
    await writeSceneDocument(one, 'scn_shared', glbWrite('scn_shared'));
    // What `createProjectFromScenes()` does: the same id in two manifests.
    await writeSceneDocument(two, 'scn_shared', glbWrite('scn_shared'));

    expect(readSceneOwner('scn_shared')?.projectIds).toEqual([P1, P2]);
  });

  it('deleting a shared scene drops only the caller’s claim', async () => {
    const one = await open(P1);
    const two = await open(P2);
    await writeSceneDocument(one, 'scn_shared', glbWrite('scn_shared'));
    await writeSceneDocument(two, 'scn_shared', glbWrite('scn_shared'));

    await one.deleteDocument('scn_shared');

    // The other owner still has it — and the body is still there.
    expect(readSceneOwner('scn_shared')?.projectIds).toEqual([P2]);
    expect(readSceneGlbPointer('scn_shared')).not.toBeNull();
  });

  it('the last owner deleting takes the body and the marker with it', async () => {
    const one = await open(P1);
    await writeSceneDocument(one, 'scn_only', glbWrite('scn_only'));

    await one.deleteDocument('scn_only');

    expect(readSceneGlbPointer('scn_only')).toBeNull();
    expect(readScene('scn_only')).toBeNull();
    expect(readSceneOwner('scn_only')).toBeNull();
    expect(listMetas()).toEqual([]);
  });

  it('two manifests coexist under separate keys', async () => {
    const one = await open(P1);
    const two = await open(P2);
    await one.writeManifest({ schemaVersion: 1, id: P1, name: 'One' });
    await two.writeManifest({ schemaVersion: 1, id: P2, name: 'Two' });

    expect((await one.readManifest())?.name).toBe('One');
    expect((await two.readManifest())?.name).toBe('Two');
  });
});

// ─── No catalogue is derived any more (plan-716 Phase 6) ────────────────
//
// The `adoptsUnowned` describe block stood here. It pinned which backend
// adopted an owner-less `rv-scenes-index` row into its listing — a rule that
// only meant anything while a listing was DERIVED from that index. Nothing
// derives one now, so the three cases had no behaviour left to assert; the
// eager migration converts those rows into documents of "My Workspace" before
// any backend is asked what it holds (workspace-migration.test.ts).

describe('BrowserBackend — the index is not a listing', () => {
  it('an index row with no manifest entry is invisible to the backend', async () => {
    writeSceneBody(scene('scn_legacy'));            // pre-migration, no marker
    const backend = await open(P1);
    expect(await backend.listDocuments()).toEqual([]);
    // Untouched, though: retiring it is the migration's job, not the backend's.
    expect(readScene('scn_legacy')?.name).toBe('scn_legacy');
  });

  it('a marker alone does not make a row a document either', async () => {
    writeSceneBody(scene('scn_legacy'));
    noteSceneMembership('scn_legacy', P2);
    setCachedFrom('scn_legacy', P2);

    const backend = await open(P2);
    expect(await backend.listDocuments()).toEqual([]);
    expect(readSceneOwner('scn_legacy')?.cachedFrom).toBe(P2);
  });
});

// ─── Manifest ───────────────────────────────────────────────────────────

describe('BrowserBackend — manifest', () => {
  it('synthesises a manifest when none is stored', async () => {
    const backend = new BrowserBackend(P1, { name: 'My scenes', requestPersistence: false });
    const manifest = await backend.readManifest();
    expect(manifest?.id).toBe(P1);
    expect(manifest?.name).toBe('My scenes');
    expect(sceneDocumentsOf(manifest)).toEqual([]);
  });

  it('stores every document row it is given, and reads them all back', async () => {
    // The mirror image of what this file used to assert. The manifest was the
    // untrusted half — a `scn_` scene row was dropped on write and re-derived
    // from the index on read — and since plan-716 Phase 6 it is the ONLY half,
    // so a row that goes in has to come back out.
    const backend = await open(P1);
    await backend.writeManifest({
      schemaVersion: 1,
      id: P1,
      name: 'One',
      documents: [{ id: 'doc_real', name: 'Real', path: 'scenes/Real.glb', section: 'scenes' }],
    });

    expect(sceneDocumentsOf(await backend.readManifest()).map(e => e.id)).toEqual(['doc_real']);
    expect((await backend.listDocuments()).map(d => d.id)).toEqual(['doc_real']);
  });

  it('keeps what the index cannot express', async () => {
    const backend = await open(P1);
    await backend.writeManifest({
      schemaVersion: 1,
      id: P1,
      name: 'One',
      hidden: ['published:demo'],
      activeSceneId: 'scn_real',
      documents: [
        { id: 'doc_a', name: 'A', path: 'models/a.glb', label: 'A', section: 'models' },
        { id: 'doc_b', name: 'b', path: 'library/b.glb', section: 'library' },
      ],
    });

    const manifest = await backend.readManifest();
    expect(manifest?.hidden).toEqual(['published:demo']);
    expect(manifest?.activeSceneId).toBe('scn_real');
    expect(await backend.listModels()).toMatchObject([{ path: 'models/a.glb', label: 'A' }]);
    expect(await backend.listLibrary()).toMatchObject([{ path: 'library/b.glb' }]);
  });

  it('a corrupt manifest reads as absent, not as a throw', async () => {
    localStorage.setItem(browserManifestKey(P1), 'not json');
    const backend = new BrowserBackend(P1, { requestPersistence: false });
    expect((await backend.readManifest())?.id).toBe(P1);
  });
});

// ─── Blobs (real OPFS) ──────────────────────────────────────────────────

describe('BrowserBackend — blobs go to OPFS', () => {
  it('stores and resolves a blob by its manifest path', async () => {
    const backend = await open(P1);
    await writeBlobDocument(backend, 'models/cell.glb', new Blob(['glb-bytes']));

    const resolved = await backend.readDocumentUrl('models/cell.glb');
    expect(resolved).not.toBeNull();
    expect(await (await fetch(resolved!.url)).text()).toBe('glb-bytes');
    resolved!.release();
  });

  it('keys by content, so identical bytes under two paths cost one copy', async () => {
    const backend = await open(P1);
    const sha = await sha256OfBlob(new Blob(['same']));
    await writeBlobDocument(backend, 'models/a.glb', new Blob(['same']));
    await writeBlobDocument(backend, 'library/b.glb', new Blob(['same']));

    const index = JSON.parse(localStorage.getItem(browserBlobIndexKey(P1))!);
    expect(index['models/a.glb']).toBe(sha);
    expect(index['library/b.glb']).toBe(sha);
  });

  it('resolves a bare digest as well as a mapped path', async () => {
    const backend = await open(P1);
    const sha = await sha256OfBlob(new Blob(['direct']));
    await writeBlobDocument(backend, 'models/d.glb', new Blob(['direct']));

    const resolved = await backend.readDocumentUrl(sha);
    expect(resolved).not.toBeNull();
    resolved!.release();
  });

  it('returns null for an unknown path instead of a dead url', async () => {
    const backend = await open(P1);
    expect(await backend.readDocumentUrl('models/missing.glb')).toBeNull();
  });

  it('unmapping a path keeps bytes another path still references', async () => {
    const backend = await open(P1);
    await writeBlobDocument(backend, 'models/a.glb', new Blob(['same']));
    await writeBlobDocument(backend, 'models/b.glb', new Blob(['same']));

    await backend.deleteDocument('models/a.glb');

    expect(await backend.readDocumentUrl('models/a.glb')).toBeNull();
    const still = await backend.readDocumentUrl('models/b.glb');
    expect(still).not.toBeNull();
    still!.release();
  });

  it('unmapping the last reference removes the bytes', async () => {
    const backend = await open(P1);
    const sha = await sha256OfBlob(new Blob(['lonely']));
    await writeBlobDocument(backend, 'models/only.glb', new Blob(['lonely']));

    await backend.deleteDocument('models/only.glb');

    const { hasBlob } = await import('../src/core/storage/rv-opfs-blobs');
    expect(await hasBlob(sha)).toBe(false);
  });

  it('release() is the backend contract over the store’s revokeUrl()', async () => {
    const backend = await open(P1);
    await writeBlobDocument(backend, 'models/r.glb', new Blob(['r']));
    const resolved = await backend.readDocumentUrl('models/r.glb');
    resolved!.release();
    expect(() => resolved!.release()).not.toThrow();
  });
});

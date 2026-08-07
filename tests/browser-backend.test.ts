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

// ─── Fixtures ───────────────────────────────────────────────────────────

const P1 = 'prj_browser_one';
const P2 = 'prj_browser_two';

function scene(id: string, name = id): RvScene {
  return {
    id,
    name,
    createdAt: '2025-01-01T00:00:00.000Z',
    modifiedAt: '2025-01-01T00:00:00.000Z',
    schemaVersion: 2,
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
    await expect(backend.writeScene('scn_x', scene('scn_x'))).rejects.toBeInstanceOf(
      BackendNotWritableError,
    );
    await expect(backend.deleteScene('scn_x')).rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(backend.writeBlob('models/a.glb', new Blob(['x']))).rejects.toBeInstanceOf(
      BackendNotWritableError,
    );
  });

  it('reading works before activation — discovery must not need a write gate', async () => {
    writeSceneBody(scene('scn_r'));
    noteSceneMembership('scn_r', P1);
    const backend = new BrowserBackend(P1, { requestPersistence: false });

    expect((await backend.listScenes()).map(e => e.id)).toEqual(['scn_r']);
    expect((await backend.readScene('scn_r'))?.id).toBe('scn_r');
  });

  it('deactivate closes the gate again and is idempotent', async () => {
    const backend = await open(P1);
    await backend.deactivate();
    await backend.deactivate();
    expect(backend.isActive).toBe(false);
    await expect(backend.writeScene('scn_x', scene('scn_x'))).rejects.toBeInstanceOf(
      BackendNotWritableError,
    );
  });

  it('addresses a scene by id, `scenes/<id>` or `<id>.scene.json` alike', () => {
    expect(sceneIdOfPath('scn_a')).toBe('scn_a');
    expect(sceneIdOfPath('scenes/scn_a')).toBe('scn_a');
    expect(sceneIdOfPath('scenes/scn_a.scene.json')).toBe('scn_a');
    expect(sceneIdOfPath('')).toBe('');
  });

  it('refuses a path that addresses a different scene', async () => {
    const backend = await open(P1);
    await expect(backend.writeScene('scn_other', scene('scn_a'))).rejects.toThrow(/scn_a/);
  });
});

// ─── The keyspace is not migrated (§2.5) ────────────────────────────────

describe('BrowserBackend — the scene keyspace is untouched', () => {
  it('writes exactly the bytes the storage module writes, at the same key', async () => {
    const backend = await open(P1);
    await backend.writeScene('scn_a', scene('scn_a', 'Cell 1'));

    // The historic key, with no project prefix anywhere.
    const raw = localStorage.getItem('rv-scenes/scn_a');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).name).toBe('Cell 1');
    expect(readScene('scn_a')?.name).toBe('Cell 1');
    // And the index the old build reads is updated the same way.
    expect(listMetas().map(m => m.id)).toEqual(['scn_a']);
  });

  it('introduces no key outside its own additive namespace', async () => {
    const backend = await open(P1);
    await backend.writeScene('scn_a', scene('scn_a'));
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
        key.startsWith('rv-scene-owner/') ||
        key.startsWith('rv-project/browser/');
      expect(known, `unexpected key "${key}"`).toBe(true);
    }
    expect(localStorage.getItem(browserManifestKey(P1))).not.toBeNull();
  });

  it('records membership but never provenance', async () => {
    const backend = await open(P1);
    await backend.writeScene('scn_a', scene('scn_a'));

    const owner = readSceneOwner('scn_a');
    expect(owner?.projectIds).toEqual([P1]);
    // localStorage IS the store here, not a mirror of a file. Claiming an
    // origin would make a folder project treat the only copy as a stale cache.
    expect(owner?.cachedFrom).toBeNull();
  });
});

// ─── Several browser projects, one flat keyspace (§5.1 M2) ──────────────

describe('BrowserBackend — two browser projects share the keyspace safely', () => {
  it('each project lists only its own scenes', async () => {
    const one = await open(P1);
    const two = await open(P2);
    await one.writeScene('scn_1', scene('scn_1', 'Line A'));
    await two.writeScene('scn_2', scene('scn_2', 'Line B'));

    expect((await one.listScenes()).map(e => e.id)).toEqual(['scn_1']);
    expect((await two.listScenes()).map(e => e.id)).toEqual(['scn_2']);
    // Both bodies are in the one index — the separation is the marker, not
    // the keyspace.
    expect(listMetas().map(m => m.id).sort()).toEqual(['scn_1', 'scn_2']);
  });

  it('neither can overwrite the other: distinct ids are distinct bodies', async () => {
    const one = await open(P1);
    const two = await open(P2);
    await one.writeScene('scn_1', scene('scn_1', 'Line A'));
    await two.writeScene('scn_2', scene('scn_2', 'Line B'));

    expect(readScene('scn_1')?.name).toBe('Line A');
    expect(readScene('scn_2')?.name).toBe('Line B');
  });

  it('a shared scene id is sharing, and both projects list it', async () => {
    const one = await open(P1);
    const two = await open(P2);
    await one.writeScene('scn_shared', scene('scn_shared'));
    // What `createProjectFromScenes()` does: the same id in two manifests.
    await two.writeScene('scn_shared', scene('scn_shared'));

    expect(readSceneOwner('scn_shared')?.projectIds).toEqual([P1, P2]);
    expect((await one.listScenes()).map(e => e.id)).toEqual(['scn_shared']);
    expect((await two.listScenes()).map(e => e.id)).toEqual(['scn_shared']);
  });

  it('deleting a shared scene drops only the caller’s claim', async () => {
    const one = await open(P1);
    const two = await open(P2);
    await one.writeScene('scn_shared', scene('scn_shared'));
    await two.writeScene('scn_shared', scene('scn_shared'));

    await one.deleteScene('scn_shared');

    // The other owner still has it — and the body is still there.
    expect(readSceneOwner('scn_shared')?.projectIds).toEqual([P2]);
    expect(readScene('scn_shared')).not.toBeNull();
    expect((await one.listScenes())).toEqual([]);
    expect((await two.listScenes()).map(e => e.id)).toEqual(['scn_shared']);
  });

  it('the last owner deleting takes the body and the marker with it', async () => {
    const one = await open(P1);
    await one.writeScene('scn_only', scene('scn_only'));

    await one.deleteScene('scn_only');

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

// ─── The Sample exception (§2.4) ────────────────────────────────────────

describe('BrowserBackend — adoptsUnowned', () => {
  it('the Sample tier lists marker-less scenes; a normal project does not', async () => {
    writeSceneBody(scene('scn_legacy'));            // pre-plan, no marker

    const sample = await open('prj_sample', { adoptsUnowned: true });
    const other = await open(P2);

    expect((await sample.listScenes()).map(e => e.id)).toEqual(['scn_legacy']);
    expect(await other.listScenes()).toEqual([]);
  });

  it('once a scene is marked, only its owner lists it', async () => {
    writeSceneBody(scene('scn_legacy'));
    noteSceneMembership('scn_legacy', P2);

    const sample = await open('prj_sample', { adoptsUnowned: true });
    const other = await open(P2);

    // Adoption is for *unowned* entries only — it never overrides evidence.
    expect(await sample.listScenes()).toEqual([]);
    expect((await other.listScenes()).map(e => e.id)).toEqual(['scn_legacy']);
  });

  it('a foreign cachedFrom does not make a scene unowned', async () => {
    writeSceneBody(scene('scn_x'));
    noteSceneMembership('scn_x', P2);
    setCachedFrom('scn_x', P2);

    const sample = await open('prj_sample', { adoptsUnowned: true });
    expect(await sample.listScenes()).toEqual([]);
  });
});

// ─── Manifest ───────────────────────────────────────────────────────────

describe('BrowserBackend — manifest', () => {
  it('synthesises a manifest when none is stored', async () => {
    const backend = new BrowserBackend(P1, { name: 'My scenes', requestPersistence: false });
    const manifest = await backend.readManifest();
    expect(manifest?.id).toBe(P1);
    expect(manifest?.name).toBe('My scenes');
    expect(manifest?.scenes).toEqual([]);
  });

  it('derives the scene list rather than trusting the stored copy', async () => {
    const backend = await open(P1);
    await backend.writeManifest({
      schemaVersion: 1,
      id: P1,
      name: 'One',
      // A stale list, of the kind a save through SceneStore would leave behind.
      scenes: [{ id: 'scn_ghost', name: 'ghost', path: 'scn_ghost' }],
    });
    await backend.writeScene('scn_real', scene('scn_real'));

    expect((await backend.readManifest())?.scenes?.map(e => e.id)).toEqual(['scn_real']);
  });

  it('keeps what the index cannot express', async () => {
    const backend = await open(P1);
    await backend.writeManifest({
      schemaVersion: 1,
      id: P1,
      name: 'One',
      hidden: ['published:demo'],
      activeSceneId: 'scn_real',
      models: [{ path: 'models/a.glb', label: 'A' }],
      library: [{ path: 'library/b.glb' }],
    });

    const manifest = await backend.readManifest();
    expect(manifest?.hidden).toEqual(['published:demo']);
    expect(manifest?.activeSceneId).toBe('scn_real');
    expect(await backend.listModels()).toEqual([{ path: 'models/a.glb', label: 'A' }]);
    expect(await backend.listLibrary()).toEqual([{ path: 'library/b.glb' }]);
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
    await backend.writeBlob('models/cell.glb', new Blob(['glb-bytes']));

    const resolved = await backend.readBlobUrl('models/cell.glb');
    expect(resolved).not.toBeNull();
    expect(await (await fetch(resolved!.url)).text()).toBe('glb-bytes');
    resolved!.release();
  });

  it('keys by content, so identical bytes under two paths cost one copy', async () => {
    const backend = await open(P1);
    const sha = await sha256OfBlob(new Blob(['same']));
    await backend.writeBlob('models/a.glb', new Blob(['same']));
    await backend.writeBlob('library/b.glb', new Blob(['same']));

    const index = JSON.parse(localStorage.getItem(browserBlobIndexKey(P1))!);
    expect(index['models/a.glb']).toBe(sha);
    expect(index['library/b.glb']).toBe(sha);
  });

  it('resolves a bare digest as well as a mapped path', async () => {
    const backend = await open(P1);
    const sha = await sha256OfBlob(new Blob(['direct']));
    await backend.writeBlob('models/d.glb', new Blob(['direct']));

    const resolved = await backend.readBlobUrl(sha);
    expect(resolved).not.toBeNull();
    resolved!.release();
  });

  it('returns null for an unknown path instead of a dead url', async () => {
    const backend = await open(P1);
    expect(await backend.readBlobUrl('models/missing.glb')).toBeNull();
  });

  it('unmapping a path keeps bytes another path still references', async () => {
    const backend = await open(P1);
    await backend.writeBlob('models/a.glb', new Blob(['same']));
    await backend.writeBlob('models/b.glb', new Blob(['same']));

    await backend.deleteBlob('models/a.glb');

    expect(await backend.readBlobUrl('models/a.glb')).toBeNull();
    const still = await backend.readBlobUrl('models/b.glb');
    expect(still).not.toBeNull();
    still!.release();
  });

  it('unmapping the last reference removes the bytes', async () => {
    const backend = await open(P1);
    const sha = await sha256OfBlob(new Blob(['lonely']));
    await backend.writeBlob('models/only.glb', new Blob(['lonely']));

    await backend.deleteBlob('models/only.glb');

    const { hasBlob } = await import('../src/core/storage/rv-opfs-blobs');
    expect(await hasBlob(sha)).toBe(false);
  });

  it('release() is the backend contract over the store’s revokeUrl()', async () => {
    const backend = await open(P1);
    await backend.writeBlob('models/r.glb', new Blob(['r']));
    const resolved = await backend.readBlobUrl('models/r.glb');
    resolved!.release();
    expect(() => resolved!.release()).not.toThrow();
  });
});

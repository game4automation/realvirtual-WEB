// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-storage-backend.test — plan-397 §9.7, phase 5.
 *
 * The backend contract of §2.7/§2.8, pinned against both writable backends.
 * What is under test is **not** whether a GLB is well-formed — nothing in
 * this layer parses one, by design — but whether the storage guarantees hold:
 *
 *  1. a scene body reaches OPFS without a project, and the project folder
 *     with one;
 *  2. a refused persistence grant is visible rather than silent, because the
 *     bodies now live in an evictable store;
 *  3. a write whose expected revision no longer matches is a **conflict**,
 *     not an overwrite — including when the mismatch was caused by an editor
 *     outside the browser touching the project folder;
 *  4. a write that fails leaves the previous body byte-for-byte intact, and
 *     creates nothing where there was nothing.
 *
 * Point 4 is the one that needs a word about the fake: `FakeFile.createWritable`
 * stages into a buffer and commits on `close()`, exactly as the real File
 * System Access API does. Against a fake that committed inside `write()` the
 * assertion would be vacuous.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeDir, asDirHandle, namedError } from './helpers/fake-fs-handles';
import { glbBytes, glbWrite } from './helpers/scene-write';
import { BrowserBackend } from '../src/core/project/backends/browser-backend';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import {
  SceneRevisionConflictError,
  revisionOfBytes,
} from '../src/core/project/rv-scene-record';
import {
  RV_PROJECT_SCHEMA_VERSION,
  sceneGlbRelPathFor,
  type RvProject,
} from '../src/core/project/rv-project-types';
import { clearAllScenes } from '../src/core/hmi/scene/rv-scene-storage';
import { clearAllSceneOwners } from '../src/core/project/rv-scene-owner';
import {
  clearAllBlobs,
  listBlobs,
  onBlobStoreNotice,
  type BlobStoreNotice,
} from '../src/core/storage/rv-opfs-blobs';
import { readSceneGlbPointer } from '../src/core/storage/rv-scene-glb-store';
import {
  readSceneGlbBody,
  writeSceneGlbBody,
} from '../src/core/hmi/scene/rv-scene-glb-io';
import {
  announceSceneWrite,
  clearSceneSyncNotices,
  closeSceneSyncChannel,
  onSceneSyncNotice,
  reportSceneConflict,
  type SceneSyncNotice,
} from '../src/core/hmi/scene/rv-scene-live-sync';
import { sceneDocumentsOf } from '../src/core/project/rv-project-documents';

// ─── Fixtures ───────────────────────────────────────────────────────────

const PRJ = 'prj_397';
const SCENE = { id: 'scn_press', name: 'Press cell' };
const REL = sceneGlbRelPathFor(SCENE);

/** A project folder with a manifest that already knows the scene. */
function folderWithScene(): FakeDir {
  const root = new FakeDir('customer');
  const manifest: RvProject = {
    schemaVersion: RV_PROJECT_SCHEMA_VERSION,
    id: PRJ,
    name: 'Customer',
    scenes: [{ id: SCENE.id, name: SCENE.name, path: REL, format: 'glb' }],
  };
  root.seedText('project.json', JSON.stringify(manifest));
  return root;
}

async function openFolder(root: FakeDir): Promise<FolderBackend> {
  const backend = new FolderBackend(asDirHandle(root), { writable: true });
  await backend.activate();
  return backend;
}

async function openBrowser(): Promise<BrowserBackend> {
  const backend = new BrowserBackend(PRJ, { requestPersistence: false });
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

// ─── Where the bytes land ───────────────────────────────────────────────

describe('Ablage — where a scene body goes', () => {
  it('writes to OPFS when there is no project folder', async () => {
    const backend = await openBrowser();
    const revision = await backend.writeScene(SCENE.id, glbWrite(SCENE.id, SCENE.name));

    // The bytes are in the content-addressed store under their own digest…
    expect(await listBlobs()).toContain(revision);
    // …and localStorage holds a pointer, not a body.
    expect(readSceneGlbPointer(SCENE.id)?.sha).toBe(revision);

    const record = await backend.readScene(SCENE.id);
    expect(record?.glb).not.toBeNull();
    expect(record?.revision).toBe(revision);
  });

  it('writes into the project folder when there is one', async () => {
    const root = folderWithScene();
    const backend = await openFolder(root);
    const revision = await backend.writeScene(REL, glbWrite(SCENE.id, SCENE.name));

    const stored = await root.readTextAt('scenes', REL.split('/')[1]!);
    expect(stored).toContain(SCENE.id);
    expect(revision).toBe(await revisionOfBytes(glbBytes(SCENE.id, SCENE.name)));

    const record = await backend.readScene(REL);
    expect(record?.glb).toBeTruthy();
    expect(record?.meta.id).toBe(SCENE.id);
    expect(record?.revision).toBe(revision);
  });

  it('lists scenes from the manifest without reading a single body', async () => {
    const root = folderWithScene();
    const backend = await openFolder(root);
    await backend.writeScene(REL, glbWrite(SCENE.id, SCENE.name));

    // Any read of the body would trip this.
    root.failures.fail({ point: 'getFile', name: REL.split('/')[1]! });
    expect((sceneDocumentsOf(await backend.readManifest())).map(e => e.id)).toEqual([SCENE.id]);
  });
});

// ─── Persistence grant (§2.8, open question 2) ──────────────────────────

describe('Persistenz-Grant', () => {
  it('surfaces a refused grant instead of failing or hiding it', async () => {
    const seen: BlobStoreNotice[] = [];
    const off = onBlobStoreNotice(n => seen.push(n));
    const storage = navigator.storage as unknown as Record<string, unknown>;
    const realPersist = storage.persist;
    const realPersisted = storage.persisted;
    storage.persist = async () => false;
    storage.persisted = async () => false;

    try {
      const backend = new BrowserBackend(PRJ, { requestPersistence: true });
      await backend.activate();

      // Refused — and said so, on the backend and on the notice channel.
      expect(backend.persistenceGranted).toBe(false);
      expect(seen.some(n => n.kind === 'not-persisted')).toBe(true);

      // …and the user keeps working. That is the decision on open question 2:
      // a warning, never a block.
      const revision = await backend.writeScene(SCENE.id, glbWrite(SCENE.id));
      expect(await listBlobs()).toContain(revision);
    } finally {
      storage.persist = realPersist;
      storage.persisted = realPersisted;
      off();
    }
  });
});

// ─── Revision preconditions (§2.8) ──────────────────────────────────────

describe('Nebenläufigkeit — Revision statt Verlust', () => {
  it('folder: a stale expected revision is a conflict, not an overwrite', async () => {
    const root = folderWithScene();
    const backend = await openFolder(root);
    const first = await backend.writeScene(REL, glbWrite(SCENE.id, 'v1'));
    const second = await backend.writeScene(REL, { ...glbWrite(SCENE.id, 'v2'), expectedRevision: first });

    await expect(
      backend.writeScene(REL, { ...glbWrite(SCENE.id, 'v3'), expectedRevision: first }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);

    // The loser changed nothing: v2 is still what is stored.
    expect((await backend.readScene(REL))?.revision).toBe(second);
    expect(await root.readTextAt('scenes', REL.split('/')[1]!)).toContain('v2');
  });

  it('browser: two tabs, and the second one is told instead of winning', async () => {
    const tabA = await openBrowser();
    const tabB = await openBrowser();          // same keyspace, same project
    const base = await tabA.writeScene(SCENE.id, glbWrite(SCENE.id, 'v1'));

    // Both tabs read `base`; A saves first.
    await tabA.writeScene(SCENE.id, { ...glbWrite(SCENE.id, 'A'), expectedRevision: base });
    await expect(
      tabB.writeScene(SCENE.id, { ...glbWrite(SCENE.id, 'B'), expectedRevision: base }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);

    expect(new TextDecoder().decode((await tabA.readScene(SCENE.id))!.glb!)).toContain(':A');
  });

  it('expecting "new" fails once something is stored', async () => {
    const backend = await openBrowser();
    await backend.writeScene(SCENE.id, glbWrite(SCENE.id));
    await expect(
      backend.writeScene(SCENE.id, { ...glbWrite(SCENE.id), expectedRevision: null }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);
  });

  it('an omitted expectation writes unconditionally — the migrator’s escape hatch', async () => {
    const backend = await openBrowser();
    await backend.writeScene(SCENE.id, glbWrite(SCENE.id, 'v1'));
    const revision = await backend.writeScene(SCENE.id, glbWrite(SCENE.id, 'v2'));
    expect(readSceneGlbPointer(SCENE.id)?.sha).toBe(revision);
  });

  it('an external change to the project folder is detected as a conflict', async () => {
    const root = folderWithScene();
    const backend = await openFolder(root);
    const mine = await backend.writeScene(REL, glbWrite(SCENE.id, 'mine'));

    // Someone else — a git pull, a second app, a text editor — replaces the
    // file. Nothing announces it; the only evidence is the changed bytes.
    root.seedDir('scenes').seedText(REL.split('/')[1]!, 'someone else wrote this');

    await expect(
      backend.writeScene(REL, { ...glbWrite(SCENE.id, 'mine2'), expectedRevision: mine }),
    ).rejects.toBeInstanceOf(SceneRevisionConflictError);
    // And their content is still there — we did not silently win.
    expect(await root.readTextAt('scenes', REL.split('/')[1]!)).toBe('someone else wrote this');
  });
});

// ─── Atomicity (§2.8) ───────────────────────────────────────────────────

describe('Atomarer Ersatz — kein Teilzustand', () => {
  it('a failed write leaves the previous body byte-for-byte intact', async () => {
    const root = folderWithScene();
    const backend = await openFolder(root);
    const good = await backend.writeScene(REL, glbWrite(SCENE.id, 'good'));
    const before = await root.readTextAt('scenes', REL.split('/')[1]!);

    root.failures.fail({ point: 'write', name: REL.split('/')[1]!, times: 1 });
    await expect(backend.writeScene(REL, glbWrite(SCENE.id, 'doomed'))).rejects.toThrow();

    expect(await root.readTextAt('scenes', REL.split('/')[1]!)).toBe(before);
    expect((await backend.readScene(REL))?.revision).toBe(good);
  });

  it('a failed first write leaves no zero-byte file behind', async () => {
    const root = folderWithScene();
    const backend = await openFolder(root);

    root.failures.fail({
      point: 'write',
      name: REL.split('/')[1]!,
      error: namedError('QuotaExceededError', 'disk full'),
    });
    await expect(backend.writeScene(REL, glbWrite(SCENE.id))).rejects.toThrow(/disk full/);

    // "No scene here" must not have become "a scene with an empty body" —
    // the second is a corrupt file where the first was merely an absent one.
    root.failures.clear();
    expect(await backend.readScene(REL)).toBeNull();
    const scenes = await root.getDirectoryHandle('scenes').catch(() => null);
    expect(scenes?.childNames() ?? []).not.toContain(REL.split('/')[1]!);
  });
});

// ─── Phase 6: the write path that finally uses all this ─────────────────
//
// Phases 5 built the contract and left it without a production caller. These
// pin the three things phase 6 added on top of it: a body reaches storage
// WITHOUT a project at all, a refused grant is visible to the UI rather than
// only to the backend, and a second tab's write turns the next autosave into a
// conflict instead of an overwrite.

describe('Ablage ohne Projekt (phase 6)', () => {
  it('writes a scene body to OPFS when no writable project is open', async () => {
    // No project store is attached in this suite, so `writableBackend()` finds
    // nothing — which is the DEFAULT case in the field, not an edge case: the
    // fallback backend a user without a folder project gets is the bundled
    // one, and that is read-only.
    const result = await writeSceneGlbBody({
      sceneId: 'scn_no_project',
      name: 'No project',
      glb: glbBytes('body-1'),
      expectedRevision: null,
    });

    expect(result.target).toBe('opfs');
    expect(readSceneGlbPointer('scn_no_project')?.sha).toBe(result.revision);

    const back = await readSceneGlbBody('scn_no_project');
    expect(back?.glb).toEqual(glbBytes('body-1'));
    expect(back?.target).toBe('opfs');
  });

  it('refuses a second write whose expected revision is stale', async () => {
    const first = await writeSceneGlbBody({
      sceneId: 'scn_cas', name: 'CAS', glb: glbBytes('v1'), expectedRevision: null,
    });
    // A second tab writes in between.
    await writeSceneGlbBody({
      sceneId: 'scn_cas', name: 'CAS', glb: glbBytes('v2'), expectedRevision: first.revision,
    });

    // This tab still believes in the first revision.
    await expect(writeSceneGlbBody({
      sceneId: 'scn_cas', name: 'CAS', glb: glbBytes('v3'), expectedRevision: first.revision,
    })).rejects.toBeInstanceOf(SceneRevisionConflictError);

    // And the other tab's body is intact — a conflict is not a partial write.
    const body = await readSceneGlbBody('scn_cas');
    expect(body?.glb).toEqual(glbBytes('v2'));
  });

  it('an unconditional write is the migrator escape hatch, not the default', async () => {
    await writeSceneGlbBody({
      sceneId: 'scn_force', name: 'F', glb: glbBytes('v1'), expectedRevision: null,
    });
    const forced = await writeSceneGlbBody({
      sceneId: 'scn_force', name: 'F', glb: glbBytes('v2'), // expectedRevision omitted
    });
    expect((await readSceneGlbBody('scn_force'))?.glb).toEqual(glbBytes('v2'));
    expect(readSceneGlbPointer('scn_force')?.sha).toBe(forced.revision);
  });
});

describe('Zwei-Tab-Hinweis und Konfliktmeldung (phase 6)', () => {
  afterEach(() => {
    clearSceneSyncNotices();
    closeSceneSyncChannel();
  });

  it('makes a refused save visible instead of leaving the autosave silently dead', () => {
    const seen: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice(n => seen.push(n));
    try {
      reportSceneConflict('Press cell');
      const conflict = seen.find(n => n.kind === 'conflict');
      expect(conflict).toBeDefined();
      // The message has to name the scene and say what to do — a user whose
      // autosave stopped cannot act on "a conflict occurred".
      expect(conflict!.message).toContain('Press cell');
      expect(conflict!.message).toMatch(/new name/i);
    } finally {
      off();
    }
  });

  it('replays the conflict to a listener that subscribes afterwards', () => {
    // The shell mounts after boot, and a write can fail before it does.
    reportSceneConflict('Late');
    const seen: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice(n => seen.push(n));
    off();
    expect(seen.map(n => n.kind)).toContain('conflict');
  });

  it('does not report a tab its own broadcast', async () => {
    const seen: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice(n => seen.push(n));
    try {
      announceSceneWrite('scn_x', 'rev1');
      await new Promise(r => setTimeout(r, 50));
      expect(seen.some(n => n.kind === 'other-tab')).toBe(false);
    } finally {
      off();
    }
  });

  it('turns another tab’s broadcast into a hint, never a lock', async () => {
    const seen: SceneSyncNotice[] = [];
    const off = onSceneSyncNotice(n => seen.push(n));
    // A second tab is a second BroadcastChannel on the same name.
    const other = new BroadcastChannel('rv-scene-writes');
    try {
      // Make sure this tab's channel exists and is listening.
      announceSceneWrite('scn_y', 'rev0');
      other.postMessage({ tab: 'some-other-tab', slot: 'scn_y', revision: 'rev1' });
      await new Promise(r => setTimeout(r, 100));

      const hint = seen.find(n => n.kind === 'other-tab');
      expect(hint).toBeDefined();
      expect(hint!.message).toMatch(/another tab/i);
    } finally {
      other.close();
      off();
    }
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-migration.test — plan-372 §9.3.
 *
 * The migration's promise is unusually strong and unusually easy to break:
 * **nothing that exists is changed.** So the central assertion here is not
 * "the right project id was written" — it is a byte-for-byte snapshot of
 * localStorage taken before the run and compared after, with the additive
 * `rv-scene-owner/*` keys removed. If any existing key drifts by a single
 * character, that comparison fails.
 *
 * Covered:
 *  - loose index entries land in the Sample project's user tier
 *  - **only** `rv-scene-owner/<id>` is written; index, bodies, active pointer
 *    and both draft keyspaces come out identical
 *  - the combined case §9.3 asks for by name: loose scenes **and** an
 *    existing folder project at the same time
 *  - already-granted handles are consulted with `queryPermission` only —
 *    `requestPermission` is never called
 *  - multi-ownership from `createProjectFromScenes` survives untouched
 *  - the marker is removed when a scene is deleted (no orphan growth)
 *  - **rollback:** after the migration layer is undone, storage is exactly
 *    what it was
 *  - the Working-Folder offer appears once and respects a refusal for good,
 *    without touching the `workfolder` handle slot
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import {
  LS_KEY_MIGRATION_STATE,
  LS_KEY_WORKFOLDER_OFFER,
  acceptWorkFolderOffer,
  declineWorkFolderOffer,
  findGrantedFolderScenes,
  installSceneOwnerCleanup,
  migrateLooseScenesToSample,
  pruneSceneOwners,
  readWorkFolderOffer,
  resetWorkFolderOffer,
  rollbackMigration,
  shouldOfferWorkFolderAsProject,
} from '../src/core/project/rv-project-migration';
import { SAMPLE_PROJECT_ID } from '../src/core/project/backends/bundled-backend';
import {
  clearAllSceneOwners,
  listSceneOwnerIds,
  noteSceneMembership,
  readSceneOwner,
  setCachedFrom,
} from '../src/core/project/rv-scene-owner';
import {
  clearAllScenes,
  listMetas,
  writeScene,
  writeActiveId,
  writeDraft,
  writeSceneDraft,
} from '../src/core/hmi/scene/rv-scene-storage';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import {
  clearSceneMutationListeners,
  emitSceneMutation,
} from '../src/core/hmi/scene/rv-scene-mutations';
import {
  HANDLE_KEY_WORKFOLDER,
  deleteStoredHandle,
  projectHandleKey,
  putHandle,
} from '../src/core/engine/rv-local-filesystem';
import {
  PROJECT_MANIFEST_FILE,
  RV_PROJECT_SCHEMA_VERSION,
  type RvProject,
} from '../src/core/project/rv-project-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

function scene(id: string, name: string): RvScene {
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

/** A folder project on disk, with a manifest listing `sceneIds`. */
function folderProject(name: string, id: string, sceneIds: string[]): FakeDir {
  const dir = new FakeDir(name);
  const manifest: RvProject = {
    schemaVersion: RV_PROJECT_SCHEMA_VERSION,
    id,
    name,
    canonicalName: name.toLowerCase(),
    scenes: sceneIds.map(s => ({ id: s, name: s, path: `scenes/${s}.scene.json` })),
  };
  dir.seedText(PROJECT_MANIFEST_FILE, JSON.stringify(manifest));
  return dir;
}

/** Every localStorage key/value, so "nothing changed" can be asserted literally. */
function snapshotStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    out[k] = localStorage.getItem(k)!;
  }
  return out;
}

function withoutOwnerKeys(snap: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(snap)) {
    if (!k.startsWith('rv-scene-owner/')) out[k] = v;
  }
  return out;
}

/**
 * The pre-plan world: three loose scenes, an active pointer and both kinds of
 * draft — i.e. every keyspace §2.4 promises not to touch.
 */
function seedLegacyWorld(): string[] {
  const ids = ['scn_a', 'scn_b', 'scn_c'];
  for (const id of ids) writeScene(scene(id, `Scene ${id}`));
  writeActiveId('scn_b');
  writeDraft({ kind: 'empty' }, scene('scn_draft', 'unsaved'));
  writeSceneDraft('scn_a', scene('scn_a', 'Scene scn_a edited'));
  return ids;
}

async function wipeHandles(): Promise<void> {
  for (const k of [
    HANDLE_KEY_WORKFOLDER,
    projectHandleKey('prj_folder'),
    projectHandleKey('prj_lapsed'),
  ]) {
    await deleteStoredHandle(k);
  }
}

beforeEach(async () => {
  localStorage.clear();
  clearAllScenes();
  clearAllSceneOwners();
  clearSceneMutationListeners();
  await wipeHandles();
});

afterEach(async () => {
  clearSceneMutationListeners();
  localStorage.clear();
  await wipeHandles();
});

// ─── Assignment ─────────────────────────────────────────────────────────

describe('migration — loose scenes join the Sample user tier', () => {
  it('gives every unowned index entry a Sample marker', async () => {
    const ids = seedLegacyWorld();
    const result = await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });

    expect(result.written.sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(readSceneOwner(id)?.projectIds).toEqual([SAMPLE_PROJECT_ID]);
    }
    expect(result.assignments.every(a => a.via === 'sample')).toBe(true);
  });

  it('leaves `cachedFrom` alone — membership is not provenance', async () => {
    seedLegacyWorld();
    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    // A body that was never read from a project has no origin, and claiming
    // one would arm the "folder wins" default against the only copy.
    expect(readSceneOwner('scn_a')?.cachedFrom).toBeNull();
  });

  it('is idempotent — a second run writes nothing', async () => {
    seedLegacyWorld();
    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    const after = snapshotStorage();

    const second = await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    expect(second.written).toEqual([]);
    expect(second.alreadyRan).toBe(true);
    expect(snapshotStorage()).toEqual(after);
  });

  it('never re-decides an entry that already has an owner', async () => {
    seedLegacyWorld();
    noteSceneMembership('scn_a', 'prj_customer');

    const result = await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });

    expect(readSceneOwner('scn_a')?.projectIds).toEqual(['prj_customer']);
    expect(result.assignments.find(a => a.sceneId === 'scn_a')?.via).toBe('already-marked');
    expect(result.written).not.toContain('scn_a');
  });

  it('preserves multi-ownership created by createProjectFromScenes', async () => {
    seedLegacyWorld();
    noteSceneMembership('scn_a', 'prj_one');
    noteSceneMembership('scn_a', 'prj_two');
    setCachedFrom('scn_a', 'prj_two');

    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });

    const owner = readSceneOwner('scn_a');
    expect(owner?.projectIds).toEqual(['prj_one', 'prj_two']);
    expect(owner?.cachedFrom).toBe('prj_two');
  });

  it('an empty index is a no-op, not a failure', async () => {
    const before = snapshotStorage();
    const result = await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    expect(result.written).toEqual([]);
    expect(withoutOwnerKeys(snapshotStorage())).toEqual({
      ...before,
      [LS_KEY_MIGRATION_STATE]: expect.any(String),
    });
  });
});

// ─── The invariant: nothing existing is changed ─────────────────────────

describe('migration — additive only (§2.4 leitsatz)', () => {
  it('writes rv-scene-owner keys and touches nothing else', async () => {
    seedLegacyWorld();
    const before = snapshotStorage();

    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    const after = snapshotStorage();

    // Every key that existed before is byte-identical.
    for (const [key, value] of Object.entries(before)) {
      expect(after[key], `key "${key}" changed`).toBe(value);
    }
    // Everything new is either the marker or the run's own state key.
    const added = Object.keys(after).filter(k => !(k in before));
    for (const key of added) {
      expect(key === LS_KEY_MIGRATION_STATE || key.startsWith('rv-scene-owner/')).toBe(true);
    }
    // And nothing was removed.
    expect(Object.keys(before).every(k => k in after)).toBe(true);
  });

  it('leaves the scene index, bodies and active pointer identical', async () => {
    const ids = seedLegacyWorld();
    const indexBefore = localStorage.getItem('rv-scenes-index');
    const bodiesBefore = ids.map(id => localStorage.getItem(`rv-scenes/${id}`));
    const activeBefore = localStorage.getItem('rv-scenes/active');

    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });

    expect(localStorage.getItem('rv-scenes-index')).toBe(indexBefore);
    expect(ids.map(id => localStorage.getItem(`rv-scenes/${id}`))).toEqual(bodiesBefore);
    expect(localStorage.getItem('rv-scenes/active')).toBe(activeBefore);
  });

  it('leaves both draft keyspaces identical', async () => {
    seedLegacyWorld();
    const drafts = Object.entries(snapshotStorage()).filter(([k]) =>
      k.startsWith('rv-scenes/draft/') || k.startsWith('rv-scenes/scene-draft/'),
    );
    expect(drafts.length).toBeGreaterThan(0);   // the fixture must be real

    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });

    for (const [key, value] of drafts) expect(localStorage.getItem(key)).toBe(value);
  });
});

// ─── The combined case §9.3 names explicitly ────────────────────────────

describe('migration — loose scenes AND an existing folder project', () => {
  const FOLDER_ID = 'prj_folder';

  /** Handle-store seams: IndexedDB cannot hold a FakeDir, so they are injected. */
  function seams(dirs: Record<string, FakeDir>) {
    return {
      listKeys: async () => Object.keys(dirs),
      getDir: async (key: string) => (dirs[key] ? asDirHandle(dirs[key]!) : null),
    };
  }

  it('attributes folder scenes to the folder and the rest to Sample', async () => {
    seedLegacyWorld();                                   // scn_a, scn_b, scn_c
    const folder = folderProject('CustomerX', FOLDER_ID, ['scn_b']);

    const result = await migrateLooseScenesToSample({
      handleSeams: seams({ [projectHandleKey(FOLDER_ID)]: folder }),
    });

    expect(readSceneOwner('scn_b')?.projectIds).toEqual([FOLDER_ID]);
    expect(readSceneOwner('scn_a')?.projectIds).toEqual([SAMPLE_PROJECT_ID]);
    expect(readSceneOwner('scn_c')?.projectIds).toEqual([SAMPLE_PROJECT_ID]);
    expect(result.consultedProjects).toEqual([FOLDER_ID]);
    expect(result.assignments.find(a => a.sceneId === 'scn_b')?.via).toBe('granted-folder');
  });

  it('consults with queryPermission only — it never prompts', async () => {
    seedLegacyWorld();
    const folder = folderProject('CustomerX', FOLDER_ID, ['scn_b']);

    await migrateLooseScenesToSample({
      handleSeams: seams({ [projectHandleKey(FOLDER_ID)]: folder }),
    });

    expect(folder.queryPermissionCalls).toBeGreaterThan(0);
    // A first-boot migration that raises a permission dialog is a migration
    // nobody lets finish — and its answer would decide data ownership.
    expect(folder.requestPermissionCalls).toBe(0);
  });

  it('a lapsed grant is not consulted, and its scenes fall to Sample', async () => {
    seedLegacyWorld();
    const lapsed = folderProject('Lapsed', 'prj_lapsed', ['scn_b']);
    lapsed.permissions = { read: 'prompt', readwrite: 'prompt' };

    const result = await migrateLooseScenesToSample({
      handleSeams: seams({ [projectHandleKey('prj_lapsed')]: lapsed }),
    });

    expect(lapsed.requestPermissionCalls).toBe(0);
    expect(readSceneOwner('scn_b')?.projectIds).toEqual([SAMPLE_PROJECT_ID]);
    expect(result.consultedProjects).toEqual([]);
  });

  it('a lapsed folder can still claim its scene later — the marker is 1:n', async () => {
    seedLegacyWorld();
    const lapsed = folderProject('Lapsed', 'prj_lapsed', ['scn_b']);
    lapsed.permissions = { read: 'prompt', readwrite: 'prompt' };
    await migrateLooseScenesToSample({
      handleSeams: seams({ [projectHandleKey('prj_lapsed')]: lapsed }),
    });

    // What happens when the user actually opens the project again.
    noteSceneMembership('scn_b', 'prj_lapsed');

    expect(readSceneOwner('scn_b')?.projectIds).toEqual([SAMPLE_PROJECT_ID, 'prj_lapsed']);
  });

  it('ignores non-project handle slots — the working folder is not a project', async () => {
    seedLegacyWorld();
    const work = folderProject('WorkFolder', 'prj_work', ['scn_a']);

    const result = await findGrantedFolderScenes(
      seams({ [HANDLE_KEY_WORKFOLDER]: work }),
    );

    expect(result.size).toBe(0);
    expect(work.queryPermissionCalls).toBe(0);
  });

  it('an unreadable manifest is no evidence, not an error', async () => {
    seedLegacyWorld();
    const broken = new FakeDir('Broken');
    broken.seedText(PROJECT_MANIFEST_FILE, '{ not json');

    const result = await migrateLooseScenesToSample({
      handleSeams: seams({ [projectHandleKey('prj_broken')]: broken }),
    });

    expect(result.consultedProjects).toEqual([]);
    expect(readSceneOwner('scn_a')?.projectIds).toEqual([SAMPLE_PROJECT_ID]);
  });
});

// ─── Marker hygiene ─────────────────────────────────────────────────────

describe('migration — the marker never outlives its scene', () => {
  it('removes the marker when a scene is deleted', async () => {
    seedLegacyWorld();
    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    const off = installSceneOwnerCleanup();

    emitSceneMutation({ type: 'delete', id: 'scn_a' });

    expect(readSceneOwner('scn_a')).toBeNull();
    expect(readSceneOwner('scn_b')).not.toBeNull();
    off();
  });

  it('unsubscribes cleanly', async () => {
    seedLegacyWorld();
    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    installSceneOwnerCleanup()();

    emitSceneMutation({ type: 'delete', id: 'scn_a' });

    expect(readSceneOwner('scn_a')).not.toBeNull();
  });

  it('ignores every other mutation type', async () => {
    seedLegacyWorld();
    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    const off = installSceneOwnerCleanup();

    emitSceneMutation({ type: 'active', id: 'scn_a' });
    emitSceneMutation({ type: 'upsert', id: 'scn_a', scene: scene('scn_a', 'x') });

    expect(readSceneOwner('scn_a')).not.toBeNull();
    off();
  });

  it('prunes orphans, but keeps folder-project scenes that are not in the index', async () => {
    seedLegacyWorld();
    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    // A scene that lives in a folder project and was never cached locally.
    noteSceneMembership('scn_folder_only', 'prj_folder');
    // A genuine orphan: marked, but in no index and no project.
    noteSceneMembership('scn_ghost', 'prj_gone');

    const removed = pruneSceneOwners(['scn_folder_only']);

    expect(removed).toEqual(['scn_ghost']);
    expect(listSceneOwnerIds().sort()).toEqual(
      [...listMetas().map(m => m.id), 'scn_folder_only'].sort(),
    );
  });
});

// ─── Rollback (the §9.3 acceptance criterion) ───────────────────────────

describe('migration — rollback', () => {
  it('restores storage byte-for-byte', async () => {
    seedLegacyWorld();
    const before = snapshotStorage();

    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    expect(listSceneOwnerIds().length).toBe(3);

    rollbackMigration();

    expect(snapshotStorage()).toEqual(before);
  });

  it('leaves every scene exactly where it was — an older build finds them all', async () => {
    const ids = seedLegacyWorld();
    const metasBefore = listMetas();

    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    rollbackMigration();

    expect(listMetas()).toEqual(metasBefore);
    for (const id of ids) expect(localStorage.getItem(`rv-scenes/${id}`)).not.toBeNull();
  });

  it('an older build ignores the marker while it is still there', async () => {
    // The forward half of the same property: a build that never reads
    // `rv-scene-owner/*` sees a completely unchanged scene index.
    const ids = seedLegacyWorld();
    const metasBefore = listMetas();
    await migrateLooseScenesToSample({ grantedFolderScenes: new Map() });
    expect(listMetas()).toEqual(metasBefore);
    expect(ids.every(id => localStorage.getItem(`rv-scenes/${id}`) !== null)).toBe(true);
  });
});

// ─── Working-Folder offer ───────────────────────────────────────────────

describe('migration — the Working-Folder offer', () => {
  const stub = (name: string) =>
    ({ name, kind: 'directory' }) as unknown as FileSystemDirectoryHandle;

  it('is not offered when there is no working folder', async () => {
    expect(await shouldOfferWorkFolderAsProject()).toBe(false);
  });

  it('is offered once when a working-folder handle exists', async () => {
    await putHandle(stub('my-work-folder'), HANDLE_KEY_WORKFOLDER);
    expect(await shouldOfferWorkFolderAsProject()).toBe(true);
  });

  it('a refusal is permanent', async () => {
    await putHandle(stub('my-work-folder'), HANDLE_KEY_WORKFOLDER);
    declineWorkFolderOffer();

    expect(readWorkFolderOffer()).toBe('declined');
    expect(await shouldOfferWorkFolderAsProject()).toBe(false);
  });

  it('acceptance also stops the offer', async () => {
    await putHandle(stub('my-work-folder'), HANDLE_KEY_WORKFOLDER);
    acceptWorkFolderOffer();

    expect(readWorkFolderOffer()).toBe('accepted');
    expect(await shouldOfferWorkFolderAsProject()).toBe(false);
  });

  it('records the decision at its OWN key — the handle slot stays untouched', async () => {
    await putHandle(stub('my-work-folder'), HANDLE_KEY_WORKFOLDER);
    declineWorkFolderOffer();

    // The decision lives here …
    expect(localStorage.getItem(LS_KEY_WORKFOLDER_OFFER)).toContain('declined');
    // … and the working folder itself is still exactly as it was. Encoding a
    // UI answer into the handle slot would make "declined" and "folder lost"
    // the same state.
    const { getHandle } = await import('../src/core/engine/rv-local-filesystem');
    expect((await getHandle(HANDLE_KEY_WORKFOLDER))?.name).toBe('my-work-folder');
  });

  it('reset makes the offer available again — support escape hatch', async () => {
    await putHandle(stub('my-work-folder'), HANDLE_KEY_WORKFOLDER);
    declineWorkFolderOffer();
    resetWorkFolderOffer();

    expect(readWorkFolderOffer()).toBe('pending');
    expect(await shouldOfferWorkFolderAsProject()).toBe(true);
  });

  it('a corrupt decision record reads as "never answered"', async () => {
    localStorage.setItem(LS_KEY_WORKFOLDER_OFFER, 'not json');
    expect(readWorkFolderOffer()).toBe('pending');
  });

  it('rollback clears the decision too', async () => {
    await putHandle(stub('my-work-folder'), HANDLE_KEY_WORKFOLDER);
    declineWorkFolderOffer();
    rollbackMigration();
    expect(readWorkFolderOffer()).toBe('pending');
  });
});

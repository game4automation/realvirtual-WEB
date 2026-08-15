// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-ownership — regression tests for the plan-373 data-loss fix.
 *
 * These started life as `spike-372-scene-ownership.test.ts`, where they
 * *asserted the bug*: one `sceneId` living in two projects, a cache with no
 * origin, `hydrateScene()` handing project A's body to project B and the save
 * path writing it onto B's own `.scene.glb`.
 *
 * The four bug assertions are inverted here. What stays untouched is the
 * cardinality half: a scene id belonging to more than one project is
 * deliberate behaviour of `createProjectFromScenes()` and remains the spec —
 * which is why the ownership marker is `projectIds: string[]`, 1:n.
 *
 * Covered:
 *   - `hydrateScene()` serves the OPEN project's body (project-store.ts);
 *   - a save inside B leaves B's file with B's content;
 *   - the conflict item names the project the cache came from;
 *   - a demonstrably foreign cache defaults to "the folder wins";
 *   - an UNKNOWN origin still takes the historic shortcut (additive fix).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { ProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { createProjectFromScenes } from '../src/core/project/rv-project-create';
import {
  clearAllSceneOwners,
  clearSceneOwner,
  readSceneOwner,
  writeSceneOwner,
} from '../src/core/project/rv-scene-owner';
import {
  clearSceneMutationListeners,
  emitSceneMutation,
} from '../src/core/hmi/scene/rv-scene-mutations';
import {
  clearAllScenes,
  listMetas,
  readScene,
  setDraftScope,
  writeScene,
} from '../src/core/hmi/scene/rv-scene-storage';
import { sceneGlbFileNameFor, type RvProject } from '../src/core/project/rv-project-types';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import { sceneDocumentsOf } from '../src/core/project/rv-project-documents';
import { revisionOfBytes } from '../src/core/project/rv-scene-record';

// ─── Fixtures ───────────────────────────────────────────────────────────

const SCENE_ID = 'scn_shared';
/**
 * Same display name in every variant, so both projects derive the SAME
 * `scenes/<file>.scene.glb` path and an overwrite would be observable.
 */
const SCENE_NAME = 'Cell';
const FILE_NAME = sceneGlbFileNameFor({ id: SCENE_ID, name: SCENE_NAME });

const MARK_A = 'content-of-project-A';
const MARK_B = 'content-of-project-B';

/** A scene body carrying a content marker and an exact `modifiedAt`. */
function variant(marker: string, modifiedAt: string): RvScene {
  return {
    id: SCENE_ID,
    name: SCENE_NAME,
    createdAt: '2025-01-01T00:00:00.000Z',
    modifiedAt,
    schemaVersion: 3,
    base: { kind: 'empty' },
    edits: { ops: [], settings: { catalogUrls: [marker], gridSizeMm: 500 } },
  };
}

/**
 * Put a body into `rv-scenes/<id>` verbatim.
 *
 * `writeScene()` stamps `modifiedAt` with "now", which would make the
 * conflict comparison depend on millisecond timing. The index entry is
 * created once via `writeScene()`; the body is then pinned here.
 */
function putCache(scene: RvScene): void {
  localStorage.setItem('rv-scenes/' + scene.id, JSON.stringify(scene));
}

/**
 * The GLB body a project writes, marked so the two are distinguishable.
 *
 * Since plan-413 phase 6 a scene body is bytes, and the cached record is a
 * SHELL that points at them — so "whose body does the cache hold?" is answered
 * by the shell's revision, not by anything inside the record. That is a
 * stronger measurement than the old one: it compares the actual content hash,
 * where reading a field out of a copied op log only compared a copy.
 */
function glbFor(marker: string): Uint8Array {
  return new TextEncoder().encode('glb:' + marker);
}

/** Which project's bytes the cached shell currently points at. */
async function cachedBodyMarker(): Promise<string | undefined> {
  const base = readScene(SCENE_ID)?.base;
  const revision = base?.kind === 'scene-glb' ? base.revision : undefined;
  if (!revision) return undefined;
  for (const marker of [MARK_A, MARK_B]) {
    if (await revisionOfBytes(glbFor(marker)) === revision) return marker;
  }
  return undefined;
}

async function manifestOf(dir: FakeDir): Promise<RvProject> {
  const text = await dir.readText('project.json');
  return JSON.parse(text ?? '{}') as RvProject;
}

async function sceneFileOf(dir: FakeDir): Promise<string | null> {
  return dir.readTextAt('scenes', FILE_NAME);
}

let stores: ProjectStore[] = [];

beforeEach(() => {
  clearSceneMutationListeners();
  clearAllScenes();
  clearAllSceneOwners();
  setDraftScope(null);
  localStorage.removeItem('rv-project/last');
  resetProjectStore();
  stores = [];
});

afterEach(async () => {
  for (const s of stores) await s.closeProject();
  clearSceneMutationListeners();
  clearAllScenes();
  clearAllSceneOwners();
  setDraftScope(null);
});

/**
 * Build the state the whole fix turns on:
 *   folder B holds B's body, folder A holds A's (newer) body,
 *   and the browser cache holds A's body — now with its origin recorded.
 */
async function twoProjectsSharingOneSceneId(): Promise<{
  dirA: FakeDir;
  dirB: FakeDir;
  idA: string;
  idB: string;
}> {
  // Index entry once; the body is pinned per step.
  writeScene(variant(MARK_B, '2025-06-01T00:00:00.000Z'));

  const withBody = (marker: string) => ({ readSceneGlb: async () => glbFor(marker) });

  const dirB = new FakeDir('project-b');
  putCache(variant(MARK_B, '2025-06-01T00:00:00.000Z'));
  const resB = await createProjectFromScenes(
    asDirHandle(dirB), 'Project B', [SCENE_ID], withBody(MARK_B));
  expect(resB.ok).toBe(true);

  const dirA = new FakeDir('project-a');
  putCache(variant(MARK_A, '2025-07-01T00:00:00.000Z'));
  const resA = await createProjectFromScenes(
    asDirHandle(dirA), 'Project A', [SCENE_ID], withBody(MARK_A));
  expect(resA.ok).toBe(true);

  const idA = (await manifestOf(dirA)).id;
  const idB = (await manifestOf(dirB)).id;
  return { dirA, dirB, idA, idB };
}

// ─── Cardinality — unchanged spec ───────────────────────────────────────

describe('cardinality of a sceneId in the shipped keyspace', () => {
  it('createProjectFromScenes puts the SAME scene id into two distinct projects', async () => {
    const { dirA, dirB } = await twoProjectsSharingOneSceneId();

    const mA = await manifestOf(dirA);
    const mB = await manifestOf(dirB);

    expect(sceneDocumentsOf(mA).map(e => e.id)).toEqual([SCENE_ID]);
    expect(sceneDocumentsOf(mB).map(e => e.id)).toEqual([SCENE_ID]);
    expect(mA.id).not.toBe(mB.id);

    // Both folders really carry a body, and the two bodies differ.
    expect(await sceneFileOf(dirA)).toContain(MARK_A);
    expect(await sceneFileOf(dirB)).toContain(MARK_B);
  });

  it('the docstring claim "the scenes exist in both worlds" holds — the cache is never cleared', async () => {
    await twoProjectsSharingOneSceneId();
    // rv-project-create.ts:14-16
    expect(readScene(SCENE_ID)).not.toBeNull();
  });

  it('the body keyspace is still 1:1 — the origin lives beside it, not inside it', async () => {
    await twoProjectsSharingOneSceneId();

    // rv-scene-storage.ts:33-41 — flat keyspace, unchanged by this fix.
    const bodyKeys = Object.keys(localStorage).filter(
      k => k.startsWith('rv-scenes/') && k.endsWith(SCENE_ID),
    );
    expect(bodyKeys).toEqual(['rv-scenes/' + SCENE_ID]);

    // rv-scenes-index still carries exactly one meta, with no owner field.
    const metas = listMetas().filter(m => m.id === SCENE_ID);
    expect(metas).toHaveLength(1);
    expect(Object.keys(metas[0])).not.toContain('projectId');

    // The provenance is additive: its own key, next to the body.
    expect(localStorage.getItem('rv-scene-owner/' + SCENE_ID)).not.toBeNull();
  });

  it('one sceneId has TWO legitimate owning projects at the same time', async () => {
    const { idA, idB } = await twoProjectsSharingOneSceneId();

    const owner = readSceneOwner(SCENE_ID)!;
    expect(owner).toBeDefined();
    // 1:n — both owners are represented, neither is lost.
    expect([...owner.projectIds].sort()).toEqual([idA, idB].sort());
    // …and the body currently cached is A's, the project created last.
    expect(owner.cachedFrom).toBe(idA);
  });

  it('membership is order-independent — the flicker a 1:1 marker would produce', async () => {
    const { dirA, dirB, idA, idB } = await twoProjectsSharingOneSceneId();

    const openOrder = async (first: FakeDir, second: FakeDir) => {
      const s1 = new ProjectStore();
      stores.push(s1);
      await s1.openProjectFolder(asDirHandle(first));
      await s1.closeProject();
      const s2 = new ProjectStore();
      stores.push(s2);
      await s2.openProjectFolder(asDirHandle(second));
      await s2.closeProject();
      return [...readSceneOwner(SCENE_ID)!.projectIds].sort();
    };

    const aThenB = await openOrder(dirA, dirB);
    const bThenA = await openOrder(dirB, dirA);

    expect(aThenB).toEqual([idA, idB].sort());
    expect(bThenA).toEqual(aThenB);
  });
});

// ─── hydrateScene() — the fix ───────────────────────────────────────────

describe('hydrateScene() with a shared sceneId', () => {
  it('opens project B and serves B own body — the foreign cache is not handed over', async () => {
    const { dirB, idB } = await twoProjectsSharingOneSceneId();

    const store = new ProjectStore();
    stores.push(store);
    expect(await store.openProjectFolder(asDirHandle(dirB))).toBe(true);
    expect(store.getProject()?.name).toBe('Project B');

    expect(await store.hydrateScene(SCENE_ID)).toBe(true);

    // THE MEASUREMENT, inverted: project B gets project B's body.
    expect(await cachedBodyMarker()).toBe(MARK_B);

    // …and the cache now says whose body it holds.
    expect(readSceneOwner(SCENE_ID)?.cachedFrom).toBe(idB);

    // B's own file on disk is untouched.
    expect(await sceneFileOf(dirB)).toContain(MARK_B);
  });

  it('re-reads this project file when the cached body is known to be foreign', async () => {
    const { dirB, idA, idB } = await twoProjectsSharingOneSceneId();

    const store = new ProjectStore();
    stores.push(store);
    await store.openProjectFolder(asDirHandle(dirB));

    // Arrange the exact bug state directly against hydrateScene: A's body in
    // the cache, marked as A's, while B is the open project.
    putCache(variant(MARK_A, '2025-07-01T00:00:00.000Z'));
    writeSceneOwner(SCENE_ID, { projectIds: [idA, idB], cachedFrom: idA });

    expect(await store.hydrateScene(SCENE_ID)).toBe(true);

    // project-store.ts — the short-circuit no longer applies to a foreign body.
    expect(await cachedBodyMarker()).toBe(MARK_B);
    expect(readSceneOwner(SCENE_ID)?.cachedFrom).toBe(idB);
  });

  it('reconciliation defaults to the folder when the cache belongs to another project', async () => {
    const { dirA, dirB } = await twoProjectsSharingOneSceneId();

    const store = new ProjectStore();
    stores.push(store);
    await store.openProjectFolder(asDirHandle(dirB));

    // The divergence is still classified as a conflict…
    expect(store.getLastConflicts().map(c => c.id)).toEqual([SCENE_ID]);
    // …but with no prompt installed the default is no longer "keep the cache":
    // adopting another project's body is the data loss, not the safety.
    expect(await cachedBodyMarker()).toBe(MARK_B);
    expect(store.getSnapshot().warnings).toEqual([]);

    // Project A's folder is untouched either way.
    expect(await sceneFileOf(dirA)).toContain(MARK_A);
  });

  it('the conflict item names the project the cached body came from', async () => {
    const { dirB, idA } = await twoProjectsSharingOneSceneId();
    const store = new ProjectStore();
    stores.push(store);
    await store.openProjectFolder(asDirHandle(dirB));

    const item = store.getLastConflicts()[0];
    expect(item).toBeDefined();
    // What the user is shown now includes the origin, not just timestamps.
    expect(item.cachedFromProjectId).toBe(idA);
    expect(item.name).toBe(SCENE_NAME);
    expect(item.folderName).toBe(SCENE_NAME);
  });
});

// ─── The save path ──────────────────────────────────────────────────────

describe('the save path after a shared-id hydration', () => {
  it('a save inside project B leaves B .scene.glb with B content', async () => {
    const { dirA, dirB } = await twoProjectsSharingOneSceneId();

    const store = new ProjectStore();
    stores.push(store);
    await store.openProjectFolder(asDirHandle(dirB));
    expect(store.isWritable()).toBe(true);
    await store.hydrateScene(SCENE_ID);

    // Before: B's file is B's.
    expect(await sceneFileOf(dirB)).toContain(MARK_B);

    // Any save inside project B — the mutation SceneStore.save() emits
    // (rv-scene-mutations.ts:38-40).
    emitSceneMutation({ type: 'upsert', id: SCENE_ID, scene: readScene(SCENE_ID)! });
    await store.flush();

    // After: still B's. Two reasons now, and both matter: the foreign body
    // never reached the cache, AND since plan-413 phase 6 the folder writer
    // records the manifest row without touching the body at all.
    const after = await sceneFileOf(dirB);
    expect(after).toContain(MARK_B);
    expect(after).not.toContain(MARK_A);

    expect(store.getSnapshot().diskError).toBeNull();
    expect(store.getSnapshot().warnings).toEqual([]);

    // Project A's own folder is untouched — the fix is not a swap of victims.
    expect(await sceneFileOf(dirA)).toContain(MARK_A);
  });

  it('the RR1 path-ownership guard still cannot see it — the path IS B own path', async () => {
    const { dirB } = await twoProjectsSharingOneSceneId();
    const mB = await manifestOf(dirB);

    // rv-project-folder-writer.ts:383-424 guards id<->path, never id<->project.
    // Unchanged by this plan: the provenance marker is what closes the gap.
    expect(sceneDocumentsOf(mB)[0].path).toBe('scenes/' + FILE_NAME);
    expect(sceneGlbFileNameFor(variant(MARK_A, '2025-07-01T00:00:00.000Z'))).toBe(FILE_NAME);
  });
});

// ─── The fix is additive ────────────────────────────────────────────────

describe('an unknown origin keeps the historic behaviour', () => {
  it('hydrateScene still short-circuits on a cache with no ownership record', async () => {
    const { dirB, idB } = await twoProjectsSharingOneSceneId();

    const store = new ProjectStore();
    stores.push(store);
    await store.openProjectFolder(asDirHandle(dirB));

    // A cache written before the marker existed: body present, origin unknown.
    putCache(variant(MARK_A, '2025-07-01T00:00:00.000Z'));
    clearSceneOwner(SCENE_ID);

    expect(await store.hydrateScene(SCENE_ID)).toBe(true);
    // Unchanged pre-fix behaviour — the cached record is served as it always
    // was, not replaced from the folder. It is still the pinned record (an
    // empty base carrying A's marker), never a shell pointing at B's bytes.
    expect(readScene(SCENE_ID)?.base.kind).toBe('empty');
    expect(readScene(SCENE_ID)?.edits.settings.catalogUrls?.[0]).toBe(MARK_A);
    expect(await cachedBodyMarker()).toBeUndefined();
    // …and from now on its origin is on record, so the next owner will see it.
    expect(readSceneOwner(SCENE_ID)?.cachedFrom).toBe(idB);
  });
});

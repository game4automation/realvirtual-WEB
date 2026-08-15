// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-709 §2.2.1 / §9.2, ported to the one save path (plan-716 §9.0, Phase 3).
 *
 * This file was `scene-save-concurrency.test.ts`. The MECHANICS it guards are
 * unchanged and every one of them is still asserted here — what changed is what
 * a save writes. There is no `scn_` mint, no catalogue row and no id-keyed body
 * slot any more, so the four properties are restated against the document file:
 *
 *  - a save on a clean, already-saved document is a TRUE no-op and creates **no
 *    second document** (§2.2.1-4). It used to mint a scene id on every click;
 *    the equivalent regression now would be a second file per press;
 *  - a save **cancels the pending autosave** so nothing writes into the window
 *    between the bake and the draft cleanup (§2.2.1-2);
 *  - the DOCUMENT file and the DRAFT slot keep **separate revision baselines**
 *    (§2.2.1-2, the latent bug this plan's ancestor fixed): after a save, the
 *    next autosave must not hand the document's revision to the draft slot;
 *  - a save that finishes after the **project changed** adopts nothing
 *    (§2.2.1-1).
 *
 * Plus the one property Phase 3 adds and §9.3 names: the document write carries
 * a precondition, and a foreign write in between refuses it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** slot → revision, as the fake body store sees it. */
  bodies: new Map<string, string>(),
  writes: [] as { slot: string; expected: string | null | undefined }[],
  /** Held open by the project-switch test, so the swap lands mid-bake. */
  bakeGate: null as null | Promise<void>,
  /** Set the moment the gated bake is actually reached. */
  bakeEntered: false,
}));

let nextRevision = 0;

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: async (slot: string) =>
    (h.bodies.has(slot)
      ? { glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46]), revision: h.bodies.get(slot)!, target: 'opfs' }
      : null),
  writeSceneGlbBody: async (write: { sceneId: string; expectedRevision?: string | null }) => {
    h.writes.push({ slot: write.sceneId, expected: write.expectedRevision });
    const revision = `rev${++nextRevision}`;
    h.bodies.set(write.sceneId, revision);
    return { revision, target: 'opfs' };
  },
  dropSceneGlbBody: async (slot: string) => { h.bodies.delete(slot); },
  sceneGlbBodyRevision: async (sceneId: string) => h.bodies.get(sceneId) ?? null,
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: async () => {
    h.bakeEntered = true;
    if (h.bakeGate) await h.bakeGate;
    return {
      glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]),
      warnings: [],
      writtenReferences: [],
    };
  },
  makeRegistryBakeResolver: () => ({}),
  bakeRequiresFullPath: () => false,
}));

import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { listMetas, clearAllScenes } from '../src/core/hmi/scene/rv-scene-storage';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { documentsOf } from '../src/core/project/rv-project-documents';
import { clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { RvProject } from '../src/core/project/rv-project-types';
import {
  installFakeDocumentProject,
  revisionOfFile,
  type FakeDocumentProject,
} from './helpers/fake-document-project';

const CELL_ID = 'doc_cell';
const CELL_PATH = 'scenes/Cell.glb';

function makeViewer() {
  const v = {
    loadScenes: [] as RvScene[],
    availableModels: [{ url: '/models/Demo.glb', label: 'Demo' }],
    availablePublishedScenes: [],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    currentModelRoot: null as unknown,
    registry: {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
    },
    lastLoadResult: null,
    modes: { has: () => true, setMode: () => {} },
    getPlugin: () => undefined,
    loadScene: async (s: RvScene) => { v.loadScenes.push(s); v.currentScene = s; },
    loadEmptyScene: async () => {},
  };
  return v;
}

function makeStore(): SceneStore {
  return new SceneStore(makeViewer() as unknown as ConstructorParameters<typeof SceneStore>[0]);
}

/** An edit, so a save has something to persist and the autosave arms. */
async function edit(store: SceneStore, value: number): Promise<void> {
  await store.applyOp({
    id: `op_${value}`, ts: Date.now(), schemaV: 1, kind: 'setField',
    nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
    value, prev: 0,
  } as never);
}

let project: FakeDocumentProject;
let store: SceneStore;

beforeEach(() => {
  localStorage.clear();
  clearAllScenes();
  clearAllDocumentAliases();
  resetProjectStore();
  h.bodies.clear();
  h.writes.length = 0;
  nextRevision = 0;
  project = installFakeDocumentProject({
    documents: [{ id: CELL_ID, path: CELL_PATH, name: 'Cell', section: 'scenes' }],
  });
  store = makeStore();
});

afterEach(() => {
  store.dispose();
  project.restore();
  resetProjectStore();
  clearAllScenes();
  clearAllDocumentAliases();
});

describe('the one save path — the no-op (§2.2.1-4)', () => {
  it('a second save of an unchanged document creates NO second document', async () => {
    await store.openDocument(CELL_ID);
    await edit(store, 100);
    await store.save();
    const afterFirst = documentsOf(project.project()).map(d => d.id);
    expect(afterFirst).toEqual([CELL_ID]);

    await store.save();
    await store.save();

    expect(documentsOf(project.project()).map(d => d.id)).toEqual(afterFirst);
    // And no catalogue row was ever the answer (plan-716 F1).
    expect(listMetas()).toEqual([]);
  });

  it('the no-op writes no file at all', async () => {
    await store.openDocument(CELL_ID);
    await edit(store, 100);
    await store.save();
    const writesAfterFirst = project.writes.length;

    await store.save();

    expect(project.writes.length).toBe(writesAfterFirst);
  });

  it('but a save after an edit does write again', async () => {
    await store.openDocument(CELL_ID);
    await edit(store, 100);
    await store.save();
    const writesAfterFirst = project.writes.length;

    await edit(store, 250);
    await store.save();

    expect(project.writes.length).toBeGreaterThan(writesAfterFirst);
  });
});

describe('the one save path — separated revision baselines (§2.2.1-2)', () => {
  it('the autosave after a save uses the DRAFT slot baseline, not the document one', async () => {
    await store.openDocument(CELL_ID);
    await edit(store, 100);
    await store.save();

    // The document file now holds a revision. The draft slot was dropped by the
    // save, so "nothing is there" — `null` — is the only correct precondition
    // for the next autosave. Handing it the DOCUMENT's revision (the shape of
    // the pre-plan-709 single field) would make every post-save autosave fail
    // as a phantom conflict.
    h.writes.length = 0;
    await edit(store, 750);
    await new Promise(resolve => setTimeout(resolve, 2100));

    const draftWrite = h.writes.find(w => w.slot === `draft/${CELL_ID}`);
    expect(draftWrite).toBeDefined();
    expect(draftWrite!.expected).toBeNull();
  }, 15_000);

  it('an explicit save states the revision it is replacing (§2.3 decision, plan-716 CAS)', async () => {
    const atLoad = await revisionOfFile(project, CELL_PATH);
    await store.openDocument(CELL_ID);
    await edit(store, 300);

    await store.save();

    expect(project.writes).toHaveLength(1);
    expect(project.writes[0].expected).toBe(atLoad);
  });

  it('a foreign write between load and save is REFUSED, not clobbered', async () => {
    await store.openDocument(CELL_ID);
    await edit(store, 300);
    project.writeForeign(CELL_PATH, 'another tab got here first');

    await expect(store.save()).rejects.toThrow(/changed since it was read/);
    expect(new TextDecoder().decode(project.files.get(CELL_PATH)!))
      .toBe('another tab got here first');
  });
});

describe('the one save path — the pending autosave (§2.2.1-2)', () => {
  it('a save cancels the armed autosave instead of racing its cleanup', async () => {
    await store.openDocument(CELL_ID);
    await edit(store, 100);
    await store.save();

    // Arm the debounced autosave, then save before it can fire.
    await edit(store, 900);
    await store.save();
    h.writes.length = 0;

    // Well past the 2 s debounce: the timer the edit armed must be gone.
    await new Promise(resolve => setTimeout(resolve, 2600));

    expect(h.writes.filter(w => w.slot === `draft/${CELL_ID}`)).toEqual([]);
  }, 15_000);
});

describe('the one save path — binding (§2.2.1-1)', () => {
  it('adopts nothing when the project changed while the file was being written', async () => {
    await store.openDocument(CELL_ID);
    await edit(store, 100);

    // Swap the project id WHILE the bake runs — the same seam the scene version
    // drove through a gated body write, moved to where the long pole now is.
    const privates = getProjectStore() as unknown as { _project: RvProject | null };
    const before = privates._project!;
    let openGate!: () => void;
    h.bakeEntered = false;
    h.bakeGate = new Promise<void>(resolve => { openGate = resolve; });

    const pending = store.save();
    // Wait for the bake to be REACHED rather than for a fixed number of
    // microturns: the save runs on the document queue and resolves the asset
    // source on the way, and a turn count tuned on one machine is the test that
    // passes alone and fails in the full suite.
    while (!h.bakeEntered) await new Promise(resolve => setTimeout(resolve, 1));
    privates._project = { ...before, id: 'prj_two' } as RvProject;   // another project opened
    openGate();
    h.bakeGate = null;

    expect(await pending).toBe('target-changed');
    expect(project.writes).toEqual([]);
    privates._project = before;
  });
});

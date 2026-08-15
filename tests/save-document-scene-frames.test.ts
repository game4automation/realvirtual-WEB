// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-710 §9.5 / F5 — `saveDocument()` covers SCENE frames too,
 * ported to the one document model (plan-716 §9.0).
 *
 * plan-709 left one half of "the one save path" unfinished: `saveDocument()`
 * knew only the asset lineage, while scenes went through a second routing
 * function in `scene-document-view` that repeated its refusal sentences, its
 * no-op rule and its "needs a name" branch. This pins that there is one
 * routing now, and — the part that matters more — that unifying the routing did
 * NOT unify away the scene's protection:
 *
 *  - the destination is still bound before the bake and verified after it, so a
 *    load that slips past the op queue through `_installOps` still discards the
 *    result. That guard is a named preservation item of the merge (§2.4, review
 *    finding S5) and this file is where it is asserted end to end;
 *  - the discard is now REPORTED rather than swallowed, because a card that
 *    says "saved" for a save that adopted nothing is the failure mode the whole
 *    verb vocabulary exists to prevent.
 *
 * ## What plan-716 changed here, and what it did not
 *
 * Not one assertion about the ROUTING changed: the verbs (`saved`, `no-op`,
 * `cancelled`, `blocked`, `target-changed`), the refusal sentences and the
 * "a draft must be named through the caller" rule are the same. What changed is
 * what a save WRITES and therefore what the assertions can look at. There is no
 * `scn_` mint and no catalogue row any more, so every `listMetas()` observation
 * is restated against the project manifest — the same substitution
 * `document-save-concurrency.test.ts` made for this file's sibling stub, which
 * §9.0 lists as "portieren".
 *
 * Two premises moved with it and are worth naming, because they are behaviour
 * and not bookkeeping:
 *
 *  - **`newEmpty()` MINTS a document** (F5). It is no longer a way to obtain an
 *    unsaved draft, so the draft cases below open one through `openEmpty()` —
 *    the boot path, which §9.3 pins as the one that deliberately does not mint.
 *  - **the long pole is the bake, not the body write.** A save writes the
 *    document file through the backend, so the gate that used to park
 *    `writeSceneGlbBody` parks `bakeIntoGlb` instead — the same seam
 *    `document-save-concurrency.test.ts` moved to for the same reason.
 *
 * The doubles are the ones that file uses, deliberately: the two files assert
 * the same store from two sides, and a divergence in the fixture would make one
 * of them lie.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** slot → revision, as the fake body store sees it (drafts only, now). */
  bodies: new Map<string, string>(),
  writes: [] as { slot: string; expected: string | null | undefined }[],
  /** Held open by the load-during-save tests, so the load lands mid-bake. */
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

// Without this the setField executor throws against the stub registry and the
// op is never RECORDED — the log stays empty, every save is a no-op and half
// the assertions below become vacuously true.
vi.mock('../src/core/hmi/scene/rv-scene-executors', () => ({
  applyForward: async () => undefined,
  applyInverse: async () => undefined,
  writeUserDataField: () => {},
  deleteUserDataField: () => {},
  reapplySchemaForComponent: () => {},
}));

import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { listMetas, clearAllScenes } from '../src/core/hmi/scene/rv-scene-storage';
import { saveDocument } from '../src/core/editor/rv-save-document';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { documentsOf } from '../src/core/project/rv-project-documents';
import { clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvProject } from '../src/core/project/rv-project-types';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import {
  installFakeDocumentProject,
  type FakeDocumentProject,
} from './helpers/fake-document-project';

function makeViewer() {
  const v = {
    loadScenes: [] as RvScene[],
    availableModels: [{ url: '/models/Demo.glb', label: 'Demo' }],
    availablePublishedScenes: [],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    currentModelRoot: { name: 'root' },
    registry: {
      getGltfNodeNames: () => [], getGltfNodeIndex: () => -1,
      getPathForNode: () => null, getNode: () => null,
      getComponentsAt: () => [],
    },
    lastLoadResult: null,
    modes: { has: () => true, setMode: () => {} },
    getPlugin: () => undefined,
    loadScene: async (s: RvScene) => { v.loadScenes.push(s); v.currentScene = s; },
    loadEmptyScene: async () => { v.currentScene = null; },
  };
  return v;
}

function makeStore(): SceneStore {
  return new SceneStore(makeViewer() as unknown as ConstructorParameters<typeof SceneStore>[0]);
}

/** An edit, so a save has something to persist. */
async function edit(store: SceneStore, value: number): Promise<void> {
  await store.applyOp({
    id: `op_${value}`, ts: Date.now(), schemaV: 1, kind: 'setField',
    nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
    value, prev: 0,
  } as never);
}

/** `saveDocument` against the scene lineage — the whole point of this file. */
const save = (store: SceneStore, opts: Parameters<typeof saveDocument>[2] = {}) =>
  saveDocument(null, store, opts);

/** The manifest rows, which is where a saved scene lives since Phase 3. */
const docs = () => documentsOf(project.project());

interface StorePrivates { _backend: ProjectBackend | null; _project: RvProject | null }
const privates = () => getProjectStore() as unknown as StorePrivates;

/**
 * Park the next bake; resolves once it is actually parked.
 *
 * Waiting for the bake to be REACHED rather than for a fixed number of
 * microturns: the save runs on the document queue and resolves the base bytes
 * on the way, and a turn count tuned on one machine is the test that passes
 * alone and fails in the full suite.
 */
let openBakeGate: (() => void) | null = null;
async function armGate(): Promise<void> {
  h.bakeEntered = false;
  h.bakeGate = new Promise<void>(resolve => { openBakeGate = resolve; });
}
async function awaitBlocked(): Promise<void> {
  while (!h.bakeEntered) await new Promise(resolve => setTimeout(resolve, 1));
}
function releaseGate(): void {
  openBakeGate?.();
  openBakeGate = null;
  h.bakeGate = null;
}

let project: FakeDocumentProject;
let urlBefore: string;

beforeEach(() => {
  urlBefore = window.location.href;
  localStorage.clear();
  clearAllScenes();
  clearAllDocumentAliases();
  resetProjectStore();
  h.bodies.clear();
  h.writes.length = 0;
  h.bakeGate = null;
  h.bakeEntered = false;
  openBakeGate = null;
  nextRevision = 0;
  // `_ensureBaseBytes` fetches the base before it can bake. The bytes do not
  // matter — the bake is mocked — but the fetch has to succeed or every
  // persistence assertion would pass for the wrong reason.
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () => new Response(new ArrayBuffer(8), { status: 200 }),
  );
  project = installFakeDocumentProject();
});

afterEach(() => {
  vi.restoreAllMocks();
  project.restore();
  resetProjectStore();
  clearAllScenes();
  clearAllDocumentAliases();
  window.history.replaceState(window.history.state, '', urlBefore);
});

// ─── Routing ──────────────────────────────────────────────────────────────

describe('saveDocument — the scene lineage (F5)', () => {
  it('a never-saved draft is named through the caller, then saved as a new document', async () => {
    const store = makeStore();
    await store.openEmpty();
    await edit(store, 400);

    const asked: string[] = [];
    const result = await save(store, {
      requestName: async (initial) => { asked.push(initial); return 'Filling Line'; },
    });

    expect(result.kind).toBe('saved');
    const rows = docs();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Filling Line');
    // The prompt was seeded with the workspace name, not with an empty string.
    expect(asked).toEqual(['Untitled']);
    expect(result).toMatchObject({ sceneId: rows[0].id });
    // The catalogue gained nothing at all (plan-716 F1).
    expect(listMetas()).toEqual([]);
  });

  it('refuses — with the reason — when a draft has no way to be named', async () => {
    const store = makeStore();
    await store.openEmpty();
    await edit(store, 410);

    // The MCP tool and the exit guard cannot prompt; a save that quietly minted
    // a name for them would be a file the user never asked for.
    expect(await save(store)).toEqual({
      kind: 'blocked',
      reason: 'This scene needs a name before it can be saved.',
    });
    expect(docs()).toHaveLength(0);
  });

  it('a declined name cancels and writes nothing', async () => {
    const store = makeStore();
    await store.openEmpty();
    await edit(store, 420);
    project.writes.length = 0;

    expect(await save(store, { requestName: async () => null })).toEqual({ kind: 'cancelled' });
    expect(project.writes).toEqual([]);
    expect(docs()).toHaveLength(0);
  });

  it('a saved scene with edits writes its file again', async () => {
    const store = makeStore();
    await store.openEmpty();
    await save(store, { requestName: async () => 'Cell' });
    const [row] = docs();
    project.writes.length = 0;

    await edit(store, 430);
    const result = await save(store);

    expect(result).toEqual({ kind: 'saved', sceneId: row.id });
    expect(project.writes.map(w => w.relPath)).toEqual([row.path]);
    // Still one document: an in-place save does not mint a second identity.
    expect(docs()).toHaveLength(1);
  });

  it('a clean saved scene is a true no-op — no write, no new document', async () => {
    const store = makeStore();
    await store.openEmpty();
    await save(store, { requestName: async () => 'Cell' });
    project.writes.length = 0;

    expect(await save(store)).toEqual({ kind: 'no-op' });
    expect(project.writes).toEqual([]);
    expect(docs()).toHaveLength(1);
  });

  it('forceNamePrompt is "Save as…": a new document under the given name', async () => {
    const store = makeStore();
    await store.openEmpty();
    await save(store, { requestName: async () => 'Cell' });

    const result = await save(store, {
      forceNamePrompt: true,
      requestName: async () => 'Cell (copy)',
    });

    expect(result.kind).toBe('saved');
    expect(docs().map(d => d.name).sort()).toEqual(['Cell', 'Cell (copy)']);
  });

  it('states WHY it cannot save, in the same words the asset lineage uses', async () => {
    const store = makeStore();
    await store.openEmpty();
    await edit(store, 440);

    privates()._backend = null;
    expect(await save(store)).toMatchObject({
      kind: 'blocked', reason: /No project is open/,
    });

    privates()._backend = { kind: 'browser', id: 'backend-1', writable: false } as ProjectBackend;
    expect(await save(store)).toMatchObject({
      kind: 'blocked', reason: /read-only/i,
    });

    privates()._backend = { kind: 'bundled', id: 'bundled', writable: false } as ProjectBackend;
    expect(await save(store)).toMatchObject({
      kind: 'blocked', reason: /ships with the application/i,
    });
  });
});

// ─── The preserved guard (§2.4, review finding S5) ────────────────────────

describe('saveDocument — load during save (the workspaceAtStart guard)', () => {
  it('discards — and REPORTS — when a load replaces the workspace mid-write', async () => {
    const store = makeStore();
    await store.openEmpty();
    await save(store, { requestName: async () => 'Cell' });
    const committed = docs();
    expect(committed).toHaveLength(1);

    await edit(store, 500);
    await armGate();
    const pending = save(store);            // the in-place save of a named scene
    await awaitBlocked();

    // A LOAD, not an op. This is the whole reason the guard exists: a load
    // reaches the document through `_installOps` → `restoreHistory`, which
    // replaces the history OUTSIDE the op queue by design, so `runExclusive`
    // cannot serialise the two. Identity comparison against the workspace
    // captured before the bake is what catches it.
    //
    // `openEmpty` rather than `newEmpty`: since F5 the latter MINTS a document,
    // which would make "the manifest is unchanged" untestable. The boot path
    // replaces the workspace and creates nothing, which is exactly the collision
    // this guard is about.
    const loaded = store.openEmpty();
    releaseGate();
    await loaded;
    const result = await pending;

    // Nothing was adopted — the manifest still describes the document as it was
    // committed, not as the abandoned save left it.
    expect(docs().map(d => d.id)).toEqual(committed.map(d => d.id));
    // And the caller is TOLD, rather than shown a success for a save whose
    // result was thrown away.
    expect(result).toEqual({ kind: 'target-changed' });
  });

  it('adopts nothing when the PROJECT changed while the body was written', async () => {
    const store = makeStore();
    await store.openEmpty();
    await edit(store, 510);

    await armGate();
    const pending = save(store, { requestName: async () => 'Cell' });
    await awaitBlocked();

    const before = privates()._project!;
    privates()._project = { ...before, id: 'prj_two' } as RvProject;   // another project
    releaseGate();

    // The first save of a draft goes through `saveAs`, which reports a moved
    // target by throwing; either way nothing is entered into the project the
    // user has moved to.
    const result = await pending;
    expect(result.kind).not.toBe('saved');
    expect(documentsOf(privates()._project)).toHaveLength(0);
    expect(project.writes).toEqual([]);
  });
});

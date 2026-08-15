// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * `SceneStore.saveAs()` — the plan-921 name propagation, plus the plan-709
 * §2.2.1 guarantees that must hold for it too. Ported to the one document
 * model (plan-716 §9.0).
 *
 * `save()` is covered by `document-save-concurrency.test.ts`; `saveAs()` is the
 * same transaction with a *new* identity in the middle, and that middle is
 * where the two field findings the merged code carries live:
 *
 *  - **plan-921 (name before body).** The name goes into the workspace BEFORE
 *    anything is written, because the destination file name is derived from it.
 *    With the OLD name still in the workspace at commit time the bytes land
 *    under one name and the row claims another, and the scene can never be
 *    reopened. The code comments this at `scene-store.ts` `_saveAs`; this file
 *    is what makes a reordering of those two lines fail.
 *  - **plan-709 §2.2.1-1 (binding).** The destination is bound before the bake
 *    and verified after it. A `saveAs` finishing after the user switched
 *    project or backend must adopt nothing — no file and no row in the context
 *    they moved to.
 *  - **plan-709 §2.2.1-2 (floor before bake).** The clean baseline is the op
 *    floor read BEFORE the bake. An op that reaches the log while the bytes
 *    are being written is not in them, so it must stay dirty and its draft
 *    must survive.
 *
 * ## What plan-716 changed here
 *
 * `saveAs` used to mint a `scn_` id, write a body slot and add a catalogue row;
 * it now places a FILE and a manifest row through the same create-only
 * primitive "New" and the first save use (F5). So the plan-921 property is
 * restated against the document path — `<new name>.glb` in the project root
 * (the default folder since folders stopped meaning anything) and the row that
 * points at it — which is the same guarantee against the same regression: the
 * name that reaches the BYTES is the new one.
 *
 * The one group that is gone rather than ported is "a new identity every time".
 * `open-save-document.test.ts` §9.3 already asserts both of its cases against
 * documents ("saveAs creates a NEW document and leaves the original file
 * alone", "saveAs probes the name rather than overwriting a namesake"), and a
 * second copy here would only be a second place to update.
 *
 * Same fixture as `document-save-concurrency.test.ts` — a real writable project
 * with real compare-and-swap, a fake body store for the DRAFT slots and a fake
 * bake that can be parked, which is where the long pole of a save now is.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** slot → revision, as the fake body store sees it (drafts only, now). */
  bodies: new Map<string, string>(),
  /** Every DRAFT body write. The commit is a project file write now. */
  writes: [] as { slot: string; expected: string | null | undefined }[],
  /** Held open by the binding and floor tests. */
  bakeGate: null as null | Promise<void>,
  /** Set the moment the gated bake is actually reached. */
  bakeEntered: false,
  /** Runs inside the gated bake, i.e. "while the bytes are being made". */
  duringBake: null as null | (() => void),
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
    h.duringBake?.();
    h.duringBake = null;
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
// op is never RECORDED — the op log stays empty and every assertion about the
// floor becomes vacuously true. `edit()` below asserts that it did land.
vi.mock('../src/core/hmi/scene/rv-scene-executors', () => ({
  applyForward: async () => undefined,
  applyInverse: async () => undefined,
  writeUserDataField: () => {},
  deleteUserDataField: () => {},
  reapplySchemaForComponent: () => {},
}));

import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { listMetas, clearAllScenes } from '../src/core/hmi/scene/rv-scene-storage';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';
import { documentsOf } from '../src/core/project/rv-project-documents';
import { clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvProject } from '../src/core/project/rv-project-types';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { RvDocument } from '../src/core/ops/rv-document';
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
    loadScene: async (s: RvScene) => {
      v.loadScenes.push(s);
      v.currentScene = s;
    },
    loadEmptyScene: async () => { v.currentScene = null; },
  };
  return v;
}

function makeStore() {
  return new SceneStore(makeViewer() as unknown as ConstructorParameters<typeof SceneStore>[0]);
}

/** The document behind the store — its op log is what the floor is read from. */
function documentOf(store: SceneStore): RvDocument {
  return (store as unknown as { _doc: RvDocument })._doc;
}

/** An edit, so a save has something to persist. Asserts that it was recorded. */
async function edit(store: SceneStore, value: number): Promise<void> {
  const before = documentOf(store).opCount;
  await store.applyOp({
    id: `op_${value}`, ts: Date.now(), schemaV: 1, kind: 'setField',
    nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
    value, prev: 0,
  } as never);
  expect(documentOf(store).opCount).toBe(before + 1);
}

/**
 * Grow the op log WITHOUT going through the queue — "an op landed while the
 * bake ran".
 *
 * `applyOp` cannot express this: it shares the document's single-flight queue
 * with `saveAs`, so it would simply wait. `restoreHistory` is the production
 * path that does mutate the log outside the queue (the in-place test session
 * and the document stack both use it), which is exactly the shape §2.2.1-2 is
 * written against.
 */
function growLogDuringBake(store: SceneStore): void {
  const doc = documentOf(store);
  const state = doc.captureHistory();
  doc.restoreHistory({
    ...state,
    ops: [...state.ops, {
      id: 'op_mid_bake', ts: Date.now(), schemaV: 1, kind: 'setField',
      nodePath: 'Conv1', componentType: 'Drive', fieldName: 'TargetSpeed',
      value: 999, prev: 0,
    } as never],
  });
}

/** The manifest rows, which is where a saved scene lives since Phase 3. */
const docs = () => documentsOf(project.project());

interface StorePrivates { _backend: ProjectBackend | null; _project: RvProject | null }
const privates = () => getProjectStore() as unknown as StorePrivates;

/** Park the next bake, and wait until it is genuinely parked. */
let openBakeGate: (() => void) | null = null;
function armGate(): void {
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
  h.duringBake = null;
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

// ─── plan-921: the name reaches the BYTES, not just the row ───────────────

describe('SceneStore.saveAs — the new name reaches the FILE (plan-921)', () => {
  it('derives the file name from the new name, never from "Untitled"', async () => {
    const store = makeStore();
    await store.openEmpty();                   // workspace name: "Untitled"
    await edit(store, 120);

    const id = await store.saveAs('Rolling Mill');

    // The bytes went to a path derived from the NEW name. Before plan-921 the
    // workspace still said "Untitled" at this point, and that is the string
    // that reached the writer.
    expect(project.writes.map(w => w.relPath)).toEqual(['Rolling Mill.glb']);
    expect(project.files.has('Rolling Mill.glb')).toBe(true);
    expect([...project.files.keys()].join('|')).not.toMatch(/untitled/i);
    expect(docs().find(d => d.id === id)?.name).toBe('Rolling Mill');
  });

  it('file and manifest row agree — the divergence plan-921 found', async () => {
    const store = makeStore();
    await store.openEmpty();
    await edit(store, 120);

    const id = await store.saveAs('Rolling Mill');

    // The two used to be derived independently — the body slug from the
    // workspace name, the row path from the catalogue name — and a stale name
    // in either made a scene that exists and cannot be reopened. They are one
    // derivation now, and this is what keeps them that way.
    const row = docs().find(d => d.id === id)!;
    expect(project.writes.map(w => w.relPath)).toContain(row.path);
    expect(project.files.has(row.path)).toBe(true);
    // And not a catalogue row in sight (plan-716 F1).
    expect(listMetas()).toEqual([]);
  });

  it('holds for a rename of an already-saved scene too', async () => {
    const store = makeStore();
    await store.openEmpty();
    await edit(store, 120);
    await store.saveAs('First Name');
    project.writes.length = 0;

    await edit(store, 340);
    const second = await store.saveAs('Second Name');

    const row = docs().find(d => d.id === second)!;
    expect(row.path).toBe('Second Name.glb');
    expect(project.writes.map(w => w.relPath)).toEqual(['Second Name.glb']);
    // The first file is left exactly where it was — `saveAs` copies, never moves.
    expect(project.files.has('First Name.glb')).toBe(true);
  });
});

// ─── §2.2.1-1 — the destination is bound at the start ─────────────────────

describe('SceneStore.saveAs — binding (§2.2.1-1)', () => {
  it('adopts nothing when the PROJECT changed while the body was written', async () => {
    const store = makeStore();
    await store.openEmpty();
    await edit(store, 100);

    armGate();
    const pending = store.saveAs('Rolling Mill');
    await awaitBlocked();

    const before = privates()._project!;
    privates()._project = { ...before, id: 'prj_two' } as RvProject;  // another project opened
    releaseGate();

    await expect(pending).rejects.toThrow(/save target changed/i);
    // The bake produced valid bytes, but nothing was entered into the project
    // the user moved to: no file, no row.
    expect(project.writes).toEqual([]);
    expect(documentsOf(privates()._project)).toHaveLength(0);
  });

  it('adopts nothing when the BACKEND was replaced while the body was written', async () => {
    const store = makeStore();
    await store.openEmpty();
    await edit(store, 100);

    armGate();
    const pending = store.saveAs('Rolling Mill');
    await awaitBlocked();

    // `_adoptProject` swaps the object; identity is what the guard compares.
    privates()._backend = { ...project.backend } as ProjectBackend;
    releaseGate();

    await expect(pending).rejects.toThrow(/save target changed/i);
    expect(project.writes).toEqual([]);
    expect(docs()).toHaveLength(0);
  });
});

// ─── §2.2.1-2 — the op floor is read BEFORE the bake ──────────────────────

describe('SceneStore.saveAs — floor before bake (§2.2.1-2)', () => {
  it('does not declare an op that arrived mid-bake saved, and keeps its draft', async () => {
    const store = makeStore();
    await store.openEmpty();
    await edit(store, 100);
    const doc = documentOf(store);
    const floorBefore = doc.opCount;

    h.duringBake = () => growLogDuringBake(store);
    const id = await store.saveAs('Rolling Mill');

    expect(doc.opCount).toBe(floorBefore + 1);
    // The baseline is the floor captured before the bake — so the mid-bake op
    // is still above it and still undoable. Reading the floor afterwards would
    // have swallowed it into the "already saved" prefix.
    expect(doc.baselineFloor).toBe(floorBefore);
    expect(doc.canUndo()).toBe(true);

    // …and the draft is refreshed instead of cleared: it is the only place
    // that op still exists.
    await vi.waitFor(() => {
      expect(h.writes.some(w => w.slot === `draft/${id}`)).toBe(true);
    });
  });

  it('a save with nothing arriving mid-bake DOES clean up its draft', async () => {
    const store = makeStore();
    await store.openEmpty();
    await edit(store, 100);

    const id = await store.saveAs('Rolling Mill');
    await new Promise(resolve => setTimeout(resolve, 50));

    // The contrast to the case above: no draft body write follows a save whose
    // log did not move.
    expect(h.writes.filter(w => w.slot === `draft/${id}`)).toEqual([]);
    expect(documentOf(store).baselineFloor).toBe(documentOf(store).opCount);
  });
});

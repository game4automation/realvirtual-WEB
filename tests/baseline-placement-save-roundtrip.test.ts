// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * baseline-placement-save-roundtrip — plan-769 Phase 7, test 9.25 (D23,
 * debug-028 Bug 1).
 *
 * The HMI save is `bakeIntoGlb(base, materialise(ops))`. A placement that came
 * in with the SAVED FILE has no `addPlacement` in the op log — it was adopted on
 * open — so `materialise` used to drop every `transformPlacement` /
 * `removePlacement` on it ("tolerate"), and the save wrote the old node back
 * unchanged: move → save → reopen showed the old position, remove → save →
 * reopen showed the placement again. The same fold feeds the replay of a
 * recovered draft tail (`viewer.loadScene`), which lost the same edits.
 *
 * Everything here is real: the viewer and its loader (assets as `data:` urls),
 * the layout planner, the `SceneStore` that books the ops and saves, the bake.
 * Only the project storage is the in-memory fake with real compare-and-swap
 * (`installFakeDocumentProject`) and the OPFS draft-body store is an in-memory
 * map. No op recorder: the ops go through `SceneStore.applyOp` and the save is
 * `SceneStore.save()`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Group, Vector3, type Object3D } from 'three';

const h = vi.hoisted(() => ({
  /** Draft body slot → bytes (the OPFS body store, in memory). */
  bodies: new Map<string, Uint8Array>(),
  revision: 0,
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: vi.fn(async (slot: string) => {
    const glb = h.bodies.get(slot);
    return glb ? { glb, revision: `rev-${slot}`, target: 'opfs' as const } : null;
  }),
  writeSceneGlbBody: vi.fn(async (write: { sceneId: string; glb: Uint8Array }) => {
    h.bodies.set(write.sceneId, write.glb);
    return { revision: `rev${++h.revision}`, target: 'opfs' as const };
  }),
  dropSceneGlbBody: vi.fn(async (slot: string) => { h.bodies.delete(slot); }),
  sceneGlbBodyRevision: vi.fn(async () => null),
}));

import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { clearAllScenes, setDraftScope } from '../src/core/hmi/scene/rv-scene-storage';
import { clearSceneMutationListeners } from '../src/core/hmi/scene/rv-scene-mutations';
import { setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import { resetProjectStore } from '../src/core/project/project-store';
import { clearAllDocumentAliases } from '../src/core/project/rv-doc-alias';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { materialise, editsBeyondAuthoredTree } from '../src/core/hmi/scene/rv-scene-edits';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { makeDraftScene } from '../src/core/hmi/scene/rv-scene-types';
import { collectPlacementNodes } from '../src/core/hmi/scene/rv-scene-glb-read';
import { getProblems, clearAllProblems } from '../src/core/hmi/problems-store';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { RV_NODE_ID_KEY } from '../src/core/engine/rv-node-id';
import type { RvOp, RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';
import type { PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';
import type { LayoutPlannerPlugin } from '../src/plugins/layout-planner';
import { installFakeDocumentProject, type FakeDocumentProject } from './helpers/fake-document-project';
import {
  bootRealLoaderViewer, findByName, innerDataUrl, jsonNodes, referenceNode, toArrayBuffer, type Booted,
} from './helpers/nested-placement-fixture';

// ─── Fixture ────────────────────────────────────────────────────────────

const DOC_ID = 'doc_layout_p7';
const DOC_PATH = 'scenes/Layout.glb';
const CELL_A = 'plc-cell-a';
const CELL_B = 'plc-cell-b';

let innerUrl = '';
let docBytes: ArrayBuffer;

/** The saved document: two planner placements of the Cell asset, at x = 10 and x = 20. */
async function layoutDocument(): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  root.add(referenceNode('Cell_A', CELL_A, innerUrl, true, [10, 0, 0], 'cat:cell'));
  root.add(referenceNode('Cell_B', CELL_B, innerUrl, true, [20, 0, 0], 'cat:cell'));
  return objectToGlb(root);
}

let opSeq = 0;
function op<T extends Record<string, unknown>>(body: T): RvScenePrimitiveOp {
  return { id: `op_p7_${++opSeq}`, ts: Date.now(), schemaV: 1, ...body } as unknown as RvScenePrimitiveOp;
}
const T0: [number, number, number] = [0, 0, 0];
const S1: [number, number, number] = [1, 1, 1];
function movePlacement(id: string, position: [number, number, number], prev: [number, number, number], rotation: [number, number, number] = T0): RvScenePrimitiveOp {
  return op({ kind: 'transformPlacement', placementId: id, position, rotation, scale: S1, prev: { position: prev, rotation: T0, scale: S1 } });
}
function removePlacement(id: string, label: string, position: [number, number, number]): RvScenePrimitiveOp {
  const placement: PlacedComponent = { id, catalogId: 'cat:cell', glbUrl: innerUrl, label, position, rotation: T0, scale: S1 };
  return op({ kind: 'removePlacement', placementId: id, placement });
}
function addPlacement(id: string, label: string, position: [number, number, number]): RvScenePrimitiveOp {
  const placement: PlacedComponent = { id, catalogId: 'cat:cell', glbUrl: innerUrl, label, position, rotation: T0, scale: S1 };
  return op({ kind: 'addPlacement', placement });
}

// ─── Harness ────────────────────────────────────────────────────────────

let booted: Booted | null = null;
let store: SceneStore | null = null;
let project: FakeDocumentProject | null = null;
let urlBefore = '';

async function bootWorld(fileBytes: ArrayBuffer = docBytes): Promise<{ viewer: Booted['h']['viewer']; store: SceneStore; planner: LayoutPlannerPlugin }> {
  booted = await bootRealLoaderViewer();
  const viewer = booted.h.viewer;
  const { LayoutPlannerPlugin } = await import('../src/plugins/layout-planner');
  const planner = new LayoutPlannerPlugin();
  viewer.use(planner);
  project = installFakeDocumentProject({
    documents: [{ id: DOC_ID, path: DOC_PATH, name: 'Layout', section: 'scenes' } as never],
    files: { [DOC_PATH]: new Uint8Array(fileBytes.slice(0)) },
  });
  store = new SceneStore(viewer);
  await store.openDocument(DOC_ID, { updateUrl: false });
  await viewer.whenSceneReady();
  return { viewer, store, planner };
}

/** Open the saved file again in the same store and wait for its placements. */
async function reopen(s: SceneStore, viewer: Booted['h']['viewer']): Promise<Object3D> {
  await s.openDocument(DOC_ID, { updateUrl: false });
  await viewer.whenSceneReady();
  return viewer.currentModelRoot!;
}

function savedBytes(): Uint8Array {
  const bytes = project!.files.get(DOC_PATH);
  if (!bytes) throw new Error('nothing saved');
  return bytes;
}

function placementNodeIds(bytes: Uint8Array): string[] {
  return jsonNodes(bytes)
    .map((n) => (n.extras as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual?.[RV_NODE_ID_KEY])
    .filter((id): id is string => id === CELL_A || id === CELL_B || (typeof id === 'string' && id.startsWith('plc-')));
}

/** A node's translation, whether the writer spelled it as `translation` (fast path) or `matrix` (full path). */
function translationOf(bytes: Uint8Array, name: string): number[] | undefined {
  const node = jsonNodes(bytes).find((n) => n.name === name);
  if (!node) return undefined;
  if (Array.isArray(node.matrix)) return (node.matrix as number[]).slice(12, 15);
  return (node.translation as number[] | undefined) ?? [0, 0, 0];
}

function relatedProblems(): string[] {
  return getProblems()
    .map((p) => p.code)
    .filter((code) => code === 'placement-transform-orphaned' || code === 'override-orphaned' || code === 'nested-transform-refused');
}

beforeEach(async () => {
  urlBefore = window.location.href;
  localStorage.clear();
  clearAllScenes();
  clearAllDocumentAliases();
  setDraftScope(null);
  clearSceneMutationListeners();
  setOpenDocumentBase(null);
  resetProjectStore();
  clearAllProblems();
  await __clearDraftStoresForTests();
  h.bodies.clear();
  if (!innerUrl) innerUrl = await innerDataUrl();
  docBytes = await layoutDocument();
});

afterEach(() => {
  store?.dispose();
  store = null;
  project?.restore();
  project = null;
  booted?.h.dispose();
  booted = null;
  resetProjectStore();
  clearAllScenes();
  clearAllDocumentAliases();
  setOpenDocumentBase(null);
  clearSceneMutationListeners();
  window.history.replaceState(window.history.state, '', urlBefore);
});

// ─── materialise: the pure fold ─────────────────────────────────────────

describe('materialise keeps edits on placements of the base file (D23)', () => {
  it('a move without an addPlacement becomes a baseline transform, last write wins', () => {
    const m = materialise([movePlacement(CELL_A, [4, 0, 0], [10, 0, 0]), movePlacement(CELL_A, [5, 0, 1], [4, 0, 0], [0, 90, 0])] as RvOp[]);
    expect(m.placements).toEqual([]);
    expect(m.baselinePlacementTransforms).toEqual(new Map([[CELL_A, { position: [5, 0, 1], rotation: [0, 90, 0], scale: [1, 1, 1] }]]));
    expect(m.removedPlacementIds).toEqual([]);
  });

  it('a remove without an addPlacement is a removed id and drops the baseline move', () => {
    const m = materialise([movePlacement(CELL_A, [4, 0, 0], [10, 0, 0]), removePlacement(CELL_A, 'Cell_A', [4, 0, 0])] as RvOp[]);
    expect(m.removedPlacementIds).toEqual([CELL_A]);
    expect(m.baselinePlacementTransforms?.size).toBe(0);
  });

  it('an addPlacement with a removed id takes it out again; an in-log placement still folds as before', () => {
    const m = materialise([
      removePlacement(CELL_A, 'Cell_A', [10, 0, 0]),
      addPlacement(CELL_A, 'Cell_A', [10, 0, 0]),
      addPlacement('plc-new', 'Cell_N', [0, 0, 0]),
      movePlacement('plc-new', [1, 0, 0], [0, 0, 0]),
      removePlacement('plc-new', 'Cell_N', [1, 0, 0]),
    ] as RvOp[]);
    expect(m.removedPlacementIds).toEqual([]);
    expect(m.baselinePlacementTransforms?.size).toBe(0);
    expect(m.placements.map((p) => p.id)).toEqual([CELL_A]);
  });

  it('editsBeyondAuthoredTree carries neither category (the authored tree holds the nodes)', () => {
    const m = editsBeyondAuthoredTree(materialise([movePlacement(CELL_A, [4, 0, 0], [10, 0, 0]), removePlacement(CELL_B, 'Cell_B', [20, 0, 0])] as RvOp[]));
    expect(m.baselinePlacementTransforms?.size).toBe(0);
    expect(m.removedPlacementIds).toEqual([]);
  });
});

// ─── Save → reopen through the real SceneStore + bake ───────────────────

describe('a placement the saved file holds: the planner books it, the save writes it (D23)', () => {
  it('move → save → reopen shows the new position', async () => {
    const { viewer, store: s, planner } = await bootWorld();
    expect(findByName(viewer.currentModelRoot!, 'Slide'), 'precondition: placed content materialised').not.toBeNull();

    await s.applyOp(movePlacement(CELL_A, [4, 0, 3], [10, 0, 0]));
    expect(findByName(viewer.currentModelRoot!, 'Cell_A')!.position.x, 'the planner moved it live').toBeCloseTo(4);

    expect(await s.save()).toBe('saved');
    expect(translationOf(savedBytes(), 'Cell_A')).toEqual([4, 0, 3]);
    // TRS-only: the reference itself is untouched.
    const node = jsonNodes(savedBytes()).find((n) => n.name === 'Cell_A') as { extras: { realvirtual: Record<string, unknown> } };
    expect(node.extras.realvirtual.AssetReference).toMatchObject({ assetId: 'cat:cell', path: innerUrl });

    const root = await reopen(s, viewer);
    expect(findByName(root, 'Cell_A')!.position.toArray()).toEqual([4, 0, 3]);
    expect(planner.store.getSnapshot().placed.find((c) => c.id === CELL_A)?.position).toEqual([4, 0, 3]);
    expect(relatedProblems()).toEqual([]);
  });

  it('remove → save → reopen: the placement is gone', async () => {
    const { viewer, store: s, planner } = await bootWorld();
    await s.applyOp(removePlacement(CELL_A, 'Cell_A', [10, 0, 0]));
    expect(findByName(viewer.currentModelRoot!, 'Cell_A'), 'the planner removed it live').toBeNull();

    expect(await s.save()).toBe('saved');
    expect(placementNodeIds(savedBytes())).toEqual([CELL_B]);

    const root = await reopen(s, viewer);
    expect(findByName(root, 'Cell_A')).toBeNull();
    expect(findByName(root, 'Cell_B')).not.toBeNull();
    expect(planner.store.getSnapshot().placed.map((c) => c.id)).toEqual([CELL_B]);
  });

  it('remove + place → save → reopen: only the new placement remains', async () => {
    const { viewer, store: s, planner } = await bootWorld();
    await s.applyOp(removePlacement(CELL_A, 'Cell_A', [10, 0, 0]));
    await s.applyOp(addPlacement('plc-cell-new', 'Cell_N', [30, 0, 0]));
    await viewer.whenSceneReady();

    expect(await s.save()).toBe('saved');
    expect(placementNodeIds(savedBytes()).sort()).toEqual([CELL_B, 'plc-cell-new'].sort());

    const root = await reopen(s, viewer);
    expect(findByName(root, 'Cell_A')).toBeNull();
    expect(findByName(root, 'Cell_N')!.position.x).toBeCloseTo(30);
    expect(planner.store.getSnapshot().placed.map((c) => c.id).sort()).toEqual([CELL_B, 'plc-cell-new'].sort());
  });

  it('saving twice after a remove: no warning, no Problems entry — and a re-bake onto the saved bytes is a silent no-op', async () => {
    const { viewer, store: s } = await bootWorld();
    const warn = vi.spyOn(console, 'warn');
    await s.applyOp(removePlacement(CELL_A, 'Cell_A', [10, 0, 0]));
    expect(await s.save()).toBe('saved');
    await s.applyOp(movePlacement(CELL_B, [21, 0, 0], [20, 0, 0]));
    expect(await s.save()).toBe('saved');
    expect(placementNodeIds(savedBytes())).toEqual([CELL_B]);
    expect(translationOf(savedBytes(), 'Cell_B')).toEqual([21, 0, 0]);

    // "Save as new" makes the saved bytes the base while the log keeps its
    // ops: the same removal reaches every later save. Absent = target state.
    const again = await bakeIntoGlb(
      savedBytes().slice(0),
      materialise(s.document.ops),
      makeRegistryBakeResolver(viewer.registry!, []),
    );
    expect(again.placementsRemoved).toBe(0);
    expect(again.path).toBe('fast');
    expect(again.warnings).toEqual([]);
    expect(placementNodeIds(again.glb)).toEqual([CELL_B]);

    expect(relatedProblems()).toEqual([]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[scene-store]'))).toEqual([]);
    warn.mockRestore();
  });

  it('a component override inside P, then P removed → the save succeeds and writes neither', async () => {
    const { viewer, store: s } = await bootWorld();
    const slide = findByName(findByName(viewer.currentModelRoot!, 'Cell_A')!, 'Slide')!;
    const slidePath = viewer.registry!.getPathForNode(slide)!;
    await s.applyOp(op({ kind: 'setField', nodePath: slidePath, componentType: 'Drive', fieldName: 'TargetSpeed', value: 500, prev: 200 }));
    await s.applyOp(removePlacement(CELL_A, 'Cell_A', [10, 0, 0]));

    expect(await s.save()).toBe('saved');
    expect(placementNodeIds(savedBytes())).toEqual([CELL_B]);
    const overrides = jsonNodes(savedBytes()).map((n) => (n.extras as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual?.AssetOverrides);
    expect(overrides.filter(Boolean)).toEqual([]);
  });

  it('a move of a placement the file no longer holds is reported, never silent', async () => {
    const { viewer } = await bootWorld();
    const result = await bakeIntoGlb(
      docBytes.slice(0),
      materialise([movePlacement('plc-gone', [1, 0, 0], [0, 0, 0])] as RvOp[]),
      makeRegistryBakeResolver(viewer.registry!, []),
    );
    expect(result.placementsMoved).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(getProblems().map((p) => p.code)).toContain('placement-transform-orphaned');
  });
});

// ─── The recovery tail: viewer.loadScene replays the same edits ─────────

describe('a recovered draft tail replays baseline moves and removals before the planner adopts (D23)', () => {
  async function replay(ops: RvScenePrimitiveOp[]): Promise<{ viewer: Booted['h']['viewer']; planner: LayoutPlannerPlugin }> {
    booted = await bootRealLoaderViewer();
    const viewer = booted.h.viewer;
    const { LayoutPlannerPlugin } = await import('../src/plugins/layout-planner');
    const planner = new LayoutPlannerPlugin();
    viewer.use(planner);
    const scene = makeDraftScene({ kind: 'builtin', url: 'Layout.glb', label: 'Layout' }, 'Layout');
    scene.edits.ops = ops;
    await viewer.loadScene(scene, undefined, { data: toArrayBuffer(new Uint8Array(docBytes.slice(0))) });
    // What `SceneStore._adoptFromLoadedGlb` does right after `loadScene`.
    planner.ensureAttached(viewer);
    planner.adoptPlacements(collectPlacementNodes(viewer.currentModelRoot!));
    await viewer.whenSceneReady();
    return { viewer, planner };
  }

  it('move → replay → the node, its placed content and the planner record are at the new position', async () => {
    const { viewer, planner } = await replay([movePlacement(CELL_A, [4, 0, 3], [10, 0, 0])]);
    const cell = findByName(viewer.currentModelRoot!, 'Cell_A')!;
    expect(cell.position.toArray()).toEqual([4, 0, 3]);
    const slide = findByName(cell, 'Slide')!;
    expect(slide, 'the placed content materialised under the moved node').not.toBeNull();
    // The content keeps its offset to the reference node — the same offset the
    // unmoved Cell_B shows at x = 20.
    const slideB = findByName(findByName(viewer.currentModelRoot!, 'Cell_B')!, 'Slide')!;
    const offsetA = slide.getWorldPosition(new Vector3()).x - 4;
    const offsetB = slideB.getWorldPosition(new Vector3()).x - 20;
    expect(offsetA).toBeCloseTo(offsetB);
    expect(planner.store.getSnapshot().placed.find((c) => c.id === CELL_A)?.position).toEqual([4, 0, 3]);
  });

  it('remove → replay → the planner never adopts it and nothing is materialised for it', async () => {
    const { viewer, planner } = await replay([removePlacement(CELL_A, 'Cell_A', [10, 0, 0])]);
    expect(findByName(viewer.currentModelRoot!, 'Cell_A')).toBeNull();
    expect(viewer.registry!.getNode('Layout/Cell_A') ?? null).toBeNull();
    expect(planner.store.getSnapshot().placed.map((c) => c.id)).toEqual([CELL_B]);
    expect(viewer.placements.progress).toMatchObject({ total: 1, materialized: 1, missing: 0 });
  });
});

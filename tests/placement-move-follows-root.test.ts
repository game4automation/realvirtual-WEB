// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * 2026-09-24 — a placement moves as ONE unit, on every entry.
 *
 * The planner's FloorGizmo writes `root.position` and lets the per-frame
 * `scene.updateMatrixWorld()` propagate. Three.js never recomputes a node with
 * `matrixWorldAutoUpdate=false`, even under `force` — so every chunk mesh of
 * a placement the static freeze (`integratePlacedContent`, F13) left frozen
 * stays where it was while the drive nodes (always dynamic) follow the root:
 * the conveyor frame stands still, the rolls travel ("Förderer zerlegt").
 * Both entries are pinned here: the RELOAD root (a reference node carrying
 * `PlacementMeta`) and the LIVE-DROP root (`createRoot` + `materialize`, which
 * stamps `LayoutObject` only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { setAssetReference, setPlacementMeta } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { collectPlacementNodes } from '../src/core/hmi/scene/rv-scene-glb-read';
import { integratePlacedContent } from '../src/core/engine/rv-placement-integrate';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { withComponent, group } from './fixtures/bake-fixture';

const ASSET_URL = 'blob:rv-test/move-follows-root.glb';
const CATALOG_ID = 'cat:move-follows-root';

function box(name: string, pos: [number, number, number], color: number): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color }));
  mesh.name = name;
  mesh.position.set(...pos);
  return mesh;
}

/** Conveyor: static frame + Drive{roll}. */
function makeAsset(): Group {
  const root = group('Conveyor');
  root.add(box('frame', [0, 0.5, 0], 0x336699));
  const drive = withComponent(group('Transport'), 'Drive', { Direction: 'LinearX', TargetSpeed: 100 });
  drive.add(box('roll', [0, 0.8, 0], 0x993333));
  root.add(drive);
  return root;
}

async function documentBytes(): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  const node = new Object3D();
  node.name = 'Conveyor';
  setNodeId(node, 'plc_1');
  setAssetReference(node, { assetId: CATALOG_ID, path: ASSET_URL });
  setPlacementMeta(node, {});
  root.add(node);
  return objectToGlb(root);
}

let handle: TestViewerHandle | null = null;
afterEach(() => { handle?.dispose(); handle = null; });

async function boot(): Promise<TestViewerHandle> {
  const h = await createTestViewer('webgl');
  handle = h;
  const loader = { loadAsync: async (): Promise<{ scene: Group }> => ({ scene: makeAsset() }) } as unknown as GLTFLoader;
  h.viewer.placements.setModelCache(new ModelCache(loader, {
    uber: () => h.viewer.placementUberMaterial,
    isWebGPU: () => h.viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  await h.viewer.loadModel('layout.glb', { data: await documentBytes() });
  await h.viewer.placements.whenMaterialized();
  return h;
}

/** Every mesh under `root` with its world X — the frame chunk(s) and the roll chunk(s). */
function meshWorldX(root: Object3D): Array<{ name: string; x: number; frozen: boolean; underDrive: boolean }> {
  const out: Array<{ name: string; x: number; frozen: boolean; underDrive: boolean }> = [];
  root.traverse((n) => {
    if (!(n as Mesh).isMesh) return;
    let underDrive = false;
    for (let a: Object3D | null = n.parent; a && a !== root; a = a.parent) if (a.userData?.realvirtual?.Drive) underDrive = true;
    out.push({ name: n.name, x: n.matrixWorld.elements[12], frozen: !n.matrixWorldAutoUpdate, underDrive });
  });
  return out;
}

function moveLikeTheGizmo(root: Object3D, x: number): void {
  root.position.x = x;
  // What the render loop does every frame (`scene.updateMatrixWorld()`), plus
  // the planner's own `updateMatrixWorld(true)` after a programmatic move.
  root.updateMatrixWorld(true);
}

describe('a placement moves as one unit', () => {
  it('RELOAD: the reference root, materialised by the viewer, drags frame AND rolls', async () => {
    const h = await boot();
    const model = (h.viewer as unknown as { currentModel: Object3D }).currentModel;
    const root = collectPlacementNodes(model)[0].node;
    expect(root.matrixAutoUpdate, 'root recomposes its local matrix').toBe(true);
    const before = meshWorldX(root);
    expect(before.length).toBeGreaterThanOrEqual(2);
    expect(before.some((m) => m.underDrive), 'a roll chunk under the drive').toBe(true);
    expect(before.some((m) => !m.underDrive), 'a frame chunk under the root').toBe(true);

    moveLikeTheGizmo(root, 7);
    const after = meshWorldX(root);
    for (let i = 0; i < after.length; i++) {
      expect(after[i].x - before[i].x, `${after[i].name} (frozen=${after[i].frozen}) follows the root`).toBeCloseTo(7);
    }
  });

  it('LIVE DROP: a fresh createRoot + materialize + integratePlacedContent drags frame AND rolls', async () => {
    const h = await boot();
    const viewer = h.viewer;
    const model = (viewer as unknown as { currentModel: Object3D }).currentModel;
    const ref = { catalogId: CATALOG_ID, glbUrl: ASSET_URL };
    const baked = await viewer.placements.resolveBaked(ref);
    const root = viewer.placements.createRoot(baked);
    model.add(root);
    viewer.placements.materialize(root, baked, { id: 'plc_live', label: 'Conveyor', catalogId: CATALOG_ID });
    integratePlacedContent(viewer, root);
    expect(root.matrixAutoUpdate).toBe(true);
    const before = meshWorldX(root);
    expect(before.some((m) => !m.underDrive), 'a frame chunk under the root').toBe(true);

    moveLikeTheGizmo(root, 7);
    const after = meshWorldX(root);
    for (let i = 0; i < after.length; i++) {
      expect(after[i].x - before[i].x, `${after[i].name} (frozen=${after[i].frozen}) follows the root`).toBeCloseTo(7);
    }
  });
});

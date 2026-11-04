// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-612 CP1d-b (#149) — an `Agv` ON a placement's reference node is scoped
 * by that placement from its very first bind.
 *
 * The PalletYard shape: three hand-authored `AssetReference` nodes
 * `Stapler_1..3` of one asset, each carrying its own `Agv` config on the
 * reference node itself. The main model's init binds those components while
 * the reference nodes are still EMPTY (the placement content materialises
 * later); before the fix that early bind saw no placement stamp, declared the
 * bare `Agv.Run` / `Agv.Moving` / … for all three vehicles and reported 11×
 * `instance-signal-collision` — the three stackers shared one status.
 *
 * Asserted on the real viewer load path (`loadModel` → deferred placements →
 * `PlacementInstancer`, fake asset loader):
 *  - no `instance-signal-collision`, no bare `Agv.*` name in the store;
 *  - every vehicle declares `Stapler_N.Agv.*`;
 *  - each vehicle's status is its own: only the one whose `Run` is set moves;
 *  - a DES lifetime claim (`__des-owner__/…`) on the same name is bookkeeping of
 *    the same instance, not a second node — no `signal-name-collision`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { ModelCache } from '../../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../../src/core/engine/rv-pick-build-port';
import { setAssetReference } from '../../src/core/engine/rv-asset-reference';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { getProblems, INSTANCE_SIGNAL_COLLISION_CODE } from '../../src/core/hmi/problems-store';
import { reportSignalCollisionAt } from '../../src/core/engine/rv-signal-construction';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { clearShared } from '../helpers/agv-harness';

const DT = 1 / 60;
const HOLD = 'plan-612-ref-scope';
const URL_STACKER = 'blob:rv-test/p612-stacker.glb';
const STACKERS = ['Stapler_1', 'Stapler_2', 'Stapler_3'] as const;

type V3 = [number, number, number];

function pathNode(id: string, from: V3, to: V3): Object3D {
  const n = new Object3D();
  n.name = id;
  n.userData.realvirtual = {
    Path: { type: 'Path', version: 1, closed: false, align: [0, 1, 0], id, segments: [{ kind: 'line', from, to }], successors: [] },
  };
  return n;
}

/** The placed asset: a body only — the `Agv` sits on the reference node. */
function stackerAsset(): Group {
  const root = new Group();
  root.name = 'AGVStacker';
  const body = new Mesh(new BoxGeometry(0.8, 0.4, 1.6), new MeshBasicMaterial());
  body.position.y = 0.2;
  root.add(body);
  return root;
}

function stackerRef(name: string, pathId: string): Object3D {
  const node = new Object3D();
  node.name = name;
  setNodeId(node, `nid-${name}`);
  setAssetReference(node, { assetId: 'cat:p612-stacker.glb', path: URL_STACKER });
  (node.userData.realvirtual as Record<string, unknown>).Agv = {
    PathId: pathId, StartPosition: 500, TargetSpeed: 1000, VehicleLength: 1600, VehicleWidth: 800,
  };
  return node;
}

const settleDevServer = (): Promise<void> => new Promise((r) => setTimeout(r, 2500));

let handle: TestViewerHandle;
let viewer: RVViewer;
const tick = (): void => { (viewer as unknown as { _tickOnce(dt: number): void })._tickOnce(DT); };

beforeAll(async () => {
  clearShared();
  handle = await createTestViewer('webgl');
  viewer = handle.viewer;
  const loader = {
    loadAsync: async (url: string): Promise<{ scene: Group }> => {
      if (url !== URL_STACKER) throw new Error(`fake loader: unknown url ${url}`);
      return { scene: stackerAsset() };
    },
  } as unknown as GLTFLoader;
  viewer.placements.setModelCache(new ModelCache(loader, {
    uber: () => viewer.placementUberMaterial,
    isWebGPU: () => viewer.isWebGPU,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
  }));
  viewer.loop.setPaused(HOLD, true);
  registerAllBehaviors(viewer.behaviors);
}, 180_000);

afterAll(async () => { await settleDevServer(); handle?.dispose(); clearShared(); }, 30_000);

describe('plan-612 #149 — Agv on three reference nodes: one scope per stacker', () => {
  it('no instance-signal-collision, no bare Agv.*, each stacker status independent', async () => {
    const doc = new Group();
    doc.name = 'Yard';
    doc.add(pathNode('LaneA', [0, 0, 0], [30, 0, 0]));
    doc.add(pathNode('LaneB', [0, 0, 6], [30, 0, 6]));
    doc.add(pathNode('LaneC', [0, 0, 12], [30, 0, 12]));
    doc.add(stackerRef('Stapler_1', 'LaneA'));
    doc.add(stackerRef('Stapler_2', 'LaneB'));
    doc.add(stackerRef('Stapler_3', 'LaneC'));
    await viewer.loadModel('p612-ref-scope.glb', { data: await objectToGlb(doc) });
    await viewer.whenSceneReady();
    await viewer.placements.whenMaterialized();
    viewer.scene.updateMatrixWorld(true);

    const collisions = getProblems().filter((p) => p.code === INSTANCE_SIGNAL_COLLISION_CODE);
    expect(collisions.map((p) => p.id), 'no instance-signal-collision').toEqual([]);

    const store = viewer.signalStore!;
    const names = [...store.getAll().keys()];
    expect(names.filter((n) => n.startsWith('Agv.')), 'no bare Agv.* name').toEqual([]);
    for (const s of STACKERS) {
      expect(names, s).toContain(`${s}.Agv.Run`);
      expect(names, s).toContain(`${s}.Agv.Moving`);
      expect(names, s).toContain(`${s}.Agv.AtNode`);
    }

    // Independent status: only Stapler_2 runs.
    for (const s of STACKERS) store.set(`${s}.Agv.Run`, s === 'Stapler_2');
    for (let i = 0; i < 60; i++) tick();
    expect(store.get('Stapler_2.Agv.Moving'), 'Stapler_2 moves').toBe(true);
    expect(store.get('Stapler_1.Agv.Moving'), 'Stapler_1 stands').toBe(false);
    expect(store.get('Stapler_3.Agv.Moving'), 'Stapler_3 stands').toBe(false);
    expect(Number(store.get('Stapler_2.Agv.Position'))).toBeGreaterThan(500);
    expect(Number(store.get('Stapler_1.Agv.Position'))).toBeCloseTo(500, 0);

    // DES claims the vehicle's names with a synthetic owner path (plan-645 L6):
    // re-running the collision rule must not count it as a second node.
    const name = 'Stapler_1.Agv.Run';
    const modelPath = store.registeredPaths(name).find((p) => !p.startsWith('__'));
    expect(modelPath, 'model path of Stapler_1.Agv.Run').toBeTruthy();
    const sigNode = viewer.registry!.getNode(modelPath!);
    expect(sigNode, 'signal node').toBeTruthy();
    expect(store.addOwnerPath(name, `__des-owner__/r/1/x/${name}`, store.get(name) ?? false)).toBe(true);
    reportSignalCollisionAt(store, sigNode!, name, modelPath!, true);
    const nameCollisions = getProblems().filter((p) => p.code === 'signal-name-collision' || p.code === INSTANCE_SIGNAL_COLLISION_CODE);
    expect(nameCollisions.map((p) => p.id), 'no collision from a DES owner claim').toEqual([]);
  }, 180_000);
});

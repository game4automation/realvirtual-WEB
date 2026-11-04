// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-559 §9.8 (Phase 2b) — the scoped fleet id.
 *
 * A real `RVViewer` loads a layout document with two loops of paths (main
 * model) and two PLACEMENTS `Inst1` / `Inst2` of ONE asset whose vehicle child
 * is named `AGV` (same name in both copies — the case the root-name id could
 * not tell apart). `Inst2` moves its vehicle to the second loop by a `byPath`
 * override on `AGV`. Expected:
 *   - both register in the fleet, as `Inst1.AGV` / `Inst2.AGV`;
 *   - no `fleet-id-collision`;
 *   - both get a task and both reach it (sim time, fixed ticks).
 * A document without placements keeps the plain root-name ids.
 *
 * Every comparison first proves the value exists (#211). No wall clock: motion
 * is advanced by `_tickOnce` steps of the paused loop, every loop is bounded.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { ModelCache } from '../../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../../src/core/engine/rv-pick-build-port';
import { setAssetOverrides, setAssetReference } from '../../src/core/engine/rv-asset-reference';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { getDefaultAgvFleet, FLEET_ID_COLLISION_CODE, type AgvTask } from '../../src/core/engine/rv-agv-fleet';
import { getProblems, resetProblemsForTests } from '../../src/core/hmi/problems-store';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { clearShared } from '../helpers/agv-harness';

const DT = 1 / 60;
const HOLD = 'plan-559-2b-scoped-id';
/** Hard bound for every drive phase (≈ 25 s sim time). */
const MAX_STEPS = 1500;
const AGV_URL = 'blob:rv-test/p559-2b-agv.glb';

type V3 = [number, number, number];

function pathNode(id: string, from: V3, to: V3, successors: string[]): Object3D {
  const n = new Object3D();
  n.name = id;
  n.userData.realvirtual = {
    Path: { type: 'Path', version: 1, closed: false, align: [0, 1, 0], id, segments: [{ kind: 'line', from, to }], successors },
  };
  return n;
}

const agvCfg = (pathId: string): Record<string, unknown> => ({
  PathId: pathId, StartPosition: 0, TargetSpeed: 1000, VehicleLength: 1000, VehicleWidth: 600,
});

/** A vehicle root named `name` with its Agv config and a body. */
function vehicle(name: string, pathId: string): Object3D {
  const agv = new Object3D();
  agv.name = name;
  agv.userData.realvirtual = { Agv: agvCfg(pathId) };
  const body = new Mesh(new BoxGeometry(0.6, 0.3, 1), new MeshBasicMaterial());
  body.position.y = 0.15;
  agv.add(body);
  return agv;
}

/** Two loops: A1 ↔ A2 at z = 0 and B1 ↔ B2 at z = 6. */
function loops(): Object3D[] {
  return [
    pathNode('A1', [0, 0, 0], [3, 0, 0], ['A2']),
    pathNode('A2', [3, 0, 0], [0, 0, 0.5], ['A1']),
    pathNode('B1', [0, 0, 6], [3, 0, 6], ['B2']),
    pathNode('B2', [3, 0, 6], [0, 0, 6.5], ['B1']),
  ];
}

function referenceNode(name: string, id: string, pos: V3): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(...pos);
  setNodeId(node, id);
  setAssetReference(node, { assetId: 'cat:p559-2b-agv', path: AGV_URL });
  return node;
}

/** Same settle as agv-lifetime-placement.test.ts (Vite watcher race at teardown). */
const settleDevServer = (): Promise<void> => new Promise((r) => setTimeout(r, 2500));

let handle: TestViewerHandle;
let viewer: RVViewer;

const tick = (): void => { (viewer as unknown as { _tickOnce(dt: number): void })._tickOnce(DT); };
function tickUntil(done: () => boolean): number {
  let n = 0;
  while (!done() && n < MAX_STEPS) { tick(); n++; }
  return n;
}

const fleetIds = (): string[] => getDefaultAgvFleet().all().map((h) => h.id).sort();
const fleetCollisions = () => getProblems().filter((p) => p.code === FLEET_ID_COLLISION_CODE);

beforeAll(async () => {
  clearShared();
  handle = await createTestViewer('webgl');
  viewer = handle.viewer;
  const loader = {
    loadAsync: async (url: string): Promise<{ scene: Group }> => {
      if (url !== AGV_URL) throw new Error(`fake loader: unknown url ${url}`);
      // Asset root `Cart`, the vehicle is its child `AGV` — CONTENT of the placement.
      const cart = new Group();
      cart.name = 'Cart';
      cart.add(vehicle('AGV', 'A1'));
      return { scene: cart };
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

beforeEach(() => { resetProblemsForTests(); });

afterAll(async () => { await settleDevServer(); handle?.dispose(); clearShared(); resetProblemsForTests(); }, 30_000);

describe('plan-559 §9.8 (2b) — scoped fleet id', () => {
  it('two placements whose vehicle has the same name register as Inst1.AGV / Inst2.AGV, no collision, both drive their task', async () => {
    const doc = new Group();
    doc.name = 'Layout';
    for (const p of loops()) doc.add(p);
    doc.add(referenceNode('Inst1', 'nid-p559-2b-1', [0, 0, 0]));
    const inst2 = referenceNode('Inst2', 'nid-p559-2b-2', [0, 0, 6]);
    // Asset-relative override of the vehicle node: Inst2 starts on the second loop.
    setAssetOverrides(inst2, { byAddress: {}, legacyByPath: { AGV: { Agv: agvCfg('B1') } } });
    doc.add(inst2);
    await viewer.loadModel('p559-2b-placements.glb', { data: await objectToGlb(doc) });
    await viewer.whenSceneReady();
    await viewer.placements.whenMaterialized();
    viewer.scene.updateMatrixWorld(true);

    // Both vehicle nodes exist and carry the SAME name.
    const n1 = viewer.scene.getObjectByName('Inst1')?.getObjectByName('AGV') ?? null;
    const n2 = viewer.scene.getObjectByName('Inst2')?.getObjectByName('AGV') ?? null;
    expect(n1, 'Inst1/AGV').toBeTruthy();
    expect(n2, 'Inst2/AGV').toBeTruthy();
    expect(n1).not.toBe(n2);

    const fleet = getDefaultAgvFleet();
    const ids = fleetIds();
    console.log('[plan-559 2b] fleet ids:', ids.join(','));
    expect(ids).toEqual(['Inst1.AGV', 'Inst2.AGV']);
    const h1 = fleet.get('Inst1.AGV');
    const h2 = fleet.get('Inst2.AGV');
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(h1!.node).toBe(n1);
    expect(h2!.node).toBe(n2);
    expect(h1!.startPathId).toBe('A1');
    expect(h2!.startPathId).toBe('B1');
    expect(fleetCollisions()).toEqual([]);

    // Both get a task and both reach it.
    const arrived: string[] = [];
    const task = (destination: string): AgvTask => ({
      destination,
      onArrive: (agvId) => { arrived.push(`${agvId}@${destination}`); },
    });
    const start1 = n1!.getWorldPosition(new Vector3());
    const start2 = n2!.getWorldPosition(new Vector3());
    const cur = new Vector3();
    let far1 = 0;
    let far2 = 0;
    h1!.assign(task('A2'));
    h2!.assign(task('B2'));
    const steps = tickUntil(() => {
      far1 = Math.max(far1, n1!.getWorldPosition(cur).distanceTo(start1));
      far2 = Math.max(far2, n2!.getWorldPosition(cur).distanceTo(start2));
      return arrived.length >= 2;
    });
    console.log('[plan-559 2b] arrivals after', steps, 'steps:', arrived.join(','), 'max travel m:', far1.toFixed(3), far2.toFixed(3));
    expect(steps, 'both arrived within the bound').toBeLessThan(MAX_STEPS);
    expect(arrived.sort()).toEqual(['Inst1.AGV@A2', 'Inst2.AGV@B2']);
    // Both drove the loop (A1 is 3 m long; its far end is ≈ 3 m from the start).
    expect(far1, 'Inst1 moved').toBeGreaterThan(2);
    expect(far2, 'Inst2 moved').toBeGreaterThan(2);
    expect(fleetCollisions()).toEqual([]);
  }, 180_000);

  it('a document without placements keeps the plain root-name ids', async () => {
    const doc = new Group();
    doc.name = 'Hall';
    for (const p of loops()) doc.add(p);
    const vehicles = new Group();
    vehicles.name = 'Vehicles';
    vehicles.add(vehicle('AGV_A', 'A1'));
    vehicles.add(vehicle('AGV_B', 'B1'));
    doc.add(vehicles);
    await viewer.loadModel('p559-2b-plain.glb', { data: await objectToGlb(doc) });
    await viewer.whenSceneReady();
    viewer.scene.updateMatrixWorld(true);

    const ids = fleetIds();
    console.log('[plan-559 2b] plain fleet ids:', ids.join(','));
    expect(ids).toEqual(['AGV_A', 'AGV_B']);
    expect(getDefaultAgvFleet().get('AGV_A')).not.toBeNull();
    expect(fleetCollisions()).toEqual([]);
  }, 180_000);
});

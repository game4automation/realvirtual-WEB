// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-source-pose-handover-scene.test.ts — plan-638 Gate R1 #8: the REAL
 * library assets on the REAL viewer load path.
 *
 * One in-memory layout document with three `AssetReference` placements —
 * `RollConveyor-2m.glb`, `EuropalletLoaded.glb` (a self-template Source) lying
 * on its rollers, `PalletSink.glb` at the belt end — loaded by a real
 * `RVViewer` (placements materialised by the `PlacementInstancer`), then
 * switched to DES (`simulationKernel.setMode('des')` → `bindSceneToRunner`).
 * Asserted:
 *
 *  - the source is bound to the conveyor through a contained link and hands
 *    the pallet over AT its spawn pose: spawn world pose (the clone the engine
 *    source made) == first tween world pose (≤ 2 mm), including the placement
 *    (parent) transform — once unrotated, once with every placement turned 90°
 *    and offset;
 *  - the rest time is (L − s)/v of the real belt;
 *  - rebind with a changed target (pallet moved off the belt → standard path)
 *    and with the target removed (no contained link);
 *  - continuous operation is unchanged: the continuous Source has no private
 *    backend, the engine source spawns as before and nothing is reported.
 *
 * Runs are bounded by step counts and SIM time. Runs only in the private build.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D, Vector3, Box3 } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { registerAllBehaviors } from '../src/core/behaviors';
import { getEngineSourceForNode, type RVSource } from '../src/core/engine/rv-source';
import { getProblems } from '../src/core/hmi/problems-store';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { DESRunner } from '@rv/plugins/des/des-runner';
import { containedTargetOf } from '@rv/plugins/des/des-scene-binding';
import { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import type { DESMU } from '@rv/plugins/des/rv-des-mu';

const CONVEYOR = 'library/PalletHandling/RollConveyor-2m.glb';
const PALLET = 'library/PalletHandling/EuropalletLoaded.glb';
const SINK = 'library/PalletHandling/PalletSink.glb';

type V3 = [number, number, number];

/** Content offset of each asset under its reference node (asset root position). */
interface Layout {
  /** Yaw of every placement (rad) and a world offset of the whole line. */
  yaw: number;
  offset: V3;
  /** Pallet origin along the belt, relative to the belt centre (m). */
  palletAlong: number;
}

function refNode(name: string, path: string): Object3D {
  const n = new Object3D();
  n.name = name;
  setNodeId(n, `nid-${name}`);
  setAssetReference(n, { assetId: `cat:${path.split('/').pop()}`, path });
  return n;
}

const worldPos = (n: Object3D): V3 => {
  n.updateWorldMatrix(true, false);
  const v = n.getWorldPosition(new Vector3());
  return [v.x, v.y, v.z];
};
const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** First node named `name` under `root` (breadth first). */
function find(root: Object3D, name: string): Object3D | null {
  const q: Object3D[] = [root];
  while (q.length) {
    const n = q.shift()!;
    if (n.name === name) return n;
    q.push(...n.children);
  }
  return null;
}

interface Loaded {
  h: TestViewerHandle;
  v: RVViewer;
  model: Object3D;
  conveyorRef: Object3D;
  palletRef: Object3D;
  /** The Source node (asset root of EuropalletLoaded). */
  source: Object3D;
  engine: RVSource;
  belt: Object3D;
}

/**
 * Load the three placements, then move the reference nodes so that the belt
 * centre sits at `offset`, the pallet origin lies on the roller top `palletAlong`
 * metres along the flow, and the sink touches the belt end — measured from the
 * materialised content (the assets carry their own root offsets).
 */
async function loadLine(l: Layout): Promise<Loaded> {
  const h = await createTestViewer('webgl');
  const v = h.viewer;
  v.loop.setPaused('plan-638-scene', true);
  registerAllBehaviors(v.behaviors);
  const doc = new Group();
  doc.name = 'PoseDoc';
  doc.add(refNode('Conveyor_1', CONVEYOR), refNode('Pallet_1', PALLET), refNode('PalletSink_1', SINK));
  await v.loadModel('plan-638-scene.glb', { data: await objectToGlb(doc) });
  await v.whenSceneReady();
  const model = (v as unknown as { currentModel: Object3D }).currentModel;
  v.scene.updateMatrixWorld(true);

  const conveyorRef = find(model, 'Conveyor_1')!;
  const palletRef = find(model, 'Pallet_1')!;
  const sinkRef = find(model, 'PalletSink_1')!;
  expect(conveyorRef, 'Conveyor_1 placement').not.toBeNull();
  expect(palletRef, 'Pallet_1 placement').not.toBeNull();
  expect(sinkRef, 'PalletSink_1 placement').not.toBeNull();
  const belt = find(conveyorRef, 'Transport-Z');
  const source = find(palletRef, 'EuropalletLoaded');
  expect(belt, 'RollConveyor Transport-Z').not.toBeNull();
  expect(source, 'EuropalletLoaded source node').not.toBeNull();

  // Belt geometry in the conveyor's OWN frame (placement unrotated at load).
  const beltBox = new Box3().setFromObject(belt!);
  const beltCentre = beltBox.getCenter(new Vector3());
  const rollerTop = beltBox.max.y;
  const sinkNode = find(sinkRef, 'PalletSink')!;
  expect(sinkNode, 'PalletSink node').not.toBeNull();
  const sinkBox = new Box3().setFromObject(sinkRef);
  const sinkHalf = (sinkBox.max.z - sinkBox.min.z) / 2;
  const sinkCentre = sinkBox.getCenter(new Vector3());
  const palletOrigin = worldPos(source!);

  // Place everything in a local line frame (flow = +Z), then turn by `yaw` and shift.
  const yaw = l.yaw;
  const rot = (x: number, z: number): [number, number] => [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];
  const place = (ref: Object3D, contentAt: Vector3 | V3, target: V3): void => {
    // `contentAt` = world point of the content with the ref at identity; the ref
    // is moved so that this point lands on `target` after the yaw.
    const c = Array.isArray(contentAt) ? contentAt : [contentAt.x, contentAt.y, contentAt.z];
    const [rx, rz] = rot(c[0], c[2]);
    ref.rotation.set(0, yaw, 0);
    ref.position.set(target[0] - rx, target[1] - c[1], target[2] - rz);
  };
  const lineToWorld = (x: number, y: number, z: number): V3 => {
    const [rx, rz] = rot(x, z);
    return [l.offset[0] + rx, l.offset[1] + y, l.offset[2] + rz];
  };
  const beltHalf = (beltBox.max.z - beltBox.min.z) / 2;
  place(conveyorRef, [beltCentre.x, 0, beltCentre.z], lineToWorld(0, 0, 0));
  place(palletRef, [palletOrigin[0], palletOrigin[1], palletOrigin[2]], lineToWorld(0, rollerTop, l.palletAlong));
  place(sinkRef, [sinkCentre.x, 0, sinkCentre.z], lineToWorld(0, 0, beltHalf + sinkHalf - 0.05));
  v.scene.updateMatrixWorld(true);

  const engine = getEngineSourceForNode(source!);
  expect(engine, 'engine RVSource of the pallet').not.toBeNull();
  return { h, v, model, conveyorRef, palletRef, source: source!, engine: engine!, belt: belt! };
}

function startDes(x: Loaded): DESRunner {
  const quiet = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    x.v.simulationKernel!.setMode('des');
  } finally {
    quiet.mockRestore();
  }
  const runner = x.v.simulationKernel!.desControl() as unknown as DESRunner;
  expect(runner, 'DES runner').toBeTruthy();
  return runner;
}

const instanceOf = (runner: DESRunner, pred: (root: Object3D, type: string) => boolean): MaterialFlowAdapter | null =>
  (runner.liveInstances.find((i) => pred(i.self.root, i.def.type))?.adapter as MaterialFlowAdapter | undefined) ?? null;

const sourceProblems = () => getProblems().filter((p) => p.code === 'source-pose-unsupported');

let open: Loaded | null = null;
afterEach(() => {
  open?.h.dispose();
  open = null;
});

describe('plan-638 R1 #8 — EuropalletLoaded on a real RollConveyor (viewer load path)', () => {
  for (const layout of [
    { name: 'placements unrotated', yaw: 0, offset: [0, 0, 0] as V3, palletAlong: -0.3 },
    { name: 'placements turned 90° and offset', yaw: Math.PI / 2, offset: [4, 0.25, -3] as V3, palletAlong: -0.2 },
  ]) {
    it(`${layout.name}: contained link, spawn pose == first tween pose (≤ 2 mm), rest time (L − s)/v`, async () => {
      const x = (open = await loadLine(layout));
      const spawnAt = worldPos(x.source);
      const runner = startDes(x);
      const src = instanceOf(runner, (r, t) => t === 'Source' && r === x.source);
      const conv = instanceOf(runner, (r, t) => t === 'Conveyor' && r === x.conveyorRef);
      expect(src, `source instance; bound: ${runner.liveInstances.map((i) => `${i.def.type}:${i.self.root.name}`).join(' ')}`).not.toBeNull();
      expect(conv, 'conveyor instance').not.toBeNull();
      expect(containedTargetOf(src!), 'the pallet source lies on the conveyor (contained)').toBe(conv);
      expect((src!.self.poseReadiness() as { state: string; reason?: string }).state, 'belt occupied by the first pallet').toBe('blocked');

      // The first pallet was spawned and handed over inside the DES start (t = 0).
      const mu = conv!.heldMUs[0] as DESMU | undefined;
      expect(mu, 'pallet on the belt').toBeDefined();
      const node = (mu!.visual as { node?: Object3D } | null)?.node ?? null;
      expect(node, 'pallet visual (clone of the engine source)').not.toBeNull();
      expect(dist(worldPos(node!), spawnAt), 'spawn world pose').toBeLessThanOrEqual(0.002);
      runner.tick(0.001); runner.lateTick(0.001);
      expect(dist(worldPos(node!), spawnAt), 'first tween world pose').toBeLessThanOrEqual(0.002);

      // Rest time: the pallet leaves the belt after (L − s)/v of the real belt.
      const timer = (conv!.self.local as unknown as { timer: { length: number; speed: number; entryPos: V3; exitPos: V3 } }).timer;
      const lengthM = dist(timer.entryPos, timer.exitPos);
      const flow = timer.exitPos.map((e, i) => (e - timer.entryPos[i]) / lengthM);
      const along = (spawnAt[0] - timer.entryPos[0]) * flow[0] + (spawnAt[2] - timer.entryPos[2]) * flow[2];
      const bug = (mu as unknown as { _bugSize: V3 })._bugSize[2] / 2;
      expect(bug).toBeCloseTo(x.engine.templateSize()![2] / 2, 9);
      const remaining = ((lengthM - Math.min(lengthM, along + bug)) * 1000) / timer.speed;
      const t0 = runner.simTime;
      let left = -1;
      for (let i = 0; i < 2000 && left < 0; i++) {
        runner.tick(0.01); runner.lateTick(0.01);
        if (!conv!.heldMUs.includes(mu!)) left = runner.getManager().currentTime;
      }
      expect(left, 'the pallet left the belt').toBeGreaterThan(0);
      expect(left - t0).toBeCloseTo(remaining, 6);
      expect(sourceProblems()).toHaveLength(0);
    }, 120_000);
  }

  it('rebind: pallet moved off the belt → standard path; conveyor removed → no contained target', async () => {
    const x = (open = await loadLine({ yaw: 0, offset: [0, 0, 0], palletAlong: -0.3 }));
    const runner = startDes(x);
    const quiet = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // Changed target: the pallet stands 0.2 m before the belt entry, on the floor.
      x.palletRef.position.z -= 1.5;
      x.palletRef.position.y -= 0.5;
      x.v.scene.updateMatrixWorld(true);
      runner.rebindScene();
      const src = instanceOf(runner, (r, t) => t === 'Source' && r === x.source)!;
      expect(src).not.toBeNull();
      expect(containedTargetOf(src)).toBeNull();
      expect(src.self.poseReadiness()).toEqual({ state: 'fallback', reason: 'not-contained' });

      // Removed target: back onto the belt position, but the conveyor is gone.
      x.palletRef.position.z += 1.5;
      x.palletRef.position.y += 0.5;
      x.conveyorRef.removeFromParent();
      x.v.scene.updateMatrixWorld(true);
      runner.rebindScene();
      expect(runner.liveInstances.some((i) => i.self.root === x.conveyorRef)).toBe(false);
      const src2 = instanceOf(runner, (r, t) => t === 'Source' && r === x.source)!;
      expect(containedTargetOf(src2)).toBeNull();
      expect(src2.self.poseReadiness()).toEqual({ state: 'fallback', reason: 'not-contained' });
    } finally {
      quiet.mockRestore();
    }
  }, 120_000);

  it('continuous operation: no pose backend, the engine source spawns as before, nothing reported', async () => {
    const x = (open = await loadLine({ yaw: 0, offset: [0, 0, 0], palletAlong: -0.3 }));
    expect(x.v.simulationKernel!.mode).toBe('continuous');
    const createdBefore = x.engine.Created;
    const tick = (x.v as unknown as { _tickOnce(dt: number): void })._tickOnce.bind(x.v);
    const pose = vi.spyOn(MaterialFlowAdapter.prototype, 'canAcceptPoseProbe');
    for (let i = 0; i < 120; i++) tick(1 / 60);
    expect(x.engine.Created, 'the continuous engine source spawned').toBeGreaterThan(createdBefore);
    expect(pose).not.toHaveBeenCalled();
    pose.mockRestore();
    expect(sourceProblems()).toHaveLength(0);
  }, 120_000);
});

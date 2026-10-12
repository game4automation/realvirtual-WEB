// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Node bounds inside a baked model (plan-756 F6).
 *
 * After a destructive bake a node whose triangles were merged into an ancestor's
 * chunk has NO `Mesh` descendant, so `computeSubtreeAABB` answered with the
 * 0.1 m fallback cube — a camera focus onto nothing, an isolate box around a
 * point, a gizmo scaled to a speck. It now asks the bake registry for the union
 * of the SEGMENT boxes of the node's subtree, transformed by the chunk mesh's
 * `matrixWorld`.
 *
 * Pinned here: the box IS the subtree's geometry (never the 0.1 m cube), a node
 * under a moving mover follows the motion, a mirrored placement mirrors, a node
 * with no geometry at all still falls back, and without the injected source
 * nothing changes at all (every non-baking context).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Box3, Group, Scene, Vector3 } from 'three';
import type { Object3D } from 'three';
import '../src/core/engine/rv-scene-loader'; // installs the capability table
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import type { BakedAsset } from '../src/core/engine/rv-bake-chunk';
import { computeSubtreeAABB, setChunkBoundsSource } from '../src/core/engine/rv-traverse-utils';
import { bakeTree, group, uberMesh, withComponent } from './fixtures/bake-fixture';

const uber = new RVUberMaterial(false);

/**
 * Machine
 *  ├── frame                       (static chunk)
 *  ├── Assembly           plain group, survives as ANCESTOR of Sensor-1
 *  │    ├── plate  [0, 2, 0]
 *  │    └── Sensor-1               component
 *  │         └── eye   [0, 0, -3]
 *  ├── Marker                      component, no geometry at all
 *  └── Drive-A                     mover → own chunk
 *       └── Carrier       plain group, survives as ANCESTOR of Sensor-2
 *            └── Sensor-2          component
 *                 └── tip  [0, 0, 5]
 */
function makeAsset(): Group {
  const root = group('Machine');
  root.add(uberMesh(uber, 'frame'));

  const assembly = group('Assembly');
  assembly.add(uberMesh(uber, 'plate', [0, 2, 0]));
  const sensor = withComponent(group('Sensor-1'), 'Sensor');
  sensor.add(uberMesh(uber, 'eye', [0, 0, -3]));
  assembly.add(sensor);
  root.add(assembly);

  root.add(withComponent(group('Marker'), 'Sensor'));

  const drive = withComponent(group('Drive-A'), 'Drive');
  const carrier = group('Carrier');
  const sensor2 = withComponent(group('Sensor-2'), 'Sensor');
  sensor2.add(uberMesh(uber, 'tip', [0, 0, 5]));
  carrier.add(sensor2);
  drive.add(carrier);
  root.add(drive);
  return root;
}

/** Box of a unit box centred at `p`, shifted by the placement offset. */
function unitBoxAt(p: [number, number, number], offsetX = 4): Box3 {
  return new Box3(
    new Vector3(p[0] - 0.5 + offsetX, p[1] - 0.5, p[2] - 0.5),
    new Vector3(p[0] + 0.5 + offsetX, p[1] + 0.5, p[2] + 0.5),
  );
}

function expectBoxClose(actual: Box3, expected: Box3, eps = 1e-4): void {
  expect(actual.min.x).toBeCloseTo(expected.min.x, 4);
  expect(actual.min.y).toBeCloseTo(expected.min.y, 4);
  expect(actual.min.z).toBeCloseTo(expected.min.z, 4);
  expect(actual.max.x).toBeCloseTo(expected.max.x, 4);
  expect(actual.max.y).toBeCloseTo(expected.max.y, 4);
  expect(actual.max.z).toBeCloseTo(expected.max.z, 4);
  expect(eps).toBeGreaterThan(0);
}

describe('computeSubtreeAABB on a baked model (plan-756 F6)', () => {
  afterEach(() => { setChunkBoundsSource(null); });

  /**
   * The main-model case: a DESTRUCTIVE bake placed as the identity instance, so
   * every survivor — a plain structural ancestor included — is a real scene node.
   * `scale` is applied by a wrapper above the template, which is how a mirrored
   * placement reaches the chunk meshes.
   */
  async function setup(scale = 1) {
    const scene = new Scene();
    const registry = new BakeRegistry();
    const baked: BakedAsset = await bakeTree(makeAsset(), { uber, destructive: true });
    const inst = registry.instantiateTemplate(baked);
    const wrapper = new Group(); wrapper.name = 'P';
    wrapper.scale.setScalar(scale); wrapper.position.x = 4;
    wrapper.add(baked.template);
    scene.add(wrapper);
    scene.updateMatrixWorld(true);
    const node = (name: string): Object3D => {
      let found: Object3D | null = null;
      baked.template.traverse((n) => { if (!found && n.name === name) found = n; });
      if (!found) throw new Error(`node "${name}" did not survive the bake`);
      return found;
    };
    return { scene, registry, wrapper, inst, node };
  }

  it('a plain structural node reports the union of its subtree segments, not a 0.1 m cube', async () => {
    const { registry, node } = await setup();
    const assembly = node('Assembly');
    // No mesh anywhere below it — that is the whole point.
    let meshes = 0;
    assembly.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) meshes++; });
    expect(meshes).toBe(0);

    const fallback = computeSubtreeAABB(assembly, new Box3());
    expect(fallback.size.x).toBeCloseTo(0.1, 6); // untouched without the source

    setChunkBoundsSource(registry);
    const { box, size } = computeSubtreeAABB(assembly, new Box3());
    // plate at y=+2 and eye at z=-3, both unit boxes, placement offset x=+4.
    expectBoxClose(box, unitBoxAt([0, 2, 0]).union(unitBoxAt([0, 0, -3])));
    expect(size.y).toBeCloseTo(3, 4);
    expect(size.z).toBeCloseTo(4, 4);
  });

  it('is never SMALLER than the triangles it covers (segment-box slack only outwards)', async () => {
    const { registry, node, inst } = await setup();
    setChunkBoundsSource(registry);
    const sensorBox = computeSubtreeAABB(node('Sensor-1'), new Box3()).box;
    const eye = unitBoxAt([0, 0, -3]);
    expect(sensorBox.containsBox(eye)).toBe(true);
    // And it stays inside the chunk it was read from.
    const staticMesh = inst.chunks.find((m) => m.name === 'static')!;
    const chunkBox = new Box3().setFromObject(staticMesh);
    expect(chunkBox.containsBox(sensorBox)).toBe(true);
  });

  it('a node under a MOVING mover follows the motion', async () => {
    const { registry, node, scene } = await setup();
    setChunkBoundsSource(registry);
    const carrier = node('Carrier');
    const before = computeSubtreeAABB(carrier, new Box3()).box.clone();
    expectBoxClose(before, unitBoxAt([0, 0, 5]));

    const drive = node('Drive-A');
    drive.position.y = 7;
    scene.updateMatrixWorld(true);
    const after = computeSubtreeAABB(carrier, new Box3()).box;
    expectBoxClose(after, unitBoxAt([0, 7, 5]));
  });

  it('a MIRRORED placement mirrors the box (same extents, negated frame)', async () => {
    const { registry, node } = await setup(-1);
    setChunkBoundsSource(registry);
    const { box, size } = computeSubtreeAABB(node('Assembly'), new Box3());
    // scale −1 about the placement origin at x=+4: min/max swap and negate.
    const local = unitBoxAt([0, 2, 0], 0).union(unitBoxAt([0, 0, -3], 0));
    expectBoxClose(box, new Box3(
      new Vector3(-local.max.x + 4, -local.max.y, -local.max.z),
      new Vector3(-local.min.x + 4, -local.min.y, -local.min.z),
    ));
    expect(size.y).toBeCloseTo(3, 4);
    expect(size.z).toBeCloseTo(4, 4);
  });

  it('a node with no geometry at all still falls back to the 0.1 m cube', async () => {
    const { registry, node } = await setup();
    setChunkBoundsSource(registry);
    const { size } = computeSubtreeAABB(node('Marker'), new Box3());
    expect(size.x).toBeCloseTo(0.1, 6);
    expect(size.y).toBeCloseTo(0.1, 6);
    expect(size.z).toBeCloseTo(0.1, 6);
  });

  it('a mover node keeps answering from its own chunk MESH (unchanged path)', async () => {
    const { registry, node } = await setup();
    setChunkBoundsSource(registry);
    const box = computeSubtreeAABB(node('Drive-A'), new Box3()).box;
    expectBoxClose(box, unitBoxAt([0, 0, 5]));
  });

  it('a node outside any baked placement is untouched by the seam', async () => {
    const { registry } = await setup();
    setChunkBoundsSource(registry);
    const lonely = new Group();
    lonely.position.set(1, 2, 3);
    lonely.updateMatrixWorld(true);
    expect(computeSubtreeAABB(lonely, new Box3()).size.x).toBeCloseTo(0.1, 6);
  });
});

describe('CameraManager.computeNodeBounds on a baked model (alarm-card focus)', () => {
  afterEach(() => { setChunkBoundsSource(null); });

  it('a survivor without own meshes frames its chunk segments instead of an EMPTY box', async () => {
    const { CameraManager } = await import('../src/core/rv-camera-manager');
    const scene = new Scene();
    const registry = new BakeRegistry();
    const baked: BakedAsset = await bakeTree(makeAsset(), { uber, destructive: true });
    registry.instantiateTemplate(baked);
    scene.add(baked.template);
    scene.updateMatrixWorld(true);
    let assembly: Object3D | null = null;
    baked.template.traverse((n) => { if (!assembly && n.name === 'Assembly') assembly = n; });
    expect(assembly).not.toBeNull();

    // The method reads no instance state — call it without a constructed manager.
    const compute = (CameraManager.prototype as unknown as { computeNodeBounds: (n: Object3D[]) => Box3 }).computeNodeBounds;
    const before = compute.call({}, [assembly!]);
    expect(before.isEmpty()).toBe(true); // the old behaviour: fitToNodes returned early

    setChunkBoundsSource(registry);
    const box = compute.call({}, [assembly!]);
    expect(box.isEmpty()).toBe(false);
    const expected = computeSubtreeAABB(assembly!, new Box3()).box;
    expect(box.min.toArray().map((v) => +v.toFixed(4))).toEqual(expected.min.toArray().map((v) => +v.toFixed(4)));
    expect(box.max.toArray().map((v) => +v.toFixed(4))).toEqual(expected.max.toArray().map((v) => +v.toFixed(4)));
  });
});

describe('CameraManager.computeNodeBounds — consecutive calls do not accumulate (focus-union regression)', () => {
  afterEach(() => { setChunkBoundsSource(null); });

  it('framing node B after node A gives B alone, not A ∪ B', async () => {
    const { CameraManager } = await import('../src/core/rv-camera-manager');
    const scene = new Scene();
    const registry = new BakeRegistry();
    const baked: BakedAsset = await bakeTree(makeAsset(), { uber, destructive: true });
    registry.instantiateTemplate(baked);
    scene.add(baked.template);
    scene.updateMatrixWorld(true);
    setChunkBoundsSource(registry);
    const find = (name: string): Object3D => { let f: Object3D | null = null; baked.template.traverse((n) => { if (!f && n.name === name) f = n; }); if (!f) throw new Error(name); return f; };
    const compute = (CameraManager.prototype as unknown as { computeNodeBounds: (n: Object3D[]) => Box3 }).computeNodeBounds;
    const assembly = find('Assembly');
    const eye = find('Sensor-1');
    const eyeAlone = computeSubtreeAABB(eye, new Box3()).box;
    compute.call({}, [assembly]);               // a previous focus on the bigger node
    const second = compute.call({}, [eye]);     // must NOT contain the assembly's extent
    expect(second.min.toArray().map((v) => +v.toFixed(4))).toEqual(eyeAlone.min.toArray().map((v) => +v.toFixed(4)));
    expect(second.max.toArray().map((v) => +v.toFixed(4))).toEqual(eyeAlone.max.toArray().map((v) => +v.toFixed(4)));
  });
});

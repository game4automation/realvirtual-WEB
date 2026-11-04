// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-675 §9.7 (D1) — a raycast sensor on a SCALED node (SolidCraft body,
 * 0.001): the drawn tube is 2 mm in world radius and `RayCastLength` long in
 * world, i.e. the drawn segment IS the detected segment; AutoRay converts the
 * local beam extent into world millimetres. Also: scaled ancestors and a
 * non-uniform scale, and the pre-bake beam stamp.
 */
import { describe, it, expect } from 'vitest';
import { Box3, BoxGeometry, Mesh, Object3D, Vector3 } from 'three';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import { RV_SENSOR_BEAM_KEY } from '../src/core/engine/rv-pre-bake-keys';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

function ctx(): ComponentContext {
  return {
    signalStore: { register: () => {}, set: () => {}, setByPath: () => {} },
    transportManager: { sensors: [] },
  } as unknown as ComponentContext;
}

function tubeOf(node: Object3D): Mesh {
  const t = node.children.find((c) => c.name.endsWith('_sensorRay')) as Mesh | undefined;
  expect(t, 'ray tube').toBeDefined();
  return t!;
}

/** World length along the beam and world radius of the drawn tube. */
function worldTube(tube: Mesh): { length: number; radius: number } {
  tube.updateWorldMatrix(true, false);
  const g = tube.geometry;
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  // Tube local frame: along +Z; radius in X/Y.
  const p0 = new Vector3(0, 0, bb.min.z).applyMatrix4(tube.matrixWorld);
  const p1 = new Vector3(0, 0, bb.max.z).applyMatrix4(tube.matrixWorld);
  // Hexagonal tube: the circumradius is the farthest vertex from the axis.
  const pos = g.getAttribute('position');
  let r = 0;
  for (let i = 0; i < pos.count; i++) r = Math.max(r, Math.hypot(pos.getX(i), pos.getY(i)));
  const pr = new Vector3(r, 0, bb.min.z).applyMatrix4(tube.matrixWorld);
  return { length: p0.distanceTo(p1), radius: pr.distanceTo(p0) };
}

function sensorUnder(scale: Vector3, parentScale = new Vector3(1, 1, 1)): { node: Object3D; s: RVSensor } {
  const parent = new Object3D(); parent.scale.copy(parentScale);
  const node = new Object3D(); node.name = 'Lichtschranke'; node.scale.copy(scale);
  parent.add(node);
  parent.updateMatrixWorld(true);
  const s = new RVSensor(node, new AABB());
  s.UseRaycast = true;
  s.RayCastDirection = { x: 1, y: 0, z: 0 } as never;
  s.RayCastLength = 620; // world mm
  return { node, s };
}

describe('plan-675 §9.7 sensor ray on a scaled node', () => {
  for (const [label, scale, parentScale] of [
    ['node scale 0.001', new Vector3(0.001, 0.001, 0.001), new Vector3(1, 1, 1)],
    ['ancestor scale 0.001', new Vector3(1, 1, 1), new Vector3(0.001, 0.001, 0.001)],
    ['unit scale (unchanged)', new Vector3(1, 1, 1), new Vector3(1, 1, 1)],
  ] as Array<[string, Vector3, Vector3]>) {
    it(`${label}: tube world radius 2 mm, world length = RayCastLength`, () => {
      const { node, s } = sensorUnder(scale, parentScale);
      s.init(ctx());
      const w = worldTube(tubeOf(node));
      expect(w.radius * 1000).toBeGreaterThan(1.9);
      expect(w.radius * 1000).toBeLessThan(2.1);
      expect(w.length * 1000).toBeCloseTo(620, 1);
    });
  }

  it('non-uniform scale: the length follows the scale along the beam', () => {
    const { node, s } = sensorUnder(new Vector3(0.002, 0.001, 0.001));
    s.init(ctx());
    const w = worldTube(tubeOf(node));
    expect(w.length * 1000).toBeCloseTo(620, 1);
  });

  it('the drawn segment is the detected segment (computeRayQueryBounds spans the same world length)', () => {
    const { node, s } = sensorUnder(new Vector3(0.001, 0.001, 0.001));
    s.init(ctx());
    const q = new AABB();
    s.computeRayQueryBounds(q);
    const span = q.max.clone().sub(q.min).length();
    expect(span * 1000).toBeCloseTo(worldTube(tubeOf(node)).length * 1000, 1);
  });

  it('AutoRay on a scaled body: the beam spans the mesh in WORLD millimetres (not ×1000)', () => {
    const node = new Object3D(); node.name = 'Sensor'; node.scale.setScalar(0.001);
    const housing = new Mesh(new BoxGeometry(600, 20, 20)); // 600 mm in the body's mm units
    node.add(housing);
    node.updateMatrixWorld(true);
    const s = new RVSensor(node, new AABB());
    s.AutoRay = true;
    s.init(ctx());
    // Local extent 600 body units × 0.001 = 0.6 m = 600 mm (was 600 000 mm before D1).
    expect(s.RayCastLength).toBeCloseTo(600, 3);
    expect(worldTube(tubeOf(node)).length * 1000).toBeCloseTo(600, 1);
  });

  it('AutoRay from the pre-bake stamp (bake merged the meshes): world millimetres too', () => {
    const node = new Object3D(); node.name = 'Sensor'; node.scale.setScalar(0.001);
    node.userData[RV_SENSOR_BEAM_KEY] = { originOffset: [-300, 0, 0], direction: { x: 1, y: 0, z: 0 }, lengthMm: 600 * 1000 };
    node.updateMatrixWorld(true);
    const s = new RVSensor(node, new AABB());
    s.AutoRay = true;
    s.init(ctx());
    expect(s.RayCastLength).toBeCloseTo(600, 3);
    const w = worldTube(tubeOf(node));
    expect(w.length * 1000).toBeCloseTo(600, 1);
    const box = new Box3().setFromObject(tubeOf(node));
    expect(box.getSize(new Vector3()).x * 1000).toBeCloseTo(600, 0);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-655 B1 — a SolidCraft collision sensor becomes occupied.
 *
 * The RM 8320 curve's sensor is a `Group` at the body origin whose `mesh_0`
 * child carries millimetre vertices far away from it (x 70–127, y 825–1431,
 * z 762–770 in the Z-up body, which sits under a 0.001 scale rotated −90° about
 * X). The destructive bake merges `mesh_0` into a chunk, so the loader's mesh
 * box was EMPTY at the node origin and a carton running through the beam never
 * overlapped it. The pre-bake hook now stamps the node-local box; the sensor
 * uses it and keeps its world extents current through placement rotations.
 */
import { describe, expect, it } from 'vitest';
import { BoxGeometry, Matrix4, Mesh, Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVSensor, computeSensorLocalBox } from '../src/core/engine/rv-sensor';
import { RV_SENSOR_BOX_KEY } from '../src/core/engine/rv-pre-bake-keys';

function curve(): { placement: Object3D; sensorNode: Object3D; mesh: Mesh } {
  const placement = new Object3D();
  const body = new Object3D();
  body.matrixAutoUpdate = false;
  body.matrix.copy(new Matrix4().makeRotationX(-Math.PI / 2).multiply(new Matrix4().makeScale(0.001, 0.001, 0.001)));
  placement.add(body);
  const sensors = new Object3D(); sensors.name = 'Sensors_1';
  const sensorNode = new Object3D(); sensorNode.name = 'Sensor';
  const geo = new BoxGeometry(127 - 70, 1431 - 825, 770 - 762);
  geo.translate((70 + 127) / 2, (825 + 1431) / 2, (762 + 770) / 2);
  const mesh = new Mesh(geo); mesh.name = 'mesh_0';
  sensorNode.add(mesh); sensors.add(sensorNode); body.add(sensors);
  placement.updateMatrixWorld(true);
  return { placement, sensorNode, mesh };
}

/** A 600 × 250 × 400 mm carton standing on the 750 mm transport plane at world (x, z). */
function cartonBox(x: number, z: number): AABB {
  const n = new Object3D();
  n.position.set(x, 0.75 + 0.125, z);
  n.updateMatrixWorld(true);
  return AABB.fromHalfSize(n, new Vector3(0.3, 0.125, 0.2));
}

/** Simulates the bake: stamp (pre-bake hook), then the source mesh is gone. */
function bake(sensorNode: Object3D, mesh: Mesh, stamp: boolean): void {
  if (stamp) sensorNode.userData[RV_SENSOR_BOX_KEY] = computeSensorLocalBox(sensorNode);
  mesh.parent?.remove(mesh);
}

describe('plan-655 B1 — sensor box from the pre-bake stamp', () => {
  it('computeSensorLocalBox measures the mesh_0 child in the sensor node frame (mm)', () => {
    const { sensorNode } = curve();
    const b = computeSensorLocalBox(sensorNode)!;
    expect(b.c[0]).toBeCloseTo(98.5, 3);
    expect(b.c[1]).toBeCloseTo(1128, 3);
    expect(b.c[2]).toBeCloseTo(766, 3);
    expect(b.h[1]).toBeCloseTo(303, 3);
  });

  it('reproduction: without the stamp the baked sensor box is empty at the node origin and never occupied', () => {
    const { sensorNode, mesh } = curve();
    bake(sensorNode, mesh, false);
    const s = new RVSensor(sensorNode, AABB.fromNode(sensorNode));
    s.updateAABB();
    expect(s.aabb.overlaps(cartonBox(0.1, -1.13))).toBe(false);
  });

  it('with the stamp the box sits on the beam: a carton in the beam overlaps, one beside it does not', () => {
    const { sensorNode, mesh } = curve();
    bake(sensorNode, mesh, true);
    const s = new RVSensor(sensorNode, AABB.fromNode(sensorNode));
    s.updateAABB();
    // World: x 0.070–0.127, z −1.431…−0.825 (Z-up y → −world z), height 0.762–0.770.
    expect(s.aabb.min.y).toBeCloseTo(0.762, 4);
    expect(s.aabb.max.y).toBeCloseTo(0.770, 4);
    expect(s.aabb.min.x).toBeCloseTo(0.070, 4);
    expect(s.aabb.min.z).toBeCloseTo(-1.431, 4);
    expect(s.aabb.overlaps(cartonBox(0.1, -1.13))).toBe(true);
    expect(s.aabb.overlaps(cartonBox(0.8, -1.13))).toBe(false);
  });

  it('follows a placement rotated by 90° (snap-attached curve)', () => {
    const { placement, sensorNode, mesh } = curve();
    bake(sensorNode, mesh, true);
    const s = new RVSensor(sensorNode, AABB.fromNode(sensorNode));
    placement.rotation.y = Math.PI / 2;
    placement.updateMatrixWorld(true);
    s.updateAABB();
    // Rotating +90° about Y maps (x, z) → (z, −x): the beam now runs along world x.
    expect(s.aabb.max.x - s.aabb.min.x).toBeCloseTo(0.606, 3);
    expect(s.aabb.max.z - s.aabb.min.z).toBeCloseTo(0.057, 3);
    expect(s.aabb.overlaps(cartonBox(-1.13, -0.1))).toBe(true);
  });
});

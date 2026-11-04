// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-675 §9.8 (D2) — a COLLISION sensor without a BoxCollider (SolidCraft /
 * CAD sensor body) draws the volume it detects with: the live mesh box, or the
 * pre-bake box when the bake merged the meshes away. Node-local (the scene
 * graph carries the 0.001 scale), yellow free / red occupied.
 */
import { describe, it, expect } from 'vitest';
import { Box3, BoxGeometry, Matrix4, Mesh, Object3D, Vector3 } from 'three';
import { RVSensor, computeSensorLocalBox } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RV_SENSOR_BOX_KEY } from '../src/core/engine/rv-pre-bake-keys';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

function ctx(): ComponentContext {
  return {
    signalStore: { register: () => {}, set: () => {}, setByPath: () => {} },
    transportManager: { sensors: [] },
  } as unknown as ComponentContext;
}

/** SolidCraft-like sensor: Z-up body under 0.001, its mesh far from the node origin. */
function body(): { node: Object3D; mesh: Mesh } {
  const placement = new Object3D();
  const b = new Object3D();
  b.matrixAutoUpdate = false;
  b.matrix.copy(new Matrix4().makeRotationX(-Math.PI / 2).multiply(new Matrix4().makeScale(0.001, 0.001, 0.001)));
  placement.add(b);
  const node = new Object3D(); node.name = 'Sensor';
  const geo = new BoxGeometry(57, 606, 8); geo.translate(98.5, 1128, 766);
  const mesh = new Mesh(geo); mesh.name = 'mesh_0';
  node.add(mesh); b.add(node);
  placement.updateMatrixWorld(true);
  return { node, mesh };
}

const vizOf = (node: Object3D): Mesh | undefined => node.children.find((c) => c.name.endsWith('_sensorViz')) as Mesh | undefined;

function worldBox(m: Object3D): Box3 { m.updateWorldMatrix(true, true); return new Box3().setFromObject(m); }

describe('plan-675 §9.8 collision sensor without BoxCollider', () => {
  it('live mesh: visMesh exists and its world box equals the mesh world box', () => {
    const { node, mesh } = body();
    const s = new RVSensor(node, AABB.fromNode(node));
    s.UseRaycast = false;
    s.init(ctx());
    const viz = vizOf(node);
    expect(viz).toBeDefined();
    expect(viz!.parent).toBe(node);
    const a = worldBox(viz!); const b = worldBox(mesh);
    for (const k of ['x', 'y', 'z'] as const) {
      expect(a.min[k]).toBeCloseTo(b.min[k], 5);
      expect(a.max[k]).toBeCloseTo(b.max[k], 5);
    }
  });

  it('after the bake (pre-bake box stamp, meshes gone): the volume still shows where the detection is', () => {
    const { node, mesh } = body();
    const expected = worldBox(mesh);
    node.userData[RV_SENSOR_BOX_KEY] = computeSensorLocalBox(node);
    mesh.removeFromParent();
    const s = new RVSensor(node, AABB.fromNode(node));
    s.UseRaycast = false;
    s.init(ctx());
    const viz = vizOf(node)!;
    const a = worldBox(viz);
    expect(a.min.y).toBeCloseTo(expected.min.y, 5);
    expect(a.max.x).toBeCloseTo(expected.max.x, 5);
    s.updateAABB();
    expect(s.aabb.min.y).toBeCloseTo(a.min.y, 5);
  });

  it('the colour follows occupancy (yellow free, red occupied)', () => {
    const { node } = body();
    const s = new RVSensor(node, AABB.fromNode(node));
    s.UseRaycast = false;
    s.init(ctx());
    const viz = vizOf(node)!;
    const free = viz.material;
    s.updateAABB();
    const c = s.aabb.center.clone();
    const muNode = new Object3D(); muNode.position.copy(c); muNode.updateMatrixWorld(true);
    const mu = new RVMovingUnit(muNode, 'probe', new Vector3(0.05, 0.05, 0.05));
    mu.updateAABB?.();
    s.checkOverlap([mu]);
    expect(s.occupied).toBe(true);
    expect(viz.material).not.toBe(free);
  });
});

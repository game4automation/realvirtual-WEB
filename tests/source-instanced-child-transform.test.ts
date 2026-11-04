// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 S6 — an instanced MU whose single mesh sits BELOW the template root
 * with its own rotation/offset (a barrel MU, FassMU/FassMU_1) must draw exactly
 * where a clone of the template would, and the pool's culling sphere must
 * contain every instance, also right after a spawn and after a move.
 */
import { describe, it, expect } from 'vitest';
import {
  Box3, BoxGeometry, Frustum, Matrix4, Mesh, MeshBasicMaterial, Object3D,
  OrthographicCamera, Vector3,
} from 'three';
import { RVSource } from '../src/core/engine/rv-source';
import { InstancedMovingUnit, analyzeTemplate, type MUInstancePool } from '../src/core/engine/rv-mu';

/** A barrel 0.58 x 0.99 x 0.58 (upright, Y up) whose mesh child is authored lying
 *  along Z and stood up by a -90 deg X rotation plus an offset, like the GLB. */
function barrelTemplate(): Object3D {
  const template = new Object3D();
  template.name = 'FassMU';
  const child = new Mesh(new BoxGeometry(0.58, 0.58, 0.99).translate(0, 0, 0.495), new MeshBasicMaterial());
  child.name = 'FassMU_1';
  child.rotation.x = -Math.PI / 2;
  child.position.set(0.1, 0, 0.05);
  template.add(child);
  return template;
}

function build(): { source: RVSource; world: Object3D; template: Object3D } {
  const world = new Object3D();
  const template = barrelTemplate();
  template.position.set(5, 0, 0);
  world.add(template);
  const sourceNode = new Object3D();
  sourceNode.name = 'SourcePlace1';
  sourceNode.position.set(2, 1, -3);
  sourceNode.rotation.y = 0.4;
  world.add(sourceNode);
  world.updateMatrixWorld(true);
  const source = new RVSource(sourceNode);
  source.muName = template.name;
  source.sourceIsTemplate = false;
  source.spawnParent = world;
  source.spawnMode = 'Interval';
  source.spawnInterval = 0.01;
  source.setTemplate(template);
  return { source, world, template };
}

/** World bounds of instance `slot` of the pool's InstancedMesh. */
function instanceWorldBox(mu: InstancedMovingUnit, pool: MUInstancePool): Box3 {
  const mesh = pool.instancedMesh;
  mesh.updateMatrixWorld(true);
  const m = new Matrix4();
  mesh.getMatrixAt(mu.slotIndex, m);
  m.premultiply(mesh.matrixWorld);
  const geo = mesh.geometry;
  geo.computeBoundingBox();
  return geo.boundingBox!.clone().applyMatrix4(m);
}

describe('plan-2016 S6 — instanced MU with a transformed child mesh', () => {
  it('bakes the child transform into a private pool geometry', () => {
    const t = barrelTemplate();
    const a = analyzeTemplate(t)!;
    expect(a).not.toBeNull();
    expect(a.ownsGeometry).toBe(true);
    a.geometry.computeBoundingBox();
    const size = a.geometry.boundingBox!.getSize(new Vector3());
    expect(size.x).toBeCloseTo(0.58, 5);
    expect(size.y).toBeCloseTo(0.99, 5); // upright, like the template
    expect(size.z).toBeCloseTo(0.58, 5);
    // The template's own geometry is untouched (shared with ghost / clones).
    const own = (t.children[0] as Mesh).geometry;
    own.computeBoundingBox();
    expect(own.boundingBox!.getSize(new Vector3()).z).toBeCloseTo(0.99, 5);
  });

  it('keeps the shared geometry when the mesh frame equals the root frame', () => {
    const t = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    const a = analyzeTemplate(t)!;
    expect(a.ownsGeometry).toBe(false);
    expect(a.geometry).toBe(t.geometry);
  });

  it('an instance has the same world bounds as a clone of the template', () => {
    const { source, world } = build();
    const inst = source.update(1, true) as InstancedMovingUnit;
    expect(inst).toBeInstanceOf(InstancedMovingUnit);
    const instBox = instanceWorldBox(inst, source.pool!);

    // Reference: the template cloned and placed at the source world pose
    // (what the clone path does).
    const ref = barrelTemplate();
    world.add(ref);
    source.node.getWorldPosition(ref.position);
    source.node.getWorldQuaternion(ref.quaternion);
    world.updateMatrixWorld(true);
    const refBox = new Box3().setFromObject(ref);

    for (const k of ['x', 'y', 'z'] as const) {
      expect(instBox.min[k]).toBeCloseTo(refBox.min[k], 5);
      expect(instBox.max[k]).toBeCloseTo(refBox.max[k], 5);
    }
  });

  it('the culling sphere contains every instance right after spawn and after a move', () => {
    const { source } = build();
    const a = source.update(1, true) as InstancedMovingUnit;
    const pool = source.pool!;
    // Valid immediately, before any transport tick refreshed the matrices.
    const s0 = pool.instancedMesh.boundingSphere!;
    expect(s0).toBeTruthy();
    expect(s0.containsPoint(instanceWorldBox(a, pool).getCenter(new Vector3()))).toBe(true);

    // Move far away from the origin and refresh as the transport tick does.
    a.setPosition(new Vector3(40, 2, 30));
    pool.updateInstanceMatrix();
    const s1 = pool.instancedMesh.boundingSphere!;
    // Every geometry corner, placed by the instance matrix, lies in the sphere.
    const m = new Matrix4();
    pool.instancedMesh.getMatrixAt(a.slotIndex, m);
    const lb = pool.instancedMesh.geometry.boundingBox!;
    for (let i = 0; i < 8; i++) {
      const c = new Vector3(i & 1 ? lb.max.x : lb.min.x, i & 2 ? lb.max.y : lb.min.y, i & 4 ? lb.max.z : lb.min.z);
      expect(s1.containsPoint(c.applyMatrix4(m))).toBe(true);
    }

    // A camera looking only at the moved instance (origin out of view) keeps it.
    const cam = new OrthographicCamera(-2, 2, 2, -2, 0.1, 50);
    cam.position.set(40, 20, 30);
    cam.lookAt(40, 2, 30);
    cam.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    expect(frustum.containsPoint(new Vector3(0, 0, 0))).toBe(false);
    expect(frustum.intersectsObject(pool.instancedMesh)).toBe(true);
  });
});

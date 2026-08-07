// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.3 — the per-tick union world box (F5), visibility (F6) and the
 * exclusion of deformed geometry (F17).
 *
 * The articulation case is the second regression test of the plan: a cached
 * half-size (`AABB.fromNode`) freezes the build pose, so a robot arm extending
 * would keep the box of its folded pose and the broadphase would drop real
 * collisions forever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, SkinnedMesh, MathUtils } from 'three';
import { RVCollisionManager } from '../src/core/engine/rv-collision-manager';
import { boxMesh, withBVH } from './collision-fixture';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';

const MAT = new MeshBasicMaterial();

/** Body root with an "upper arm" that can slide away from the root. */
function articulatedBody(): { manager: RVCollisionManager; root: Object3D; arm: Object3D; scene: Scene } {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Robot';
  root.add(boxMesh({ name: 'Base' }));
  const arm = new Object3D();
  arm.name = 'Arm';
  arm.add(boxMesh({ name: 'ArmMesh' }));
  root.add(arm);
  scene.add(root);
  scene.updateMatrixWorld(true);
  const manager = new RVCollisionManager();
  manager.register(root, 'Robot');
  manager.rebuild();
  return { manager, root, arm, scene };
}

function bodyOf(manager: RVCollisionManager, root: Object3D) {
  const b = manager.bodies.find((x) => x.root === root);
  if (!b) throw new Error('body not built');
  return b;
}

beforeEach(() => __resetCollisionAlertStore());
afterEach(() => vi.restoreAllMocks());

describe('body bounds', () => {
  it('grows when a child mesh moves relative to the body root (articulation, F5)', () => {
    const { manager, root, arm, scene } = articulatedBody();
    const body = bodyOf(manager, root);
    manager.updateBodyBounds(body);
    const folded = body.worldBox.max.x;

    arm.position.x += 5;
    scene.updateMatrixWorld(true);
    manager.updateBodyBounds(body);
    expect(body.worldBox.max.x).toBeGreaterThan(folded + 4);
  });

  it('tracks world scale applied on a parent', () => {
    const { manager, root, scene } = articulatedBody();
    const body = bodyOf(manager, root);
    manager.updateBodyBounds(body);
    const before = body.worldBox.max.x - body.worldBox.min.x;

    root.scale.setScalar(2);
    scene.updateMatrixWorld(true);
    manager.updateBodyBounds(body);
    const after = body.worldBox.max.x - body.worldBox.min.x;
    expect(after).toBeCloseTo(before * 2, 5);
  });

  it('tracks rotation of the body root (wider axis-aligned box at 45 deg)', () => {
    const { manager, root, scene } = articulatedBody();
    const body = bodyOf(manager, root);
    manager.updateBodyBounds(body);
    const before = body.worldBox.max.x - body.worldBox.min.x;

    root.rotation.y = MathUtils.degToRad(45);
    scene.updateMatrixWorld(true);
    manager.updateBodyBounds(body);
    const after = body.worldBox.max.x - body.worldBox.min.x;
    expect(after).toBeGreaterThan(before * 1.3);   // 1 -> sqrt(2)
  });

  it('excludes meshes hidden by an ancestor (F6)', () => {
    const { manager, root, arm, scene } = articulatedBody();
    const body = bodyOf(manager, root);
    arm.position.x = 5;
    scene.updateMatrixWorld(true);
    manager.updateBodyBounds(body);
    expect(body.worldBox.max.x).toBeGreaterThan(4);

    arm.visible = false;
    manager.updateBodyBounds(body);
    expect(body.worldBox.max.x).toBeLessThan(1);
  });

  it('excludes meshes with layers.mask === 0 (batch sources, F6)', () => {
    const { manager, root, arm, scene } = articulatedBody();
    const body = bodyOf(manager, root);
    arm.position.x = 5;
    scene.updateMatrixWorld(true);
    const armMesh = arm.children[0] as Mesh;
    armMesh.layers.mask = 0;
    manager.updateBodyBounds(body);
    expect(body.worldBox.max.x).toBeLessThan(1);
  });

  it('produces an empty box when every mesh is hidden (no phantom overlap)', () => {
    const { manager, root } = articulatedBody();
    const body = bodyOf(manager, root);
    root.visible = false;
    // The root itself is an ancestor of its meshes.
    manager.updateBodyBounds(body);
    expect(body.worldBox.isEmpty()).toBe(true);
  });

  it('excludes SkinnedMesh / morph-target geometry and warns once (F17)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Chain';
    root.add(boxMesh({ name: 'Solid' }));

    const skinned = new SkinnedMesh(withBVH(new BoxGeometry(1, 1, 1)), MAT);
    skinned.name = 'Skinned';
    skinned.position.x = 20;
    root.add(skinned);

    const morph = new Mesh(withBVH(new BoxGeometry(1, 1, 1)), MAT);
    morph.name = 'Morph';
    morph.morphTargetInfluences = [0];
    morph.position.x = 40;
    root.add(morph);

    scene.add(root);
    scene.updateMatrixWorld(true);

    const manager = new RVCollisionManager();
    manager.register(root, 'Machine');
    manager.rebuild();
    const body = bodyOf(manager, root);

    expect(body.meshes.map((m) => m.mesh.name)).toEqual(['Solid']);
    manager.updateBodyBounds(body);
    expect(body.worldBox.max.x).toBeLessThan(1);

    const deformWarnings = warn.mock.calls.filter(
      (c) => String(c[0]).includes('deformed mesh'));
    expect(deformWarnings).toHaveLength(1);

    // A second rebuild in the same model load must NOT warn again.
    manager.invalidate();
    manager.rebuild();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('deformed mesh'))).toHaveLength(1);
  });

  it('does not let an excluded deformed mesh pull the whole body to aabbOnly (F17)', () => {
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Machine';
    root.add(boxMesh({ name: 'Solid' }));            // has a BVH
    // A skinned mesh has no boundsTree — if it were part of the body it would
    // set aabbOnly and silently downgrade the whole body to a box test.
    const skinned = new SkinnedMesh(new BoxGeometry(1, 1, 1), MAT);
    skinned.name = 'Skinned';
    root.add(skinned);
    scene.add(root);
    scene.updateMatrixWorld(true);

    const manager = new RVCollisionManager();
    manager.register(root, 'Machine');
    manager.rebuild();
    expect(bodyOf(manager, root).aabbOnly).toBe(false);
  });

  it('marks a body aabbOnly when a REAL mesh has no boundsTree, warning once (F14)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Machine';
    root.add(boxMesh({ name: 'NoBVH', bvh: false }));
    scene.add(root);
    scene.updateMatrixWorld(true);

    const manager = new RVCollisionManager();
    manager.register(root, 'Machine');
    manager.rebuild();
    expect(bodyOf(manager, root).aabbOnly).toBe(true);

    manager.invalidate();
    manager.rebuild();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('boundsTree'))).toHaveLength(1);
  });
});

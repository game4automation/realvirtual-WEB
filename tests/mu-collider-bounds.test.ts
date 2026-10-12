// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-collider-bounds.test.ts — plan-516 §9.1, the collider contract (F7).
 *
 * The box an MU is judged by (load resolution, grip candidates) comes from its
 * OWN solid colliders — no Rigidbody needed, a rotated collider yields the
 * world AABB of its oriented box, a child MU's collider is not counted, and
 * the mesh bounds only stand in when there is no collider at all.
 */

import { describe, it, expect } from 'vitest';
import { Box3, BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import {
  computeMUColliderWorldBox, computeMUColliderFrameBox,
} from '../src/core/engine/rv-mu-collider-bounds';

/** A BoxCollider in the Unity-side extras form (`colliders[]`). */
function boxCollider(center: [number, number, number], size: [number, number, number]) {
  return {
    type: 'BoxCollider', enabled: true, isTrigger: false,
    center: { x: center[0], y: center[1], z: center[2] },
    size: { x: size[0], y: size[1], z: size[2] },
  };
}

function muNode(name: string, colliders?: unknown[]): Object3D {
  const n = new Object3D();
  n.name = name;
  n.userData.realvirtual = { MU: {}, ...(colliders ? { colliders } : {}) };
  return n;
}

function expectBox(box: Box3, min: [number, number, number], max: [number, number, number]): void {
  expect(box.min.x).toBeCloseTo(min[0], 5);
  expect(box.min.y).toBeCloseTo(min[1], 5);
  expect(box.min.z).toBeCloseTo(min[2], 5);
  expect(box.max.x).toBeCloseTo(max[0], 5);
  expect(box.max.y).toBeCloseTo(max[1], 5);
  expect(box.max.z).toBeCloseTo(max[2], 5);
}

describe('computeMUColliderWorldBox (plan-516 F7)', () => {
  it('a BoxCollider without Rigidbody gives the box (Unity X negated)', () => {
    const mu = muNode('Pallet', [boxCollider([0.1, 0.05, 0], [1.2, 0.1, 0.8])]);
    mu.position.set(2, 0, 0);
    const box = computeMUColliderWorldBox(mu, new Box3());
    // center x: Unity +0.1 → glTF -0.1, plus node x 2
    expectBox(box, [2 - 0.1 - 0.6, 0, -0.4], [2 - 0.1 + 0.6, 0.1, 0.4]);
  });

  it('a rotated collider yields the world AABB of the oriented box', () => {
    const mu = muNode('Rot');
    const holder = new Object3D();
    holder.userData.realvirtual = { colliders: [boxCollider([0, 0, 0], [2, 0.2, 1])] };
    holder.rotation.y = Math.PI / 4;
    mu.add(holder);
    const box = computeMUColliderWorldBox(mu, new Box3());
    // 2×1 footprint rotated 45°: half-extent along x/z = (1 + 0.5)·√½
    const h = 1.5 * Math.SQRT1_2;
    expectBox(box, [-h, -0.1, -h], [h, 0.1, h]);
  });

  it('a child MU with its own collider is not counted', () => {
    const pallet = muNode('Pallet', [boxCollider([0, 0.05, 0], [1, 0.1, 1])]);
    const product = muNode('Product', [boxCollider([0, 0.25, 0], [0.2, 0.3, 0.2])]);
    pallet.add(product);
    const box = computeMUColliderWorldBox(pallet, new Box3());
    expectBox(box, [-0.5, 0, -0.5], [0.5, 0.1, 0.5]);
    const pbox = computeMUColliderWorldBox(product, new Box3());
    expectBox(pbox, [-0.1, 0.1, -0.1], [0.1, 0.4, 0.1]);
  });

  it('trigger and disabled colliders do not count', () => {
    const mu = muNode('T', [
      { ...boxCollider([0, 0, 0], [5, 5, 5]), isTrigger: true },
      { ...boxCollider([0, 0, 0], [4, 4, 4]), enabled: false },
      boxCollider([0, 0, 0], [1, 1, 1]),
    ]);
    const box = computeMUColliderWorldBox(mu, new Box3());
    expectBox(box, [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
  });

  it('without colliders the mesh AABB stands in', () => {
    const mu = muNode('Plain');
    const mesh = new Mesh(new BoxGeometry(0.4, 0.2, 0.6), new MeshBasicMaterial());
    mesh.position.set(0, 0.1, 0);
    mu.add(mesh);
    mu.position.set(0, 1, 0);
    const box = computeMUColliderWorldBox(mu, new Box3());
    expectBox(box, [-0.2, 1, -0.3], [0.2, 1.2, 0.3]);
  });

  it('frame box is in the MU rotation frame with world units (scale baked in)', () => {
    const mu = muNode('Scaled', [boxCollider([0, 0, 0], [1, 1, 1])]);
    mu.scale.setScalar(2);
    mu.rotation.y = Math.PI / 2;
    mu.position.set(3, 0, 0);
    const box = computeMUColliderFrameBox(mu, new Box3());
    const size = box.getSize(new Vector3());
    expect(size.x).toBeCloseTo(2, 5);
    expect(size.y).toBeCloseTo(2, 5);
    expect(size.z).toBeCloseTo(2, 5);
    const c = box.getCenter(new Vector3());
    expect(c.length()).toBeCloseTo(0, 5);
  });
});

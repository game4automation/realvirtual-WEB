// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { PhysicsShape } from './rv-physics-registry';

export interface MUColliderTemplate {
  isKinematic: boolean;
  shapes: Extract<PhysicsShape, { kind: 'cuboid' }>[];
}

/** Copies authored Unity child BoxColliders before Source strips component extras.
 * Compound boxes must be axis-aligned in the MU frame; never substitutes a hull. */
export function readMUColliderTemplate(root: Object3D): MUColliderTemplate | undefined {
  const rigidbody = root.userData.realvirtual?.Rigidbody;
  if (!rigidbody) return undefined;
  root.updateWorldMatrix(true, true);
  const inverse = new Matrix4().compose(
    root.getWorldPosition(new Vector3()), root.getWorldQuaternion(new Quaternion()), new Vector3(1, 1, 1),
  ).invert();
  const shapes: MUColliderTemplate['shapes'] = [];
  root.traverse(node => {
    const box = node.userData.realvirtual?.BoxCollider;
    if (!box || box.isTrigger === true || box.enabled === false) return;
    const matrix = new Matrix4().multiplyMatrices(inverse, node.matrixWorld);
    const e = matrix.elements;
    for (const base of [0, 4, 8]) {
      if ([e[base], e[base + 1], e[base + 2]].filter(v => Math.abs(v) > 1e-6).length !== 1) {
        throw new Error(`MU collider ${node.name} must align with its Rigidbody axes.`);
      }
    }
    const center = new Vector3(box.center.x, box.center.y, box.center.z).applyMatrix4(matrix);
    const h = new Vector3(box.size.x / 2, box.size.y / 2, box.size.z / 2);
    const half = {
      x: Math.abs(e[0]) * h.x + Math.abs(e[4]) * h.y + Math.abs(e[8]) * h.z,
      y: Math.abs(e[1]) * h.x + Math.abs(e[5]) * h.y + Math.abs(e[9]) * h.z,
      z: Math.abs(e[2]) * h.x + Math.abs(e[6]) * h.y + Math.abs(e[10]) * h.z,
    };
    if (![half.x, half.y, half.z, center.x, center.y, center.z].every(Number.isFinite)
      || Math.min(half.x, half.y, half.z) <= 0) throw new Error(`Invalid MU collider ${node.name}`);
    shapes.push({ kind: 'cuboid', halfExtents: half, localOffset: { x: center.x, y: center.y, z: center.z } });
  });
  return shapes.length ? { isKinematic: rigidbody.isKinematic === true, shapes } : undefined;
}

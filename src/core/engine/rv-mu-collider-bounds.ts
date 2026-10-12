// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mu-collider-bounds.ts — the collider footprint of ONE MU (plan-516 F7).
 *
 * Pre-placed MUs (plan-516) decide which MU carries which by their COLLIDERS,
 * not by the hierarchy and not by the render mesh: a product rests on a pallet
 * when its collider bottom sits on the pallet's collider top. This module is
 * the one place that turns an MU node into that box.
 *
 * Contract:
 * - Every SOLID collider (enabled, not a trigger) the MU carries on its own
 *   node or on a descendant counts — Box colliders as authored boxes (a rotated
 *   collider contributes the axis-aligned enclosure of its oriented box), Mesh
 *   colliders by the bounds of the node's render primitives.
 * - The traversal STOPS at a child MU root: a product hanging under a pallet
 *   in the authored hierarchy is its own MU with its own box.
 * - A Rigidbody is NOT required (unlike `readMUColliderTemplate`, which serves
 *   the physics provider and stays untouched).
 * - Only when the MU has no usable collider at all does the mesh AABB of the
 *   same (child-MU-pruned) subtree stand in.
 *
 * Not a hot path: called once per MU at classification, and on demand by
 * load resolution / grip placement. Scratch objects are module-level anyway.
 */

import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import type { Mesh, Object3D } from 'three';
import { getColliderExtras, isSolidCollider, renderPrimitivesOf } from './rv-collider-extras';
import { unityPositionToGltf } from './rv-coordinate-utils';

const _frameInv = new Matrix4();
const _rel = new Matrix4();
const _corner = new Vector3();
const _pos = new Vector3();
const _quat = new Quaternion();
const _one = new Vector3(1, 1, 1);
const _meshBox = new Box3();

/** True when `node` carries an `MU` component in its rv_extras. */
export function isMUNode(node: Object3D): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  return !!rv && typeof rv === 'object' && !!rv['MU'];
}

/** Expand `out` by the 8 corners of the box `center ± half`, transformed by `m`. */
function expandByTransformedBox(out: Box3, m: Matrix4, center: Vector3, half: Vector3): void {
  for (let i = 0; i < 8; i++) {
    _corner.set(
      center.x + ((i & 1) ? half.x : -half.x),
      center.y + ((i & 2) ? half.y : -half.y),
      center.z + ((i & 4) ? half.z : -half.z),
    ).applyMatrix4(m);
    out.expandByPoint(_corner);
  }
}

const _c = new Vector3();
const _h = new Vector3();

/** Walk `root` and its descendants, stopping at child MU roots. */
function walkOwn(root: Object3D, fn: (node: Object3D) => void): void {
  fn(root);
  for (const child of root.children) {
    if (isMUNode(child)) continue;
    walkOwn(child, fn);
  }
}

/**
 * Collect the MU's collider box, expressed in the frame whose inverse is
 * `frameInv` (identity → world). Returns whether a collider was found.
 */
function collectColliders(muNode: Object3D, frameInv: Matrix4, out: Box3): boolean {
  let found = false;
  walkOwn(muNode, (node) => {
    for (const col of getColliderExtras(node)) {
      if (!isSolidCollider(col)) continue;
      _rel.multiplyMatrices(frameInv, node.matrixWorld);
      if (col.kind === 'box') {
        _c.copy(unityPositionToGltf(col.center.x, col.center.y, col.center.z));
        _h.set(Math.abs(col.size.x) / 2, Math.abs(col.size.y) / 2, Math.abs(col.size.z) / 2);
        expandByTransformedBox(out, _rel, _c, _h);
        found = true;
      } else {
        // MeshCollider: the collider IS the node's render geometry.
        for (const mesh of renderPrimitivesOf(node)) {
          if (expandByMesh(out, mesh, frameInv)) found = true;
        }
      }
    }
  });
  return found;
}

function expandByMesh(out: Box3, mesh: Mesh, frameInv: Matrix4): boolean {
  const geom = mesh.geometry;
  if (!geom) return false;
  if (!geom.boundingBox) geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb || bb.isEmpty()) return false;
  _rel.multiplyMatrices(frameInv, mesh.matrixWorld);
  bb.getCenter(_c);
  bb.getSize(_h).multiplyScalar(0.5);
  expandByTransformedBox(out, _rel, _c, _h);
  return true;
}

/** Mesh AABB of the child-MU-pruned subtree (fallback when no collider exists). */
function collectMeshes(muNode: Object3D, frameInv: Matrix4, out: Box3): void {
  walkOwn(muNode, (node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    _meshBox.makeEmpty();
    if (expandByMesh(_meshBox, mesh, frameInv)) out.union(_meshBox);
  });
}

function computeBox(muNode: Object3D, frameInv: Matrix4, out: Box3): Box3 {
  out.makeEmpty();
  muNode.updateWorldMatrix(true, true);
  if (!collectColliders(muNode, frameInv, out)) collectMeshes(muNode, frameInv, out);
  return out;
}

/**
 * World-space AABB of the MU's own colliders (F7). A rotated collider yields
 * the axis-aligned enclosure of its oriented box. Empty when the MU has
 * neither collider nor mesh.
 */
export function computeMUColliderWorldBox(muNode: Object3D, out: Box3): Box3 {
  return computeBox(muNode, _frameInv.identity(), out);
}

/**
 * The same box in the MU's ROTATION frame: origin at the MU's world position,
 * axes along its world rotation, world units (scale is baked in). This is the
 * shape `RVMovingUnit` expects (`halfSize` / `localCenter` are rotated by the
 * node's world quaternion and added to its world position), so the MU's
 * transport AABB follows the part when it turns — and equals the collider.
 */
export function computeMUColliderFrameBox(muNode: Object3D, out: Box3): Box3 {
  muNode.updateWorldMatrix(true, false);
  muNode.matrixWorld.decompose(_pos, _quat, _corner);
  _frameInv.compose(_pos, _quat, _one).invert();
  return computeBox(muNode, _frameInv, out);
}

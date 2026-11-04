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
import { colliderExtrasOfNode, getColliderExtras, isSolidCollider, renderPrimitivesOf, RV_IS_MU_KEY } from './rv-collider-extras';
import { unityPositionToGltf } from './rv-coordinate-utils';
import { isInactiveWithin } from './rv-authored-inactive';
import { layerOfNode } from './rv-layers';

const _frameInv = new Matrix4();
const _rel = new Matrix4();
const _corner = new Vector3();
const _pos = new Vector3();
const _quat = new Quaternion();
const _one = new Vector3(1, 1, 1);
const _meshBox = new Box3();
const _part = new Box3();

/** True when `node` carries an `MU` component in its rv_extras. */
export function isMUNode(node: Object3D): boolean {
  if (node.userData?.[RV_IS_MU_KEY]) return true;   // a stripped clone (plan-2016 S5)
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
const _obbPos = new Vector3();
const _obbQuat = new Quaternion();
const _obbScale = new Vector3();

/**
 * The exact oriented box of one detection part (plan-2016 Codex review): the
 * part's frame box (`parts[i]`) is the axis-aligned ENCLOSURE in the MU frame —
 * right for the broadphase and the overlap test, too large for a rotated child
 * collider. The ray tests this box instead: centre = the frame box centre (the
 * enclosure of a box is symmetric about its centre), `rot` = the collider's
 * rotation relative to the MU frame, `half` = its half extents along its own axes
 * (world units). `colliderIndex` = index of the collider in its node's collider
 * list — with the node it is the collider's identity (several colliders per node).
 */
export interface DetectPartObb { rot: Quaternion; half: Vector3; colliderIndex: number }

/** Decompose `m` (collider frame → MU frame) into the OBB rotation + world half extents of `center ± half`. */
function writeObb(m: Matrix4, half: Vector3, colliderIndex: number): DetectPartObb {
  m.decompose(_obbPos, _obbQuat, _obbScale);
  return {
    rot: _obbQuat.clone().normalize(),
    half: new Vector3(half.x * Math.abs(_obbScale.x), half.y * Math.abs(_obbScale.y), half.z * Math.abs(_obbScale.z)),
    colliderIndex,
  };
}

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

/**
 * The SENSOR detection box of an MU (plan-2016 S5, Unity parity): the union of
 * ALL ACTIVE colliders in the MU's own subtree, in its rotation frame (same
 * frame as {@link computeMUColliderFrameBox}).
 *
 * Unity's sensors see every collider of the MU: the blow-moulding line project sets
 * `queriesHitTriggers`, and the overlap test uses `QueryTriggerInteraction.Collide`
 * — so TRIGGER colliders count as well. Counted are:
 * - BoxColliders (trigger or not) as their oriented boxes, through the node's
 *   world matrix;
 * - MeshColliders as the bounds of the node's render primitives;
 * - only enabled colliders on ACTIVE nodes — a node authored or switched
 *   inactive below the root (`_rvInactive`, a MUSwitcher variant) is skipped,
 *   like an inactive GameObject. The root's own flag does not count.
 *
 * Reads the parsed clone stash (`colliderExtrasOfNode`), so a spawned clone
 * whose rv-extras were stripped is measured too. Child MU roots and the nodes
 * in `exclude` (passive loads) are pruned. `parts` (optional) receives each
 * collider's own frame box: the union `out` fills the gaps between separate
 * colliders, so sensors use it only as the broadphase and test the parts after
 * (plan-2016 S5 Codex fix); `partLayers` (optional) the Unity layer of the node
 * carrying each part (plan-2016 S6c, -1 = unknown), `partNodes` (optional) that node
 * itself — the collider's identity for the raycast's per-collider enter; `partObbs`
 * (optional) each part's exact oriented box and collider index ({@link DetectPartObb}).
 * Returns false — the caller keeps the mesh box — when the MU has no active collider at all.
 */
export function computeMUDetectionFrameBox(
  muNode: Object3D, out: Box3, exclude?: ReadonlySet<Object3D>, parts?: Box3[], partLayers?: number[],
  partNodes?: Object3D[], partObbs?: DetectPartObb[],
): boolean {
  out.makeEmpty();
  if (parts) parts.length = 0;
  if (partLayers) partLayers.length = 0;
  if (partNodes) partNodes.length = 0;
  if (partObbs) partObbs.length = 0;
  muNode.updateWorldMatrix(true, true);
  muNode.matrixWorld.decompose(_pos, _quat, _corner);
  _frameInv.compose(_pos, _quat, _one).invert();
  let found = false;
  const visit = (node: Object3D): void => {
    if (exclude?.has(node)) return;
    if (isInactiveWithin(node, muNode)) return;   // the whole subtree is inactive
    const cols = colliderExtrasOfNode(node);
    for (let ci = 0; ci < cols.length; ci++) {
      const col = cols[ci];
      if (!col.enabled) continue;
      if (col.kind === 'box') {
        _rel.multiplyMatrices(_frameInv, node.matrixWorld);
        _c.copy(unityPositionToGltf(col.center.x, col.center.y, col.center.z));
        _h.set(Math.abs(col.size.x) / 2, Math.abs(col.size.y) / 2, Math.abs(col.size.z) / 2);
        _part.makeEmpty();
        expandByTransformedBox(_part, _rel, _c, _h);
        out.union(_part);
        parts?.push(_part.clone());
        partLayers?.push(layerOfNode(node));
        partNodes?.push(node);
        partObbs?.push(writeObb(_rel, _h, ci));
        found = true;
      } else {
        for (const mesh of renderPrimitivesOf(node)) {
          _part.makeEmpty();
          if (expandByMesh(_part, mesh, _frameInv)) {
            out.union(_part);
            parts?.push(_part.clone());
            partLayers?.push(layerOfNode(node));
            partNodes?.push(node);
            // expandByMesh left the mesh → MU-frame matrix in `_rel` and the half box in `_h`.
            partObbs?.push(writeObb(_rel, _h, ci));
            found = true;
          }
        }
      }
    }
    for (const child of node.children) {
      if (isMUNode(child)) continue;
      visit(child);
    }
  };
  visit(muNode);
  if (!found || out.isEmpty()) {
    out.makeEmpty();
    if (parts) parts.length = 0;
    if (partLayers) partLayers.length = 0;
    if (partNodes) partNodes.length = 0;
    if (partObbs) partObbs.length = 0;
    return false;
  }
  return true;
}

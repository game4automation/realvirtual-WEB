// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-transform.ts — Frozen-safe local-transform editing for scene nodes.
 *
 * The loader freezes static nodes (baked matrixWorld, auto-update off, local
 * TRS possibly stale). Anything that wants to MOVE such a node must first
 * rebuild its local transform from the baked matrices — including the local
 * scale, which for Unity-exported GLBs can carry a mirror component (e.g.
 * IKTarget nodes ship scale (-1,1,1)) that must survive the edit.
 *
 * Shared by the IK target edit plugin (gizmo drags), the scene-op executors
 * (`transformNode` forward/inverse) and the scene loader (persisted node
 * transforms applied after model load).
 */

import { Matrix4 } from 'three';
import type { Object3D } from 'three';

const _mat = new Matrix4();

/**
 * Make a (possibly loader-frozen) node's LOCAL transform trustworthy and
 * editable: rebuild position/quaternion/scale from the baked matrixWorld of
 * node and parent, then re-enable auto-update. Idempotent (marker flag).
 */
export function ensureMovableTransform(node: Object3D): void {
  const ud = node.userData as Record<string, unknown>;
  if (ud.__rvMovable) return;
  const parent = node.parent;
  if (parent) {
    _mat.copy(parent.matrixWorld).invert().multiply(node.matrixWorld);
    _mat.decompose(node.position, node.quaternion, node.scale);
  }
  node.matrixAutoUpdate = true;
  node.matrixWorldAutoUpdate = true;
  ud.__rvMovable = true;
}

/**
 * Force-recompute `matrixWorld` for a node and its WHOLE subtree, ignoring
 * the loader freeze.
 *
 * `updateMatrixWorld(true)` deliberately skips every node whose
 * `matrixWorldAutoUpdate` is false — that is the entire point of
 * `freezeStaticMatrices` — so a transform written onto a frozen parent leaves
 * all frozen descendants standing at their baked world pose. This walk is the
 * write-side counterpart: local matrices are still valid on frozen nodes (the
 * freeze never touches `matrixAutoUpdate`), so recomposing world = parentWorld
 * × local down the subtree is exact, and the freeze flags stay untouched —
 * the per-frame skip keeps its value.
 */
export function refreshWorldMatricesDeep(node: Object3D): void {
  if (node.matrixAutoUpdate) node.updateMatrix();
  const parent = node.parent;
  if (parent) node.matrixWorld.multiplyMatrices(parent.matrixWorld, node.matrix);
  else node.matrixWorld.copy(node.matrix);
  for (const child of node.children) refreshWorldMatricesDeep(child);
}

/**
 * Set a node's local position/quaternion (scale untouched — see module doc)
 * and refresh matrix + matrixWorld from the BAKED parent matrixWorld. No
 * ancestor recursion — frozen ancestors keep their baked values.
 */
export function applyLocalPose(
  node: Object3D,
  position: readonly number[],
  quaternion: readonly number[],
): void {
  ensureMovableTransform(node);
  node.position.set(position[0] ?? 0, position[1] ?? 0, position[2] ?? 0);
  node.quaternion.set(quaternion[0] ?? 0, quaternion[1] ?? 0, quaternion[2] ?? 0, quaternion[3] ?? 1);
  node.updateMatrix();
  const parent = node.parent;
  if (parent) node.matrixWorld.multiplyMatrices(parent.matrixWorld, node.matrix);
  else node.matrixWorld.copy(node.matrix);
}

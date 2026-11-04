// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-world-matrix.ts — a world matrix from the CURRENT parent chain, without the
 * render loop (plan-2016 sensor parity).
 *
 * The freeze pass (rv-freeze-static.ts) sets `matrixAutoUpdate = false` on the
 * static descendants of a mover — their LOCAL matrix never changes — and leaves
 * the world matrix to `scene.updateMatrixWorld()`, which the render loop calls
 * once per frame and which forces every child of a moved parent. Three's
 * `updateWorldMatrix(true, false)` does NOT: it recomputes a node only when its
 * own `matrixWorldNeedsUpdate` is set, and a node that never composes its local
 * matrix never sets it. A sensor on a moving gripper therefore kept the world
 * pose of the last rendered frame — and with no rendering at all (hidden tab,
 * headless run, several simulation ticks per frame) its ray stood still while the
 * gripper drove away (the blow-moulding line: the loading gripper never saw a tube).
 *
 * {@link refreshWorldMatrix} walks the chain from the root and multiplies every
 * matrix-world-auto-updated node, whatever its flags say — O(depth).
 */

import type { Object3D } from 'three';

/** Recompute `node.matrixWorld` (and its ancestors') from the current local matrices. */
export function refreshWorldMatrix(node: Object3D): void {
  const parent = node.parent;
  if (parent) refreshWorldMatrix(parent);
  if (node.matrixAutoUpdate) node.updateMatrix();
  if (!node.matrixWorldAutoUpdate) return; // frozen static: its world matrix is final
  if (parent) node.matrixWorld.multiplyMatrices(parent.matrixWorld, node.matrix);
  else node.matrixWorld.copy(node.matrix);
  node.matrixWorldNeedsUpdate = false;
}

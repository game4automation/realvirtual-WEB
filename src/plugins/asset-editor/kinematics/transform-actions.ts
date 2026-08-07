// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * transform-actions — the Kinematics window's transform tools, ported from
 * Unity QuickEdit's transform section. Every action emits undoable
 * `transformNode` ops through the AssetDocument (pivot tools as ONE composite
 * so a single undo reverts node + child compensation together).
 *
 * All math happens here at op-creation time; the executor only replays the
 * recorded TRS numbers (deterministic draft replay).
 */

import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewer } from '../../../core/rv-viewer';
import type { AssetDocument } from '../../../core/editor/rv-asset-document';
import type { NodeTransform } from '../../../core/editor/rv-asset-ops';
import { computeSubtreeAABB, computeSubtreeVertexCenter } from '../../../core/engine/rv-traverse-utils';
import { NodeRegistry } from '../../../core/engine/rv-node-registry';

/** Local TRS snapshot of a node. */
export function snapshotLocal(node: Object3D): NodeTransform {
  return {
    position: node.position.toArray() as [number, number, number],
    quaternion: node.quaternion.toArray() as [number, number, number, number],
    scale: node.scale.toArray() as [number, number, number],
  };
}

function decompose(m: Matrix4): NodeTransform {
  const p = new Vector3(); const q = new Quaternion(); const s = new Vector3();
  m.decompose(p, q, s);
  return {
    position: p.toArray() as [number, number, number],
    quaternion: q.toArray() as [number, number, number, number],
    scale: s.toArray() as [number, number, number],
  };
}

function composeMatrix(t: NodeTransform): Matrix4 {
  return new Matrix4().compose(
    new Vector3().fromArray(t.position),
    new Quaternion().fromArray(t.quaternion),
    new Vector3().fromArray(t.scale),
  );
}

function parentWorld(node: Object3D): Matrix4 {
  node.updateMatrixWorld(true);
  return node.parent
    ? node.parent.matrixWorld.clone()
    : new Matrix4();
}

/** Set every selected node's local position to (0,0,0). One undo unit. */
export async function zeroLocalPosition(viewer: RVViewer, doc: AssetDocument, paths: ReadonlyArray<string>): Promise<void> {
  const nodes = paths
    .map((p) => ({ path: p, node: viewer.registry?.getNode(p) ?? null }))
    .filter((e): e is { path: string; node: Object3D } => e.node !== null);
  if (nodes.length === 0) return;
  const apply = () => {
    for (const { path, node } of nodes) {
      const prev = snapshotLocal(node);
      doc.transformNode(path, { ...prev, position: [0, 0, 0] }, prev);
    }
  };
  if (nodes.length === 1) apply();
  else await doc.withTransaction(`Zero local position (${nodes.length})`, async () => apply());
}

/** Rotate a node ±90° around one of its LOCAL axes (Unity QuickEdit parity:
 *  `transform.rotation *= Quaternion.Euler(axis * sign * 90)`). */
export function rotate90(viewer: RVViewer, doc: AssetDocument, path: string, axis: 'x' | 'y' | 'z', sign: 1 | -1): void {
  const node = viewer.registry?.getNode(path);
  if (!node) return;
  const prev = snapshotLocal(node);
  const axisVec = new Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  const q = new Quaternion().setFromAxisAngle(axisVec, sign * Math.PI / 2);
  const quat = new Quaternion().fromArray(prev.quaternion).multiply(q);
  doc.transformNode(path, { ...prev, quaternion: quat.toArray() as [number, number, number, number] }, prev);
}

/** Shift the node on world Y so its subtree bounding box rests on Y = 0. */
export function toGround(viewer: RVViewer, doc: AssetDocument, path: string): void {
  const node = viewer.registry?.getNode(path);
  if (!node) return;
  node.updateMatrixWorld(true);
  const { box } = computeSubtreeAABB(node, new Box3());
  if (box.isEmpty()) return;
  const deltaY = -box.min.y;
  if (Math.abs(deltaY) < 1e-9) return;
  const prev = snapshotLocal(node);
  const worldPos = new Vector3().setFromMatrixPosition(node.matrixWorld).add(new Vector3(0, deltaY, 0));
  const localPos = worldPos.applyMatrix4(parentWorld(node).invert());
  doc.transformNode(path, { ...prev, position: localPos.toArray() as [number, number, number] }, prev);
}

/** True when the node itself carries mesh geometry (pivot ops would shift it). */
export function nodeHasOwnMesh(node: Object3D): boolean {
  return (node as { isMesh?: boolean }).isMesh === true;
}

/** GroupName of the node's Kinematic component (any `_N` key), or null. */
export function getKinematicGroupName(node: Object3D): string | null {
  const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
    Record<string, unknown> | undefined;
  if (!rv) return null;
  for (const key of Object.keys(rv)) {
    if (!/^Kinematic(_\d+)?$/.test(key)) continue;
    const gn = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
    if (typeof gn === 'string' && gn) return gn;
  }
  return null;
}

/** World-space count/bounds helper: the number of objects the kinematic's group
 *  currently collects (drives the Center button's enabled state). */
export function kinematicGroupMemberCount(viewer: RVViewer, node: Object3D): number {
  const groupName = getKinematicGroupName(node);
  if (!groupName) return 0;
  return viewer.groups?.get(groupName)?.nodes.length ?? 0;
}

/**
 * Move `sourcePath`'s pivot to the world-space center of another object
 * (the average of `targetPath`'s mesh-subtree vertices — the precise geometric
 * center, not the AABB center) WITHOUT moving either object's geometry — the
 * source's direct children are compensated so their world poses are preserved.
 * Backs the Transform section's "Pivot to Object" pick tool. One composite
 * undo unit.
 */
export async function pivotToObjectCenter(
  viewer: RVViewer, doc: AssetDocument, sourcePath: string, targetPath: string,
): Promise<void> {
  const node = viewer.registry?.getNode(sourcePath);
  const target = viewer.registry?.getNode(targetPath);
  if (!node || !target) return;
  target.updateMatrixWorld(true);
  const center = computeSubtreeVertexCenter(target)
    ?? computeSubtreeAABB(target, new Box3()).center;
  node.updateMatrixWorld(true);
  const current = new Vector3().setFromMatrixPosition(node.matrixWorld);
  if (current.distanceTo(center) < 1e-6) return; // already there
  await repivot(viewer, doc, sourcePath, node, (world) => {
    world.setPosition(center);
  }, 'Pivot to object');
}

/**
 * Move a Kinematic axis node's pivot to the world-space center of its group's
 * objects, WITHOUT moving those objects (only the axis origin moves). The
 * group members are separate objects in the editor — moving the empty axis
 * leaves them in place — but any direct children the axis already has are
 * compensated so their world poses are preserved. One composite undo unit.
 */
export async function centerKinematicToGroup(viewer: RVViewer, doc: AssetDocument, path: string): Promise<void> {
  const node = viewer.registry?.getNode(path);
  if (!node) return;
  const groupName = getKinematicGroupName(node);
  if (!groupName) return;
  const members = viewer.groups?.get(groupName)?.nodes ?? [];
  if (members.length === 0) return;

  // Combined world AABB of every group member's mesh subtree.
  const bounds = new Box3().makeEmpty();
  for (const member of members) {
    member.updateMatrixWorld(true);
    const { box } = computeSubtreeAABB(member, new Box3());
    bounds.union(box);
  }
  if (bounds.isEmpty()) return;
  const target = bounds.getCenter(new Vector3());

  node.updateMatrixWorld(true);
  const current = new Vector3().setFromMatrixPosition(node.matrixWorld);
  if (current.distanceTo(target) < 1e-6) return; // already centered

  await repivot(viewer, doc, path, node, (world) => {
    world.setPosition(target);
  }, 'Center kinematic to group');
}

/**
 * Move the node's pivot to the bottom-center of its children's combined
 * bounds WITHOUT moving the children (their world poses are preserved via
 * compensating transforms). One composite undo unit.
 */
export async function pivotToBottom(viewer: RVViewer, doc: AssetDocument, path: string): Promise<void> {
  const node = viewer.registry?.getNode(path);
  if (!node || node.children.length === 0) return;
  node.updateMatrixWorld(true);
  const { box, center } = computeSubtreeAABB(node, new Box3());
  if (box.isEmpty()) return;
  const targetWorldPos = new Vector3(center.x, box.min.y, center.z);
  await repivot(viewer, doc, path, node, (world) => {
    world.setPosition(targetWorldPos);
  }, 'Pivot to bottom');
}

/** Rotate the node so its local +Y aligns with world up, children preserved. */
export async function alignYUp(viewer: RVViewer, doc: AssetDocument, path: string): Promise<void> {
  const node = viewer.registry?.getNode(path);
  if (!node || node.children.length === 0) return;
  node.updateMatrixWorld(true);
  const worldPos = new Vector3(); const worldQuat = new Quaternion(); const worldScale = new Vector3();
  node.matrixWorld.decompose(worldPos, worldQuat, worldScale);
  const localYInWorld = new Vector3(0, 1, 0).applyQuaternion(worldQuat).normalize();
  const correction = new Quaternion().setFromUnitVectors(localYInWorld, new Vector3(0, 1, 0));
  if (Math.abs(1 - Math.abs(correction.w)) < 1e-9) return; // already aligned
  const newWorldQuat = correction.multiply(worldQuat);
  await repivot(viewer, doc, path, node, (world) => {
    world.compose(worldPos, newWorldQuat, worldScale);
  }, 'Align Y up');
}

/**
 * Core of the pivot tools: mutate the node's WORLD matrix via `mutateWorld`,
 * then compensate every direct child so its world pose is unchanged. Emits
 * one composite of transformNode ops (node first, then children).
 */
async function repivot(
  viewer: RVViewer,
  doc: AssetDocument,
  path: string,
  node: Object3D,
  mutateWorld: (world: Matrix4) => void,
  label: string,
): Promise<void> {
  node.updateMatrixWorld(true);
  const childSnapshots = node.children.map((child) => ({
    path: NodeRegistry.computeNodePath(child),
    prev: snapshotLocal(child),
    world: child.matrixWorld.clone(),
  }));

  const newWorld = node.matrixWorld.clone();
  mutateWorld(newWorld);
  const invParent = parentWorld(node).invert();
  const nodePrev = snapshotLocal(node);
  const nodeNext = decompose(invParent.clone().multiply(newWorld));
  // Recompose from the decomposed TRS so child math matches EXACTLY what the
  // executor will apply (guards against shear lost in decomposition).
  const appliedWorld = parentWorld(node).multiply(composeMatrix(nodeNext));
  const invNodeWorld = appliedWorld.invert();

  await doc.withTransaction(label, async () => {
    doc.transformNode(path, nodeNext, nodePrev);
    for (const child of childSnapshots) {
      const next = decompose(invNodeWorld.clone().multiply(child.world));
      doc.transformNode(child.path, next, child.prev);
    }
  });
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-722 §9.2 / plan-724 — the `pivotToCircle` commit.
 *
 * The contract in one sentence: the NODE lands on the circle's centre with its
 * local +Y on the circle's axis, and everything below it stays exactly where it
 * was — in ONE undo step.
 *
 * Three of these tests exist because the failure they guard is SILENT. A commit
 * that used the world values captured at HOVER time instead of re-deriving them
 * would place the pivot where the bore was 50 ms ago; a compensation that only
 * reached direct children would displace a grandchild; a sign rule that ignored
 * the node's current orientation would flip an axis 180° without telling anyone.
 * All three produce a model that looks plausible and solves to the wrong pose.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  BufferAttribute, BufferGeometry, Euler, Group, Mesh, Object3D, Quaternion, Scene, Vector3,
} from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { pivotToCircle } from '@rv-private/plugins/asset-editor/kinematics/transform-actions';

function makeViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  const register = () => {
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    model.updateMatrixWorld(true);
  };
  const viewer = {
    scene, registry,
    signalStore: null, transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {}, markShadowsDirty() {}, emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {},
  } as unknown as RVViewer;
  return { viewer, model, register };
}

/** A one-triangle mesh — geometry is irrelevant here; only its matrix is used. */
function stubMesh(name: string): Mesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  const mesh = new Mesh(geometry);
  mesh.name = name;
  return mesh;
}

/** Local +Y of a node, in world space. */
function localYWorld(node: Object3D): Vector3 {
  return new Vector3(0, 1, 0)
    .applyQuaternion(node.getWorldQuaternion(new Quaternion())).normalize();
}

describe('pivotToCircle', () => {
  it('moves the pivot to the circle center and aligns local +Y with the normal', async () => {
    const { viewer, model, register } = makeViewer();
    const axisNode = new Object3D();
    axisNode.name = 'Axis';
    const target = stubMesh('Bore');
    target.position.set(10, 0, 0);
    model.add(axisNode, target);
    register();
    const doc = scratchAssetDocument(viewer);

    // Circle at the mesh's local origin, axis +Z ⇒ world (10,0,0) / world +Z.
    await pivotToCircle(
      viewer, doc, 'Asset/Axis', target, new Vector3(0, 0, 0), new Vector3(0, 0, 1));
    await doc.whenIdle();
    model.updateMatrixWorld(true);

    expect(axisNode.getWorldPosition(new Vector3()).distanceTo(new Vector3(10, 0, 0)))
      .toBeLessThan(1e-6);
    expect(localYWorld(axisNode).distanceTo(new Vector3(0, 0, 1))).toBeLessThan(1e-6);
    doc.dispose();
  });

  it('chooses the normal sign closer to the node\'s current world +Y', async () => {
    const { viewer, model, register } = makeViewer();
    const axisNode = new Object3D();
    axisNode.name = 'Axis';
    // Local +Y already points along world −Z.
    axisNode.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(0, 0, -1));
    const target = stubMesh('Bore');
    model.add(axisNode, target);
    register();
    const doc = scratchAssetDocument(viewer);

    // The circle's canonical axis is +Z, but −Z is the nearer of the two.
    await pivotToCircle(
      viewer, doc, 'Asset/Axis', target, new Vector3(), new Vector3(0, 0, 1));
    await doc.whenIdle();
    model.updateMatrixWorld(true);

    // A 180° flip would have been a valid alignment and the wrong answer.
    expect(localYWorld(axisNode).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-6);
    doc.dispose();
  });

  it('preserves the roll about the new axis (shortest arc)', async () => {
    const { viewer, model, register } = makeViewer();
    const axisNode = new Object3D();
    axisNode.name = 'Axis';
    axisNode.quaternion.setFromEuler(new Euler(0, 0.9, 0));  // a yaw, i.e. pure roll about +Y
    const target = stubMesh('Bore');
    model.add(axisNode, target);
    register();
    const doc = scratchAssetDocument(viewer);

    const rollBefore = new Vector3(1, 0, 0)
      .applyQuaternion(axisNode.getWorldQuaternion(new Quaternion()));
    // Aligning +Y to +Y is a no-op rotation, so the yaw must survive untouched —
    // the property that separates a shortest-arc correction from a recompose.
    await pivotToCircle(
      viewer, doc, 'Asset/Axis', target, new Vector3(0, 0, 0), new Vector3(0, 1, 0));
    await doc.whenIdle();
    model.updateMatrixWorld(true);

    const rollAfter = new Vector3(1, 0, 0)
      .applyQuaternion(axisNode.getWorldQuaternion(new Quaternion()));
    expect(rollAfter.distanceTo(rollBefore)).toBeLessThan(1e-6);
    doc.dispose();
  });

  it('keeps all direct children\'s world poses in one transaction', async () => {
    const { viewer, model, register } = makeViewer();
    const axisNode = new Object3D();
    axisNode.name = 'Axis';
    const child = stubMesh('Child');
    child.position.set(3, 4, 5);
    axisNode.add(child);
    const target = stubMesh('Bore');
    target.position.set(-8, 2, 1);
    model.add(axisNode, target);
    register();
    const doc = scratchAssetDocument(viewer);

    const before = child.getWorldPosition(new Vector3()).clone();
    const beforeQuat = child.getWorldQuaternion(new Quaternion()).clone();
    await pivotToCircle(
      viewer, doc, 'Asset/Axis', target, new Vector3(), new Vector3(1, 0, 0));
    await doc.whenIdle();
    model.updateMatrixWorld(true);

    expect(child.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(1e-6);
    expect(Math.abs(child.getWorldQuaternion(new Quaternion()).dot(beforeQuat)))
      .toBeCloseTo(1, 6);

    // ONE undo puts the node AND the compensation back — a composite, not two ops.
    const axisBefore = axisNode.position.clone();
    await doc.undo();
    model.updateMatrixWorld(true);
    expect(axisNode.position.distanceTo(axisBefore)).toBeGreaterThan(1e-6);
    expect(child.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(1e-6);
    doc.dispose();
  });

  it('keeps GRANDchildren\'s world poses when the target mesh is a descendant', async () => {
    // The main real-world case: an axis node is created around the part it will
    // rotate, and the bore that defines the axis belongs to that very part.
    const { viewer, model, register } = makeViewer();
    const axisNode = new Object3D();
    axisNode.name = 'Axis';
    const arm = new Object3D();
    arm.name = 'Arm';
    arm.position.set(2, 0, 0);
    const bore = stubMesh('Bore');
    bore.position.set(5, 1, 0);
    arm.add(bore);
    axisNode.add(arm);
    model.add(axisNode);
    register();
    const doc = scratchAssetDocument(viewer);

    const boreBefore = bore.getWorldPosition(new Vector3()).clone();
    await pivotToCircle(
      viewer, doc, 'Asset/Axis', bore, new Vector3(), new Vector3(0, 0, 1));
    await doc.whenIdle();
    model.updateMatrixWorld(true);

    // The pivot landed on the bore, and the bore did not move an inch.
    expect(axisNode.getWorldPosition(new Vector3()).distanceTo(boreBefore)).toBeLessThan(1e-6);
    expect(bore.getWorldPosition(new Vector3()).distanceTo(boreBefore)).toBeLessThan(1e-6);
    doc.dispose();
  });

  it('recomputes world center/axis from the target\'s CURRENT matrixWorld', async () => {
    const { viewer, model, register } = makeViewer();
    const axisNode = new Object3D();
    axisNode.name = 'Axis';
    const target = stubMesh('Bore');
    target.position.set(10, 0, 0);
    model.add(axisNode, target);
    register();
    const doc = scratchAssetDocument(viewer);

    // The scan happened here — at world (10,0,0), axis +Z.
    // Now the target moves and rotates BEFORE the commit runs (a jog, an undo,
    // a CADLink partial re-import). Only the LOCAL values are still valid.
    target.position.set(-40, 7, 3);
    target.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), new Vector3(1, 0, 0));
    model.updateMatrixWorld(true);

    await pivotToCircle(
      viewer, doc, 'Asset/Axis', target, new Vector3(0, 0, 0), new Vector3(0, 0, 1));
    await doc.whenIdle();
    model.updateMatrixWorld(true);

    // The stale snapshot would have said (10,0,0) / +Z.
    expect(axisNode.getWorldPosition(new Vector3()).distanceTo(new Vector3(-40, 7, 3)))
      .toBeLessThan(1e-6);
    expect(localYWorld(axisNode).distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-6);
    doc.dispose();
  });

  it('is a no-op when position and axis already match', async () => {
    const { viewer, model, register } = makeViewer();
    const axisNode = new Object3D();
    axisNode.name = 'Axis';
    const target = stubMesh('Bore');
    model.add(axisNode, target);
    register();
    const doc = scratchAssetDocument(viewer);

    const opsBefore = doc.document.opCount;
    await pivotToCircle(
      viewer, doc, 'Asset/Axis', target, new Vector3(), new Vector3(0, 1, 0));
    await doc.whenIdle();
    expect(doc.document.opCount).toBe(opsBefore);
    doc.dispose();
  });

  it('refuses a missing node, a missing mesh and a degenerate axis without throwing', async () => {
    const { viewer, model, register } = makeViewer();
    const axisNode = new Object3D();
    axisNode.name = 'Axis';
    const target = stubMesh('Bore');
    model.add(axisNode, target);
    register();
    const doc = scratchAssetDocument(viewer);

    const opsBefore = doc.document.opCount;
    await pivotToCircle(viewer, doc, 'Asset/Nope', target, new Vector3(), new Vector3(0, 0, 1));
    await pivotToCircle(viewer, doc, 'Asset/Axis', null, new Vector3(), new Vector3(0, 0, 1));
    // A zero axis would compose a NaN quaternion and poison every matrix below.
    await pivotToCircle(viewer, doc, 'Asset/Axis', target, new Vector3(), new Vector3());
    await doc.whenIdle();
    expect(doc.document.opCount).toBe(opsBefore);
    doc.dispose();
  });
});

describe('pivotToCircle guards', () => {
  it('does nothing for a missing node, a missing mesh or a degenerate axis', async () => {
    const { viewer, model, register } = makeViewer();
    const axisNode = new Object3D();
    axisNode.name = 'Axis';
    const target = stubMesh('Bore');
    model.add(axisNode, target);
    register();
    const doc = scratchAssetDocument(viewer);

    const opsBefore = doc.document.opCount;
    await pivotToCircle(viewer, doc, 'Asset/Nope', target, new Vector3(), new Vector3(0, 0, 1));
    await pivotToCircle(viewer, doc, 'Asset/Axis', null, new Vector3(), new Vector3(0, 0, 1));
    // A zero axis would compose a NaN quaternion and poison every matrix below.
    await pivotToCircle(viewer, doc, 'Asset/Axis', target, new Vector3(), new Vector3());
    await doc.whenIdle();
    expect(doc.document.opCount).toBe(opsBefore);
    doc.dispose();
  });
});

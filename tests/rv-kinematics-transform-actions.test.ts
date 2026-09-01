// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Kinematics transform-action tests — zero position, rotate ±90°, to-ground
 * and the child-compensating pivot tools (pivot to bottom / align Y up).
 * The pivot tools' contract: the NODE moves, every child keeps its WORLD pose.
 */
import { describe, it, expect } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D, Mesh, BoxGeometry, Vector3, Quaternion, Euler } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import {
  zeroLocalPosition, rotate90, toGround, pivotToBottom, alignYUp, centerKinematicToGroup, pivotToObjectCenter,
} from '@rv-private/plugins/asset-editor/kinematics/transform-actions';

function makeViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  const register = () => {
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  };
  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
  } as unknown as RVViewer;
  return { viewer, model, registry, register };
}

function boxMesh(name: string, pos: [number, number, number]): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1));
  mesh.name = name;
  mesh.position.set(...pos);
  return mesh;
}

describe('zeroLocalPosition / rotate90', () => {
  it('zeroLocalPosition zeroes the local position and undo restores it', async () => {
    const { viewer, model, register } = makeViewer();
    const node = new Object3D();
    node.name = 'Part';
    node.position.set(3, 4, 5);
    model.add(node);
    register();
    const doc = scratchAssetDocument(viewer);

    await zeroLocalPosition(viewer, doc, ['Asset/Part']);
    await doc.whenIdle();
    expect(node.position.toArray()).toEqual([0, 0, 0]);
    await doc.undo();
    expect(node.position.toArray()).toEqual([3, 4, 5]);
    doc.dispose();
  });

  it('rotate90 rotates ±90° around the LOCAL axis', async () => {
    const { viewer, model, register } = makeViewer();
    const node = new Object3D();
    node.name = 'Part';
    model.add(node);
    register();
    const doc = scratchAssetDocument(viewer);

    rotate90(viewer, doc, 'Asset/Part', 'y', 1);
    await doc.whenIdle();
    const expected = new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0));
    expect(Math.abs(node.quaternion.dot(expected))).toBeCloseTo(1, 6);

    rotate90(viewer, doc, 'Asset/Part', 'y', -1);
    await doc.whenIdle();
    expect(Math.abs(node.quaternion.dot(new Quaternion()))).toBeCloseTo(1, 6);
    doc.dispose();
  });
});

describe('toGround', () => {
  it('shifts the object so its bounds rest on Y = 0', async () => {
    const { viewer, model, register } = makeViewer();
    const rig = new Object3D();
    rig.name = 'Rig';
    rig.position.set(0, 3, 0);
    rig.add(boxMesh('Box', [0, 0, 0])); // unit cube centered at rig origin
    model.add(rig);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    toGround(viewer, doc, 'Asset/Rig');
    await doc.whenIdle();
    // Cube center must now sit at y = 0.5 → bounds min at 0.
    expect(rig.position.y).toBeCloseTo(0.5, 6);
    doc.dispose();
  });
});

describe('pivot tools (child world pose preserved)', () => {
  it('pivotToBottom moves the pivot to the bounds bottom-center; children stay put', async () => {
    const { viewer, model, register } = makeViewer();
    const rig = new Object3D();
    rig.name = 'Rig';
    rig.position.set(0, 1, 0);
    const mesh = boxMesh('Box', [2, 0, 0]); // world center (2, 1, 0), min.y = 0.5
    rig.add(mesh);
    model.add(rig);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    const meshWorldBefore = mesh.getWorldPosition(new Vector3()).clone();
    await pivotToBottom(viewer, doc, 'Asset/Rig');
    await doc.whenIdle();
    model.updateMatrixWorld(true);

    expect(rig.position.toArray().map(v => Math.round(v * 1e6) / 1e6)).toEqual([2, 0.5, 0]);
    expect(mesh.getWorldPosition(new Vector3()).distanceTo(meshWorldBefore)).toBeLessThan(1e-6);

    // One undo reverts node + child compensation together.
    await doc.undo();
    model.updateMatrixWorld(true);
    expect(rig.position.toArray()).toEqual([0, 1, 0]);
    expect(mesh.getWorldPosition(new Vector3()).distanceTo(meshWorldBefore)).toBeLessThan(1e-6);
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });

  it('alignYUp re-orients local +Y to world up; children stay put', async () => {
    const { viewer, model, register } = makeViewer();
    const rig = new Object3D();
    rig.name = 'Rig';
    rig.position.set(0, 2, 0);
    rig.quaternion.setFromEuler(new Euler(0, 0, Math.PI / 2)); // local Y points at world -X
    const mesh = boxMesh('Box', [0, 1.5, 0]);
    rig.add(mesh);
    model.add(rig);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    const meshWorldBefore = mesh.getWorldPosition(new Vector3()).clone();
    await alignYUp(viewer, doc, 'Asset/Rig');
    await doc.whenIdle();
    model.updateMatrixWorld(true);

    const worldY = new Vector3(0, 1, 0).applyQuaternion(rig.getWorldQuaternion(new Quaternion()));
    expect(worldY.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-6);
    expect(mesh.getWorldPosition(new Vector3()).distanceTo(meshWorldBefore)).toBeLessThan(1e-6);
    doc.dispose();
  });
});

describe('centerKinematicToGroup', () => {
  it('moves the axis pivot to the world center of its group objects; the objects stay put; undo restores', async () => {
    const { viewer, model, register } = makeViewer();
    // Two member cubes at x=0 and x=4 → combined center (2, 1, 0).
    const m1 = boxMesh('M1', [0, 1, 0]);
    const m2 = boxMesh('M2', [4, 1, 0]);
    model.add(m1);
    model.add(m2);
    // Kinematic axis empty, off-center.
    const axis = new Object3D();
    axis.name = 'Axis';
    axis.userData['realvirtual'] = { Kinematic: { GroupName: 'AxisGrp' } };
    axis.position.set(10, 10, 10);
    model.add(axis);
    register();
    model.updateMatrixWorld(true);

    const groups = new GroupRegistry();
    groups.register('AxisGrp', m1);
    groups.register('AxisGrp', m2);
    (viewer as unknown as { groups: GroupRegistry }).groups = groups;

    const doc = scratchAssetDocument(viewer);
    const m1Before = m1.getWorldPosition(new Vector3()).clone();
    const m2Before = m2.getWorldPosition(new Vector3()).clone();

    await centerKinematicToGroup(viewer, doc, 'Asset/Axis');
    await doc.whenIdle();
    model.updateMatrixWorld(true);

    const axisWorld = axis.getWorldPosition(new Vector3());
    expect(axisWorld.x).toBeCloseTo(2, 6);
    expect(axisWorld.y).toBeCloseTo(1, 6);
    expect(axisWorld.z).toBeCloseTo(0, 6);
    // Group objects are NOT children of the axis — they must not move.
    expect(m1.getWorldPosition(new Vector3()).distanceTo(m1Before)).toBeLessThan(1e-6);
    expect(m2.getWorldPosition(new Vector3()).distanceTo(m2Before)).toBeLessThan(1e-6);

    await doc.undo();
    model.updateMatrixWorld(true);
    expect(axis.position.toArray()).toEqual([10, 10, 10]);
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });

  it('compensates a direct child so it keeps its world pose when the axis moves', async () => {
    const { viewer, model, register } = makeViewer();
    const m1 = boxMesh('M1', [0, 0, 0]);
    const m2 = boxMesh('M2', [4, 0, 0]);
    model.add(m1);
    model.add(m2);
    const axis = new Object3D();
    axis.name = 'Axis';
    axis.userData['realvirtual'] = { Kinematic: { GroupName: 'G' } };
    axis.position.set(0, 0, 0);
    const child = new Object3D();
    child.name = 'Child';
    child.position.set(1, 0, 0);
    axis.add(child);
    model.add(axis);
    register();
    model.updateMatrixWorld(true);

    const groups = new GroupRegistry();
    groups.register('G', m1);
    groups.register('G', m2);
    (viewer as unknown as { groups: GroupRegistry }).groups = groups;

    const doc = scratchAssetDocument(viewer);
    const childBefore = child.getWorldPosition(new Vector3()).clone();

    await centerKinematicToGroup(viewer, doc, 'Asset/Axis');
    await doc.whenIdle();
    model.updateMatrixWorld(true);

    expect(axis.getWorldPosition(new Vector3()).x).toBeCloseTo(2, 6);
    // Child compensated → same world pose despite the axis moving.
    expect(child.getWorldPosition(new Vector3()).distanceTo(childBefore)).toBeLessThan(1e-6);
    doc.dispose();
  });

  it('no-ops when the kinematic group has no members', async () => {
    const { viewer, model, register } = makeViewer();
    const axis = new Object3D();
    axis.name = 'Axis';
    axis.userData['realvirtual'] = { Kinematic: { GroupName: 'Empty' } };
    axis.position.set(5, 6, 7);
    model.add(axis);
    register();
    model.updateMatrixWorld(true);
    (viewer as unknown as { groups: GroupRegistry }).groups = new GroupRegistry();

    const doc = scratchAssetDocument(viewer);
    await centerKinematicToGroup(viewer, doc, 'Asset/Axis');
    await doc.whenIdle();
    expect(axis.position.toArray()).toEqual([5, 6, 7]);
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });
});

describe('pivotToObjectCenter', () => {
  it('moves the source pivot to the target object center; source children keep world pose; target unaffected', async () => {
    const { viewer, model, register } = makeViewer();
    // Target cube centered at world (5, 0, 0).
    const target = boxMesh('Target', [5, 0, 0]);
    model.add(target);
    // Source empty at the origin carrying a child mesh at local (1,0,0).
    const source = new Object3D();
    source.name = 'Source';
    source.position.set(0, 0, 0);
    const child = boxMesh('Child', [1, 0, 0]);
    source.add(child);
    model.add(source);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);

    const childBefore = child.getWorldPosition(new Vector3()).clone();
    const targetBefore = target.getWorldPosition(new Vector3()).clone();

    await pivotToObjectCenter(viewer, doc, 'Asset/Source', 'Asset/Target');
    await doc.whenIdle();
    model.updateMatrixWorld(true);

    // Source pivot now sits at the target's center (5,0,0).
    const srcWorld = source.getWorldPosition(new Vector3());
    expect(srcWorld.x).toBeCloseTo(5, 6);
    expect(srcWorld.y).toBeCloseTo(0, 6);
    expect(srcWorld.z).toBeCloseTo(0, 6);
    // Source child compensated → unchanged world pose. Target never moves.
    expect(child.getWorldPosition(new Vector3()).distanceTo(childBefore)).toBeLessThan(1e-6);
    expect(target.getWorldPosition(new Vector3()).distanceTo(targetBefore)).toBeLessThan(1e-6);

    await doc.undo();
    model.updateMatrixWorld(true);
    expect(source.position.toArray()).toEqual([0, 0, 0]);
    expect(child.getWorldPosition(new Vector3()).distanceTo(childBefore)).toBeLessThan(1e-6);
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });

  it('no-ops when source and target are missing', async () => {
    const { viewer, model, register } = makeViewer();
    model.add(boxMesh('Only', [0, 0, 0]));
    register();
    const doc = scratchAssetDocument(viewer);
    await pivotToObjectCenter(viewer, doc, 'Asset/Missing', 'Asset/Only');
    await doc.whenIdle();
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });
});

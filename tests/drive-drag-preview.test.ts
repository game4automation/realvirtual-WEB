// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-drag-preview — the editor drive-gizmo drag driver: previews a drive's
 * motion (axis node + rigid kinematic-group members) and restores exactly.
 * Tests the synchronous preview/cancel path (the rAF spring is browser-only).
 */
import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, Object3D, Vector3, Quaternion, Euler } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { DriveDragPreview } from '@rv-private/plugins/asset-editor/drive-drag-preview';
import { resolveEditorDriveGizmoSource } from '@rv-private/plugins/asset-editor/editor-drive-gizmo-source';

function makeEnv() {
  const scene = new Group(); // model root
  const nodes: Record<string, Object3D> = {};
  const groups = new GroupRegistry();
  const viewer = {
    groups,
    registry: { getNode: (p: string) => nodes[p] ?? null },
    on: () => () => {},
    markRenderDirty() {},
    markShadowsDirty() {},
  } as unknown as RVViewer;
  return { scene, nodes, groups, viewer };
}

function axisWithDrive(name: string, drive: Record<string, unknown>, kinGroup?: string): Group {
  const node = new Group();
  node.name = name;
  const rv: Record<string, unknown> = { Drive: drive };
  if (kinGroup) rv['Kinematic'] = { GroupName: kinGroup, IntegrateGroupEnable: true };
  node.userData['realvirtual'] = rv;
  return node;
}

describe('DriveDragPreview — linear', () => {
  it('moves the axis node and a non-child group member by the same world delta; cancel restores', () => {
    const { scene, nodes, groups, viewer } = makeEnv();
    const axis = axisWithDrive('Axis', { Direction: 'LinearX' }, 'G');
    scene.add(axis); nodes['Axis'] = axis;
    const member = new Mesh(new BoxGeometry(1, 1, 1)); member.name = 'M'; member.position.set(5, 0, 0);
    scene.add(member); nodes['M'] = member;
    groups.register('G', member);
    scene.updateMatrixWorld(true);

    const source = resolveEditorDriveGizmoSource(viewer, 'Axis')!;
    const driver = new DriveDragPreview(viewer);
    const memberBefore = member.getWorldPosition(new Vector3()).clone();

    // LinearX glTF axis = (-1,0,0); P=-1000mm → +1 m along +X.
    driver.preview({ viewer, source, node: axis, position: -1000 });
    scene.updateMatrixWorld(true);
    expect(axis.position.x).toBeCloseTo(1, 6);
    expect(member.getWorldPosition(new Vector3()).x).toBeCloseTo(6, 6);

    driver.cancel({ viewer, source, node: axis, position: 0 });
    scene.updateMatrixWorld(true);
    expect(axis.position.x).toBeCloseTo(0, 6);
    expect(member.getWorldPosition(new Vector3()).distanceTo(memberBefore)).toBeLessThan(1e-6);
  });

  it('does NOT double-move a member that is already a child of the axis', () => {
    const { scene, nodes, groups, viewer } = makeEnv();
    const axis = axisWithDrive('Axis', { Direction: 'LinearX' }, 'G');
    scene.add(axis); nodes['Axis'] = axis;
    const child = new Group(); child.name = 'C'; child.position.set(2, 0, 0);
    axis.add(child); nodes['Axis/C'] = child;
    groups.register('G', child); // group member, but under the axis
    scene.updateMatrixWorld(true);

    const source = resolveEditorDriveGizmoSource(viewer, 'Axis')!;
    const driver = new DriveDragPreview(viewer);

    driver.preview({ viewer, source, node: axis, position: -1000 });
    scene.updateMatrixWorld(true);
    // Axis moved +1 on X; child follows via parenting to world 3 (NOT 4 = doubled).
    expect(axis.position.x).toBeCloseTo(1, 6);
    expect(child.getWorldPosition(new Vector3()).x).toBeCloseTo(3, 6);

    driver.cancel({ viewer, source, node: axis, position: 0 });
    scene.updateMatrixWorld(true);
    expect(child.getWorldPosition(new Vector3()).x).toBeCloseTo(2, 6);
  });
});

describe('DriveDragPreview — rotary', () => {
  it('rotates a non-child member rigidly about the axis origin; cancel restores', () => {
    const { scene, nodes, groups, viewer } = makeEnv();
    const axis = axisWithDrive('Axis', { Direction: 'RotationZ' }, 'G');
    scene.add(axis); nodes['Axis'] = axis;
    const member = new Mesh(new BoxGeometry(1, 1, 1)); member.name = 'M'; member.position.set(2, 0, 0);
    scene.add(member); nodes['M'] = member;
    groups.register('G', member);
    scene.updateMatrixWorld(true);

    const source = resolveEditorDriveGizmoSource(viewer, 'Axis')!;
    const driver = new DriveDragPreview(viewer);
    const before = member.getWorldPosition(new Vector3()).clone();

    // RotationZ glTF axis = (0,0,-1); P=90° → member (2,0,0) rotates to (0,-2,0).
    driver.preview({ viewer, source, node: axis, position: 90 });
    scene.updateMatrixWorld(true);
    const w = member.getWorldPosition(new Vector3());
    expect(w.x).toBeCloseTo(0, 5);
    expect(w.y).toBeCloseTo(-2, 5);

    driver.cancel({ viewer, source, node: axis, position: 0 });
    scene.updateMatrixWorld(true);
    expect(member.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(1e-6);
  });
});

describe('DriveDragPreview — safety', () => {
  it('restores the axis node EXACTLY (rotated home) after a preview', () => {
    const { scene, nodes, viewer } = makeEnv();
    const axis = axisWithDrive('Axis', { Direction: 'LinearY' });
    axis.position.set(1, 2, 3);
    axis.quaternion.setFromEuler(new Euler(0.1, 0.2, 0.3));
    scene.add(axis); nodes['Axis'] = axis;
    scene.updateMatrixWorld(true);

    const source = resolveEditorDriveGizmoSource(viewer, 'Axis')!;
    const driver = new DriveDragPreview(viewer);
    const posHome = axis.position.clone();
    const quatHome = axis.quaternion.clone();

    driver.preview({ viewer, source, node: axis, position: 500 });
    driver.preview({ viewer, source, node: axis, position: -300 });
    driver.cancel({ viewer, source, node: axis, position: 0 });

    expect(axis.position.distanceTo(posHome)).toBeLessThan(1e-9);
    expect(Math.abs(axis.quaternion.dot(quatHome))).toBeCloseTo(1, 12);
  });

  it('holds no document reference — a preview can never emit an op', () => {
    const { viewer } = makeEnv();
    const driver = new DriveDragPreview(viewer) as unknown as Record<string, unknown>;
    // Structural guarantee: the driver never received a doc/AssetDocument.
    for (const v of Object.values(driver)) {
      expect(String((v as { constructor?: { name?: string } })?.constructor?.name ?? '')).not.toBe('AssetDocument');
    }
  });
});

describe('DriveDragPreview — nested kinematics (scene hierarchy chain)', () => {
  it('moves a child kinematic AND its own group members with the dragged parent', () => {
    const { scene, nodes, groups, viewer } = makeEnv();
    // A drives group GA; B (a member of GA) is itself a kinematic driving GB.
    const a = axisWithDrive('A', { Direction: 'LinearX' }, 'GA');
    scene.add(a); nodes['A'] = a;

    const b = new Group(); b.name = 'B'; b.position.set(2, 0, 0);
    b.userData['realvirtual'] = { Kinematic: { GroupName: 'GB', IntegrateGroupEnable: true } };
    scene.add(b); nodes['B'] = b;

    const m2 = new Mesh(new BoxGeometry(1, 1, 1)); m2.name = 'M2'; m2.position.set(5, 0, 0);
    scene.add(m2); nodes['M2'] = m2;

    groups.register('GA', b);  // B is a member of A's group
    groups.register('GB', m2); // M2 is a member of B's group
    scene.updateMatrixWorld(true);

    const source = resolveEditorDriveGizmoSource(viewer, 'A')!;
    const driver = new DriveDragPreview(viewer);
    const bBefore = b.getWorldPosition(new Vector3()).clone();
    const m2Before = m2.getWorldPosition(new Vector3()).clone();

    // LinearX P=-1000 → +1 m along X for the whole assembly.
    driver.preview({ viewer, source, node: a, position: -1000 });
    scene.updateMatrixWorld(true);
    expect(b.getWorldPosition(new Vector3()).x).toBeCloseTo(bBefore.x + 1, 6);
    expect(m2.getWorldPosition(new Vector3()).x).toBeCloseTo(m2Before.x + 1, 6);

    driver.cancel({ viewer, source, node: a, position: 0 });
    scene.updateMatrixWorld(true);
    expect(b.getWorldPosition(new Vector3()).distanceTo(bBefore)).toBeLessThan(1e-6);
    expect(m2.getWorldPosition(new Vector3()).distanceTo(m2Before)).toBeLessThan(1e-6);
  });

  it('does not move a group whose Kinematic is NOT integrated (IntegrateGroupEnable false)', () => {
    const { scene, nodes, groups, viewer } = makeEnv();
    const a = new Group(); a.name = 'A';
    a.userData['realvirtual'] = { Drive: { Direction: 'LinearX' }, Kinematic: { GroupName: 'G', IntegrateGroupEnable: false } };
    scene.add(a); nodes['A'] = a;
    const m = new Mesh(new BoxGeometry(1, 1, 1)); m.name = 'M'; m.position.set(5, 0, 0);
    scene.add(m); nodes['M'] = m;
    groups.register('G', m);
    scene.updateMatrixWorld(true);

    const source = resolveEditorDriveGizmoSource(viewer, 'A')!;
    const driver = new DriveDragPreview(viewer);
    const mBefore = m.getWorldPosition(new Vector3()).clone();

    driver.preview({ viewer, source, node: a, position: -1000 });
    scene.updateMatrixWorld(true);
    // Group not integrated → not reparented at runtime → does not move with the axis.
    expect(m.getWorldPosition(new Vector3()).distanceTo(mBefore)).toBeLessThan(1e-6);
    driver.cancel({ viewer, source, node: a, position: 0 });
  });
});

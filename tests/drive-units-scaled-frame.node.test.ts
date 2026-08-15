// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A linear drive position is a PHYSICAL millimetre, also inside a CAD subtree.
 *
 * The STEP and JT importers keep the assembly in its native millimetres and put
 * the mm→m conversion on the CAD ROOT as a node scale (CADLink.ImportScaleFactor
 * = 0.001), instead of baking it into the vertices. A drive created inside such
 * a root therefore lives in a MILLIMETRE frame, and the historical `mm / 1000`
 * conversion under-travelled by exactly that factor: the PLMXML import's 740 mm
 * ZL1 stroke came out as 0.74 mm on a four-metre machine, i.e. "nothing moves".
 *
 * These tests pin BOTH halves of the contract:
 *   - inside a 0.001-scaled root, the drive position is honoured in world metres,
 *   - at scale 1 the numbers are bit-identical to before (no Unity-parity drift;
 *     Unity bakes its import scale, so a Unity drive is never in a scaled frame).
 *
 * They cover the runtime drive, the editor's authoring gizmo source and the
 * editor drag preview — the three places that do the conversion.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, Object3D, Vector3 } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { RVDrive } from '../src/core/engine/rv-drive';
import { DriveDirection } from '../src/core/engine/rv-coordinate-utils';
import { parentScaleAlong } from '../src/core/engine/rv-drive-units';
import { DriveDragPreview } from '@rv-private/plugins/asset-editor/drive-drag-preview';
import { resolveEditorDriveGizmoSource } from '@rv-private/plugins/asset-editor/editor-drive-gizmo-source';

/** Scene root → CAD root (scale s, mm inside) → axis node. */
function makeCadScene(s: number) {
  const scene = new Group();
  const cadRoot = new Group();
  cadRoot.name = 'CAD';
  cadRoot.scale.setScalar(s);
  scene.add(cadRoot);
  const axis = new Group();
  axis.name = 'Axis';
  cadRoot.add(axis);
  scene.updateMatrixWorld(true);
  return { scene, cadRoot, axis };
}

function makeViewer(nodes: Record<string, Object3D>, groups = new GroupRegistry()) {
  return {
    groups,
    registry: { getNode: (p: string) => nodes[p] ?? null },
    on: () => () => {},
    markRenderDirty() {},
    markShadowsDirty() {},
  } as unknown as RVViewer;
}

describe('parentScaleAlong', () => {
  it('is 1 for a root node and for an unscaled parent (the conversion is a no-op there)', () => {
    const { axis } = makeCadScene(1);
    expect(parentScaleAlong(axis, new Vector3(0, 1, 0))).toBeCloseTo(1, 12);
    expect(parentScaleAlong(new Group(), new Vector3(0, 1, 0))).toBe(1);
  });

  it('reads the CAD root scale, and survives a degenerate direction', () => {
    const { axis } = makeCadScene(0.001);
    expect(parentScaleAlong(axis, new Vector3(0, 1, 0))).toBeCloseTo(0.001, 12);
    // Direction length must not matter — only its orientation.
    expect(parentScaleAlong(axis, new Vector3(0, 7, 0))).toBeCloseTo(0.001, 12);
    // Degenerate input falls back to 1 instead of dividing by zero later.
    expect(parentScaleAlong(axis, new Vector3(0, 0, 0))).toBe(1);
  });

  it('is direction-dependent under a non-uniform parent scale', () => {
    const { cadRoot, axis } = makeCadScene(1);
    cadRoot.scale.set(0.001, 1, 1);
    cadRoot.updateMatrixWorld(true);
    expect(parentScaleAlong(axis, new Vector3(1, 0, 0))).toBeCloseTo(0.001, 12);
    expect(parentScaleAlong(axis, new Vector3(0, 1, 0))).toBeCloseTo(1, 12);
  });
});

describe('RVDrive — linear travel is millimetres in WORLD space', () => {
  for (const s of [1, 0.001]) {
    it(`moves 740 mm of world travel at CAD-root scale ${s}`, () => {
      const { scene, axis } = makeCadScene(s);
      const drive = new RVDrive(axis);
      drive.Direction = DriveDirection.LinearY;
      drive.initDrive();

      drive.applySyncData(-100.5);
      scene.updateMatrixWorld(true);
      const lower = axis.getWorldPosition(new Vector3()).clone();
      drive.applySyncData(639.5);
      scene.updateMatrixWorld(true);
      const upper = axis.getWorldPosition(new Vector3()).clone();

      expect(upper.distanceTo(lower)).toBeCloseTo(0.74, 9);
      // The local offset is expressed in the parent's units, not in metres.
      expect(drive.positionToLocalOffset(740)).toBeCloseTo(0.74 / s, 9);
    });
  }

  it('leaves a ROTARY drive untouched by the frame scale (an angle has no length)', () => {
    const a = makeCadScene(1);
    const b = makeCadScene(0.001);
    const da = new RVDrive(a.axis); da.Direction = DriveDirection.RotationY; da.initDrive();
    const db = new RVDrive(b.axis); db.Direction = DriveDirection.RotationY; db.initDrive();
    da.applySyncData(90); db.applySyncData(90);
    expect(da.node.quaternion.angleTo(db.node.quaternion)).toBeCloseTo(0, 12);
  });
});

describe('editor authoring path — same conversion as the live drive', () => {
  it('the gizmo source reports the local offset in the parent frame units', () => {
    for (const s of [1, 0.001]) {
      const { axis } = makeCadScene(s);
      axis.userData['realvirtual'] = { Drive: { Direction: 'LinearY' } };
      const viewer = makeViewer({ Axis: axis });
      const source = resolveEditorDriveGizmoSource(viewer, 'Axis')!;
      expect(source.positionToLocalOffset(740)).toBeCloseTo(0.74 / s, 9);
    }
  });

  it('the drag preview moves the axis AND its group members 740 mm in world space', () => {
    const { scene, cadRoot, axis } = makeCadScene(0.001);
    axis.userData['realvirtual'] = {
      Drive: { Direction: 'LinearY', UseLimits: true, LowerLimit: -100.5, UpperLimit: 639.5 },
      Kinematic: { GroupName: 'ZL1', IntegrateGroupEnable: true },
    };
    // A member that stays in the CAD tree (group mode) — not a child of the axis.
    const member = new Mesh(new BoxGeometry(1, 1, 1));
    member.name = 'Part';
    member.position.set(0, 500, 0); // millimetres, like the rest of the CAD subtree
    cadRoot.add(member);
    // And one part that belongs to no axis at all.
    const bystander = new Mesh(new BoxGeometry(1, 1, 1));
    bystander.name = 'Frame';
    bystander.position.set(300, 0, 0);
    cadRoot.add(bystander);
    scene.updateMatrixWorld(true);

    const groups = new GroupRegistry();
    groups.register('ZL1', member);
    const viewer = makeViewer({ Axis: axis, Part: member, Frame: bystander }, groups);
    const source = resolveEditorDriveGizmoSource(viewer, 'Axis')!;
    const driver = new DriveDragPreview(viewer);

    const memberHome = member.getWorldPosition(new Vector3()).clone();
    const bystanderHome = bystander.getWorldPosition(new Vector3()).clone();

    driver.preview({ viewer, source, node: axis, position: -100.5 });
    scene.updateMatrixWorld(true);
    const memberLower = member.getWorldPosition(new Vector3()).clone();
    const bystanderLower = bystander.getWorldPosition(new Vector3()).clone();

    driver.preview({ viewer, source, node: axis, position: 639.5 });
    scene.updateMatrixWorld(true);
    const memberUpper = member.getWorldPosition(new Vector3()).clone();
    const bystanderUpper = bystander.getWorldPosition(new Vector3()).clone();

    // The member travels the full stroke, in metres, along the drive axis.
    expect(memberUpper.distanceTo(memberLower)).toBeCloseTo(0.74, 9);
    // A part in no group never moves.
    expect(bystanderUpper.distanceTo(bystanderLower)).toBeLessThan(1e-12);
    expect(bystanderLower.distanceTo(bystanderHome)).toBeLessThan(1e-12);

    driver.cancel({ viewer, source, node: axis, position: 0 });
    scene.updateMatrixWorld(true);
    expect(member.getWorldPosition(new Vector3()).distanceTo(memberHome)).toBeLessThan(1e-12);
  });
});

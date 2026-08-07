// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { RVDrive, DriveDirection } from '../../src/core/engine/rv-drive';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import {
  attachMuToTcp,
  buildAxesTween,
  detachMuFromTcp,
  snapToPose,
  type RobotIkAnchor,
} from '../../src/behaviors/_shared/robot-ik-des';

function anchorFixture(axisCount = 2): { anchor: RobotIkAnchor; drives: RVDrive[]; root: Object3D; tcp: Object3D } {
  const root = new Object3D(); root.name = 'Cell';
  const robot = new Object3D(); robot.name = 'Robot'; root.add(robot);
  const tcp = new Object3D(); tcp.name = 'TCP'; robot.add(tcp);
  const drives = Array.from({ length: axisCount }, (_, index) => {
    const node = new Object3D(); node.name = `A${index + 1}`; robot.add(node);
    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.RotationZ;
    drive.TargetSpeed = index === 0 ? 1 : 10000;
    drive.initDrive();
    return drive;
  });
  return { anchor: { node: robot, getAxisDrives: () => drives, getTcpNode: () => tcp }, drives, root, tcp };
}

describe('robot IK DES scheduler', () => {
  it('preserves the caller duration verbatim and never derives it from drive speeds', () => {
    const { anchor } = anchorFixture();
    const plan = buildAxesTween(anchor, [90, -45], 2.75, { driveRefs: ['Cell/Robot/A1', 'Cell/Robot/A2'] });
    expect(plan.duration).toBe(2.75);
    expect(plan.tween.kind).toBe('axes');
    if (plan.tween.kind === 'axes') expect(plan.tween.phases[0].axes.map((axis) => axis.to)).toEqual([90, -45]);
  });

  it('snapToPose uses positionOverwrite and accepts an all-zero pose', () => {
    const { anchor, drives } = anchorFixture();
    drives[0].currentPosition = 10;
    expect(snapToPose(anchor, [0, 0])).toBe(true);
    expect(drives.map((drive) => drive.currentPosition)).toEqual([0, 0]);
    expect(drives.every((drive) => drive.positionOverwrite)).toBe(true);
    expect(snapToPose(anchor, [0, Number.NaN])).toBe(false);
  });

  it('attaches/detaches a materialized MU at the TCP with world transform preserved', () => {
    const { anchor, root, tcp } = anchorFixture(1);
    tcp.position.set(3, 0, 0);
    const parent = new Object3D(); parent.name = 'Parts'; parent.position.set(1, 2, 0); root.add(parent);
    const node = new Object3D(); node.position.set(2, 0, 0); parent.add(node);
    root.updateWorldMatrix(true, true);
    const visual = new RVMovingUnit(node, 'test', new Vector3(0.1, 0.1, 0.1));
    const before = node.getWorldPosition(new Vector3());
    const attachment = attachMuToTcp(anchor, visual);
    expect(attachment).not.toBeNull();
    expect(node.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(1e-9);
    detachMuFromTcp(attachment!);
    expect(node.parent).toBe(parent);
    expect(node.getWorldPosition(new Vector3()).distanceTo(before)).toBeLessThan(1e-9);
  });

  it('materializeMu is idempotent and returns defined errors', () => {
    const runner = new DESRunner({ subMode: 'fastforward' });
    const scene = new Object3D();
    runner.registerMuVisualFactory('part', () => {
      const node = new Object3D(); scene.add(node);
      return new RVMovingUnit(node, 'part', new Vector3(0.1, 0.1, 0.1));
    });
    const mu = runner.createMU('part');
    const first = runner.materializeMu(mu);
    const second = runner.materializeMu(mu);
    expect(first.ok && first.created).toBe(true);
    expect(second.ok && !second.created).toBe(true);
    const missing = runner.createMU();
    expect(runner.materializeMu(missing)).toMatchObject({ ok: false, reason: 'missing-template' });
    runner.dispose();
  });
});

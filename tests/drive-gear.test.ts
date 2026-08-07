// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-gear.test.ts — RVDriveGear couples a slave drive to a master drive.
 *
 * Port of Drive_Gear.cs: every fixed step the slave position is derived from
 * the master through a gear ratio + offset:
 *   CurrentPosition = MasterDrive.CurrentPosition * GearFactor + Offset
 *   CurrentSpeed    = MasterDrive.CurrentSpeed    * GearFactor
 * The slave has no autonomous physics — it mirrors the master. This is the
 * mechanism behind the Mauser arrestor clamps (one cylinder-driven master leaf
 * driving a mirrored slave leaf) and gripper fingers.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Scene, MathUtils } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveGear } from '../src/core/engine/rv-drive-gear';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

interface GearFixture {
  master: RVDrive;
  slave: RVDrive;
  gear: RVDriveGear;
}

function makeGearFixture(opts: { factor?: number; offset?: number; slaveReverse?: boolean } = {}): GearFixture {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);

  const masterNode = new Object3D();
  masterNode.name = 'Master';
  root.add(masterNode);
  const slaveNode = new Object3D();
  slaveNode.name = 'Slave';
  root.add(slaveNode);

  const masterPath = NodeRegistry.computeNodePath(masterNode);
  const slavePath = NodeRegistry.computeNodePath(slaveNode);
  registry.registerNode(masterPath, masterNode);
  registry.registerNode(slavePath, slaveNode);

  const master = new RVDrive(masterNode);
  master.Direction = DriveDirection.RotationZ;
  master.ReverseDirection = true;
  master.initDrive();
  registry.register('Drive', masterPath, master);

  const slave = new RVDrive(slaveNode);
  slave.Direction = DriveDirection.RotationZ;
  slave.ReverseDirection = opts.slaveReverse ?? false;
  slave.initDrive();
  registry.register('Drive', slavePath, slave);

  // Wire the gear as resolveComponentRefs() would: MasterDrive already resolved
  // to the master RVDrive instance.
  const gear = new RVDriveGear(slaveNode);
  gear.MasterDrive = master;
  gear.GearFactor = opts.factor ?? 1;
  gear.Offset = opts.offset ?? 0;
  slave.BehaviorExtras['Drive_Gear'] = { MasterDrive: { type: 'ComponentReference', path: masterPath } };

  const ctx: ComponentContext = {
    registry,
    signalStore: store,
    scene,
    transportManager: new RVTransportManager(),
    root,
  };
  gear.init(ctx);

  return { master, slave, gear };
}

describe('RVDriveGear master→slave coupling', () => {
  it('registers itself as a drive behavior on the slave', () => {
    const { slave } = makeGearFixture();
    expect(slave.driveBehaviors.length).toBe(1);
  });

  it('copies the master position with factor 1 / offset 0', () => {
    const { master, slave } = makeGearFixture();
    for (const p of [0, 30, 60, 90]) {
      master.currentPosition = p;
      slave.update(1 / 60);
      expect(slave.currentPosition).toBeCloseTo(p, 6);
    }
  });

  it('applies GearFactor and Offset (pos = master*factor + offset)', () => {
    const { master, slave } = makeGearFixture({ factor: 2, offset: 5 });
    master.currentPosition = 40;
    slave.update(1 / 60);
    expect(slave.currentPosition).toBeCloseTo(85, 6); // 40*2 + 5
  });

  it('propagates speed through the gear ratio', () => {
    const { master, slave } = makeGearFixture({ factor: 0.5 });
    master.currentSpeed = 120;
    slave.update(1 / 60);
    expect(slave.currentSpeed).toBeCloseTo(60, 6);
  });

  it('drives the slave node transform (rotates about its own pivot)', () => {
    const { master, slave } = makeGearFixture();
    master.currentPosition = 90;
    slave.update(1 / 60);
    slave.node.updateMatrixWorld(true);
    // RotationZ (not reversed) → glTF axis (0,0,-1): a +90° command yields a
    // quaternion whose z-component is sin(-45°). Position stays put (pure spin).
    expect(slave.node.position.length()).toBeCloseTo(0, 6);
    expect(slave.node.quaternion.z).toBeCloseTo(Math.sin(MathUtils.degToRad(-90) / 2), 4);
  });

  it('mirrors via opposite ReverseDirection (arrestor clamp: same position, opposite spin)', () => {
    const { master, slave } = makeGearFixture({ slaveReverse: false });
    master.currentPosition = 90;
    slave.update(1 / 60);
    master.applyToNode();
    master.node.updateMatrixWorld(true);
    slave.node.updateMatrixWorld(true);
    // Same commanded position, but master is ReverseDirection=true and slave is
    // false → their node spins are opposite (mirror closing like a clamp).
    expect(slave.currentPosition).toBeCloseTo(master.currentPosition, 6);
    expect(slave.node.quaternion.z).toBeCloseTo(-master.node.quaternion.z, 4);
  });

  it('does not fight recording playback (positionOverwrite)', () => {
    const { master, slave } = makeGearFixture();
    slave.positionOverwrite = true;
    slave.currentPosition = 12.5;
    master.currentPosition = 90;
    slave.update(1 / 60);
    // With positionOverwrite the gear must NOT overwrite the replayed position.
    expect(slave.currentPosition).toBe(12.5);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveDestinationMotor } from '../src/core/engine/rv-drive-destination-motor';
import {
  addSignal,
  attachDriveBehaviorByCode,
  type DriveBehaviorHostViewer,
} from '../src/core/engine/rv-signal-construction';

function fixture() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Turntable';
  root.userData.realvirtual = { LayoutObject: true };
  scene.add(root);
  const rotary = new Object3D();
  rotary.name = 'Drive-Rot-Y';
  rotary.userData.realvirtual = { Drive: { Direction: 'RotationY' } };
  root.add(rotary);
  const path = 'Turntable/Drive-Rot-Y';
  const registry = new NodeRegistry();
  registry.registerNode(path, rotary);
  const store = new SignalStore();
  const drive = new RVDrive(rotary);
  drive.Direction = DriveDirection.RotationY;
  drive.initDrive();
  registry.register('Drive', path, drive);
  const viewer: DriveBehaviorHostViewer = { scene, registry, signalStore: store };
  return { scene, root, rotary, path, registry, store, drive, viewer };
}

describe('Turntable rotary drive-model attach', () => {
  it('attaches and stamps the behavior without creating signals', () => {
    const f = fixture();
    const motor = attachDriveBehaviorByCode(f.viewer, f.rotary, 'Drive_DestinationMotor');
    expect(motor).toBeInstanceOf(RVDriveDestinationMotor);
    expect(f.registry.getByPath('Drive_DestinationMotor', f.path)).toBe(motor);
    expect(f.rotary.userData.realvirtual.Drive_DestinationMotor).toBeDefined();
    expect(f.root.children.find(child => child.name === 'Signals')).toBeUndefined();
    expect([...f.store.getAll().keys()]).toEqual([]);
  });

  it('uses only explicitly supplied wiring', () => {
    const f = fixture();
    const start = addSignal(f.rotary, 'Rot.StartDrive', 'PLCOutputBool', f.store, f.registry);
    const destination = addSignal(f.rotary, 'Rot.Destination', 'PLCOutputFloat', f.store, f.registry);
    const motor = attachDriveBehaviorByCode(f.viewer, f.rotary, 'Drive_DestinationMotor', {
      StartDrive: start,
      Destination: destination,
    })!;
    expect(motor.StartDrive).toBe(start.path);
    expect(motor.Destination).toBe(destination.path);
    expect(motor.IsDriving).toBeNull();
    expect(f.root.children.find(child => child.name === 'Signals')?.children).toHaveLength(2);
  });

  it('returns the same instance on repeated attachment', () => {
    const f = fixture();
    const first = attachDriveBehaviorByCode(f.viewer, f.rotary, 'Drive_DestinationMotor');
    const second = attachDriveBehaviorByCode(f.viewer, f.rotary, 'Drive_DestinationMotor');
    expect(second).toBe(first);
    expect(f.root.children.find(child => child.name === 'Signals')).toBeUndefined();
  });

  it('returns null without a registered Drive or construction services', () => {
    const f = fixture();
    const bare = new Object3D();
    bare.name = 'Bare';
    f.scene.add(bare);
    expect(attachDriveBehaviorByCode(f.viewer, bare, 'Drive_DestinationMotor')).toBeNull();
    expect(attachDriveBehaviorByCode(
      { scene: f.scene, registry: null, signalStore: null },
      f.rotary,
      'Drive_DestinationMotor',
    )).toBeNull();
  });
});

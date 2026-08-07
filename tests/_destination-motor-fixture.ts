// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared test fixture for RVDriveDestinationMotor (plan-232).
 *
 * Builds a Drive + the 8 standard signals + a wired RVDriveDestinationMotor so
 * the move / modulo / edge tests share one setup.
 */

import { Object3D, Scene } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveDestinationMotor } from '../src/core/engine/rv-drive-destination-motor';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

export interface MotorFixture {
  drive: RVDrive;
  motor: RVDriveDestinationMotor;
  store: SignalStore;
  registry: NodeRegistry;
  ctx: ComponentContext;
  node: Object3D;
}

export interface MotorFixtureOptions {
  scale?: number;
  offset?: number;
  scaleFeedback?: boolean;
  rotary?: boolean;
  startPosition?: number;
  /** Build the Drive but NOT register it, to exercise the "no Drive" path. */
  noDrive?: boolean;
}

export function makeMotorFixture(opts: MotorFixtureOptions = {}): MotorFixture {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const node = new Object3D();
  node.name = 'DriveNode';
  root.add(node);

  const path = NodeRegistry.computeNodePath(node);
  registry.registerNode(path, node);

  const drive = new RVDrive(node);
  drive.Direction = opts.rotary ? DriveDirection.RotationY : DriveDirection.LinearX;
  drive.TargetSpeed = 1000;
  drive.UseAcceleration = false;
  drive.StartPosition = opts.startPosition ?? 0;
  drive.initDrive();
  if (!opts.noDrive) registry.register('Drive', path, drive);

  store.register('DriveNode.Destination', `${path}/Signals/Destination`, 0, 'PLCOutputFloat');
  store.register('DriveNode.StartDrive', `${path}/Signals/StartDrive`, false, 'PLCOutputBool');
  store.register('DriveNode.TargetSpeed', `${path}/Signals/TargetSpeed`, 0, 'PLCOutputFloat');
  store.register('DriveNode.Acceleration', `${path}/Signals/Acceleration`, 0, 'PLCOutputFloat');
  store.register('DriveNode.IsAtPosition', `${path}/Signals/IsAtPosition`, 0, 'PLCInputFloat');
  store.register('DriveNode.IsAtSpeed', `${path}/Signals/IsAtSpeed`, 0, 'PLCInputFloat');
  store.register('DriveNode.IsAtDestination', `${path}/Signals/IsAtDestination`, false, 'PLCInputBool');
  store.register('DriveNode.IsDriving', `${path}/Signals/IsDriving`, false, 'PLCInputBool');
  store.buildIndex();

  // The motor refs hold the resolved signal ADDRESS = the registered store PATH
  // (what resolveComponentRefs produces in production: { signalAddress: path }).
  const motor = new RVDriveDestinationMotor(node);
  motor.Destination = `${path}/Signals/Destination`;
  motor.StartDrive = `${path}/Signals/StartDrive`;
  motor.TargetSpeed = `${path}/Signals/TargetSpeed`;
  motor.Acceleration = `${path}/Signals/Acceleration`;
  motor.IsAtPosition = `${path}/Signals/IsAtPosition`;
  motor.IsAtSpeed = `${path}/Signals/IsAtSpeed`;
  motor.IsAtDestination = `${path}/Signals/IsAtDestination`;
  motor.IsDriving = `${path}/Signals/IsDriving`;
  motor.CurrentPositionScale = opts.scale ?? 1;
  motor.CurrentPositionOffset = opts.offset ?? 0;
  motor.ScaleFeedbackPosition = opts.scaleFeedback ?? true;

  const ctx: ComponentContext = {
    registry,
    signalStore: store,
    scene,
    transportManager: new RVTransportManager(),
    root,
  };
  motor.init(ctx);

  return { drive, motor, store, registry, ctx, node };
}

export function tickDrive(drive: RVDrive, n: number, dt = 0.05): void {
  for (let i = 0; i < n; i++) drive.update(dt);
}

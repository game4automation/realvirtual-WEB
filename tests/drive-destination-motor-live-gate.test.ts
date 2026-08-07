// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-destination-motor-live-gate.test.ts — Plan 232, Phase 4 (Step D), §9.3.
 *
 * plan-226 binding + liveControlled + feedback active:
 *  - Destination bound to a CONNECT source → element goes liveControlled.
 *  - The relay drives the motor's Destination/StartDrive → the drive follows PLC.
 *  - Feedback (IsAtDestination …) is STILL written under live control (F6).
 *  - Source lost → hold (dt=1000ms) → drops to self-sim.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { clearLiveControl } from '../src/core/engine/rv-live-control';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveDestinationMotor } from '../src/core/engine/rv-drive-destination-motor';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

function build() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const scene = new Scene();
  const sceneRoot = new Object3D();
  scene.add(sceneRoot);

  // LayoutObject root = the drive node itself (scope = 'Turntable').
  const node = new Object3D();
  node.name = 'Turntable';
  node.userData.realvirtual = { LayoutObject: { Label: 'Turntable' }, Drive_DestinationMotor: {} };
  sceneRoot.add(node);
  const path = NodeRegistry.computeNodePath(node);  // 'Turntable'
  registry.registerNode(path, node);

  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.LinearX;
  drive.TargetSpeed = 1000;
  drive.initDrive();
  registry.register('Drive', path, drive);

  // 8 standard signals (name = 'Turntable.<slot>', path = '<path>/Signals/<slot>').
  const reg = (slot: string, type: string, seed: boolean | number) =>
    store.register(`Turntable.${slot}`, `${path}/Signals/${slot}`, seed, type);
  reg('Destination', 'PLCOutputFloat', 0);
  reg('StartDrive', 'PLCOutputBool', false);
  reg('TargetSpeed', 'PLCOutputFloat', 0);
  reg('Acceleration', 'PLCOutputFloat', 0);
  reg('IsAtPosition', 'PLCInputFloat', 0);
  reg('IsAtSpeed', 'PLCInputFloat', 0);
  reg('IsAtDestination', 'PLCInputBool', false);
  reg('IsDriving', 'PLCInputBool', false);
  store.buildIndex();

  const motor = new RVDriveDestinationMotor(node);
  for (const slot of ['Destination', 'StartDrive', 'TargetSpeed', 'Acceleration',
    'IsAtPosition', 'IsAtSpeed', 'IsAtDestination', 'IsDriving']) {
    (motor as unknown as Record<string, unknown>)[slot] = `${path}/Signals/${slot}`;
  }
  registry.register('Drive_DestinationMotor', path, motor);

  const ctx: ComponentContext = {
    registry, signalStore: store, scene,
    transportManager: new RVTransportManager(), root: sceneRoot,
  };
  motor.init(ctx);

  const mgr = new SignalBindingManager(store, registry);
  return { store, registry, node, drive, motor, mgr };
}

describe('Drive_DestinationMotor live gate (plan-232 Phase 4)', () => {
  beforeEach(() => clearLiveControl());

  it('binds Destination → liveControlled; relay drives motor; feedback still written', () => {
    const { store, node, drive, motor, mgr } = build();

    // CONNECT source signals.
    store.register('SrcDest', '__iface__/SrcDest', 30, 'PLCOutputFloat');
    store.register('SrcStart', '__iface__/SrcStart', false, 'PLCOutputBool');

    mgr.bind('tt', node, { slot: 'Destination', signal: 'SrcDest', direction: 'plcInput', enabled: true });
    mgr.bind('tt', node, { slot: 'StartDrive', signal: 'SrcStart', direction: 'plcInput', enabled: true });
    mgr.tick(1 / 60);

    expect(mgr.isLive('tt')).toBe(true);
    expect(motor.liveControlled).toBe(true);

    // Relay seeded Destination=30 into the motor → targetPosition followed.
    expect(store.getFloat('Turntable.Destination')).toBe(30);
    expect(drive.targetPosition).toBeCloseTo(30, 3);

    // Now the PLC raises StartDrive → relay writes it → drive starts.
    store.set('SrcStart', true);
    mgr.tick(1 / 60);
    expect(store.getBool('Turntable.StartDrive')).toBe(true);
    expect(drive.isRunning).toBe(true);

    // Feedback IS written even under live control (F6).
    for (let i = 0; i < 100; i++) drive.update(0.05);
    expect(drive.currentPosition).toBeCloseTo(30, 2);
    expect(store.getBool('Turntable.IsAtDestination')).toBe(true);
    expect(store.getFloat('Turntable.IsAtPosition')).toBeCloseTo(30, 1);
  });

  it('source lost → hold (dt=1000ms) → drops back to self-sim', () => {
    const { store, node, motor, mgr } = build();
    store.register('SrcDest', '__iface__/SrcDest', 30, 'PLCOutputFloat');
    mgr.bind('tt', node, { slot: 'Destination', signal: 'SrcDest', direction: 'plcInput', enabled: true });
    mgr.tick(1 / 60);
    expect(motor.liveControlled).toBe(true);

    // Source disappears — within hold it stays live.
    store.clear();  // wipe the store so the source is gone
    // Re-register only the slot targets so the gate can still flip them.
    // (clear() removed everything; the manager only needs the source absent.)
    mgr.tick(0.1);                 // 100ms < holdMs default (800ms) → still live
    expect(motor.liveControlled).toBe(true);

    mgr.tick(1.0);                 // 1000ms > hold → drops to self-sim
    expect(motor.liveControlled).toBe(false);
  });
});

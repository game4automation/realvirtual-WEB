// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * turntable-live-gate.test.ts — Plan 232, Phase 6 (Step E).
 *
 * The Turntable autonomous rotary path is silenced when its Drive-Rot-* drive is
 * live-controlled. The gate the Turntable uses is
 * `isSignalLiveControlled('<rotaryNodeName>.Destination')`. This test proves the
 * gate KEY convention matches what the SignalBindingManager registers when a
 * Drive_DestinationMotor's Destination slot is bound and live, so the Turntable's
 * guard actually fires.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { clearLiveControl, isSignalLiveControlled } from '../src/core/engine/rv-live-control';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveDestinationMotor } from '../src/core/engine/rv-drive-destination-motor';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

describe('Turntable live gate key convention (plan-232 Phase 6)', () => {
  beforeEach(() => clearLiveControl());

  it('binding the rotary Destination flips <rotaryNode>.Destination live-control', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const scene = new Scene();
    const sceneRoot = new Object3D();
    scene.add(sceneRoot);

    // The rotary drive node is the LayoutObject root (matches a Drive-Rot-* node
    // whose name becomes the signal prefix).
    const node = new Object3D();
    node.name = 'Drive-Rot-Y';
    node.userData.realvirtual = { LayoutObject: { Label: 'Drive-Rot-Y' }, Drive_DestinationMotor: {} };
    sceneRoot.add(node);
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);

    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.RotationY;
    drive.initDrive();
    registry.register('Drive', path, drive);

    const reg = (slot: string, type: string, seed: boolean | number) =>
      store.register(`Drive-Rot-Y.${slot}`, `${path}/Signals/${slot}`, seed, type);
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

    // Before binding: the gate is empty → the Turntable would run autonomously.
    expect(isSignalLiveControlled('Drive-Rot-Y.Destination')).toBe(false);

    const mgr = new SignalBindingManager(store, registry);
    store.register('SrcDest', '__iface__/SrcDest', 90, 'PLCOutputFloat');
    mgr.bind('tt', node, { slot: 'Destination', signal: 'SrcDest', direction: 'plcInput', enabled: true });
    mgr.tick(1 / 60);

    // After bind+tick: the EXACT key the Turntable guard checks is live.
    expect(isSignalLiveControlled('Drive-Rot-Y.Destination')).toBe(true);
    expect(motor.liveControlled).toBe(true);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveSimple } from '../src/core/engine/rv-drive-simple';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { makeMotorFixture } from './_destination-motor-fixture';

function simpleFixture() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'DriveNode';
  node.userData.realvirtual = { Drive: {}, Drive_Simple: {} };
  scene.add(node);
  const path = NodeRegistry.computeNodePath(node);
  registry.registerNode(path, node);
  const drive = new RVDrive(node);
  drive.TargetSpeed = 100;
  drive.initDrive();
  registry.register('Drive', path, drive);
  store.register('Drive.Forward', `${path}/Signals/Forward`, true, 'PLCOutputBool');
  store.register('Drive.Backward', `${path}/Signals/Backward`, false, 'PLCOutputBool');
  store.buildIndex();
  const adapter = new RVDriveSimple(node);
  adapter.Forward = `${path}/Signals/Forward`;
  adapter.Backward = `${path}/Signals/Backward`;
  registry.register('Drive_Simple', path, adapter);
  adapter.init({ registry, signalStore: store, scene, root: scene, transportManager: new RVTransportManager() });
  return { store, registry, node, drive };
}

describe('equal-value atomic live handover', () => {
  it('re-applies a level command after stop and does not synthesize an edge trigger', () => {
    const { store, registry, node, drive } = simpleFixture();
    const manager = new SignalBindingManager(store, registry);
    store.register('Source.Forward', '__iface__/Source.Forward', true, 'PLCOutputBool');
    expect(drive.jogForward).toBe(true);

    manager.bind('drive', node, {
      slot: 'Forward', signal: 'Source.Forward', interfaceId: 'connect',
      direction: 'plcOutput', enabled: true,
    });
    manager.tick(1 / 60);

    expect(drive.liveControlled).toBe(true);
    expect(drive.jogForward).toBe(true);

    // Public redispatch does not alter value/version and is safe to repeat.
    const version = store.version;
    expect(store.redispatch('Drive.Forward')).toBe(true);
    expect(store.version).toBe(version);
  });

  it('does not seed a true StartDrive edge while binding', () => {
    const { store, registry, node, drive, motor } = makeMotorFixture();
    node.userData.realvirtual = { Drive: {}, Drive_DestinationMotor: {} };
    registry.register('Drive_DestinationMotor', NodeRegistry.computeNodePath(node), motor);
    store.register('Source.Start', '__iface__/Source.Start', true, 'PLCOutputBool');
    const manager = new SignalBindingManager(store, registry);

    manager.bind('drive', node, {
      slot: 'StartDrive', signal: 'Source.Start', interfaceId: 'connect',
      direction: 'plcOutput', enabled: true,
    });
    manager.tick(1 / 60);

    expect(drive.isRunning).toBe(false);
    store.set('Source.Start', false);
    manager.tick(1 / 60);
    store.set('Source.Start', true);
    manager.tick(1 / 60);
    expect(drive.isRunning).toBe(true);
  });
});

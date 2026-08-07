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

describe('live handover force priority', () => {
  it('dispatches the forced target value before the live source value', () => {
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
    drive.initDrive();
    registry.register('Drive', path, drive);
    store.register('Drive.Forward', `${path}/Signals/Forward`, false, 'PLCOutputBool');
    store.buildIndex();
    const adapter = new RVDriveSimple(node);
    adapter.Forward = `${path}/Signals/Forward`;
    registry.register('Drive_Simple', path, adapter);
    adapter.init({ registry, signalStore: store, scene, root: scene, transportManager: new RVTransportManager() });
    store.register('Source.Forward', '__iface__/Source.Forward', true, 'PLCOutputBool');
    store.forceSignal('Drive.Forward', false);

    const manager = new SignalBindingManager(store, registry);
    manager.bind('drive', node, {
      slot: 'Forward', signal: 'Source.Forward', interfaceId: 'connect',
      direction: 'plcOutput', enabled: true,
    });
    manager.tick(1 / 60);

    expect(store.get('Drive.Forward')).toBe(false);
    expect(drive.jogForward).toBe(false);
  });
});

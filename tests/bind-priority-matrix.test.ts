// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import type { RVDrive } from '../src/core/engine/rv-drive';

describe('binding priority matrix', () => {
  it('orders remote ownership above force above live above internal value', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const node = new Object3D(); node.name = 'Drive'; node.userData.realvirtual = { Drive_Simple: {} }; new Scene().add(node);
    registry.registerNode('Drive', node);
    registry.register('Drive_Simple', 'Drive', { Forward: 'Drive/Forward', Backward: null, liveControlled: false });
    const drive = { isOwner: true, liveControlled: false, stop: vi.fn() } as unknown as RVDrive;
    registry.register('Drive', 'Drive', drive);
    store.register('Drive.Forward', 'Drive/Forward', false, 'PLCOutputBool');
    store.register('PLC.Forward', '__iface__/PLC.Forward', true, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Forward' }, true);
    const manager = new SignalBindingManager(store, registry);
    store.forceSignal('Drive.Forward', false);
    manager.bind('Drive', node, { slot: 'Forward', signal: 'PLC.Forward', interfaceId: 'plc', direction: 'plcOutput', enabled: true });
    manager.tick(0.02);
    expect(store.getBool('Drive.Forward')).toBe(false);

    store.unforce('Drive.Forward');
    manager.tick(0.02);
    expect(store.getBool('Drive.Forward')).toBe(true);

    drive.isOwner = false;
    store.set('Drive.Forward', false);
    manager.tick(0.02);
    expect(manager.isLive('Drive')).toBe(false);
    expect(store.getBool('Drive.Forward')).toBe(false);
  });
});

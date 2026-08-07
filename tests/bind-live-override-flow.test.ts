// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';

describe('live override flow', () => {
  it('relays, holds a real provider disconnect, falls back, and resumes on reconnect', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const node = new Object3D(); node.name = 'Conveyor'; node.userData.realvirtual = { Conveyor: {} }; new Scene().add(node);
    registry.registerNode('Conveyor', node);
    store.register('Flow.Run', 'Conveyor/Flow.Run', false);
    store.register('PLC.Run', '__iface__/PLC.Run', true, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Run' }, true);
    const manager = new SignalBindingManager(store, registry);
    manager.bind('Conveyor', node, { slot: 'Flow.Run', signal: 'PLC.Run', interfaceId: 'plc', direction: 'plcOutput', enabled: true });
    manager.tick(0.02);
    expect(store.getBool('Flow.Run')).toBe(true);

    store.setSignalProviderConnected({ interfaceId: 'plc' }, false);
    manager.tick(0.4);
    expect(manager.getBindingLiveness('Conveyor', 'Flow.Run')).toBe('hold');
    manager.tick(0.5);
    expect(store.getBool('Flow.Run')).toBe(false);
    expect(manager.isLive('Conveyor')).toBe(false);

    store.setSignalProviderConnected({ interfaceId: 'plc' }, true);
    manager.tick(0.02);
    expect(manager.isLive('Conveyor')).toBe(true);
    expect(store.getBool('Flow.Run')).toBe(true);
  });
});

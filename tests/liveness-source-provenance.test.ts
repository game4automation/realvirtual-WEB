// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';

describe('source provenance liveness', () => {
  it('does not borrow liveness from another connected interface of the same type', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const node = new Object3D();
    node.name = 'Conveyor';
    node.userData.realvirtual = { Conveyor: {} };
    registry.registerNode('Conveyor', node);
    store.register('Flow.Run', 'Conveyor/Flow.Run', false);
    store.register('LineA.Run', '__iface__/LineA.Run', true, 'PLCOutputBool');
    store.register('LineB.Other', '__iface__/LineB.Other', true, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'a', signal: 'LineA.Run' }, false);
    store.registerSignalProvider({ interfaceId: 'b', signal: 'LineB.Other' }, true);
    const manager = new SignalBindingManager(store, registry);
    manager.bind('Conveyor', node, { slot: 'Flow.Run', signal: 'LineA.Run', interfaceId: 'a', direction: 'plcOutput', enabled: true });

    manager.tick(0.02);

    expect(manager.getBindingLiveness('Conveyor', 'Flow.Run')).toBe('disconnected');
    expect(manager.isLive('Conveyor')).toBe(false);
    expect(store.getBool('Flow.Run')).toBe(false);
  });
});

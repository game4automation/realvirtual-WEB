// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';

describe('partial control unbind', () => {
  it('keeps the element live until its last control slot is unbound', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const node = new Object3D(); node.name = 'Drive'; node.userData.realvirtual = { Drive_Simple: {} }; new Scene().add(node);
    registry.registerNode('Drive', node);
    const adapter = { Forward: 'Drive/Forward', Backward: 'Drive/Backward', liveControlled: false };
    registry.register('Drive_Simple', 'Drive', adapter);
    store.register('Drive.Forward', 'Drive/Forward', false, 'PLCOutputBool');
    store.register('Drive.Backward', 'Drive/Backward', false, 'PLCOutputBool');
    store.register('PLC.Forward', '__iface__/PLC.Forward', true, 'PLCOutputBool');
    store.register('PLC.Backward', '__iface__/PLC.Backward', false, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Forward' }, true);
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Backward' }, true);
    const manager = new SignalBindingManager(store, registry);
    manager.bind('Drive', node, { slot: 'Forward', signal: 'PLC.Forward', interfaceId: 'plc', direction: 'plcOutput', enabled: true });
    manager.bind('Drive', node, { slot: 'Backward', signal: 'PLC.Backward', interfaceId: 'plc', direction: 'plcOutput', enabled: true });
    manager.tick(0.02);
    expect(adapter.liveControlled).toBe(true);

    manager.unbind('Drive', 'Forward');
    manager.tick(0.02);
    expect(manager.isLive('Drive')).toBe(true);
    expect(adapter.liveControlled).toBe(true);

    manager.unbind('Drive', 'Backward');
    manager.tick(0.02);
    expect(manager.isLive('Drive')).toBe(false);
    expect(adapter.liveControlled).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';

describe('legacy mapping direction compatibility', () => {
  it('routes from the resolved target role rather than the persisted direction field', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const node = new Object3D(); node.name = 'Drive'; node.userData.realvirtual = { Drive_Simple: {} }; new Scene().add(node);
    registry.registerNode('Drive', node);
    registry.register('Drive_Simple', 'Drive', { Forward: 'Drive/Forward', Backward: null, liveControlled: false });
    store.register('Drive.Forward', 'Drive/Forward', false, 'PLCOutputBool');
    store.register('PLC.Forward', '__iface__/PLC.Forward', true, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Forward' }, true);
    const manager = new SignalBindingManager(store, registry);
    manager.bind('Drive', node, {
      slot: 'Forward', signal: 'PLC.Forward', interfaceId: 'plc',
      direction: 'plcInput', enabled: true,
    });
    manager.tick(0.02);
    expect(manager.isLive('Drive')).toBe(true);
    expect(store.getBool('Drive.Forward')).toBe(true);
  });
});

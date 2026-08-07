// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';

describe('source and GLB signal name collision', () => {
  it('keeps the GLB registration and relays only into the resolved target signal', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const node = new Object3D(); node.name = 'Drive'; node.userData.realvirtual = { Drive_Simple: {} }; new Scene().add(node);
    registry.registerNode('Drive', node);
    registry.register('Drive_Simple', 'Drive', { Forward: 'Drive/Forward', Backward: null, liveControlled: false });
    store.register('Shared', 'Model/Signals/Shared', true, 'PLCOutputBool');
    store.register('Drive.Forward', 'Drive/Forward', false, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'Shared' }, true);
    const manager = new SignalBindingManager(store, registry);
    manager.bind('Drive', node, { slot: 'Forward', signal: 'Shared', interfaceId: 'plc', direction: 'plcOutput', enabled: true });
    manager.tick(0.02);

    expect(store.getPath('Shared')).toBe('Model/Signals/Shared');
    expect(store.getBool('Drive.Forward')).toBe(true);
  });
});

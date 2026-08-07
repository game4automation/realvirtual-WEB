// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';

describe('planner linking regression', () => {
  it('keeps legacy provider-less placement mappings operational', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const node = new Object3D(); node.name = 'Placed'; node.userData.realvirtual = { LayoutObject: {}, Conveyor: {} }; new Scene().add(node);
    registry.registerNode('Placed', node);
    store.register('Placed.Flow.Run', 'Placed/Flow.Run', false, 'PLCInputBool');
    store.register('Legacy.Run', '__iface__/Legacy.Run', true, 'PLCOutputBool');
    const manager = new SignalBindingManager(store, registry);
    manager.bind('placed-1', node, { slot: 'Flow.Run', signal: 'Legacy.Run', direction: 'plcInput', enabled: true });
    manager.tick(0.02);
    expect(manager.isLive('placed-1')).toBe(true);
    expect(store.getBool('Placed.Flow.Run')).toBe(true);
    expect(manager.getLinkedSourceNames()).toEqual(new Set(['Legacy.Run']));
  });
});

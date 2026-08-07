// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

function fixture(store: SignalStore) {
  const registry = new NodeRegistry();
  const node = new Object3D();
  node.name = 'Conveyor';
  node.userData.realvirtual = { Conveyor: {} };
  registry.registerNode('Conveyor', node);
  store.register('Flow.Run', 'Conveyor/Flow.Run', false);
  return { node, manager: new SignalBindingManager(store, registry) };
}

describe('legacy mapping provider migration', () => {
  it('resolves exactly one full provider key', () => {
    const store = new SignalStore();
    store.register('Run', '__iface__/Run', true, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'mqtt', topic: 'cell/a', signal: 'Run' }, true);
    const { node, manager } = fixture(store);
    const mapping: SignalMapping = { slot: 'Flow.Run', signal: 'Run', direction: 'plcInput', enabled: true };
    manager.bind('Conveyor', node, mapping);
    manager.tick(0.02);
    expect(mapping.interfaceId).toBe('mqtt');
    expect(mapping.topic).toBe('cell/a');
    expect(manager.getBindingLiveness('Conveyor', 'Flow.Run')).toBe('live');
  });

  it('keeps an undiscovered mapping pending', () => {
    const store = new SignalStore();
    store.setSignalProviderConnected({ interfaceId: 'other' }, true);
    const { node, manager } = fixture(store);
    manager.bind('Conveyor', node, { slot: 'Flow.Run', signal: 'Missing', direction: 'plcInput', enabled: true });
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conveyor', 'Flow.Run')).toBe('pending');
  });

  it('marks two topics of one interface as a provider conflict', () => {
    const store = new SignalStore();
    store.register('Run', '__iface__/Run', true, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'mqtt', topic: 'cell/a', signal: 'Run' }, true);
    store.registerSignalProvider({ interfaceId: 'mqtt', topic: 'cell/b', signal: 'Run' }, true);
    const { node, manager } = fixture(store);
    manager.bind('Conveyor', node, { slot: 'Flow.Run', signal: 'Run', direction: 'plcInput', enabled: true });
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conveyor', 'Flow.Run')).toBe('conflict');
    expect(manager.getElementState('Conveyor')).toBe('conflict');
  });
});

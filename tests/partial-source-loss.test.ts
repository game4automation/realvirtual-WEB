// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';

function fixture() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const node = new Object3D();
  node.name = 'Axis';
  node.userData.realvirtual = { Drive_DestinationMotor: {} };
  new Scene().add(node);
  const path = NodeRegistry.computeNodePath(node);
  registry.registerNode(path, node);
  const motor = {
    Destination: 'Axis/Destination', StartDrive: null,
    TargetSpeed: 'Axis/TargetSpeed', Acceleration: null,
    IsAtPosition: null, IsAtSpeed: null, IsAtDestination: null, IsDriving: null,
    liveControlled: false,
  };
  registry.register('Drive_DestinationMotor', path, motor);
  store.register('Axis.Destination', 'Axis/Destination', 0, 'PLCOutputFloat');
  store.register('Axis.TargetSpeed', 'Axis/TargetSpeed', 0, 'PLCOutputFloat');
  store.register('A.Destination', '__iface__/A.Destination', 25, 'PLCOutputFloat');
  store.register('B.Speed', '__iface__/B.Speed', 8, 'PLCOutputFloat');
  store.registerSignalProvider({ interfaceId: 'a', signal: 'A.Destination' }, true);
  store.registerSignalProvider({ interfaceId: 'b', signal: 'B.Speed' }, true);
  const manager = new SignalBindingManager(store, registry);
  manager.bind('axis', node, { slot: 'Destination', signal: 'A.Destination', interfaceId: 'a', direction: 'plcInput', enabled: true });
  manager.bind('axis', node, { slot: 'TargetSpeed', signal: 'B.Speed', interfaceId: 'b', direction: 'plcInput', enabled: true });
  return { store, manager, motor };
}

describe('provider-specific partial source loss', () => {
  it('holds and then neutralises only the dead slot while the element stays live', () => {
    const { store, manager, motor } = fixture();
    manager.tick(0.02);
    expect(manager.getBindingLiveness('axis', 'Destination')).toBe('live');
    expect(store.getFloat('Axis.Destination')).toBe(25);
    expect(store.getFloat('Axis.TargetSpeed')).toBe(8);

    store.setSignalProviderConnected({ interfaceId: 'a' }, false);
    manager.tick(0.4);
    expect(manager.getBindingLiveness('axis', 'Destination')).toBe('hold');
    expect(motor.liveControlled).toBe(true);
    manager.tick(0.5);

    expect(manager.getBindingLiveness('axis', 'Destination')).toBe('disconnected');
    expect(store.getFloat('Axis.Destination')).toBe(0);
    expect(store.getFloat('Axis.TargetSpeed')).toBe(8);
    expect(motor.liveControlled).toBe(true);
  });
});

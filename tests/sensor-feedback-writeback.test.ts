// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';

function fixture(name = 'SensorA') {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const node = new Object3D();
  node.name = name;
  node.userData.realvirtual = { Sensor: {} };
  new Scene().add(node);
  registry.registerNode(name, node);
  const sensor = new RVSensor(node, new AABB());
  registry.register('Sensor', name, sensor);
  return { store, registry, node, sensor };
}

describe('sensor direct feedback writeback', () => {
  it('registers no model signal and samples the current value immediately', () => {
    const f = fixture();
    f.store.register('PLC.Sensor', '__iface__/PLC.Sensor', true, 'PLCInputBool');
    f.store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Sensor' }, true);
    const manager = new SignalBindingManager(f.store, f.registry);
    manager.bind('SensorA', f.node, {
      kind: 'direct-feedback',
      componentPath: '.',
      slot: 'SensorOccupied',
      signal: 'PLC.Sensor',
      interfaceId: 'plc',
      direction: 'plcInput',
      enabled: true,
    });
    manager.tick(0.02);

    expect([...f.store.getAll().keys()].sort()).toEqual(['PLC.Sensor']);
    expect(f.store.getBool('PLC.Sensor')).toBe(false);
    expect(manager.getBindingLiveness('SensorA', 'SensorOccupied', '.')).toBe('live');
    expect(manager.isLive('SensorA')).toBe(false);
  });

  it('writes changes while preserving onChanged and additive listeners', () => {
    const f = fixture();
    const onChanged = vi.fn();
    const listener = vi.fn();
    f.sensor.onChanged = onChanged;
    f.sensor.addFeedbackListener(listener);
    f.store.register('PLC.Sensor', '__iface__/PLC.Sensor', false, 'PLCInputBool');
    f.store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Sensor' }, true);
    const manager = new SignalBindingManager(f.store, f.registry);
    manager.bind('SensorA', f.node, {
      kind: 'direct-feedback',
      componentPath: '.',
      slot: 'SensorOccupied',
      signal: 'PLC.Sensor',
      interfaceId: 'plc',
      direction: 'plcInput',
      enabled: true,
    });

    const mu = { getName: () => 'MU' };
    f.sensor.applyPhysicsResult(mu as never);
    expect(f.store.getBool('PLC.Sensor')).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

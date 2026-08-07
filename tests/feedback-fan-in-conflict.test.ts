// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';

describe('direct feedback fan-in', () => {
  it('allows exactly one writer for a full provider signal key', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const scene = new Scene();
    const sensors: Array<{ node: Object3D; sensor: RVSensor }> = [];
    for (const name of ['SensorA', 'SensorB']) {
      const node = new Object3D();
      node.name = name;
      node.userData.realvirtual = { Sensor: {} };
      scene.add(node);
      registry.registerNode(name, node);
      const sensor = new RVSensor(node, new AABB());
      registry.register('Sensor', name, sensor);
      sensors.push({ node, sensor });
    }
    store.register('PLC.Sensor', '__iface__/PLC.Sensor', false, 'PLCInputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Sensor' }, true);
    const manager = new SignalBindingManager(store, registry);
    for (const { node } of sensors) {
      manager.bind(node.name, node, {
        kind: 'direct-feedback',
        componentPath: '.',
        slot: 'SensorOccupied',
        signal: 'PLC.Sensor',
        interfaceId: 'plc',
        direction: 'plcInput',
        enabled: true,
      });
    }
    manager.tick(0.02);

    expect(manager.getBindingLiveness('SensorA', 'SensorOccupied', '.')).toBe('live');
    expect(manager.getBindingLiveness('SensorB', 'SensorOccupied', '.')).toBe('conflict');
    sensors[1].sensor.applyPhysicsResult({ getName: () => 'B' } as never);
    expect(store.getBool('PLC.Sensor')).toBe(false);
    sensors[0].sensor.applyPhysicsResult({ getName: () => 'A' } as never);
    expect(store.getBool('PLC.Sensor')).toBe(true);
  });
});

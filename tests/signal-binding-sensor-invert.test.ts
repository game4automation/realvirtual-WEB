// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { resolveBindableSlots } from '../src/core/engine/rv-binding-slot-resolver';

describe('signal-free sensor slots', () => {
  it('exposes occupied and inverted occupied as direct feedback without store entries', () => {
    const node = new Object3D();
    node.name = 'Sensor';
    node.userData.realvirtual = { Sensor: {} };
    const registry = new NodeRegistry();
    registry.registerNode('Sensor', node);
    const sensor = new RVSensor(node, new AABB());
    registry.register('Sensor', 'Sensor', sensor);
    const store = new SignalStore();

    expect(resolveBindableSlots(node, store, registry)).toMatchObject([
      { kind: 'direct-feedback', slot: 'SensorOccupied' },
      { kind: 'direct-feedback', slot: 'SensorNotOccupied' },
    ]);
    expect(sensor.readFeedbackSlot('SensorOccupied')).toBe(false);
    expect(sensor.readFeedbackSlot('SensorNotOccupied')).toBe(true);
    sensor.applyPhysicsResult({ getName: () => 'MU' } as never);
    expect(sensor.readFeedbackSlot('SensorOccupied')).toBe(true);
    expect(sensor.readFeedbackSlot('SensorNotOccupied')).toBe(false);
    expect([...store.getAll().keys()]).toEqual([]);
  });
});

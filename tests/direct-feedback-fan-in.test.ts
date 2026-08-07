// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.2 direct-feedback-fan-in — two slots on ONE channel.
 *
 * Two sensors bind their direct-feedback slot to the same CONNECT signal:
 *  - the authority service records TWO slot entries with the SAME channel
 *    (fan-out explicit via the bidirectional index),
 *  - the channel-level feedback-writer claim of the binding manager still
 *    admits exactly one writer (second binding → conflict),
 *  - no double dispatch: only the winning sensor's feedback reaches the store.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import {
  channelForSlot,
  getSlotAuthority,
  makeSignalChannelId,
  resetSlotAuthority,
  slotsForChannel,
} from '../src/core/engine/rv-slot-authority';

afterEach(() => resetSlotAuthority());

describe('direct feedback fan-in (9.2)', () => {
  it('indexes two authority slots on one channel and keeps the single-writer claim', () => {
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

    // Fan-out explicit: two hoheits entries, same channel.
    const slotA = manager.getSlotId('SensorA', 'SensorOccupied', '.');
    const slotB = manager.getSlotId('SensorB', 'SensorOccupied', '.');
    expect(slotA).toBeDefined();
    expect(slotB).toBeDefined();
    expect(slotA).not.toBe(slotB);
    const channel = makeSignalChannelId('PLC.Sensor');
    expect(channelForSlot(slotA!)).toBe(channel);
    expect(channelForSlot(slotB!)).toBe(channel);
    expect([...slotsForChannel(channel)]).toEqual([slotA, slotB]);

    // Channel-level single-writer claim keeps working on top.
    expect(manager.getBindingLiveness('SensorA', 'SensorOccupied', '.')).toBe('live');
    expect(manager.getBindingLiveness('SensorB', 'SensorOccupied', '.')).toBe('conflict');
    expect(getSlotAuthority(slotA!)).toBe('bound');
    expect(getSlotAuthority(slotB!)).toBe('component'); // conflict binding never claims

    // No double dispatch: the losing sensor's feedback never writes the channel.
    let notifications = 0;
    store.subscribe('PLC.Sensor', () => { notifications += 1; });
    sensors[1].sensor.applyPhysicsResult({ getName: () => 'B' } as never);
    expect(notifications).toBe(0);
    expect(store.getBool('PLC.Sensor')).toBe(false);
    sensors[0].sensor.applyPhysicsResult({ getName: () => 'A' } as never);
    expect(notifications).toBe(1);
    expect(store.getBool('PLC.Sensor')).toBe(true);
  });
});

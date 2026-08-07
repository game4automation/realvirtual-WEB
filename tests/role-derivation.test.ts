// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';

describe('three-stage slot role derivation', () => {
  it('uses registered type, then schema descriptor, and fails closed when unknown', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const scene = new Scene();
    store.register('Control.Source', '__iface__/Control.Source', true, 'PLCOutputBool');
    store.register('Feedback.Source', '__iface__/Feedback.Source', false, 'PLCInputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'Control.Source' }, true);
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'Feedback.Source' }, true);

    // Stage 1 — registered store TYPE wins: the sensor's SensorOccupied schema
    // slot is wired to a GLB signal registered as PLCOutputBool → 'control'.
    // (plan-317: the synthetic IsOccupied descriptor is gone; SensorOccupied is
    // a regular schema slot with a signal: marker.)
    const registered = new Object3D(); registered.name = 'Registered'; registered.userData.realvirtual = { Sensor: {} }; scene.add(registered);
    registry.registerNode('Registered', registered);
    registry.register('Sensor', 'Registered', { SensorOccupied: 'Registered', liveControlled: false });
    store.register('Registered', 'Registered', false, 'PLCOutputBool');

    // Stage 2 — no registered type, schema-descriptor fallback: a synthetic
    // Conveyor Flow.* slot (descriptorRoleFallback) derives 'feedback' from the
    // descriptor direction.
    const synthetic = new Object3D(); synthetic.name = 'Synthetic'; synthetic.userData.realvirtual = { Conveyor: {} }; scene.add(synthetic);
    registry.registerNode('Synthetic', synthetic);
    store.register('Flow.Occupied', 'Synthetic/Flow.Occupied', false);

    // Stage 3 — no registered type, no descriptor fallback → fail closed.
    const unknown = new Object3D(); unknown.name = 'Unknown'; unknown.userData.realvirtual = { Drive_Simple: {} }; scene.add(unknown);
    registry.registerNode('Unknown', unknown);
    registry.register('Drive_Simple', 'Unknown', { Forward: 'Unknown/Forward', Backward: null, liveControlled: false });
    store.register('Unknown.Forward', 'Unknown/Forward', false);

    const manager = new SignalBindingManager(store, registry);
    manager.bind('Registered', registered, { slot: 'SensorOccupied', signal: 'Control.Source', interfaceId: 'plc', direction: 'plcInput', enabled: true });
    manager.bind('Synthetic', synthetic, { slot: 'Flow.Occupied', signal: 'Feedback.Source', interfaceId: 'plc', direction: 'plcOutput', enabled: true });
    manager.bind('Unknown', unknown, { slot: 'Forward', signal: 'Control.Source', interfaceId: 'plc', direction: 'plcOutput', enabled: true });
    manager.tick(0.02);

    expect(manager.isLive('Registered')).toBe(true);
    expect(manager.isLive('Synthetic')).toBe(false);
    store.set('Flow.Occupied', true);
    expect(store.getBool('Feedback.Source')).toBe(true);
    expect(manager.getBindingLiveness('Unknown', 'Forward')).toBe('conflict');
  });
});

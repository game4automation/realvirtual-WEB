// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import {
  createBindContext,
  iterateFixedUpdate,
  type BindContextHost,
  type KinematicsSpec,
} from '../src/core/behavior-runtime';
import PickPlaceStationExample from '../src/behaviors/PickPlaceStationExample';
import { createSelf } from '../src/core/material-flow/material-flow-self';

describe('sensor without a model signal', () => {
  it('uses the SDK object state and preserves both callback APIs without registration', () => {
    const node = new Object3D();
    node.name = 'Photoeye';
    const store = new SignalStore();
    const sensor = new RVSensor(node, new AABB());
    const onChanged = vi.fn();
    const listener = vi.fn();
    sensor.onChanged = onChanged;
    sensor.addFeedbackListener(listener);

    sensor.applyPhysicsResult({ getName: () => 'MU' } as never);

    expect(sensor.occupied).toBe(true);
    expect(sensor.readFeedbackSlot('SensorOccupied')).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it('PickPlace consumes component events and never creates a sensor-named signal', () => {
    const root = new Object3D();
    root.name = 'PickPlaceStation';
    for (const name of [
      'Axis1_LinearSled',
      'Tool_GripperHead',
      'Belt_Infeed_Mesh',
      'Belt_Outfeed_Mesh',
      'Photoeye_42',
      'Connector_InletEnd',
      'Connector_OutletEnd',
    ]) {
      const node = new Object3D();
      node.name = name;
      root.add(node);
    }
    const events = new EventEmitter<Record<string, unknown>>();
    const values = new Map<string, boolean | number>();
    const subscriptions = new Map<string, Set<(value: boolean | number) => void>>();
    const movedTo: number[] = [];
    const drives = ['Axis1_LinearSled', 'Tool_GripperHead'].map((name) => ({
      name,
      node: root.getObjectByName(name)!,
      TargetSpeed: 100,
      jogForward: false,
      jogBackward: false,
      startMove(destination?: number) { if (destination !== undefined) movedTo.push(destination); },
      stop() {},
      moveTo(destination: number) { movedTo.push(destination); },
      jog(forward: boolean) { this.jogForward = forward; },
    }));
    const host: BindContextHost = {
      signalStore: {
        get: (name) => values.get(name),
        set: (name, value) => {
          values.set(name, value);
          subscriptions.get(name)?.forEach((cb) => cb(value));
        },
        subscribe: (name, cb) => {
          let listeners = subscriptions.get(name);
          if (!listeners) { listeners = new Set(); subscriptions.set(name, listeners); }
          listeners.add(cb);
          return () => listeners!.delete(cb);
        },
      },
      on: (event, cb) => events.on(event, cb as never),
      contextMenu: new ContextMenuStore(),
      drives,
      registry: null,
    };
    const spec: KinematicsSpec = {};
    const { ctx, handle } = createBindContext(root, host, spec);
    PickPlaceStationExample.bind(ctx);

    expect(spec.signals?.map((signal) => signal.name).sort())
      .toEqual(['Axis1.Forward', 'Axis1.Position']);
    expect(values.has('Photoeye_42')).toBe(false);
    expect(values.has('Photoeye_42.Occupied')).toBe(false);

    events.emit('component-event', {
      componentType: 'sensor',
      kind: 'changed',
      path: 'Photoeye_42',
      payload: { occupied: true, mu: { id: 1 } },
    });
    for (let i = 0; i < 31; i++) iterateFixedUpdate(handle, 1 / 60);
    expect(movedTo).toContain(250);
  });

  it('material-flow sensor subscriptions use the object listener and auto-dispose', () => {
    const root = new Object3D();
    root.name = 'FlowUnit';
    const sensorNode = new Object3D();
    sensorNode.name = 'Sensor';
    root.add(sensorNode);
    const sensor = new RVSensor(sensorNode, new AABB());
    const store = new SignalStore();
    const events = new EventEmitter<Record<string, unknown>>();
    const host = {
      signalStore: store,
      on: (event: string, cb: (...args: unknown[]) => void) => events.on(event, cb as never),
      contextMenu: new ContextMenuStore(),
      drives: [],
      registry: null,
      transportManager: { sensors: [sensor] },
    } as unknown as BindContextHost;
    const { ctx, handle } = createBindContext(root, host, {});
    const self = createSelf(ctx, { type: 'FlowUnit', kind: 'station' });
    const changed = vi.fn();
    self.onSensorChanged(sensorNode, changed);

    sensor.applyPhysicsResult({ getName: () => 'MU' } as never);
    expect(changed).toHaveBeenCalledWith(true);
    expect(store.size).toBe(0);

    handle.dispose();
    sensor.applyPhysicsResult(null);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

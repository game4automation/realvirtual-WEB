// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { constructDrive } from '../src/core/engine/rv-signal-construction';
import {
  resolveComponentRefs,
  type ComponentContext,
  type RVComponent,
} from '../src/core/engine/rv-component-registry';
import type { RVDrive } from '../src/core/engine/rv-drive';
import type { FeedbackSource } from '../src/core/engine/rv-binding-slot-resolver';

type FeedbackDriveBehavior =
  | 'Drive_Simple'
  | 'Drive_Cylinder'
  | 'Drive_DestinationMotor'
  | 'Drive_Speed'
  | 'Drive_FollowPosition'
  | 'Drive_PositionSwitch';

interface Fixture {
  node: Object3D;
  store: SignalStore;
  manager: SignalBindingManager;
  drive: RVDrive;
  component: RVComponent & FeedbackSource & Record<string, unknown>;
}

function fixture(
  type: FeedbackDriveBehavior,
  extras: Record<string, unknown> = {},
): Fixture {
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Axis';
  scene.add(node);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Axis', node);
  const rv = { Drive: { Direction: 'LinearX' }, [type]: extras };
  node.userData.realvirtual = rv;
  const result = constructDrive(node, rv, rv.Drive, 'Axis', registry, store);
  if (!result || result.pendingBehaviors.length !== 1) throw new Error(`Could not construct ${type}`);
  const pending = result.pendingBehaviors[0];
  registry.register(pending.type, pending.path, pending.component);
  resolveComponentRefs(pending.component as unknown as Record<string, unknown>, registry);
  pending.component.init({ registry, signalStore: store, scene, root: node } as ComponentContext);
  return {
    node,
    store,
    manager: new SignalBindingManager(store, registry),
    drive: result.drive,
    component: pending.component as RVComponent & FeedbackSource & Record<string, unknown>,
  };
}

function bindFeedback(f: Fixture, slot: string, type: 'Bool' | 'Float'): void {
  f.store.register('PLC.Feedback', '__iface__/PLC.Feedback', type === 'Bool', `PLCInput${type}`);
  f.store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Feedback' }, true);
  f.manager.bind('axis', f.node, {
    kind: 'direct-feedback',
    componentPath: '.',
    slot,
    signal: 'PLC.Feedback',
    interfaceId: 'plc',
    direction: 'plcInput',
    enabled: true,
  });
  f.manager.tick(1 / 60);
}

describe('DirectFeedbackSlot binding', () => {
  it.each([
    ['Drive_Simple', 'IsAtPosition', 'Float', 12],
    ['Drive_Cylinder', 'IsOut', 'Bool', 100],
    ['Drive_DestinationMotor', 'IsAtPosition', 'Float', 12],
    ['Drive_Speed', 'SignalCurrentPosition', 'Float', 12],
    ['Drive_FollowPosition', 'CurrentPosition', 'Float', 12],
    ['Drive_PositionSwitch', 'OutputSignal', 'Bool', 12],
  ] as const)(
    'samples a stopped %s immediately, sends changes, suppresses duplicates and cleans up',
    (type, slot, plcType, changedPosition) => {
      const extras = type === 'Drive_PositionSwitch'
        ? { Areas: [{ StartPosition: 10, EndPosition: 20 }] }
        : {};
      const f = fixture(type, extras);
      const set = vi.spyOn(f.store, 'set');
      bindFeedback(f, slot, plcType);
      const initial = f.component.readFeedbackSlot(slot);
      expect(f.store.get('PLC.Feedback')).toBe(initial);
      const callsAfterInitial = set.mock.calls.length;

      f.drive.reset();
      expect(set.mock.calls.length).toBe(callsAfterInitial);

      f.drive.StartPosition = changedPosition;
      f.drive.reset();
      expect(f.store.get('PLC.Feedback')).toBe(f.component.readFeedbackSlot(slot));
      expect(set.mock.calls.length).toBe(callsAfterInitial + 1);

      f.manager.unbind('axis', slot, '.');
      f.drive.StartPosition = changedPosition + 1;
      f.drive.reset();
      expect(set.mock.calls.length).toBe(callsAfterInitial + 1);
    },
  );

  it('dispatches FollowPosition changes while drive.isRunning remains false', () => {
    const f = fixture('Drive_FollowPosition');
    bindFeedback(f, 'CurrentPosition', 'Float');
    const component = f.component as unknown as {
      commandPosition(value: number): void;
    };

    component.commandPosition(42);
    f.drive.update(1 / 60);

    expect(f.drive.currentPosition).toBe(42);
    expect(f.drive.isRunning).toBe(false);
    expect(f.store.getFloat('PLC.Feedback')).toBe(42);
  });

  it('resamples a stopped drive on pending-to-live, reconnect and remote-to-local transitions', () => {
    const f = fixture('Drive_Simple');
    f.store.register('PLC.Feedback', '__iface__/PLC.Feedback', 999, 'PLCInputFloat');
    f.manager.bind('axis', f.node, {
      kind: 'direct-feedback',
      componentPath: '.',
      slot: 'IsAtPosition',
      signal: 'PLC.Feedback',
      interfaceId: 'plc',
      direction: 'plcInput',
      enabled: true,
    });
    f.manager.tick(1 / 60);
    expect(f.manager.getBindingLiveness('axis', 'IsAtPosition', '.')).toBe('pending');
    expect(f.store.getFloat('PLC.Feedback')).toBe(999);

    f.drive.currentPosition = 10;
    f.store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Feedback' }, true);
    f.manager.tick(1 / 60);
    expect(f.store.getFloat('PLC.Feedback')).toBe(10);

    f.store.setSignalProviderConnected({ interfaceId: 'plc' }, false);
    f.manager.tick(1);
    f.drive.currentPosition = 20;
    f.manager.tick(1 / 60);
    expect(f.store.getFloat('PLC.Feedback')).toBe(10);
    f.store.setSignalProviderConnected({ interfaceId: 'plc' }, true);
    f.manager.tick(1 / 60);
    expect(f.store.getFloat('PLC.Feedback')).toBe(20);

    f.drive.isOwner = false;
    f.manager.tick(1 / 60);
    f.drive.currentPosition = 30;
    f.drive.reset();
    f.drive.currentPosition = 30;
    expect(f.store.getFloat('PLC.Feedback')).toBe(20);
    f.drive.isOwner = true;
    f.manager.tick(1 / 60);
    expect(f.store.getFloat('PLC.Feedback')).toBe(30);

    f.manager.dispose();
    f.drive.StartPosition = 40;
    f.drive.reset();
    expect(f.store.getFloat('PLC.Feedback')).toBe(30);
  });
});

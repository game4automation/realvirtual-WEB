// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
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
import type { RVDriveSpeed } from '../src/core/engine/rv-drive-speed';
import type { RVDriveFollowPosition } from '../src/core/engine/rv-drive-follow-position';
import { resolveBindableSlots } from '../src/core/engine/rv-binding-slot-resolver';

interface Fixture<T extends RVComponent> {
  node: Object3D;
  registry: NodeRegistry;
  store: SignalStore;
  drive: RVDrive;
  component: T;
}

function fixture<T extends RVComponent>(
  type: 'Drive_Speed' | 'Drive_FollowPosition',
  extras: Record<string, unknown>,
): Fixture<T> {
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Axis';
  scene.add(node);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Axis', node);
  const rv = { Drive: { Direction: 'LinearX' }, [type]: extras };
  node.userData.realvirtual = rv;
  const result = constructDrive(node, rv, rv.Drive, 'Axis', registry, store)!;
  const pending = result.pendingBehaviors[0];
  registry.register(pending.type, pending.path, pending.component);
  resolveComponentRefs(pending.component as unknown as Record<string, unknown>, registry);
  pending.component.init({ registry, signalStore: store, scene, root: node } as ComponentContext);
  return { node, registry, store, drive: result.drive, component: pending.component as T };
}

describe('direct command contracts', () => {
  it('Drive_Speed applies held commands and restores the authored baseline', () => {
    const f = fixture<RVDriveSpeed>('Drive_Speed', {
      TargetSpeed: 120,
      Acceleration: 30,
    });

    f.component.commandSignalTargetSpeed(-240);
    f.component.commandSignalAcceleration(60);
    f.drive.update(1 / 60);
    expect(f.drive.targetSpeed).toBe(240);
    expect(f.drive.jogBackward).toBe(true);
    expect(f.drive.Acceleration).toBe(60);

    f.component.neutralizeSignalTargetSpeed();
    f.component.neutralizeSignalAcceleration();
    f.drive.update(1 / 60);
    expect(f.drive.targetSpeed).toBe(120);
    expect(f.drive.jogForward).toBe(true);
    expect(f.drive.Acceleration).toBe(30);
  });

  it('Drive_Speed provider loss neutralizes both properties to authored values', () => {
    const f = fixture<RVDriveSpeed>('Drive_Speed', {
      TargetSpeed: 100,
      Acceleration: 20,
    });
    f.store.register('PLC.Speed', '__iface__/PLC.Speed', 250, 'PLCOutputFloat');
    f.store.register('PLC.Accel', '__iface__/PLC.Accel', 55, 'PLCOutputFloat');
    f.store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Speed' }, true);
    f.store.registerSignalProvider({ interfaceId: 'plc', signal: 'PLC.Accel' }, true);
    const manager = new SignalBindingManager(f.store, f.registry);
    manager.applyMappings('axis', f.node, [
      {
        kind: 'direct-property',
        componentPath: '.',
        slot: 'SignalTargetSpeed',
        signal: 'PLC.Speed',
        interfaceId: 'plc',
        direction: 'plcOutput',
        enabled: true,
      },
      {
        kind: 'direct-property',
        componentPath: '.',
        slot: 'SignalAcceleration',
        signal: 'PLC.Accel',
        interfaceId: 'plc',
        direction: 'plcOutput',
        enabled: true,
      },
    ]);
    manager.tick(1 / 60);
    f.drive.update(1 / 60);
    expect(f.drive.targetSpeed).toBe(250);
    expect(f.drive.Acceleration).toBe(55);

    f.store.setSignalProviderConnected({ interfaceId: 'plc' }, false);
    manager.tick(0.81);
    f.drive.update(1 / 60);
    expect(f.drive.targetSpeed).toBe(100);
    expect(f.drive.Acceleration).toBe(20);
  });

  it('Drive_FollowPosition moves on the next tick and neutralize holds position', () => {
    const f = fixture<RVDriveFollowPosition>('Drive_FollowPosition', {
      Scale: 2,
      Offset: 5,
    });

    f.component.commandPosition(20);
    expect(f.drive.currentPosition).toBe(0);
    f.drive.update(1 / 60);
    expect(f.drive.currentPosition).toBe(45);
    expect(f.drive.currentSpeed).toBeGreaterThan(0);
    expect(f.drive.isRunning).toBe(false);

    f.component.neutralizePosition();
    f.drive.currentPosition = 55;
    f.drive.update(1 / 60);
    expect(f.drive.currentPosition).toBe(55);
    expect(f.drive.currentSpeed).toBe(0);
  });

  it('resolver exposes all three reconstructed command slots as direct-property', () => {
    const speed = fixture<RVDriveSpeed>('Drive_Speed', {});
    expect(resolveBindableSlots(speed.node, speed.store, speed.registry)
      .filter((slot) => slot.kind === 'direct-property')
      .map((slot) => slot.slot)
      .sort()).toEqual(['SignalAcceleration', 'SignalTargetSpeed']);

    const follow = fixture<RVDriveFollowPosition>('Drive_FollowPosition', {});
    expect(resolveBindableSlots(follow.node, follow.store, follow.registry)
      .filter((slot) => slot.kind === 'direct-property')
      .map((slot) => slot.slot)).toEqual(['Position']);
  });
});

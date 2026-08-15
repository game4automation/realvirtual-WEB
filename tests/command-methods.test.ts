// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  constructDrive,
  DRIVE_BEHAVIOR_MAP,
} from '../src/core/engine/rv-signal-construction';
import {
  resolveComponentRefs,
  type ComponentContext,
  type RVComponent,
} from '../src/core/engine/rv-component-registry';
import {
  bindingSlotRvKeys,
  resolveBindableSlots,
} from '../src/core/engine/rv-binding-slot-resolver';
import type { RVDrive } from '../src/core/engine/rv-drive';

function buildBehavior(type: 'Drive_Simple' | 'Drive_Cylinder' | 'Drive_DestinationMotor', extras: Record<string, unknown> = {}) {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const node = new Object3D();
  node.name = 'Axis';
  root.add(node);
  const rv = { Drive: { Direction: 'LinearX' }, [type]: extras };
  node.userData.realvirtual = rv;
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Root/Axis', node);
  const result = constructDrive(node, rv, rv.Drive, 'Root/Axis', registry, store)!;
  store.buildIndex();
  const entry = result.pendingBehaviors[0];
  resolveComponentRefs(entry.component as unknown as Record<string, unknown>, registry);
  registry.register(entry.type, entry.path, entry.component);
  entry.component.init({ registry, signalStore: store, scene, root } as ComponentContext);
  return {
    root,
    registry,
    store,
    component: entry.component as RVComponent & Record<string, unknown>,
    drive: result.drive,
  };
}

describe('component command methods', () => {
  it('covers every schema control slot of the v1 direct drive set in both directions', () => {
    const v1Types = bindingSlotRvKeys().filter((key) => key in DRIVE_BEHAVIOR_MAP);
    for (const type of v1Types) {
      const behavior = DRIVE_BEHAVIOR_MAP[type];
      const instance = new behavior.ctor(new Object3D()) as RVComponent & Record<string, unknown>;
      const controlSlots = Object.entries(behavior.schema)
        .filter(([, descriptor]) => descriptor.signal?.startsWith('PLCOutput'))
        .map(([slot]) => slot);
      for (const slot of controlSlots) {
        expect(typeof instance[`command${slot}`], `${type}.${slot} command`).toBe('function');
        expect(typeof instance[`neutralize${slot}`], `${type}.${slot} neutralize`).toBe('function');
      }
      const commandSlots = Object.getOwnPropertyNames(Object.getPrototypeOf(instance))
        .filter((name) => name.startsWith('command'))
        .map((name) => name.slice('command'.length));
      expect(new Set(commandSlots)).toEqual(new Set(controlSlots));
    }
  });

  it('keeps DRIVE_BEHAVIOR_MAP types outside the v1 set out of direct slots', () => {
    for (const type of ['Drive_Speed', 'Drive_FollowPosition']) {
      const fixture = buildBehavior('Drive_Simple');
      fixture.root.children[0].userData.realvirtual = { [type]: {} };
      expect(resolveBindableSlots(fixture.root.children[0], fixture.store, fixture.registry)
        .filter((slot) => slot.kind === 'direct-property' && slot.componentPath === '.')).toEqual([]);
    }
  });

  it('the ODT schema exposes Drive_Cylinder Out/In as PLCOutputBool signals', () => {
    expect(DRIVE_BEHAVIOR_MAP.Drive_Cylinder.schema.Out.signal).toBe('PLCOutputBool');
    expect(DRIVE_BEHAVIOR_MAP.Drive_Cylinder.schema.In.signal).toBe('PLCOutputBool');
  });

  it('Drive_Simple commands apply ScaleSpeed and neutralize held jogs', () => {
    const fixture = buildBehavior('Drive_Simple', { ScaleSpeed: 2 });
    const component = fixture.component as unknown as {
      commandSpeed: (value: number) => void;
      commandAccelaration: (value: number) => void;
      commandForward: (value: boolean) => void;
      neutralizeForward: () => void;
    };
    component.commandSpeed(25);
    component.commandAccelaration(10);
    component.commandForward(true);
    expect(fixture.drive.targetSpeed).toBe(50);
    expect(fixture.drive.Acceleration).toBe(20);
    expect(fixture.drive.jogForward).toBe(true);
    component.neutralizeForward();
    expect(fixture.drive.jogForward).toBe(false);
  });

  it.each([
    ['two-bit', {}],
    ['one-bit', { OneBitCylinder: true }],
    ['inverted', { InvertOutputLogic: true }],
  ])('cylinder neutralize uses drive.stop for the %s variant', (_name, extras) => {
    const fixture = buildBehavior('Drive_Cylinder', extras);
    const component = fixture.component as unknown as {
      commandOut: (value: boolean) => void;
      neutralizeOut: () => void;
    };
    component.commandOut('InvertOutputLogic' in extras && extras.InvertOutputLogic ? false : true);
    expect(fixture.drive.isRunning).toBe(true);
    component.neutralizeOut();
    expect(fixture.drive.isRunning).toBe(false);
    expect(fixture.drive.jogForward).toBe(false);
    expect(fixture.drive.jogBackward).toBe(false);
  });

  it('DestinationMotor applies normalization and StartDrive only on rising edges', () => {
    const fixture = buildBehavior('Drive_DestinationMotor', {
      CurrentPositionScale: 2,
      CurrentPositionOffset: 5,
    });
    fixture.drive.isRotary = true;
    fixture.drive.currentPosition = 350;
    const component = fixture.component as unknown as {
      commandDestination: (value: number) => void;
      commandStartDrive: (value: boolean) => void;
    };
    component.commandDestination(2.5);
    expect(fixture.drive.targetPosition).toBe(370);
    const start = vi.spyOn(fixture.drive as RVDrive, 'startMove');
    component.commandStartDrive(true);
    component.commandStartDrive(true);
    component.commandStartDrive(false);
    component.commandStartDrive(true);
    expect(start).toHaveBeenCalledTimes(2);
  });
});

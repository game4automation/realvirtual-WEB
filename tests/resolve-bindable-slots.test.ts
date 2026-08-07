// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  constructDrive,
  registerSignal,
} from '../src/core/engine/rv-signal-construction';
import {
  resolveComponentRefs,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import { resolveBindableSlots } from '../src/core/engine/rv-binding-slot-resolver';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { AABB } from '../src/core/engine/rv-aabb';

interface DriveSpec {
  name: string;
  authoredSlots?: string[];
  authoredSignalNames?: Record<string, string>;
}

function buildFixture(specs: DriveSpec[]) {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Cell';
  root.userData.realvirtual = { LayoutObject: { Label: 'Cell' } };
  scene.add(root);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Cell', root);

  const authoredPaths = new Map<string, string>();
  for (const spec of specs) {
    for (const slot of spec.authoredSlots ?? []) {
      const key = `${spec.name}.${slot}`;
      const signalNode = new Object3D();
      signalNode.name = key;
      root.add(signalNode);
      const path = `Cell/${key}`;
      registry.registerNode(path, signalNode);
      const type = slot === 'Forward' || slot === 'Backward' ? 'PLCOutputBool' : 'PLCOutputFloat';
      registerSignal(signalNode, type, {
        Name: spec.authoredSignalNames?.[slot] ?? key,
        Status: { Value: false },
      }, path, store, registry);
      authoredPaths.set(key, path);
    }
  }

  const pending: ReturnType<typeof constructDrive>[] = [];
  for (const spec of specs) {
    const node = new Object3D();
    node.name = spec.name;
    root.add(node);
    const behavior: Record<string, unknown> = {};
    for (const slot of spec.authoredSlots ?? []) {
      const key = `${spec.name}.${slot}`;
      behavior[slot] = {
        type: 'ComponentReference',
        path: authoredPaths.get(key),
        componentType: slot === 'Forward' || slot === 'Backward' ? 'PLCOutputBool' : 'PLCOutputFloat',
      };
    }
    const rv = { Drive: { Direction: 'LinearX' }, Drive_Simple: behavior };
    node.userData.realvirtual = rv;
    const path = `Cell/${spec.name}`;
    registry.registerNode(path, node);
    pending.push(constructDrive(node, rv, rv.Drive, path, registry, store));
  }

  store.buildIndex();
  const ctx = { registry, signalStore: store, scene, root } as ComponentContext;
  for (const result of pending) {
    for (const entry of result?.pendingBehaviors ?? []) {
      resolveComponentRefs(entry.component as unknown as Record<string, unknown>, registry);
      registry.register(entry.type, entry.path, entry.component);
      entry.component.init(ctx);
    }
  }
  return { root, registry, store };
}

describe('resolveBindableSlots', () => {
  it('returns direct command and feedback slots for an unwired Drive_Simple', () => {
    const fixture = buildFixture([{ name: 'Auto' }]);
    const slots = resolveBindableSlots(fixture.root, fixture.store, fixture.registry);
    expect(new Set(slots.map((slot) => slot.kind)))
      .toEqual(new Set(['direct-property', 'direct-feedback']));
    expect(slots.filter(slot => slot.kind === 'direct-property').map(slot => slot.slot))
      .toEqual(['Speed', 'Accelaration', 'Forward', 'Backward']);
    expect(slots.filter(slot => slot.kind === 'direct-feedback').map(slot => slot.slot))
      .toEqual(['IsAtPosition', 'IsAtSpeed', 'IsDriving']);
  });

  it('resolves a partially wired instance per slot', () => {
    const fixture = buildFixture([{ name: 'Wired', authoredSlots: ['Forward'] }]);
    const slots = resolveBindableSlots(fixture.root, fixture.store, fixture.registry);
    expect(slots).toHaveLength(7);
    expect(slots.find(slot => slot.slot === 'Forward')).toMatchObject({
      kind: 'mapped-signal',
      slot: 'Forward',
      componentPath: 'Wired',
      targetName: 'Wired.Forward',
    });
    expect(slots.find(slot => slot.slot === 'Backward')?.kind).toBe('direct-property');
    expect(slots.find(slot => slot.slot === 'IsDriving')?.kind).toBe('direct-feedback');
  });

  it('switches independently per component instance inside one placement', () => {
    const fixture = buildFixture([
      { name: 'Wired', authoredSlots: ['Forward'] },
      { name: 'Auto' },
    ]);
    const slots = resolveBindableSlots(fixture.root, fixture.store, fixture.registry);
    expect(new Set(slots.filter((slot) => slot.kind !== 'unavailable' && slot.componentPath === 'Wired').map((slot) => slot.kind)))
      .toEqual(new Set(['mapped-signal', 'direct-property', 'direct-feedback']));
    expect(new Set(slots.filter((slot) => slot.kind !== 'unavailable' && slot.componentPath === 'Auto').map((slot) => slot.kind)))
      .toEqual(new Set(['direct-property', 'direct-feedback']));
    expect(slots.flatMap((slot) =>
      slot.kind !== 'unavailable' && slot.slot === 'Forward' ? [slot.componentPath] : []).sort())
      .toEqual(['Auto', 'Wired']);
  });

  it('keeps provenance per component instance even when authored and auto slots share a signal name', () => {
    const fixture = buildFixture([
      {
        name: 'Wired',
        authoredSlots: ['Forward'],
        authoredSignalNames: { Forward: 'Cell.Forward' },
      },
      { name: 'Auto' },
    ]);
    const slots = resolveBindableSlots(fixture.root, fixture.store, fixture.registry);
    expect(slots.find(slot => slot.kind !== 'unavailable' && slot.componentPath === 'Wired' && slot.slot === 'Forward')?.kind)
      .toBe('mapped-signal');
    expect(slots.find(slot => slot.kind !== 'unavailable' && slot.componentPath === 'Auto' && slot.slot === 'Forward')?.kind)
      .toBe('direct-property');
  });

  it('keeps mapped and direct rows distinct per slot on one component instance', () => {
    const fixture = buildFixture([{ name: 'Wired', authoredSlots: ['Backward'] }]);
    const slots = resolveBindableSlots(fixture.root, fixture.store, fixture.registry)
      .filter(slot => slot.kind !== 'unavailable' && slot.componentPath === 'Wired');
    expect(new Set(slots.map(slot => slot.kind)))
      .toEqual(new Set(['mapped-signal', 'direct-property', 'direct-feedback']));
  });

  it('returns direct feedback slots for an unwired Sensor', () => {
    const fixture = buildFixture([]);
    const sensor = new Object3D();
    sensor.name = 'Sensor';
    sensor.userData.realvirtual = { Sensor: {} };
    fixture.root.add(sensor);
    fixture.registry.registerNode('Cell/Sensor', sensor);
    fixture.registry.register('Sensor', 'Cell/Sensor', new RVSensor(sensor, new AABB()));
    expect(resolveBindableSlots(fixture.root, fixture.store, fixture.registry)).toMatchObject([
      { kind: 'direct-feedback', slot: 'SensorOccupied', componentPath: 'Sensor' },
      { kind: 'direct-feedback', slot: 'SensorNotOccupied', componentPath: 'Sensor' },
    ]);
  });
});

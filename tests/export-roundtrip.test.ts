// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { processExtras } from '../src/core/engine/rv-scene-loader';
import {
  attachDriveBehaviorByCode,
  type DriveBehaviorHostViewer,
} from '../src/core/engine/rv-signal-construction';
import { resolveBindableSlots } from '../src/core/engine/rv-binding-slot-resolver';

function asset(withBehavior: boolean) {
  const root = new Group();
  root.name = 'Asset';
  const axis = new Object3D();
  axis.name = 'Axis';
  axis.userData.realvirtual = {
    Drive: { Direction: 'LinearX' },
    ...(withBehavior ? { Drive_Simple: {} } : {}),
  };
  root.add(axis);
  return { root, axis };
}

function find(root: Object3D, name: string): Object3D {
  let result: Object3D | null = null;
  root.traverse((node) => { if (!result && node.name === name) result = node; });
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}

async function reload(buffer: ArrayBuffer) {
  const parsed = await new GLTFLoader().parseAsync(buffer, '');
  const scene = new Scene();
  scene.add(parsed.scene);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  processExtras(
    parsed.scene,
    registry,
    store,
    new RVTransportManager(),
    scene,
  );
  const axis = find(parsed.scene, 'Axis');
  return { root: parsed.scene, axis, registry, store };
}

function assertSignalFree(axis: Object3D, store: SignalStore): void {
  expect(findOptional(axis, 'Signals')).toBeNull();
  expect([...store.getAll().keys()]).toEqual([]);
  const extras = (axis.userData.realvirtual as Record<string, unknown>).Drive_Simple as Record<string, unknown>;
  expect(Object.keys(extras).filter((key) => [
    'Speed', 'Accelaration', 'Forward', 'Backward',
    'IsAtPosition', 'IsAtSpeed', 'IsDriving',
  ].includes(key))).toEqual([]);
}

function findOptional(root: Object3D, name: string): Object3D | null {
  let result: Object3D | null = null;
  root.traverse((node) => { if (!result && node.name === name) result = node; });
  return result;
}

function slotKinds(root: Object3D, store: SignalStore, registry: NodeRegistry): string[] {
  return resolveBindableSlots(root, store, registry)
    .map((slot) => `${slot.slot}:${slot.kind}`)
    .sort();
}

describe('signal-free behavior export round-trip', () => {
  it('preserves an authored behavior with empty references without mutating the live tree', async () => {
    const { root, axis } = asset(true);
    const before = JSON.stringify(axis.userData);

    const loaded = await reload(await exportAssetGlb(root));

    expect(JSON.stringify(axis.userData)).toBe(before);
    assertSignalFree(loaded.axis, loaded.store);
    expect(slotKinds(loaded.axis, loaded.store, loaded.registry)).toEqual([
      'Accelaration:direct-property',
      'Backward:direct-property',
      'Forward:direct-property',
      'IsAtPosition:direct-feedback',
      'IsAtSpeed:direct-feedback',
      'IsDriving:direct-feedback',
      'Speed:direct-property',
    ]);
  });

  it('preserves a code-attached behavior with no wiring and no stamped references', async () => {
    const { root, axis } = asset(false);
    const scene = new Scene();
    scene.add(root);
    const registry = new NodeRegistry();
    const store = new SignalStore();
    processExtras(root, registry, store, new RVTransportManager(), scene);
    const viewer = { registry, signalStore: store, scene } satisfies DriveBehaviorHostViewer;
    expect(attachDriveBehaviorByCode(viewer, axis, 'Drive_Simple')).not.toBeNull();
    const before = JSON.stringify(axis.userData);

    const loaded = await reload(await exportAssetGlb(root));

    expect(JSON.stringify(axis.userData)).toBe(before);
    assertSignalFree(loaded.axis, loaded.store);
    expect(slotKinds(loaded.axis, loaded.store, loaded.registry))
      .toEqual(slotKinds(axis, store, registry));
  });
});

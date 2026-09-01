// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase D — component authoring: addComponent/removeComponent ops on the
 * AssetDocument (userData round-trip, `_N` key dedup, undo restores prev
 * fields) and the `authorable` capability wiring.
 */
import { describe, it, expect } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { getCapabilities, getTypesWithCapability } from '../src/core/engine/rv-component-registry';
// Import component modules for their registration side effects (capabilities).
import '../src/core/engine/rv-sensor';
import '../src/core/engine/rv-drive';
import '../src/core/engine/rv-source';

function makeMockViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const box = new Object3D();
  box.name = 'Box';
  model.add(box);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    rebuildGroupedBvh() {},
  } as unknown as RVViewer;

  return { viewer, box, boxPath: NodeRegistry.computeNodePath(box), registry };
}

describe('authorable capability', () => {
  it('core authoring set declares authorable: true; unknown types default false', () => {
    expect(getCapabilities('Drive').authorable).toBe(true);
    expect(getCapabilities('Sensor').authorable).toBe(true);
    expect(getCapabilities('Source').authorable).toBe(true);
    expect(getCapabilities('SomethingUnknown').authorable).toBe(false);
    expect(getTypesWithCapability('authorable')).toContain('Sensor');
  });
});

describe('addComponent / removeComponent ops', () => {
  it('addComponent writes userData with schema fields; undo removes it', async () => {
    const { viewer, box, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);

    const key = doc.addComponent(boxPath, 'Sensor', { Limit: 5 });
    await doc.whenIdle();
    expect(key).toBe('Sensor');
    expect((box.userData.realvirtual as any).Sensor).toEqual({ Limit: 5 });

    await doc.undo();
    expect((box.userData.realvirtual as any)?.Sensor).toBeUndefined();

    await doc.redo();
    expect((box.userData.realvirtual as any).Sensor).toEqual({ Limit: 5 });
    doc.dispose();
  });

  it('duplicate adds get deterministic _N suffixed keys', async () => {
    const { viewer, box, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);

    const k1 = doc.addComponent(boxPath, 'Sensor', {});
    await doc.whenIdle();
    const k2 = doc.addComponent(boxPath, 'Sensor', {});
    await doc.whenIdle();
    expect(k1).toBe('Sensor');
    expect(k2).toBe('Sensor_1');
    const rv = box.userData.realvirtual as Record<string, unknown>;
    expect(Object.keys(rv).sort()).toEqual(['Sensor', 'Sensor_1']);
    doc.dispose();
  });

  it('removeComponent deletes the entry; undo restores the exact prev fields', async () => {
    const { viewer, box, boxPath } = makeMockViewer();
    box.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 250 } };
    const doc = scratchAssetDocument(viewer);

    doc.removeComponent(boxPath, 'Drive');
    await doc.whenIdle();
    expect((box.userData.realvirtual as any).Drive).toBeUndefined();

    await doc.undo();
    expect((box.userData.realvirtual as any).Drive).toEqual({ Direction: 'LinearX', TargetSpeed: 250 });
    doc.dispose();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { BatchTable } from '../src/core/engine/rv-batch-table';
import { buildBatchedScene } from '../src/core/engine/rv-batched-render';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { deduplicateMaterials } from '../src/core/engine/rv-material-dedup';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { applyUberMaterial } from '../src/core/engine/rv-uber-material';

describe('RVLamp material pipeline', () => {
  it('keeps a live emissive material through dedup, uber bake and batching', async () => {
    const scene = new Scene();
    const root = new Group();
    root.name = 'Root';
    scene.add(root);

    const lampNode = new Object3D();
    lampNode.name = 'Lamp';
    lampNode.userData.realvirtual = {
      Lamp: { OnColor: { r: 1, g: 0.2, b: 0, a: 1 } },
    };
    const base = new MeshStandardMaterial({ color: 0x808080 });
    base.emissiveIntensity = 0;
    const lampMesh = new Mesh(new BoxGeometry(), base);
    lampMesh.name = 'Lens';
    lampMesh.matrixAutoUpdate = false;
    lampMesh.updateMatrix();
    lampNode.add(lampMesh);
    root.add(lampNode);

    const peerMaterialA = base.clone();
    const peerMaterialB = base.clone();
    const peerA = new Mesh(new BoxGeometry(), peerMaterialA);
    const peerB = new Mesh(new BoxGeometry(), peerMaterialB);
    for (const [index, peer] of [peerA, peerB].entries()) {
      peer.name = `Peer${index}`;
      peer.position.x = index + 2;
      peer.matrixAutoUpdate = false;
      peer.updateMatrix();
      root.add(peer);
    }

    const registry = new NodeRegistry();
    registry.registerNode('Root', root);
    registry.registerNode('Root/Lamp', lampNode);
    const signalStore = new SignalStore();
    signalStore.register('LampOn', 'Signals/LampOn', false);
    const lamp = new RVLamp(lampNode);
    lamp.SignalLampOn = 'Signals/LampOn';
    lamp.init({ scene, root, registry, signalStore } as any);

    const lampMaterial = lampMesh.material as MeshStandardMaterial;
    const dedup = deduplicateMaterials(root);
    expect(lampMesh.material).toBe(lampMaterial);
    expect(lampMesh.material).not.toBe(peerA.material);
    expect(peerA.material).toBe(peerB.material);

    const uber = applyUberMaterial(root, dedup.uniqueMaterials, false);
    expect(lampMesh.material).toBe(lampMaterial);
    expect(lampMesh.userData._rvUberBaked).toBeUndefined();

    root.updateMatrixWorld(true);
    const table = new BatchTable();
    await buildBatchedScene(root, uber.sharedMaterial, new Set<Object3D>(), table);
    expect(lampMesh.userData._rvBatchSource).toBeUndefined();
    expect(lampMesh.layers.mask).toBe(1);
    expect(table.batches.length).toBeGreaterThan(0);

    signalStore.set('LampOn', true);
    expect(lampMaterial.emissive.getHex()).toBe(0xff3300);
    expect(lampMaterial.emissiveIntensity).toBe(2);
    signalStore.set('LampOn', false);
    expect(lampMaterial.emissive.getHex()).toBe(0x000000);
    expect(lampMaterial.emissiveIntensity).toBe(0);
  });
});

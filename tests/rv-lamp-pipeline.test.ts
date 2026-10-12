// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { deduplicateMaterials } from '../src/core/engine/rv-material-dedup';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { applyUberMaterial } from '../src/core/engine/rv-uber-material';

describe('RVLamp material pipeline', () => {
  it('keeps a live emissive material through dedup and the uber bake', () => {
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
    expect(uber.sharedMaterial).not.toBeNull();

    signalStore.set('LampOn', true);
    expect(lampMaterial.emissive.getHex()).toBe(0xff3300);
    expect(lampMaterial.emissiveIntensity).toBe(2);
    signalStore.set('LampOn', false);
    expect(lampMaterial.emissive.getHex()).toBe(0x000000);
    expect(lampMaterial.emissiveIntensity).toBe(0);
  });
});

// ─── plan-754: the same contract under the destructive loader bake ─────
// Under `bake()` the Lamp is a `keep` mesh: never staged into a chunk, its
// live material untouched, and the template placement leaves it unmasked.
import { bake } from '../src/core/engine/rv-bake-pipeline';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';

describe('RVLamp under the loader bake (plan-754)', () => {
  it('is a keep mesh: unmasked, live emissive material, peers baked into the static chunk', async () => {
    const scene = new Scene();
    const root = new Group();
    root.name = 'Root';
    scene.add(root);
    const lampNode = new Object3D();
    lampNode.name = 'Lamp';
    lampNode.userData.realvirtual = { Lamp: { OnColor: { r: 1, g: 0.2, b: 0, a: 1 } } };
    const base = new MeshStandardMaterial({ color: 0x808080 });
    const lampMesh = new Mesh(new BoxGeometry(), base);
    lampMesh.name = 'Lens';
    lampNode.add(lampMesh);
    root.add(lampNode);
    const peerA = new Mesh(new BoxGeometry(), base.clone()); peerA.name = 'PeerA'; peerA.position.x = 2; root.add(peerA);
    const peerB = new Mesh(new BoxGeometry(), base.clone()); peerB.name = 'PeerB'; peerB.position.x = 4; root.add(peerB);

    const registry = new NodeRegistry();
    registry.registerNode('Root', root);
    registry.registerNode('Root/Lamp', lampNode);
    const signalStore = new SignalStore();
    signalStore.register('LampOn', 'Signals/LampOn', false);
    const lamp = new RVLamp(lampNode);
    lamp.SignalLampOn = 'Signals/LampOn';
    lamp.init({ scene, root, registry, signalStore } as any);
    // The lamp owns its material from init on (same read point as above).
    const lampMaterial = lampMesh.material as MeshStandardMaterial;

    const dedup = deduplicateMaterials(root);
    const uber = applyUberMaterial(root, dedup.uniqueMaterials, false);
    root.updateMatrixWorld(true);
    const baked = await bake(root, {
      assetId: 'lamp-test', uberMaterial: uber.sharedMaterial, 
      pickPort: createPickBuildPort({ createWorker: () => null }),
      destructive: true,
    });
    // A keep mesh is MOVED into the template, so it is the very same object the
    // Lamp component initialised — that is what keeps its live material alive.
    expect(baked.keep.map((k) => k.mesh)).toEqual([lampMesh]);
    expect(baked.chunks.map((c) => c.key)).toEqual(['static']);

    const inst = new BakeRegistry().instantiateTemplate(baked);
    expect(lampMesh.layers.mask).toBe(1);
    expect(lampMesh.parent).toBeTruthy();
    // The peers were merged into the static chunk and REMOVED (plan-754), not
    // masked: they are gone from the template and from any parent.
    const templateNames: string[] = [];
    baked.template.traverse((n) => templateNames.push(n.name));
    expect(templateNames).not.toContain('PeerA');
    expect(templateNames).not.toContain('PeerB');
    // (`peerA` itself still points at its old parent — that whole graph is the
    // dropped `tmp` and is unreachable from the scene.)
    expect(inst.keep).toEqual([lampMesh]);
    expect(lampMesh.material).toBe(lampMaterial);

    signalStore.set('LampOn', true);
    expect(lampMaterial.emissive.getHex()).toBe(0xff3300);
    signalStore.set('LampOn', false);
    expect(lampMaterial.emissiveIntensity).toBe(0);
  });
});

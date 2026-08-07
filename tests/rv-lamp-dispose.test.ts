// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { LampManager } from '../src/core/engine/rv-lamp-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';

describe('RVLamp dispose', () => {
  it('restores materials, unsubscribes, unregisters and removes owned markers', () => {
    const scene = new Scene();
    const node = new Object3D();
    node.name = 'Beacon';
    node.userData.realvirtual = { Lamp: {} };
    const original = new MeshStandardMaterial();
    const mesh = new Mesh(new BoxGeometry(), original);
    node.add(mesh);
    scene.add(node);
    const registry = new NodeRegistry();
    registry.registerNode('Beacon', node);
    const signalStore = new SignalStore();
    signalStore.register('On', 'Signals/On', false);
    const manager = new LampManager();
    const lamp = new RVLamp(node);
    lamp.SignalLampOn = 'Signals/On';
    lamp.init({ registry, signalStore, scene, root: scene, lampManager: manager } as any);
    const clone = mesh.material as MeshStandardMaterial;

    lamp.dispose();
    expect(mesh.material).toBe(original);
    expect(manager.size).toBe(0);
    expect(mesh.userData._rvLampMesh).toBeUndefined();
    expect(node.userData._rvLamp).toBeUndefined();
    expect(node.userData._rvType).toBeUndefined();
    signalStore.set('On', true);
    expect(clone.emissive.getHex()).toBe(0x000000);
  });

  it('never removes a pre-existing component type marker', () => {
    const scene = new Scene();
    const node = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    node.name = 'DriveLamp';
    node.userData._rvType = 'Drive';
    node.userData.realvirtual = { Lamp: {} };
    scene.add(node);
    const registry = new NodeRegistry();
    registry.registerNode('DriveLamp', node);
    const lamp = new RVLamp(node);
    lamp.init({
      registry,
      signalStore: new SignalStore(),
      scene,
      root: scene,
      lampManager: new LampManager(),
    } as any);
    lamp.dispose();
    expect(node.userData._rvType).toBe('Drive');
  });
});

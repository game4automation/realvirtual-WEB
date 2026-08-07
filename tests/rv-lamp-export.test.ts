// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { LampManager } from '../src/core/engine/rv-lamp-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';

async function exportLamp(
  lampData: Record<string, unknown>,
  configure: (lamp: RVLamp, manager: LampManager) => void,
) {
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Beacon';
  node.userData.realvirtual = {
    Lamp: {
      OnColor: { r: 1, g: 0, b: 0, a: 1 },
      ...lampData,
    },
  };
  const authored = new MeshStandardMaterial({
    color: 0x345678,
    emissive: 0x000000,
    emissiveIntensity: 0,
  });
  const mesh = new Mesh(new BoxGeometry(), authored);
  mesh.name = 'Lens';
  node.add(mesh);
  scene.add(node);
  const registry = new NodeRegistry();
  registry.registerNode('Beacon', node);
  const manager = new LampManager();
  const lamp = new RVLamp(node);
  for (const key of ['Flashing', 'Period', 'LampOn', 'Intensity'] as const) {
    if (key in lampData) (lamp[key] as unknown) = lampData[key];
  }
  lamp.init({
    registry,
    signalStore: new SignalStore(),
    scene,
    root: scene,
    lampManager: manager,
  } as any);
  configure(lamp, manager);

  const bytes = await exportAssetGlb(node);
  const parsed = await new GLTFLoader().parseAsync(bytes, '');
  const reloaded = parsed.scene.getObjectByName('Lens') as Mesh;
  return {
    lamp,
    liveMaterial: mesh.material as MeshStandardMaterial,
    reloadedMaterial: reloaded.material as MeshStandardMaterial,
    extras: parsed.scene.getObjectByName('Beacon')?.userData.realvirtual?.Lamp,
  };
}

describe('Lamp GLB export persistence', () => {
  it('exports the authored base material while off', async () => {
    const result = await exportLamp({ LampOn: false }, () => {});
    expect(result.reloadedMaterial.color.getHex()).toBe(0x345678);
    expect(result.reloadedMaterial.emissive.getHex()).toBe(0x000000);
    expect(result.extras.LampOn).toBe(false);
  });

  it('does not bake a live on-state and leaves the live material unchanged', async () => {
    const result = await exportLamp({ LampOn: true }, () => {});
    expect(result.lamp.isLit()).toBe(true);
    expect(result.liveMaterial.emissive.getHex()).toBe(0xff0000);
    expect(result.reloadedMaterial.emissive.getHex()).toBe(0x000000);
    expect(result.lamp.isLit()).toBe(true);
    expect(result.liveMaterial.emissive.getHex()).toBe(0xff0000);
  });

  it('does not bake a flashing phase and preserves both field spellings', async () => {
    const result = await exportLamp(
      {
        Flashing: true,
        Period: 1,
        SingalLampFlashing: { object: 'FlashLegacy' },
        SignalLampFlashing: { object: 'FlashCorrected' },
      },
      (_lamp, manager) => manager.update(0.6),
    );
    expect(result.reloadedMaterial.emissive.getHex()).toBe(0x000000);
    expect(result.extras.SingalLampFlashing).toEqual({ object: 'FlashLegacy' });
    expect(result.extras.SignalLampFlashing).toEqual({ object: 'FlashCorrected' });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';

function litLamp(lampData: Record<string, unknown>, lensColor: number): MeshStandardMaterial {
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Segment';
  node.userData.realvirtual = { Lamp: lampData };
  const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ color: lensColor }));
  node.add(mesh);
  scene.add(node);
  const registry = new NodeRegistry();
  registry.registerNode('Segment', node);
  const lamp = new RVLamp(node);
  lamp.LampOn = true;
  lamp.init({ registry, signalStore: new SignalStore(), scene, root: scene } as any);
  return mesh.material as MeshStandardMaterial;
}

describe('Lamp on-colour', () => {
  it('lights in its own lens colour when no OnColor is authored', () => {
    // A green stack-light segment must glow green, not the old red default.
    expect(litLamp({}, 0x00c040).emissive.getHex()).toBe(0x00c040);
  });

  it('an authored OnColor wins over the lens colour', () => {
    expect(litLamp({ OnColor: { r: 0, g: 0, b: 1, a: 1 } }, 0x00c040).emissive.getHex()).toBe(0x0000ff);
  });
});

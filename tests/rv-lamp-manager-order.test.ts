// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { LampManager } from '../src/core/engine/rv-lamp-manager';
import { objectToGlb } from '../src/core/import/rv-import-object';

describe('LampManager initial-load order', () => {
  it('is available during the real loadGLB component init pass', async () => {
    const root = new Object3D();
    root.name = 'LampFixture';
    const node = new Object3D();
    node.name = 'Beacon';
    node.userData.realvirtual = {
      Lamp: {
        OnColor: { r: 1, g: 0.25, b: 0, a: 1 },
        Flashing: true,
        Period: 1,
      },
    };
    node.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()));
    root.add(node);

    const data = await objectToGlb(root);
    const scene = new Scene();
    const manager = new LampManager();
    const result = await loadGLB('memory://lamp-manager-order.glb', scene, {
      data,
      lampManager: manager,
      preserveHierarchy: true,
    });

    const lamps = result.registry.findAllInChildren<RVLamp>(result.root, 'Lamp');
    expect(lamps).toHaveLength(1);
    expect(manager.size).toBe(1);
    expect(lamps[0].instance.isLit()).toBe(true);
    expect(manager.update(0.6)).toBe(true);
    expect(lamps[0].instance.isLit()).toBe(false);

    manager.clear();
    expect(manager.size).toBe(0);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Scene } from 'three';
import { getCapabilities } from '../src/core/engine/rv-component-registry';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { bake } from '../src/core/engine/rv-bake-pipeline';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';

describe('RVLamp coexistence under the loader bake (plan-753)', () => {
  it('a Pipe mesh with a Lamp is a keep mesh with its identity intact', async () => {
    const scene = new Scene();
    const root = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    root.name = 'Root';
    const node = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    node.name = 'PipeBeacon';
    node.userData._rvType = 'Pipe';
    node.userData._rvPipeMesh = true;
    node.userData.realvirtual = { Lamp: { LampOn: true } };
    root.add(node);
    scene.add(root);
    const registry = new NodeRegistry();
    registry.registerNode('Root/PipeBeacon', node);
    const lamp = new RVLamp(node);
    lamp.LampOn = true;
    lamp.init({ registry, signalStore: new SignalStore(), scene, root } as any);
    root.updateMatrixWorld(true);
    const staged: Mesh[] = [];
    const baked = await bake(root, { assetId: 'coexist', uberMaterial: null, pickPort: createPickBuildPort({ createWorker: () => null }), onStaged: (m) => staged.push(m) });
    expect(baked.keep.map((k) => k.mesh)).toEqual([node]);
    expect(staged).not.toContain(node);
    expect(node.userData._rvType).toBe('Pipe');
    expect(node.userData._rvPipeMesh).toBe(true);
    expect(node.userData._rvLampMesh).toBe(true);
    const capabilities = getCapabilities('Lamp');
    expect(capabilities.pick).toBe('select');
    expect(capabilities.bake).toBe('keep');

    lamp.dispose();
    expect(node.userData._rvType).toBe('Pipe');
    expect(node.userData._rvPipeMesh).toBe(true);
  });
});

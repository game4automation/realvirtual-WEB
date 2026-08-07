// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Scene } from 'three';
import { BatchTable } from '../src/core/engine/rv-batch-table';
import { buildBatchedScene } from '../src/core/engine/rv-batched-render';
import { getCapabilities } from '../src/core/engine/rv-component-registry';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';

describe('RVLamp component coexistence', () => {
  it('preserves Drive/Pipe identity and remains an unbatched selectable mesh', async () => {
    const scene = new Scene();
    const node = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    node.name = 'PipeBeacon';
    node.userData._rvType = 'Pipe';
    node.userData._rvPipeMesh = true;
    node.userData.realvirtual = { Lamp: { LampOn: true } };
    scene.add(node);
    const registry = new NodeRegistry();
    registry.registerNode('PipeBeacon', node);
    const lamp = new RVLamp(node);
    lamp.LampOn = true;
    lamp.init({ registry, signalStore: new SignalStore(), scene, root: scene } as any);

    const table = new BatchTable();
    const result = await buildBatchedScene(
      scene,
      new MeshStandardMaterial(),
      new Set(),
      table,
    );
    expect(result.staticUber.instanceCount).toBe(0);
    expect(node.userData._rvType).toBe('Pipe');
    expect(node.userData._rvPipeMesh).toBe(true);
    expect(node.userData._rvLampMesh).toBe(true);
    const capabilities = getCapabilities('Lamp');
    expect(capabilities.hoverable).toBe(true);
    expect(capabilities.selectable).toBe(true);

    lamp.dispose();
    expect(node.userData._rvType).toBe('Pipe');
    expect(node.userData._rvPipeMesh).toBe(true);
  });
});

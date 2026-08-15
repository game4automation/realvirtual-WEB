// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { ResolvedSlot } from '../src/core/engine/rv-binding-slot-resolver';
import { armSignalDrag, cancelSignalDrag, updateSignalDrag } from '../src/core/hmi/signal-drag-store';
import { DropTargetOverlayController } from '../src/plugins/signal-bind/drop-target-overlay';
import { DEV_GLB } from './fixtures/glb-paths.mjs';

const VIEWER_TEST_TIMEOUT = 60_000;
const SLOT: ResolvedSlot = {
  slot: 'Flow.Run', targetName: 'Flow.Run', type: 'bool', direction: 'plcOutput', aliases: [], instance: null,
};
let handle: TestViewerHandle | null = null;

afterEach(() => {
  cancelSignalDrag();
  handle?.dispose();
  handle = null;
});

describe('drop target overlay on webgpu renderer', () => {
  it('builds, renders and disposes on a webgpu-gl viewer', async () => {
    handle = await createTestViewer('webgpu-gl', { plannerSignalLinking: true });
    const viewer = handle.viewer;
    await viewer.loadModel(DEV_GLB.europalletEmpty);
    expect(viewer.isWebGPU).toBe(true);
    expect(viewer.signalBindingManager).not.toBeNull();
    expect(viewer.registry).not.toBeNull();

    const node = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshBasicMaterial());
    node.name = 'WebGpuTarget';
    node.userData.realvirtual = { Conveyor: {} };
    viewer.scene.add(node);
    viewer.registry!.registerNode(node.name, node);
    Object.assign(viewer.signalBindingManager!, {
      getElementSlots: (id: string) => id === node.name ? [SLOT] : [],
    });

    const controller = new DropTargetOverlayController(viewer);
    armSignalDrag({ name: 'Run', direction: 'output', plcType: 'PLCOutputBool', origin: 'connect', interfaceId: 'iface-1' }, 310, 240);
    updateSignalDrag(320, 240);
    expect(controller.targetCount).toBe(1);
    expect(() => controller.onRender()).not.toThrow();
    cancelSignalDrag();
    expect(controller.targetCount).toBe(0);
    expect(() => controller.dispose()).not.toThrow();

    viewer.registry!.unregisterSubtree(node);
    node.removeFromParent();
    node.geometry.dispose();
    (node.material as MeshBasicMaterial).dispose();
  }, VIEWER_TEST_TIMEOUT);
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
  vi.restoreAllMocks();
});

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('viewer core frame and entity APIs', () => {
  it('runs onBeforeFrame before the render decision in the same frame', async () => {
    handle = await createTestViewer('webgl');
    await nextFrame();
    const order: string[] = [];
    const render = handle.viewer.renderer.render.bind(handle.viewer.renderer);
    vi.spyOn(handle.viewer.renderer, 'render').mockImplementation((...args) => {
      order.push('render');
      return render(...args);
    });
    const off = handle.viewer.onBeforeFrame(() => {
      order.push('before');
      handle!.viewer.markRenderDirty();
    });

    await nextFrame();
    off();
    expect(order.slice(0, 2)).toEqual(['before', 'render']);
  });

  it('registers entity-pool pick targets on entry, growth, and disposal', async () => {
    handle = await createTestViewer('webgl');
    const refresh = vi.spyOn(handle.viewer, 'refreshInstancedPickTargets');
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshBasicMaterial();
    const pool = handle.viewer.createEntityPool({ geometry, material, initialCapacity: 1 });
    expect(refresh).toHaveBeenCalledTimes(1);
    pool.set('a', new Vector3(), new Quaternion());
    pool.set('b', new Vector3(1, 0, 0), new Quaternion());
    expect(refresh).toHaveBeenCalledTimes(2);
    pool.dispose();
    expect(refresh).toHaveBeenCalledTimes(3);
    geometry.dispose();
    material.dispose();
  });
});

describe('model render hints', () => {
  it('SuppressGround hides the ground for a model and releases it on clear', async () => {
    handle = await createTestViewer('webgl', { ground: true });
    expect(handle.viewer.groundVisible).toBe(true);
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [], extras: { realvirtual: { SuppressGround: true } } }],
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(gltf)], { type: 'model/gltf+json' }));
    try {
      await handle.viewer.loadModel(url);
      expect(handle.viewer.groundVisible).toBe(false);
      handle.viewer.clearModel();
      expect(handle.viewer.groundVisible).toBe(true);
    } finally {
      URL.revokeObjectURL(url);
    }
  });
});

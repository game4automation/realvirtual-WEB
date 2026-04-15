// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for ModelCache — verify model caching and cloning behavior.
 */
import { describe, test, expect, vi } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { ModelCache } from '../../realvirtual-WebViewer-Private~/src/plugins/layout-planner';

// Create a mock loader that returns a pre-built Group
function createMockLoader() {
  let loadCount = 0;
  return {
    loadCount: () => loadCount,
    loadAsync: vi.fn(async (_url: string) => {
      loadCount++;
      const group = new Group();
      const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
      group.add(mesh);
      return { scene: group };
    }),
  };
}

describe('ModelCache', () => {
  test('caches loaded model by URL', async () => {
    const mockLoader = createMockLoader();
    const cache = new ModelCache(mockLoader as any);
    await cache.getOrLoad('https://example.com/belt.glb');
    await cache.getOrLoad('https://example.com/belt.glb');
    expect(mockLoader.loadAsync).toHaveBeenCalledTimes(1); // Only loaded once
  });

  test('clone returns independent Object3D', async () => {
    const mockLoader = createMockLoader();
    const cache = new ModelCache(mockLoader as any);
    const clone1 = await cache.getOrLoad('https://example.com/belt.glb');
    const clone2 = await cache.getOrLoad('https://example.com/belt.glb');
    clone1.position.set(100, 0, 0);
    expect(clone2.position.x).toBe(0); // Independent transforms
  });

  test('different URLs load separately', async () => {
    const mockLoader = createMockLoader();
    const cache = new ModelCache(mockLoader as any);
    await cache.getOrLoad('https://example.com/belt.glb');
    await cache.getOrLoad('https://example.com/robot.glb');
    expect(mockLoader.loadAsync).toHaveBeenCalledTimes(2);
  });

  test('dispose clears cache and disposes geometry', () => {
    const mockLoader = createMockLoader();
    const cache = new ModelCache(mockLoader as any);
    cache.dispose();
    expect(cache.size).toBe(0);
  });

  test('failed load is not cached', async () => {
    const mockLoader = createMockLoader();
    mockLoader.loadAsync.mockRejectedValueOnce(new Error('404'));
    const cache = new ModelCache(mockLoader as any);
    await expect(cache.getOrLoad('https://example.com/missing.glb')).rejects.toThrow('404');
    expect(cache.size).toBe(0); // Not cached
  });

  test('size reflects number of cached entries', async () => {
    const mockLoader = createMockLoader();
    const cache = new ModelCache(mockLoader as any);
    expect(cache.size).toBe(0);
    await cache.getOrLoad('https://example.com/belt.glb');
    expect(cache.size).toBe(1);
    await cache.getOrLoad('https://example.com/robot.glb');
    expect(cache.size).toBe(2);
  });
});

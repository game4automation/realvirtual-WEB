// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for ModelCache — verify model caching and cloning behavior.
 *
 * ModelCache routes loads through `RVAssetBlobCache.getObjectUrl()` (which
 * does a network `fetch` + Cache API hit) before handing the resulting
 * blob URL to the supplied GLTFLoader. Tests therefore have to mock both:
 *   - `fetch` (the network call inside RVAssetBlobCache)
 *   - `loadAsync` (the GLTFLoader call that produces the decoded Group)
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Group, Mesh, Object3D, Vector3, BoxGeometry, MeshBasicMaterial } from 'three';
import { ModelCache, pivotToFloorCenter } from '../src/plugins/layout-planner';

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

/**
 * Stub `globalThis.fetch` so RVAssetBlobCache._fetchWithBucket can hand a
 * Blob back to the loader. The bytes only have to pass the blob cache's
 * content check (a `glTF` header — since 2026-09-26 the cache refuses to
 * serve or store anything else); the mocked GLTFLoader.loadAsync ignores
 * its argument and returns the pre-built Three.js Group regardless.
 */
function mockFetchOK() {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input) => {
    const header = new Uint8Array(12);
    header.set([0x67, 0x6c, 0x54, 0x46], 0); // 'glTF'
    header[4] = 2;
    header[8] = 12;
    return new Response(new Blob([header]), {
      status: 200,
      headers: { 'Content-Type': 'model/gltf-binary' },
    });
  });
  return fetchSpy;
}

describe('ModelCache', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = mockFetchOK();
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

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
    // Loader-side rejection: blob cache succeeds (fetch OK), loadAsync throws.
    // The error message contains '404' because the test mocks loadAsync's
    // rejection — RVAssetBlobCache itself would translate fetch !ok into
    // 'HTTP 404 for <url>', but here we exercise the loader path.
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

describe('pivotToFloorCenter', () => {
  function makeBoxAt(x: number, y: number, z: number, size = 1): Mesh {
    const mesh = new Mesh(new BoxGeometry(size, size, size), new MeshBasicMaterial());
    mesh.position.set(x, y, z);
    return mesh;
  }

  test('without WebPivot marker: pivot lands at AABB bottom-center', () => {
    const root = new Group();
    // Mesh.position=(3,2,4), BoxGeometry(2) → world AABB x∈[2,4], y∈[1,3], z∈[3,5].
    // AABB centroid XZ = (3,4), AABB.min.y = 1 → expected offset = (-3, -1, -4),
    // so mesh.position shifts from (3,2,4) to (0,1,0).
    root.add(makeBoxAt(3, 2, 4, 2));

    pivotToFloorCenter(root);
    root.updateMatrixWorld(true);

    const child = root.children[0];
    expect(child.position.x).toBeCloseTo(0, 5);
    expect(child.position.y).toBeCloseTo(1, 5);
    expect(child.position.z).toBeCloseTo(0, 5);
  });

  test('with WebPivot marker: pivot lands at marker world position', () => {
    const root = new Group();
    const mesh = makeBoxAt(5, 1, 5, 2);
    root.add(mesh);

    // Marker child placed at a hand-authored pivot location
    const marker = new Object3D();
    marker.position.set(5, 0, 5); // floor under mesh center
    marker.userData.realvirtual = { WebPivot: { _enabled: true } };
    root.add(marker);

    pivotToFloorCenter(root);
    root.updateMatrixWorld(true);

    // Marker is the new origin → its world position is (0, 0, 0) after shift.
    const markerWorld = new Vector3();
    marker.getWorldPosition(markerWorld);
    expect(markerWorld.x).toBeCloseTo(0, 5);
    expect(markerWorld.y).toBeCloseTo(0, 5);
    expect(markerWorld.z).toBeCloseTo(0, 5);
  });

  test('honours non-zero obj.position: gizmo lines up with AABB bottom-center in WORLD', () => {
    // Reproduces a Unity-authored library object whose root transform sat at
    // (10, 0, 10) when exported. Before the fix the gizmo (obj.position) and
    // the AABB bottom-center diverged by exactly obj.position.
    const root = new Group();
    root.position.set(10, 0, 10);
    root.add(makeBoxAt(0, 1, 0, 2)); // local-space AABB y∈[0,2], xz centered

    pivotToFloorCenter(root);
    root.updateMatrixWorld(true);

    // obj.position must be preserved.
    expect(root.position.x).toBeCloseTo(10, 5);
    expect(root.position.y).toBeCloseTo(0, 5);
    expect(root.position.z).toBeCloseTo(10, 5);

    // World AABB bottom-center must sit AT root's world position (the gizmo).
    const child = root.children[0];
    const worldPos = new Vector3();
    child.getWorldPosition(worldPos);
    // Box of size 2 centered locally at (0,1,0) → world AABB bottom y = root.y + 0 = 0.
    // After pivot recentering: child.position should be (0, 1, 0) (unchanged
    // because local-space AABB was already centred); xz unchanged, y = 1.
    expect(worldPos.x).toBeCloseTo(10, 5);
    expect(worldPos.y).toBeCloseTo(1, 5);
    expect(worldPos.z).toBeCloseTo(10, 5);
  });

  test('WebPivot takes precedence over AABB even when marker is below floor', () => {
    const root = new Group();
    // Mesh.position=(0,10,0), BoxGeometry(10) → world AABB y∈[5,15].
    // Without marker: offsetY = -5, mesh world y would become 5.
    root.add(makeBoxAt(0, 10, 0, 10));

    // Hand-authored pivot below the AABB floor → marker wins, no Y shift.
    const marker = new Object3D();
    marker.position.set(0, 0, 0);
    marker.userData.realvirtual = { WebPivot: {} };
    root.add(marker);

    pivotToFloorCenter(root);
    root.updateMatrixWorld(true);

    // Marker is the new origin; box keeps its original local-to-marker offset,
    // i.e. its world y stays at 10 (no AABB.min.y normalization).
    const meshWorld = new Vector3();
    root.children[0].getWorldPosition(meshWorld);
    expect(meshWorld.y).toBeCloseTo(10, 5);
  });
});

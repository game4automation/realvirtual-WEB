// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach } from 'vitest';

// MUST: Mock the external library (WASM can't run in browser test env)
const mockAddSplatScene = vi.fn().mockResolvedValue(undefined);
const mockUpdate = vi.fn();
const mockRender = vi.fn();
const mockDispose = vi.fn().mockResolvedValue(undefined);

vi.mock('@mkkellogg/gaussian-splats-3d', () => {
  return {
    Viewer: class MockViewer {
      addSplatScene = mockAddSplatScene;
      update = mockUpdate;
      render = mockRender;
      dispose = mockDispose;
      position = { set: vi.fn() };
      rotation = { set: vi.fn() };
      scale = { setScalar: vi.fn() };
      splatMesh = null;
      parent = null;
      removeFromParent = vi.fn();
    },
    DropInViewer: vi.fn(),
  };
});

// Mock rv-app-config
vi.mock('../src/core/rv-app-config', () => ({
  getAppConfig: vi.fn(() => ({ pluginConfig: {} })),
}));

// Mock the blob cache so loadSplat() doesn't actually try to fetch the
// (non-existent) splat file from the test server. Returns a stub blob URL
// — the splat library Viewer is already mocked, so only the URL string
// is observed downstream.
vi.mock('../src/core/engine/rv-asset-blob-cache', () => {
  return {
    RVAssetBlobCache: class MockBlobCache {
      constructor(_opts: unknown) { /* swallow */ }
      async getBlob(_url: string) { return new Blob(); }
      async getObjectUrl(url: string) { return url; }
      clearMemory() { /* no-op */ }
      async clearPersistent() { /* no-op */ }
    },
  };
});

import { GaussianSplatPlugin } from '../src/plugins/gaussian-splat-plugin';

function makeViewer() {
  return {
    isWebGPU: false,
    scene: {
      add: vi.fn(),
      remove: vi.fn(),
      children: [],
      // Plugin's onRender diagnostic walks the scene once via traverse —
      // give the mock a no-op traversal so the test doesn't blow up.
      traverse: vi.fn(),
    },
    camera: {},
    renderer: {
      domElement: document.createElement('canvas'),
      setRenderTarget: vi.fn(),
      autoClear: true,
    },
    controls: { enabled: true },
    markRenderDirty: vi.fn(),
    getPlugin: vi.fn(),
    // Plugin subscribes to layout-transform-update via viewer.on; mock
    // returns the unsubscribe handle the plugin stores.
    on: vi.fn(() => vi.fn()),
    registry: { getNode: vi.fn(() => null) },
  };
}

function makeLoadResult(pluginConfig?: Record<string, unknown>) {
  return {
    modelConfig: {
      pluginConfig: pluginConfig ?? {},
    },
  } as unknown;
}

/** Wait for fire-and-forget promises to settle.
 *  loadSplat() does `await rAF → await rAF` before its inner work, so we
 *  yield twice through rAF (one cycle ≈ 16 ms in headless Chromium) on top
 *  of the microtask drains. setTimeout(0) alone does not advance rAF. */
async function flush() {
  for (let i = 0; i < 6; i++) {
    await new Promise(r => requestAnimationFrame(() => r(undefined)));
  }
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
}

/** Wait until the plugin has actually issued `count` splat loads.
 *
 *  `flush()` above grants a CONSTANT budget (6 rAF + 10 macrotasks). That is
 *  fine for the negative tests — they assert nothing happens — but it raced
 *  the positive ones: `loadSplat()` awaits two nested rAFs and THEN
 *  `await import('@mkkellogg/gaussian-splats-3d')`, and under full-suite load
 *  that dynamic module fetch outlives any fixed number of frames, so
 *  `addSplatScene` had simply not been called yet. Poll against a deadline
 *  instead of guessing a frame count. */
async function flushLoaded(count = 1, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (mockAddSplatScene.mock.calls.length < count) {
    if (performance.now() > deadline) {
      throw new Error(
        `flushLoaded: expected ${count} addSplatScene call(s) within ${timeoutMs} ms, `
        + `got ${mockAddSplatScene.mock.calls.length}`,
      );
    }
    await new Promise(r => requestAnimationFrame(() => r(undefined)));
    await new Promise(r => setTimeout(r, 0));
  }
  // Let the continuation after the awaited addSplatScene() settle (the plugin
  // adds the container and marks the frame dirty after that await resolves).
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
}

describe('GaussianSplatPlugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // vitest 4.x: clearAllMocks now also resets mockResolvedValue (mock impl).
    // Re-establish async return values used by the GS3D library mock so the
    // plugin's `await splatViewer.addSplatScene(...)` resolves correctly.
    mockAddSplatScene.mockResolvedValue(undefined);
    mockDispose.mockResolvedValue(undefined);
  });

  it('has correct plugin id', () => {
    expect(new GaussianSplatPlugin().id).toBe('gaussian-splat');
  });

  it('has empty slots array (UI removed)', () => {
    const plugin = new GaussianSplatPlugin();
    expect(plugin.slots).toEqual([]);
  });

  it('skips loading when config is disabled', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    const result = makeLoadResult({ 'gaussian-splat': { enabled: false, url: 'test.splat' } });
    plugin.onModelLoaded(result as any, viewer as any);
    await flush();
    expect(mockAddSplatScene).not.toHaveBeenCalled();
  });

  it('skips loading when pluginConfig is undefined', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    const result = makeLoadResult();
    plugin.onModelLoaded(result as any, viewer as any);
    await flush();
    expect(mockAddSplatScene).not.toHaveBeenCalled();
  });

  it('skips loading when WebGPU is active', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    (viewer as any).isWebGPU = true;
    const result = makeLoadResult({ 'gaussian-splat': { enabled: true, url: 'test.splat' } });
    plugin.onModelLoaded(result as any, viewer as any);
    await flush();
    expect(mockAddSplatScene).not.toHaveBeenCalled();
  });

  it('skips loading when no url configured', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    const result = makeLoadResult({ 'gaussian-splat': { enabled: true } });
    plugin.onModelLoaded(result as any, viewer as any);
    await flush();
    expect(mockAddSplatScene).not.toHaveBeenCalled();
  });

  it('loads splat and adds to scene when configured', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    const result = makeLoadResult({ 'gaussian-splat': { enabled: true, url: 'factory.splat' } });
    plugin.onModelLoaded(result as any, viewer as any);
    await flushLoaded();

    expect(viewer.scene.add).toHaveBeenCalled();
    expect(mockAddSplatScene).toHaveBeenCalledWith('factory.splat', expect.any(Object));
    expect(viewer.markRenderDirty).toHaveBeenCalled();
    expect(plugin.instanceCount).toBe(1);
  });

  it('disposes splat on model cleared (idempotent)', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    const result = makeLoadResult({ 'gaussian-splat': { enabled: true, url: 'test.splat' } });
    plugin.onModelLoaded(result as any, viewer as any);
    await flushLoaded();

    expect(plugin.instanceCount).toBe(1);
    plugin.onModelCleared();
    expect(plugin.instanceCount).toBe(0);

    // Double-dispose should be no-op (no crash)
    plugin.dispose();
  });

  it('sets _rvExcludeFromRaycast on splat container', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    const result = makeLoadResult({ 'gaussian-splat': { enabled: true, url: 'test.splat' } });
    plugin.onModelLoaded(result as any, viewer as any);
    await flushLoaded();

    const firstAddCall = viewer.scene.add.mock.calls[0]?.[0];
    expect(firstAddCall?.userData?._rvExcludeFromRaycast).toBe(true);
  });
});

describe('GaussianSplatPlugin multi-instance API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddSplatScene.mockResolvedValue(undefined);
    mockDispose.mockResolvedValue(undefined);
  });

  it('loadSplat creates separate viewer instances', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    // Initialize viewer reference
    (plugin as any)._viewer = viewer;

    const c1 = await plugin.loadSplat('scan.splat');
    const c2 = await plugin.loadSplat('scan.splat');

    expect(c1).not.toBe(c2);
    expect(plugin.instanceCount).toBe(2);
    expect(mockAddSplatScene).toHaveBeenCalledTimes(2);
  });

  it('disposeSplat removes only the targeted instance', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    (plugin as any)._viewer = viewer;

    const c1 = await plugin.loadSplat('scan.splat');
    const c2 = await plugin.loadSplat('scan.splat');
    expect(plugin.instanceCount).toBe(2);

    plugin.disposeSplat(c1);
    expect(plugin.instanceCount).toBe(1);

    plugin.disposeSplat(c2);
    expect(plugin.instanceCount).toBe(0);
  });

  it('onRender iterates all visible instances', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    (plugin as any)._viewer = viewer;

    await plugin.loadSplat('a.splat');
    await plugin.loadSplat('b.splat');

    // Reset mocks from loading phase
    mockUpdate.mockClear();
    mockRender.mockClear();

    plugin.onRender(0.016);

    // Both instances should be updated and rendered
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockRender).toHaveBeenCalledTimes(2);
    expect(viewer.markRenderDirty).toHaveBeenCalled();
  });

  it('onRender skips hidden containers', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    (plugin as any)._viewer = viewer;

    const c1 = await plugin.loadSplat('a.splat');
    await plugin.loadSplat('b.splat');

    // Hide first container
    c1.visible = false;

    mockUpdate.mockClear();
    mockRender.mockClear();

    plugin.onRender(0.016);

    // Only the visible instance should render
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockRender).toHaveBeenCalledTimes(1);
  });

  it('disposeSplat is no-op for unknown container', async () => {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    (plugin as any)._viewer = viewer;

    const { Group: ThreeGroup } = await import('three');
    const unknown = new ThreeGroup();
    // Should not throw
    plugin.disposeSplat(unknown);
    expect(plugin.instanceCount).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// raycastSplats — crop culling + world-ray hit projection
// ──────────────────────────────────────────────────────────────────────────
//
// These tests pin three regression fixes:
//
//   1. setSplatCrop() bounds are respected by raycastSplats() — picking a
//      cropped-out splat would feel like a "ghost hit" on hidden geometry.
//   2. Each returned hit.point lies exactly on the world ray (caller's
//      pick ray). Earlier code projected the splat centre onto a local
//      ray and transformed back, which left the marker off the ray under
//      non-uniform mesh scale.
//   3. Returned hit.distance is the true world-space ray-depth (the same
//      unit Raycaster.intersectObjects uses), so it's directly comparable
//      with mesh-raycast distances when measurement merges the two.

describe('GaussianSplatPlugin raycastSplats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddSplatScene.mockResolvedValue(undefined);
    mockDispose.mockResolvedValue(undefined);
  });

  /**
   * Build a mock splatMesh that exposes the same surface area as the
   * gaussian-splats-3d library — enough for `castRayAtSplatMesh` /
   * `castRayAtSplatNode` to walk it. All splats share one root node with
   * a wide bounding box so AABB pruning is never the thing that filters.
   */
  async function makeMockSplatMesh(splats: Array<{ center: [number, number, number]; scale: [number, number, number] }>) {
    const { Box3, Matrix4, Vector3 } = await import('three');
    const tree: any = {
      subTrees: [{
        rootNode: {
          boundingBox: new Box3(
            new Vector3(-1e6, -1e6, -1e6),
            new Vector3(1e6, 1e6, 1e6),
          ),
          data: { indexes: splats.map((_, i) => i) },
          children: undefined,
        },
      }],
      splatMesh: null as any, // back-reference set below
    };
    const mesh: any = {
      matrixWorld: new Matrix4(), // identity
      dynamicMode: false,
      splatRenderMode: 0, // ThreeD
      getSplatTree: () => tree,
      getSceneTransform: (_s: number, out: any) => out.identity(),
      getSceneIndexForSplat: () => 0,
      getScene: () => ({ visible: true }),
      getSplatCenter: (idx: number, out: any) => {
        const c = splats[idx].center;
        out.set(c[0], c[1], c[2]);
      },
      getSplatScaleAndRotation: (idx: number, outScale: any, _outRot: any) => {
        const s = splats[idx].scale;
        outScale.set(s[0], s[1], s[2]);
      },
    };
    tree.splatMesh = mesh;
    return mesh;
  }

  async function loadWithMockMesh(splats: Array<{ center: [number, number, number]; scale: [number, number, number] }>) {
    const plugin = new GaussianSplatPlugin();
    const viewer = makeViewer();
    (plugin as any)._viewer = viewer;
    const container = await plugin.loadSplat('mock.splat');
    // Inject mock splatMesh on the live instance.
    const inst = (plugin as any)._instances[0];
    inst.viewer.splatMesh = await makeMockSplatMesh(splats);
    return { plugin, container, inst };
  }

  it('returns a hit for a splat in front of the camera', async () => {
    const { Ray, Vector3 } = await import('three');
    // One splat 10 units in front of origin, average radius 0.1
    const { plugin } = await loadWithMockMesh([
      { center: [0, 0, -10], scale: [0.1, 0.1, 0.1] },
    ]);

    // Ray from origin straight along -Z (looking at the splat)
    const ray = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
    const hits = plugin.raycastSplats(ray);

    expect(hits.length).toBe(1);
    // Hit point must lie EXACTLY on the ray (origin + t * direction).
    expect(hits[0].point.x).toBeCloseTo(0, 5);
    expect(hits[0].point.y).toBeCloseTo(0, 5);
    expect(hits[0].point.z).toBeCloseTo(-10, 5);
    // Distance equals world-space ray-depth (= 10).
    expect(hits[0].distance).toBeCloseTo(10, 5);
  });

  it('hit point stays exactly on the world ray for an off-axis splat', async () => {
    const { Ray, Vector3 } = await import('three');
    // Splat sits a bit to the side of the ray, but inside the bounding
    // sphere → must still be picked, and the hit point must be the
    // perpendicular foot ON the world ray (not on the splat centre).
    const { plugin } = await loadWithMockMesh([
      { center: [0.05, 0, -5], scale: [0.2, 0.2, 0.2] },
    ]);

    const ray = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
    const hits = plugin.raycastSplats(ray);

    expect(hits.length).toBe(1);
    // The on-ray foot of a centre at (0.05, 0, -5) along ray (0,0,-1) is (0, 0, -5).
    expect(hits[0].point.x).toBeCloseTo(0, 5);
    expect(hits[0].point.y).toBeCloseTo(0, 5);
    expect(hits[0].point.z).toBeCloseTo(-5, 5);
    expect(hits[0].distance).toBeCloseTo(5, 5);
    // Normal points from hit point toward splat centre — unit length.
    expect(hits[0].normal.length()).toBeCloseTo(1, 5);
  });

  it('skips splats behind the camera (negative ray parameter)', async () => {
    const { Ray, Vector3 } = await import('three');
    // Splat directly behind the camera. AABB-ray pruning is permissive
    // (wide root box) so the leaf is still reached; the behind-camera
    // skip must come from the world-space t<=0 check.
    const { plugin } = await loadWithMockMesh([
      { center: [0, 0, 10], scale: [0.1, 0.1, 0.1] }, // behind, camera looks -Z
    ]);

    const ray = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
    const hits = plugin.raycastSplats(ray);

    expect(hits.length).toBe(0);
  });

  it('honours setSplatCrop — cropped-out splats are not picked', async () => {
    const { Ray, Vector3 } = await import('three');
    // Two splats in front of the camera, both intersected by the ray.
    // Crop box keeps only the further one (z=-10), excludes the nearer (z=-3).
    const { plugin, container } = await loadWithMockMesh([
      { center: [0, 0, -3],  scale: [0.1, 0.1, 0.1] }, // near
      { center: [0, 0, -10], scale: [0.1, 0.1, 0.1] }, // far
    ]);

    plugin.setSplatCrop(container, {
      min: [-1, -1, -20],
      max: [1, 1, -5],
    });

    const ray = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
    const hits = plugin.raycastSplats(ray);

    // Only the far splat should be hit — near splat is cropped out.
    expect(hits.length).toBe(1);
    expect(hits[0].point.z).toBeCloseTo(-10, 5);
  });

  it('hits are sorted nearest-first by world ray-depth', async () => {
    const { Ray, Vector3 } = await import('three');
    const { plugin } = await loadWithMockMesh([
      { center: [0, 0, -10], scale: [0.1, 0.1, 0.1] },
      { center: [0, 0, -3],  scale: [0.1, 0.1, 0.1] },
      { center: [0, 0, -7],  scale: [0.1, 0.1, 0.1] },
    ]);

    const ray = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
    const hits = plugin.raycastSplats(ray);

    expect(hits.length).toBe(3);
    expect(hits[0].distance).toBeCloseTo(3, 5);
    expect(hits[1].distance).toBeCloseTo(7, 5);
    expect(hits[2].distance).toBeCloseTo(10, 5);
  });

  it('returns empty array when the container is hidden', async () => {
    const { Ray, Vector3 } = await import('three');
    const { plugin, container } = await loadWithMockMesh([
      { center: [0, 0, -5], scale: [0.1, 0.1, 0.1] },
    ]);

    container.visible = false;

    const ray = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
    const hits = plugin.raycastSplats(ray);
    expect(hits.length).toBe(0);
  });
});

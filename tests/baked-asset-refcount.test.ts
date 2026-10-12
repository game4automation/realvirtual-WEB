// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.4 — dispose ownership of a `BakedAsset`.
 *
 * `acquire()` / `release()` count instances; `invalidate` with live instances
 * does NOT dispose; after the last `release()` on a retired asset every chunk
 * geometry is disposed exactly once; with no instances `invalidate` disposes
 * right away; a re-request after `invalidate` bakes a NEW asset.
 */
import { describe, it, expect, vi } from 'vitest';
import { Group } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import '../src/core/engine/rv-scene-loader';
import { ModelCache } from '../src/plugins/layout-planner/model-cache';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { chunkMetaOf } from '../src/core/engine/rv-bake-chunk';
import { group, uberMesh, withComponent } from './fixtures/bake-fixture';

const BLOB_URL = 'blob:rv-test/refcount.glb';
const uber = new RVUberMaterial(false);

function fakeLoader(make: () => Group): GLTFLoader {
  return { loadAsync: async (): Promise<{ scene: Group }> => ({ scene: make() }) } as unknown as GLTFLoader;
}

/** Static frame + one Drive → two chunks. */
function makeAsset(): Group {
  const root = group('Conveyor');
  root.add(uberMesh(uber, 'frame'));
  const drive = withComponent(group('Drive-Rot-Y'), 'Drive');
  drive.add(uberMesh(uber, 'roll', [1, 0, 0]));
  root.add(drive);
  return root;
}

function makeCache(): ModelCache {
  return new ModelCache(fakeLoader(makeAsset), { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
}

describe('BakedAsset refcount (plan-753 §9.4)', () => {
  it('acquire/release count; the cache hands out the same asset', async () => {
    const cache = makeCache();
    const asset = await cache.getOrLoadBaked(BLOB_URL);
    expect(asset.chunks).toHaveLength(2);
    expect(asset.instances).toBe(0);
    asset.acquire(); asset.acquire();
    expect(asset.instances).toBe(2);
    expect(await cache.getOrLoadBaked(BLOB_URL)).toBe(asset);
    asset.release();
    expect(asset.instances).toBe(1);
    expect(asset.disposed).toBe(false);
    expect(cache.getBakeStats()).toMatchObject({ assets: 1, chunks: 2, instances: 1 });
  });

  it('invalidate with live instances retires but does NOT dispose; the last release disposes once', async () => {
    const cache = makeCache();
    const asset = await cache.getOrLoadBaked(BLOB_URL);
    const spies = asset.chunks.map((c) => vi.spyOn(c.geometry, 'dispose'));
    asset.acquire(); asset.acquire();

    cache.invalidate(BLOB_URL);
    expect(asset.retired).toBe(true);
    expect(asset.disposed).toBe(false);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(cache.peekBaked(BLOB_URL)).toBeUndefined();
    // The chunk geometries are still guarded — a placement teardown must not free them.
    for (const c of asset.chunks) expect(chunkMetaOf.has(c.geometry)).toBe(true);

    asset.release();
    expect(asset.disposed).toBe(false);
    asset.release();
    expect(asset.instances).toBe(0);
    expect(asset.disposed).toBe(true);
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
    for (const c of asset.chunks) {
      expect(chunkMetaOf.has(c.geometry)).toBe(false);
      // The bake never builds a three-mesh-bvh tree on a chunk any more
      // (plan-756 step 1d); only a collision body could, and none ran here.
      expect(c.geometry.boundsTree).toBeUndefined();
    }
    // A third release is a no-op (warned), never a double dispose.
    asset.release();
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
  });

  it('invalidate with zero instances disposes at once', async () => {
    const cache = makeCache();
    const asset = await cache.getOrLoadBaked(BLOB_URL);
    const spies = asset.chunks.map((c) => vi.spyOn(c.geometry, 'dispose'));
    cache.invalidate(BLOB_URL);
    expect(asset.disposed).toBe(true);
    for (const s of spies) expect(s).toHaveBeenCalledTimes(1);
  });

  it('a request after invalidate bakes a NEW asset; the old one stays with its holders', async () => {
    const cache = makeCache();
    const first = await cache.getOrLoadBaked(BLOB_URL);
    first.acquire();
    cache.invalidate(BLOB_URL);
    const second = await cache.getOrLoadBaked(BLOB_URL);
    expect(second).not.toBe(first);
    expect(second.disposed).toBe(false);
    expect(first.disposed).toBe(false);
    expect(first.retired).toBe(true);
    first.release();
    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(false);
  });

  it('clearDecoded and dispose() follow the same rule as invalidate', async () => {
    for (const teardown of ['clearDecoded', 'dispose'] as const) {
      const cache = makeCache();
      const asset = await cache.getOrLoadBaked(BLOB_URL);
      asset.acquire();
      cache[teardown]();
      expect(asset.retired, teardown).toBe(true);
      expect(asset.disposed, teardown).toBe(false);
      expect(cache.getBakeStats().assets, teardown).toBe(0);
      asset.release();
      expect(asset.disposed, teardown).toBe(true);
    }
  });
});

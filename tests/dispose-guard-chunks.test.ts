// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.13 — the runtime dispose guard.
 *
 * `disposeSubtree` (rv-traverse-utils) and `disposeModelSubtree`
 * (rv-dispose-subtree) on a tree that carries a chunk mesh must free neither
 * the chunk geometry, nor its BVH (`disposeBoundsTree`), nor the chunk
 * material — the `BakedAsset` owns those. Everything else in the tree is
 * disposed as before.
 */
import { describe, it, expect, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import '../src/core/engine/rv-scene-loader';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { disposeSubtree } from '../src/core/engine/rv-traverse-utils';
import { disposeModelSubtree } from '../src/core/engine/rv-dispose-subtree';
import { chunkMetaOf } from '../src/core/engine/rv-bake-chunk';
import { bakeTree, chunkByKey, group, uberMesh } from './fixtures/bake-fixture';

const uber = new RVUberMaterial(false);

async function makePlacement() {
  const master = group('Asset');
  master.add(uberMesh(uber, 'frame'));
  const asset = await bakeTree(master, { uber });
  const chunk = chunkByKey(asset, 'static');

  const placement = new Group();
  placement.name = 'Placement';
  const chunkMesh = new Mesh(chunk.geometry, chunk.material);
  chunkMesh.name = 'static-chunk';
  const ownGeometry = new BoxGeometry(1, 1, 1);
  const ownMaterial = new MeshStandardMaterial();
  const ownMesh = new Mesh(ownGeometry, ownMaterial);
  ownMesh.name = 'own';
  placement.add(chunkMesh, ownMesh);

  const spies = {
    chunkDispose: vi.spyOn(chunk.geometry, 'dispose'),
    chunkBvh: vi.fn(),
    uberDispose: vi.spyOn(uber, 'dispose'),
    ownGeometry: vi.spyOn(ownGeometry, 'dispose'),
    ownMaterial: vi.spyOn(ownMaterial, 'dispose'),
  };
  // The bake itself builds NO three-mesh-bvh tree on a chunk any more (plan-756
  // step 1d); only a collision body may, with `{ indirect: true }` (§2.4a.10).
  // That is the case this guard must cover, so one is planted here — together
  // with the instance-level `disposeBoundsTree` that makes the guard observable
  // even when the prototype patch already exists in this worker.
  (chunk.geometry as unknown as { boundsTree: unknown }).boundsTree = { indirect: true };
  (chunk.geometry as unknown as { disposeBoundsTree: () => void }).disposeBoundsTree = spies.chunkBvh;
  return { asset, chunk, placement, spies };
}

describe('dispose guard for chunk geometries (plan-753 §9.13)', () => {
  it('disposeSubtree skips chunk geometry, BVH and material — frees the rest', async () => {
    const { asset, chunk, placement, spies } = await makePlacement();
    expect(chunk.geometry.boundsTree).toBeDefined();

    disposeSubtree(placement);

    expect(spies.chunkDispose).not.toHaveBeenCalled();
    expect(spies.chunkBvh).not.toHaveBeenCalled();
    expect(spies.uberDispose).not.toHaveBeenCalled();
    expect(chunk.geometry.boundsTree).toBeDefined();
    expect(spies.ownGeometry).toHaveBeenCalledTimes(1);
    expect(spies.ownMaterial).toHaveBeenCalledTimes(1);
    expect(asset.disposed).toBe(false);
  });

  it('disposeModelSubtree skips chunk geometry, BVH and material — frees the rest', async () => {
    const { asset, chunk, placement, spies } = await makePlacement();
    const onMaterial = vi.fn();

    disposeModelSubtree(placement, { onMaterial });

    expect(spies.chunkDispose).not.toHaveBeenCalled();
    expect(spies.chunkBvh).not.toHaveBeenCalled();
    expect(spies.uberDispose).not.toHaveBeenCalled();
    expect(onMaterial).not.toHaveBeenCalledWith(uber);
    expect(chunk.geometry.boundsTree).toBeDefined();
    expect(spies.ownGeometry).toHaveBeenCalledTimes(1);
    expect(spies.ownMaterial).toHaveBeenCalledTimes(1);
    expect(asset.disposed).toBe(false);
  });

  it('once the asset is disposed the guard is gone and the geometry is free game again', async () => {
    const { asset, chunk, spies } = await makePlacement();
    asset.dispose();
    expect(chunkMetaOf.has(chunk.geometry)).toBe(false);
    expect(spies.chunkDispose).toHaveBeenCalledTimes(1);
    expect(spies.chunkBvh).toHaveBeenCalledTimes(1);
  });
});

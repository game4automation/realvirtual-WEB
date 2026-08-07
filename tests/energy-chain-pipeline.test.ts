// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.5 of plan-362 — render-pipeline exclusion.
 *
 * A rigged chain has to fall out of FOUR scene-wide passes. Three of them
 * (material dedup, uber bake, layout-planner aux raycast targets) walk EVERY
 * mesh and knew nothing about skinning before Phase 0; the fourth (batching)
 * already excluded `mesh.skeleton` by contract and is verified here rather than
 * assumed.
 *
 * Modelled on `tests/rv-lamp-pipeline.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { Mesh, Object3D, SkinnedMesh } from 'three';
import { BatchTable } from '../src/core/engine/rv-batch-table';
import { buildBatchedScene } from '../src/core/engine/rv-batched-render';
import { deduplicateMaterials } from '../src/core/engine/rv-material-dedup';
import { applyUberMaterial } from '../src/core/engine/rv-uber-material';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { RVEnergyChain } from '../src/core/engine/rv-energy-chain';
import { isRigRaycastExcluded } from '../src/core/engine/rv-traverse-utils';
import { chainHarness, transformRef } from './energy-chain-fixture';

function setup() {
  const h = chainHarness();
  const data = { Follower: transformRef('Root/Slide') };
  h.chain.userData.realvirtual = { EnergyChain: data };
  const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;
  h.scene.updateMatrixWorld(true);
  const skinned: SkinnedMesh[] = [];
  h.chain.traverse((n) => { if ((n as SkinnedMesh).isSkinnedMesh) skinned.push(n as SkinnedMesh); });
  return { h, chain, skinned };
}

describe('EnergyChain render-pipeline exclusion', () => {
  it('survives material dedup with its own material instances', () => {
    const { h, skinned } = setup();
    const before = skinned.map(m => m.material);
    const dedup = deduplicateMaterials(h.root);
    for (let i = 0; i < skinned.length; i++) {
      expect(skinned[i].material).toBe(before[i]);
      expect(dedup.uniqueMaterials.has(skinned[i].material as never)).toBe(true);
    }
  });

  it('is never uber-baked, and neither is its shared geometry', () => {
    const { h, chain, skinned } = setup();
    const dedup = deduplicateMaterials(h.root);
    const before = skinned.map(m => ({ mat: m.material, geo: m.geometry }));
    applyUberMaterial(h.root, dedup.uniqueMaterials, false);

    for (let i = 0; i < skinned.length; i++) {
      expect(skinned[i].userData._rvUberBaked).toBeUndefined();
      expect(skinned[i].material).toBe(before[i].mat);
      expect(skinned[i].geometry).toBe(before[i].geo);
      // The bake writes color/rmPacked attributes in place — a rig geometry
      // must not carry them, or dispose() would hand back mutated CAD data.
      expect(skinned[i].geometry.userData._rvUberBaked).toBeUndefined();
      expect(skinned[i].geometry.getAttribute('color')).toBeUndefined();
      expect(skinned[i].geometry.getAttribute('skinIndex')).toBeDefined();
    }
    // The deactivated originals share that geometry and are excluded too.
    const original = h.chain.getObjectByName('28') as Mesh;
    expect(original.userData._rvUberBaked).toBeUndefined();
    expect(chain.pickProxy!.userData._rvUberBaked).toBeUndefined();
  });

  it('is excluded from batching by the existing skeleton contract', async () => {
    const { h, chain, skinned } = setup();
    const dedup = deduplicateMaterials(h.root);
    const uber = applyUberMaterial(h.root, dedup.uniqueMaterials, false);
    h.root.updateMatrixWorld(true);

    const table = new BatchTable();
    await buildBatchedScene(h.root, uber.sharedMaterial, new Set<Object3D>(), table);

    for (const mesh of skinned) {
      expect(mesh.userData._rvBatchSource).toBeUndefined();
    }
    expect(chain.pickProxy!.userData._rvBatchSource).toBeUndefined();
  });

  it('exposes the proxy — and only the proxy — to the planner drop path', () => {
    const { h, chain } = setup();
    // Reproduces the aux-target registration of
    // `layout-planner/scene-mutations.ts`, which registers EVERY mesh.
    const registered: Object3D[] = [];
    h.chain.traverse((node) => {
      if (!(node as Mesh).isMesh) return;
      if (node.userData?._highlightOverlay || node.userData?._isGhostOverlay) return;
      if (isRigRaycastExcluded(node)) return;
      registered.push(node);
    });
    expect(registered).toEqual([chain.pickProxy]);
  });

  it('registers the picking hull with the raycast host through the manager', () => {
    const h = chainHarness();
    const added: Array<[Object3D, Object3D]> = [];
    const removed: Object3D[] = [];
    h.energyChainManager.setRaycastHost({
      addAuxRaycastTarget: (m, o) => { added.push([m, o]); },
      removeAuxRaycastTarget: (m) => { removed.push(m); },
    });

    const data = { Follower: transformRef('Root/Slide') };
    h.chain.userData.realvirtual = { EnergyChain: data };
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;

    expect(added).toEqual([[chain.pickProxy, h.chain]]);
    const proxy = chain.pickProxy!;
    chain.dispose();
    expect(removed).toEqual([proxy]);
  });

  it('back-fills already-rigged chains when the raycast host arrives later', () => {
    // Chains rig during scene loading; the raycast manager only exists after it.
    const { h, chain } = setup();
    const added: Object3D[] = [];
    h.energyChainManager.setRaycastHost({
      addAuxRaycastTarget: (m) => { added.push(m); },
      removeAuxRaycastTarget: () => {},
    });
    expect(added).toEqual([chain.pickProxy]);
  });
});

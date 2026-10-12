// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.5 of plan-362 — render-pipeline exclusion.
 *
 * A rigged chain has to fall out of FOUR scene-wide passes. Three of them
 * (material dedup, uber bake, layout-planner aux raycast targets) walk EVERY
 * mesh and knew nothing about skinning before Phase 0; the fourth (the bake,
 * plan-753) keeps skinned meshes by contract and is verified here rather than
 * assumed.
 *
 * Modelled on `tests/rv-lamp-pipeline.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { Mesh, Object3D, SkinnedMesh, Vector3 } from 'three';
import { freezeStaticMatrices } from '../src/core/engine/rv-freeze-static';
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
  it('still deforms visible vertices after the loader freezes static matrices', () => {
    const { h, chain, skinned } = setup();
    // The follower is an external moving transform, as with the Festo drive.
    freezeStaticMatrices(h.root, [h.follower]);
    const mesh = skinned[0];
    const positions = mesh.geometry.getAttribute('position');
    h.moveFollower(-200);
    chain.updatePose(0.016);
    h.scene.updateMatrixWorld(true);
    let movement = 0;
    const original = new Vector3(), deformed = new Vector3();
    for (let i = 0; i < positions.count; i += 37) {
      original.fromBufferAttribute(positions, i);
      mesh.applyBoneTransform(i, deformed.copy(original));
      movement = Math.max(movement, original.distanceTo(deformed));
    }
    expect(movement).toBeGreaterThan(0.01);
    expect(chain.skeleton!.bones.every(bone => bone.matrixWorldAutoUpdate)).toBe(true);
  });

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

// ─── plan-753: exclusion under the loader bake ──────────────────────────
import { bake } from '../src/core/engine/rv-bake-pipeline';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';

describe('EnergyChain under bake() (plan-753)', () => {
  it('the skinned rig and the pick proxy are keep meshes — never staged into a chunk', async () => {
    const { h, chain, skinned } = setup();
    const dedup = deduplicateMaterials(h.root);
    const uber = applyUberMaterial(h.root, dedup.uniqueMaterials, false);
    h.root.updateMatrixWorld(true);
    const staged = new Set<Mesh>();
    const baked = await bake(h.root, { assetId: 'chain', uberMaterial: uber.sharedMaterial, pickPort: createPickBuildPort({ createWorker: () => null }), onStaged: (m) => staged.add(m) });
    const keep = new Set(baked.keep.map((k) => k.mesh));
    for (const mesh of skinned) {
      expect(staged.has(mesh)).toBe(false);
      expect(keep.has(mesh)).toBe(true);
    }
    expect(staged.has(chain.pickProxy as Mesh)).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.8 of plan-362 — GLB round trip (F13). NOT skipped: the scene is
 * synthetic, exactly like `tests/rv-asset-glb-export.test.ts`.
 *
 * The exported file must contain the UNDEFORMED ORIGINAL meshes and none of
 * the runtime rig: no bones, no skin attributes, no picking hull. The rig is
 * deterministically reproducible from the rv_extras on load, and glTF skin
 * round trips are a documented minefield — so the strategy is "restore the
 * original", not `SkeletonUtils.clone()`.
 *
 * Equally important and easy to get wrong: the LIVE scene must be untouched
 * afterwards. The restore runs on the export clone only, and `Object3D.clone()`
 * SHARES geometry — so the skin attributes have to be dropped from a copy.
 */

import { describe, expect, it } from 'vitest';
import { Mesh, Object3D, SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { RVEnergyChain } from '../src/core/engine/rv-energy-chain';
import { chainHarness, transformRef } from './energy-chain-fixture';

async function exportAndReload(root: Object3D): Promise<Object3D> {
  const buffer = await exportAssetGlb(root, 'ChainAsset');
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(buffer, '');
  return gltf.scene;
}

function setup() {
  const h = chainHarness();
  const data = { Follower: transformRef('Root/Slide') };
  h.chain.userData.realvirtual = { EnergyChain: data };
  const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;
  h.scene.updateMatrixWorld(true);
  return { h, chain };
}

describe('EnergyChain GLB export', () => {
  it('exports the original meshes and nothing of the rig', async () => {
    const { h } = setup();
    h.moveFollower(-200);
    (h.chain.userData._rvEnergyChain as RVEnergyChain).updatePose(0.016);
    h.scene.updateMatrixWorld(true);

    const reloaded = await exportAndReload(h.chain);

    const names: string[] = [];
    let skinned = 0, bones = 0, proxies = 0, skinAttrs = 0;
    reloaded.traverse((node) => {
      names.push(node.name);
      if ((node as SkinnedMesh).isSkinnedMesh) skinned++;
      if ((node as unknown as { isBone?: boolean }).isBone) bones++;
      if (node.userData?._rvEnergyChainProxy || node.name === '__rvEnergyChainProxy') proxies++;
      const geo = (node as Mesh).geometry;
      if (geo?.getAttribute?.('skinIndex')) skinAttrs++;
    });

    expect(skinned).toBe(0);
    expect(bones).toBe(0);
    expect(proxies).toBe(0);
    expect(skinAttrs).toBe(0);
    expect(names).not.toContain('__rvEnergyChainBones');
    expect(names.some(n => n.includes('__rvChainSkin'))).toBe(false);
  });

  it('exports the originals VISIBLE and with their authored geometry', async () => {
    const { h } = setup();
    const reloaded = await exportAndReload(h.chain);

    const meshes: Mesh[] = [];
    reloaded.traverse((n) => { if ((n as Mesh).isMesh) meshes.push(n as Mesh); });
    expect(meshes.length).toBe(2);           // the two CAD source meshes
    for (const mesh of meshes) {
      expect(mesh.visible).toBe(true);
      expect(mesh.geometry.getAttribute('position').count).toBeGreaterThan(100);
    }
  });

  it('carries the EnergyChain rv_extras through so the rig rebuilds on load', async () => {
    const { h } = setup();
    const reloaded = await exportAndReload(h.chain);
    const rv = reloaded.userData?.realvirtual as Record<string, unknown> | undefined;
    expect(rv).toBeDefined();
    const cfg = rv!.EnergyChain as Record<string, unknown>;
    expect(cfg).toBeDefined();
    expect(cfg.Follower).toBeDefined();
  });

  it('leaves the LIVE scene fully rigged after the export', async () => {
    const { h, chain } = setup();
    const skeletonBefore = chain.skeleton;
    await exportAndReload(h.chain);

    expect(chain.isRigged).toBe(true);
    expect(chain.skeleton).toBe(skeletonBefore);
    const original = h.chain.getObjectByName('28') as Mesh;
    expect(original.visible).toBe(false);
    // The shared geometry must still carry the skin attributes — dropping them
    // on the clone must not have reached through the shared reference.
    expect(original.geometry.getAttribute('skinIndex')).toBeDefined();
    let skinned = 0;
    h.chain.traverse((n) => { if ((n as SkinnedMesh).isSkinnedMesh) skinned++; });
    expect(skinned).toBe(2);
  });

  it('does not lose an author-hidden source mesh', async () => {
    // glTF has no visibility concept, so the FILE cannot carry `visible` — but
    // the mesh must still be in it. The export runs with `onlyVisible: false`
    // for exactly this reason, and the restore hook must hand the rig's hidden
    // originals back to it rather than leaving them looking like runtime junk.
    const h = chainHarness();
    const bend = h.chain.getObjectByName('31') as Mesh;
    bend.visible = false;                    // authored as hidden BEFORE rigging
    const data = { Follower: transformRef('Root/Slide') };
    h.chain.userData.realvirtual = { EnergyChain: data };
    const chain = constructComponentOnNode(
      h.deps, h.chain, 'EnergyChain', data,
    ) as RVEnergyChain;
    h.scene.updateMatrixWorld(true);

    const reloaded = await exportAndReload(h.chain);
    const byName = new Map<string, Object3D>();
    reloaded.traverse((n) => byName.set(n.name, n));
    expect(byName.has('28')).toBe(true);
    expect(byName.has('31')).toBe(true);

    // …and disposing puts the authored flag back on the LIVE mesh, rather than
    // making every rigged part visible again.
    chain.dispose();
    expect(h.chain.getObjectByName('28')!.visible).toBe(true);
    expect(h.chain.getObjectByName('31')!.visible).toBe(false);
  });
});

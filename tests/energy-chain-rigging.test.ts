// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.3 of plan-362 — skinning invariants.
 *
 * Every assertion here covers something whose violation shows up ONLY as a
 * silent graphics artefact: weights that do not sum to 1 make vertices
 * explode, an out-of-range bone index renders garbage, and a per-mesh skeleton
 * would tear a multi-mesh chain apart at the seam without any error anywhere.
 */

import { describe, expect, it } from 'vitest';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { RVEnergyChain } from '../src/core/engine/rv-energy-chain';
import { minimumBoneCount } from '../src/core/engine/rv-energy-chain-path';
import { chainHarness, transformRef } from './energy-chain-fixture';

function rig(bones?: number): { chain: RVEnergyChain; h: ReturnType<typeof chainHarness> } {
  const h = chainHarness();
  const data: Record<string, unknown> = { Follower: transformRef('Root/Slide') };
  if (bones !== undefined) data.Bones = bones;
  h.chain.userData.realvirtual = { EnergyChain: data };
  const chain = constructComponentOnNode(
    h.deps, h.chain, 'EnergyChain', data,
  ) as RVEnergyChain;
  return { chain, h };
}

describe('EnergyChain rigging invariants', () => {
  it('rigs the two-mesh reference chain and measures it', () => {
    const { chain } = rig();
    expect(chain.isRigged).toBe(true);
    expect(chain.diagnosis).toBe('ok');
    expect(chain.calibration!.status).toBe('ok');
    expect(chain.calibration!.axis).toBe('Z');
    expect(chain.calibration!.bendRadiusMm).toBeCloseTo(55, 1);
    expect(chain.calibration!.linkHeightMm).toBeCloseTo(35, 1);
    expect(chain.calibration!.chainLengthMm).toBeCloseTo(815, 0);
  });

  it('normalizes every skin weight to exactly 1', () => {
    const { h } = rig();
    let checked = 0;
    h.chain.traverse((node) => {
      const sm = node as unknown as { isSkinnedMesh?: boolean; geometry?: never };
      if (!sm.isSkinnedMesh) return;
      const geo = (node as unknown as { geometry: { getAttribute(n: string): { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number; getW(i: number): number } } }).geometry;
      const wgt = geo.getAttribute('skinWeight');
      for (let i = 0; i < wgt.count; i++) {
        const sum = wgt.getX(i) + wgt.getY(i) + wgt.getZ(i) + wgt.getW(i);
        expect(sum).toBeCloseTo(1, 5);
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(1000);
  });

  it('keeps every skin index inside the bone array', () => {
    const { chain, h } = rig();
    const boneCount = chain.skeleton!.bones.length;
    h.chain.traverse((node) => {
      if (!(node as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return;
      const geo = (node as unknown as { geometry: { getAttribute(n: string): { count: number; getX(i: number): number; getY(i: number): number } } }).geometry;
      const idx = geo.getAttribute('skinIndex');
      for (let i = 0; i < idx.count; i++) {
        expect(idx.getX(i)).toBeLessThan(boneCount);
        expect(idx.getY(i)).toBeLessThan(boneCount);
      }
    });
  });

  it('binds ALL source meshes to the SAME skeleton instance', () => {
    const { chain, h } = rig();
    const skeletons: unknown[] = [];
    h.chain.traverse((node) => {
      const sm = node as unknown as { isSkinnedMesh?: boolean; skeleton?: unknown };
      if (sm.isSkinnedMesh) skeletons.push(sm.skeleton);
    });
    expect(skeletons.length).toBe(2);          // strands mesh + bend mesh
    expect(skeletons[0]).toBe(chain.skeleton);
    expect(skeletons[1]).toBe(chain.skeleton);
  });

  it('hides the originals and marks them as rig sources', () => {
    const { h } = rig();
    const strands = h.chain.getObjectByName('28')!;
    const bend = h.chain.getObjectByName('31')!;
    expect(strands.visible).toBe(false);
    expect(bend.visible).toBe(false);
    expect(strands.userData._rvEnergyChainSource).toBe(true);
    expect(bend.userData._rvEnergyChainSource).toBe(true);
  });

  it('clamps an under-specified bone count and says so in the status line', () => {
    const { chain } = rig(8);
    const minimum = minimumBoneCount();
    expect(minimum).toBe(21);
    expect(chain.skeleton!.bones.length).toBe(minimum);
    expect(chain.statusLine).toContain('Bones raised to 21');
  });

  it('accepts a bone count above the minimum unchanged', () => {
    const { chain } = rig(32);
    expect(chain.skeleton!.bones.length).toBe(32);
    expect(chain.statusLine).not.toContain('Bones raised');
  });

  it('registers an invisible picking proxy instead of raycasting the skin', () => {
    const { chain } = rig();
    const proxy = chain.pickProxy!;
    expect(proxy).toBeDefined();
    expect(proxy.visible).toBe(false);
    expect(proxy.userData._rvEnergyChainProxy).toBe(true);
    expect(proxy.parent).toBe(chain.node);
  });

  it('restores the original scene completely on dispose', () => {
    const { chain, h } = rig();
    chain.dispose();
    const strands = h.chain.getObjectByName('28')!;
    const bend = h.chain.getObjectByName('31')!;
    expect(strands.visible).toBe(true);
    expect(bend.visible).toBe(true);
    expect(strands.userData._rvEnergyChainSource).toBeUndefined();
    expect((strands as unknown as { geometry: { getAttribute(n: string): unknown } }).geometry.getAttribute('skinIndex')).toBeUndefined();
    let leftovers = 0;
    h.chain.traverse((node) => {
      if ((node as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) leftovers++;
      if (node.userData?._rvEnergyChainProxy) leftovers++;
      if (node.name === '__rvEnergyChainBones') leftovers++;
    });
    expect(leftovers).toBe(0);
    expect(chain.isRigged).toBe(false);
  });

  it('degrades without throwing when the node carries no geometry', () => {
    const h = chainHarness();
    h.chain.remove(...h.chain.children);
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', {}) as RVEnergyChain;
    expect(chain.isRigged).toBe(false);
    expect(chain.diagnosis).toBe('no-geometry');
    expect(chain.statusLine.length).toBeGreaterThan(0);
  });

  it('holds the rest pose and reports the stage when no follower is known', () => {
    const h = chainHarness();
    const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', {}) as RVEnergyChain;
    expect(chain.isRigged).toBe(true);
    expect(chain.diagnosis).toBe('degraded-assignment');
    expect(chain.statusLine).toContain('No follower');
    h.moveFollower(-200);
    expect(chain.updatePose(0.016)).toBe(false);
  });
});

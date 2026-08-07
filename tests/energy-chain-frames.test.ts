// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.10 of plan-362 — the three integration cases V1 promises.
 *
 * 1. A MOVED KINEMATIC PARENT must translate the chain as a whole and change
 *    nothing about its relative pose — and must NOT trigger a re-rig. This is
 *    the direct check on Re-Challenge R1: a structure signature that contained
 *    world matrices would swap the `Skeleton` on every frame of ordinary motion.
 * 2. TWO CHAINS on the same follower rig independently and share nothing.
 * 3. DRIVE-FREE operation in BOTH travel directions plus overstretch — the
 *    symmetric envelope of Re-Challenge R3.
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { RVEnergyChain } from '../src/core/engine/rv-energy-chain';
import { followerRange } from '../src/core/engine/rv-energy-chain-path';
import { chainHarness, makeChainMeshes, transformRef } from './energy-chain-fixture';

function rig(h: ReturnType<typeof chainHarness>): RVEnergyChain {
  const data = { Follower: transformRef('Root/Slide') };
  h.chain.userData.realvirtual = { EnergyChain: data };
  return constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;
}

/** Bone positions in the chain-local frame — invariant under root motion. */
function localBonePositions(chain: RVEnergyChain): Vector3[] {
  return chain.skeleton!.bones.map(b => b.position.clone());
}

describe('EnergyChain reference frames', () => {
  it('moves as a whole with a kinematic parent, without deforming or re-rigging', () => {
    const h = chainHarness();
    const chain = rig(h);
    const skeletonBefore = chain.skeleton;
    const posesBefore = localBonePositions(chain);
    const bendBefore = chain.bendCenter;

    // The parent moves AND rotates — the case that a world-space implementation
    // would turn into a double transform.
    const parent = new Object3D();
    parent.name = 'Portal';
    h.root.add(parent);
    parent.add(h.chain);
    // The follower rides the SAME assembly — that is what "moves as a whole"
    // means. A follower left behind genuinely changes the relative pose and the
    // chain SHOULD deform then (asserted in the next test).
    parent.add(h.follower);
    parent.position.set(2.5, 1.25, -3);
    parent.rotation.set(0.3, Math.PI / 4, -0.2);
    h.scene.updateMatrixWorld(true);

    expect(chain.updatePose(0.016)).toBe(false);   // nothing about the chain changed
    expect(chain.skeleton).toBe(skeletonBefore);   // R1: no re-rig on motion
    expect(chain.bendCenter).toBeCloseTo(bendBefore, 12);

    const posesAfter = localBonePositions(chain);
    for (let i = 0; i < posesBefore.length; i++) {
      expect(posesAfter[i].distanceTo(posesBefore[i])).toBeLessThan(1e-12);
    }
  });

  it('still follows correctly after the parent has moved', () => {
    const h = chainHarness();
    const chain = rig(h);

    const parent = new Object3D();
    h.root.add(parent);
    parent.add(h.chain);
    parent.add(h.follower);
    parent.position.set(1, 0, 2);
    h.scene.updateMatrixWorld(true);

    const bendBefore = chain.bendCenter;
    h.moveFollower(-200);
    expect(chain.updatePose(0.016)).toBe(true);
    // Half the follower travel, independent of where the parent sits.
    expect((chain.bendCenter - bendBefore) * 1000).toBeCloseTo(-100, 6);
  });

  it('rigs two chains on the same follower independently', () => {
    const h = chainHarness();
    const first = rig(h);

    const second = new Object3D();
    second.name = 'EnergyChain2';
    const { strands, bend } = makeChainMeshes();
    second.add(strands, bend);
    second.position.set(0.5, 0, 0);
    h.root.add(second);
    h.scene.updateMatrixWorld(true);
    h.registry.registerNode('Root/EnergyChain2', second);
    const data = { Follower: transformRef('Root/Slide') };
    second.userData.realvirtual = { EnergyChain: data };
    const other = constructComponentOnNode(h.deps, second, 'EnergyChain', data) as RVEnergyChain;

    expect(other.isRigged).toBe(true);
    expect(other.skeleton).not.toBe(first.skeleton);
    expect(h.energyChainManager.size).toBe(2);

    h.moveFollower(-150);
    expect(h.energyChainManager.update(0.016)).toBe(true);
    // Same geometry, same follower, same travel — both bends land on the same
    // chain-local coordinate, each computed on its own skeleton.
    expect(first.bendCenter - other.bendCenter).toBeCloseTo(0, 9);
    expect(Number.isFinite(other.bendCenter)).toBe(true);
  });

  it('follows a plain transform in BOTH directions without any drive', () => {
    const h = chainHarness();
    const chain = rig(h);
    const start = chain.bendCenter;

    h.moveFollower(-300);
    expect(chain.updatePose(0.016)).toBe(true);
    expect((chain.bendCenter - start) * 1000).toBeCloseTo(-150, 6);

    h.moveFollower(600);   // now 300 mm on the OTHER side of the rest pose
    expect(chain.updatePose(0.016)).toBe(true);
    expect((chain.bendCenter - start) * 1000).toBeCloseTo(150, 6);
    expect(chain.diagnosis).toBe('ok');
  });

  it('reports overstretch and clamps instead of drawing nonsense', () => {
    const h = chainHarness();
    const chain = rig(h);
    const range = followerRange({
      a: chain.calibration!.lowEnd,
      R: chain.calibration!.bendRadiusMm / 1000,
      L: chain.calibration!.chainLengthMm / 1000,
    });
    const reachMm = (range.max - range.min) * 1000 / 2;
    expect(reachMm).toBeGreaterThan(600);   // 815 − π·55 ≈ 642 mm

    h.moveFollower(-(reachMm + 200));
    chain.updatePose(0.016);
    expect(chain.diagnosis).toBe('overstretched');
    expect(chain.statusLine).toContain('Overstretched');
    expect(Number.isFinite(chain.bendCenter)).toBe(true);

    h.moveFollower(reachMm + 200);   // back into range
    chain.updatePose(0.016);
    expect(chain.diagnosis).toBe('ok');
  });

  it('covers both end positions with the picking envelope', () => {
    const h = chainHarness();
    const chain = rig(h);
    const proxy = chain.pickProxy!;
    proxy.geometry.computeBoundingBox();
    const box = proxy.geometry.boundingBox!.clone().applyMatrix4(proxy.matrix);

    const reach = (chain.calibration!.chainLengthMm / 1000)
      - Math.PI * (chain.calibration!.bendRadiusMm / 1000);
    const a = chain.calibration!.lowEnd;
    // The envelope is SYMMETRIC around the anchor — the reference chain travels
    // toward negative Z, so a one-sided hull would miss half the stroke.
    expect(box.min.z).toBeLessThanOrEqual(a - reach + 1e-6);
    expect(box.max.z).toBeGreaterThanOrEqual(a + reach - 1e-6);
  });
});

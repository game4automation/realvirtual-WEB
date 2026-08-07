// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Test 9.4 of plan-362 — rest-pose identity, the core contract of F5/F6.
 *
 * With the follower at its rest position the ACTUALLY SKINNED geometry must
 * equal the CAD input. It is evaluated through `SkinnedMesh.applyBoneTransform()`
 * — the CPU-side evaluation of the skinning, including bind and world matrices.
 * Comparing `position` attributes instead would be tautologically green: GPU
 * skinning never writes back to them, so such a test passes even with a
 * completely broken skeleton.
 *
 * Tolerance 0.05 mm, derived from float32 precision at ~1 m part size
 * (resolution ≈ 6e-5 mm), not guessed. Runs over BOTH source meshes.
 */

import { describe, expect, it } from 'vitest';
import { SkinnedMesh, Vector3 } from 'three';
import { constructComponentOnNode } from '../src/core/engine/rv-scene-loader';
import { RVEnergyChain } from '../src/core/engine/rv-energy-chain';
import { chainHarness, transformRef } from './energy-chain-fixture';

const TOL = 0.05 / 1000;   // 0.05 mm in metres

function skinnedMeshes(root: import('three').Object3D): SkinnedMesh[] {
  const out: SkinnedMesh[] = [];
  root.traverse((n) => {
    if ((n as SkinnedMesh).isSkinnedMesh) out.push(n as SkinnedMesh);
  });
  return out;
}

/** Largest deviation between the skinned and the authored local position. */
function maxRestDeviation(mesh: SkinnedMesh): number {
  const pos = mesh.geometry.getAttribute('position');
  const v = new Vector3();
  const original = new Vector3();
  let worst = 0;
  const step = Math.max(1, Math.floor(pos.count / 400));
  for (let i = 0; i < pos.count; i += step) {
    original.fromBufferAttribute(pos as never, i);
    v.copy(original);
    mesh.applyBoneTransform(i, v);
    worst = Math.max(worst, v.distanceTo(original));
  }
  return worst;
}

function setup() {
  const h = chainHarness();
  const data = { Follower: transformRef('Root/Slide') };
  h.chain.userData.realvirtual = { EnergyChain: data };
  const chain = constructComponentOnNode(h.deps, h.chain, 'EnergyChain', data) as RVEnergyChain;
  h.scene.updateMatrixWorld(true);
  return { h, chain };
}

describe('EnergyChain rest pose', () => {
  it('reproduces the CAD geometry exactly on both source meshes', () => {
    const { h, chain } = setup();
    expect(chain.diagnosis).toBe('ok');
    const meshes = skinnedMeshes(h.chain);
    expect(meshes.length).toBe(2);
    for (const mesh of meshes) {
      expect(maxRestDeviation(mesh)).toBeLessThan(TOL);
    }
  });

  it('early-outs when the follower has not moved', () => {
    const { chain } = setup();
    expect(chain.updatePose(0.016)).toBe(false);
    expect(chain.updatePose(0.016)).toBe(false);
  });

  it('starts with the bend exactly where the CAD rest pose has it', () => {
    const { chain } = setup();
    // The rig pins `L` so `solveBend` lands on the MEASURED bend center — if it
    // did not, the rest pose would already be a few millimetres off.
    expect(chain.bendCenter).toBeCloseTo(chain.calibration!.bendCenter, 9);
  });

  it('moves the bend at half the follower travel and keeps the length', () => {
    const { h, chain } = setup();
    const bendBefore = chain.bendCenter;
    const followerBefore = chain.followerScalar;

    h.moveFollower(-200);
    expect(chain.updatePose(0.016)).toBe(true);

    expect((chain.followerScalar - followerBefore) * 1000).toBeCloseTo(-200, 6);
    expect((chain.bendCenter - bendBefore) * 1000).toBeCloseTo(-100, 6);

    // The bend is also physically where the model says. The bones do not sit
    // exactly on the apex: their arc lengths are MATERIAL coordinates fixed at
    // rig time, so as the bend travels the sample grid drifts relative to it.
    // The apex is therefore under-sampled by at most `R·(1 − cos 2Δθ)` with the
    // ~10.6° bend step of a 24-bone rig, i.e. ≈ 3.7 mm at R = 55 mm. What must
    // NOT drift is the angular spacing itself — that is asserted in
    // energy-chain-path.test.ts and is what LBS quality depends on.
    const R = chain.calibration!.bendRadiusMm / 1000;
    let outermostZ = -Infinity;
    for (const b of chain.skeleton!.bones) outermostZ = Math.max(outermostZ, b.position.z);
    expect(outermostZ).toBeLessThanOrEqual(chain.bendCenter + R + 1e-9);
    expect(Math.abs(outermostZ - (chain.bendCenter + R))).toBeLessThan(R * 0.08);
  });

  it('deforms the geometry when the follower moves and returns on the way back', () => {
    const { h, chain } = setup();
    const mesh = skinnedMeshes(h.chain)[0];
    const before = maxRestDeviation(mesh);
    expect(before).toBeLessThan(TOL);

    h.moveFollower(-200);
    chain.updatePose(0.016);
    h.scene.updateMatrixWorld(true);
    expect(maxRestDeviation(mesh)).toBeGreaterThan(0.01);   // > 10 mm somewhere

    h.moveFollower(200);
    chain.updatePose(0.016);
    h.scene.updateMatrixWorld(true);
    expect(maxRestDeviation(mesh)).toBeLessThan(TOL);
  });

  it('never produces NaN, in either travel direction or beyond the range', () => {
    const { h, chain } = setup();
    const mesh = skinnedMeshes(h.chain)[0];
    const v = new Vector3();
    for (const delta of [-200, -300, 500, -2000, 2000]) {
      h.moveFollower(delta);
      chain.updatePose(0.016);
      h.scene.updateMatrixWorld(true);
      const pos = mesh.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i += 97) {
        v.fromBufferAttribute(pos as never, i);
        mesh.applyBoneTransform(i, v);
        expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
      }
    }
  });
});

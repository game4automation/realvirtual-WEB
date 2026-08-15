// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T5 — Root-link seeding contract (ABI.md "Root-link seeding", plan-404 §2.3).
 *
 * The one place the ABI needs input the C# solver got for free from the live
 * `Transform`: `KinematicSolver.ForwardKinematics()` re-reads the root link's
 * pose from Unity on every call, but the Rust core has no Transform access. When
 * `root_link_index >= 0` the HOST must pre-fill `link_pos`/`link_rot` at that
 * index before every `rvk_solve`.
 *
 * Getting this wrong is invisible on a static mechanism and produces a machine
 * that silently stays behind when its base moves — a mechanism on a moving
 * carriage, which is the normal industrial case. Hence a dedicated test.
 *
 * Guarded: skips loudly without the wasm artifact.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { KinematicSolverProvider, RVK_OK }
  from '@rv-private/kinematic-solver/rv-kinematic-solver-provider';
import { createSolverFor, fourBarRig, seedRoot, singleRevoluteRig, twoLinkChainRig }
  from './_mechanism-rigs';

let provider: KinematicSolverProvider;
let loaded = false;

beforeAll(async () => {
  provider = new KinematicSolverProvider();
  loaded = await provider.load();
});

afterEach(() => { provider?.destroyAll(); });

function requireSolver(ctx: { skip: (note?: string) => void }): boolean {
  if (!loaded) {
    ctx.skip(`rv_kinematic_solver.wasm unavailable (${provider.failure}) — plan-404 Phase 1 artifact missing`);
    return false;
  }
  return true;
}

describe('T5 — root-link seeding', () => {
  it('a rig with a REAL root link exposes a non-negative root index', (ctx) => {
    if (!requireSolver(ctx)) return;
    const { topology } = createSolverFor(provider, singleRevoluteRig());
    expect(topology.rootLinkIndex).toBeGreaterThanOrEqual(0);
  });

  it('a world-grounded rig has NO root to seed (synthetic world frame)', (ctx) => {
    if (!requireSolver(ctx)) return;
    const { topology } = createSolverFor(provider, fourBarRig());
    expect(topology.rootLinkIndex).toBe(-1);
  });

  it('a MOVED root carries the whole mechanism with it', (ctx) => {
    if (!requireSolver(ctx)) return;
    // The heart of the contract. Same joint value, root displaced by 1 m: every
    // solved link must move by the same 1 m. Without seeding, the solve would
    // reproduce the OLD pose and the mechanism would stay behind its base.
    const rig = singleRevoluteRig();
    const { topology, solver } = createSolverFor(provider, rig);
    const rootIdx = topology.rootLinkIndex;

    seedRoot(solver, topology, rig);
    solver.jointValues[0] = 25;
    expect(solver.solve(6, 0.01, 0.001).status).toBe(RVK_OK);
    const armBefore = Array.from(solver.linkPos.slice(3, 6));

    // Move the root 1 m along +Y and re-seed, exactly as the manager does each
    // tick from the live Object3D world matrix.
    solver.seedRootLinkPose(rootIdx, 0, 1, 0, 0, 0, 0, 1);
    solver.jointValues[0] = 25;
    expect(solver.solve(6, 0.01, 0.001).status).toBe(RVK_OK);
    const armAfter = Array.from(solver.linkPos.slice(3, 6));

    expect(armAfter[0]).toBeCloseTo(armBefore[0], 4);
    expect(armAfter[1] - armBefore[1]).toBeCloseTo(1, 4);
    expect(armAfter[2]).toBeCloseTo(armBefore[2], 4);
  });

  it('the solve overwrites EVERY link position, including the root slot', (ctx) => {
    if (!requireSolver(ctx)) return;
    // ABI.md: every index of link_pos/link_rot is don't-care on input except the
    // root's, and the call overwrites all of them — including the root's — with
    // the solved pose. Poison a non-root slot and confirm it is replaced.
    const rig = twoLinkChainRig();
    const { topology, solver } = createSolverFor(provider, rig);
    solver.linkPos[6] = 12345;
    solver.linkPos[7] = 12345;

    seedRoot(solver, topology, rig);
    solver.jointValues[0] = 10;
    expect(solver.solve(6, 0.01, 0.001).status).toBe(RVK_OK);

    expect(solver.linkPos[6]).not.toBe(12345);
    expect(Math.abs(solver.linkPos[6])).toBeLessThan(10);
    // And the root slot still holds the pose we seeded (it never moves).
    expect(solver.linkPos[topology.rootLinkIndex * 3]).toBeCloseTo(0, 5);
  });

  it('a rotated root rotates the whole mechanism', (ctx) => {
    if (!requireSolver(ctx)) return;
    const rig = singleRevoluteRig();
    const { topology, solver } = createSolverFor(provider, rig);

    seedRoot(solver, topology, rig);
    solver.jointValues[0] = 0;
    solver.solve(6, 0.01, 0.001);
    const armIdentity = Array.from(solver.linkPos.slice(3, 6));

    // Rotate the root 90° about Z (quaternion 0,0,sin45,cos45).
    const s = Math.SQRT1_2;
    solver.seedRootLinkPose(topology.rootLinkIndex, 0, 0, 0, 0, 0, s, s);
    solver.jointValues[0] = 0;
    solver.solve(6, 0.01, 0.001);
    const armRotated = Array.from(solver.linkPos.slice(3, 6));

    // The 500 mm arm swings from +X onto ±Y; magnitude is preserved.
    const rBefore = Math.hypot(...armIdentity);
    const rAfter = Math.hypot(...armRotated);
    expect(rAfter).toBeCloseTo(rBefore, 4);
    expect(Math.abs(armRotated[1])).toBeGreaterThan(Math.abs(armIdentity[1]));
  });

  it('seeding a NEGATIVE root index is ignored, not written out of bounds', (ctx) => {
    if (!requireSolver(ctx)) return;
    const { solver } = createSolverFor(provider, fourBarRig());
    const before = Array.from(solver.linkPos);
    solver.seedRootLinkPose(-1, 9, 9, 9, 0, 0, 0, 1);
    expect(Array.from(solver.linkPos)).toEqual(before);
  });
});

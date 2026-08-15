// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T7 — Inverse solve (plan-404 Phase 4, §9).
 *
 * The acceptance criterion is the CARTESIAN TARGET RESIDUAL, not `IK(FK(q)) == q`
 * (SOL finding 8): with redundancy many joint vectors reach the same point, so a
 * q-roundtrip is only a valid assertion where the solution is unique — which is
 * why the single-Revolute rig gets that extra check and the others do not.
 *
 * Also covered: the separate warm start (forward and inverse must not disturb
 * each other), limits, and the least-squares behaviour on an unreachable target
 * ("Klemm-Verhalten": converge to the closest pose with converged=false, never
 * diverge).
 *
 * Guarded: skips loudly without the wasm artifact.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  KinematicSolverProvider, RVK_OK, RVK_NON_FINITE, kinematicStatusText,
} from '@rv-private/kinematic-solver/rv-kinematic-solver-provider';
import {
  createSolverFor, fourBarRig, seedRoot, singleRevoluteRig, twoLinkChainRig,
} from './_mechanism-rigs';

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

describe('T7 — inverse solve', () => {
  it('drives a single Revolute onto a reachable Cartesian target', (ctx) => {
    if (!requireSolver(ctx)) return;
    const rig = singleRevoluteRig();
    const { topology, solver } = createSolverFor(provider, rig);

    // FORWARD to a known angle, then read the arm's resulting world position.
    const theta = 35;
    seedRoot(solver, topology, rig);
    solver.jointValues[0] = theta;
    expect(solver.solve(6, 0.01, 0.001).status).toBe(RVK_OK);
    const target: [number, number, number] = [
      solver.linkPos[3], solver.linkPos[4], solver.linkPos[5],
    ];

    // INVERSE back to that exact point.
    const root = rig.links[topology.rootLinkIndex];
    const result = solver.solveInverse(
      1, [0, 0, 0], target, 60, 0.01, 1e-4,
      topology.rootLinkIndex,
      [root.worldPosition.x, root.worldPosition.y, root.worldPosition.z],
      [root.worldRotation.x, root.worldRotation.y, root.worldRotation.z, root.worldRotation.w],
    );
    expect(result.status).toBe(RVK_OK);
    expect(result.converged).toBe(true);
    // Cartesian residual is the real criterion.
    expect(result.residualError).toBeLessThan(1e-2);

    // A single Revolute has a unique solution UP TO FULL TURNS, so here the
    // q-roundtrip is a valid extra assertion — modulo 360°, because the solver
    // has no reason to prefer 35° over 395° when no limits constrain it.
    // (On a redundant rig even this weaker form would not hold.)
    const solved = ((solver.jointValuesOut[0] % 360) + 360) % 360;
    expect(solved).toBeCloseTo(theta, 1);
    solver.destroy();
  });

  it('keeps inverse warm start SEPARATE from the forward one', (ctx) => {
    if (!requireSolver(ctx)) return;
    // ABI.md: inv_q / inv_free_body_rot are fully independent of q, so a
    // mechanism can be solved both ways from one handle without either
    // direction corrupting the other's warm start.
    const rig = fourBarRig();
    const { topology, solver } = createSolverFor(provider, rig);

    seedRoot(solver, topology, rig);
    solver.jointValues[0] = 4;
    solver.solve(8, 0.01, 0.001);
    const forwardQ = Array.from(solver.q);
    const forwardPose = Array.from(solver.linkPos);

    solver.solveInverse(
      2, [0, 0, 0], [0.62, 0.28, 0], 40, 0.01, 1e-4,
      topology.rootLinkIndex, null, null,
    );

    // Re-running the SAME forward solve must reproduce the same result: the
    // inverse call must not have touched q or the forward link poses.
    seedRoot(solver, topology, rig);
    solver.jointValues[0] = 4;
    solver.solve(8, 0.01, 0.001);
    expect(Array.from(solver.q)).toEqual(forwardQ);
    for (let i = 0; i < forwardPose.length; i++) {
      expect(solver.linkPos[i]).toBeCloseTo(forwardPose[i], 6);
    }
    solver.destroy();
  });

  it('an unreachable target converges least-squares, NOT to divergence', (ctx) => {
    if (!requireSolver(ctx)) return;
    // plan-269 "Klemm-Verhalten": the mechanism moves to the closest achievable
    // pose and reports converged=false — it must never tear apart or emit NaN.
    const rig = singleRevoluteRig();
    const { topology, solver } = createSolverFor(provider, rig);
    const root = rig.links[topology.rootLinkIndex];

    const result = solver.solveInverse(
      1, [0, 0, 0], [50, 50, 50], 60, 0.01, 1e-4,
      topology.rootLinkIndex,
      [root.worldPosition.x, root.worldPosition.y, root.worldPosition.z],
      [root.worldRotation.x, root.worldRotation.y, root.worldRotation.z, root.worldRotation.w],
    );
    expect(result.status).toBe(RVK_OK);
    expect(result.converged).toBe(false);
    expect(Number.isFinite(result.residualError)).toBe(true);
    for (let i = 0; i < solver.jointValuesOut.length; i++) {
      expect(Number.isFinite(solver.jointValuesOut[i])).toBe(true);
    }
    solver.destroy();
  });

  it('writes an output value for EVERY tree-dof joint, not just driven ones', (ctx) => {
    if (!requireSolver(ctx)) return;
    // Inverse mode has no active/passive split — callers read back the subset
    // they need, so the buffer must be joint-indexed and fully written.
    // A two-link open chain has ONE driven and ONE passive tree dof and a well
    // conditioned inverse Jacobian — the four-bar would confound this assertion
    // with its own out-of-plane rank deficiency (see the next case).
    const rig = twoLinkChainRig();
    const { topology, solver } = createSolverFor(provider, rig);
    expect(topology.treeDofs.filter((d) => d.isActive)).toHaveLength(1);
    expect(topology.treeDofs.filter((d) => !d.isActive)).toHaveLength(1);

    const root = rig.links[topology.rootLinkIndex];
    const result = solver.solveInverse(
      2, [0, 0, 0], [0.42, 0.42, 0], 60, 0.01, 1e-4,
      topology.rootLinkIndex,
      [root.worldPosition.x, root.worldPosition.y, root.worldPosition.z],
      [root.worldRotation.x, root.worldRotation.y, root.worldRotation.z, root.worldRotation.w],
    );
    expect(result.status).toBe(RVK_OK);
    expect(solver.jointValuesOut.length).toBe(rig.joints.length);
    for (let i = 0; i < solver.jointValuesOut.length; i++) {
      expect(Number.isFinite(solver.jointValuesOut[i])).toBe(true);
    }
    // BOTH dofs moved — the passive one is an unknown here, unlike in forward mode.
    expect(Math.abs(solver.jointValuesOut[1])).toBeGreaterThan(0.01);
    solver.destroy();
  });

  it('reports a NON-FINITE result instead of passing NaN to the scene', (ctx) => {
    if (!requireSolver(ctx)) return;
    // OBSERVED core behaviour, not a hypothetical: a planar four-bar's inverse
    // Jacobian is rank-deficient out of plane, and at damping 0.01 the core
    // returns status 0 with converged=1 and residual=0 while joint_values_out is
    // NaN — its convergence test compares against NaN and passes vacuously.
    // The host must catch this; writing NaN poses destroys the model silently.
    const rig = fourBarRig();
    const { topology, solver } = createSolverFor(provider, rig);
    const result = solver.solveInverse(
      2, [0, 0, 0], [0.58, 0.32, 0], 40, 0.01, 1e-4,
      topology.rootLinkIndex, null, null,
    );
    if (result.status === RVK_OK) {
      // The core stayed finite on this build — then the contract still holds.
      for (let i = 0; i < solver.jointValuesOut.length; i++) {
        expect(Number.isFinite(solver.jointValuesOut[i])).toBe(true);
      }
    } else {
      expect(result.status).toBe(RVK_NON_FINITE);
      expect(result.converged).toBe(false);
      // Never a flattering "converged" on a poisoned solve.
      expect(kinematicStatusText(result.status)).toMatch(/non-finite/);
    }
    solver.destroy();
  });

  it('respects joint limits when they are enabled', (ctx) => {
    if (!requireSolver(ctx)) return;
    const rig = singleRevoluteRig();
    rig.joints[0].useLimits = true;
    rig.joints[0].lowerLimit = -10;
    rig.joints[0].upperLimit = 10;
    const { topology, solver } = createSolverFor(provider, rig);
    const root = rig.links[topology.rootLinkIndex];

    // Ask for a pose that would need ~90°, far outside the ±10° window.
    solver.solveInverse(
      1, [0, 0, 0], [0, 0.5, 0], 60, 0.01, 1e-4,
      topology.rootLinkIndex,
      [root.worldPosition.x, root.worldPosition.y, root.worldPosition.z],
      [root.worldRotation.x, root.worldRotation.y, root.worldRotation.z, root.worldRotation.w],
    );
    // Blocks 9/10 of the blob carry the per-tree-dof limits precisely so the
    // inverse solve can honour them for ACTIVE dofs too.
    expect(solver.jointValuesOut[0]).toBeGreaterThanOrEqual(-10.5);
    expect(solver.jointValuesOut[0]).toBeLessThanOrEqual(10.5);
    solver.destroy();
  });
});

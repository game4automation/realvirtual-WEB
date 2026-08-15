// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T1 / T4 — Mechanism solver provider: ABI gate + memory rules (plan-404 §2.3, §9).
 *
 * T1: the provider loads rv_kinematic_solver.wasm, the ABI version gate
 *     (`rvk_abi_version() === 3`) passes, and a real mechanism gets a handle.
 * T4: the documented memory rules hold — buffers are allocated ONCE per
 *     mechanism, the tick path never re-allocates, a mechanism without free
 *     bodies works with a zero-length free-body buffer, and views survive an
 *     allocating call (the detached-ArrayBuffer trap, plan-404 R4).
 *
 * Guarded: without the artifact the whole file skips loudly instead of passing.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  KinematicSolverProvider,
  KINEMATIC_ABI_VERSION,
  RVK_OK,
  kinematicStatusText,
} from '@rv-private/kinematic-solver/rv-kinematic-solver-provider';
import { KINEMATIC_WASM_URL } from '@rv-private/kinematic-solver/rv-kinematic-wasm-url';
import {
  createSolverFor, fourBarRig, freeBodyRig, seedRoot, singleRevoluteRig,
} from './_mechanism-rigs';

let provider: KinematicSolverProvider;
let loaded = false;

beforeAll(async () => {
  provider = new KinematicSolverProvider();
  loaded = await provider.load();
});

/** Skip loudly when the wasm artifact is not part of this build. */
function requireSolver(ctx: { skip: (note?: string) => void }): boolean {
  if (!loaded) {
    ctx.skip(
      'rv_kinematic_solver.wasm unavailable '
      + `(url=${KINEMATIC_WASM_URL ?? 'none'}, failure=${provider.failure}: ${provider.failureDetail}) `
      + '— plan-404 Phase 1 (crate wasm32 target) has not produced an artifact for this build',
    );
    return false;
  }
  return true;
}

afterEach(() => {
  // Every test must leave the provider balanced; destroyAll is the safety net
  // for a case that threw before its own cleanup.
  provider?.destroyAll();
});

describe('T1 — ABI gate', () => {
  it('loads the artifact and passes the version gate', (ctx) => {
    if (!requireSolver(ctx)) return;
    expect(provider.available).toBe(true);
    expect(provider.version).toBe(KINEMATIC_ABI_VERSION);
    expect(provider.version).toBe(3);
    expect(provider.failure).toBe('none');
  });

  it('load() is idempotent and shares one in-flight promise', async (ctx) => {
    if (!requireSolver(ctx)) return;
    const [a, b] = await Promise.all([provider.load(), provider.load()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('creates a handle for an open chain, a loop rig and a free-body rig', (ctx) => {
    if (!requireSolver(ctx)) return;
    for (const rig of [singleRevoluteRig(), fourBarRig(), freeBodyRig()]) {
      const { solver } = createSolverFor(provider, rig);
      expect(solver.handle).not.toBe(0);
      expect(solver.alive).toBe(true);
      solver.destroy();
    }
  });

  it('rejects a truncated state blob with handle 0 instead of crashing', (ctx) => {
    if (!requireSolver(ctx)) return;
    const rig = singleRevoluteRig();
    const { solver } = createSolverFor(provider, rig);
    const sizes = solver.sizes;
    solver.destroy();

    // Cut the header in half — the core must return 0, never a bad handle.
    const bad = provider.createMechanism(new Int32Array([2, 1]), new Float32Array([1]), sizes);
    expect(bad).toBeNull();
  });

  it('translates every documented status code to readable text', () => {
    // Pure mapping — runs even without the artifact, since a status code with
    // no wording is what turns a solver failure into an unexplained freeze.
    expect(kinematicStatusText(RVK_OK)).toBe('ok');
    expect(kinematicStatusText(-1)).toBe('invalid handle');
    expect(kinematicStatusText(-2)).toBe('buffer length mismatch');
    expect(kinematicStatusText(-3)).toBe('solver panic / wasm trap');
    expect(kinematicStatusText(-4)).toBe('null pointer');
  });
});

describe('T1 — forward solve', () => {
  it('solves an open chain and reports convergence', (ctx) => {
    if (!requireSolver(ctx)) return;
    const rig = singleRevoluteRig();
    const { topology, solver } = createSolverFor(provider, rig);
    seedRoot(solver, topology, rig);

    solver.jointValues[0] = 30;
    const result = solver.solve(4, 0.01, 0.001);
    expect(result.status).toBe(RVK_OK);
    // An open chain has no residuals at all, so it converges by construction.
    expect(result.converged).toBe(true);
    expect(result.residualError).toBeLessThan(0.001);
    solver.destroy();
  });

  it('moves the driven link when the joint value changes', (ctx) => {
    if (!requireSolver(ctx)) return;
    const rig = singleRevoluteRig();
    const { topology, solver } = createSolverFor(provider, rig);

    seedRoot(solver, topology, rig);
    solver.jointValues[0] = 0;
    solver.solve(4, 0.01, 0.001);
    const at0 = Array.from(solver.linkPos.slice(3, 6));

    seedRoot(solver, topology, rig);
    solver.jointValues[0] = 90;
    solver.solve(4, 0.01, 0.001);
    const at90 = Array.from(solver.linkPos.slice(3, 6));

    const moved = Math.hypot(at90[0] - at0[0], at90[1] - at0[1], at90[2] - at0[2]);
    // A 500 mm arm swung 90° travels ~707 mm = ~0.707 world units.
    expect(moved).toBeGreaterThan(0.5);
    solver.destroy();
  });

  it('solves a loop-closure rig (four-bar) through the Newton path', (ctx) => {
    if (!requireSolver(ctx)) return;
    const rig = fourBarRig();
    const { topology, solver } = createSolverFor(provider, rig);
    expect(topology.residualCount).toBeGreaterThan(0);

    seedRoot(solver, topology, rig);
    solver.jointValues[0] = 5;
    const result = solver.solve(8, 0.01, 0.001);
    expect(result.status).toBe(RVK_OK);
    expect(Number.isFinite(result.residualError)).toBe(true);
    solver.destroy();
  });
});

describe('T4 — memory rules', () => {
  it('a mechanism WITHOUT free bodies runs with a zero-length free-body buffer', (ctx) => {
    if (!requireSolver(ctx)) return;
    // ABI.md accepts a null pointer with a declared length of 0 for exactly this
    // case; getting it wrong broke every non-free-body mechanism's first solve.
    const rig = fourBarRig();
    const { topology, solver } = createSolverFor(provider, rig);
    expect(topology.freeBodyDofs).toHaveLength(0);
    seedRoot(solver, topology, rig);
    const result = solver.solve(4, 0.01, 0.001);
    expect(result.status).toBe(RVK_OK);
    solver.destroy();
  });

  it('a mechanism WITH free bodies solves and keeps its warm-start buffer', (ctx) => {
    if (!requireSolver(ctx)) return;
    const rig = freeBodyRig();
    const { topology, solver } = createSolverFor(provider, rig);
    expect(topology.freeBodyDofs.length).toBeGreaterThan(0);
    expect(solver.freeBodyRot.length).toBe(topology.freeBodyDofs.length * 4);
    seedRoot(solver, topology, rig);
    const result = solver.solve(6, 0.01, 0.001);
    expect(result.status).toBe(RVK_OK);
    solver.destroy();
  });

  it('1000 ticks allocate NOTHING — the tick path is allocation-free', (ctx) => {
    if (!requireSolver(ctx)) return;
    const rig = fourBarRig();
    const { topology, solver } = createSolverFor(provider, rig);
    const allocsAfterCreate = provider.allocCount;

    for (let i = 0; i < 1000; i++) {
      seedRoot(solver, topology, rig);
      solver.jointValues[0] = (i % 20) - 10;
      const result = solver.solve(4, 0.01, 0.001);
      expect(result.status).toBe(RVK_OK);
    }
    // The whole point of pre-allocating at create time (plan-404 R4): no growth,
    // so no Memory.grow(), so no detached views mid-tick.
    expect(provider.allocCount).toBe(allocsAfterCreate);
    solver.destroy();
  });

  it('views stay valid across an allocating call (detached-buffer trap)', (ctx) => {
    if (!requireSolver(ctx)) return;
    const rigA = fourBarRig();
    const a = createSolverFor(provider, rigA);
    a.solver.jointValues[0] = 3;

    // Creating a SECOND mechanism allocates, which may grow linear memory and
    // detach every existing view. Reading through the accessor must re-derive.
    const b = createSolverFor(provider, freeBodyRig());

    expect(a.solver.jointValues.length).toBe(a.solver.sizes.jointCount);
    // A detached view reads as 0/undefined; a correctly re-derived one does not.
    expect(a.solver.jointValues.byteLength).toBeGreaterThan(0);
    seedRoot(a.solver, a.topology, rigA);
    expect(a.solver.solve(4, 0.01, 0.001).status).toBe(RVK_OK);

    a.solver.destroy();
    b.solver.destroy();
  });

  it('warm-start reset zeroes q without invalidating the handle', (ctx) => {
    if (!requireSolver(ctx)) return;
    const rig = fourBarRig();
    const { topology, solver } = createSolverFor(provider, rig);
    seedRoot(solver, topology, rig);
    solver.jointValues[0] = 10;
    solver.solve(6, 0.01, 0.001);

    solver.resetWarmStart();
    expect(Array.from(solver.q).every((v) => v === 0)).toBe(true);
    seedRoot(solver, topology, rig);
    expect(solver.solve(6, 0.01, 0.001).status).toBe(RVK_OK);
    solver.destroy();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T13 / T15 — Mechanism lifecycle + runtime-create (plan-404 §2.3, §9).
 *
 * The lifecycle matrix in plan-404 §2.3 is binding, and its proof obligation is
 * numeric: after any sequence of load → clear → reload and runtime
 * create/remove, `create == destroy` and `alloc == free`. A leaked wasm handle
 * is invisible until a long session runs out of linear memory, which is exactly
 * why it gets a counter rather than a code review.
 *
 * T15 additionally pins the context-slot contract: the manager registry is a
 * module singleton precisely so that EVERY `ComponentContext` construction path
 * (initial load, processExtras/asset placement, createRuntimeNode,
 * constructComponentOnNode) carries it — a threaded optional is what gets
 * forgotten on the runtime paths.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { KinematicSolverProvider } from '@rv-private/kinematic-solver/rv-kinematic-solver-provider';
import {
  getKinematicManager,
  setKinematicManager,
  isMechanismSupported,
  getMechanismUiBridge,
  setMechanismUiBridge,
  type KinematicManagerLike,
  type KinematicMechanismHandle,
} from '../src/core/engine/rv-kinematic-registry';
import { createSolverFor, fourBarRig, freeBodyRig, seedRoot, singleRevoluteRig } from './_mechanism-rigs';

let provider: KinematicSolverProvider;
let loaded = false;

beforeAll(async () => {
  provider = new KinematicSolverProvider();
  loaded = await provider.load();
});

afterEach(() => {
  provider?.destroyAll();
  setKinematicManager(null);
  setMechanismUiBridge(null);
});

function requireSolver(ctx: { skip: (note?: string) => void }): boolean {
  if (!loaded) {
    ctx.skip(`rv_kinematic_solver.wasm unavailable (${provider.failure}) — plan-404 Phase 1 artifact missing`);
    return false;
  }
  return true;
}

describe('T13 — handle and buffer accounting', () => {
  it('create == destroy and alloc == free after a full load/clear cycle', (ctx) => {
    if (!requireSolver(ctx)) return;
    provider._resetCountersForTesting();

    const solvers = [
      createSolverFor(provider, singleRevoluteRig()),
      createSolverFor(provider, fourBarRig()),
      createSolverFor(provider, freeBodyRig()),
    ];
    expect(provider.createCount).toBe(3);
    expect(provider.liveInstanceCount).toBe(3);

    for (const s of solvers) s.solver.destroy();

    expect(provider.destroyCount).toBe(provider.createCount);
    expect(provider.freeCount).toBe(provider.allocCount);
    expect(provider.liveInstanceCount).toBe(0);
  });

  it('stays balanced across repeated load → clear → reload cycles', (ctx) => {
    if (!requireSolver(ctx)) return;
    provider._resetCountersForTesting();

    for (let cycle = 0; cycle < 5; cycle++) {
      const a = createSolverFor(provider, fourBarRig());
      const b = createSolverFor(provider, freeBodyRig());
      seedRoot(a.solver, a.topology, fourBarRig());
      a.solver.solve(4, 0.01, 0.001);
      // The model-clear path: release everything, keep the provider alive.
      provider.destroyAll();
      expect(provider.liveInstanceCount).toBe(0);
      void b;
    }

    expect(provider.createCount).toBe(10);
    expect(provider.destroyCount).toBe(10);
    expect(provider.freeCount).toBe(provider.allocCount);
  });

  it('destroy() is idempotent — a double release is not a double free', (ctx) => {
    if (!requireSolver(ctx)) return;
    provider._resetCountersForTesting();
    const { solver } = createSolverFor(provider, singleRevoluteRig());

    solver.destroy();
    const afterFirst = { destroy: provider.destroyCount, free: provider.freeCount };
    solver.destroy();
    solver.destroy();

    // `rvk_destroy` is a Box::from_raw — calling it twice IS a double free, so
    // the guard has to be here, not in the caller's discipline.
    expect(provider.destroyCount).toBe(afterFirst.destroy);
    expect(provider.freeCount).toBe(afterFirst.free);
  });

  it('a destroyed instance reports itself dead and refuses to solve', (ctx) => {
    if (!requireSolver(ctx)) return;
    const { solver } = createSolverFor(provider, singleRevoluteRig());
    solver.destroy();
    expect(solver.alive).toBe(false);
    const result = solver.solve(4, 0.01, 0.001);
    expect(result.status).not.toBe(0);
    expect(result.converged).toBe(false);
  });

  it('destroyAll releases every live instance exactly once', (ctx) => {
    if (!requireSolver(ctx)) return;
    provider._resetCountersForTesting();
    createSolverFor(provider, fourBarRig());
    createSolverFor(provider, singleRevoluteRig());
    provider.destroyAll();
    provider.destroyAll(); // second sweep must be a no-op
    expect(provider.destroyCount).toBe(2);
    expect(provider.freeCount).toBe(provider.allocCount);
  });

  it('a fresh mechanism starts from a ZEROED warm start, not recycled memory', (ctx) => {
    if (!requireSolver(ctx)) return;
    // Regression guard. `rvk_alloc` does not zero, and q / inv_q are IN/OUT —
    // the core READS them as warm start. Without explicit zeroing a new
    // mechanism inherits the previous one's leftovers (observed: NaN), and then
    // every solve stays NaN forever while the first mechanism looked fine.
    const first = createSolverFor(provider, fourBarRig());
    // Poison this instance's warm start, then release its memory block.
    first.solver.q.fill(Number.NaN);
    first.solver.destroy();

    const second = createSolverFor(provider, fourBarRig());
    expect(Array.from(second.solver.q).every((v) => v === 0)).toBe(true);
    expect(Array.from(second.solver.jointValuesOut).every(Number.isFinite)).toBe(true);
    second.solver.destroy();
  });
});

describe('T15 — manager registry and the context slot', () => {
  it('a public build has no manager and no bridge — the feature is simply absent', () => {
    setKinematicManager(null);
    setMechanismUiBridge(null);
    expect(getKinematicManager()).toBeNull();
    expect(getMechanismUiBridge()).toBeNull();
    expect(isMechanismSupported()).toBe(false);
  });

  it('installing a manager makes mechanisms supported, removing it undoes that', () => {
    const registered: KinematicMechanismHandle[] = [];
    const fake: KinematicManagerLike = {
      register: (m) => { registered.push(m); },
      unregister: (m) => { const i = registered.indexOf(m); if (i >= 0) registered.splice(i, 1); },
      get size() { return registered.length; },
    };

    setKinematicManager(fake);
    expect(isMechanismSupported()).toBe(true);
    expect(getKinematicManager()).toBe(fake);

    // The loader reads the singleton when it builds EVERY ComponentContext, so a
    // component constructed on any path reaches the same manager.
    const handle = { node: { name: 'Mech' } } as unknown as KinematicMechanismHandle;
    getKinematicManager()?.register(handle);
    expect(fake.size).toBe(1);
    getKinematicManager()?.unregister(handle);
    expect(fake.size).toBe(0);

    setKinematicManager(null);
    expect(isMechanismSupported()).toBe(false);
  });

  it('every ComponentContext construction path in the loader reads the slot', async () => {
    // Structural guard for the lifecycle matrix (SOL finding 3): the loader must
    // populate `kinematicManager` on ALL FOUR paths — initial load (loadGLB),
    // asset placement (processExtras), createRuntimeNode and
    // constructComponentOnNode. Threading it as an option is exactly what gets
    // forgotten on the runtime paths, which is why it is read from the singleton
    // at each site and why that count is asserted here.
    //
    // The dev server serves TRANSFORMED modules, so TS type annotations
    // (`: ComponentContext`) are already stripped — only the runtime object
    // property survives, and that is what this counts.
    const source = await fetch('/src/core/engine/rv-scene-loader.ts').then((r) => r.text());
    const reads = source.match(/kinematicManager:\s*getKinematicManager\(\)/g) ?? [];
    expect(reads.length).toBe(4);
  });
});

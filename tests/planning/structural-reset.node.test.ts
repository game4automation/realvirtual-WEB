// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-630 §9.13b — ONE apply is ONE reset.
 *
 * The generic half (plan-630 phases 1-8, no placement and no path changes):
 * stop → commit → reconfigure the components → exactly one runner reset. Every
 * number in here is a count of something the runner did, because the failure
 * mode this guards against is invisible in a screenshot: two resets per apply,
 * a `bound` handler that sees new values against old structure, a run that
 * keeps going while the structure changes, an apply that silently works on a
 * document the user has already left.
 *
 * The private counterpart (`pallet-yard-structural-apply.test.ts`, plan-630
 * phase 7) measures the same ritual on a real plant: the FIRST order actually
 * created after the apply has no destination V2.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { preloadStructuralResetHull } from '../../src/plugins/planning-parameters/structural-reset';
import {
  createPlanningRegistry, type PlanningRegistry,
} from '../../src/core/planning/rv-planning-registry';
import type { PlanningParamDef, StructuralResetContext } from '../../src/core/planning/rv-planning-params';
import {
  createStructuralResetRunner, PLANNING_APPLY_PAUSE_REASON, type StructuralResetViewer,
} from '../../src/plugins/planning-parameters/structural-reset';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';

const PARAMS: PlanningParamDef[] = [
  { key: 'slots', label: 'Pufferplätze', type: 'integer', min: 0, max: 8, default: 6, group: 'Stationen', apply: 'reset' },
  { key: 'rate', label: 'A1', type: 'number', min: 0, max: 120, default: 40, group: 'Last', apply: 'live' },
];

// ─── A viewer that only counts ─────────────────────────────────────────────

interface FakeViewer extends StructuralResetViewer {
  /** How often `resetSimulation()` really ran (a held-back one does not count). */
  resets: number;
  /** `bound` events the fake DES runner emitted. */
  bounds: number;
  pauseCalls: Array<{ reason: string; paused: boolean }>;
  readonly pauseReasons: Set<string>;
  ffCancelled: number;
  /** Open transaction depth — so a test can prove the reset was withheld. */
  depth: number;
  /** Emits `bound` as the DES runner does after a reset. */
  emitBound(): void;
  /** Mutable here, so a test can swap the instancer in. */
  placements: { whenMaterialized?(): Promise<unknown> } | null;
}

/**
 * @param mode `'des'` gives the runner a lifecycle service (so step 5 waits for
 *   `bound`); `'continuous'` gives it none.
 * @param transaction `true` adds a `structuralEdit` that withholds the reset and
 *   flushes exactly one when it closes — the plan-681 §2.3 prototype, so this
 *   test already covers the shape 630 will run inside later.
 */
function makeViewer(mode: 'des' | 'continuous', transaction = false): FakeViewer {
  const pauseReasons = new Set<string>();
  const listeners = new Set<(e: { type: string; generation?: number }) => void>();
  let generation = 0;
  let held = 0;

  const v: FakeViewer = {
    resets: 0,
    bounds: 0,
    pauseCalls: [],
    pauseReasons,
    ffCancelled: 0,
    depth: 0,
    get isSimulationPaused() { return pauseReasons.size > 0; },
    setSimulationPaused(reason, paused) {
      v.pauseCalls.push({ reason, paused });
      if (paused) pauseReasons.add(reason); else pauseReasons.delete(reason);
    },
    resetSimulation() {
      if (v.depth > 0) { held += 1; return; }
      v.resets += 1;
      // The real DES runner rebinds on a reset and reports `bound`.
      if (mode === 'des') v.emitBound();
    },
    emitBound() {
      v.bounds += 1;
      generation += 1;
      for (const fn of [...listeners]) fn({ type: 'bound', generation });
    },
    simulationKernel: {
      mode,
      desControl: () => ({ cancelFastForward: () => { v.ffCancelled += 1; } }),
      hasDesLifecycle: () => mode === 'des',
      onDesLifecycle: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    },
    placements: { whenMaterialized: () => Promise.resolve() },
  };

  if (transaction) {
    v.structuralEdit = async <T>(fn: () => Promise<T> | T): Promise<T> => {
      v.depth += 1;
      try {
        return await fn();
      } finally {
        v.depth -= 1;
        if (v.depth === 0 && held > 0) { held = 0; v.resetSimulation(); }
      }
    };
  }
  return v;
}

function harness(opts: {
  mode?: 'des' | 'continuous';
  transaction?: boolean;
  onStructuralReset?: (
    committed: Readonly<Record<string, unknown>>,
    ctx: StructuralResetContext,
  ) => Promise<void>;
} = {}) {
  clearAllProblems();
  const viewer = makeViewer(opts.mode ?? 'des', opts.transaction);
  let documentLoadId = 'doc-1';
  let abort = new AbortController();
  const calls: Array<Readonly<Record<string, unknown>>> = [];

  const registry: PlanningRegistry = createPlanningRegistry({ simTime: () => 0 });
  registry.setApplyRunner(createStructuralResetRunner({
    viewer,
    documentLoadId: () => documentLoadId,
    signal: () => abort.signal,
    boundTimeoutMs: 200,
  }));
  const handle = registry.declare({
    owner: 'yard',
    title: 'Yard',
    params: PARAMS,
    onStructuralReset: async (committed, ctx) => {
      calls.push(committed);
      // The owner reconfigures while the simulation stands still — which is the
      // whole point, so the test asserts it here, where it is true or not.
      expect(viewer.isSimulationPaused).toBe(true);
      await opts.onStructuralReset?.(committed, ctx);
    },
  });

  return {
    viewer,
    registry,
    handle,
    calls,
    changeDocument(id: string) { documentLoadId = id; abort.abort(); abort = new AbortController(); },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────


// plan-2013 Phase 1: the apply hull is a lazy chunk; installed runners preload it at boot.
beforeAll(async () => { await preloadStructuralResetHull(); });

describe('structural reset (plan-630 §2.5a)', () => {
  it('stops, commits, reconfigures and resets the runner exactly once', async () => {
    const h = harness();
    h.registry.set('yard.slots', 2, 'ui');
    // Pending until the apply: `values()` still says 6.
    expect(h.registry.list().find((p) => p.key === 'yard.slots')?.value).toBe(6);

    const r = await h.registry.applyPendingAndReset();

    expect(r.ok).toBe(true);
    expect(h.viewer.ffCancelled).toBe(1);
    expect(h.calls).toEqual([{ slots: 2, rate: 40 }]);
    expect(h.viewer.resets).toBe(1);
    expect(h.viewer.bounds).toBe(1);
    expect(h.registry.list().find((p) => p.key === 'yard.slots')?.value).toBe(2);
    // The commit belongs to the NEW run, at its t = 0.
    expect(h.registry.changeLog()).toEqual([
      { simTime: 0, seq: 0, key: 'yard.slots', from: 6, to: 2, origin: 'ui' },
    ]);
    // Nothing of the apply is left holding the simulation.
    expect(h.viewer.pauseReasons.has(PLANNING_APPLY_PAUSE_REASON)).toBe(false);
    expect(h.viewer.isSimulationPaused).toBe(false);
  });

  it('is one reset in the continuous mode too, without waiting for a bound', async () => {
    const h = harness({ mode: 'continuous' });
    h.registry.set('yard.slots', 3, 'ui');

    const r = await h.registry.applyPendingAndReset();

    expect(r.ok).toBe(true);
    expect(h.viewer.resets).toBe(1);
    expect(h.viewer.bounds).toBe(0);
  });

  it('is one reset inside an open structural-edit transaction (plan-681 shape)', async () => {
    const h = harness({ transaction: true });
    h.registry.set('yard.slots', 1, 'ui');

    const r = await h.registry.applyPendingAndReset();

    expect(r.ok).toBe(true);
    // Withheld while the transaction was open, flushed once on close.
    expect(h.viewer.resets).toBe(1);
    expect(h.viewer.bounds).toBe(1);
    expect(h.viewer.depth).toBe(0);
  });

  it('answers the second of two concurrent applies with apply-in-progress', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((res) => { release = res; });
    const h = harness({ onStructuralReset: () => slow });
    h.registry.set('yard.slots', 4, 'ui');

    const first = h.registry.applyPendingAndReset();
    const second = await h.registry.applyPendingAndReset();

    expect(second).toEqual({ ok: false, generation: 0, error: 'apply-in-progress' });
    release();
    expect((await first).ok).toBe(true);
    expect(h.viewer.resets).toBe(1);
  });

  it('answers document-changed and does not reset the NEW document', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((res) => { release = res; });
    const h = harness({ onStructuralReset: () => slow });
    h.registry.set('yard.slots', 5, 'ui');

    const apply = h.registry.applyPendingAndReset();
    h.changeDocument('doc-2');
    release();

    const r = await apply;
    expect(r.error).toBe('document-changed');
    // The new load binds itself (plan-645 S8) — nothing here may touch it.
    expect(h.viewer.resets).toBe(0);
    expect(h.viewer.bounds).toBe(0);
  });

  it('an owner error AFTER a document change is document-changed — no rollback onto the new document (plan-681)', async () => {
    let fail: () => void = () => {};
    const slow = new Promise<void>((_res, rej) => { fail = () => rej(new Error('scene gone under the rebuild')); });
    const h = harness({ onStructuralReset: () => slow });
    h.registry.set('yard.slots', 5, 'ui');

    const apply = h.registry.applyPendingAndReset();
    await Promise.resolve();
    h.changeDocument('doc-2');
    fail();

    const r = await apply;
    expect(r.error).toBe('document-changed');
    expect(h.calls.length).toBe(1);            // no second (rollback) call
    expect(h.viewer.resets).toBe(0);
    expect(getProblems().map((p) => p.id)).not.toContain('planning-apply-failed');
  });

  it('reports materialize-failed, puts the values back and stays paused at t = 0', async () => {
    const h = harness({ onStructuralReset: () => Promise.reject(new Error('cannot shrink the buffer')) });
    h.registry.set('yard.slots', 0, 'ui');

    const r = await h.registry.applyPendingAndReset();

    expect(r.ok).toBe(false);
    expect(r.error).toBe('materialize-failed');
    expect(r.detail).toContain('cannot shrink');
    // The value is pending again — the user can correct it and apply once more.
    const state = h.registry.list().find((p) => p.key === 'yard.slots');
    expect(state?.value).toBe(6);
    expect(state?.pending).toBe(0);
    // The rollback call is on the SAME path; both throw here, so both are reported.
    const ids = getProblems().map((p) => p.id);
    expect(ids).toContain('planning-apply-failed');
    expect(ids).toContain('planning-apply-rollback-failed');
    // Paused at t = 0, and by the USER reason — so the toolbar's play button,
    // not a stuck internal reason, is what lets it go again.
    expect(h.viewer.isSimulationPaused).toBe(true);
    expect(h.viewer.pauseReasons.has(PLANNING_APPLY_PAUSE_REASON)).toBe(false);
    expect(h.viewer.pauseReasons.has('user')).toBe(true);
  });

  it('clears an earlier failure on the next successful apply', async () => {
    let fail = true;
    const h = harness({ onStructuralReset: () => (fail ? Promise.reject(new Error('nope')) : Promise.resolve()) });
    h.registry.set('yard.slots', 2, 'ui');
    await h.registry.applyPendingAndReset();
    expect(getProblems().map((p) => p.id)).toContain('planning-apply-failed');

    fail = false;
    await h.registry.applyPendingAndReset();
    expect(getProblems().map((p) => p.id)).not.toContain('planning-apply-failed');
  });

  it('leaves a simulation that was paused before paused afterwards', async () => {
    const h = harness();
    h.viewer.setSimulationPaused('user', true);
    h.registry.set('yard.slots', 2, 'ui');

    await h.registry.applyPendingAndReset();

    expect(h.viewer.isSimulationPaused).toBe(true);
    expect(h.viewer.pauseReasons.has('user')).toBe(true);
  });

  it('does not take pending values over on an ordinary toolbar reset', () => {
    const h = harness();
    h.registry.set('yard.slots', 2, 'ui');

    h.registry.notifySimulationReset();

    const state = h.registry.list().find((p) => p.key === 'yard.slots');
    expect(state?.value).toBe(6);
    expect(state?.pending).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it('calls an owner WITHOUT pending values on reconcileStructure (plan-681 Gate-R2 #4)', async () => {
    const h = harness();

    const r = await h.registry.reconcileStructure('yard');

    expect(r.ok).toBe(true);
    expect(h.calls).toEqual([{ slots: 6, rate: 40 }]);
    expect(h.viewer.resets).toBe(1);
    // An ordinary apply without anything pending calls nobody.
    h.calls.length = 0;
    await h.registry.applyPendingAndReset();
    expect(h.calls).toEqual([]);
  });

  it('a failed reconcile recovers committed to the restored structure; a change meanwhile stays pending (plan-681 F2)', async () => {
    let first = true;
    const h = harness({
      onStructuralReset: async () => {
        if (!first) return;
        first = false;
        // The owner rolled back to the document (slots 6) while the user set slots = 2.
        h.registry.set('yard.slots', 2, 'ui');
        expect(h.handle.recoverCommitted({ slots: 6 }).ok).toBe(true);
        throw new Error('placement failed');
      },
    });
    h.registry.loadScenario({ 'yard.slots': 8 });
    const r = await h.registry.reconcileStructure('yard');
    expect(r.error).toBe('materialize-failed');
    expect(h.viewer.resets).toBe(1);
    const state = h.registry.list().find((p) => p.key === 'yard.slots');
    expect(state?.value).toBe(6);
    expect(state?.pending).toBe(2);
    const ids = getProblems().map((p) => p.id);
    expect(ids).toContain('planning-apply-failed');
    expect(ids).toContain('planning-committed-recovered:yard');
    expect((await h.registry.applyPendingAndReset()).ok).toBe(true);
    expect(h.handle.get('slots')).toBe(2);
    expect(getProblems().map((p) => p.id)).not.toContain('planning-committed-recovered:yard');
  });

  it('refuses a recovery the declaration rejects, changing nothing, as a Problems entry', () => {
    const h = harness();
    h.registry.loadScenario({ 'yard.slots': 8 });
    expect(h.handle.recoverCommitted({ slots: 99 }).ok).toBe(false);
    expect(h.handle.get('slots')).toBe(8);
    expect(getProblems().find((p) => p.id === 'planning-committed-recovered:yard')?.code).toBe('planning-committed-recovery-failed');
  });

  it('a retired owner takes its recovery warning with it', () => {
    const h = harness();
    h.registry.loadScenario({ 'yard.slots': 8 });
    expect(h.handle.recoverCommitted({ slots: 6 }).ok).toBe(true);
    expect(getProblems().map((p) => p.id)).toContain('planning-committed-recovered:yard');
    h.handle.dispose();
    expect(getProblems().map((p) => p.id)).not.toContain('planning-committed-recovered:yard');
  });

  it('answers unknown-owner for a reconcile of something nobody declared', async () => {
    const h = harness();
    expect(await h.registry.reconcileStructure('nothing')).toEqual({
      ok: false, generation: 0, error: 'unknown-owner',
    });
  });

  it('gives up with materialize-failed when the runner never rebinds', async () => {
    const h = harness();
    // A runner that eats the reset: the structure changed, nothing rebound.
    h.viewer.resetSimulation = () => { h.viewer.resets += 1; };
    h.registry.set('yard.slots', 2, 'ui');

    const r = await h.registry.applyPendingAndReset();

    expect(r.ok).toBe(false);
    expect(r.error).toBe('materialize-failed');
    expect(r.detail).toContain('did not rebind');
    expect(getProblems().map((p) => p.id)).toContain('planning-apply-failed');
  });

  it('does not wait for the placements-materialized event (plan-681 A1)', async () => {
    // The event fires once per load and never again, so a context that waited
    // for it would hang. `awaitPlacements` must resolve off the instancer.
    const materialized = vi.fn(() => Promise.resolve());
    let waited = false;
    const h = harness({
      onStructuralReset: async (_committed, ctx) => {
        await ctx.awaitPlacements();
        waited = true;
      },
    });
    h.viewer.placements = { whenMaterialized: materialized };
    h.registry.set('yard.slots', 2, 'ui');

    expect((await h.registry.applyPendingAndReset()).ok).toBe(true);
    expect(waited).toBe(true);
    expect(materialized).toHaveBeenCalledTimes(1);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-ff-time-slicing.test.ts — plan-262 Phase 1 (time-sliced FastForward).
 *
 * Verifies the DESRunner's `_ffDrainLoop` semantics against the review finds
 * R1–R3 with REAL `await runner.runFastForward()` chains (no fake timers):
 *  - a complete run resolves `true`; progress is monotonic while in flight;
 *  - `cancelFastForward()` mid-slice resolves `false` SYNCHRONOUSLY and no
 *    further batch runs afterwards (R3);
 *  - cancel → immediate restart leaves exactly ONE active loop — the stale
 *    continuation wakes to a mismatched `_ffRunId` and exits (R2);
 *  - `setSubMode('animated')` during a drain yield ends the loop cleanly
 *    (promise resolved `false`);
 *  - the tick()-FF branch does NOT double-drain while the drain loop is
 *    active (R1) and, standalone (SimModeToggle path), uses the time-based
 *    deadline (more than one inner batch per tick);
 *  - `yieldToBrowser()` falls back to MessageChannel without `scheduler.yield`
 *    (Safari path) and prefers `scheduler.yield()` when present.
 *
 * The yield utility is MOCKED so the tests control exactly when the drain
 * loop resumes (deferred mode) — deterministic interleaving, no timing races.
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D } from 'three';

// ─── Controllable yield mock (hoisted; same module id the runner imports) ──

const yieldCtl = vi.hoisted(() => ({
  /** true → yields park in `pending` until the test resolves them manually. */
  manual: false,
  pending: [] as Array<() => void>,
  calls: 0,
  reset(): void {
    this.manual = false;
    this.calls = 0;
    // Release anything still parked so no loop continuation leaks between tests.
    for (const r of this.pending) r();
    this.pending = [];
  },
}));

vi.mock('../../src/core/engine/rv-des-yield', () => ({
  yieldToBrowser: (): Promise<void> => {
    yieldCtl.calls++;
    if (yieldCtl.manual) {
      return new Promise<void>((resolve) => { yieldCtl.pending.push(resolve); });
    }
    return new Promise<void>((resolve) => setTimeout(resolve, 0));
  },
}));

import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import {
  createSelf,
  type MaterialFlowSelf,
} from '../../src/core/material-flow/material-flow-self';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry } from '../../src/core/material-flow/registry';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeBindContext(root: Object3D): RVBindContext {
  const events = new EventEmitter<Record<string, unknown>>();
  const values = new Map<string, boolean | number>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => values.set(n, v),
      subscribe: () => () => {},
    } as never,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [] as never,
    registry: null,
    getPlugin: () => undefined,
  };
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return ctx;
}

/** Infinite self-rescheduling event stream — FastForward never completes. */
function makeInfiniteDef(): MaterialFlowDefinition {
  return defineMaterialFlow<MaterialFlowSelf>({
    type: 'FfInfinite', kind: 'source', schema: {}, continuous: {},
    des: {
      onGenerate(self) { self.in(0.001, 'Arrival', null); },
      onArrival(self) { self.in(0.001, 'Arrival', null); },
    },
  }) as MaterialFlowDefinition;
}

/** Finite burst — `count` events densely packed at t = 0.001·(i+1). */
function makeBurstDef(count: number): MaterialFlowDefinition {
  return defineMaterialFlow<MaterialFlowSelf>({
    type: 'FfBurst', kind: 'source', schema: {}, continuous: {},
    des: {
      onGenerate(self) {
        for (let i = 0; i < count; i++) self.at(0.001 * (i + 1), 'Arrival', null);
      },
      onArrival() { /* no-op */ },
    },
  }) as MaterialFlowDefinition;
}

function buildRunner(def: MaterialFlowDefinition, durationSeconds?: number): DESRunner {
  const runner = new DESRunner({
    subMode: 'animated',
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  });
  const node = new Object3D();
  node.name = def.type;
  const self = createSelf(makeBindContext(node), def, {
    mode: 'des',
    scheduler: runner.makeScheduler(def, () => adapter.entityId),
  });
  const adapter = runner.addInstance(def, self, node);
  runner.start([def], { root: node });
  return runner;
}

/** Flush one macrotask turn so a resolved deferred's continuation runs. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** True when `p` has not settled yet (race against an already-settled sentinel). */
async function isPending(p: Promise<unknown>): Promise<boolean> {
  const sentinel = Symbol('pending');
  const r = await Promise.race([p, Promise.resolve(sentinel)]);
  return r === sentinel;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

let runner: DESRunner | null = null;

describe('DES FastForward time slicing (plan-262 Phase 1)', () => {
  beforeEach(() => {
    _resetMaterialFlowRegistry();
    _resetDesHookCache();
    resetDESMUCounter();
    yieldCtl.reset();
  });

  afterEach(async () => {
    yieldCtl.reset();       // release parked continuations
    await flush();          // let stale loops exit via their runId/active guards
    runner?.dispose();
    runner = null;
  });

  it('a complete run resolves true and clears the in-flight progress', async () => {
    runner = buildRunner(makeBurstDef(3000));
    const done = await runner.runFastForward();
    expect(done).toBe(true);
    expect(runner.ffProgress).toBeUndefined();
    expect(runner.getManager().pendingEventCount).toBe(0);
  });

  it('progress is monotonically non-decreasing across drain slices', async () => {
    yieldCtl.manual = true;
    runner = buildRunner(makeInfiniteDef(), 1e6);

    const p = runner.runFastForward();
    const samples: number[] = [runner.ffProgress ?? -1];
    // Step 4 slices manually, sampling the progress after each.
    for (let i = 0; i < 4; i++) {
      expect(yieldCtl.pending.length).toBe(1);
      yieldCtl.pending.shift()!();
      await flush();
      samples.push(runner.ffProgress ?? -1);
    }
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
    expect(samples[samples.length - 1]).toBeGreaterThan(0); // sim time advanced

    runner.cancelFastForward();
    await expect(p).resolves.toBe(false);
  });

  it('cancelFastForward() mid-slice resolves false synchronously and no further batch runs (R3)', async () => {
    yieldCtl.manual = true;
    runner = buildRunner(makeInfiniteDef(), 1e9);

    const p = runner.runFastForward();
    // First slice ran synchronously; the loop is parked on its first yield.
    expect(yieldCtl.pending.length).toBe(1);

    runner.cancelFastForward();
    await expect(p).resolves.toBe(false);   // resolved BEFORE the loop wakes

    const eventsAfterCancel = runner.getManager().totalEventsProcessed;
    yieldCtl.pending.shift()!();            // wake the stale continuation
    await flush();
    // The woken loop must exit without touching the manager again.
    expect(runner.getManager().totalEventsProcessed).toBe(eventsAfterCancel);
    expect(yieldCtl.pending.length).toBe(0); // no re-yield → loop is gone
  });

  it('cancel → immediate restart leaves exactly ONE active loop (R2)', async () => {
    yieldCtl.manual = true;
    runner = buildRunner(makeInfiniteDef(), 1e9);

    // Loop A: one slice, parked on D1.
    const p1 = runner.runFastForward();
    expect(yieldCtl.pending.length).toBe(1);
    const d1 = yieldCtl.pending.shift()!;

    // Cancel A (resolves false), restart immediately → loop B parks on D2.
    runner.cancelFastForward();
    await expect(p1).resolves.toBe(false);
    const p2 = runner.runFastForward();
    expect(yieldCtl.pending.length).toBe(1);
    const d2 = yieldCtl.pending.shift()!;

    // Wake stale loop A: runId mismatch → it must NOT process events, NOT
    // yield again, and NOT resolve the NEW run's promise.
    const eventsBefore = runner.getManager().totalEventsProcessed;
    d1();
    await flush();
    expect(runner.getManager().totalEventsProcessed).toBe(eventsBefore);
    expect(yieldCtl.pending.length).toBe(0);
    expect(await isPending(p2)).toBe(true);
    expect(runner.ffProgress).toBeDefined(); // run B still in flight

    // Wake loop B: it processes another slice and parks again — ONE loop.
    d2();
    await flush();
    expect(runner.getManager().totalEventsProcessed).toBeGreaterThan(eventsBefore);
    expect(yieldCtl.pending.length).toBe(1);

    runner.cancelFastForward();
    await expect(p2).resolves.toBe(false);
  });

  it("setSubMode('animated') during a drain yield ends the loop cleanly (promise resolves false)", async () => {
    yieldCtl.manual = true;
    runner = buildRunner(makeInfiniteDef(), 1e9);

    const p = runner.runFastForward();
    expect(yieldCtl.pending.length).toBe(1);

    runner.setSubMode('animated');          // leave FF while the loop is parked
    await expect(p).resolves.toBe(false);   // promise resolved by the mode switch
    expect(runner.subMode).toBe('animated');

    const events = runner.getManager().totalEventsProcessed;
    yieldCtl.pending.shift()!();
    await flush();
    expect(runner.getManager().totalEventsProcessed).toBe(events); // loop exited
    expect(yieldCtl.pending.length).toBe(0);
  });

  it('tick() does not double-drain while the drain loop is active (R1)', async () => {
    yieldCtl.manual = true;
    runner = buildRunner(makeInfiniteDef(), 1e9);

    const p = runner.runFastForward();
    expect(yieldCtl.pending.length).toBe(1); // loop parked mid-run

    const events = runner.getManager().totalEventsProcessed;
    runner.tick(0.016);                      // 60 Hz kernel tick during FF
    runner.tick(0.016);
    // The drain loop is the ONLY driver — the ticks must process nothing.
    expect(runner.getManager().totalEventsProcessed).toBe(events);

    runner.cancelFastForward();
    await expect(p).resolves.toBe(false);
  });

  it('standalone tick FF (SimModeToggle path) drains against the time deadline — more than one inner batch', () => {
    runner = buildRunner(makeInfiniteDef(), 1e9);
    runner.setSubMode('fastforward');        // NO runFastForward() — tick drives

    runner.tick(0.016);
    // Old behavior: exactly ONE fixed 2000-event batch per frame. New: a 12 ms
    // deadline loop of 2000-event inner batches — a trivial-handler stream
    // processes well beyond a single batch inside one tick.
    expect(runner.getManager().totalEventsProcessed).toBeGreaterThan(2000);
  });
});

describe('yieldToBrowser (real implementation — Safari fallback path)', () => {
  it('resolves via MessageChannel when scheduler.yield is absent', async () => {
    const real = await vi.importActual<typeof import('../../src/core/engine/rv-des-yield')>(
      '../../src/core/engine/rv-des-yield',
    );
    const g = globalThis as { scheduler?: unknown };
    const saved = g.scheduler;
    delete g.scheduler;
    try {
      await expect(real.yieldToBrowser()).resolves.toBeUndefined();
    } finally {
      if (saved !== undefined) g.scheduler = saved;
    }
  });

  it('prefers scheduler.yield() when present', async () => {
    const real = await vi.importActual<typeof import('../../src/core/engine/rv-des-yield')>(
      '../../src/core/engine/rv-des-yield',
    );
    const g = globalThis as { scheduler?: unknown };
    const saved = g.scheduler;
    const spy = vi.fn(() => Promise.resolve());
    g.scheduler = { yield: spy };
    try {
      await real.yieldToBrowser();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      if (saved !== undefined) g.scheduler = saved;
      else delete g.scheduler;
    }
  });
});

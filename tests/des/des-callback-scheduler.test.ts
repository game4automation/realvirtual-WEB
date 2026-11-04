// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-645 9.2 — the DES callback scheduler: a callback fires once at its sim
// time (also in FastForward), an old generation never fires, cancel works, the
// callback is NOT in a snapshot (nor the legacy `PalletYard.Clock` action), and
// after `restored` the consumer can plan again. Sim time only, never wall clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAction, ACTION_INDEX } from '@rv/plugins/des/rv-des-named-actions';
import { DesSimClock } from '@rv/plugins/des/fleet/des-sim-clock';
import { PLANNING_PRIORITY, CHECKPOINT_PRIORITY } from '@rv/plugins/des/rv-des-event';
import { DES_CALLBACK_ACTION } from '@rv/plugins/des/rv-des-manager';
import { MAX_EVENTS, record, resetWorld, startLine } from './des-lifecycle-line';

let infoSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetWorld();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { infoSpy.mockRestore(); });

describe('plan-645 9.2 — DES callback scheduler', () => {
  it('fires exactly once at its sim time, in time order with the model events', () => {
    const { runner } = startLine();
    const mgr = runner.getManager();
    const fired: number[] = [];
    runner.scheduleCallback(15, () => fired.push(mgr.currentTime), { origin: { owner: 'test.ui', kind: 'ui' } });
    runner.scheduleCallback(5, () => fired.push(mgr.currentTime), { origin: { owner: 'test.ui', kind: 'ui' } });
    expect(runner.pendingCallbacks).toBe(2);
    mgr.processUpTo(30, MAX_EVENTS);
    expect(fired).toEqual([5, 15]);
    expect(runner.pendingCallbacks).toBe(0);
    mgr.processUpTo(40, MAX_EVENTS);
    expect(fired, 'never twice').toEqual([5, 15]);
    runner.dispose();
  });

  it('a time in the past is clamped to now; a callback may plan the next one', () => {
    const { runner } = startLine();
    const mgr = runner.getManager();
    mgr.processUpTo(10, MAX_EVENTS);
    const fired: number[] = [];
    runner.scheduleCallback(2, () => {
      fired.push(mgr.currentTime);
      runner.scheduleCallback(mgr.currentTime + 3, () => fired.push(mgr.currentTime), { origin: { owner: 'test.ui', kind: 'ui' } });
    }, { origin: { owner: 'test.ui', kind: 'ui' } });
    mgr.processUpTo(20, MAX_EVENTS);
    expect(fired[0]).toBeGreaterThanOrEqual(10);
    expect(fired[1]).toBeCloseTo(fired[0] + 3, 9);
    runner.dispose();
  });

  it('cancel drops the callback; a handle of an older generation is ignored', () => {
    const { runner } = startLine();
    const mgr = runner.getManager();
    const fired: string[] = [];
    const h = runner.scheduleCallback(5, () => fired.push('a'), { origin: { owner: 'test.ui', kind: 'ui' } });
    runner.cancelCallback(h);
    runner.cancelCallback(h);
    runner.cancelCallback(null);
    mgr.processUpTo(10, MAX_EVENTS);
    expect(fired).toEqual([]);

    const old = runner.scheduleCallback(50, () => fired.push('old'), { origin: { owner: 'test.ui', kind: 'ui' } });
    runner.reset();                       // reset + bound: two new generations
    const fresh = runner.scheduleCallback(5, () => fired.push('new'), { origin: { owner: 'test.ui', kind: 'ui' } });
    runner.cancelCallback(old);           // stale handle: must not cancel anything
    mgr.processUpTo(60, MAX_EVENTS);
    expect(fired, 'the old generation never fires, the stale cancel hit nothing').toEqual(['new']);
    expect(fresh.generation).toBe(runner.lifecycleGeneration);
    runner.dispose();
  });

  it('every lifecycle event drops the pending callbacks (reset, clearMUs, rebind)', () => {
    const { runner } = startLine();
    const mgr = runner.getManager();
    const fired: string[] = [];
    runner.scheduleCallback(5, () => fired.push('before-rebind'), { origin: { owner: 'test.ui', kind: 'ui' } });
    runner.rebindScene();
    expect(runner.pendingCallbacks).toBe(0);
    mgr.processUpTo(10, MAX_EVENTS);
    expect(fired).toEqual([]);
    runner.scheduleCallback(15, () => fired.push('before-clear'), { origin: { owner: 'test.ui', kind: 'ui' } });
    runner.clearMUs();
    expect(runner.pendingCallbacks).toBe(0);
    runner.dispose();
  });

  it('a ui callback is NOT in a snapshot; after restored it can plan again (plan-2059 A4)', () => {
    const { runner } = startLine();
    const mgr = runner.getManager();
    const fired: number[] = [];
    runner.scheduleCallback(50, () => fired.push(mgr.currentTime), { origin: { owner: 'test.ui', kind: 'ui' } });
    mgr.processUpTo(10, MAX_EVENTS);
    const snap = runner.fullSnapshot();
    const actions = snap.eventQueue.map((e) => e.action);
    expect(actions.length, 'model events are written').toBeGreaterThan(0);
    expect(actions).not.toContain(DES_CALLBACK_ACTION);

    const r = record(runner);
    runner.restoreFull(snap);
    expect(r.log).toEqual(['restored@2']);
    expect(runner.pendingCallbacks, 'restored drops the pending callbacks').toBe(0);
    runner.scheduleCallback(30, () => fired.push(mgr.currentTime), { origin: { owner: 'test.ui', kind: 'ui' } });
    mgr.processUpTo(60, MAX_EVENTS);
    expect(fired, 'only the re-planned callback fires').toEqual([30]);
    runner.dispose();
  });

  it('an event of an action without persistence schema (the retired PalletYard.Clock) refuses the capture (plan-2059 A3/A4)', () => {
    const { runner } = startLine();
    const mgr = runner.getManager();
    if (!ACTION_INDEX.has('PalletYard.Clock')) registerAction('PalletYard.Clock', () => {});
    mgr.scheduleEvent(45, 'PalletYard.Clock', -1, -1, 0, { g: 1, k: 1 });
    expect(() => runner.fullSnapshot()).toThrow(/des-snapshot-contract.*PalletYard\.Clock.*no persistence schema/);
    runner.dispose();
  });

  it('fires during FastForward', async () => {
    const { runner } = startLine();
    const mgr = runner.getManager();
    const fired: number[] = [];
    runner.scheduleCallback(42, () => fired.push(mgr.currentTime), { origin: { owner: 'test.ui', kind: 'ui' } });
    const done = await runner.runFastForward();
    expect(done).toBe(true);
    expect(fired).toEqual([42]);
    runner.dispose();
  });

  it('a disposed runner drops its callbacks (a stray queue event is a no-op)', () => {
    const { runner } = startLine();
    const fired: string[] = [];
    runner.scheduleCallback(5, () => fired.push('x'), { origin: { owner: 'test.ui', kind: 'ui' } });
    runner.dispose();
    expect(runner.pendingCallbacks).toBe(0);
    expect(fired).toEqual([]);
  });
});


describe('planning callback priority', () => {
  it.each([false, true])('runs model, change, checkpoint (planning first: %s)', (planningFirst) => {
    const { runner } = startLine();
    const mgr = runner.getManager();
    const spy = vi.spyOn(mgr, 'scheduleEvent');
    const order: string[] = [];
    const clock = new DesSimClock(runner);
    const checkpoint = `PlanningTest.Checkpoint.${planningFirst}`;
    registerAction(checkpoint, () => { order.push('checkpoint'); });
    mgr.scheduleEvent(5, checkpoint, -1, -1, CHECKPOINT_PRIORITY);
    const model = () => runner.scheduleCallback(5, () => {
      order.push('model');
      runner.scheduleCallback(5, () => { order.push('model-child'); }, { origin: { owner: 'test.ui', kind: 'ui' } });
    }, { origin: { owner: 'test.ui', kind: 'ui' } });
    const change = () => clock.schedule(5, () => { order.push('change'); }, { afterModelEvents: true });
    if (planningFirst) { change(); model(); } else { model(); change(); }
    const priorities = spy.mock.calls.filter(c => c[1] === DES_CALLBACK_ACTION).map(c => c[4]);
    expect(priorities).toEqual(planningFirst ? [PLANNING_PRIORITY, 0] : [0, PLANNING_PRIORITY]);
    mgr.processUpTo(5, MAX_EVENTS);
    expect(order).toEqual(['model', 'model-child', 'change', 'checkpoint']);
    spy.mockRestore();
    clock.dispose();
    runner.dispose();
  });
});

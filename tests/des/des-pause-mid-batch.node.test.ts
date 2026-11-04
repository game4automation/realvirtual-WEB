// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2058 F02 (§9.2) — a pause set from INSIDE an event handler stops the
 * running batch right after that event, not only at the next batch entry:
 * the remaining due events stay queued, the clock stays at the last
 * dispatched event (it does not jump to the batch target), and resume
 * continues exactly there. The FastForward drain (`runBatch`) is the
 * documented exception — it resumes the manager itself and ignores the flag.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DESManager } from '@rv/plugins/des/rv-des-manager';
import { registerAction } from '@rv/plugins/des/rv-des-named-actions';

/** Dispatch log + the sim time at which the handler pauses its manager. */
const run = { log: [] as number[], pauseAt: Number.NaN };
const ACTION = registerAction('Plan2058.F02.Event', (ctx) => {
  run.log.push(ctx.simTime);
  if (ctx.simTime === run.pauseAt) (ctx.manager as DESManager).pause();
});

/** Events at t = 1, 2, 2, 3, 4, 5; the handler pauses at t = 2 (first of the burst). */
function manager(): DESManager {
  const m = new DESManager();
  m.duration = 1000;
  for (const t of [1, 2, 2, 3, 4, 5]) m.scheduleEventByIndex(t, ACTION, -1);
  run.pauseAt = 2;
  return m;
}

beforeEach(() => { run.log = []; run.pauseAt = Number.NaN; });

describe('pause mid-batch (plan-2058 F02)', () => {
  it('processEvents stops right after the pausing event; resume continues there', () => {
    const m = manager();
    expect(m.processEvents(100)).toBe(2);
    expect(run.log).toEqual([1, 2]);
    expect(m.isPaused).toBe(true);
    expect(m.currentTime).toBe(2);
    expect(m.nextEventTime).toBe(2); // the second t=2 event of the burst is still queued
    expect(m.processEvents(100)).toBe(0); // paused: nothing further
    run.pauseAt = Number.NaN;
    m.resume();
    expect(m.processEvents(100)).toBe(4);
    expect(run.log).toEqual([1, 2, 2, 3, 4, 5]);
    expect(m.currentTime).toBe(5);
  });

  it('processAnimated does not advance the clock past the queued events when paused mid-batch', () => {
    const m = manager();
    expect(m.processAnimated(10)).toBe(2);
    expect(m.currentTime).toBe(2); // not the batch target 10
    run.pauseAt = Number.NaN;
    m.resume();
    expect(m.processAnimated(10)).toBe(4);
    expect(run.log).toEqual([1, 2, 2, 3, 4, 5]);
    // Without a pause the Animated clock advances to its target as before.
    expect(m.currentTime).toBe(12);
  });

  it('processUpTo reports the early stop (hitBudget) so the caller does not advance its clock', () => {
    const m = manager();
    expect(m.processUpTo(10, 100)).toEqual({ processed: 2, hitBudget: true });
    expect(m.currentTime).toBe(2);
    expect(m.processUpTo(10, 100)).toEqual({ processed: 0, hitBudget: false }); // paused at entry
    run.pauseAt = Number.NaN;
    m.resume();
    expect(m.processUpTo(10, 100)).toEqual({ processed: 4, hitBudget: false });
    expect(m.currentTime).toBe(5);
  });

  it('processUpTo reports hitBudget for a mid-batch pause even when the next event lies beyond maxTime', () => {
    // Post-impl review of F02: the runner pulls its render clock back to
    // `currentTime` ONLY on hitBudget, and never calls again while paused — so a
    // pause must be reported regardless of where the next queued event sits.
    const m = new DESManager();
    m.duration = 1000;
    for (const t of [1, 2, 20]) m.scheduleEventByIndex(t, ACTION, -1);
    run.pauseAt = 2;
    expect(m.processUpTo(10, 100)).toEqual({ processed: 2, hitBudget: true });
    expect(m.isPaused).toBe(true);
    expect(m.currentTime).toBe(2);
    expect(m.nextEventTime).toBe(20); // beyond the frame target 10
    run.pauseAt = Number.NaN;
    m.resume();
    // Resumed, nothing due ≤ 10 and no pause: a plain, complete batch.
    expect(m.processUpTo(10, 100)).toEqual({ processed: 0, hitBudget: false });
    expect(m.processUpTo(30, 100)).toEqual({ processed: 1, hitBudget: false });
    expect(run.log).toEqual([1, 2, 20]);
    expect(m.currentTime).toBe(20);
  });

  it('processUpTo reports hitBudget when the pausing event empties the queue', () => {
    const m = manager();
    run.pauseAt = 5; // the last scheduled event — nothing is left queued afterwards
    expect(m.processUpTo(10, 100)).toEqual({ processed: 6, hitBudget: true });
    expect(m.isPaused).toBe(true);
    expect(m.currentTime).toBe(5);
    expect(m.nextEventTime).toBe(Number.POSITIVE_INFINITY);
  });

  it('a pause set by the last due event of a batch is a no-op for that batch', () => {
    const m = manager();
    run.pauseAt = 5;
    expect(m.processEvents(100)).toBe(6);
    expect(m.isPaused).toBe(true);
    expect(m.currentTime).toBe(5);
  });

  it('the FastForward drain (runBatch) is not stopped by the pause flag (documented exception)', () => {
    const m = manager();
    const { eventsProcessed, done } = m.runBatch(100);
    expect(eventsProcessed).toBe(6);
    expect(done).toBe(true);
    expect(run.log).toEqual([1, 2, 2, 3, 4, 5]);
  });
});

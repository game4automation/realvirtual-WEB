// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2058 F01 (§9.1) — the DES clock never runs backwards: an event time
 * that is in the past, NaN or ±Infinity is refused at scheduling time with a
 * clear error, instead of being queued and silently resetting the clock to an
 * earlier time when it dispatches. Covers every scheduling entry point
 * (absolute/relative, by name/by index, the checkpoint system event).
 */

import { describe, expect, it } from 'vitest';
import { DESManager, type IDESMU } from '@rv/plugins/des/rv-des-manager';
import { ACTION_INDEX, registerAction } from '@rv/plugins/des/rv-des-named-actions';

const ACTION = 'Plan2058.F01.Noop';
registerAction(ACTION, () => {});
const ACTION_IDX = ACTION_INDEX.get(ACTION)!;

/** A manager whose clock stands at t = 5 (one dispatched event). */
function managerAt5(): DESManager {
  const manager = new DESManager();
  manager.duration = 1000;
  manager.scheduleEvent(5, ACTION, -1);
  expect(manager.processEvents(10)).toBe(1);
  expect(manager.currentTime).toBe(5);
  return manager;
}

const INVALID = /event times must be finite and not earlier than the current simulation time/;

describe('DESManager event-time validation (plan-2058 F01)', () => {
  it.each([
    ['in the past', 4],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('refuses an absolute time %s on every entry point', (_label, time) => {
    const manager = managerAt5();
    const queued = manager.queuedEventCount;
    expect(() => manager.scheduleEvent(time, ACTION, -1)).toThrow(RangeError);
    expect(() => manager.scheduleEvent(time, ACTION, -1)).toThrow(INVALID);
    expect(() => manager.scheduleEventByIndex(time, ACTION_IDX, -1)).toThrow(INVALID);
    expect(() => manager.scheduleCheckpoint(time)).toThrow(INVALID);
    // Nothing reached the queue; the clock is untouched.
    expect(manager.queuedEventCount).toBe(queued);
    expect(manager.hasScheduledCheckpoint).toBe(false);
    expect(manager.currentTime).toBe(5);
  });

  it.each([
    ['negative', -0.001],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
  ])('refuses a relative delay %s (scheduleIn / scheduleInByIndex)', (_label, delay) => {
    const manager = managerAt5();
    expect(() => manager.scheduleIn(delay, ACTION, -1)).toThrow(INVALID);
    expect(() => manager.scheduleInByIndex(delay, ACTION_IDX, -1)).toThrow(INVALID);
    expect(manager.queuedEventCount).toBe(0);
  });

  it('names the action and the time in the error message', () => {
    const manager = managerAt5();
    expect(() => manager.scheduleEvent(3, ACTION, -1)).toThrow(`'${ACTION}'`);
    expect(() => manager.scheduleEvent(3, ACTION, -1)).toThrow('t=3');
  });

  it('accepts the current time and later times; the clock only moves forward', () => {
    const manager = managerAt5();
    expect(() => manager.scheduleEvent(5, ACTION, -1)).not.toThrow();
    expect(() => manager.scheduleIn(0, ACTION, -1)).not.toThrow();
    expect(() => manager.scheduleEvent(7.5, ACTION, -1)).not.toThrow();
    expect(() => manager.scheduleCheckpoint(10)).not.toThrow();
    const seen: number[] = [];
    let last = manager.currentTime;
    while (manager.queuedEventCount > 0 && manager.processEvents(1) > 0) {
      expect(manager.currentTime).toBeGreaterThanOrEqual(last);
      last = manager.currentTime;
      seen.push(last);
    }
    expect(seen).toEqual([5, 5, 7.5]);
  });

  it('a refused event leaves the pending-event refcount of its MU untouched', () => {
    const manager = managerAt5();
    const mu: IDESMU = { id: -1, generation: 0, childMUs: [], parentMU: null, pendingEvents: 0 };
    const muId = manager.registerMU(mu);
    expect(() => manager.scheduleEventByIndex(1, ACTION_IDX, -1, muId)).toThrow(INVALID);
    expect(mu.pendingEvents).toBe(0);
    manager.scheduleEventByIndex(6, ACTION_IDX, -1, muId);
    expect(mu.pendingEvents).toBe(1);
  });
});

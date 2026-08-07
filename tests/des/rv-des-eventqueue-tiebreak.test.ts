// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-des-eventqueue-tiebreak-restore (plan-261 §9.7 — blocker B1).
 *
 * Two events with identical (time, priority) must keep their relative FIFO
 * order across a snapshot/restore cycle. Before the B1 fix, `snapshot()`
 * iterated the heap arrays in MEMORY order and `restore()` assigned fresh ids
 * in that order — flipping the id tie-break for time-equal events.
 */

import { describe, it, expect } from 'vitest';
import { DESEventQueue } from '@rv-private/plugins/des/rv-des-event-queue';
import { DESManager } from '@rv-private/plugins/des/rv-des-manager';
import { registerAction, ACTION_INDEX } from '@rv-private/plugins/des/rv-des-named-actions';
import type { ActionContext } from '@rv-private/plugins/des/rv-des-event';

describe('DES event queue — tie-break determinism over snapshot/restore (B1)', () => {
  it('snapshot() returns events in dispatch order (time ASC, priority DESC, id ASC)', () => {
    const q = new DESEventQueue(4);
    // Interleave times so the heap memory layout differs from dispatch order.
    const idA = q.enqueue(10, 0, 0, -1, 0); // t=10, first
    q.enqueue(5, 1, 0, -1, 0);
    const idB = q.enqueue(10, 2, 0, -1, 0); // t=10, second (same prio)
    q.enqueue(1, 3, 0, -1, 0);
    q.enqueue(10, 4, 0, -1, 5);             // t=10, HIGHER priority → first at t=10

    const snap = q.snapshot();
    expect(snap.map((e) => e.time)).toEqual([1, 5, 10, 10, 10]);
    // At t=10: priority 5 first, then FIFO by id (idA before idB).
    expect(snap[2].priority).toBe(5);
    expect(snap[3].id).toBe(idA);
    expect(snap[4].id).toBe(idB);
  });

  it('time-/priority-equal events keep their dispatch order across manager restore', () => {
    const fired: string[] = [];
    const record = (tag: string) => (_ctx: ActionContext): void => { fired.push(tag); };
    if (!ACTION_INDEX.has('TieTest.A')) registerAction('TieTest.A', record('A'));
    if (!ACTION_INDEX.has('TieTest.B')) registerAction('TieTest.B', record('B'));
    if (!ACTION_INDEX.has('TieTest.C')) registerAction('TieTest.C', record('C'));

    const mkManager = (): DESManager => {
      const m = new DESManager();
      m.registerComponent({
        entityId: -1, path: 'Tie/Comp',
        attachManager: () => {}, resetStatistics: () => {},
      });
      return m;
    };

    const m1 = mkManager();
    // Same time, same priority — FIFO order A, B, C must survive the restore.
    m1.scheduleEvent(7, 'TieTest.A', 0, -1, 0);
    m1.scheduleEvent(7, 'TieTest.B', 0, -1, 0);
    m1.scheduleEvent(7, 'TieTest.C', 0, -1, 0);
    // Extra earlier events to shuffle the heap layout.
    m1.scheduleEvent(3, 'TieTest.A', 0, -1, 0);
    m1.scheduleEvent(1, 'TieTest.B', 0, -1, 0);

    const snap = m1.snapshot();

    // Reference: dispatch on the ORIGINAL manager.
    fired.length = 0;
    m1.processEvents(100);
    const refOrder = [...fired];

    // Restore into a fresh manager and dispatch again.
    const m2 = mkManager();
    m2.restore(snap);
    fired.length = 0;
    m2.processEvents(100);
    expect(fired).toEqual(refOrder);
    expect(fired.slice(-3)).toEqual(['A', 'B', 'C']);
  });
});

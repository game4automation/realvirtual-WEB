// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESEventQueue -- Core event queue tests.
 *
 * Validates 4-ary min-heap ordering, priority, cancellation,
 * capacity growth, and stress performance.
 */

import { describe, it, expect } from 'vitest';
import { DESEventQueue } from '@rv-private/plugins/des/rv-des-event-queue';

describe('DESEventQueue', () => {
  it('returns events in time order', () => {
    const q = new DESEventQueue(1000);
    q.enqueue(5.0, 0, 1, 0);
    q.enqueue(2.0, 0, 2, 0);
    q.enqueue(8.0, 0, 3, 0);
    expect(q.peekTime).toBe(2.0);

    const e1 = q.dequeue()!;
    expect(e1.time).toBe(2.0);
    const e2 = q.dequeue()!;
    expect(e2.time).toBe(5.0);
    const e3 = q.dequeue()!;
    expect(e3.time).toBe(8.0);
  });

  it('respects priority DESC at same time', () => {
    const q = new DESEventQueue(100);
    q.enqueue(10.0, 0, 1, 0, 1);  // low priority
    q.enqueue(10.0, 0, 2, 0, 5);  // high priority
    q.enqueue(10.0, 0, 3, 0, 3);  // mid priority

    const e1 = q.dequeue()!;
    expect(e1.priority).toBe(5);
    const e2 = q.dequeue()!;
    expect(e2.priority).toBe(3);
    const e3 = q.dequeue()!;
    expect(e3.priority).toBe(1);
  });

  it('respects id ASC at same time+priority (FIFO)', () => {
    const q = new DESEventQueue(100);
    const id1 = q.enqueue(10.0, 0, 1, 0, 0);
    const id2 = q.enqueue(10.0, 0, 2, 0, 0);
    const id3 = q.enqueue(10.0, 0, 3, 0, 0);

    const e1 = q.dequeue()!;
    expect(e1.id).toBe(id1);
    const e2 = q.dequeue()!;
    expect(e2.id).toBe(id2);
    const e3 = q.dequeue()!;
    expect(e3.id).toBe(id3);
  });

  it('peekTime returns Infinity on empty queue', () => {
    const q = new DESEventQueue(10);
    expect(q.peekTime).toBe(Infinity);
    expect(q.isEmpty).toBe(true);
  });

  it('handles 100K random events without heap corruption', () => {
    const q = new DESEventQueue(256);
    const N = 100_000;

    // Use a simple deterministic sequence for reproducibility
    let seed = 12345;
    for (let i = 0; i < N; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const time = (seed / 0x7fffffff) * 1000;
      q.enqueue(time, 0, i, 0);
    }

    expect(q.count).toBe(N);

    // Dequeue all and verify monotone non-decreasing
    let prevTime = -Infinity;
    let dequeued = 0;
    while (!q.isEmpty) {
      const e = q.dequeue()!;
      expect(e.time).toBeGreaterThanOrEqual(prevTime);
      prevTime = e.time;
      dequeued++;
    }
    expect(dequeued).toBe(N);
  });

  it('capacity auto-grows on overflow', () => {
    const q = new DESEventQueue(4); // tiny initial capacity
    for (let i = 0; i < 1000; i++) {
      q.enqueue(i * 0.1, 0, i, 0);
    }
    expect(q.count).toBe(1000);

    // Verify ordering after growth
    let prev = -Infinity;
    for (let i = 0; i < 1000; i++) {
      const e = q.dequeue()!;
      expect(e.time).toBeGreaterThanOrEqual(prev);
      prev = e.time;
    }
  });

  it('cancelled events are skipped on dequeue', () => {
    const q = new DESEventQueue(100);
    q.enqueue(1.0, 0, 1, 0);
    const id2 = q.enqueue(2.0, 0, 2, 0);
    q.enqueue(3.0, 0, 3, 0);

    // Cancel the middle event
    expect(q.cancel(id2)).toBe(true);

    const e1 = q.dequeue()!;
    expect(e1.time).toBe(1.0);
    const e2 = q.dequeue()!;
    expect(e2.time).toBe(3.0); // skipped t=2.0
    expect(q.dequeue()).toBeNull();
  });

  it('all-cancelled queue reports empty correctly', () => {
    const q = new DESEventQueue(10);
    const id1 = q.enqueue(1.0, 0, 1, 0);
    const id2 = q.enqueue(2.0, 0, 2, 0);

    q.cancel(id1);
    q.cancel(id2);

    expect(q.isEmpty).toBe(true);
    expect(q.peekTime).toBe(Infinity);
    expect(q.dequeue()).toBeNull();
  });

  it('snapshot and restore preserves events', () => {
    const q = new DESEventQueue(100);
    q.enqueue(5.0, 1, 10, 20, 3);
    q.enqueue(2.0, 0, 5, -1, 0);

    const snap = q.snapshot();
    expect(snap.length).toBe(2);

    const q2 = new DESEventQueue(100);
    q2.restore(snap);

    const e1 = q2.dequeue()!;
    expect(e1.time).toBe(2.0);
    const e2 = q2.dequeue()!;
    expect(e2.time).toBe(5.0);
    expect(e2.entityId).toBe(10);
    expect(e2.muId).toBe(20);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { DESEventQueue } from '@rv/plugins/des/rv-des-event-queue';

function runningQueue(): DESEventQueue {
  const q = new DESEventQueue(4);
  q.enqueue(0, 1, 10, -1); // processed, leaving an ID gap
  q.enqueue(10, 2, 11, 21, 2);
  const cancelled = q.enqueue(10, 3, 12, 22, 2);
  q.enqueue(10, 4, 13, 23, 2);
  q.enqueue(10, 5, 14, 24, 2);
  q.enqueue(5, 6, 15, 25, 1);
  q.enqueue(10, 7, 16, 26, 3);
  q.dequeue();
  q.cancel(cancelled);
  return q;
}

function drain(q: DESEventQueue) {
  const events = [];
  for (let event = q.dequeue(); event !== null; event = q.dequeue()) events.push(event);
  return events;
}

describe('snapshot event IDs', () => {
  it('retains gaps and the sequence counter, with the same dispatch order after continuation', () => {
    const original = runningQueue();
    const snapshot = original.snapshot();
    const restored = new DESEventQueue(4);
    restored.enqueue(99, 99, 99, -1); // restore replaces existing state
    restored.restoreWithIds([...snapshot].reverse(), 7);
    expect(restored.snapshot()).toEqual(snapshot);
    expect(snapshot.map(e => e.id)).toEqual([5, 6, 1, 3, 4]);
    expect(restored.indexSize).toBe(snapshot.length);
    const next = original.enqueue(10, 8, 17, 27, 2);
    expect(next).toBe(7);
    expect(restored.enqueue(10, 8, 17, 27, 2)).toBe(next);
    const expected = drain(original);
    expect(expected.map(e => e.id)).toEqual([5, 6, 1, 3, 4, 7]);
    expect(drain(restored)).toEqual(expected);
    expect(restored.indexSize).toBe(0);
  });

  it('cancels the correct event by its original ID immediately after restore', () => {
    const original = runningQueue();
    const restored = new DESEventQueue(4);
    restored.restoreWithIds(original.snapshot(), 7);
    expect(restored.muIdOf(3)).toBe(23);
    expect(restored.cancel(3)).toBe(true);
    expect(restored.cancel(2)).toBe(false); // gap is not reassigned
    original.cancel(3);
    expect(drain(restored)).toEqual(drain(original));
  });

  it('keeps legacy restore assigning fresh IDs in input order', () => {
    const q = runningQueue();
    const events = q.snapshot();
    q.restore(events);
    expect(q.snapshot()).toEqual(events.map((event, id) => ({ ...event, id })));
    expect(q.enqueue(20, 0, 0, -1)).toBe(events.length);
    q.restore([]);
    expect(q.enqueue(1, 0, 0, -1)).toBe(0);
  });
});

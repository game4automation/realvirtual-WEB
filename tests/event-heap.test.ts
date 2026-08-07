// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * event-heap.test.ts — plan-210 §6b (kernel-agnostic timer heap).
 *
 * Contract of `RVEventHeap`:
 *  - ordering by absolute virtual time; FIFO tie-break by registration order
 *  - `drainUntil(now)` pops ALL events with `time <= now` (delta-cycle drain,
 *    including events scheduled during the drain)
 *  - cancel (lazy tombstone) — never dispatched, size bookkeeping correct
 *  - multiple listeners per event (listener array, not single-slot)
 */

import { describe, it, expect } from 'vitest';
import { RVEventHeap, type ScheduledHookEvent } from '../src/core/sdk/rv-event-heap';

function collect(heap: RVEventHeap): ScheduledHookEvent[] {
  const out: ScheduledHookEvent[] = [];
  heap.addListener((ev) => out.push(ev));
  return out;
}

describe('RVEventHeap — ordering', () => {
  it('dispatches strictly by ascending time regardless of insertion order', () => {
    const heap = new RVEventHeap();
    const seen = collect(heap);
    heap.schedule(3, 'c');
    heap.schedule(1, 'a');
    heap.schedule(2, 'b');
    heap.drainUntil(10);
    expect(seen.map((e) => e.hook)).toEqual(['a', 'b', 'c']);
    expect(seen.map((e) => e.time)).toEqual([1, 2, 3]);
  });

  it('ties at the same time break FIFO by registration order', () => {
    const heap = new RVEventHeap();
    const seen = collect(heap);
    heap.schedule(5, 'first');
    heap.schedule(5, 'second');
    heap.schedule(5, 'third');
    heap.schedule(1, 'earliest');
    heap.drainUntil(5);
    expect(seen.map((e) => e.hook)).toEqual(['earliest', 'first', 'second', 'third']);
  });

  it('rejects non-finite times', () => {
    const heap = new RVEventHeap();
    expect(() => heap.schedule(Number.NaN, 'x')).toThrow(/non-finite/);
    expect(() => heap.schedule(Infinity, 'x')).toThrow(/non-finite/);
  });
});

describe('RVEventHeap — continuous drain (time <= now)', () => {
  it('drains only due events; later events stay pending', () => {
    const heap = new RVEventHeap();
    const seen = collect(heap);
    heap.schedule(0.5, 'due');
    heap.schedule(1.0, 'alsoDue');
    heap.schedule(1.0001, 'notYet');
    const n = heap.drainUntil(1.0);
    expect(n).toBe(2);
    expect(seen.map((e) => e.hook)).toEqual(['due', 'alsoDue']);
    expect(heap.size).toBe(1);
    expect(heap.peekTime()).toBeCloseTo(1.0001);
  });

  it('events scheduled during the drain run in the same drain when due (delta cycle)', () => {
    const heap = new RVEventHeap();
    const order: string[] = [];
    heap.addListener((ev) => {
      order.push(ev.hook);
      if (ev.hook === 'a') heap.schedule(ev.time, 'chained'); // same time, still due
    });
    heap.schedule(1, 'a');
    heap.schedule(2, 'b');
    heap.drainUntil(2);
    expect(order).toEqual(['a', 'chained', 'b']);
  });

  it('carries mu and data payloads through', () => {
    const heap = new RVEventHeap();
    const seen = collect(heap);
    const mu = { id: 7 };
    heap.schedule(1, 'arrive', mu, { note: 'x' });
    heap.drainUntil(1);
    expect(seen[0].mu).toBe(mu);
    expect(seen[0].data).toEqual({ note: 'x' });
  });
});

describe('RVEventHeap — cancel', () => {
  it('cancelled events never dispatch and size reflects the cancellation', () => {
    const heap = new RVEventHeap();
    const seen = collect(heap);
    heap.schedule(1, 'keep');
    const id = heap.schedule(2, 'drop');
    heap.schedule(3, 'keep2');
    expect(heap.size).toBe(3);
    expect(heap.cancel(id)).toBe(true);
    expect(heap.size).toBe(2);
    heap.drainUntil(10);
    expect(seen.map((e) => e.hook)).toEqual(['keep', 'keep2']);
  });

  it('cancel of unknown / already-fired / already-cancelled ids returns false', () => {
    const heap = new RVEventHeap();
    const id = heap.schedule(1, 'x');
    heap.drainUntil(1); // fires
    expect(heap.cancel(id)).toBe(false);
    expect(heap.cancel(9999)).toBe(false);
    const id2 = heap.schedule(2, 'y');
    expect(heap.cancel(id2)).toBe(true);
    expect(heap.cancel(id2)).toBe(false);
  });

  it('cancelled top does not block peekTime', () => {
    const heap = new RVEventHeap();
    const id = heap.schedule(1, 'a');
    heap.schedule(2, 'b');
    heap.cancel(id);
    expect(heap.peekTime()).toBe(2);
  });
});

describe('RVEventHeap — multiple handlers per event', () => {
  it('every listener receives every event (listener array)', () => {
    const heap = new RVEventHeap();
    const a: string[] = [];
    const b: string[] = [];
    heap.addListener((ev) => a.push(ev.hook));
    heap.addListener((ev) => b.push(ev.hook));
    heap.schedule(1, 'x');
    heap.drainUntil(1);
    expect(a).toEqual(['x']);
    expect(b).toEqual(['x']);
  });

  it('unsubscribe removes only the one listener; a throwing listener does not block others', () => {
    const heap = new RVEventHeap();
    const seen: string[] = [];
    const off = heap.addListener(() => seen.push('gone'));
    heap.addListener(() => { throw new Error('boom'); });
    heap.addListener((ev) => seen.push(ev.hook));
    off();
    heap.schedule(1, 'x');
    heap.drainUntil(1);
    expect(seen).toEqual(['x']);
  });
});

describe('RVEventHeap — clear', () => {
  it('drops all pending events', () => {
    const heap = new RVEventHeap();
    const seen = collect(heap);
    heap.schedule(1, 'a');
    heap.schedule(2, 'b');
    heap.clear();
    expect(heap.size).toBe(0);
    heap.drainUntil(10);
    expect(seen).toEqual([]);
  });
});

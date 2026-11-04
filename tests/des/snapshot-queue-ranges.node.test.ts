// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { DESEventQueue } from '@rv/plugins/des/rv-des-event-queue';
import { preflightSnapshot, type PreflightContext } from '@rv/plugins/des/rv-des-preflight';

const MAX_ID = 2 ** 32 - 1;
const event = { id: 1, time: 5, actionIndex: 0, entityId: 1, muId: -1, priority: 0 };
type Event = typeof event;
const invalid: Array<{ label: string; events: Event[]; nextId: number }> = [];
for (const value of [-1, 0.5, MAX_ID + 1, NaN, Infinity, -Infinity]) {
  invalid.push({ label: `id=${value}`, events: [{ ...event, id: value }], nextId: 10 });
  invalid.push({ label: `nextId=${value}`, events: [event], nextId: value });
}
invalid.push(
  { label: 'duplicate id', events: [event, { ...event, time: 6 }], nextId: 10 },
  { label: 'id equals nextId', events: [event], nextId: 1 },
  { label: 'id exceeds nextId', events: [event], nextId: 0 },
  { label: 'maximum ID cannot be below nextId', events: [{ ...event, id: MAX_ID }], nextId: MAX_ID },
);
for (const field of ['priority', 'entityId', 'muId'] as const) {
  for (const value of [-(2 ** 31) - 1, 2 ** 31, 0.5, NaN, Infinity, -Infinity])
    invalid.push({ label: `${field}=${value}`, events: [{ ...event, [field]: value }], nextId: 10 });
}
for (const time of [NaN, Infinity, -Infinity])
  invalid.push({ label: `time=${time}`, events: [{ ...event, time }], nextId: 10 });
for (const actionIndex of [-1, 0.5, MAX_ID + 1, NaN, Infinity])
  invalid.push({ label: `actionIndex=${actionIndex}`, events: [{ ...event, actionIndex }], nextId: 10 });

describe('snapshot queue numeric ranges', () => {
  it.each(invalid)('rejects $label before any mutation', ({ events, nextId }) => {
    const q = new DESEventQueue(4);
    q.enqueue(2, 2, 2, 2);
    const cancelled = q.enqueue(3, 3, 3, 3);
    q.cancel(cancelled);
    const before = q.getSnapshot();
    // Put a valid entry before the invalid entry to catch partial application.
    expect(() => q.restoreWithIds([{ ...event, id: 0 }, ...events], nextId)).toThrow(RangeError);
    expect(q.getSnapshot()).toEqual(before);
    expect(q.count).toBe(2);
    expect(q.indexSize).toBe(2);
    expect(q.muIdOf(0)).toBe(2);
    expect(q.enqueue(4, 4, 4, 4)).toBe(2); // counter also unchanged
    expect(q.cancel(0)).toBe(true); // original ID index still works
    expect(q.dequeue()?.id).toBe(2);
    expect(q.dequeue()).toBeNull();
  });

  it('accepts representable boundary values and the last usable event ID', () => {
    const q = new DESEventQueue(4);
    const events = [
      { ...event, id: 0, time: -Number.MAX_VALUE, entityId: -(2 ** 31), muId: 2 ** 31 - 1,
        priority: -(2 ** 31), actionIndex: MAX_ID },
      { ...event, id: MAX_ID - 1, time: Number.MAX_VALUE, priority: 2 ** 31 - 1 },
    ];
    q.restoreWithIds(events, MAX_ID);
    expect(q.snapshot()).toEqual(events);
    expect(() => q.enqueue(6, 0, 0, -1)).toThrow('des-event-id-overflow');
    expect(q.snapshot()).toEqual(events);
    q.restoreWithIds([], 0);
    expect(q.enqueue(0, 0, 0, -1)).toBe(0);
  });

  it('throws at sequence exhaustion without changing the queue or counter', () => {
    const q = new DESEventQueue(4);
    q.restoreWithIds([], MAX_ID);
    for (let i = 0; i < 2; i++) {
      expect(() => q.enqueue(0, 0, 0, -1)).toThrow(new RangeError('des-event-id-overflow'));
      expect(q.count).toBe(0);
      expect(q.indexSize).toBe(0);
    }
    q.clear();
    q.restoreWithIds([], MAX_ID - 1);
    expect(q.enqueue(0, 0, 0, -1)).toBe(MAX_ID - 1);
    expect(() => q.enqueue(0, 0, 0, -1)).toThrow('des-event-id-overflow');
    expect(q.dequeue()?.id).toBe(MAX_ID - 1);
  });
});

describe('preflight queue numeric ranges', () => {
  const ctx: PreflightContext = {
    fingerprint: { schemaVersion: 4, rngVersion: 2, modelHash: 'ranges', runConfigHash: 'run', components: [] },
    participants: new Map([['global', { version: 1, validate: () => [] }]]),
    componentTypeOf: () => undefined,
    getActionSchema: () => ({ owner: 'global', payload: 'none' }),
  };
  const cases: Array<{ field: string; value: number }> = [];
  for (const field of ['id', 'nextEventId'])
    for (const value of [-1, 0.5, MAX_ID + 1, NaN, Infinity, -Infinity]) cases.push({ field, value });
  for (const field of ['priority', 'muId'])
    for (const value of [-(2 ** 31) - 1, 2 ** 31, 0.5, NaN, Infinity, -Infinity]) cases.push({ field, value });
  for (const value of [NaN, Infinity, -Infinity, 4]) cases.push({ field: 'time', value });
  for (const value of [NaN, Infinity, -Infinity, -1]) cases.push({ field: 'simTime', value });

  function snapshot() {
    return {
      version: 4, fingerprint: ctx.fingerprint, simTime: 5, nextEventId: 2,
      eventQueue: [{ id: 1, time: 5, action: 'range-test', componentId: null, muId: -1, priority: 0 }],
      muIds: [] as number[], parts: [{ key: 'global', version: 1, state: null }],
    };
  }
  it.each(cases)('rejects $field=$value without mutation', ({ field, value }) => {
    const raw = snapshot();
    Reflect.set(field === 'nextEventId' || field === 'simTime' ? raw : raw.eventQueue[0], field, value);
    const before = structuredClone(raw);
    const result = preflightSnapshot(raw, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.some(p => p.path?.endsWith(field))).toBe(true);
    expect(raw).toEqual(before);
  });

  it('accepts numeric boundaries and the final usable event ID', () => {
    const raw = snapshot();
    raw.nextEventId = MAX_ID;
    raw.muIds = [2 ** 31 - 1];
    raw.eventQueue = [
      { ...raw.eventQueue[0], id: 0, muId: 2 ** 31 - 1, priority: -(2 ** 31) },
      { ...raw.eventQueue[0], id: MAX_ID - 1, time: Number.MAX_VALUE, priority: 2 ** 31 - 1 },
    ];
    expect(preflightSnapshot(raw, ctx)).toEqual({ ok: true });
    raw.eventQueue = []; raw.nextEventId = 0;
    expect(preflightSnapshot(raw, ctx)).toEqual({ ok: true });
  });
});

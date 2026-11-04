// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Capture-boundary tests: inspect raw state before JSON can conceal loss. */
import { describe, expect, it, vi } from 'vitest';
import {
  assertEventTime, assertSnapshotData, createCaptureSession, fromSnapshotData, toSnapshotData,
  type SnapshotContext, type SnapshotContractError,
} from '@rv/plugins/des/rv-snapshot-contract';

const ctx: SnapshotContext = { participant: 'orders' };

describe('snapshot data contract', () => {
  it('copies the allowlist, including null-prototype objects and special string keys', () => {
    const live = { text: 'ok', yes: true, no: false, count: 12.5, zero: 0,
      values: [null, { done: 2 }], dict: Object.assign(Object.create(null), { item: 1 }) };
    const data = toSnapshotData(live, ctx);
    expect(data).toEqual(live);
    live.values[1]!.done = 9;
    live.dict.item = 4;
    expect(data).toMatchObject({ values: [null, { done: 2 }], dict: { item: 1 } });
    const special = JSON.parse('{"__proto__":{"safe":true},"constructor":1}');
    const copy = toSnapshotData(special, ctx);
    expect(Object.hasOwn(copy as object, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(JSON.stringify(copy)).toBe(JSON.stringify(special));
    expect(() => assertSnapshotData(data)).not.toThrow();
  });

  it.each([
    ['undefined', undefined], ['function', () => 1], ['symbol', Symbol('bad')], ['BigInt', 1n],
    ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['-0', -0],
    ['Map', new Map()], ['Set', new Set()], ['Date', new Date(0)],
    ['class', new (class State {})()], ['typed array', new Uint8Array(2)],
    ['DataView', new DataView(new ArrayBuffer(2))], ['ArrayBuffer', new ArrayBuffer(2)],
    ['WeakMap', new WeakMap()], ['WeakSet', new WeakSet()], ['RegExp', /x/],
    ['boxed number', new Number(2)], ['Error', new Error('state')], ['Promise', Promise.resolve(1)],
  ])('rejects %s with participant and exact nested field path', (_name, value) => {
    const session = createCaptureSession();
    expect(() => session.capture('orders', { open: [0, 1, 2, { due: value }] }))
      .toThrow('orders.open[3].due');
    expect(session.errors()).toEqual([expect.objectContaining({
      code: 'des-snapshot-contract', participant: 'orders', path: 'open[3].due',
    })]);
  });

  it('reports all violations in one error', () => {
    try {
      assertSnapshotData({ a: undefined, b: [NaN, () => 1] }, ctx);
      expect.unreachable('invalid data accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const errors = (error as Error & { errors: SnapshotContractError[] }).errors;
      expect(errors.map(e => e.path)).toEqual(['a', 'b[0]', 'b[1]']);
    }
  });

  it('rejects holes, extra array fields, symbol keys and hidden fields', () => {
    expect(() => toSnapshotData({ open: new Array(2) }, ctx)).toThrow('open[0]');
    expect(() => toSnapshotData({ open: Object.assign([], { extra: 2 }) }, ctx)).toThrow('open.extra');
    expect(() => toSnapshotData({ [Symbol('hidden')]: 1 }, ctx)).toThrow('symbol key');
    expect(() => toSnapshotData(Object.defineProperty({}, 'hidden', { value: 2 }), ctx)).toThrow('hidden');
  });

  it('rejects getters and setters on objects and arrays without calling them', () => {
    const access = vi.fn(() => { throw new Error('must not execute'); });
    for (const descriptor of [{ get: access }, { set: access }]) {
      const object = Object.defineProperty({}, 'due', { ...descriptor, enumerable: true });
      const array = Object.defineProperty([], '0', { ...descriptor, enumerable: true });
      expect(() => toSnapshotData(object, ctx)).toThrow('orders.due: accessor');
      expect(() => toSnapshotData(array, ctx)).toThrow('orders.[0]: accessor');
    }
    expect(access).not.toHaveBeenCalled();
  });

  it('rejects cycles and aliases with both source paths', () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    expect(() => toSnapshotData(cycle, ctx)).toThrow('cycle');
    const shared = { due: 1 };
    expect(() => toSnapshotData({ first: shared, second: shared }, ctx))
      .toThrow('orders.second: alias: same object as orders.first');
    const session = createCaptureSession();
    session.capture('first', { local: shared });
    expect(() => session.capture('second', { other: shared }))
      .toThrow('second.other: alias: same object as first.local');
    const diagnostics = session.errors();
    diagnostics[0].reason = 'changed externally';
    expect(session.errors()[0].reason).toContain('first.local');
    expect(() => createCaptureSession().capture('next capture', shared)).not.toThrow();
  });

  it('roundtrips schema codecs through JSON, preserving numeric tags and collection order', () => {
    const context: SnapshotContext = { participant: 'fleet', codecs: {
      releaseEvents: 'map', held: 'set', 'vehicles[].fieldCap': 'number-tags',
      'releaseEvents[][1].due': 'number-tags',
    } };
    const live = {
      releaseEvents: new Map<string | number, { due: number }>([['b', { due: Infinity }], [7, { due: -0 }], ['a', { due: 3 }]]),
      held: new Set(['z', 'a']),
      vehicles: [NaN, Infinity, -Infinity, -0, 0, 42].map(fieldCap => ({ fieldCap })),
    };
    const data = toSnapshotData(live, context);
    const wire = JSON.parse(JSON.stringify(data));
    const restored = fromSnapshotData(wire, context) as typeof live;
    expect([...restored.releaseEvents.keys()]).toEqual(['b', 7, 'a']);
    expect([...restored.held]).toEqual(['z', 'a']);
    expect(Object.is(restored.releaseEvents.get(7)!.due, -0)).toBe(true);
    live.vehicles.forEach((v, i) => expect(Object.is(v.fieldCap, restored.vehicles[i].fieldCap)).toBe(true));
    live.releaseEvents.get('b')!.due = 9;
    live.held.add('later');
    expect(JSON.stringify(data)).toBe(JSON.stringify(wire));
    expect(restored.releaseEvents.get('b')!.due).toBe(Infinity);
  });

  it.each([
    [new Map(), { $map: [] }], [new Set(), { $set: [] }], [Infinity, { $num: 'Infinity' }],
  ])('requires explicit field permission on both encode and decode', (value, tag) => {
    expect(() => toSnapshotData({ field: value }, ctx)).toThrow('orders.field');
    expect(() => fromSnapshotData({ field: tag }, ctx)).toThrow('orders.field');
    expect(() => toSnapshotData({ field: value }, { ...ctx, codecs: { other: 'map' } })).toThrow();
  });

  it('rejects malformed tags and collection entries', () => {
    for (const value of [{ $num: 'oops' }, { $num: 'NaN', extra: 1 }])
      expect(() => fromSnapshotData(value, { ...ctx, codecs: { '': 'number-tags' } })).toThrow();
    for (const value of [{ $map: 2 }, { $map: [[true, 1]] }, { $map: [['a']] }, { $map: [['a', 1], ['a', 2]] }])
      expect(() => fromSnapshotData(value, { ...ctx, codecs: { '': 'map' } })).toThrow();
    expect(() => fromSnapshotData({ $set: [1, 1] }, { ...ctx, codecs: { '': 'set' } })).toThrow('duplicate');
    expect(() => toSnapshotData(new Map([[{}, 1]]), { ...ctx, codecs: { '': 'map' } })).toThrow('Map key');
  });

  it('does not allow codec paths to conceal aliases or cycles', () => {
    const shared = {};
    expect(() => toSnapshotData(new Map([['a', shared], ['b', shared]]), { ...ctx, codecs: { '': 'map' } })).toThrow('alias');
    const set = new Set<unknown>(); set.add(set);
    expect(() => toSnapshotData(set, { ...ctx, codecs: { '': 'set' } })).toThrow('cycle');
    expect(() => toSnapshotData({ 'vehiclesX': [{ fieldCap: Infinity }] }, {
      ...ctx, codecs: { 'vehicles[].fieldCap': 'number-tags' },
    })).toThrow();
  });

  it('decodes ordinary JSON into detached containers too', () => {
    const wire = { nested: [{ count: 1 }] };
    const result = fromSnapshotData(wire, ctx);
    wire.nested[0].count = 7;
    expect(result).toEqual({ nested: [{ count: 1 }] });
  });

  it.each([NaN, Infinity, -Infinity, 4])('rejects invalid or past event time %s', time => {
    expect(() => assertEventTime(time, 5)).toThrow(RangeError);
  });
  it('accepts current/future event times and rejects a non-finite simulation clock', () => {
    expect(() => assertEventTime(5, 5)).not.toThrow();
    expect(() => assertEventTime(6, 5)).not.toThrow();
    expect(() => assertEventTime(6, NaN)).toThrow();
    expect(() => assertEventTime(6, Infinity)).toThrow();
  });

  it('first declared codec wins across exact and [] patterns, and a reused codecs object keeps answering the same', () => {
    // plan-2059 O8: the codec table is compiled once per codecs object; declaration order must survive it.
    const value = { list: [new Set([1])] };
    const setFirst: SnapshotContext = { ...ctx, codecs: { 'list[]': 'set', 'list[0]': 'map' } };
    const exactFirst: SnapshotContext = { ...ctx, codecs: { 'list[0]': 'set', 'list[]': 'map' } };
    for (let i = 0; i < 3; i++) {
      expect(toSnapshotData(value, setFirst)).toEqual({ list: [{ $set: [1] }] });
      expect(toSnapshotData(value, exactFirst)).toEqual({ list: [{ $set: [1] }] });
    }
    // 'list[]' declared first matches 'list[0]' too; as the map codec it must refuse a Set.
    expect(() => toSnapshotData(value, { ...ctx, codecs: { 'list[]': 'map', 'list[0]': 'set' } })).toThrow();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { OrderPool, type OrderPoolState } from '../../src/core/fleet/core/orders';

function fixture() {
  const pool = new OrderPool();
  const a = pool.add({ source: 'pick', destination: 'drop' }, 0);
  const b = pool.add({ source: 'pick' }, 1);
  const c = pool.add({ source: 'pick' }, 2);
  const d = pool.add({ source: 'other' }, 3);
  const done = pool.add({ source: 'done' }, 4);
  Object.defineProperty(a, 'payload', { value: { nested: [1] }, enumerable: true });
  pool.assign(b, 'v1', 5); pool.markPicked(b, 6);
  pool.assign(c, 'v2', 7); pool.requeue(c);
  pool.assign(d, 'v3', 8); pool.complete(done, 9);
  return { pool, a };
}
describe('OrderPool state', () => {
  it('round trips ordered state, payload presence, and listeners through reset', () => {
    const { pool } = fixture();
    const state = pool.exportState(), text = JSON.stringify(state);
    expect(state.bySource[0].orderIds).toEqual([1, 3]);
    expect(Object.hasOwn(state.open[0], 'payload')).toBe(true);
    expect(Object.hasOwn(state.open[1], 'payload')).toBe(false);
    const listener = vi.fn(); pool.onComplete(listener);
    const prepared = pool.prepareState(JSON.parse(text));
    pool.reset(); pool.swapState(prepared);
    expect(listener).not.toHaveBeenCalled();
    expect(JSON.stringify(pool.exportState())).toBe(text);
    pool.complete(pool.openOf('pick')!, 10);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('detaches exported and prepared records; a payload stays live for the contract to copy', () => {
    const { pool, a } = fixture();
    const state = pool.exportState(), text = JSON.stringify(state);
    pool.assign(a, 'changed', 99);
    expect(JSON.stringify(state)).toBe(text);
    expect(state.open[0].payload).toBe(a.payload);
    const prepared = pool.prepareState(state);
    state.open[0].times.created = 999;
    state.bySource[0].orderIds.reverse();
    pool.swapState(prepared);
    expect(JSON.stringify(pool.exportState())).toBe(text);
  });
  const cases: Array<[string, (s: OrderPoolState) => void]> = [
    ['unknown field', s => Object.assign(s, { extra: 1 })],
    ['missing field', s => Reflect.deleteProperty(s, 'completed')],
    ['duplicate id', s => s.open.push(s.open[0])],
    ['nextId', s => { s.nextId = 1; }],
    ['state', s => Object.assign(s.open[0], { state: 'bad' })],
    ['unknown reference', s => s.bySource[0].orderIds.push(999)],
    ['carrying reference', s => s.bySource[0].orderIds.push(2)],
    ['missing reference', s => { s.bySource[0].orderIds = [3]; }],
    ['wrong source', s => { s.bySource[0].source = 'wrong'; }],
    ['duplicate reference', s => s.bySource[0].orderIds.push(1)],
    ['empty list', s => { s.bySource[0].orderIds = []; }],
    ['duplicate source', s => s.bySource.push(s.bySource[0])],
    ['negative completed', s => { s.completed = -1; }],
    ['nonfinite priority', s => { Object.assign(s.open[0], { priority: Infinity }); }],
    ['missing time', s => Reflect.deleteProperty(s.open[0].times, 'created')],
    ['unknown time field', s => Object.assign(s.open[0].times, { extra: 1 })],
    ['nonfinite time', s => { s.open[0].times.created = NaN; }],
  ];
  it.each(cases)('rejects %s without mutation', (_name, mutate) => {
    const { pool } = fixture(), before = JSON.stringify(pool.exportState());
    const state = pool.exportState(); mutate(state);
    expect(OrderPool.validateState(state).length).toBeGreaterThan(0);
    expect(() => pool.prepareState(state)).toThrow();
    expect(JSON.stringify(pool.exportState())).toBe(before);
  });
  it('checks optional station knowledge', () => {
    const { pool } = fixture();
    expect(OrderPool.validateState(pool.exportState(), { stationKnown: () => false }).length).toBeGreaterThan(0);
    expect(OrderPool.validateState(pool.exportState(), { stationKnown: () => true })).toEqual([]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { OrderPool } from '../../src/core/fleet/core/orders';

describe('OrderPool completion observers', () => {
  it('notifies once per complete after the existing state changes', () => {
    const pool = new OrderPool();
    const order = pool.add({ source: 'A' }, 2);
    const listener = vi.fn(() => ({
      state: order.state, done: order.times.done, count: pool.doneCount, open: pool.openOf('A'),
    }));
    pool.onComplete(listener);
    pool.complete(order, 12);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(order, 12);
    expect(listener.mock.results[0].value).toEqual({ state: 'done', done: 12, count: 1, open: null });
  });

  it('ignores fail, cancel and requeue, preserves listeners on reset and supports unsubscribe', () => {
    const pool = new OrderPool();
    const listener = vi.fn();
    const off = pool.onComplete(listener);
    pool.fail(pool.add({ source: 'A' }, 0), 3);
    pool.cancel(pool.add({ source: 'A' }, 0));
    pool.requeue(pool.add({ source: 'A' }, 0));
    expect(listener).not.toHaveBeenCalled();
    pool.reset();
    pool.complete(pool.add({ source: 'A' }, 0), 4);
    expect(listener).toHaveBeenCalledTimes(1);
    off(); off();
    pool.complete(pool.add({ source: 'A' }, 0), 5);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates throwing observers and continues notifying', () => {
    const pool = new OrderPool();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const error = new Error('observer');
      pool.onComplete(() => { throw error; });
      const listener = vi.fn();
      pool.onComplete(listener);
      const order = pool.add({ source: 'A' }, 0);
      expect(() => pool.complete(order, 7)).not.toThrow();
      expect(order.state).toBe('done');
      expect(pool.doneCount).toBe(1);
      expect(listener).toHaveBeenCalledWith(order, 7);
      expect(warn).toHaveBeenCalledWith('[OrderPool] completion listener failed', error);
    } finally { warn.mockRestore(); }
  });
});

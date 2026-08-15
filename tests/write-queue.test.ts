// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-709 §2.2.1-3 — the per-backend write queue, on its own.
 *
 * `WriteQueue` was covered only indirectly, through the backends that own one:
 * every existing assertion about serialised writes goes through a browser or
 * folder backend and therefore also proves something about OPFS, localStorage
 * and revision preconditions. That makes the queue's own four properties
 * expensive to state and easy to lose, so they are pinned here directly:
 *
 *  - **order** — `run()` is strictly serial. Task B does not START before task
 *    A has SETTLED; an event list plus manually released promises is the only
 *    way to show the difference between "serialised" and "merely awaited";
 *  - **error isolation** — a rejection reaches ITS caller and nobody else, and
 *    the queue keeps running afterwards. The tail continues with a settled
 *    promise, which is what stops one failed write from wedging the session
 *    (the file's own words);
 *  - **drain()** — resolves only once everything queued before it has settled,
 *    including after a rejection, because a drain that resolved early would let
 *    a project switch proceed over a write still in flight;
 *  - **instance separation** — the queue lives on the backend INSTANCE by
 *    design (§"The queue lives on the INSTANCE, deliberately"). A hung write in
 *    one queue must not delay another, or the project the user just left would
 *    hold up the one they opened.
 */

import { describe, it, expect } from 'vitest';
import { WriteQueue } from '../src/core/project/backends/write-queue';

/** A promise plus its resolvers — the only way to control settle order. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every already-settled microtask continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ─── Order ────────────────────────────────────────────────────────────────

describe('WriteQueue.run — strict serialisation', () => {
  it('does not start B before A has settled', async () => {
    const queue = new WriteQueue();
    const events: string[] = [];
    const a = deferred();
    const b = deferred();

    const first = queue.run(async () => {
      events.push('A:start');
      await a.promise;
      events.push('A:end');
    });
    const second = queue.run(async () => {
      events.push('B:start');
      await b.promise;
      events.push('B:end');
    });

    // Both are queued, but only A is running: the whole point of the queue.
    await settle();
    expect(events).toEqual(['A:start']);

    a.resolve();
    await settle();
    expect(events).toEqual(['A:start', 'A:end', 'B:start']);

    b.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('keeps the enqueue order for many tasks, whatever their duration', async () => {
    const queue = new WriteQueue();
    const order: number[] = [];

    // Descending delays: without the queue the fastest would finish first.
    const runs = [30, 20, 10, 0].map((delay, i) =>
      queue.run(async () => {
        await new Promise(resolve => setTimeout(resolve, delay));
        order.push(i);
      }));

    await Promise.all(runs);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('hands each caller its own result', async () => {
    const queue = new WriteQueue();
    const results = await Promise.all([
      queue.run(async () => 'first'),
      queue.run(async () => 'second'),
    ]);
    expect(results).toEqual(['first', 'second']);
  });
});

// ─── Error isolation ──────────────────────────────────────────────────────

describe('WriteQueue.run — a rejection belongs to its caller only', () => {
  it('rejects the failing call and nobody else, and the queue runs on', async () => {
    const queue = new WriteQueue();
    const events: string[] = [];

    const failing = queue.run(async () => {
      events.push('bad:start');
      throw new Error('disk full');
    });
    const next = queue.run(async () => {
      events.push('good:start');
      return 'written';
    });

    await expect(failing).rejects.toThrow('disk full');
    // The second caller sees a clean result — not the first one's failure.
    await expect(next).resolves.toBe('written');
    expect(events).toEqual(['bad:start', 'good:start']);
  });

  it('a task queued AFTER the rejection still starts and resolves', async () => {
    const queue = new WriteQueue();
    await expect(queue.run(async () => { throw new Error('nope'); })).rejects.toThrow('nope');

    // The tail was continued with a settled promise, so this is not blocked.
    await expect(queue.run(async () => 'later')).resolves.toBe('later');
  });

  it('a synchronous throw is a rejection too, not a wedged queue', async () => {
    const queue = new WriteQueue();
    await expect(queue.run((): Promise<string> => { throw new Error('sync'); }))
      .rejects.toThrow('sync');
    await expect(queue.run(async () => 'still alive')).resolves.toBe('still alive');
  });
});

// ─── drain() ──────────────────────────────────────────────────────────────

describe('WriteQueue.drain', () => {
  it('resolves only after everything queued before it has settled', async () => {
    const queue = new WriteQueue();
    const gate = deferred();
    let drained = false;

    const pending = queue.run(() => gate.promise);
    const draining = queue.drain().then(() => { drained = true; });

    await settle();
    expect(drained).toBe(false);          // the write is still in flight

    gate.resolve();
    await Promise.all([pending, draining]);
    expect(drained).toBe(true);
  });

  it('resolves after a REJECTED write instead of rejecting with it', async () => {
    const queue = new WriteQueue();
    const gate = deferred();
    let drained = false;

    const failing = queue.run(() => gate.promise);
    // Attached immediately: an unhandled rejection here would fail the run for
    // a reason that has nothing to do with what is being asserted.
    const failed = failing.then(() => 'resolved', (e: Error) => e.message);
    const draining = queue.drain().then(() => { drained = true; });

    await settle();
    expect(drained).toBe(false);

    gate.reject(new Error('write failed'));
    expect(await failed).toBe('write failed');

    // A drain is "is anything still running", not "did everything succeed" —
    // a rejecting drain would make a project switch throw on somebody else's
    // failed write.
    await expect(draining).resolves.toBeUndefined();
    expect(drained).toBe(true);
  });

  it('on an idle queue resolves immediately', async () => {
    await expect(new WriteQueue().drain()).resolves.toBeUndefined();
  });

  it('waits for tasks queued before it, not for ones queued after', async () => {
    const queue = new WriteQueue();
    const first = deferred();
    const later = deferred();
    const events: string[] = [];

    const a = queue.run(async () => { await first.promise; events.push('a'); });
    const draining = queue.drain().then(() => { events.push('drained'); });
    const b = queue.run(async () => { await later.promise; events.push('b'); });

    first.resolve();
    await draining;
    expect(events).toEqual(['a', 'drained']);

    later.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['a', 'drained', 'b']);
  });
});

// ─── Instance separation ──────────────────────────────────────────────────

describe('WriteQueue instances are independent', () => {
  it('a hung write in one queue does not delay another', async () => {
    const outgoing = new WriteQueue();
    const incoming = new WriteQueue();
    const stuck = deferred();
    const events: string[] = [];

    // The project the user just left, mid-write…
    const hung = outgoing.run(async () => { await stuck.promise; events.push('outgoing'); });
    // …must not hold up the project they opened.
    await incoming.run(async () => { events.push('incoming'); });
    await expect(incoming.drain()).resolves.toBeUndefined();

    expect(events).toEqual(['incoming']);

    stuck.resolve();
    await hung;
    expect(events).toEqual(['incoming', 'outgoing']);
  });

  it('a rejection in one queue leaves the other untouched', async () => {
    const a = new WriteQueue();
    const b = new WriteQueue();

    await expect(a.run(async () => { throw new Error('backend A'); })).rejects.toThrow('backend A');
    await expect(b.run(async () => 'backend B ok')).resolves.toBe('backend B ok');
    await expect(b.drain()).resolves.toBeUndefined();
  });
});

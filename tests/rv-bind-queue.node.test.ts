// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { enqueueBind, inBindQueue, runInBindQueue, whenDocumentSettled } from '../src/core/hmi/rv-bind-queue';
import type { EditTarget } from '../src/core/hmi/rv-edit-target';
import { RvDocument } from '../src/core/ops/rv-document';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
function rig() {
  const doc = new RvDocument({ id: 'settle', name: 'Settle', mode: 'asset', executor: {
    async applyForward() {}, async applyInverse() {},
  } });
  const facade = { document: doc, whenIdle: () => doc.whenIdle() };
  const et = { documentKey: facade } as EditTarget;
  return { doc, facade, et };
}

describe('whenDocumentSettled', () => {
  it('resolves with an empty queue without adding a queue entry', async () => {
    const { doc } = rig();
    const tail = doc.whenIdle();
    await whenDocumentSettled(doc);
    expect(doc.whenIdle()).toBe(tail);
  });

  it('resolves when whenIdle returns a new promise on every call', async () => {
    const doc = { whenIdle: async () => {} };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        whenDocumentSettled(doc),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('settle barrier timed out')), 200);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  });

  it('waits for facade ops when its inner document has no whenIdle', async () => {
    const gate = deferred();
    let calls = 0;
    const facade = { document: {}, whenIdle: () => { calls++; return gate.promise; } };
    let settled = false;
    const barrier = whenDocumentSettled(facade).then(() => { settled = true; });
    await Promise.resolve();
    expect(calls).toBeGreaterThan(0);
    expect(settled).toBe(false);
    gate.resolve();
    await barrier;
    expect(settled).toBe(true);
  });

  it('waits for binds on an object without whenIdle', async () => {
    const doc = {};
    const et = { documentKey: doc } as EditTarget;
    const gate = deferred();
    const started = deferred();
    const job = enqueueBind(et, async () => { started.resolve(); await gate.promise; });
    await started.promise;
    let settled = false;
    const barrier = whenDocumentSettled(doc).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await barrier;
    await job;
    expect(settled).toBe(true);
  });

  it('waits for a running job reached through a facade and a different adapter', async () => {
    const { doc, facade, et } = rig();
    const gate = deferred();
    const started = deferred();
    const job = enqueueBind(et, async () => { started.resolve(); await gate.promise; });
    await started.promise;
    let settled = false;
    const barrier = whenDocumentSettled(doc).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await barrier;
    await job;
    await whenDocumentSettled(facade);
    expect(settled).toBe(true);
  });

  it('repeats for a job appended while waiting for document ops', async () => {
    const { doc, et } = rig();
    const gate = deferred();
    const started = deferred();
    const op = doc.runExclusive(async () => { started.resolve(); await gate.promise; });
    await started.promise;
    const barrier = whenDocumentSettled(doc);
    await Promise.resolve();
    const jobGate = deferred();
    let wrote = false;
    const job = enqueueBind(et, async () => { await jobGate.promise; wrote = true; });
    gate.resolve();
    await op;
    let settled = false;
    void barrier.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    jobGate.resolve();
    await barrier;
    await job;
    expect(wrote).toBe(true);
  });

  it('repeats when document ops are appended during the drain', async () => {
    const { doc } = rig();
    const first = deferred();
    const second = deferred();
    const op = doc.runExclusive(() => first.promise);
    const barrier = whenDocumentSettled(doc);
    await Promise.resolve();
    let wrote = false;
    const next = doc.runExclusive(async () => { await second.promise; wrote = true; });
    first.resolve();
    await op;
    let settled = false;
    void barrier.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    second.resolve();
    await barrier;
    await next;
    expect(wrote).toBe(true);
  });

  it('does not deadlock inside a held job, including inBindQueue', async () => {
    const { doc, facade, et } = rig();
    await runInBindQueue(et, async (hold) => {
      await inBindQueue(et, hold, () => whenDocumentSettled(facade, hold));
      await whenDocumentSettled(doc, hold);
    });
  });

  it('also supplies a hold to a plain enqueueBind job', async () => {
    const { doc, et } = rig();
    await enqueueBind(et, (hold) => whenDocumentSettled(doc, hold));
  });

  it('an external caller cannot bypass a held job using a forged hold', async () => {
    const { doc, et } = rig();
    const gate = deferred();
    const started = deferred();
    const job = runInBindQueue(et, async () => { started.resolve(); await gate.promise; });
    await started.promise;
    let settled = false;
    const barrier = whenDocumentSettled(doc, {}).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await barrier;
    await job;
  });

  it('does not let a failed job poison the barrier', async () => {
    const { doc, et } = rig();
    const job = enqueueBind(et, async () => { throw new Error('refused'); });
    await expect(job).rejects.toThrow('refused');
    await whenDocumentSettled(doc);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { EditTarget } from './rv-edit-target';

/** Per-document promise chain (SOL R2 #6): `RvDocument` transactions share one depth counter.
 *  Core since plan-2233: a composite edit holds it; its own binds pass the hold OBJECT
 *  (identity, never serialisable — a JSON argument cannot forge it). */
const queues = new WeakMap<object, Promise<unknown>>();
const holders = new WeakMap<object, object>();
// AssetDocument and SceneStore expose the same RvDocument through `document`.
const documentOf = (doc: object): object => {
  const inner = (doc as { document?: { whenIdle?: unknown } }).document;
  return typeof inner?.whenIdle === 'function' ? inner : doc;
};
const key = (et: EditTarget): object => documentOf(et.documentKey ?? et);

/** Drain both tails before reading/saving. Inside a held job pass its hold, or
 * await only doc.whenIdle(): waiting for that job's own tail would deadlock. */
export async function whenDocumentSettled(
  doc: object,
  hold?: unknown,
): Promise<void> {
  const document = documentOf(doc) as { whenIdle(): Promise<void> };
  // Facades/documents without an op queue only need to drain binds.
  if (typeof document.whenIdle !== 'function') {
    let binds: Promise<unknown> | undefined;
    do {
      binds = queues.get(document);
      await binds;
    } while (binds !== queues.get(document));
    return;
  }
  if (hold && holders.get(document) === hold) { await document.whenIdle(); return; }
  let binds: Promise<unknown> | undefined;
  let ops: Promise<void>;
  // Only compare promise identity when whenIdle exposes a stable queue tail.
  const stableTail = document.whenIdle() === document.whenIdle();
  do {
    binds = queues.get(document);
    await binds;
    ops = document.whenIdle();
    await ops;
  } while (binds !== queues.get(document) || (stableTail && ops !== document.whenIdle()));
}

export function enqueueBind<T>(et: EditTarget, job: (hold: object) => Promise<T>): Promise<T> {
  const k = key(et);
  const run = (queues.get(k) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const hold = Object.freeze({});
    holders.set(k, hold);
    try { return await job(hold); } finally { holders.delete(k); }
  });
  queues.set(k, run.catch(() => undefined));
  return run;
}

export const runInBindQueue = enqueueBind;

export const holdsBindQueue = (et: EditTarget, hold?: unknown): boolean => !!hold && holders.get(key(et)) === hold;

/** A mapping write inside a queue entry: awaited where the target lands ops async, else the plain write. */
export const writeQueued = <M>(p: { write(m: M): void; writeAsync?(m: M): Promise<void> }, et: EditTarget, m: M): Promise<void> =>
  et.available && et.setFieldAsync && p.writeAsync ? p.writeAsync(m) : Promise.resolve(p.write(m));

/** `job` inside the held queue when `hold` holds it, else as its own queue entry. */
export const inBindQueue = <T>(et: EditTarget, hold: unknown, job: () => Promise<T>): Promise<T> =>
  holdsBindQueue(et, hold) ? job() : enqueueBind(et, job);

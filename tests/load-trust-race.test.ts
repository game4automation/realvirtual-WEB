// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * load-trust-race — the trust slot under OVERLAPPING loads (plan-442 §9.7, F6).
 *
 * `withLoadTrust` used to remember the value it found and put it back in a
 * `finally`. That is correct only while scopes nest, and loads do not always
 * nest: a second `loadModel()` can start while the first is still inside
 * `loadGLB`. The snapshot version then ends on the FIRST run's context instead
 * of the original one, and the slot decides whether interfaces auto-connect
 * and whether a `SignalBindingManager` binds model slots to live signals — so
 * "ends on the wrong value" means a viewer that reaches out of the tab when it
 * should not, or one that quietly never does again.
 *
 * The contract these tests pin down:
 *  - while scopes are open, the NEWEST one is what the slot reads;
 *  - once the last one closes, the slot holds the value from before the FIRST
 *    one opened — in both completion orders;
 *  - a throwing body still leaves its scope;
 *  - nested (LIFO) use is unchanged.
 */

import { describe, expect, it } from 'vitest';
import {
  TRUSTED_LOAD,
  withLoadTrust,
  type LoadTrustContext,
  type TrustSlot,
} from '../src/core/rv-load-trust';

const C1: LoadTrustContext = { trusted: false, sourceOrigin: 'one.example' };
const C2: LoadTrustContext = { trusted: false, sourceOrigin: 'two.example' };

/** A slot plus the deferred bodies the tests drive by hand. */
function makeSlot(): TrustSlot & { value: LoadTrustContext } {
  const state = { value: TRUSTED_LOAD as LoadTrustContext };
  return {
    get value() { return state.value; },
    get: () => state.value,
    set: (next) => { state.value = next; },
  } as TrustSlot & { value: LoadTrustContext };
}

/** A body that only finishes when the test says so. */
function deferred(): { body: () => Promise<void>; finish: () => void; fail: (e: unknown) => void } {
  let finish!: () => void;
  let fail!: (e: unknown) => void;
  const gate = new Promise<void>((res, rej) => { finish = () => res(); fail = rej; });
  gate.catch(() => { /* consumed by the body */ });
  return { body: () => gate, finish, fail };
}

describe('withLoadTrust under overlapping loads', () => {
  it('keeps the newest scope, then falls back to the base (older finishes first)', async () => {
    const slot = makeSlot();
    const one = deferred();
    const two = deferred();

    const p1 = withLoadTrust(slot, C1, one.body);
    expect(slot.value).toBe(C1);
    const p2 = withLoadTrust(slot, C2, two.body);
    expect(slot.value).toBe(C2);              // youngest scope wins reads

    one.finish();
    await p1;
    // The snapshot implementation restored the BASE here and lost C2 while
    // run 2 was still using it.
    expect(slot.value).toBe(C2);

    two.finish();
    await p2;
    expect(slot.value).toBe(TRUSTED_LOAD);    // …and only now the base
  });

  it('falls back to the older scope, then to the base (younger finishes first)', async () => {
    const slot = makeSlot();
    const one = deferred();
    const two = deferred();

    const p1 = withLoadTrust(slot, C1, one.body);
    const p2 = withLoadTrust(slot, C2, two.body);

    two.finish();
    await p2;
    // The snapshot implementation restored C1's PREDECESSOR reading, i.e. C1
    // itself, and then never got back to the base at all.
    expect(slot.value).toBe(C1);

    one.finish();
    await p1;
    expect(slot.value).toBe(TRUSTED_LOAD);
  });

  it('removes the scope of a body that throws', async () => {
    const slot = makeSlot();
    const one = deferred();
    const two = deferred();

    const p1 = withLoadTrust(slot, C1, one.body);
    const p2 = withLoadTrust(slot, C2, two.body);

    const boom = new Error('load failed');
    two.fail(boom);
    await expect(p2).rejects.toBe(boom);
    expect(slot.value).toBe(C1);

    one.fail(boom);
    await expect(p1).rejects.toBe(boom);
    expect(slot.value).toBe(TRUSTED_LOAD);
  });

  it('behaves exactly as before for NESTED (LIFO) use', async () => {
    const slot = makeSlot();
    const seen: (string | undefined)[] = [];

    await withLoadTrust(slot, C1, async () => {
      seen.push(slot.get().sourceOrigin);
      await withLoadTrust(slot, C2, async () => {
        seen.push(slot.get().sourceOrigin);
      });
      seen.push(slot.get().sourceOrigin);
    });
    seen.push(slot.get().sourceOrigin);

    expect(seen).toEqual(['one.example', 'two.example', 'one.example', undefined]);
    expect(slot.value).toBe(TRUSTED_LOAD);
  });

  it('re-reads the base value after every scope has closed', async () => {
    const slot = makeSlot();
    await withLoadTrust(slot, C1, async () => {});
    expect(slot.value).toBe(TRUSTED_LOAD);

    // A slot the owner changed between load runs must not be restored to a
    // value captured a load ago — hence the stack is dropped when it empties.
    slot.set(C2);
    await withLoadTrust(slot, C1, async () => {});
    expect(slot.value).toBe(C2);
  });

  it('defaults an omitted trust to TRUSTED_LOAD', async () => {
    const slot = makeSlot();
    slot.set(C1);
    await withLoadTrust(slot, undefined, async () => {
      expect(slot.get()).toBe(TRUSTED_LOAD);
    });
    expect(slot.value).toBe(C1);
  });
});

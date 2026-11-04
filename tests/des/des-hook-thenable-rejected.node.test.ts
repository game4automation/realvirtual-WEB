// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2058 F15 (§9.3) — DES hooks are synchronous by contract. A `def.des`
 * hook that returns a thenable (an `async` hook, a Promise, any `{ then }`)
 * makes `MaterialFlowAdapter.dispatchHook()` throw at once, naming the hook
 * suffix and the component path, instead of dropping the return value and
 * letting the hook body run detached from the event clock. Checked for
 * several suffixes, directly and through the event queue. A thenable that
 * REJECTS later must not add a second, unhandled rejection on top of the
 * synchronous contract error (post-implementation review).
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { defineMaterialFlow, type MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { MaterialFlowSelf } from '../../src/core/material-flow/material-flow-self';
import { bindDes, makeHost } from '../helpers/agv-harness';

/** A custom thenable — not a Promise, but `then` is a function. */
const THENABLE = { then(): void {} };

const ThenableHooks = defineMaterialFlow({
  type: 'Plan2058ThenableHooks', kind: 'sink', schema: {}, continuous: {},
  des: {
    async onArrival(): Promise<void> {},                 // async hook → Promise
    onProcessComplete: () => THENABLE,                   // custom thenable
    onReplan: () => Promise.resolve(),                   // explicit Promise
    onRotateComplete: () => 42,                          // a plain value is fine
    onDownstreamReady: () => {},                         // void is fine
    onAccept: () => true,                                // the boolean contract is fine
  },
}) as unknown as MaterialFlowDefinition;

/**
 * Hooks whose thenable REJECTS later (post-impl review of F15): the contract
 * violation is still thrown synchronously, and the rejection itself must not
 * surface a second time as an unhandled rejection.
 */
const RejectingHooks = defineMaterialFlow({
  type: 'Plan2058RejectingHooks', kind: 'sink', schema: {}, continuous: {},
  des: {
    async onArrival(): Promise<void> { throw new Error('boom: async hook body'); },
    onReplan: () => Promise.reject(new Error('boom: explicit rejected Promise')),
    // A custom thenable whose `then` rejects — and one whose `then` itself throws.
    onProcessComplete: () => ({ then(_ok: unknown, fail: (e: unknown) => void): void { fail(new Error('boom: thenable')); } }),
    onRotateComplete: () => ({ then(): void { throw new Error('boom: throwing then'); } }),
  },
}) as unknown as MaterialFlowDefinition;

function fixture(def: MaterialFlowDefinition = ThenableHooks): {
  runner: DESRunner; adapter: MaterialFlowAdapter; self: MaterialFlowSelf;
} {
  const runner = new DESRunner({ subMode: 'animated' });
  const root = new Object3D(); root.name = 'Plant';
  const node = new Object3D(); node.name = 'AsyncCell'; root.add(node);
  const self = bindDes(runner, node, makeHost(), def);
  runner.start([], { root });
  const adapter = runner.liveInstances.find((i) => i.def === def)!.adapter;
  return { runner, adapter, self };
}

/** Lets a pending rejection reach Node's unhandled-rejection check (microtasks + a macrotask turn). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise<void>((done) => setImmediate(done));
};

const message = (suffix: string, path: string): RegExp =>
  new RegExp(`hook '${suffix}' on '${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' returned a thenable`);

describe('DES hooks returning a thenable are rejected (plan-2058 F15)', () => {
  it.each(['Arrival', 'ProcessComplete', 'Replan'])(
    'dispatchHook(%s) throws with suffix and component path',
    (suffix) => {
      const { runner, adapter } = fixture();
      expect(adapter.path).not.toBe('');
      expect(() => adapter.dispatchHook(suffix, null, undefined, null)).toThrow(message(suffix, adapter.path));
      expect(() => adapter.dispatchHook(suffix, null, undefined, null)).toThrow(/DES hooks must be synchronous/);
      runner.dispose();
    },
  );

  it('synchronous hooks (void, a plain value, the onAccept boolean) do not throw', () => {
    const { runner, adapter } = fixture();
    expect(() => adapter.dispatchHook('RotateComplete', null, undefined, null)).not.toThrow();
    expect(() => adapter.dispatchHook('DownstreamReady', null, undefined, null)).not.toThrow();
    expect(() => adapter.dispatchHook('Accept', null, undefined, null)).not.toThrow();
    runner.dispose();
  });

  it('a REJECTING thenable still throws synchronously and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { runner, adapter } = fixture(RejectingHooks);
      for (const suffix of ['Arrival', 'Replan', 'ProcessComplete', 'RotateComplete']) {
        expect(() => adapter.dispatchHook(suffix, null, undefined, null)).toThrow(message(suffix, adapter.path));
      }
      await settle();
      runner.dispose();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('a scheduled hook event that returns a thenable fails its dispatch in the event loop', () => {
    const { runner, adapter, self } = fixture();
    const manager = runner.getManager();
    self.in(1, 'ProcessComplete');
    expect(() => manager.processEvents(10)).toThrow(message('ProcessComplete', adapter.path));
    // The manager records the failed event like any other throwing action.
    expect(manager.lastFailedEvent.componentPath).toBe(adapter.path);
    expect(manager.lastFailedEvent.time).toBe(1);
    runner.dispose();
  });
});

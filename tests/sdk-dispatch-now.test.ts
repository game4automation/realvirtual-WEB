// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 Phase 4b (C) — `now` rides along with every host→VM dispatch.
 *
 * The test scheduler's `now` is a READ COUNTER: every read returns a new value.
 * Inside a dispatch (`des.on` hook, sink callback via `__cb`, station handlers)
 * `self.now` must answer from the value the host handed in - several reads give
 * the same number and the scheduler is read exactly once (by the host). Outside
 * a dispatch `self.now` still asks the host (unchanged semantics), and a failed
 * dispatch leaves no stale time behind.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import { createSdkComponent } from '../src/core/sdk/rv-component-sdk';
import { RVScriptComponentAdapter } from '../src/core/sdk/rv-script-component-adapter';
import type { SdkScheduler, ScriptMuRef } from '../src/core/sdk/rv-script-hook';

const hosts: RVScriptHost[] = [];
afterEach(() => { for (const h of hosts) h.dispose(); hosts.length = 0; });

const CODE = `
function setup(self) {
  const st = self.persist({ hook: [], cb: [], accept: [] });
  const s = self.sink('Sink');
  if (s) s.on(function () { st.cb.push(self.now, self.now); });
  return {
    des: {
      on(hook) {
        if (hook === 'boom') { st.hook.push(self.now); throw new Error('boom'); }
        if (hook === 'spin') { st.hook.push(self.now); for (;;) { /* call deadline abort: uncatchable */ } }
        st.hook.push(self.now, self.now);
      },
      canAccept() { st.accept.push(self.now); return true; },
      onAccept() { st.accept.push(self.now); return true; },
    },
    outside() { return [self.now, self.now]; },
    state() { return st; },
  };
}`;

async function build() {
  const host = await RVScriptHost.create();
  hosts.push(host);
  let reads = 0;
  let fire: ((mu: ScriptMuRef) => void) | null = null;
  const scheduler: SdkScheduler = {
    in: () => 1, at: () => 1, cancel: () => {},
    get now() { reads++; return reads * 10; },
  };
  const adapter = new RVScriptComponentAdapter({ mode: 'des', desScheduler: scheduler, lintPolicy: 'warn', onLintWarning: () => {} });
  const node = new Object3D(); node.name = 'Probe';
  const c = createSdkComponent(host, {
    name: 'Probe', path: 'Probe', node, scheduler,
    components: { sink: () => ({ subscribe(cb: (mu: ScriptMuRef) => void) { fire = cb; return () => { fire = null; }; } }) },
    log: () => {},
  }, CODE, { callDeadlineMs: 100 });
  expect(c.ok, c.error?.message).toBe(true);
  adapter.attach(c);
  const state = () => c.callHandler('state').value as { hook: number[]; cb: number[]; accept: number[] };
  return { adapter, c, state, reads: () => reads, fire: (mu: ScriptMuRef) => fire!(mu) };
}

describe('plan-2212 Phase 4b (C) — self.now inside a dispatch', () => {
  it('des.on hook: one host read, every guest read answers that value', async () => {
    const t = await build();
    const before = t.reads();
    t.adapter.dispatchScriptHook('tick', null);
    expect(t.reads() - before).toBe(1);
    expect(t.state().hook).toEqual([before * 10 + 10, before * 10 + 10]);
  });

  it('sink callback (__cb): the time comes with the notification', async () => {
    const t = await build();
    const before = t.reads();
    t.fire({ id: 7 });
    expect(t.reads() - before).toBe(1);
    expect(t.state().cb).toEqual([before * 10 + 10, before * 10 + 10]);
  });

  it('station handlers carry the time too', async () => {
    const t = await build();
    const before = t.reads();
    expect(t.adapter.stationCanAccept({ id: 1 }, null)).toBe(true);
    expect(t.adapter.stationOnAccept({ id: 1 }, null)).toBe(true);
    expect(t.state().accept).toEqual([before * 10 + 10, before * 10 + 20]);
    expect(t.reads() - before).toBe(2);
  });

  it('outside a dispatch self.now still asks the host on every read', async () => {
    const t = await build();
    t.adapter.dispatchScriptHook('tick', null);
    const before = t.reads();
    const r = t.c.callHandler('outside').value as number[];
    expect(r).toEqual([before * 10 + 10, before * 10 + 20]);
  });

  it('an uncatchable deadline abort skips the guest finally - the host clears the dispatch time', async () => {
    const t = await build();
    t.adapter.dispatchScriptHook('spin', null);
    const before = t.reads();
    const r = t.c.callHandler('outside');
    // Today a deadline abort disables the VM (nothing can read a stale time);
    // should it ever keep running, self.now must ask the host again.
    if (!r.ok) { expect(r.error?.name).toBe('ContextDisabledError'); return; }
    expect(r.value).toEqual([before * 10 + 10, before * 10 + 20]);
  });

  it('a failed dispatch leaves no stale time behind', async () => {
    const t = await build();
    t.adapter.dispatchScriptHook('boom', null);
    const before = t.reads();
    const r = t.c.callHandler('outside').value as number[];
    expect(r).toEqual([before * 10 + 10, before * 10 + 20]);
  });
});

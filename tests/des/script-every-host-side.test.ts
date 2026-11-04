// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 Phase 4c (test 9.6e) — host-side `self.every`.
 *
 * The recurring timer's record and clock live in the host scheduler
 * (`SdkEveryTimers`); a due slice is re-armed by the host BEFORE the guest
 * sees it, and the guest only calls the user hook.
 *
 *  (a) one guest call per slice, no `timer.in` call back into the host;
 *  (b) event sequence, results and event ids identical to the pre-4c reference
 *      (recorded with the guest-side implementation, same seed — fixture);
 *  (c) cancel from the hook itself, from another hook, and owner-scoped;
 *  (d) snapshot mid-run → restore (same and fresh sim) → identical continuation;
 *  (e) every keeps working on the continuous (animated, non-DES) kernel;
 *  (f) every from a DES frame hook is refused without a record or a pid step;
 *  (g)-(j) review 1: the payload stays in the guest, one-sided pids are dropped;
 *  (k) review 2: a refused cancel (frame-hook fence) keeps both halves, the timer fires on;
 *  (l) review 2: a guest-only leftover is dropped BEFORE payload validation.
 *
 * The reference (fixtures/script-every-pre4c-trace.json) was recorded from the
 * pre-4c guest-side implementation (da90f4d4): an empty fixture makes test (b)
 * print the `RV_EVERY_TRACE` line to re-record from. Never re-record from 4c code.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Object3D } from 'three';
import { DESManager, DESMode } from '@rv/plugins/des/rv-des-manager';
import { makeScriptHookScheduler } from '@rv/plugins/des/rv-des-script-hook';
import { whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { createSdkComponent, type SdkComponent } from '../../src/core/sdk/rv-component-sdk';
import { RVScriptComponentAdapter } from '../../src/core/sdk/rv-script-component-adapter';
import type { SdkEnvironment } from '../../src/core/sdk/rv-sdk-self';
import type { SdkScheduler } from '../../src/core/sdk/rv-script-hook';

import referenceJson from './fixtures/script-every-pre4c-trace.json';

/** Two recurring timers, a one-shot timer, rng draws and cancels — the reference workload. */
const TRACE_CODE = `
function setup(self) {
  const st = self.persist({ log: [], a: 0, b: 0, ids: [] });
  st.ids.push(self.every(1, 'a', { tag: 'A' }));
  st.ids.push(self.every(0.75, 'b'));
  self.in(2.5, 'one');
  return {
    state() { return st; },
    des: { on(hook, mu, data) {
      st.log.push([Math.round(self.now * 1000) / 1000, hook, data === null ? null : JSON.stringify(data),
        Math.floor(self.random() * 1000000)]);
      if (hook === 'a') { st.a++; if (st.a === 4) self.cancel(st.ids[0]); }
      if (hook === 'b') { st.b++; if (st.b === 3) st.ids.push(self.every(1.25, 'c', [st.b])); }
      if (hook === 'one') self.cancel(st.ids[1]);
    } },
  };
}
`;

interface TraceState { log: [number, string, string | null, number][]; a: number; b: number; ids: number[] }

const hosts: RVScriptHost[] = [];
const components: SdkComponent[] = [];
afterEach(() => {
  for (const c of components) c.dispose();
  components.length = 0;
  for (const h of hosts) h.dispose();
  hosts.length = 0;
});

/** Wraps the scheduler the guest talks to and counts its calls (the adapter keeps the real one). */
function countingScheduler(real: SdkScheduler): { scheduler: SdkScheduler; calls: Record<string, number> } {
  const calls: Record<string, number> = { in: 0, at: 0, cancel: 0, every: 0 };
  const scheduler: SdkScheduler = {
    in: (d, h, mu, data) => { calls.in++; return real.in(d, h, mu, data); },
    at: (t, h, mu, data) => { calls.at++; return real.at(t, h, mu, data); },
    cancel: id => { calls.cancel++; real.cancel(id); },
    get now() { return real.now; },
  };
  if (real.every) {
    Object.assign(scheduler, {
      every: (i: number, h: string) => { calls.every++; return real.every!(i, h); },
    });
    Object.defineProperty(scheduler, 'everyTimers', { get: () => real.everyTimers });
  }
  return { scheduler, calls };
}

interface DesSim {
  runner: DESRunner;
  manager: DESManager;
  adapter: RVScriptComponentAdapter;
  component: SdkComponent;
  calls: Record<string, number>;
  guestCalls: string[];
  runTo(t: number): void;
  state<T = unknown>(): T;
}

async function makeDesSim(code: string, opts: { displayFrames?: boolean; path?: string } = {}): Promise<DesSim> {
  const host = await RVScriptHost.create();
  hosts.push(host);
  const runner = new DESRunner();
  const manager = runner.getManager();
  manager.mode = DESMode.Animated;
  manager.duration = 100000;
  const path = opts.path ?? 'Cell/EveryScript';
  const dispatcher = { dispatchScriptHook: (hook: string, mu: Parameters<RVScriptComponentAdapter['dispatchScriptHook']>[1], data: unknown) => adapter.dispatchScriptHook(hook, mu, data) };
  const adapter: RVScriptComponentAdapter = new RVScriptComponentAdapter({
    mode: 'des',
    desScheduler: makeScriptHookScheduler(manager, dispatcher),
    lintPolicy: 'warn',
    onLintWarning: () => {},
    ...(opts.displayFrames ? { displayFrames: () => true } : {}),
  });
  runner.setScriptComponentSource(() => [{ path, desId: '#EveryScript@Script', source: code, adapter: Object.assign(dispatcher, {
    captureScriptState: () => adapter.captureScriptState(),
    restoreScriptState: (s: Parameters<RVScriptComponentAdapter['restoreScriptState']>[0]) => adapter.restoreScriptState(s),
  }) }]);
  runner.start([], { root: new Object3D() });
  await whenDocumentHashesSettled();
  manager.mode = DESMode.Animated;
  manager.duration = 100000;
  const { scheduler, calls } = countingScheduler(adapter.scheduler);
  const node = new Object3D();
  node.name = 'EveryScript';
  const env: SdkEnvironment = { name: 'EveryScript', path, node, props: {}, scheduler, log: () => {} };
  const component = createSdkComponent(host, env, code, { callDeadlineMs: 500 });
  expect(component.ok).toBe(true);
  components.push(component);
  const guestCalls: string[] = [];
  const callHandler = component.callHandler.bind(component);
  component.callHandler = ((p: string, ...args: unknown[]) => { guestCalls.push(p); return callHandler(p, ...args); }) as typeof component.callHandler;
  adapter.attach(component);
  return {
    runner, manager, adapter, component, calls, guestCalls,
    runTo(t: number): void {
      let guard = 0;
      while (manager.currentTime < t && guard++ < 200000) manager.processAnimated(0.05);
    },
    state<T>(): T {
      const r = callHandler('state');
      expect(r.ok).toBe(true);
      return r.value as T;
    },
  };
}

async function makeContinuousSim(code: string): Promise<{ adapter: RVScriptComponentAdapter; component: SdkComponent;
  calls: Record<string, number>; tick(seconds: number, dt?: number): void; state<T = unknown>(): T }> {
  const host = await RVScriptHost.create();
  hosts.push(host);
  const adapter = new RVScriptComponentAdapter();
  const { scheduler, calls } = countingScheduler(adapter.scheduler);
  const node = new Object3D();
  node.name = 'EveryScript';
  const env: SdkEnvironment = { name: 'EveryScript', path: 'Cell/EveryScript', node, props: {}, scheduler, log: () => {} };
  const component = createSdkComponent(host, env, code, { callDeadlineMs: 500 });
  expect(component.ok).toBe(true);
  components.push(component);
  adapter.attach(component);
  return {
    adapter, component, calls,
    tick(seconds: number, dt = 0.02): void {
      const n = Math.round(seconds / dt);
      for (let i = 0; i < n; i++) adapter.tick(dt);
    },
    state<T>(): T {
      const r = component.callHandler('state');
      expect(r.ok).toBe(true);
      return r.value as T;
    },
  };
}

interface Reference {
  des: { state: TraceState; nextEventId: number; totalEventsProcessed: number; currentTime: number };
  continuous: { state: TraceState };
}

describe('host-side self.every (plan-2212 Phase 4c, 9.6e)', () => {
  it('(a) one guest call per slice, no timer.in back into the host', async () => {
    const sim = await makeDesSim(`function setup(self) {
      const st = self.persist({ n: 0 });
      self.every(1, 'beat');
      return { state() { return st; }, des: { on(hook) { if (hook === 'beat') st.n++; } } };
    }`);
    expect(sim.calls.every).toBe(1);
    sim.guestCalls.length = 0;
    sim.runTo(10.5);
    expect(sim.state<{ n: number }>().n).toBe(10);
    expect(sim.guestCalls.filter(p => p === 'des.on')).toHaveLength(10);
    expect(sim.calls.in).toBe(0);
    expect(sim.calls.at).toBe(0);
    expect(sim.calls.every).toBe(1);
    expect(sim.adapter.scheduler.everyTimers?.size).toBe(1);
  });

  it('(b) event sequence, results and event ids equal the pre-4c reference', async () => {
    const sim = await makeDesSim(TRACE_CODE);
    sim.runTo(12.5);
    const cont = await makeContinuousSim(TRACE_CODE);
    cont.tick(12.5);
    const actual: Reference = {
      des: { state: sim.state<TraceState>(), nextEventId: sim.manager.nextEventId,
        totalEventsProcessed: sim.manager.totalEventsProcessed, currentTime: sim.manager.currentTime },
      continuous: { state: cont.state<TraceState>() },
    };
    const reference = referenceJson as unknown as Reference;
    if (!('des' in reference)) console.log('RV_EVERY_TRACE ' + JSON.stringify(actual));
    expect(actual).toEqual(reference);
    // Sanity: the workload really exercised every, cancel and the late every.
    expect(actual.des.state.ids).toEqual([-1, -2, -3]);
    expect(actual.des.state.log.some(e => e[1] === 'c')).toBe(true);
  });

  it('(c) cancel from the hook itself, from another hook, and only the own timers', async () => {
    const code = `function setup(self) {
      const st = self.persist({ a: 0, b: 0, c: 0, ids: [] });
      st.ids.push(self.every(1, 'a'));
      st.ids.push(self.every(0.5, 'b'));
      st.ids.push(self.every(0.7, 'c'));
      return { state() { return st; }, des: { on(hook) {
        if (hook === 'a') { st.a++; if (st.a === 2) self.cancel(st.ids[0]); }
        if (hook === 'b') { st.b++; if (st.b === 3) self.cancel(st.ids[2]); }
        if (hook === 'c') st.c++;
        if (hook === 'foreign') self.cancel(-1);
      } } };
    }`;
    const sim = await makeDesSim(code);
    sim.runTo(5.1);
    const st = sim.state<{ a: number; b: number; c: number }>();
    expect(st.a).toBe(2);          // cancelled itself in its 2nd slice
    expect(st.c).toBe(2);          // 0.7, 1.4; cancelled by 'b' at 1.5
    expect(st.b).toBe(10);
    expect(sim.adapter.scheduler.everyTimers?.size).toBe(1);

    // Owner scope: another script cancelling "-1" never touches this script's -1.
    const other = await makeDesSim(`function setup(self) {
      const st = self.persist({ n: 0 });
      self.every(1, 'beat');
      return { state() { return st; }, des: { on(hook) { if (hook === 'beat') st.n++; } } };
    }`, { path: 'Cell/Other' });
    const killer = await makeDesSim(code, { path: 'Cell/Killer' });
    killer.adapter.dispatchScriptHook('foreign', null, null);
    other.runTo(3.5);
    expect(other.state<{ n: number }>().n).toBe(3);
    // A stale id after dispose is a no-op for a live scheduler.
    killer.component.dispose();
    expect(killer.adapter.scheduler.everyTimers?.size).toBe(0);
  });

  it.each(['same', 'fresh'])('(d) snapshot mid-run → restore (%s sim) → identical continuation', async target => {
    const sim = await makeDesSim(TRACE_CODE);
    sim.runTo(3.1);
    const snapshot = sim.runner.fullSnapshot();
    sim.runTo(12.5);
    const expected = sim.state<TraceState>();
    const expectedIds = sim.manager.nextEventId;
    const into = target === 'same' ? sim : await makeDesSim(TRACE_CODE);
    into.runner.restoreFull(snapshot);
    expect(into.adapter.scheduler.everyTimers?.size).toBe(2);
    into.calls.in = 0;
    into.runTo(12.5);
    expect(into.state<TraceState>()).toEqual(expected);
    expect(into.manager.nextEventId).toBe(expectedIds);
    expect(into.calls.in).toBe(0);
  });

  it('(e) every keeps working on the continuous kernel; reset drops the dead records', async () => {
    const sim = await makeContinuousSim(`function setup(self) {
      const st = self.persist({ n: 0, id: 0 });
      st.id = self.every(0.1, 'beat', { k: 2 });
      return { state() { return st; }, stop() { self.cancel(st.id); },
        des: { on(hook, mu, data) { if (hook === 'beat' && data.k === 2) st.n++; } } };
    }`);
    sim.tick(0.55, 0.05);
    expect(sim.state<{ n: number }>().n).toBe(5);
    expect(sim.calls.in).toBe(0);
    expect(sim.component.callHandler('stop').ok).toBe(true);
    sim.tick(0.5, 0.05);
    expect(sim.state<{ n: number }>().n).toBe(5);
    expect(sim.adapter.scheduler.everyTimers?.size).toBe(0);
    expect(sim.adapter.heap.size).toBe(0);
  });

  it('(f) every from a DES frame hook is refused without a record or a pid step', async () => {
    const sim = await makeDesSim(`function setup(self) {
      const st = self.persist({ refused: 0, later: 0 });
      return { state() { return st; },
        continuous: { fixedUpdate() { try { self.every(0.25, 'beat'); } catch (e) { st.refused++; } } },
        des: { on(hook) { if (hook === 'make') st.later = self.every(1, 'beat'); } } };
    }`, { displayFrames: true });
    sim.adapter.tick(0.02);
    sim.adapter.tick(0.02);
    expect(sim.adapter.displayWriteRefusals).toBe(2);
    expect(sim.calls.every).toBe(0);
    expect(sim.adapter.scheduler.everyTimers?.size).toBe(0);
    expect(guestEvery(sim.component)).toEqual([]);            // no guest map entry either
    sim.adapter.dispatchScriptHook('make', null, null);
    expect(sim.state<{ later: number }>().later).toBe(-1);   // the counter did not move
    expect(sim.adapter.scheduler.everyTimers?.size).toBe(1);
    expect(guestEvery(sim.component).map(e => e.pid)).toEqual([-1]);
  });

  // ── Review fixes (Codex review of 40aeaaab): the payload stays in the guest ──

  const MUTATE_CODE = `function setup(self) {
    const st = self.persist({ seen: [] });
    const d = { n: 0 };
    self.every(1, 't', d);
    d.n = 10;                                  // mutate the ORIGINAL after scheduling
    return { state() { return st; }, des: { on(hook, mu, data) {
      if (hook === 't') { st.seen.push(data.n); data.n++; }   // mutate inside the hook
    } } };
  }`;

  it('(g) the original payload object is kept: mutations after scheduling and in the hook are seen (DES + animated)', async () => {
    const des = await makeDesSim(MUTATE_CODE);
    des.runTo(2.5);
    expect(des.state<{ seen: number[] }>().seen).toEqual([10, 11]);
    const cont = await makeContinuousSim(MUTATE_CODE);
    cont.tick(2.5, 0.05);
    expect(cont.state<{ seen: number[] }>().seen).toEqual([10, 11]);
  });

  it.each(['same', 'fresh'])('(h) a hook mutation survives snapshot → restore (%s sim) and continues identically', async target => {
    const sim = await makeDesSim(MUTATE_CODE);
    sim.runTo(2.5);
    const snapshot = sim.runner.fullSnapshot();
    sim.runTo(5.5);
    const expected = sim.state<{ seen: number[] }>();
    expect(expected.seen).toEqual([10, 11, 12, 13, 14]);
    const into = target === 'same' ? sim : await makeDesSim(MUTATE_CODE);
    into.runner.restoreFull(snapshot);
    expect(guestEvery(into.component)).toEqual([{ pid: -1, hook: 't', data: { n: 12 } }]);
    into.runTo(5.5);
    expect(into.state()).toEqual(expected);
  });

  it('(i) a 20-level nested payload is delivered with every slice (no per-slice marshalling)', async () => {
    const code = `function setup(self) {
      const st = self.persist({ depths: [] });
      let deep = { leaf: true };
      for (let i = 1; i < 20; i++) deep = { inner: deep };
      self.every(1, 'deep', deep);
      return { state() { return st; }, des: { on(hook, mu, data) {
        if (hook !== 'deep') return;
        let n = 1, o = data;
        while (o.inner) { o = o.inner; n++; }
        st.depths.push(n);
      } } };
    }`;
    const des = await makeDesSim(code);
    des.runTo(3.5);
    expect(des.state<{ depths: number[] }>().depths).toEqual([20, 20, 20]);
    const cont = await makeContinuousSim(code);
    cont.tick(3.5, 0.05);
    expect(cont.state<{ depths: number[] }>().depths).toEqual([20, 20, 20]);
  });

  it('(j) a pid present on one side only is dropped deterministically', async () => {
    const code = `function setup(self) {
      const st = self.persist({ hooks: [] });
      self.every(1, 'kept');
      self.every(1, 'guestOnly');
      return { state() { return st; }, des: { on(hook) { st.hooks.push(hook); } } };
    }`;
    // Guest-only entry (host record gone): left out of the snapshot table, gone after restore.
    const sim = await makeDesSim(code);
    sim.adapter.scheduler.everyTimers!.cancel(-2);
    const snapshot = sim.runner.fullSnapshot();
    const fresh = await makeDesSim(code);
    fresh.runner.restoreFull(snapshot);
    expect(guestEvery(fresh.component).map(e => e.pid)).toEqual([-1]);
    expect(fresh.adapter.scheduler.everyTimers?.size).toBe(1);
    fresh.runTo(2.5);
    expect(fresh.state<{ hooks: string[] }>().hooks).toEqual(['kept', 'kept']);

    // Host-only record (no guest entry): its first slice reaches no user hook and drops it.
    const host = await makeDesSim(code);
    const ghost = host.adapter.scheduler.everyTimers!.add(0.5, 'ghost');
    expect(host.adapter.scheduler.everyTimers!.has(ghost)).toBe(true);
    host.runTo(2.5);
    expect(host.adapter.scheduler.everyTimers!.has(ghost)).toBe(false);
    expect(host.state<{ hooks: string[] }>().hooks).toEqual(['kept', 'guestOnly', 'kept', 'guestOnly']);
  });

  // ── Review fixes, round 2 (Codex review of 106493ce) ──

  it('(k) a cancel refused by the frame-hook fence leaves both halves intact; the timer keeps firing identically', async () => {
    const code = `function setup(self) {
      const st = self.persist({ id: 0, refused: 0, log: [] });
      st.id = self.every(1, 'beat', { k: 7 });
      return { state() { return st; },
        continuous: { fixedUpdate() { try { self.cancel(st.id); } catch (e) { st.refused++; } } },
        des: { on(hook, mu, data) { if (hook === 'beat') st.log.push([self.now, data.k, Math.floor(self.random() * 1000000)]); } } };
    }`;
    const ref = await makeDesSim(code);
    ref.runTo(5.5);
    const expected = ref.state<{ log: unknown[] }>().log;
    expect(expected).toHaveLength(5);

    const sim = await makeDesSim(code, { displayFrames: true });
    sim.adapter.tick(0.02);
    sim.adapter.tick(0.02);
    expect(sim.adapter.displayWriteRefusals).toBe(2);
    expect(sim.calls.cancel).toBe(0);
    expect(sim.state<{ refused: number }>().refused).toBe(2);
    // Both halves survive the refused cancel.
    expect(sim.adapter.scheduler.everyTimers?.has(-1)).toBe(true);
    expect(guestEvery(sim.component)).toEqual([{ pid: -1, hook: 'beat', data: { k: 7 } }]);
    sim.runTo(5.5);
    expect(sim.state<{ log: unknown[] }>().log).toEqual(expected);
    expect(sim.adapter.scheduler.everyTimers?.size).toBe(1);
  });

  it('(l) a guest-only leftover with an unsupported payload neither blocks the snapshot nor survives it', async () => {
    const code = `function setup(self) {
      const st = self.persist({ hooks: [] });
      const bad = { n: 1 };
      self.every(1, 'kept', { ok: true });
      self.every(1, 'bad', bad);
      return { state() { return st; },
        poison() { bad.fn = function () {}; bad.self = bad; },
        des: { on(hook) { st.hooks.push(hook); } } };
    }`;
    // Control: while the host record is live, the invalid payload refuses the snapshot.
    const live = await makeDesSim(code);
    expect(live.component.callHandler('poison').ok).toBe(true);
    expect(() => live.runner.fullSnapshot()).toThrow();

    const sim = await makeDesSim(code);
    expect(sim.component.callHandler('poison').ok).toBe(true);
    sim.adapter.scheduler.everyTimers!.cancel(-2);   // host record gone, guest entry left over
    const snapshot = sim.runner.fullSnapshot();
    const fresh = await makeDesSim(code);
    fresh.runner.restoreFull(snapshot);
    expect(guestEvery(fresh.component)).toEqual([{ pid: -1, hook: 'kept', data: { ok: true } }]);
    expect(fresh.adapter.scheduler.everyTimers?.size).toBe(1);
    fresh.runTo(2.5);
    expect(fresh.state<{ hooks: string[] }>().hooks).toEqual(['kept', 'kept']);
  });
});

function guestEvery(component: SdkComponent): { pid: number; hook: string; data: unknown }[] {
  const r = component.callHandler('__rv.every.get');
  expect(r.ok).toBe(true);
  return JSON.parse(r.value as string) as { pid: number; hook: string; data: unknown }[];
}

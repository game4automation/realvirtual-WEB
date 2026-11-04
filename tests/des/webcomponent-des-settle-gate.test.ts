// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 Phase 4b (A) — the exact settle gate for Model-Scripts, end to end
 * (real QuickJS, real WebComponentPlugin, real DESRunner):
 *  - a plain script (sink listener + every) no longer turns the per-event tween
 *    settle on - and the run gives the same result as with the settle forced on;
 *  - a direct geometry read, every detour (alias, computed member, `self` passed
 *    to a helper, destructuring) and the explicit opt-in
 *    `des: { samplesLiveGeometry: true }` keep it on;
 *  - correctness: a detour script reads the tweened node position at the exact
 *    event time in FastForward - the same values as the animated run.
 */

import { describe, it, expect, vi } from 'vitest';
import { Vector3, Object3D } from 'three';
import { makeWorld } from './webcomponent-des-fixture';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { createSdkComponent } from '../../src/core/sdk/rv-component-sdk';
import { RVScriptComponentAdapter } from '../../src/core/sdk/rv-script-component-adapter';
import { desScriptMayReadLiveGeometry } from '../../src/core/sdk/rv-des-lint';
import { shippingMonitorCode, PERF_SCRIPT_VARIANTS } from './perf-des-script';

const PLAIN = `
function setup(self) {
  const st = self.persist({ arrivals: 0, last: -1, audits: 0 });
  const s = self.sink('Sink');
  if (s) s.on(function (mu) { st.arrivals++; st.last = self.now; self.statValue('Arrivals', st.arrivals); });
  self.every(60, 'audit');
  return { des: { on(hook) { if (hook === 'audit') st.audits++; } }, state() { return st; } };
}`;

/** Reads its own node at t = 1, 2, 3 through `read(...)`; `READ` is the detour. */
const sampler = (read: string, extraSetup = '') => `
function setup(self) {
  const st = self.persist({ xs: [] });
  ${extraSetup}
  self.at(1, 'probe'); self.at(2, 'probe'); self.at(3, 'probe');
  return {
    des: { on(hook) { if (hook === 'probe') st.xs.push(${read}); } },
    state() { return st; },
  };
}`;

const DETOURS: Array<[string, string]> = [
  ['direct read', sampler('self.self.worldPosition().x')],
  ['alias of self', sampler('alias.self.worldPosition().x', 'const alias = self;')],
  ['computed member on self', sampler("self['se' + 'lf']['world' + 'Position']().x")],
  ['self passed to a helper', `
function readX(api) { return api.self.worldPosition().x; }
${sampler('readX(self)')}`],
  ['destructured self', sampler('me.worldPosition().x', 'const { self: me } = self;')],
];

const OPT_IN = `
function setup(self) {
  const st = self.persist({ n: 0 });
  self.every(60, 'tick');
  return { des: { samplesLiveGeometry: true, on() { st.n++; } }, state() { return st; } };
}`;

type World = Awaited<ReturnType<typeof makeWorld>>;

/** Tween the script node 0 → 10 (x) over t = 0..2 s on the runner's tween registry. */
function tweenNode(w: World, node: Object3D): void {
  const target = { setPosition(v: Vector3) { node.position.copy(v); node.updateMatrixWorld(true); } };
  w.runner.getTweenRegistry().addPosition(target, new Vector3(0, 0, 0), new Vector3(10, 0, 0), 0, 2);
}

describe('plan-2212 Phase 4b (A) — exact settle gate for Model-Scripts', () => {
  it('a plain sink + every script leaves the per-event settle off (same result as settle on)', async () => {
    const run = async (forceSettle: boolean) => {
      const w = await makeWorld({ flow: true, scripts: [{ name: 'Plain', code: PLAIN }] });
      // The DES start rebuilds the script (fresh adapter): force on the prototype.
      const force = forceSettle
        ? vi.spyOn(RVScriptComponentAdapter.prototype, 'samplesLiveGeometry').mockReturnValue(true)
        : null;
      w.start();
      force?.mockRestore();
      const wired = w.manager.onTimeAdvance !== null;
      const settle = vi.spyOn(w.runner.getTweenRegistry(), 'settle');
      await w.runTo(600);
      const result = { wired, settleCalls: settle.mock.calls.length, state: w.state('Plain'), events: w.manager.totalEventsProcessed };
      settle.mockRestore();
      return result;
    };
    const gated = await run(false);
    const settled = await run(true);
    expect(gated.wired).toBe(false);
    expect(gated.settleCalls).toBe(0);
    expect(settled.wired).toBe(true);
    expect(settled.settleCalls).toBeGreaterThan(0);
    const st = gated.state as { arrivals: number; audits: number };
    expect(st.arrivals).toBeGreaterThan(0);
    expect(st.audits).toBe(10);
    expect(gated.state).toEqual(settled.state);
    expect(gated.events).toBe(settled.events);
  }, 60_000);

  it.each(DETOURS)('%s keeps the settle on', async (_label, code) => {
    const w = await makeWorld({ flow: true, scripts: [{ name: 'Sampler', code }] });
    expect(w.inst('Sampler').ok, w.inst('Sampler').disabledReason ?? '').toBe(true);
    w.start();
    expect(w.manager.onTimeAdvance).not.toBeNull();
  });

  it('Codex #1: a JSON replacer that calls the sink node\'s worldPosition keeps the settle on - FF equals animated', async () => {
    const code = `
function setup(self) {
  const st = self.persist({ xs: [] });
  const s = self.sink('Sink');
  self.at(1, 'probe'); self.at(2, 'probe'); self.at(3, 'probe');
  return {
    des: { on(hook) {
      if (hook !== 'probe') return;
      let x = null;
      JSON.stringify(s, function (k, v) { if (k === 'world' + 'Position') { x = v().x; return 0; } return v; });
      st.xs.push(x);
    } },
    state() { return st; },
  };
}`;
    expect(desScriptMayReadLiveGeometry(code).mayRead).toBe(true);
    const sample = async (mode: 'ff' | 'animated'): Promise<number[]> => {
      const w = await makeWorld({ flow: true, scripts: [{ name: 'Json', code }] });
      w.start();
      expect(w.manager.onTimeAdvance).not.toBeNull();
      tweenNode(w, w.scene.getObjectByName('Sink')!);
      if (mode === 'ff') await w.runTo(4);
      else w.animateTo(4, 0.1);
      return (w.state('Json') as { xs: number[] }).xs;
    };
    const ff = await sample('ff');
    expect(ff).toHaveLength(3);
    expect(ff[0]).toBeCloseTo(5);
    expect(ff[1]).toBeCloseTo(10);
    expect(ff.map(x => +x.toFixed(6))).toEqual((await sample('animated')).map(x => +x.toFixed(6)));
  }, 60_000);

  it('Codex round 2: a derived port member escapes at runtime (the leak is real) - the check keeps the settle on', async () => {
    // Script station handlers are not dispatched by the DES runner (no production
    // path), so this runs the station dispatch directly: the port's live worldAngle
    // reaches self.log through p.copy() → let → spread. FF-vs-animated needs a
    // runner path to station handlers that does not exist; the verdict is what gates.
    const code = 'function setup(self){ return { des: { canAccept(mu,p){ p.copy=[].reverse; let q=p.copy(); self.log({...q}); return true; } } }; }';
    expect(desScriptMayReadLiveGeometry(code).mayRead).toBe(true);
    const host = await RVScriptHost.create();
    try {
      const logged: unknown[][] = [];
      const scheduler = { in: () => 1, at: () => 1, cancel: () => {}, now: 0 };
      const adapter = new RVScriptComponentAdapter({ mode: 'des', desScheduler: scheduler, lintPolicy: 'warn', onLintWarning: () => {} });
      const node = new Object3D(); node.name = 'Station';
      const c = createSdkComponent(host, { name: 'Station', path: 'Station', node, scheduler, log: (...a: unknown[]) => { logged.push(a); } }, code, { callDeadlineMs: 500 });
      expect(c.ok, c.error?.message).toBe(true);
      adapter.attach(c);
      expect(adapter.samplesLiveGeometry()).toBe(true);
      expect(adapter.stationCanAccept({ id: 1 }, { id: 'in', role: 'input', worldAngle: 47 })).toBe(true);
      expect(JSON.stringify(logged)).toContain('47');
      c.dispose();
    } finally { host.dispose(); }
  });

  it('the perf fixtures (dense, realistic) and the plain monitor stay geometry-free', () => {
    const sinks = ['Sink_V1', 'Sink_V2'];
    expect(desScriptMayReadLiveGeometry(shippingMonitorCode(sinks, 600, PERF_SCRIPT_VARIANTS.dense.auditSec))).toEqual({ mayRead: false, reason: '' });
    expect(desScriptMayReadLiveGeometry(shippingMonitorCode(sinks.slice(0, 1), 600, PERF_SCRIPT_VARIANTS.realistic.auditSec))).toEqual({ mayRead: false, reason: '' });
    expect(desScriptMayReadLiveGeometry(PLAIN)).toEqual({ mayRead: false, reason: '' });
  });

  it('the explicit opt-in des.samplesLiveGeometry keeps the settle on', async () => {
    const w = await makeWorld({ flow: true, scripts: [{ name: 'OptIn', code: OPT_IN }] });
    w.start();
    expect(w.inst('OptIn').adapter!.samplesLiveGeometry()).toBe(true);
    expect(w.manager.onTimeAdvance).not.toBeNull();
  });

  it.each(DETOURS)('correctness (%s): FastForward reads the exact event-time position, equal to the animated run', async (_label, code) => {
    const sample = async (mode: 'ff' | 'animated'): Promise<number[]> => {
      const w = await makeWorld({ flow: true, scripts: [{ name: 'Sampler', code }] });
      w.start();
      tweenNode(w, w.inst('Sampler').node);
      if (mode === 'ff') await w.runTo(4);
      else w.animateTo(4, 0.1);
      return (w.state('Sampler') as { xs: number[] }).xs;
    };
    const ff = await sample('ff');
    const animated = await sample('animated');
    expect(ff).toHaveLength(3);
    expect(ff[0]).toBeCloseTo(5);   // t = 1: mid-tween, exact event time
    expect(ff[1]).toBeCloseTo(10);
    expect(ff[2]).toBeCloseTo(10);
    expect(ff.map(x => +x.toFixed(6))).toEqual(animated.map(x => +x.toFixed(6)));
  }, 60_000);
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 §9.3b (SOL R2-3) — Model-Scripts that do not exist yet when the
 * DES run starts:
 *
 *  - readiness barrier: with a COLD QuickJS host (still loading at run start)
 *    no DES event runs before the scripts exist; the run then produces the
 *    identical event trace and values as with a WARM host;
 *  - a host load failure is a visible problem and the run goes on without
 *    scripts;
 *  - separately: an asset placed during the DES run and a late trust release
 *    create their script instances directly in DES mode, with the run seed,
 *    as snapshot participants (listed for the DES snapshot pipeline).
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { getProblem, clearProblem } from '../../src/core/hmi/problems-store';
import { DES_SCRIPTS_UNAVAILABLE_CODE } from '@rv/plugins/des/des-runner';
import { scriptSeed32 } from '../../src/core/rv-rng-streams';
import { getActionName } from '@rv/plugins/des/rv-des-named-actions';
import { borrowed, deferred, makeWorld, mulberry32, scriptNode, warmHost } from './webcomponent-des-fixture';

const TRACER = `
function setup(self) {
  const st = self.persist({ trace: [], first: self.random() });
  self.statValue('Draws', 0);
  self.every(3, 'beat');
  return {
    des: { on(hook) {
      if (hook !== 'beat') return;
      st.trace.push([self.now, Math.floor(self.random() * 1000)]);
      self.statValue('Draws', st.trace.length);
    } },
    state() { return st; },
  };
}`;

describe('plan-2212 §9.3b — readiness barrier and late script instances', () => {
  it('cold vs warm QuickJS host: identical event trace and KPI values', async () => {
    // Warm: the host is up before the run starts.
    const warm = await makeWorld({ scripts: [{ name: 'Tracer', code: TRACER }], flow: true });
    warm.manager.setRngVersion(2);
    warm.start();
    expect(warm.runner.scriptsPending).toBe(false);
    await warm.runTo(30);
    const warmState = warm.state('Tracer');
    const warmRow = warm.statRows().find(r => r.label === 'Draws')?.value;
    const warmEvents = warm.manager.totalEventsProcessed;

    // Cold: the host is still loading when the run starts.
    const host = deferred<RVScriptHost>();
    const cold = await makeWorld({ scripts: [{ name: 'Tracer', code: TRACER }], flow: true,
      createHost: () => host.promise, awaitWiring: false });
    cold.manager.setRngVersion(2);
    expect(cold.plugin.wiringPending).toBe(true);
    cold.start();
    expect(cold.runner.scriptsPending).toBe(true);
    // Frames while the barrier holds run no event.
    for (let i = 0; i < 10; i++) cold.runner.tick(1 / 60);
    expect(cold.manager.totalEventsProcessed).toBe(0);
    expect(cold.runner.step()).toBe(false);
    cold.manager.duration = 30;
    const ff = cold.runner.runFastForward();
    await new Promise(r => setTimeout(r, 20));
    expect(cold.manager.totalEventsProcessed).toBe(0);
    host.resolve(borrowed(await warmHost()));
    expect(await ff).toBe(true);
    expect(cold.runner.scriptsPending).toBe(false);
    expect(cold.inst('Tracer').adapter!.mode).toBe('des');
    expect(cold.state('Tracer')).toEqual(warmState);
    expect(cold.statRows().find(r => r.label === 'Draws')?.value).toBe(warmRow);
    expect(cold.manager.totalEventsProcessed).toBe(warmEvents);
  });

  it('cold vs warm: ONE startup order — same-time script and material events are queued identically (review #3)', async () => {
    // Script timers at exactly the times the Source generates (Interval 10 s,
    // first part at t=0): the queue order at equal times is the startup order.
    const SAME_TIME = `
function setup(self) {
  const st = self.persist({ seen: [] });
  self.at(0, 'zero');
  self.at(10, 'ten');
  return {
    des: { on(hook) { st.seen.push([hook, self.now]); } },
    state() { return st; },
  };
}`;
    type Q = { snapshot(): Array<{ id: number; time: number; priority: number; actionIndex: number; entityId: number }> };
    const order = (w: Awaited<ReturnType<typeof makeWorld>>): string[] =>
      (w.manager as unknown as { queue: Q }).queue.snapshot()
        .sort((a, b) => a.time - b.time || a.priority - b.priority || a.id - b.id)
        .map(e => `${e.time}:${getActionName(e.actionIndex)}:${e.entityId}`);

    const warm = await makeWorld({ scripts: [{ name: 'Same', code: SAME_TIME }], flow: true });
    warm.start();
    const warmOrder = order(warm);
    await warm.runTo(30);

    const host = deferred<RVScriptHost>();
    const cold = await makeWorld({ scripts: [{ name: 'Same', code: SAME_TIME }], flow: true,
      createHost: () => host.promise, awaitWiring: false });
    cold.start();
    // Nothing of the run is started while the scripts are missing.
    expect(order(cold)).toEqual([]);
    host.resolve(borrowed(await warmHost()));
    await cold.plugin.whenWired();
    await new Promise(r => setTimeout(r, 0));
    expect(cold.runner.scriptsPending).toBe(false);
    expect(order(cold)).toEqual(warmOrder);
    expect(warmOrder.some(e => e.startsWith('0:Script.Hook'))).toBe(true);
    await cold.runTo(30);
    expect(cold.state('Same')).toEqual(warm.state('Same'));
    expect(cold.manager.totalEventsProcessed).toBe(warm.manager.totalEventsProcessed);
    const sink = (w: typeof warm) => w.runner.liveInstances.find(i => i.adapter.node.name === 'Sink')!.adapter.totalProcessed;
    expect(sink(cold)).toBe(sink(warm));
  });

  it('a host load failure is a visible problem; the run starts without scripts', async () => {
    clearProblem(DES_SCRIPTS_UNAVAILABLE_CODE);
    const host = deferred<RVScriptHost>();
    const w = await makeWorld({ scripts: [{ name: 'Tracer', code: TRACER }], flow: true,
      createHost: () => host.promise, awaitWiring: false });
    w.start();
    expect(w.runner.scriptsPending).toBe(true);
    w.manager.duration = 30;
    const ff = w.runner.runFastForward();
    host.reject(new Error('wasm blocked'));
    expect(await ff).toBe(true);
    expect(w.plugin.instances).toHaveLength(0);
    expect(w.manager.totalEventsProcessed).toBeGreaterThan(0);   // the material flow ran
    const problem = getProblem(DES_SCRIPTS_UNAVAILABLE_CODE);
    expect(problem?.severity).toBe('warning');
    expect(problem?.detail).toContain('wasm blocked');
    clearProblem(DES_SCRIPTS_UNAVAILABLE_CODE);
  });

  it('a script placed during the DES run is minted in DES mode with the run seed, as snapshot participant', async () => {
    const w = await makeWorld({ scripts: [], flow: true });
    w.manager.setRngVersion(2);
    w.runner.setMasterSeed(77);
    w.start();
    await w.runTo(10);

    // layout-content-added: a placed asset with a WebComponent arrives mid-run.
    const placed = new Object3D(); placed.name = 'Placed';
    placed.add(scriptNode({ name: 'Tracer', code: TRACER }));
    w.scene.add(placed);
    w.viewer.emit('layout-content-added', { root: placed });
    await w.plugin.whenWired();

    const inst = w.inst('Tracer');
    expect(inst.adapter!.mode).toBe('des');
    const listed = w.plugin.listScriptComponents();
    expect(listed.map(s => s.path)).toEqual(['Placed/Tracer']);
    const desId = listed[0].desId!;
    expect(desId).toBeTruthy();
    expect((w.state('Tracer') as { first: number }).first).toBe(mulberry32(scriptSeed32(77, desId))());
    await w.runTo(16);
    // Timers run on the DES clock from the placement time on.
    expect((w.state('Tracer') as { trace: number[][] }).trace.map(t => t[0])).toEqual([13, 16]);
  });

  it('a late trust release mints the scripts in DES mode with the run seed', async () => {
    const w = await makeWorld({ scripts: [{ name: 'Tracer', code: TRACER }], flow: true, allowScripts: false });
    w.manager.setRngVersion(2);
    w.runner.setMasterSeed(91);
    w.start();
    expect(w.plugin.instances).toHaveLength(0);

    w.plugin.setAllowScripts(true);
    await w.plugin.whenWired();
    const inst = w.inst('Tracer');
    expect(inst.adapter!.mode).toBe('des');
    const desId = w.plugin.listScriptComponents()[0].desId!;
    expect((w.state('Tracer') as { first: number }).first).toBe(mulberry32(scriptSeed32(91, desId))());
    await w.runTo(6);
    expect((w.state('Tracer') as { trace: number[][] }).trace.map(t => t[0])).toEqual([3, 6]);
  });
});

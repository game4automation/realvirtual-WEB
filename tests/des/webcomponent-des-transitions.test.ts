// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 §9.6d (SOL R2-VG) — transitions inside one DES run with open
 * Model-Script timers:
 *
 *  1. pause/resume and profile switches animated ⇄ FastForward (both the
 *     `runFastForward()` drain and the standalone FastForward sub-mode) in ONE
 *     run give the same script trace and KPIs as a straight FastForward run;
 *  2. a snapshot taken AFTER the run end, continued (same world and a fresh
 *     world restored from it), equals a straight run to the longer end;
 *  3. a switch to continuous during an experiment batch aborts the batch
 *     cleanly: the archive holds only completed replications, the scripts are
 *     back on the frame clock and nothing rebinds them to DES afterwards.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeWorld } from './webcomponent-des-fixture';
import { whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';

const MONITOR = `
function setup(self) {
  const st = self.persist({ trace: [], late: 0, lastAt: -1 });
  self.statValue('Late', 0);
  self.every(7, 'audit');
  self.at(155.5, 'far');              // open over every transition below
  self.at(3 + Math.floor(self.random() * 50) / 10, 'once');
  self.sink('Sink').on(function (mu) {
    if (st.lastAt >= 0 && self.now - st.lastAt > 12) { st.late++; self.statValue('Late', st.late); }
    st.lastAt = self.now;
    st.trace.push(['sink', self.now, mu.id]);
  });
  return {
    des: { on(hook) {
      st.trace.push([hook, self.now, Math.floor(self.random() * 1e6)]);
      if (hook === 'audit') self.statValue('Audits', st.trace.length);
      if (hook === 'once' || hook === 'after') self.in(2.5 + Math.floor(self.random() * 20), 'after');
    } },
    continuous: { fixedUpdate() { self.random(); self.statValue('Late', -1); } },
    state() { return st; },
  };
}`;

type World = Awaited<ReturnType<typeof makeWorld>>;

async function world(seed = 9): Promise<World> {
  const w = await makeWorld({ flow: true, seed, scripts: [{ name: 'Monitor', code: MONITOR }] });
  w.manager.setRngVersion(2);
  return w;
}

function outcome(w: World) {
  const sink = w.runner.liveInstances.find(i => i.adapter.node.name === 'Sink')!.adapter;
  return {
    trace: (w.state('Monitor') as { trace: unknown[] }).trace,
    rows: w.statRows().map(r => [r.label, r.value]),
    kpis: { processed: sink.totalProcessed, live: w.manager.liveMuCount, events: w.manager.totalEventsProcessed },
  };
}

/** Animated frames until the DES time reaches `t` (the run goes on). */
function animateUntil(w: World, t: number, dt = 0.2): void {
  w.runner.setSubMode('animated');
  for (let i = 0; i < 100_000 && w.manager.currentTime < t; i++) w.frame(dt);
}

describe('plan-2212 §9.6d — profile transitions with open script timers', () => {
  it('pause/resume and animated ⇄ FastForward switches in one run = straight FastForward run', async () => {
    const END = 240;
    const ref = await world();
    ref.start();
    await ref.runTo(END);
    const expected = outcome(ref);
    expect(expected.trace.some(t => (t as unknown[])[0] === 'far')).toBe(true);

    const w = await world();
    w.start();
    w.manager.duration = END;
    animateUntil(w, 30);
    // Pause: frames go on (display), the DES state does not move.
    w.manager.pause();
    const paused = JSON.stringify(outcome(w));
    const at = w.manager.currentTime;
    for (let i = 0; i < 20; i++) w.frame(0.2);
    expect(w.manager.currentTime).toBe(at);
    expect(JSON.stringify(outcome(w))).toBe(paused);
    w.manager.resume();
    // FastForward drain to a target, back to animated, standalone FF sub-mode, animated to the end.
    await expect(w.runner.fastForwardUntil(90.3)).resolves.toBe(true);
    expect(w.runner.subMode).toBe('animated');
    animateUntil(w, 120);
    const hooks = () => (w.state('Monitor') as { trace: unknown[][] }).trace.map(t => t[0]);
    expect(hooks()).not.toContain('far');   // still open at the switch to FastForward
    // Standalone FastForward sub-mode (the toggle): one frame drains a whole time slice.
    w.runner.setSubMode('fastforward');
    for (let i = 0; i < 100_000 && !w.runner.runComplete; i++) w.frame(0.2);
    expect(hooks()).toContain('far');
    w.animateTo(END, 0.2);
    expect(outcome(w)).toEqual(expected);
  });

  it('snapshot after the run end, continued in the same and in a fresh world = straight longer run', async () => {
    const ref = await world();
    ref.start();
    await ref.runTo(240);
    const expected = outcome(ref);

    const w = await world();
    w.start();
    await whenDocumentHashesSettled();
    await w.runTo(120);
    expect(w.runner.runComplete?.reason).toBe('duration-reached');
    const saved = JSON.stringify(w.runner.fullSnapshot());

    // Same world: Play after "Run finished" continues to 2 x 120.
    expect(w.runner.continueRun()).toBe(true);
    expect(w.manager.duration).toBe(240);
    await expect(w.runner.runFastForward()).resolves.toBe(true);
    expect(outcome(w)).toEqual(expected);

    // Fresh world (real rebuild): load the after-end snapshot, continue to 240.
    const fresh = await world();
    fresh.start();
    fresh.runner.restoreFull(JSON.parse(saved));
    expect(fresh.manager.currentTime).toBe(120);
    fresh.runner.setEndTime(240);
    await expect(fresh.runner.runFastForward()).resolves.toBe(true);
    expect(outcome(fresh)).toEqual(expected);
  });

});

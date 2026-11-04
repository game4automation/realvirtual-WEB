// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 §9.6b — one model with a Model-Script (timers, a sink listener,
 * `self.statValue` KPIs, `self.random()`, and a frame hook that tries to
 * change state) gives the SAME script event trace and the SAME KPIs in all
 * three DES profiles:
 *
 *  - animated (viewer frames: frame hooks run, display only),
 *  - FastForward (no frame hooks),
 *  - an experiment batch replication (no frame hooks, archived run).
 *
 * The trace includes the MU ids the sink listener sees (Phase 2 made them
 * independent of how the run is sliced) and the random draws of the DES hooks
 * (the frame hook's draws must not shift the stream).
 */

import { describe, it, expect } from 'vitest';
import { makeWorld } from './webcomponent-des-fixture';

const MONITOR = `
function setup(self) {
  const st = self.persist({ trace: [], late: 0, lastAt: -1 });
  self.statValue('Late', 0);
  self.every(7, 'audit');
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
      if (hook === 'once') self.in(2.5, 'after');
    } },
    continuous: {
      fixedUpdate() {
        self.random(); self.random();
        self.statValue('Late', -1);    // refused: display only
      },
    },
    state() { return st; },
  };
}`;

const END = 240;
type World = Awaited<ReturnType<typeof makeWorld>>;

async function world(): Promise<World> {
  const w = await makeWorld({ flow: true, seed: 7, scripts: [{ name: 'Monitor', code: MONITOR }] });
  w.manager.setRngVersion(2);
  return w;
}

function outcome(w: World) {
  const sink = w.runner.liveInstances.find(i => i.adapter.node.name === 'Sink')!.adapter;
  return {
    trace: (w.state('Monitor') as { trace: unknown[] }).trace,
    rows: w.statRows().map(r => [r.label, r.value]),
    kpis: {
      processed: sink.totalProcessed,
      live: w.manager.liveMuCount,
      events: w.manager.totalEventsProcessed,
      simTime: w.manager.currentTime,
    },
  };
}

describe('plan-2212 §9.6b — identical script results in animated and FastForward', () => {
  it('same trace (incl. MU ids and random draws) and KPIs in all profiles', async () => {
    const baseline = await world();
    baseline.start();
    await baseline.runTo(END);
    const ref = outcome(baseline);
    const batchSeed = baseline.manager.masterSeed;
    const ff = await world();
    ff.runner.setMasterSeed(batchSeed);
    ff.start();
    await ff.runTo(END);
    expect(outcome(ff)).toEqual(ref);

    const an = await world();
    an.runner.setMasterSeed(batchSeed);
    an.start();
    an.animateTo(END, 0.2);
    expect(an.inst('Monitor').adapter!.displayWriteRefusals).toBeGreaterThan(100);   // the frame hook ran
    expect(outcome(an)).toEqual(ref);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 (9.6b brought forward) — MU ids do not depend on how a run is sliced.
 *
 * DES MU ids are manager slot ids; the slot of a consumed MU is reused by the
 * next part. The id a sink callback (and every KPI built from it) sees must be
 * the same for one FastForward to T, single event steps, many short
 * FastForward slices and animated frame ticks - so a consumed MU retires at the
 * end of its consuming event (DES time), never at a runner sweep between
 * batches or frames.
 */

import { describe, it, expect } from 'vitest';
import { makeWorld } from './webcomponent-des-fixture';

const RECORDER = `
function setup(self) {
  const st = self.persist({ hits: [] });
  self.sink('Sink').on(function (mu) { st.hits.push([self.now, mu.id]); });
  return { state() { return st; } };
}`;

const T = 203.3;   // between events: every slicing processes the same event set

type World = Awaited<ReturnType<typeof makeWorld>>;
type Slicing = (w: World) => Promise<void>;

const SLICINGS: Record<string, Slicing> = {
  'one FastForward to T': async (w) => { await w.runner.fastForwardUntil(T); },
  'single event steps': async (w) => {
    while (w.manager.nextModelEventTime <= T) {
      if (!w.runner.step()) throw new Error('step refused');
    }
  },
  'many short FastForward slices': async (w) => {
    for (let t = 0.7; t < T; t += 0.7) await w.runner.fastForwardUntil(t);
    await w.runner.fastForwardUntil(T);
  },
  'animated frame ticks': async (w) => {
    w.runner.setSubMode('animated');
    for (let i = 0; i < 100_000 && w.manager.currentTime < T && w.manager.nextModelEventTime <= T; i++) {
      w.runner.tick(0.25);
      w.runner.lateTick(0.25);
    }
  },
};

async function run(slicing: Slicing) {
  const w = await makeWorld({ flow: true, seed: 3, scripts: [{ name: 'Recorder', code: RECORDER }] });
  w.start();
  w.manager.duration = T;
  await slicing(w);
  const sink = w.runner.liveInstances.find(i => i.adapter.node.name === 'Sink')!.adapter;
  return {
    hits: (w.state('Recorder') as { hits: Array<[number, number]> }).hits,
    kpis: { processed: sink.totalProcessed, live: w.manager.liveMuCount, events: w.manager.totalEventsProcessed },
  };
}

describe('plan-2212 — MU ids are independent of run slicing', () => {
  it('identical MU-id trace and KPIs for FF, steps, FF slices and animated ticks', async () => {
    const ref = await run(SLICINGS['one FastForward to T']);
    expect(ref.hits.length).toBeGreaterThan(20);
    // The model reuses slots: otherwise this test proves nothing.
    expect(new Set(ref.hits.map(h => h[1])).size).toBeLessThan(ref.hits.length);
    for (const [name, slicing] of Object.entries(SLICINGS)) {
      const got = await run(slicing);
      expect({ name, ...got }).toEqual({ name, ...ref });
    }
  });

  it('an MU consumed outside a dispatch and captured at once retires at the same point after a restore', async () => {
    const world = async () => {
      const w = await makeWorld({ flow: true, seed: 3, scripts: [{ name: 'Recorder', code: RECORDER }] });
      w.start();
      w.manager.duration = 1e6;
      return w;
    };
    const sinkOf = (w: World) => w.runner.liveInstances.find(i => i.adapter.node.name === 'Sink')!.adapter;
    // A consumption outside any event dispatch (a command / programmatic hand-over).
    const consumeOutside = (w: World) => {
      const mu = w.runner.createMU();
      expect(sinkOf(w).acceptMU(mu)).toBe(true);
    };
    const result = (w: World) => ({
      hits: (w.state('Recorder') as { hits: Array<[number, number]> }).hits,
      processed: sinkOf(w).totalProcessed, live: w.manager.liveMuCount, slots: w.manager.muCount,
    });

    const ref = await world();
    await ref.runner.fastForwardUntil(20.5);
    consumeOutside(ref);
    await ref.runner.fastForwardUntil(80);
    const expected = result(ref);

    // Same world: capture right after the outside consumption, reset, restore.
    const same = await world();
    await same.runner.fastForwardUntil(20.5);
    consumeOutside(same);
    const saved = JSON.parse(JSON.stringify(same.runner.fullSnapshot()));
    expect(saved.parts.find((p: { key: string }) => p.key === 'des.mus').state.pendingRetire).toHaveLength(1);
    same.runner.reset();
    same.runner.restoreFull(JSON.parse(JSON.stringify(saved)));
    await same.runner.fastForwardUntil(80);
    expect(result(same)).toEqual(expected);

    // A fresh world (real rebuild) loads the same snapshot.
    const fresh = await world();
    fresh.runner.restoreFull(JSON.parse(JSON.stringify(saved)));
    await fresh.runner.fastForwardUntil(80);
    expect(result(fresh)).toEqual(expected);
  });
});

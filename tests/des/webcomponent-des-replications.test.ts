// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 §9.2 — every DES replication starts each Model-Script from its
 * initial state, with the run RNG seed fixed BEFORE `setup()`:
 *
 *  - persist starts from its initial value in every replication;
 *  - the random values drawn in `setup()` (persist start value, first timer)
 *    and the first timer differ per replication and are identical over two
 *    batches (CRN) — and they are the FIRST draws of the run stream
 *    `scriptSeed32(masterSeed, desId)`: the stream is not started twice
 *    (once with the path seed in setup, once with the run seed afterwards);
 *  - after the batch the DES instances stay with their end state (readable
 *    for KPI rows); only the switch to continuous unbinds them.
 *
 * Replications are driven like the experiment batch does it per column slot
 * (`setMasterSeed(seed)` + `reset()` + FastForward to the end time).
 */

import { describe, it, expect } from 'vitest';
import { makeWorld, mulberry32 } from './webcomponent-des-fixture';
import { scriptSeed32 } from '../../src/core/rv-rng-streams';

const REPLICATING = `
function setup(self) {
  const st = self.persist({ init: self.random(), firstAt: 0, n: 0, draws: [] });
  st.firstAt = 1 + Math.floor(self.random() * 10);
  self.at(st.firstAt, 'go');
  return {
    des: { on(hook) {
      if (hook !== 'go') return;
      st.n++;
      st.draws.push(self.random());
      self.in(5, 'go');
    } },
    state() { return st; },
  };
}`;

interface St { init: number; firstAt: number; n: number; draws: number[] }
const SEEDS = [11, 12, 13];
const END = 60;

async function batch(w: Awaited<ReturnType<typeof makeWorld>>): Promise<St[]> {
  const out: St[] = [];
  for (const seed of SEEDS) {
    w.runner.setMasterSeed(seed);
    w.runner.reset();
    await w.runTo(END);
    out.push(JSON.parse(JSON.stringify(w.state('Rep'))) as St);
  }
  return out;
}

describe('plan-2212 §9.2 — replications restart Model-Scripts', () => {
  it('fresh state per replication, run seed before setup, CRN over two batches, instances stand after the batch', async () => {
    const w = await makeWorld({ scripts: [{ name: 'Rep', code: REPLICATING }], flow: true });
    w.manager.setRngVersion(2);
    w.start();
    const desId = w.plugin.listScriptComponents()[0].desId!;
    expect(desId).toBeTruthy();

    const first = await batch(w);
    for (const [i, st] of first.entries()) {
      // The first draws of THIS replication's run stream, in order.
      const rnd = mulberry32(scriptSeed32(SEEDS[i], desId));
      const init = rnd();
      const firstAt = 1 + Math.floor(rnd() * 10);
      expect(st.init).toBe(init);
      expect(st.firstAt).toBe(firstAt);
      expect(st.draws[0]).toBe(rnd());
      // Initial persist state: the count starts at 0 in every replication.
      expect(st.n).toBe(Math.floor((END - firstAt) / 5) + 1);
    }
    expect(new Set(first.map(s => s.init)).size).toBe(SEEDS.length);

    const second = await batch(w);
    expect(second).toEqual(first);

    // After the batch: the DES instance stands with the last replication's end state.
    const inst = w.inst('Rep');
    expect(inst.adapter!.mode).toBe('des');
    expect(w.state('Rep')).toEqual(first[first.length - 1]);

    // Only the switch to continuous unbinds: a fresh frame-clock instance.
    w.switchToContinuous();
    const back = w.inst('Rep');
    expect(back).not.toBe(inst);
    expect(back.adapter!.mode).toBe('continuous');
    expect((w.state('Rep') as St).n).toBe(0);
  });
});

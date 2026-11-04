// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 review #1 — the teardown of an outgoing Model-Script never cancels
 * an event of the new run. Queue ids restart with every reset; a disposed
 * script still holds the ids of its pending timers and cancels them on
 * dispose. Those ids may now name the new run's warm-up event or another
 * (already rebuilt) script's timer — with seed-dependent setup timer counts the
 * id ranges of the scripts shift between replications. The script scheduler
 * cancels only an event that this script itself still has pending.
 */

import { describe, it, expect } from 'vitest';
import { makeWorld } from './webcomponent-des-fixture';
import { getActionName } from '@rv/plugins/des/rv-des-named-actions';
import { WARMUP_ACTION } from '@rv/plugins/des/rv-des-event';

/** 1..4 long pending timers in setup, count drawn from the run seed. */
const FAN = `
function setup(self) {
  const st = self.persist({ k: 1 + Math.floor(self.random() * 4) });
  for (let i = 0; i < st.k; i++) self.in(1000 + i, 'late');
  return { state() { return st; } };
}`;

interface QueueView { snapshot(): Array<{ id: number; time: number; actionIndex: number }> }

describe('plan-2212 review #1 — no foreign event is cancelled by a script teardown', () => {
  it('warm-up event and every new script timer survive the rebuild across replications', async () => {
    const names = ['A', 'B', 'C', 'D'];
    const w = await makeWorld({ scripts: names.map(name => ({ name, code: FAN })), flow: true });
    w.manager.setRngVersion(2);
    w.manager.statResetTime = 500;   // warm-up event: queued first at every reset
    w.start();
    const queue = (w.manager as unknown as { queue: QueueView }).queue;
    const ks = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      w.runner.setMasterSeed(seed);
      w.runner.reset();
      const events = queue.snapshot();
      const actions = events.map(e => getActionName(e.actionIndex));
      expect(actions.filter(a => a === WARMUP_ACTION).length, `warm-up after seed ${seed}`).toBe(1);
      // Every rebuilt script still has exactly its k setup timers pending.
      const scripts = w.plugin.listScriptComponents();
      const counts = scripts.map(s => events.filter(e =>
        (w.manager.eventDataOf(e.id) as { dispatcher?: unknown } | undefined)?.dispatcher === s.adapter).length);
      const expected = names.map(n => (w.state(n) as { k: number }).k);
      expect(counts, `script timers after seed ${seed}`).toEqual(expected);
      ks.add(expected.join(','));
      await w.runTo(20);
    }
    // The seeds really moved the id ranges between replications.
    expect(ks.size).toBeGreaterThan(1);
  });
});

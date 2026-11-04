// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 §9.2b (SOL R2-1) — a Model-Script whose `setup()` already queues a
 * DES event must not stop the runner from cleaning its component
 * registrations at the next start. `_startWith` clears the registrations while
 * the model queue is still empty and only THEN rebuilds the scripts; the other
 * order leaves the setup timer in the queue, the guard skips the cleanup and
 * every replication registers the material-flow adapters once more (growing
 * component list, shifting entity ids, parts processed twice).
 */

import { describe, it, expect } from 'vitest';
import { makeWorld } from './webcomponent-des-fixture';

const SETUP_TIMER = `
function setup(self) {
  const st = self.persist({ fired: 0 });
  self.in(0.5, 'early');
  return {
    des: { on(hook) { if (hook === 'early') st.fired++; } },
    state() { return st; },
  };
}`;

interface Rep { components: number; entityIds: number[]; sinkProcessed: number; events: number; fired: number }

async function replications(withScript: boolean): Promise<Rep[]> {
  const w = await makeWorld({ scripts: withScript ? [{ name: 'Early', code: SETUP_TIMER }] : [], flow: true });
  w.start();
  const adapters = w.runner.liveInstances.map(i => i.adapter);
  const sink = adapters.find(a => a.node.name === 'Sink')!;
  const out: Rep[] = [];
  for (let rep = 0; rep < 3; rep++) {
    w.runner.setMasterSeed(7);
    w.runner.reset();
    await w.runTo(200);
    out.push({
      components: w.manager.componentCount,
      entityIds: adapters.map(a => a.entityId),
      sinkProcessed: sink.totalProcessed,
      events: w.manager.totalEventsProcessed,
      fired: withScript ? (w.state('Early') as { fired: number }).fired : 0,
    });
  }
  return out;
}

describe('plan-2212 §9.2b — component registration stays clean with script setup timers', () => {
  it('constant component count and entity ids over 3 replications, no double processing', async () => {
    const withScript = await replications(true);
    const plain = await replications(false);
    for (const rep of withScript) {
      expect(rep.components).toBe(withScript[0].components);
      expect(rep.entityIds).toEqual(withScript[0].entityIds);
      expect(rep.fired).toBe(1);   // setup timer once per replication
    }
    expect(withScript[0].components).toBe(3);
    // The script never doubles the material flow: same parts at the sink as without it.
    expect(withScript.map(r => r.sinkProcessed)).toEqual(plain.map(r => r.sinkProcessed));
    expect(withScript[0].sinkProcessed).toBeGreaterThan(0);
    // Exactly one extra event per replication: the script's setup timer.
    expect(withScript.map(r => r.events)).toEqual(plain.map(r => r.events + 1));
  });
});

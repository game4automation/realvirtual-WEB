// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { makeScriptSim, CODE, restart } from './rng-v2-script-fixture';
import { whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';
import { scriptSeed32 } from '../../src/core/rv-rng-streams';
function viewerReset(sim: Parameters<typeof restart>[0], seed: number): void {
  sim.manager.setRngVersion(2);
  sim.runner.setMasterSeed(seed);
  sim.adapter.reset();
  sim.runner.reset();
  // Runner reset clears the queue, including the timer armed by onReset.
  sim.adapter.scheduler.at(1, 'beat', null, null);
}

const RESET_DRAW_CODE = CODE.replace('st.hist.length = 0;', 'st.hist.length = 0; st.hist.push(self.random());');

describe('RNG v2 script stream', () => {
  it('viewer reset uses the changed seed and preserves onReset consumption', async () => {
    const sim = await makeScriptSim(RESET_DRAW_CODE);
    restart(sim, 41);
    viewerReset(sim, 41); const old = sim.state() as number[];
    viewerReset(sim, 42); sim.runTo(5.25); const actual = sim.state() as number[];
    const fresh = await makeScriptSim(RESET_DRAW_CODE);
    restart(fresh, 42); fresh.runTo(5.25);
    expect(actual[0]).toBe((fresh.state() as number[])[0]);
    expect(actual[0]).not.toBe(old[0]);
    expect(actual[1]).not.toBe(actual[0]);
    expect(actual).toEqual(fresh.state());
  });
  it('viewer reset with the same seed replays the full sequence', async () => {
    const sim = await makeScriptSim(RESET_DRAW_CODE);
    restart(sim, 42);
    viewerReset(sim, 41); sim.runTo(5.25); const expected = sim.state();
    viewerReset(sim, 41); sim.runTo(5.25);
    expect(sim.state()).toEqual(expected);
  });
  it('snapshot after viewer reset continues the uninterrupted sequence', async () => {
    const sim = await makeScriptSim(RESET_DRAW_CODE);
    restart(sim, 41);
    viewerReset(sim, 41); sim.runTo(2.25);
    viewerReset(sim, 42); sim.runTo(3.25);
    await whenDocumentHashesSettled();
    const snapshot = sim.runner.fullSnapshot();
    sim.runTo(7.25); const expected = sim.state();
    const target = await makeScriptSim(RESET_DRAW_CODE);
    viewerReset(target, 42);
    await whenDocumentHashesSettled();
    target.runner.restoreFull(snapshot);
    target.runTo(7.25);
    expect(target.state()).toEqual(expected);
    const fresh = await makeScriptSim(RESET_DRAW_CODE);
    restart(fresh, 42); fresh.runTo(7.25);
    expect(target.state()).toEqual(fresh.state());
  });
  it('replays A after A and B in one VM, and in a fresh VM', async () => {
    const sim = await makeScriptSim(CODE);
    restart(sim, 41); sim.runTo(5.25); const a = sim.state();
    restart(sim, 41); sim.runTo(5.25); expect(sim.state()).toEqual(a);
    restart(sim, 42); sim.runTo(5.25); expect(sim.state()).not.toEqual(a);
    restart(sim, 41); sim.runTo(5.25); expect(sim.state()).toEqual(a);
    const fresh = await makeScriptSim(CODE);
    restart(fresh, 41); fresh.runTo(5.25); expect(fresh.state()).toEqual(a);
  });
  it.each(['A', 'B', 'B-immediate'])('%s restores saved RNG after start reseeding', async mode => {
    const sim = await makeScriptSim(CODE);
    restart(sim, 41);
    await whenDocumentHashesSettled();
    expect(sim.adapter.captureScriptState()!.rng).toBe(scriptSeed32(41, '#ScriptStation@Script') | 0);
    if (mode !== 'B-immediate') sim.runTo(3.25);
    const snapshot = sim.runner.fullSnapshot();
    sim.runTo(7.25); const expected = sim.state();
    const target = mode === 'A' ? sim : await makeScriptSim(CODE);
    if (mode !== 'A') {
      restart(target, 41);
      await whenDocumentHashesSettled();
    }
    target.runner.restoreFull(snapshot);
    target.runTo(7.25);
    expect(target.state()).toEqual(expected);
  });
  it('v1 resets continue the stream and v2 to v1 restores the path seed', async () => {
    const sim = await makeScriptSim(CODE);
    const initial = sim.adapter.captureScriptState()!.rng;
    restart(sim, 41, 1); sim.runTo(3.25); const first = sim.state();
    const after = sim.adapter.captureScriptState()!.rng;
    restart(sim, 41, 1);
    expect(sim.adapter.captureScriptState()!.rng).toBe(after);
    sim.runTo(3.25); expect(sim.state()).not.toEqual(first);
    restart(sim, 41);
    expect(sim.adapter.captureScriptState()!.rng).toBe(scriptSeed32(41, '#ScriptStation@Script') | 0);
    restart(sim, 41, 1);
    expect(sim.adapter.captureScriptState()!.rng).toBe(initial);
    sim.runTo(3.25); expect(sim.state()).toEqual(first);
  });
  it('onReset draws from the run seed, including repeated adapter resets', async () => {
    const sim = await makeScriptSim(`function setup(self) {
      const st = self.persist({draw: 0});
      return { onReset() { st.draw = self.random(); }, state() { return st.draw; }, des: { on() { self.random(); } } };
    }`);
    restart(sim, 41); const expected = sim.state();
    sim.adapter.setRunRngSeed(scriptSeed32(41, '#ScriptStation@Script'));
    sim.adapter.dispatchScriptHook('x', null, null);   // advance the stream: reset must rewind it
    sim.adapter.reset(); expect(sim.state()).toBe(expected);
    restart(sim, 42); expect(sim.state()).not.toBe(expected);
    restart(sim, 41); expect(sim.state()).toBe(expected);
  });
});

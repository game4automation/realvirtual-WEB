// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 §9.3 — mode switches and rebinding:
 *
 *  - continuous → DES → continuous: timer times are right in both modes, and
 *    after the switch back the script's `tick` is active again on the frame
 *    clock (open frame timers are dropped at the switch into DES);
 *  - the DES lint/state check (`des-script-undeclared-state`) only warns for a
 *    script that is not `DesSafe` — it keeps running on the DES clock — and
 *    disables a `DesSafe` one;
 *  - `rebindScene()` during DES binds the scripts again: fresh instances, still
 *    on the DES clock, timers run on.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeWorld } from './webcomponent-des-fixture';

const TICKER = `
function setup(self) {
  const st = self.persist({ times: [] });
  self.every(2, 'tick');
  return {
    des: { on(hook) { if (hook === 'tick') st.times.push(self.now); } },
    state() { return st; },
  };
}`;

/** Hidden closure state: the AST state check flags it (undeclared state). */
const CLOSURE_STATE = `
function setup(self) {
  function make(n=0) { return () => { ++n; self.statValue('Count', n); }; }
  self.every(1, 'beat');
  return { des: { on: make() } };
}`;

const times = (v: unknown): number[] => (v as { times: number[] }).times;

describe('plan-2212 §9.3 — continuous ↔ DES switches', () => {
  it('continuous → DES → continuous keeps correct timer times; tick is active after the switch back', async () => {
    const w = await makeWorld({ scripts: [{ name: 'Ticker', code: TICKER }], flow: true });
    w.tickContinuous(5);
    const cont = times(w.state('Ticker'));
    expect(cont).toHaveLength(2);
    expect(cont[0]).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(cont[0]).toBeLessThan(2 + 1 / 60 + 1e-9);

    // → DES: fresh instance (the open frame timer at ~6 s is dropped), DES clock.
    w.start();
    await w.runTo(10);
    expect(w.inst('Ticker').adapter!.mode).toBe('des');
    expect(times(w.state('Ticker'))).toEqual([2, 4, 6, 8, 10]);

    // → continuous: fresh frame-clock instance, tick runs again.
    w.switchToContinuous();
    expect(w.inst('Ticker').adapter!.mode).toBe('continuous');
    expect(times(w.state('Ticker'))).toEqual([]);
    w.tickContinuous(3);
    const again = times(w.state('Ticker'));
    expect(again).toHaveLength(1);
    expect(again[0]).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(again[0]).toBeLessThan(2 + 1 / 60 + 1e-9);
  });

  it('a lint finding warns but does not block a non-DesSafe script; DesSafe disables it', async () => {
    const warn = vi.spyOn(console, 'warn');
    const w = await makeWorld({ scripts: [
      { name: 'Loose', code: CLOSURE_STATE },
      { name: 'Strict', code: CLOSURE_STATE, desSafe: true },
    ], flow: true });
    w.start();
    const loose = w.inst('Loose');
    const strict = w.inst('Strict');
    expect(loose.adapter!.mode).toBe('des');
    expect(loose.ok).toBe(true);
    expect(strict.isDisabled).toBe(true);
    expect(strict.disabledReason).toContain('des-script-undeclared-state');
    expect(warn.mock.calls.some(c => String(c.join(' ')).includes('des-script-undeclared-state')
      && String(c.join(' ')).includes('Loose'))).toBe(true);
    // Only the running script is a DES participant.
    expect(w.plugin.listScriptComponents().map(s => s.path)).toEqual(['Scripts/Loose']);
    await w.runTo(5);
    const row = w.statRows().find(r => r.label === 'Count' && r.owner === 'Scripts/Loose');
    expect(row?.value).toBe(5);
    warn.mockRestore();
  });

  it('rebindScene() during DES binds the scripts again on the DES clock', async () => {
    const w = await makeWorld({ scripts: [{ name: 'Ticker', code: TICKER }], flow: true });
    w.start();
    await w.runTo(4);
    const before = w.inst('Ticker');
    expect(times(w.state('Ticker'))).toEqual([2, 4]);

    w.runner.rebindScene();
    const after = w.inst('Ticker');
    expect(after).not.toBe(before);
    expect(after.adapter!.mode).toBe('des');
    expect(w.plugin.desBound).toBe(true);
    await w.runTo(6);
    // A rebind restarts the run like reset(): fresh script state, DES-exact timers.
    expect(times(w.state('Ticker'))).toEqual([2, 4, 6]);
  });
});

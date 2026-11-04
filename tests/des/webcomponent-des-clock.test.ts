// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 §9.1 — a Model-Script (`WebComponent`) runs on the DES event clock
 * in a DES run: `self.every(60, 'tick')` fires exactly 60 times in one
 * FastForward hour, at exact multiples of 60 s, and `self.now` inside the hook
 * IS the DES time. In continuous mode the same script still runs on the frame
 * clock, as before.
 */

import { describe, it, expect } from 'vitest';
import { makeWorld } from './webcomponent-des-fixture';

const TICKER = `
function setup(self) {
  const st = self.persist({ ticks: 0, times: [] });
  self.every(60, 'tick');
  return {
    des: { on(hook) {
      if (hook !== 'tick') return;
      st.ticks++;
      st.times.push(self.now);
    } },
    state() { return st; },
  };
}`;

describe('plan-2212 §9.1 — WebComponent on the DES clock', () => {
  it('counts exactly 60 ticks in a FastForward hour, self.now is the DES time', async () => {
    const w = await makeWorld({ scripts: [{ name: 'Ticker', code: TICKER }] });
    expect(w.inst('Ticker').adapter!.mode).toBe('continuous');
    w.start();
    const adapter = w.inst('Ticker').adapter!;
    expect(adapter.mode).toBe('des');
    await w.runTo(3600);
    const st = w.state('Ticker') as { ticks: number; times: number[] };
    expect(st.ticks).toBe(60);
    expect(st.times).toEqual(Array.from({ length: 60 }, (_, i) => 60 * (i + 1)));
    expect(adapter.now).toBe(w.manager.currentTime);
  });

  it('keeps running on the frame clock in continuous mode', async () => {
    const w = await makeWorld({ scripts: [{ name: 'Ticker', code: TICKER }] });
    w.tickContinuous(125);
    const st = w.state('Ticker') as { ticks: number; times: number[] };
    expect(w.inst('Ticker').adapter!.mode).toBe('continuous');
    expect(st.ticks).toBe(2);
    // Frame clock: a timer fires at the end of the frame that crosses it (up to
    // one frame late), and `every` re-arms from there — the lag adds up per tick.
    // This drift is exactly what the DES clock above does not have.
    for (const [i, t] of st.times.entries()) {
      expect(t).toBeGreaterThanOrEqual(60 * (i + 1) - 1e-9);
      expect(t).toBeLessThan(60 * (i + 1) + (i + 1) / 60 + 1e-9);
    }
    // No DES time advanced: the frame clock is the script's only clock here.
    expect(w.manager.currentTime).toBe(0);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 review #4 — a Model-Script's state statistics (`self.statState`,
 * `viewer.statisticsManager`) run on the script instance's OWN clock. A mode
 * switch rebuilds the scripts BEFORE the kernel commits the new mode, so the
 * viewer's sim time still belongs to the outgoing mode then (continuous
 * t = 125 → DES t = 0, DES t = 50 → continuous): a statistics object started
 * on that clock books negative durations. Both switches after time advanced.
 */

import { describe, it, expect } from 'vitest';
import { makeWorld } from './webcomponent-des-fixture';
import type { StateStatsSnapshot } from '../../src/core/material-flow/rv-state-statistics';

const TOGGLER = `
function setup(self) {
  const st = self.persist({ busy: false });
  self.statState('Idle');
  self.every(1, 'flip');
  return {
    des: { on(hook) {
      if (hook !== 'flip') return;
      st.busy = !st.busy;
      self.statState(st.busy ? 'Busy' : 'Idle');
    } },
  };
}`;

function stats(w: Awaited<ReturnType<typeof makeWorld>>): StateStatsSnapshot {
  const s = w.viewer.statisticsManager.get('Scripts/Toggler');
  expect(s, 'script statistics registered').toBeTruthy();
  return s!.getSnapshot();
}

function expectSane(snap: StateStatsSnapshot, total: number, tol: number): void {
  expect(snap.totalTime).toBeGreaterThan(total - tol);
  expect(snap.totalTime).toBeLessThan(total + tol);
  let sum = 0;
  for (const [name, entry] of Object.entries(snap.states)) {
    expect(entry.duration, `duration of ${name}`).toBeGreaterThanOrEqual(0);
    sum += entry.duration;
  }
  expect(sum).toBeCloseTo(snap.totalTime, 6);
}

describe('plan-2212 review #4 — script statistics on the instance clock', () => {
  it('continuous → DES → continuous after time advanced: no negative durations, totals per mode', async () => {
    const w = await makeWorld({ scripts: [{ name: 'Toggler', code: TOGGLER }], flow: true });
    w.tickContinuous(125);
    expectSane(stats(w), 125, 0.1);

    w.start();                 // rebuild while the viewer clock still reads continuous 125 s
    await w.runTo(50);
    const des = stats(w);
    expectSane(des, 50, 1e-9);
    expect(des.states.Busy.duration).toBeCloseTo(25, 9);

    w.switchToContinuous();    // rebuild while the viewer clock still reads DES 50 s
    w.tickContinuous(30);
    expectSane(stats(w), 30, 0.1);
  });
});

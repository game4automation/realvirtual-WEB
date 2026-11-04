// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.9 — authoring rule "split zones": the lane stays free while a
 * forklift handles in a stub.
 *
 * A forklift A docks in stub S2 for 300 s, a cart C circles the ring.
 * - Split zones (stub zone K2 + mouth piece in the merge zone M2): during the
 *   whole stay A does NOT hold M2 (0 of the dock frames), C passes the merge
 *   piece during the stay, no watchdog fires, SAT 0.
 * - Counter-probe, stub zone = merge zone (the stub lies in M2): A holds M2 in
 *   EVERY dock frame — the lane is blocked for the whole stay, C never passes.
 * Preconditions (the stay really happened, frames were observed) are asserted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { clearShared } from '../helpers/agv-harness';
import {
  stubLayout, makeStubWorld, forkCfg, carCfg, FORK, FORK_MESH, CAR, delay, frameOverlap, type Mode,
} from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true)); // restore the default

const HOLD_SEC = 300;

interface Split {
  dockArrive: number; dockRelease: number; done: boolean;
  holdFrames: number; mergeHeldByDocked: number;
  cPasses: number; overlapFrames: number; watchdog: number; violations: number;
}

function run(mode: Mode, split: boolean): Split {
  stubLayout({ split });
  const w = makeStubWorld(mode, [
    { name: 'A', cfg: forkCfg('L0', 5000), mesh: FORK_MESH, body: FORK },
    { name: 'C', cfg: carCfg('R2', 20000), body: CAR },
  ], 600);
  const zones = getDefaultZoneRegistry();
  const fleet = getDefaultAgvFleet();
  const r: Split = {
    dockArrive: -1, dockRelease: -1, done: false, holdFrames: 0, mergeHeldByDocked: 0,
    cPasses: 0, overlapFrames: 0, watchdog: 0, violations: 0,
  };
  const inHold = (): boolean => r.dockArrive >= 0 && r.dockRelease < 0;
  getDefaultPathNetwork().setRouter({
    onArrive: (pathId, id) => { if (id === 'C' && pathId === 'Turn2' && inHold()) r.cPasses++; },
  }, 'agv-reverse-split-zones');
  getDefaultPathDockRegistry().register('S2', {
    onVehicleArrive: (_id, release) => {
      r.dockArrive = w.now();
      delay(HOLD_SEC, () => { r.dockRelease = w.now(); release(); });
    },
  });
  fleet.get('A')!.assign({ destination: 'S2', approach: 'reverse', onServiceEnd: () => { r.done = true; fleet.get('A')!.clear(); } });
  while (!w.done() && !r.done) {
    w.step();
    if (inHold()) { r.holdFrames++; if (zones.isHolder('M2', 'A')) r.mergeHeldByDocked++; }
    if (frameOverlap(w).hit) r.overlapFrames++;
  }
  r.watchdog = w.mb.stats.watchdogFires;
  r.violations = w.mb.stats.violations;
  w.dispose();
  return r;
}

describe('plan-595 9.9 — split zones keep the lane free during a dock stay', () => {
  for (const mode of ['animated', 'continuous'] as Mode[]) {
    it(`${mode}: split zones — the merge zone is free in every dock frame, the cart passes`, () => {
      const r = run(mode, true);
      expect(r.dockArrive).toBeGreaterThan(0);                       // preconditions: the stay happened …
      expect(r.dockRelease - r.dockArrive).toBeCloseTo(HOLD_SEC, 1);
      expect(r.holdFrames).toBeGreaterThan(0);                       // … and was observed
      expect(r.done).toBe(true);
      expect(r.mergeHeldByDocked).toBe(0);
      expect(r.cPasses).toBeGreaterThan(0);
      expect(r.overlapFrames).toBe(0);
      expect(r.watchdog).toBe(0);
      expect(r.violations).toBe(0);
    }, 300000);

    it(`${mode}: counter-probe stub zone = merge zone — the lane is blocked in every dock frame`, () => {
      const r = run(mode, false);
      expect(r.dockArrive).toBeGreaterThan(0);
      expect(r.holdFrames).toBeGreaterThan(0);
      expect(r.mergeHeldByDocked).toBe(r.holdFrames);
      expect(r.cPasses).toBe(0);
      expect(r.overlapFrames).toBe(0);
      expect(r.violations).toBe(0);
    }, 300000);
  }
});

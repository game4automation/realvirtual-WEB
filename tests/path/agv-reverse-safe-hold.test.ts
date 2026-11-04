// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.10 (Spike C) — a forced safe hold around the direction changes,
 * with followers.
 *
 * The safe hold (re-plan cap hit) does not run `planZones`; Spike C showed it
 * needs no zone stop of its own (`stopX = max(s, xStop − off)` can only shorten
 * the previous plan's authority). Here: a forklift works reverse tasks to S2
 * and S3 while two carts follow it around the ring; the re-plan cap is 1, so
 * crowded instants go through the safe-hold path. Asserted: safe holds really
 * happened (non-empty), at least two plans follow EVERY direction change of the
 * forklift (a 1 s stop 2 s after every change forces the second one — forward,
 * the 30 m horizon would otherwise need no re-plan for 10 s), all tasks
 * are done, the SAT oracle sees no overlap, no watchdog fires.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { clearShared } from '../helpers/agv-harness';
import {
  stubLayout, makeStubWorld, forkCfg, carCfg, FORK, FORK_MESH, CAR, delay, frameOverlap, type Mode,
} from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true)); // restore the default

const CHAIN = ['S2', 'S3'];

/**
 * Upper bound of safe holds per vehicle and BEGUN sim minute (plan-595 wake-up guard).
 * Counted per begun minute (limit = 120 · ⌈t / 60 s⌉) so the initial back-off burst
 * of a short run is not inflated by normalising it to a minute.
 * Analytic worst case of the wake-up back-off for a vehicle that stays standing
 * in an unchanged safe hold for a whole minute: 1, 2, 4 … 512 ms (10 wakes in
 * ~1 s), then one per second (60) = 70 wake-ups, each at most one safe hold;
 * the margin to 120 covers holds triggered by the events of other vehicles. A
 * wake-up loop without the back-off (one per millisecond) would be ~60 000.
 *
 * SCOPE: calibrated for operation WITH a cap (replanCap >= 1, as in this test)
 * and the small cap-0 stand of the cap test in agv-movement-authority. It does
 * NOT apply to cap 0 on a full fleet / the constructed FastForward path of
 * agv-forward-hold-parity: there ~477 safe holds per vehicle and minute from
 * `soft-recheck` re-plans are normal — do not carry this bound over unchecked.
 *
 * WHICH TEST CATCHES WHICH FAULT: a missing wake-up (standstill) is caught by
 * 9.10 Animated (tasks not done) — NOT by this guard, a standstill produces
 * FEWER safe holds. A missing back-off (wake-up flood) is caught by the cap test
 * plus this guard (mutation: 25 045 per minute). In 9.10 the guard is practically
 * toothless: its safe holds fall only on the timer vehicle.
 */
const MAX_SAFE_HOLDS_PER_VEHICLE_MIN = 120; // measured 2026-10-17 after the fix: max 37 (cap test), 9 here


describe('plan-595 9.10 — forced safe hold around the direction changes (Spike C)', () => {
  for (const mode of ['animated', 'continuous'] as Mode[]) {
    it(`${mode}: replanCap = 1 with followers — safe holds, ≥ 2 plans after every change, SAT 0, all tasks done`, () => {
      stubLayout({ split: false }); // the Spike C layout (stub inside the merge zone)
      const w = makeStubWorld(mode, [
        { name: 'F', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, body: FORK },
        { name: 'B', cfg: carCfg('R2', 33000), body: CAR },
        { name: 'C', cfg: carCfg('L2', 500, { TargetSpeed: 900 }), body: CAR },
      ], 900);
      const fleet = getDefaultAgvFleet();
      for (const sid of CHAIN) getDefaultPathDockRegistry().register(sid, { onVehicleArrive: (_id, release) => delay(4, release) });
      const done: string[] = [];
      let k = 0;
      const next = (): void => {
        if (k >= CHAIN.length) { fleet.get('F')!.clear(); return; }
        const stub = CHAIN[k++];
        fleet.get('F')!.assign({ destination: stub, approach: 'reverse', onServiceEnd: () => { done.push(stub); next(); } });
      };
      next();
      // The DES run start clears the authority (cap included) at its first tick — set the cap after it.
      w.step();
      w.mb.replanCap = 1;
      expect(w.mb.replanCap).toBe(1);
      // Plans after each direction change of F (distinct versions until the next change, 10 s window).
      const changes: { t: number; dir: number; versions: Set<number> }[] = [];
      let lastDir = w.mb.planDirOf('F');
      let overlap = 0;
      while (!w.done() && done.length < CHAIN.length) {
        w.step();
        const now = w.now();
        const dir = w.mb.planDirOf('F');
        if (dir !== lastDir) {
          changes.push({ t: now, dir, versions: new Set() });
          delay(2, () => w.pause('F', 1)); // a 1 s stop 2 s after EVERY change forces a second plan
          lastDir = dir;
        }
        const c = changes[changes.length - 1];
        if (c && now - c.t <= 10) c.versions.add(w.mb.versionOf('F'));
        if (frameOverlap(w).hit) overlap++;
      }
      // Keep observing the window of the LAST direction change (it happens at the final service end).
      const tLast = w.now();
      while (!w.done() && w.now() - tLast <= 10) {
        w.step();
        const c = changes[changes.length - 1];
        if (c && w.now() - c.t <= 10) c.versions.add(w.mb.versionOf('F'));
        if (frameOverlap(w).hit) overlap++;
      }
      const stats = w.mb.stats;
      const minutes = Math.max(1, Math.ceil(w.now() / 60));
      const perVehicle = Object.fromEntries(Object.entries(stats.safeHoldsBy).map(([id, n]) => [id, n / minutes]));
      console.log(`[agv-safe-hold] ${mode} safe holds per vehicle and begun sim minute (${minutes} min): ${JSON.stringify(perVehicle)} wakes=${stats.wakes}`);
      w.dispose();
      expect(done).toEqual(CHAIN);
      expect(stats.holdsBy.safe ?? 0).toBeGreaterThan(0);      // the safe-hold path really ran
      for (const [id, rate] of Object.entries(perVehicle)) expect(rate, id).toBeLessThanOrEqual(MAX_SAFE_HOLDS_PER_VEHICLE_MIN);
      expect(changes.length).toBeGreaterThanOrEqual(2 * CHAIN.length); // −1 and +1 per stub
      for (const c of changes) expect(c.versions.size, `change to ${c.dir} at ${c.t.toFixed(2)}`).toBeGreaterThanOrEqual(2);
      expect(overlap).toBe(0);
      expect(stats.watchdogFires).toBe(0);
      expect(stats.violations).toBe(0);
    }, 300000);
  }
});

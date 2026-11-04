// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 R3-5 — forward HOLD parity, CONSTRUCTED scenario.
 *
 * The AGVFactory reference of agv-reverse-legacy-parity (9.6) produces NO hold
 * plans at all (measured before R3-5: `holdsBy = {}`, `safeHolds = 0` in DES and
 * continuous) — it cannot see a change of the hold paths. This test forces both
 * forward hold kinds on the same factory fleet (forward only, no reverse):
 * - `safe`: DES FastForward, the re-plan cap set to 0 at the first piece arrival
 *   — from then on every re-plan is a safe hold and the fleet brakes to a stand
 *   through the safe-hold path, S-curves included (`replanCap = 1` alone
 *   produces none here — no factory vehicle re-plans twice in one instant; a
 *   time window cannot be closed by a timer vehicle: with the cap at 0 it is
 *   capped as well. Since the plan-595 wake-up fix the capped fleet gets
 *   wake-up re-plans with a back-off and keeps standing in safe holds);
 * - `stopped`: continuous 120 s, every vehicle switched Run off for 1.5 s while
 *   driving, staggered every 7 s.
 * The fingerprint carries the hold counts PER REASON (a shift between reasons
 * with an equal sum is a behaviour change too) and is compared against a
 * reference produced BEFORE the R3-5 change. Non-emptiness of each forced hold
 * kind is asserted — a parity of two empty sets would prove nothing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { iterateFixedUpdate } from '../../src/core/behavior-runtime';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { AGV_DEF, TICK, Object3D, makeHost, makeAgvRoot, bindDes, bindContinuous, clearShared } from '../helpers/agv-harness';
import { registerFactory, factoryAgvConfigs, installWorkPlan } from '../fixtures/agv-factory-fixture';

beforeEach(() => clearShared());

/**
 * Reference produced 2026-10-17 16:35 before the R3-5 change (plan-595), twice identical.
 *
 * `safe` is EMPTY on purpose: the old value (`trace=220057:f5f9c52d … holds=safe:200010 … replans=8`)
 * encoded the safe-hold STANDSTILL as the target — a capped fleet that stood still for good. The
 * wake-up fix of plan-595 changes that run by design; a deviation from the old value is the fix,
 * not a regression. TO BE RE-RECORDED after the safe-hold fix: while it is empty the test only
 * prints the new `[agv-hold-parity] SAFE …` line and checks the invariants, not the equality.
 */
const REFERENCE = {
  // Recorded 2026-10-17 18:06 AFTER the safe-hold fix (the old reference encoded the standstill).
  safe: 'trace=252445:f2014d70 poses=eccbc670 holds=safe:228798,stopped:0,frozen:0 replans=8 violations=0 forced=0',
  // Re-recorded 2026-10-19 with plan-632 (#202), twice identical; approved by Thomas. Before 632 every vehicle
  // advanced the shared continuous clock with its own skewed tick, so after 7200 frames it stood at 120.116667 s
  // (7 ticks ahead with 8 vehicles) instead of 120 s, and the vehicles were offset against each other. The run
  // differs only by that defect: holds stopped:16 and violations 0 unchanged; triggers 'run' 52 = 52, the
  // difference is in dependent/field re-plans and one arrival less inside the now exact 120 s.
  // Old value: poses=96f35616 ... replans=254.
  stopped: 'poses=481c2147 holds=safe:0,stopped:16,frozen:0 replans=262 violations=0 forced=0',
};

function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

const holds = (by: Record<string, number>): string => ['safe', 'stopped', 'frozen'].map((k) => `${k}:${by[k] ?? 0}`).join(',');

describe('plan-595 R3-5 — forward hold parity (constructed scenario)', () => {
  it('DES FastForward with replanCap = 0 from the first arrival: safe holds, trace, poses', () => {
    const layout = registerFactory();
    const mb = getDefaultMovementAuthority('des');
    // The run start clears the authority (cap included) and one FastForward tick drains the
    // whole run — so the cap is lowered from inside the run, at the first piece arrival.
    let capT = -1;
    getDefaultPathNetwork().setRouter({
      onArrive: () => {
        if (capT >= 0) return;
        capT = runner.getManager().currentTime;
        mb.replanCap = 0; // from here EVERY re-plan is a safe hold (the fleet brakes to a stand, curves included)
      },
    }, 'agv-hold-parity');
    mb.trace = [];
    const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: 3600 });
    const host = makeHost();
    const roots = factoryAgvConfigs(layout, 8).map(([n, c]) => makeAgvRoot(n, c));
    roots.forEach((r) => bindDes(runner, r, host, AGV_DEF));
    runner.start([AGV_DEF], { root: new Object3D() });
    installWorkPlan().dispatch();
    const mgr = runner.getManager();
    for (let i = 0; i < 1_000_000 && !mgr.isComplete; i++) { runner.tick(TICK); runner.lateTick(TICK); }
    const complete = mgr.isComplete;
    let h = 0x811c9dc5;
    for (const e of mb.trace) h = fnv(`${e.t.toFixed(12)}|${e.kind}|${e.id};`, h);
    const poses = [...roots].sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((r) => `${r.name}:${r.position.x.toFixed(9)},${r.position.z.toFixed(9)}`).join(' ');
    const st = mb.stats;
    const fp = `trace=${mb.trace.length}:${h.toString(16)} poses=${fnv(poses).toString(16)} holds=${holds(st.holdsBy)} `
      + `replans=${st.replans} violations=${st.violations} forced=${st.forced}`;
    if (fp !== REFERENCE.safe) console.log(`[agv-hold-parity] SAFE ${fp}`);
    mb.trace = null;
    runner.dispose();
    expect(complete).toBe(true);
    expect(capT).toBeGreaterThan(0);
    expect(st.holdsBy.safe ?? 0).toBeGreaterThan(0); // the constructed scenario really produces safe holds
    expect(st.violations).toBe(0);
    // Equality only once the post-fix reference is recorded (see REFERENCE above).
    if (REFERENCE.safe) expect(fp).toBe(REFERENCE.safe);
    else console.log('[agv-hold-parity] SAFE reference not recorded yet — copy the line above into REFERENCE.safe');
  }, 300000);

  it('continuous 120 s with staggered Run-off stops: stopped holds, pose sequence', () => {
    const layout = registerFactory();
    const host = makeHost();
    const roots = factoryAgvConfigs(layout, 8).map(([n, c]) => makeAgvRoot(n, c));
    const handles = roots.map((r) => bindContinuous(r, host));
    installWorkPlan().dispatch();
    const mb = getDefaultMovementAuthority('continuous');
    let h = 0x811c9dc5;
    for (let f = 0; f < 120 * 60; f++) {
      // Every 7 s the next vehicle stops for 1.5 s (Run off while driving → a brake-to-stop hold).
      const k = Math.floor(f / (7 * 60)) % roots.length;
      const inStop = f % (7 * 60) < 1.5 * 60 && f >= 7 * 60;
      for (let i = 0; i < roots.length; i++) host.signalStore!.set(`${roots[i].name}.Agv.Run`, !(inStop && i === k));
      for (const hd of handles) iterateFixedUpdate(hd, TICK);
      if (f % 6 === 0) for (const r of roots) h = fnv(`${r.position.x.toFixed(9)},${r.position.z.toFixed(9)};`, h);
    }
    const st = mb.stats;
    const fp = `poses=${h.toString(16)} holds=${holds(st.holdsBy)} replans=${st.replans} violations=${st.violations} forced=${st.forced}`;
    if (fp !== REFERENCE.stopped) console.log(`[agv-hold-parity] STOPPED ${fp}`);
    expect(st.holdsBy.stopped ?? 0).toBeGreaterThan(0); // Run-off holds really happened
    expect(st.violations).toBe(0);
    expect(fp).toBe(REFERENCE.stopped);
  }, 300000);
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.6 (F10) — a forward-only fleet is bit-identical to the engine
 * BEFORE the travel direction existed.
 *
 * AGVFactory (8 AGVs, work plan, project router, scanner fields) is fingerprinted
 * in DES FastForward (full event trace, end poses, planner statistics) and in the
 * continuous kernel (pose sequence every 6th frame). `REFERENCE` was produced on
 * main (WebViewer @59ab9dd0, engine files identical to @225930ac) BEFORE the first
 * engine change of plan-595 and is checked in — the test COMPARES, it does not
 * only log. A deliberate change of forward behaviour must regenerate the reference
 * on purpose (a mismatch prints the actual `[agv-parity]` line).
 *
 * Note (plan-595 Gate finding 12): this test covers `dir = +1` only — it cannot
 * detect a direction-dependent site that was skipped; the mirrored-frame and
 * curve-mirror tests cover `dir = -1`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { iterateFixedUpdate } from '../../src/core/behavior-runtime';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { AGV_DEF, TICK, Object3D, makeHost, makeAgvRoot, bindDes, bindContinuous, clearShared } from '../helpers/agv-harness';
import { registerFactory, factoryAgvConfigs, installWorkPlan } from '../fixtures/agv-factory-fixture';

beforeEach(() => clearShared());

/** Reference fingerprint of main, produced 2026-10-17 14:07 before the first plan-595 engine change. */
const REFERENCE = {
  des: 'trace=29980:d37b6018 poses=ec688ffc replans=7358 changed=5517 violations=0 minMargin=0.002075334 '
    + 'bisections=4984 fieldEvents=1767',
  // Re-recorded 2026-10-19 with plan-632 (#202, one tick time per frame), twice identical. Only the pose
  // hash moves: before 632 vehicle i was drawn at (n+i)*dt, so the sampled root poses carried the clock-join
  // skew; every planner counter is unchanged. Old value: poses=a9102e8a (same counters).
  continuous: 'poses=ccb65d8b replans=228 changed=182 violations=0 minMargin=Infinity bisections=186 fieldEvents=79',
};

function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

describe('plan-595 F10 — forward fleet bit-identical to main', () => {
  it('DES FastForward 2 h: event trace, end poses and planner statistics', () => {
    const layout = registerFactory();
    getDefaultPathNetwork().setRouter({ onArrive: () => { /* subscriber */ } }, 'agv-parity');
    const mb = getDefaultMovementAuthority('des');
    mb.trace = [];
    const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: 7200 });
    const host = makeHost();
    const roots = factoryAgvConfigs(layout, 8).map(([n, c]) => makeAgvRoot(n, c));
    roots.forEach((r) => bindDes(runner, r, host, AGV_DEF));
    runner.start([AGV_DEF], { root: new Object3D() });
    installWorkPlan().dispatch();
    const mgr = runner.getManager();
    // Bounded by ticks, not by wall clock: the fingerprint must not depend on machine load.
    for (let i = 0; i < 1_000_000 && !mgr.isComplete; i++) { runner.tick(TICK); runner.lateTick(TICK); }
    const complete = mgr.isComplete;
    let h = 0x811c9dc5;
    for (const e of mb.trace) h = fnv(`${e.t.toFixed(12)}|${e.kind}|${e.id};`, h);
    const poses = [...roots].sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((r) => `${r.name}:${r.position.x.toFixed(9)},${r.position.z.toFixed(9)}`).join(' ');
    const st = mb.stats;
    const fp = `trace=${mb.trace.length}:${h.toString(16)} poses=${fnv(poses).toString(16)} replans=${st.replans} `
      + `changed=${st.replansChanged} violations=${st.violations} minMargin=${st.minMargin.toFixed(9)} `
      + `bisections=${st.bisections} fieldEvents=${st.fieldEvents}`;
    if (fp !== REFERENCE.des) console.log(`[agv-parity] DES ${fp}`);
    mb.trace = null;
    runner.dispose();
    expect(complete).toBe(true);
    expect(st.violations).toBe(0);
    expect(fp).toBe(REFERENCE.des);
  }, 300000);

  it('continuous 120 s: pose sequence', () => {
    const layout = registerFactory();
    const host = makeHost();
    const roots = factoryAgvConfigs(layout, 8).map(([n, c]) => makeAgvRoot(n, c));
    const handles = roots.map((r) => bindContinuous(r, host));
    installWorkPlan().dispatch();
    let h = 0x811c9dc5;
    for (let f = 0; f < 120 * 60; f++) {
      for (const hd of handles) iterateFixedUpdate(hd, TICK);
      if (f % 6 === 0) for (const r of roots) h = fnv(`${r.position.x.toFixed(9)},${r.position.z.toFixed(9)};`, h);
    }
    const st = getDefaultMovementAuthority('continuous').stats;
    const fp = `poses=${h.toString(16)} replans=${st.replans} changed=${st.replansChanged} violations=${st.violations} `
      + `minMargin=${st.minMargin.toFixed(9)} bisections=${st.bisections} fieldEvents=${st.fieldEvents}`;
    if (fp !== REFERENCE.continuous) console.log(`[agv-parity] CONT ${fp}`);
    expect(st.violations).toBe(0);
    expect(fp).toBe(REFERENCE.continuous);
  }, 300000);
});

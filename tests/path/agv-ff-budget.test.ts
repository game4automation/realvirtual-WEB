// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 §9.8 / plan-623 — FastForward event budget, counter fingerprint and
 * determinism (AGVFactory, 8 AGVs, 1 simulated day).
 *
 * The simulation is deterministic, so this test checks RESULTS, never the wall
 * clock (plan-623 F1: the former median wall-time ratio against the plan-903
 * original model fell by machine load, not by code). The new moving-block model
 * runs with its full feature set: scanner fields on (schema default),
 * statistics transitions as events, and a project router installed so every
 * piece end is announced (notify events).
 *
 * - Budget test: one run; exact counter fingerprint against `REFERENCE.counters`
 *   plus the counter budgets (events per AGV-hour, re-plans per instant).
 * - Determinism test: full EVENT TRACE (time, kind, vehicle of every
 *   planner-visible event), end poses and fingerprint of two runs and of a run
 *   with REVERSED bind order; the trace hash is also compared to `REFERENCE.trace`.
 *
 * Adopting an INTENDED change of the movement model (plan-623 §2.3):
 * 1. The test fails and prints `[agv-ff] FINGERPRINT <actual>` (and
 *    `[agv-ff] TRACE <actual>`) next to `expected <reference>`.
 * 2. Produce that line twice in a row (two separate runs of this file). Both
 *    must be identical — otherwise it is a determinism bug, not a new reference.
 * 3. Replace `REFERENCE`; update its comment with date, commit and the plan that
 *    caused the change, and justify the diff in the commit message (which number
 *    changed and why).
 * 4. Unintended (no plan changes the movement): it is a regression — do NOT
 *    adopt the new values.
 *
 * The run loop has no wall-clock limit. It stops at `mgr.isComplete` or at one of
 * two load-independent emergency brakes (plan-623 F7): a stall (K consecutive
 * ticks without a processed event while the manager is incomplete) or an event
 * budget (`EVENT_BUDGET_FACTOR × REFERENCE.events`). A vitest timeout cannot
 * interrupt the synchronous loop, so these brakes are the only bound. Every
 * progressing tick processes ≥ 1 event, so the event budget also bounds the
 * number of ticks; no tick limit is derived from measured tick counts (a
 * FastForward tick works up to a 12 ms wall-clock slice, tick counts are NOT
 * deterministic).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getDefaultMovementAuthority, type MbStats } from '../../src/core/engine/rv-movement-authority';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { DESRunner } from '@rv/plugins/des/des-runner';
import {
  AGV_DEF, TICK, Object3D, makeHost, makeAgvRoot, bindDes, clearShared,
} from '../helpers/agv-harness';
import { registerFactory, factoryAgvConfigs, installWorkPlan } from '../fixtures/agv-factory-fixture';

const DAY = 86400;
const N_AGV = 8;

/**
 * Reference fingerprint, measured 2026-10-18 (plan-623 Phase 1) on WebViewer
 * 873a2189 / Private 6117bbb with `npm test -- tests/path/agv-ff-budget.test.ts`:
 * 4 runs (budget, determinism a/b/reversed) identical. Identical to the
 * measurement of 2026-10-17 on main 1645796f (events/jobs/replans/changed/
 * bisections/fieldEvents and trace, `<WS>/rv-tmp/ffdet-2..5.log`); no commit in
 * `1645796f..873a2189 -- src/core/engine src/behaviors/Agv.ts` and none in the
 * Private DES plugin since then changed the model.
 */
const REFERENCE = {
  events: 358097,
  counters: 'events=358097 jobs=3486 replans=86939 changed=64701 bisections=58174 fieldEvents=20161'
    + ' violations=0 forced=0 watchdog=0 poses=8716ad6f',
  trace: '358105:407ce0cf',
};

/** Emergency brake (a): consecutive ticks without a processed event (manager incomplete). */
const STALL_TICKS = 3;
/** Emergency brake (b): abort when more than this multiple of the reference events is processed. */
const EVENT_BUDGET_FACTOR = 4;

const log = (...a: unknown[]): void => { console.log('[agv-ff]', ...a); };

beforeEach(() => clearShared());

interface FfResult {
  events: number;
  simSec: number;
  complete: boolean;
  jobs: number;
  stats: MbStats;
  traceHash: string;
  poses: string;
}

function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/**
 * FNV-1a over the trace (allocation-light determinism fingerprint). Events of
 * the SAME instant are put in canonical (kind, vehicle) order first: the DES
 * queue dispatches same-time events FIFO, so the bind order may permute them
 * without changing the simulation — a reordering ACROSS instants, a missing
 * or an extra event changes the hash.
 */
function hashTrace(trace: readonly { t: number; kind: string; id: string }[]): string {
  const sorted = [...trace].sort((a, b) => a.t - b.t
    || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let h = 0x811c9dc5;
  for (const e of sorted) { h = fnv(e.t.toFixed(9), h); h = fnv(e.kind, h); h = fnv(e.id, h); }
  return `${trace.length}:${h.toString(16)}`;
}

/** Counter fingerprint (plan-623 F2) — counters only, no wall-clock field (`flushMs` stays out). */
function fingerprint(r: FfResult): string {
  const s = r.stats;
  return `events=${r.events} jobs=${r.jobs} replans=${s.replans} changed=${s.replansChanged}`
    + ` bisections=${s.bisections} fieldEvents=${s.fieldEvents} violations=${s.violations}`
    + ` forced=${s.forced} watchdog=${s.watchdogFires} poses=${fnv(r.poses).toString(16)}`;
}

function ff(opts: { reverse?: boolean; trace?: boolean } = {}): FfResult {
  clearShared();
  const layout = registerFactory();
  // Full feature configuration: a project router that subscribes to every arrival.
  getDefaultPathNetwork().setRouter({ onArrive: () => { /* subscriber only */ } }, 'agv-ff-test');
  const mb = getDefaultMovementAuthority('des');
  mb.trace = opts.trace ? [] : null;
  const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: DAY });
  try {
    const host = makeHost();
    let cfgs = factoryAgvConfigs(layout, N_AGV);
    if (opts.reverse) cfgs = [...cfgs].reverse();
    const roots = cfgs.map(([n, c]) => makeAgvRoot(n, c));
    roots.forEach((r) => bindDes(runner, r, host, AGV_DEF));
    runner.start([AGV_DEF], { root: new Object3D() });
    const wp = installWorkPlan();
    wp.dispatch();
    const mgr = runner.getManager();
    const eventLimit = EVENT_BUDGET_FACTOR * REFERENCE.events;
    let idle = 0;
    while (!mgr.isComplete) {
      const before = mgr.totalEventsProcessed;
      runner.tick(TICK);
      runner.lateTick(TICK);
      const after = mgr.totalEventsProcessed;
      if (after > eventLimit) {
        throw new Error(`[agv-ff] event budget exceeded: ${after} events > ${eventLimit}`
          + ` (${EVENT_BUDGET_FACTOR} × REFERENCE.events) at t=${mgr.currentTime.toFixed(3)} s`);
      }
      if (after === before && !mgr.isComplete) {
        if (++idle >= STALL_TICKS) {
          throw new Error(`[agv-ff] stall: ${STALL_TICKS} ticks without a processed event,`
            + ` manager incomplete at t=${mgr.currentTime.toFixed(3)} s, ${after} events`);
        }
      } else {
        idle = 0;
      }
    }
    const jobs = [...wp.stats.jobsDone.values()].reduce((a, b) => a + b, 0);
    const sorted = [...roots].sort((a, b) => (a.name < b.name ? -1 : 1));
    return {
      events: mgr.totalEventsProcessed, simSec: mgr.currentTime, complete: mgr.isComplete, jobs,
      stats: JSON.parse(JSON.stringify(mb.stats)) as MbStats,
      traceHash: mb.trace ? hashTrace(mb.trace) : '',
      poses: sorted.map((r) => `${r.name}:${r.position.x.toFixed(6)},${r.position.z.toFixed(6)}`).join(' '),
    };
  } finally {
    mb.trace = null;
    runner.dispose();
  }
}

/** Prints the actual line BEFORE the assertion (plan-623 F4) so an intended change can be adopted. */
function expectFingerprint(r: FfResult, label: string): void {
  const fp = fingerprint(r);
  if (fp !== REFERENCE.counters) log(`FINGERPRINT ${fp}  (${label}; expected ${REFERENCE.counters})`);
  expect(fp).toBe(REFERENCE.counters);
}

describe('AGV FastForward budget (plan-558 §9.8, plan-623)', () => {
  it('exact counter fingerprint; event + re-plan budget (1 simulated day, no wall clock)', () => {
    const n = ff();
    const s = n.stats;
    const agvHours = N_AGV * n.simSec / 3600;
    // The router's arrival notifications exist only because this run installs
    // a project router. The event budget compares the movement model itself;
    // the notifications are reported separately.
    const notify = s.events['Replan:notify'] ?? 0;
    const modelEvPerAgvH = (n.events - notify) / agvHours;
    log(`events/AGV-h=${(n.events / agvHours).toFixed(1)} (model ${modelEvPerAgvH.toFixed(1)},`
      + ` router notify ${(notify / agvHours).toFixed(1)}) maxAtInstantAfterStart=${s.maxReplansAtInstantAfterStart}`
      + ` capHitsAfterStart=${s.cascadeCapHitsAfterStart} dirtyBy=${JSON.stringify(s.dirtyBy)}`
      + ` events=${JSON.stringify(s.events)}`);
    expect(n.complete).toBe(true);
    expect(n.simSec).toBeGreaterThan(DAY - 1);
    expect(s.violations).toBe(0);
    expect(s.forced).toBe(0);
    expect(s.watchdogFires).toBe(0);
    expect(notify).toBeGreaterThan(0); // notify events active
    expect(s.events['Replan:field'] ?? 0).toBeGreaterThan(0); // scanner fields active
    expect(s.events['Replan:stat'] ?? 0).toBeGreaterThan(0); // statistics transitions active
    expect(modelEvPerAgvH).toBeLessThanOrEqual(1621);
    expect(s.maxReplansAtInstantAfterStart).toBeLessThanOrEqual(6);
    expectFingerprint(n, 'budget');
  }, 600_000);

  it('deterministic: identical event trace, end poses and fingerprint twice and with REVERSED bind order', () => {
    const a = ff({ trace: true });
    const b = ff({ trace: true });
    const c = ff({ trace: true, reverse: true });
    log(`trace a=${a.traceHash} b=${b.traceHash} reversed=${c.traceHash}`);
    if (a.traceHash !== REFERENCE.trace) log(`TRACE ${a.traceHash}  (expected ${REFERENCE.trace})`);
    expect(a.traceHash.length).toBeGreaterThan(4);
    expect(b.traceHash).toBe(a.traceHash);
    expect(c.traceHash).toBe(a.traceHash);
    expect(b.poses).toBe(a.poses);
    expect(c.poses).toBe(a.poses);
    expect(fingerprint(b)).toBe(fingerprint(a));
    expect(fingerprint(c)).toBe(fingerprint(a));
    expect(a.traceHash).toBe(REFERENCE.trace);
    expectFingerprint(a, 'determinism a');
  }, 600_000);
});

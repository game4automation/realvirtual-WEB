// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 §9.8 — FastForward budget, event budget and determinism
 * (AGVFactory, 8 AGVs, 1 simulated day).
 *
 * Methodology (R2-8): the ORIGINAL plan-903 model (tests/path/_reference,
 * segment occupancy) and the NEW moving-block model run in the SAME process;
 * one warm-up pair is discarded, then 5 ALTERNATING original/new runs; the
 * MEDIAN wall-time ratio must stay ≤ 3. The new model runs with its full
 * feature set: scanner fields on (schema default), statistics transitions as
 * events, and a project router installed so every piece end is announced
 * (notify events). Determinism compares the full EVENT TRACE (time, kind,
 * vehicle of every planner-visible event) and the end poses of two runs and
 * of a run with REVERSED bind order.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { getDefaultMovementAuthority, type MbStats } from '../../src/core/engine/rv-movement-authority';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { AgvFlow as AgvOrigFlow } from './_reference/agv-original-903';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import {
  AGV_DEF, TICK, Object3D, makeHost, makeAgvRoot, bindDes, clearShared,
} from '../helpers/agv-harness';
import { registerFactory, factoryAgvConfigs, installWorkPlan } from '../fixtures/agv-factory-fixture';

const ORIG = AgvOrigFlow as unknown as MaterialFlowDefinition;
const DAY = 86400;
const N_AGV = 8;

const log = (...a: unknown[]): void => { console.log('[agv-ff]', ...a); };

beforeEach(() => clearShared());

interface FfResult {
  wallMs: number;
  events: number;
  simSec: number;
  jobs: number;
  stats: MbStats | null;
  traceHash: string;
  poses: string;
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
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  };
  for (const e of sorted) { mix(e.t.toFixed(9)); mix(e.kind); mix(e.id); }
  return `${trace.length}:${h.toString(16)}`;
}

function ff(def: MaterialFlowDefinition, opts: { reverse?: boolean; trace?: boolean } = {}): FfResult {
  clearShared();
  const layout = registerFactory();
  const isNew = def !== ORIG;
  // Full feature configuration: a project router that subscribes to every arrival.
  if (isNew) getDefaultPathNetwork().setRouter({ onArrive: () => { /* subscriber only */ } }, 'agv-ff-test');
  const mb = getDefaultMovementAuthority('des');
  mb.trace = opts.trace ? [] : null;
  const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: DAY });
  const host = makeHost();
  let cfgs = factoryAgvConfigs(layout, N_AGV);
  if (opts.reverse) cfgs = [...cfgs].reverse();
  const roots = cfgs.map(([n, c]) => makeAgvRoot(n, c));
  roots.forEach((r) => bindDes(runner, r, host, def));
  runner.start([def], { root: new Object3D() });
  const wp = installWorkPlan();
  wp.dispatch();
  const w0 = performance.now();
  const mgr = runner.getManager();
  while (!mgr.isComplete && performance.now() - w0 < 240000) {
    runner.tick(TICK);
    runner.lateTick(TICK);
  }
  const wallMs = performance.now() - w0;
  const jobs = [...wp.stats.jobsDone.values()].reduce((a, b) => a + b, 0);
  const sorted = [...roots].sort((a, b) => (a.name < b.name ? -1 : 1));
  const out: FfResult = {
    wallMs, events: mgr.totalEventsProcessed, simSec: mgr.currentTime, jobs,
    stats: isNew ? JSON.parse(JSON.stringify(mb.stats)) as MbStats : null,
    traceHash: mb.trace ? hashTrace(mb.trace) : '',
    poses: sorted.map((r) => `${r.name}:${r.position.x.toFixed(6)},${r.position.z.toFixed(6)}`).join(' '),
  };
  mb.trace = null;
  runner.dispose();
  return out;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

describe('AGV FastForward budget (plan-558 §9.8)', () => {
  it('median wall-time ratio NEW/ORIGINAL ≤ 3 (warm-up discarded, 5 alternating runs); event + re-plan budget', () => {
    ff(ORIG);
    ff(AGV_DEF);
    const ratios: number[] = [];
    let last: FfResult | null = null;
    for (let i = 0; i < 5; i++) {
      const o = ff(ORIG);
      const n = ff(AGV_DEF);
      ratios.push(n.wallMs / o.wallMs);
      log(`run ${i + 1}: ORIG wallMs=${o.wallMs.toFixed(0)} events=${o.events} jobs=${o.jobs}`
        + ` | NEW wallMs=${n.wallMs.toFixed(0)} events=${n.events} jobs=${n.jobs} ratio=${(n.wallMs / o.wallMs).toFixed(2)}`);
      last = n;
    }
    const med = median(ratios);
    const s = last!.stats!;
    const agvHours = N_AGV * last!.simSec / 3600;
    const evPerAgvH = last!.events / agvHours;
    // The router's arrival notifications exist only because this run installs
    // a project router (the original model delivers them inside its per-piece
    // arrival events). The event budget compares the movement model itself;
    // the notifications are reported separately and are part of the wall time.
    const notify = s.events['Replan:notify'] ?? 0;
    const modelEvPerAgvH = (last!.events - notify) / agvHours;
    log(`median ratio=${med.toFixed(2)} ratios=${ratios.map((r) => r.toFixed(2)).join(',')} events/AGV-h=${evPerAgvH.toFixed(1)}`
      + ` (model ${modelEvPerAgvH.toFixed(1)}, router notify ${(notify / agvHours).toFixed(1)})`
      + ` replans=${s.replans} changed=${s.replansChanged} flushMs=${s.flushMs.toFixed(0)} bisections=${s.bisections}`
      + ` maxAtInstantAfterStart=${s.maxReplansAtInstantAfterStart} capHitsAfterStart=${s.cascadeCapHitsAfterStart}`
      + ` violations=${s.violations} forced=${s.forced} watchdog=${s.watchdogFires} fieldEvents=${s.fieldEvents}`
      + ` dirtyBy=${JSON.stringify(s.dirtyBy)} events=${JSON.stringify(s.events)}`);
    expect(last!.simSec).toBeGreaterThan(DAY - 1);
    expect(s.violations).toBe(0);
    expect(s.forced).toBe(0);
    expect(s.watchdogFires).toBe(0);
    expect(notify).toBeGreaterThan(0); // notify events active
    expect(s.events['Replan:field'] ?? 0).toBeGreaterThan(0); // scanner fields active
    expect(s.events['Replan:stat'] ?? 0).toBeGreaterThan(0); // statistics transitions active
    expect(modelEvPerAgvH).toBeLessThanOrEqual(1621);
    expect(s.maxReplansAtInstantAfterStart).toBeLessThanOrEqual(6);
    expect(med).toBeLessThanOrEqual(3);
  }, 600_000);

  it('deterministic: identical event trace + end poses twice and with REVERSED bind order', () => {
    const a = ff(AGV_DEF, { trace: true });
    const b = ff(AGV_DEF, { trace: true });
    const c = ff(AGV_DEF, { trace: true, reverse: true });
    log(`trace a=${a.traceHash} b=${b.traceHash} reversed=${c.traceHash}`);
    expect(a.traceHash.length).toBeGreaterThan(4);
    expect(b.traceHash).toBe(a.traceHash);
    expect(c.traceHash).toBe(a.traceHash);
    expect(b.poses).toBe(a.poses);
    expect(c.poses).toBe(a.poses);
  }, 600_000);
});

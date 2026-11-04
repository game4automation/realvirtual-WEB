// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-629 §9.4 (+ gate R1-1 / R2-1) — the continuous time driver: the trace
 * samples inside `MotionEventClock.advanceTo()` (before every due event and the
 * end horizon, i.e. BEFORE the vehicle's `syncTo`), so the grid depends on the
 * authority time only, not on the fixed tick:
 *
 * - two identical runs → identical counters;
 * - dt = 1/60, 1/30, 1/90 and a coarse 0.49 s tick → identical samples, covers
 *   and counters — with a piece change (no router, so no event at the piece
 *   end) between a grid point and the end of the tick that sampled it, and a
 *   plan replacement at an event right after a grid point (task chained in
 *   `onServiceEnd`);
 * - the hook is a pure observer: the clock's event order is unchanged.
 *
 * Measured at one horizon (`horizonLimit`), in authority time only (plan-629
 * addendum on #202).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { iterateFixedUpdate } from '../../src/core/behavior-runtime';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority, MotionEventClock } from '../../src/core/engine/rv-movement-authority';
import { PathTraceDriver } from '../../src/core/engine/rv-path-trace-sources';
import { makeHost, makeAgvRoot, bindContinuous, clearShared } from '../helpers/agv-harness';

beforeEach(() => clearShared());

/** A straight chain of unequal pieces A → B → … → F (dead end), plus a ring with a zone (R0…R3). */
function layout(): void {
  const net = getDefaultPathNetwork();
  const add = (id: string, from: number[], to: number[], succ: string[], zone?: string): void => {
    net.register(parsePathExtras({
      type: 'Path', version: 1, id, closed: false, align: [0, 1, 0], successors: succ,
      segments: [{ kind: 'line', from, to }], ...(zone ? { zone, zoneCapacity: 1 } : {}),
    }, id)!);
  };
  const xs = [0, 7.3, 13.1, 20, 27.7, 40, 55];
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (let i = 0; i < ids.length; i++) add(ids[i], [xs[i], 0, 0], [xs[i + 1], 0, 0], i + 1 < ids.length ? [ids[i + 1]] : []);
  add('R0', [0, 0, 20], [18.3, 0, 20], ['R1']);
  add('R1', [18.3, 0, 20], [22.1, 0, 20], ['R2'], 'ZR');
  add('R2', [22.1, 0, 20], [22.1, 0, 31], ['R3']);
  add('R3', [22.1, 0, 31], [0, 0, 20], ['R0']);
  net.resolveGraph();
}

interface RunResult { records: string[]; counts: string; samples: number; crossingsInTick: number }

function run(dt: number, horizon: number, vehicles: 'chain' | 'ring'): RunResult {
  clearShared();
  layout();
  const host = makeHost();
  const cfgs: Array<[string, Record<string, unknown>]> = vehicles === 'chain'
    ? [['C1', { PathId: 'A', StartPosition: 1500, TargetSpeed: 1100, VehicleLength: 1200, VehicleWidth: 800 }]]
    : [
        ['K1', { PathId: 'R0', StartPosition: 9000, TargetSpeed: 900, VehicleLength: 1200, VehicleWidth: 800 }],
        ['K2', { PathId: 'R0', StartPosition: 3000, TargetSpeed: 1300, VehicleLength: 1600, VehicleWidth: 800 }],
      ];
  const handles = cfgs.map(([n, c]) => bindContinuous(makeAgvRoot(n, c), host));
  const fleet = getDefaultAgvFleet();
  if (vehicles === 'chain') {
    fleet.get('C1')!.assign({
      destination: 'D', serviceSec: 2.013,
      onServiceEnd: () => fleet.get('C1')!.assign({ destination: 'F', serviceSec: 1000 }),
    });
  } else {
    fleet.get('K1')!.assign({
      destination: 'R1', serviceSec: 6.27,
      onServiceEnd: () => fleet.get('K1')!.clear(),
    });
  }
  const mb = getDefaultMovementAuthority('continuous');
  const driver = new PathTraceDriver();
  driver.rebuild(getDefaultPathNetwork().all());
  driver.attachContinuous(mb);
  driver.horizonLimit = horizon;
  const tr = driver.trace;
  const records: string[] = [];
  const orig = tr.cover.bind(tr);
  let lastSampleT = -1, lastSamplePath = -1;
  tr.cover = (p, a, b, blocked) => {
    records.push(`${tr.sampleTime}|${p}|${a.toFixed(9)}|${b.toFixed(9)}|${blocked ? 1 : 0}`);
    lastSampleT = tr.sampleTime; lastSamplePath = p;
    orig(p, a, b, blocked);
  };
  let crossingsInTick = 0;
  while (mb.clock.now < horizon + 1) {
    const before = mb.clock.now;
    for (const h of handles) iterateFixedUpdate(h, dt);
    driver.tickFixed(dt);
    // A grid point sampled IN this tick on a piece the vehicle has already left by the tick end:
    // the sample ran before syncTo (gate R2-1).
    if (vehicles === 'chain' && lastSampleT > before) {
      const now = tr.indexOfPath(mb.locate('C1', mb.clock.now)!.path);
      if (now !== lastSamplePath) crossingsInTick++;
    }
  }
  driver.detach(); // the clock listener outlives clearShared() — never leak it into the next run
  const counts = (['blocked', 'utilization'] as const)
    .map((v) => (['window', 'start'] as const).map((r) => Array.from(tr.snapshotCounts(v, r)).join(',')).join(';')).join('#');
  return { records, counts, samples: tr.samplesTotal, crossingsInTick };
}

describe('PathTrace continuous driver (plan-629 §9.4, gate R1-1 / R2-1)', () => {
  it('two identical runs give identical counters', () => {
    const a = run(1 / 60, 60, 'ring');
    const b = run(1 / 60, 60, 'ring');
    expect(a.samples).toBe(119);
    expect(b.counts).toBe(a.counts);
    expect(b.records).toEqual(a.records);
  });

  it('the tick split does not matter (1/60, 1/30, 1/90, 0.49 s): one vehicle, piece changes inside a tick, plan replacement', () => {
    const base = run(1 / 60, 80, 'chain');
    expect(base.samples).toBe(159);
    expect(base.records.length).toBe(159);
    for (const dt of [1 / 30, 1 / 90, 0.49]) {
      const r = run(dt, 80, 'chain');
      expect(r.samples).toBe(base.samples);
      expect(r.records).toEqual(base.records);
      expect(r.counts).toBe(base.counts);
      if (dt === 0.49) expect(r.crossingsInTick).toBeGreaterThan(0);
    }
    // Service at D is occupied, not blocked; the plan after onServiceEnd drove on to F.
    expect(base.records.some((s) => s.endsWith('|1'))).toBe(false);
  });

  it('the tick split does not matter with two vehicles, a zone and a service stop', () => {
    const base = run(1 / 60, 90, 'ring');
    for (const dt of [1 / 30, 1 / 90]) {
      const r = run(dt, 90, 'ring');
      expect(r.samples).toBe(base.samples);
      expect(r.counts).toBe(base.counts);
    }
  });
});

describe('MotionEventClock.onBeforeAdvance — pure observer', () => {
  it('fires before each due event and for the end horizon, keeps the order, survives reset, unsubscribes', () => {
    const c = new MotionEventClock();
    const log: string[] = [];
    c.schedule(1, 0, () => log.push('e1'));
    c.schedule(2, 1, () => log.push('e2a'));
    c.schedule(2, 0, () => log.push('e2b'));
    c.schedule(5, 0, () => log.push('e5'));
    const off = c.onBeforeAdvance((t) => log.push(`h${t}@${c.now}`));
    c.advanceTo(3);
    expect(log).toEqual(['h1@0', 'e1', 'h2@1', 'e2a', 'h2@2', 'e2b', 'h3@2']);
    log.length = 0;
    c.advanceTo(2.5); // behind now: end horizon reported as now (never backwards)
    expect(log).toEqual(['h3@3']);
    c.reset();
    log.length = 0;
    c.schedule(0.5, 0, () => log.push('r'));
    c.advanceTo(1);
    expect(log).toEqual(['h0.5@0', 'r', 'h1@0.5']);
    off();
    log.length = 0;
    c.schedule(2, 0, () => log.push('x'));
    c.advanceTo(3);
    expect(log).toEqual(['x']);
  });
});

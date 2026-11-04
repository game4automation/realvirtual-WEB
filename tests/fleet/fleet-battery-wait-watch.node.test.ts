// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-559 §9.2 — battery model (ported from plan-612) and WaitWatch.
 * Node test: no Three, no DOM, no wall clock. Battery parameters are chosen
 * as binary-exact values so every expectation is an exact number.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  canAccept,
  chargeFor,
  chargeTimeSec,
  consume,
  createBatteryModel,
  energyOf,
  minSocFor,
  needsCharge,
  reserveAfterOrder,
  wantsCharge,
  type BatteryConfig,
  type Consumption,
} from '../../src/core/fleet/core/battery';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';
import {
  FLEET_WAIT_TIMEOUT_CODE,
  WaitWatch,
  waitTimeoutProblemId,
  type WaitProblem,
  type WaitProblemSink,
} from '../../src/core/fleet/exec/wait-watch';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';

const CFG: BatteryConfig = {
  startSoc: 100,
  drivePerMin: 0.5,
  liftPerM: 0.25,
  idlePerMin: 0.125,
  chargePerMin: 5,
  threshold: 30,
  target: 80,
  reserveToCharger: 2,
  chargerWaitReserveSec: 300,
};

/** 2 min driving (1.0) + 4 m lift (1.0) + 4 min standing (0.5) = 2.5 %-points. */
const ORDER: Consumption = { driveSec: 120, liftM: 4, idleSec: 240 };

describe('battery model (plan-612 formulas)', () => {
  it('consumption: drive per minute + lift per metre + idle per minute, never below 0', () => {
    expect(energyOf(ORDER, CFG)).toBe(2.5);
    expect(energyOf({ driveSec: -60, liftM: -1, idleSec: -60 }, CFG)).toBe(0);
    expect(consume(10, ORDER, CFG)).toBe(7.5);
    expect(consume(1, ORDER, CFG)).toBe(0);
  });

  it('charging: rate per minute, capped at 100; chargeTimeSec up to target', () => {
    expect(chargeFor(50, 120, CFG)).toBe(60);
    expect(chargeFor(98, 120, CFG)).toBe(100);
    expect(chargeTimeSec(50, CFG)).toBe(360); // (80 − 50) / 5 %/min = 6 min
    expect(chargeTimeSec(90, CFG)).toBe(0);
    expect(needsCharge(29.5, CFG)).toBe(true);
    expect(needsCharge(30, CFG)).toBe(false);
    expect(wantsCharge(79, CFG)).toBe(true);
    expect(wantsCharge(80, CFG)).toBe(false);
  });

  it('reserve after the order = max(way to the charger, reserveToCharger) + charger wait', () => {
    const wait = (300 / 60) * 0.125; // 0.625
    // short way (1 min = 0.5) → the minimal reserve 2 dominates
    expect(reserveAfterOrder({ driveSec: 60, liftM: 0, idleSec: 0 }, CFG)).toBe(2 + wait);
    // long way (10 min = 5) → the way dominates
    expect(reserveAfterOrder({ driveSec: 600, liftM: 0, idleSec: 0 }, CFG)).toBe(5 + wait);
  });

  it('admission includes the way to the charger and the wait reserve; the boundary is admissible', () => {
    const toCharger: Consumption = { driveSec: 600, liftM: 0, idleSec: 0 };
    const min = minSocFor(ORDER, toCharger, CFG);
    expect(min).toBe(2.5 + 5 + 0.625); // 8.125
    expect(canAccept(8.125, ORDER, toCharger, CFG)).toBe(true);
    expect(canAccept(8, ORDER, toCharger, CFG)).toBe(false);
    // a near charger: the reserve 2 holds → 2.5 + 2 + 0.625
    expect(minSocFor(ORDER, { driveSec: 60, liftM: 0, idleSec: 0 }, CFG)).toBe(5.125);
    expect(canAccept(5.125, ORDER, { driveSec: 60, liftM: 0, idleSec: 0 }, CFG)).toBe(true);
    expect(canAccept(5, ORDER, { driveSec: 60, liftM: 0, idleSec: 0 }, CFG)).toBe(false);
  });

  it('the bound model equals the free functions', () => {
    const m = createBatteryModel(CFG);
    const toCharger: Consumption = { driveSec: 600, liftM: 0, idleSec: 0 };
    expect(m.config).toBe(CFG);
    expect(m.energyOf(ORDER)).toBe(energyOf(ORDER, CFG));
    expect(m.consume(10, ORDER)).toBe(consume(10, ORDER, CFG));
    expect(m.chargeFor(50, 120)).toBe(chargeFor(50, 120, CFG));
    expect(m.chargeTimeSec(50)).toBe(chargeTimeSec(50, CFG));
    expect(m.needsCharge(10)).toBe(true);
    expect(m.wantsCharge(90)).toBe(false);
    expect(m.reserveAfterOrder(toCharger)).toBe(reserveAfterOrder(toCharger, CFG));
    expect(m.minSocFor(ORDER, toCharger)).toBe(8.125);
    expect(m.canAccept(8.125, ORDER, toCharger)).toBe(true);
  });
});

/** Recording sink: the test sees every report/clear call. */
function recordingSink(): WaitProblemSink & { reports: WaitProblem[]; clears: string[] } {
  const reports: WaitProblem[] = [];
  const clears: string[] = [];
  return { reports, clears, report: (p) => { reports.push(p); }, clear: (id) => { clears.push(id); } };
}

describe('WaitWatch', () => {
  afterEach(() => clearAllProblems());

  it('one Problems entry when the limit is reached in SIM time, cleared when the wait ends', () => {
    const clock = new ContinuousSimClock();
    const sink = recordingSink();
    const ww = new WaitWatch({ clock, defaultLimitSec: 60, problems: sink });
    ww.begin('v1', 'fork', 10);
    clock.advanceTo(9.5);
    expect(sink.reports).toHaveLength(0);
    expect(ww.currentSec('v1', 'fork')).toBe(9.5);
    clock.advanceTo(10);
    expect(sink.reports).toHaveLength(1);
    expect(sink.reports[0].id).toBe('fleet-wait-timeout:v1:fork');
    expect(sink.reports[0].code).toBe(FLEET_WAIT_TIMEOUT_CODE);
    expect(ww.isOverLimit('v1')).toBe(true);
    clock.advanceTo(30);
    clock.advanceTo(50);
    expect(sink.reports).toHaveLength(1); // exactly one
    ww.end('v1', 'fork');
    expect(sink.clears).toEqual(['fleet-wait-timeout:v1:fork']);
    expect(ww.isOverLimit('v1')).toBe(false);
    const st = ww.stats('fork');
    expect(st).toEqual({ count: 1, active: 0, totalSec: 50, maxSec: 50, timeouts: 1 });
  });

  it('counts waits, keeps the maximum, never reports a wait ended before its limit', () => {
    const clock = new ContinuousSimClock();
    const sink = recordingSink();
    const ww = new WaitWatch({ clock, defaultLimitSec: 60, problems: sink });
    ww.begin('v1', 'target');
    ww.begin('v1', 'target'); // already active: not counted twice
    clock.advanceTo(4);
    ww.end('v1', 'target');
    ww.end('v1', 'target'); // not active: no-op
    expect(clock.pendingCount).toBe(0); // the limit event was cancelled
    clock.advanceTo(10);
    ww.begin('v2', 'target');
    clock.advanceTo(17);
    ww.end('v2', 'target');
    clock.advanceTo(200);
    expect(sink.reports).toHaveLength(0);
    expect(sink.clears).toHaveLength(0);
    expect(ww.stats('target')).toEqual({ count: 2, active: 0, totalSec: 11, maxSec: 7, timeouts: 0 });
    expect(ww.kinds()).toEqual(['target']);
  });

  it('limit: the step limit wins, else the default; per vehicle and kind independently', () => {
    const clock = new ContinuousSimClock();
    const sink = recordingSink();
    const ww = new WaitWatch({ clock, defaultLimitSec: 60, problems: sink });
    ww.begin('v1', 'exit');        // default 60
    ww.begin('v2', 'exit', 20);    // step limit 20
    ww.begin('v3', 'exit', 0);     // 0 = never report
    clock.advanceTo(59);
    expect(sink.reports.map((p) => p.id)).toEqual([waitTimeoutProblemId('v2', 'exit')]);
    clock.advanceTo(60);
    expect(sink.reports.map((p) => p.id)).toEqual([
      waitTimeoutProblemId('v2', 'exit'),
      waitTimeoutProblemId('v1', 'exit'),
    ]);
    clock.advanceTo(1000);
    expect(sink.reports).toHaveLength(2);
    expect(ww.stats('exit').active).toBe(3);
    expect(ww.stats('exit').timeouts).toBe(2);
  });

  it('endAllOf and reset end waits and clear their problems; a stale limit event never fires', () => {
    const clock = new ContinuousSimClock();
    const sink = recordingSink();
    const ww = new WaitWatch({ clock, defaultLimitSec: 5, problems: sink });
    ww.begin('v1', 'fork');
    ww.begin('v1', 'exit');
    clock.advanceTo(5);
    expect(sink.reports).toHaveLength(2);
    ww.endAllOf('v1');
    expect(sink.clears.sort()).toEqual([waitTimeoutProblemId('v1', 'exit'), waitTimeoutProblemId('v1', 'fork')]);
    ww.begin('v2', 'fork');
    ww.reset();
    clock.advanceTo(100);
    expect(sink.reports).toHaveLength(2); // v2 never reported
    expect(ww.kinds()).toEqual([]);
  });

  it('cancelOnEnd false (the executor, plan-559 P5): an ended wait leaves its limit event, which fires as a no-op', () => {
    const clock = new ContinuousSimClock();
    const sink = recordingSink();
    const timeouts: string[] = [];
    const ww = new WaitWatch({
      clock, defaultLimitSec: 10, problems: sink, cancelOnEnd: false,
      onTimeout: (v, kind, limit) => { timeouts.push(`${v}:${kind}:${limit}`); },
    });
    ww.begin('v1', 'fork');
    clock.advanceTo(4);
    ww.end('v1', 'fork');
    expect(clock.pendingCount, 'the event stays queued').toBe(1);
    ww.begin('v1', 'fork');            // a new wait of the same kind: its own event at 4 + 10
    expect(clock.pendingCount).toBe(2);
    clock.advanceTo(10);               // the stale event of the first wait: no report
    expect(sink.reports).toHaveLength(0);
    expect(timeouts).toEqual([]);
    clock.advanceTo(14);
    expect(timeouts).toEqual(['v1:fork:10']);
    expect(ww.isReported('v1', 'fork')).toBe(true);
    expect(ww.isReported('v1', 'exit')).toBe(false);
    ww.end('v1', 'fork');
    expect(ww.isReported('v1', 'fork')).toBe(false);
  });

  it('a timeout hook that ends the wait leaves no Problems entry behind', () => {
    const clock = new ContinuousSimClock();
    const sink = recordingSink();
    const ww: WaitWatch = new WaitWatch({ clock, defaultLimitSec: 5, problems: sink, onTimeout: (v, kind) => ww.end(v, kind) });
    ww.begin('v1', 'fork');
    clock.advanceTo(5);
    expect(sink.reports).toEqual([]);
    expect(ww.isWaiting('v1', 'fork')).toBe(false);
  });

  it('a detail provider adds its line to the Problems entry, read at the timeout', () => {
    const clock = new ContinuousSimClock();
    const sink = recordingSink();
    const ww = new WaitWatch({ clock, defaultLimitSec: 5, problems: sink });
    let actual = 100;
    ww.setResolver({ detail: () => `fork at ${actual} mm`, valid: () => true });
    ww.begin('v1', 'fork', 5, {});
    actual = 340;
    clock.advanceTo(5);
    expect(sink.reports[0].detail).toContain('fork at 340 mm');
  });

  it('default sink writes into the Problems store and removes the entry again', () => {
    clearAllProblems();
    const clock = new ContinuousSimClock();
    const ww = new WaitWatch({ clock, defaultLimitSec: 3 });
    ww.begin('Stapler_1', 'target');
    clock.advanceTo(3);
    const mine = getProblems().filter((p) => p.code === FLEET_WAIT_TIMEOUT_CODE);
    expect(mine.map((p) => p.id)).toEqual(['fleet-wait-timeout:Stapler_1:target']);
    expect(mine[0].severity).toBe('warning');
    ww.end('Stapler_1', 'target');
    expect(getProblems().filter((p) => p.code === FLEET_WAIT_TIMEOUT_CODE)).toHaveLength(0);
  });
});


describe('passive wait limits', () => {
  it('schedules nothing, reports lazily once at the limit and clears on end', () => {
    const clock = new ContinuousSimClock();
    let schedules = 0;
    const schedule = clock.schedule.bind(clock);
    clock.schedule = (...args) => { schedules++; return schedule(...args); };
    const sink = recordingSink();
    const ww = new WaitWatch({ clock, defaultLimitSec: 10, problems: sink });
    let holder = 'old';
    ww.setResolver({ detail: () => ({ order: 'pick A>B (42)', waitingFor: 'drop at B', heldBy: holder }), valid: () => true });
    ww.begin('V', 'target', 10, {}, { passive: true });
    expect(schedules).toBe(0);
    clock.advanceTo(9); ww.poll();
    expect(sink.reports).toHaveLength(0);
    holder = 'MU7';
    clock.advanceTo(10); ww.poll(); ww.poll();
    expect(sink.reports).toHaveLength(1);
    expect(sink.reports[0].detail).toContain('Vehicle: V\nOrder: pick A>B (42)\nWaiting for: drop at B\nHeld by: MU7');
    expect(ww.stats('target').timeouts).toBe(1);
    expect(ww.firstReportedKind('V')).toBe('target');
    ww.end('V', 'target');
    expect(sink.clears).toEqual(['fleet-wait-timeout:V:target']);
    expect(ww.firstReportedKind('V')).toBeNull();
    expect(schedules).toBe(0);
  });

  it('checks passive deadlines at existing begin/end events', () => {
    const clock = new ContinuousSimClock();
    const sink = recordingSink();
    const ww = new WaitWatch({ clock, defaultLimitSec: 5, problems: sink });
    ww.begin('V', 'charge', 5, undefined, { passive: true });
    clock.advanceTo(5);
    ww.begin('W', 'target', 5, undefined, { passive: true });
    expect(ww.stats('charge').timeouts).toBe(1);
    clock.advanceTo(10);
    ww.end('W', 'target');
    expect(ww.stats('target').timeouts).toBe(1);
  });
});


it('uses fixed fault priority independently of wait insertion order', () => {
  const clock = new ContinuousSimClock();
  const ww = new WaitWatch({ clock, defaultLimitSec: 1, problems: recordingSink() });
  for (const kind of ['standstill', 'charge', 'target', 'exit', 'fork']) ww.begin('V', kind, 1, undefined, { passive: true });
  clock.advanceTo(1); ww.poll();
  for (const kind of ['fork', 'exit', 'target', 'charge', 'standstill']) {
    expect(ww.firstReportedKind('V')).toBe(kind);
    ww.end('V', kind);
  }
  expect(ww.firstReportedKind('V')).toBeNull();
});

it('exit deadline excludes downtime and still reports a vehicle stuck after repair', () => {
  const clock = new ContinuousSimClock();
  const sink = recordingSink();
  const ww = new WaitWatch({ clock, defaultLimitSec: 60, problems: sink, cancelOnEnd: false });
  ww.begin('V', 'exit');
  clock.advanceTo(20);
  ww.setPaused('V', 'exit', true);
  clock.advanceTo(620);
  expect(sink.reports).toHaveLength(0);
  const state = ww.exportState();
  expect(ww.validateState(state)).toEqual([]);
  ww.swapState(ww.prepareState(state));
  ww.setPaused('V', 'exit', false);
  clock.advanceTo(659);
  expect(sink.reports).toHaveLength(0);
  clock.advanceTo(660);
  expect(sink.reports.map(p => p.id)).toEqual([waitTimeoutProblemId('V', 'exit')]);
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-664 §9.13 — Phase 0 GO/NO-GO: does the MovementAuthority carry a
 * GEOMETRIC sensor limit?
 *
 * This is the one capability the sensor plan invents. It is built here thin and
 * WITHOUT rays: a stub field machine supplies an obstacle at a fixed position in
 * the vehicle's odometer frame — exactly the shape the real `LaserScanner`
 * coupling will push in Phase 3. The analytic scanner fields are switched OFF on
 * every vehicle (`ScannerFields: false`), so what these tests observe can only
 * come from the new planner step 5b and not from the leader machine.
 *
 * The course is deliberately CHAINED out of 10 m pieces rather than one long
 * path: route coordinates are re-anchored at every piece (`plan.odo0` moves), so
 * every test here crosses several re-anchorings — the condition R1 is about. On
 * a single long path `odo0` would stay 0 and the tests would be blind to it.
 *
 * Covered (Phase 0 checklist + §9.13): throttle / halt / restart, no flutter
 * while the obstacle stays, the leader combinations, the flush WITHOUT a Run or
 * task edge, two vehicles with different decelerations, the docking-field
 * remaining distance on the real plan, and the four residual risks R1-R4
 * (odometer frame, limit on ALL plan paths, `cause = 'field'`,
 * `sensor-chain-infeasible`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Object3D } from 'three';
import { parsePathExtras } from '../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../src/core/engine/rv-path-network';
import { getDefaultAgvFleet, type SensorLimitSource } from '../src/core/engine/rv-agv-fleet';
import {
  getDefaultMovementAuthority, fieldLength, SENSOR_CHAIN_INFEASIBLE_CODE,
  type MovementAuthority, type FieldState,
} from '../src/core/engine/rv-movement-authority';
import type { BindContextHandle } from '../src/core/behavior-runtime';
import { getProblems, clearProblemsOfCode } from '../src/core/hmi/problems-store';
import {
  TICK, makeHost, makeAgvRoot, bindContinuous, clearShared, stepFleet, sig, type AgvTestHost,
} from './helpers/agv-harness';

// ── Scenario parameters (SI) ──────────────────────────────────────────────

/** Cruise speed (m/s) of the test vehicles. */
const VMAX = 1;
/** Deceleration (m/s²) — braking distance from VMAX is 1 m. */
const BRAKE = 0.5;
/** Docking crawl (m/s) — the warning cap. */
const DOCK = 0.3;
/** Protective supplement (m) the stub machine keeps free in front of the obstacle. */
const MARGIN = 0.2;
/** Warning field beyond the protective field (m). */
const WARN_MARGIN = 1;
/** Scanner + control reaction time (s). */
const REACT = 0.2;
/** Exit hysteresis (m). */
const HYST = 0.1;
/** Restart delay (s) after the protective field cleared. */
const RESTART = 0.5;
/** Leading body reach (m) — `VehicleLength: 1000` centred on the root. */
const FRONT = 0.5;
/** Length (m) of one course piece. */
const PIECE = 10;
/** Number of course pieces. */
const PIECES = 12;

const P = (v: number): number => fieldLength(v, REACT, BRAKE, MARGIN);
const W = (v: number): number => P(v) + WARN_MARGIN;
/** Gap above which the warning field releases (mirrors `warningExitLength`). */
const W_EXIT = W(VMAX) + HYST;

/** `L0 → L1 → … → L11`, each {@link PIECE} m long; world x = odometer. */
function chainedCourse(): void {
  const net = getDefaultPathNetwork();
  for (let i = 0; i < PIECES; i++) {
    net.register(parsePathExtras({
      type: 'Path', version: 1, id: `L${i}`,
      segments: [{ kind: 'line', from: [i * PIECE, 0, 0], to: [(i + 1) * PIECE, 0, 0] }],
      ...(i + 1 < PIECES ? { successors: [`L${i + 1}`] } : {}),
    }, `L${i}`)!);
  }
  net.resolveGraph();
}

/** Start pose for an absolute odometer position (m) on the chained course. */
function at(odoM: number): { PathId: string; StartPosition: number } {
  const i = Math.min(PIECES - 1, Math.floor(odoM / PIECE));
  return { PathId: `L${i}`, StartPosition: (odoM - i * PIECE) * 1000 };
}

function agvCfg(odoM: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...at(odoM),
    TargetSpeed: VMAX * 1000, Acceleration: 500,
    Deceleration: BRAKE * 1000, DockingSpeed: DOCK * 1000, UseAcceleration: true,
    VehicleLength: 1000, VehicleWidth: 600,
    // The analytic machine stays OFF: every observed effect is the sensor limit.
    ScannerFields: false,
    ...extra,
  };
}

/**
 * The stub geometric field machine of ONE vehicle — the Phase 3 coupling in
 * miniature, without rays. It knows an obstacle at a fixed ODOMETER position,
 * derives clear / warning / protective from the field lengths at the current
 * speed, and applies hysteresis and the restart delay. Structurally identical
 * to the analytic `updateFieldInline`, which is the point: Phase 0 must show
 * that the AUTHORITY carries such a machine's output, not that the machine
 * itself is clever.
 */
interface ScanStub {
  source: SensorLimitSource;
  /** Place the obstacle at odometer position `x` (m); null removes it. */
  set(x: number | null): void;
  /** Extra offset (m) added to the reported obstacle on every other scan (jitter). */
  jitter: number;
  /** Number of measurements delivered. */
  scans: number;
  /** Field states in order of first occurrence. */
  states: FieldState[];
}

function makeScanStub(w: World, id: string): ScanStub {
  let obs: number | null = null;
  /** Last known obstacle — a protective field keeps holding at it while it runs out. */
  let lastObs = 0;
  let state: FieldState = 'clear';
  let restartAt = -1;
  const out: ScanStub = {
    scans: 0,
    jitter: 0,
    states: ['clear'],
    set: (x) => { obs = x; if (x !== null) lastObs = x; },
    source: (now) => {
      out.scans++;
      const speed = w.mb.speedOf(id, now);
      const gap = obs === null ? Infinity : obs - (w.odo(id) + FRONT);
      if (state === 'clear') {
        if (gap < P(speed)) state = 'protective';
        else if (gap < W(speed)) state = 'warning';
      } else if (state === 'warning') {
        if (gap < P(speed)) state = 'protective';
        else if (gap > W_EXIT) state = 'clear';
      }
      if (state === 'protective') {
        if (speed <= 1e-9 && gap > MARGIN + HYST) {
          if (restartAt < 0) restartAt = now + RESTART;
          if (now >= restartAt) { state = 'clear'; restartAt = -1; }
        } else restartAt = -1;
      }
      if (out.states[out.states.length - 1] !== state) out.states.push(state);
      if (state === 'clear') return { state: 'clear', odoObs: Infinity, dir: 1, margin: MARGIN, measuredAt: now };
      // Still protective / warning — a removed obstacle keeps holding at its LAST
      // known place until the restart delay expires (as a real scanner does).
      const base = obs ?? lastObs;
      const shift = out.jitter !== 0 && out.scans % 2 === 0 ? out.jitter : 0;
      return { state, odoObs: base + shift, dir: 1, margin: MARGIN, measuredAt: now };
    },
  };
  return out;
}

interface World {
  mb: MovementAuthority;
  host: AgvTestHost;
  roots: Record<string, Object3D>;
  step(n?: number): void;
  now(): number;
  /** Odometer (m) of the vehicle root — on this course equal to world x. */
  odo(id: string): number;
  /** Leading body end (m) in odometer terms. */
  nose(id: string): number;
  v(id: string): number;
}

function makeWorld(specs: { name: string; cfg: Record<string, unknown> }[]): World {
  chainedCourse();
  const host = makeHost();
  const roots: Record<string, Object3D> = {};
  const handles: BindContextHandle[] = [];
  for (const s of specs) {
    roots[s.name] = makeAgvRoot(s.name, s.cfg);
    handles.push(bindContinuous(roots[s.name], host));
  }
  const mb = getDefaultMovementAuthority('continuous');
  const odo = (id: string): number => (mb.planOf(id)?.odo0 ?? 0) + (mb.locate(id, mb.clock.now)?.x ?? 0);
  return {
    mb, host, roots,
    step: (n = 1) => { for (let i = 0; i < n; i++) stepFleet(host, handles, TICK); },
    now: () => mb.clock.now,
    odo,
    nose: (id) => odo(id) + FRONT,
    v: (id) => mb.speedOf(id, mb.clock.now),
  };
}

/**
 * Step until `id` has moved and then come to a standstill. Returns the number
 * of steps, or -1 when it never halted (a plain `v > 0` loop condition is wrong
 * here: at t = 0 the vehicle is still standing and the loop would never run).
 */
function runUntilHalt(w: World, id: string, maxSteps = 4000): number {
  let moved = false;
  for (let i = 1; i <= maxSteps; i++) {
    w.step();
    const v = w.v(id);
    if (v > 1e-6) moved = true;
    else if (moved) return i;
  }
  return -1;
}

beforeEach(() => { clearShared(); clearProblemsOfCode(SENSOR_CHAIN_INFEASIBLE_CODE); });
afterEach(() => { clearShared(); clearProblemsOfCode(SENSOR_CHAIN_INFEASIBLE_CODE); });

describe('plan-664 Phase 0 — geometric sensor limit in the MovementAuthority', () => {
  it('without a source nothing changes: the vehicle cruises across the piece boundaries', () => {
    const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
    w.step(900); // 15 s — past the first piece ends
    expect(w.v('A')).toBeCloseTo(VMAX, 6);
    expect(w.odo('A')).toBeGreaterThan(PIECE);
    expect(w.mb.sensorLimitOf('A')).toBeNull();
    expect(w.mb.stats.dirtyBy.scanner ?? 0).toBe(0);
  });

  it('obstacle 3 m ahead: the warning throttles to the docking speed, the protective field halts before it', () => {
    const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
    const stub = makeScanStub(w, 'A');
    getDefaultAgvFleet().setSensorLimitSource('A', stub.source);
    w.step(180); // 3 s of free travel
    expect(w.v('A')).toBeCloseTo(VMAX, 6);
    const obs = w.nose('A') + 3;
    stub.set(obs);
    let sawCap = false;
    let moved = false;
    for (let i = 0; i < 1500; i++) {
      w.step();
      const v = w.v('A');
      if (v > 1e-6) { moved = true; if (v <= DOCK + 1e-3) sawCap = true; } else if (moved) break;
    }
    expect(stub.states).toContain('warning');
    expect(sawCap).toBe(true);                                      // the warning cap bit
    expect(w.v('A')).toBeLessThanOrEqual(1e-9);                     // halted
    expect(w.nose('A')).toBeLessThanOrEqual(obs - MARGIN + 1e-6);   // never past xObs - margin
    expect(obs - MARGIN - w.nose('A')).toBeLessThan(0.25);          // and it really drove up to it
    expect(w.mb.stopCauseOf('A')).toBe('field');                    // R3
    expect(sig(w.host, 'A', 'Blocked')).toBe(true);
  });

  it('the obstacle stays: no flutter over 3 restart delays, and the scanner re-plans once, not once per scan', () => {
    const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
    const stub = makeScanStub(w, 'A');
    getDefaultAgvFleet().setSensorLimitSource('A', stub.source);
    stub.set(5);
    expect(runUntilHalt(w, 'A')).toBeGreaterThan(0);
    const dirtyAtStop = w.mb.stats.dirtyBy.scanner ?? 0;
    const xAtStop = w.odo('A');
    w.step(Math.ceil((3 * RESTART) / TICK) + 5);
    expect(w.v('A')).toBeLessThanOrEqual(1e-9);                 // stays stopped
    expect(w.odo('A')).toBeCloseTo(xAtStop, 6);
    expect(w.mb.fieldStateOf('A')).toBe('clear');               // the analytic machine stayed out
    expect(w.mb.sensorLimitOf('A')!.state).toBe('protective');
    expect((w.mb.stats.dirtyBy.scanner ?? 0) - dirtyAtStop).toBe(0);
    expect(w.mb.stats.dirtyBy.scanner ?? 0).toBeLessThan(stub.scans / 10);
  });

  it('obstacle removed: the vehicle restarts after the restart delay and returns to cruise', () => {
    const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
    const stub = makeScanStub(w, 'A');
    getDefaultAgvFleet().setSensorLimitSource('A', stub.source);
    stub.set(5);
    expect(runUntilHalt(w, 'A')).toBeGreaterThan(0);
    stub.set(null);
    const tFree = w.now();
    let tMove = -1;
    for (let i = 0; i < 300 && tMove < 0; i++) { w.step(); if (w.v('A') > 1e-6) tMove = w.now(); }
    expect(tMove).toBeGreaterThan(0);
    expect(tMove - tFree).toBeGreaterThanOrEqual(RESTART - 2 * TICK);
    expect(tMove - tFree).toBeLessThan(RESTART + 10 * TICK);
    w.step(300);
    expect(w.v('A')).toBeCloseTo(VMAX, 3);
    expect(w.mb.stopCauseOf('A')).not.toBe('field');
    expect(w.mb.sensorLimitOf('A')).toBeNull();
  });

  it('a new obstacle takes effect WITHOUT a Run or task edge and without a due authority event (SOL #2)', () => {
    const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
    const stub = makeScanStub(w, 'A');
    getDefaultAgvFleet().setSensorLimitSource('A', stub.source);
    w.step(300); // 5 s of undisturbed cruise — no edge of any kind afterwards
    const vBefore = w.v('A');
    const versionBefore = w.mb.versionOf('A');
    expect(vBefore).toBeCloseTo(VMAX, 6);
    const obs = w.nose('A') + 1.3;  // inside the protective field at once, still brakeable
    stub.set(obs);
    w.step();                        // ONE step
    // The re-plan happened INSIDE that step — no Run edge, no task edge, no due
    // authority event was needed to make the obstacle take effect.
    expect(w.mb.versionOf('A')).not.toBe(versionBefore);
    expect(w.mb.stopCauseOf('A')).toBe('field');
    const plan = w.mb.planOf('A')!;
    expect(plan.odo0 + plan.profile.xStop).toBeCloseTo(obs - MARGIN - FRONT, 6); // stops AT the obstacle
    expect(w.mb.stats.sensorUnbrakeable).toBe(0);                                // brakeable, no emergency
    w.step(20);
    expect(w.v('A')).toBeLessThan(vBefore);                                      // and it is braking
  });

  describe('leader combinations', () => {
    it('a fast, distant leader does not matter — the obstacle decides', () => {
      const w = makeWorld([
        { name: 'Lead', cfg: agvCfg(40, { TargetSpeed: 2000 }) },
        { name: 'A', cfg: agvCfg(0) },
      ]);
      const stub = makeScanStub(w, 'A');
      getDefaultAgvFleet().setSensorLimitSource('A', stub.source);
      stub.set(6);
      expect(runUntilHalt(w, 'A')).toBeGreaterThan(0);
      expect(w.mb.stopCauseOf('A')).toBe('field');
      expect(w.nose('A')).toBeLessThanOrEqual(6 - MARGIN + 1e-6);
    });

    it('a leader NEARER than the obstacle decides instead', () => {
      const w = makeWorld([
        { name: 'Lead', cfg: agvCfg(4, { TargetSpeed: 1 }) }, // practically standing at 4 m
        { name: 'A', cfg: agvCfg(0) },
      ]);
      const stub = makeScanStub(w, 'A');
      getDefaultAgvFleet().setSensorLimitSource('A', stub.source);
      stub.set(20); // far beyond the leader
      w.step(1500);
      expect(w.mb.stopCauseOf('A')).toBe('leader');
      expect(w.odo('A')).toBeLessThan(4);
      expect(w.mb.sensorLimitOf('A')?.state ?? 'clear').toBe('clear');
    });
  });

  it('two vehicles with different decelerations: the follower never overlaps the halted leader', () => {
    const w = makeWorld([
      { name: 'A', cfg: agvCfg(6) },
      { name: 'B', cfg: agvCfg(0, { Deceleration: 300 }) }, // weaker brake behind
    ]);
    const stub = makeScanStub(w, 'A');
    getDefaultAgvFleet().setSensorLimitSource('A', stub.source);
    stub.set(12);
    let minGap = Infinity;
    for (let i = 0; i < 3000; i++) {
      w.step();
      minGap = Math.min(minGap, (w.odo('A') - FRONT) - (w.odo('B') + FRONT));
      if (i > 60 && w.v('A') <= 1e-9 && w.v('B') <= 1e-9) break;
    }
    expect(minGap).toBeGreaterThan(-1e-6);                 // no overlap at any step
    expect(w.mb.stopCauseOf('A')).toBe('field');
    expect(w.nose('A')).toBeLessThanOrEqual(12 - MARGIN + 1e-6);
    expect(w.mb.stats.violations).toBe(0);
    expect(w.mb.stats.authorityBehind).toBe(0);
    expect(w.mb.stats.cascadeCapHitsAfterStart).toBe(0);
    expect(w.mb.stats.safeHolds).toBe(0);
    // The cascade a geometric obstacle costs is counted and stays small.
    expect(w.mb.stats.sensorChainReplans).toBeLessThan(20);
  });

  describe('R1 — the obstacle survives re-anchoring (odometer frame)', () => {
    it('measured ONCE and then never again, the halt still lands at the obstacle three pieces later', () => {
      const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
      // 65 m is beyond the 30 m route-walk horizon, so the plan is rebuilt (and
      // re-anchored) on the way — which is the condition this test needs.
      const obs = 65;
      // One measurement while still on L0 and no scanner source afterwards: only
      // the odometer frame can still place the obstacle correctly. The limit is
      // set directly — removing a registered source clears it (plan-2006 #13).
      w.step(2);
      w.mb.setSensorLimit('A', { state: 'protective', odoObs: obs, dir: 1, margin: MARGIN, measuredAt: w.now() });
      const odo0Start = w.mb.planOf('A')!.odo0;
      expect(runUntilHalt(w, 'A', 6000)).toBeGreaterThan(0);
      // The plan really was re-anchored on the way (otherwise this proves nothing).
      expect(w.mb.planOf('A')!.odo0).toBeGreaterThan(odo0Start + PIECE);
      expect(w.mb.sensorLimitOf('A')!.odoObs).toBeCloseTo(obs, 9);
      expect(w.mb.stopCauseOf('A')).toBe('field');
      expect(w.nose('A')).toBeLessThanOrEqual(obs - MARGIN + 1e-6);
      expect(obs - MARGIN - w.nose('A')).toBeLessThan(0.05);
    });

    it('a limit measured in the other travel direction is discarded', () => {
      const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
      w.step(60);
      // Setting it re-plans at once, and that forward plan drops it unread.
      expect(w.mb.setSensorLimit('A', {
        state: 'protective', odoObs: w.odo('A') + 2, dir: -1, margin: MARGIN, measuredAt: w.now(),
      })).toBe(true);
      expect(w.mb.sensorLimitOf('A')).toBeNull();
      w.step(30);
      expect(w.mb.stopCauseOf('A')).not.toBe('field');
      w.step(300);
      expect(w.v('A')).toBeCloseTo(VMAX, 6);
    });

    it('an obstacle the vehicle has already driven past is discarded', () => {
      const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
      w.step(300);
      w.mb.setSensorLimit('A', { state: 'protective', odoObs: w.odo('A') - 2, dir: 1, margin: MARGIN, measuredAt: w.now() });
      w.step(30);
      expect(w.mb.sensorLimitOf('A')).toBeNull();
      expect(w.v('A')).toBeCloseTo(VMAX, 6);
    });
  });

  describe('R2 — the limit binds on ALL plan paths', () => {
    it('the hold plan (Run off) never ends behind the obstacle', () => {
      const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
      const stub = makeScanStub(w, 'A');
      getDefaultAgvFleet().setSensorLimitSource('A', stub.source);
      w.step(300);
      const obs = w.nose('A') + 1.3;
      stub.set(obs);
      // Obstacle and Run-off in the SAME step: the hold plan bypasses
      // buildPlanInner, so without the R2 clamp it could end beyond the obstacle.
      w.host.signalStore!.set('A.Agv.Run', false);
      w.step(600);
      expect(w.v('A')).toBeLessThanOrEqual(1e-9);
      expect(w.nose('A')).toBeLessThanOrEqual(obs - MARGIN + 1e-6);
    });

    it('the safe hold (re-plan cap reached) never ends behind the obstacle', () => {
      const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
      const stub = makeScanStub(w, 'A');
      getDefaultAgvFleet().setSensorLimitSource('A', stub.source);
      w.step(300);
      const obs = w.nose('A') + 2.5;
      stub.set(obs);
      stub.jitter = 0.05;        // every other scan is a real change → a re-plan
      w.mb.replanCap = 0;        // ... and every re-plan is a safe hold
      let halted = false;
      for (let i = 0; i < 1500; i++) { w.step(); if (w.v('A') <= 1e-9) { halted = true; break; } }
      w.mb.replanCap = 4;
      expect(halted).toBe(true);
      expect(w.mb.stats.safeHolds).toBeGreaterThan(0);
      expect(w.nose('A')).toBeLessThanOrEqual(obs + stub.jitter - MARGIN + 1e-6);
    });
  });

  it('R3 — a sensor halt is a FIELD stop: traffic stop, Blocked, stopped motion state', () => {
    const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
    const stub = makeScanStub(w, 'A');
    getDefaultAgvFleet().setSensorLimitSource('A', stub.source);
    stub.set(6);
    expect(runUntilHalt(w, 'A')).toBeGreaterThan(0);
    expect(w.mb.stopCauseOf('A')).toBe('field');
    expect(w.mb.motionStateOf('A')).toBe('stopped');
    expect(sig(w.host, 'A', 'Blocked')).toBe(true);
    expect(sig(w.host, 'A', 'Moving')).toBe(false);
  });

  it('R4 — a halt the queue behind cannot absorb is reported ONCE, counted, and the obstacle still wins', () => {
    // A very weak brake close behind: the leader's halt is no longer reachable
    // for the follower. The obstacle keeps priority and the case is named.
    const w = makeWorld([
      { name: 'A', cfg: agvCfg(15) },
      { name: 'B', cfg: agvCfg(10, { Deceleration: 60 }) }, // 8.3 m braking distance
    ]);
    const stub = makeScanStub(w, 'A');
    getDefaultAgvFleet().setSensorLimitSource('A', stub.source);
    w.step(300);                       // both at cruise, ~5 m apart
    const obs = w.nose('A') + 1.3;
    stub.set(obs);
    for (let i = 0; i < 2000 && w.v('A') > 1e-9; i++) w.step();
    expect(w.mb.stats.sensorChainInfeasible).toBeGreaterThan(0);
    const reported = getProblems().filter((p) => p.code === SENSOR_CHAIN_INFEASIBLE_CODE);
    expect(reported).toHaveLength(1);                            // once, not per re-plan
    expect(reported[0].id).toBe(`${SENSOR_CHAIN_INFEASIBLE_CODE}:A`);
    expect(reported[0].detail).toContain('deceleration');
    expect(w.nose('A')).toBeLessThanOrEqual(obs - MARGIN + 1e-6);
  });

  it('counters: an unbrakeable sensor halt is counted, not silently rounded away', () => {
    const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
    w.step(300);
    expect(w.v('A')).toBeCloseTo(VMAX, 6);
    // Braking distance from 1 m/s at 0.5 m/s² is 1 m — an obstacle 0.3 m ahead
    // can no longer be respected.
    w.mb.setSensorLimit('A', { state: 'protective', odoObs: w.nose('A') + 0.3, dir: 1, margin: MARGIN, measuredAt: w.now() });
    w.step(10);
    expect(w.mb.stats.sensorUnbrakeable).toBeGreaterThan(0);
  });
});

describe('plan-664 Phase 0 — docking field (remaining distance on the real plan)', () => {
  it('serviceStopAheadOf is +inf without a service stop, counts down on approach and reaches 0 at the dock', () => {
    const w = makeWorld([{ name: 'A', cfg: agvCfg(0) }]);
    w.step(60);
    expect(w.mb.serviceStopAheadOf('A', w.now())).toBe(Infinity);   // cruising, no task
    getDefaultAgvFleet().get('A')!.assign({ destination: 'L2', serviceSec: 5 });
    w.step(60);
    const d0 = w.mb.serviceStopAheadOf('A', w.now());
    expect(Number.isFinite(d0)).toBe(true);
    expect(d0).toBeGreaterThan(0);
    w.step(120);
    const d1 = w.mb.serviceStopAheadOf('A', w.now());
    expect(d1).toBeLessThan(d0 - 1);                                 // it really counts down
    let minLeft = d1;
    for (let i = 0; i < 4000; i++) {
      w.step();
      minLeft = Math.min(minLeft, w.mb.serviceStopAheadOf('A', w.now()));
      if (w.v('A') <= 1e-9 && minLeft < 0.05) break;
    }
    expect(minLeft).toBeLessThan(0.05);   // the docking field would be muted here
  });

  it('the remaining distance stays visible while a traffic stop hides the service cause', () => {
    const w = makeWorld([
      { name: 'Lead', cfg: agvCfg(12, { TargetSpeed: 1 }) },
      { name: 'A', cfg: agvCfg(0) },
    ]);
    w.host.signalStore!.set('Lead.Agv.Run', false); // a standing obstacle short of the dock
    getDefaultAgvFleet().get('A')!.assign({ destination: 'L2', serviceSec: 5 });
    w.step(3000);
    expect(w.mb.stopCauseOf('A')).toBe('leader');                    // the binding cause is NOT 'service'
    expect(Number.isFinite(w.mb.serviceStopAheadOf('A', w.now()))).toBe(true);
  });
});

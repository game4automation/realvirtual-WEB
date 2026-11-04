// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-634 §9.1-9.7 — an UNREACHABLE service stop is missed (LOP #204).
 *
 * A service stop (task destination, dock, turn point of a stub manoeuvre) that
 * can no longer be reached with the vehicle's own deceleration when it is planned
 * must not become a stop beyond the piece end. It is MISSED — once per occurrence
 * (path + odometer of its end) — and the vehicle comes back on a later visit:
 * the destination over the routing, the turn point over the go-around lap.
 *
 * Every case runs in BOTH kernels (DES Animated and continuous) and checks the
 * F8 invariant `serviceOvershoot === 0` — except the negative test 9.6b, which
 * switches the rule off through the authority's INTERNAL instance field to show
 * that the turn-point guard (F5) detects the old overshoot.
 *
 * Triggers run at EVENT time (a polling chain on the stub world's timer
 * vehicles, {@link every}): the DES clock only advances at events, so a check
 * between two render ticks would read a stale instant.
 *
 * The forklift drives 1.2 m/s with 0.5 m/s² deceleration: braking distance 1.44 m.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { setReverseGateOpen, type MovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { positionAt } from '../../src/core/engine/rv-motion-profile';
import { getProblems, resetProblemsForTests } from '../../src/core/hmi/problems-store';
import { clearShared, TICK } from '../helpers/agv-harness';
import {
  stubLayout, makeStubWorld, forkCfg, delay, FORK, FORK_MESH, type Mode, type StubWorld,
} from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); resetProblemsForTests(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

const MODES: Mode[] = ['animated', 'continuous'];
/** Braking distance (m) of the forklift at cruise speed: 1.2² / (2 · 0.5). */
const BRAKE_M = 1.44;
const DECEL = 0.5;
/** Period (s) of the event-time polling chain. */
const POLL_SEC = 0.05;

// ── Layouts ─────────────────────────────────────────────────────────────────

function add(id: string, pts: number[][], succ: string[], opts: { zone?: string; closed?: boolean } = {}): void {
  const segments = [];
  for (let i = 0; i + 1 < pts.length; i++) segments.push({ kind: 'line', from: pts[i], to: pts[i + 1] });
  getDefaultPathNetwork().register(parsePathExtras({
    type: 'Path', version: 1, closed: opts.closed === true, align: [0, 1, 0], id, segments, successors: succ,
    ...(opts.zone ? { zone: opts.zone, zoneCapacity: 1 } : {}),
  }, id)!);
}

/** The dead-end pieces the parked timer vehicles of the stub world stand on. */
function parks(): void {
  for (let k = 0; k < 4; k++) add(`Park${k}`, [[0, 0, 30 + 3 * k], [4, 0, 30 + 3 * k]], []);
}

/** One-way rectangle ring (100 m) with two short pieces D1, D2 (0.4 m each) after A0. */
function dockRing(): void {
  add('A0', [[0, 0, 0], [20, 0, 0]], ['D1']);
  add('D1', [[20, 0, 0], [20.4, 0, 0]], ['D2']);
  add('D2', [[20.4, 0, 0], [20.8, 0, 0]], ['A1']);
  add('A1', [[20.8, 0, 0], [40, 0, 0]], ['A2']);
  add('A2', [[40, 0, 0], [40, 0, 10]], ['A3']);
  add('A3', [[40, 0, 10], [0, 0, 10]], ['A4']);
  add('A4', [[0, 0, 10], [0, 0, 0]], ['A0']);
  parks();
  getDefaultPathNetwork().resolveGraph();
}

/** A single CLOSED rectangle path C (36 m) — one route entry per lap. */
function closedRing(): void {
  add('C', [[0, 0, -20], [12, 0, -20], [12, 0, -14], [0, 0, -14], [0, 0, -20]], [], { closed: true });
  parks();
  getDefaultPathNetwork().resolveGraph();
}

/** Short ring (20 m) with ONE stub S (zone K) into the merge piece Turn (zone M): the turn point twice in the 30 m horizon. */
function shortStubRing(): void {
  add('Pre', [[0, 0, 0], [3, 0, 0]], ['Turn'], { zone: 'M' });
  add('Turn', [[3, 0, 0], [6, 0, 0]], ['Ra'], { zone: 'M' });
  add('Ra', [[6, 0, 0], [6, 0, 4]], ['Rb']);
  add('Rb', [[6, 0, 4], [0, 0, 4]], ['Rc']);
  add('Rc', [[0, 0, 4], [0, 0, 0]], ['Pre']);
  add('S', [[-1, 0, -4], [2, 0, -1]], ['Mouth'], { zone: 'K' });
  add('Mouth', [[2, 0, -1], [3, 0, 0]], ['Turn'], { zone: 'M' });
  parks();
  getDefaultPathNetwork().resolveGraph();
}

/** Spur E0 → X (4 m) → Y (dead end). */
function spur(): void {
  add('E0', [[0, 0, 50], [10, 0, 50]], ['X']);
  add('X', [[10, 0, 50], [14, 0, 50]], ['Y']);
  add('Y', [[14, 0, 50], [24, 0, 50]], []);
  parks();
  getDefaultPathNetwork().resolveGraph();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function world(mode: Mode, path: string, startMm: number, extra: Record<string, unknown> = {}, limit = 400): StubWorld {
  return makeStubWorld(mode, [{ name: 'F', cfg: forkCfg(path, startMm, extra), mesh: FORK_MESH, body: FORK }], limit);
}

/** Root location of F at the current sim instant. */
function loc(w: StubWorld): { path: string; s: number; v: number; rest: number } {
  const l = w.mb.locate('F', w.now())!;
  return { path: l.path.id, s: l.s, v: l.v, rest: l.path.length - l.s };
}

/** Run `fn` every {@link POLL_SEC} of sim time AT EVENT TIME (a parked timer vehicle's dwell), both kernels. */
function every(fn: () => void): void {
  const tick = (): void => { fn(); delay(POLL_SEC, tick); };
  delay(POLL_SEC, tick);
}

/** Step the world until `stop()` or its sim limit. */
function runUntil(w: StubWorld, stop: () => boolean): void {
  while (!w.done() && !stop()) w.step();
}

/** F8: an applied SERVICE plan never stops beyond the end of its last route entry. */
function servicePlanBeyondEnd(mb: MovementAuthority): boolean {
  const pl = mb.planOf('F');
  if (!pl || pl.stopCause !== 'service') return false;
  const last = pl.route[pl.route.length - 1];
  return pl.profile.xStop > last.x0 + last.path.length + 1e-3;
}

/** A re-plan trigger from outside (any cause — a live edit, a zone wake, …). */
function kick(w: StubWorld): void {
  w.mb.markDirty('F', 'test-replan');
  w.mb.flush(w.now());
}

function problemsOf(code: string): { title: string; detail: string }[] {
  return getProblems().filter((p) => p.code === code).map((p) => ({ title: p.title, detail: p.detail ?? '' }));
}

/** Common end-of-run invariants. */
function expectClean(mb: MovementAuthority): void {
  expect(mb.stats.serviceOvershoot).toBe(0);
  expect(mb.stats.violations).toBe(0);
  expect(mb.stats.watchdogFires).toBe(0);
}

// ── 9.1 / 9.4b Stub task, turn point unreachable ────────────────────────────

interface StubRun {
  assigned: boolean;
  missed: number;
  served: boolean;
  servedPath: string;
  turnArrivals: number;
  beyond: boolean;
  dirRefused: number;
  guardTrips: number;
  goAroundResets: number;
  mb: MovementAuthority;
}

function runStubMiss(mode: Mode, layout: 'ring' | 'short', pauseDuring: boolean): StubRun {
  if (layout === 'ring') stubLayout(); else shortStubRing();
  const turn = layout === 'ring' ? 'Turn2' : 'Turn';
  const stub = layout === 'ring' ? 'S2' : 'S';
  const w = world(mode, layout === 'ring' ? 'L0' : 'Rc', layout === 'ring' ? 3500 : 0, {}, 400);
  const { mb } = w;
  const fleet = getDefaultAgvFleet();
  const r: StubRun = {
    assigned: false, missed: 0, served: false, servedPath: '', turnArrivals: 0, beyond: false, dirRefused: 0,
    guardTrips: 0, goAroundResets: 0, mb,
  };
  getDefaultPathNetwork().setRouter({
    onArrive: (pathId, id) => { if (id === 'F' && pathId === turn && r.assigned && !r.served) r.turnArrivals++; },
  }, 'plan-634-test');
  try {
    every(() => {
      if (servicePlanBeyondEnd(mb)) r.beyond = true;
      if (r.assigned) return;
      const l = loc(w);
      // The #204 case: the task comes while the remaining way to the turn point is shorter than the braking distance.
      if (l.path === turn && l.rest < 0.7 && l.v > 1.0) {
        r.assigned = true;
        fleet.get('F')!.assign({
          destination: stub, approach: 'reverse', serviceSec: 2,
          onServiceEnd: () => { r.served = true; r.servedPath = mb.locate('F', w.now())!.path.id; },
        });
        if (pauseDuring) w.pause('F', 3);
      }
    });
    runUntil(w, () => r.served);
    r.missed = mb.stats.serviceStopsMissed;
    r.dirRefused = mb.stats.dirRefused;
    r.guardTrips = mb.stats.turnGuardTrips;
    r.goAroundResets = mb.stats.dirtyBy['goAround-reset'] ?? 0;
    return r;
  } finally {
    w.dispose();
  }
}

describe('plan-634 9.1 — stub task, turn point unreachable: go around, then enter', () => {
  for (const mode of MODES) {
    for (const pause of [false, true]) {
      it(`${mode}${pause ? ' with a Run/hold interruption' : ''}`, () => {
        const r = runStubMiss(mode, 'ring', pause);
        expect(r.assigned).toBe(true);
        expect(r.beyond).toBe(false);         // no plan ever stopped beyond its route entry
        expect(r.missed).toBe(1);
        expect(r.served).toBe(true);
        expect(r.servedPath).toBe('S2');      // in the stub after one lap
        expect(r.turnArrivals).toBe(2);       // passed once, stopped the second time
        expect(r.dirRefused).toBe(0);
        expect(r.guardTrips).toBe(0);
        expectClean(r.mb);
      }, 180000);
    }
  }
});

// ── 9.2 Forward destination unreachable ─────────────────────────────────────

describe('plan-634 9.2 — forward destination unreachable: served on the next visit', () => {
  for (const mode of MODES) {
    it(mode, () => {
      stubLayout();
      const w = world(mode, 'L0', 3500);
      const { mb } = w;
      let assignedAt = -1;
      let arrivedAt = -1;
      let pose: { path: string; s: number } | null = null;
      let overshootAtArrive = Number.NaN;
      let beyond = false;
      try {
        every(() => {
          if (servicePlanBeyondEnd(mb)) beyond = true;
          if (assignedAt >= 0) return;
          const l = loc(w);
          if (l.path === 'L2' && l.rest < 0.7 && l.v > 1.0) {
            assignedAt = w.now();
            getDefaultAgvFleet().get('F')!.assign({
              destination: 'L2', serviceSec: 1,
              onArrive: () => {
                arrivedAt = w.now();
                const p = mb.locate('F', w.now())!;
                pose = { path: p.path.id, s: p.s };
                overshootAtArrive = mb.overshootOf('F');
              },
            });
          }
        });
        runUntil(w, () => arrivedAt >= 0);
        expect(assignedAt).toBeGreaterThan(0);
        expect(beyond).toBe(false);
        expect(mb.stats.serviceStopsMissed).toBe(1);
        expect(arrivedAt).toBeGreaterThan(assignedAt + 60); // one lap (100 m) later, not now
        expect(pose!.path).toBe('L2');
        expect(Math.abs(pose!.s - 4)).toBeLessThanOrEqual(1e-3);
        expect(Math.abs(overshootAtArrive)).toBeLessThanOrEqual(1e-3);
        expectClean(mb);
      } finally {
        w.dispose();
      }
    }, 180000);
  }
});

// ── 9.3 Two short docks inside the braking distance ─────────────────────────

describe('plan-634 9.3 — two short docks missed: one report each, both served next lap', () => {
  for (const mode of MODES) {
    it(mode, () => {
      dockRing();
      const w = world(mode, 'A0', 2000);
      const { mb } = w;
      const calls: Record<string, number> = { D1: 0, D2: 0 };
      const firstPass: Record<string, number> = { D1: -1, D2: -1 };
      let added = false;
      let kicks = 0;
      let missedAfterPass = -1;
      try {
        every(() => {
          const l = loc(w);
          if (!added) {
            if (l.path === 'A0' && l.rest < 0.25 && l.v > 1.0) {
              added = true;
              for (const id of ['D1', 'D2']) {
                getDefaultPathDockRegistry().register(id, { onVehicleArrive: (_v, release) => { calls[id]++; release(); } });
              }
              kick(w); // the docks enter the plan by a re-plan in the middle of the approach
            }
            return;
          }
          if (kicks < 10) { kicks++; kick(w); } // further re-plans during the overrun — no second report
          if (missedAfterPass < 0 && l.path === 'A2') {
            missedAfterPass = mb.stats.serviceStopsMissed;
            firstPass.D1 = calls.D1;
            firstPass.D2 = calls.D2;
          }
        });
        runUntil(w, () => calls.D2 > 0);
        expect(added).toBe(true);
        expect(missedAfterPass).toBe(2);
        expect(firstPass).toEqual({ D1: 0, D2: 0 });   // nothing served on the pass that missed them
        expect(calls).toEqual({ D1: 1, D2: 1 });       // both on the next lap
        expect(mb.stats.serviceStopsMissed).toBe(2);
        expectClean(mb);
      } finally {
        w.dispose();
      }
    }, 180000);
  }
});

// ── 9.4 Closed path / short ring: the next occurrence counts ────────────────

describe('plan-634 9.4 — the next occurrence is not suppressed', () => {
  for (const mode of MODES) {
    it(`${mode} (a) closed path: missed in lap 1, served at the end of lap 2`, () => {
      closedRing();
      const w = world(mode, 'C', 0);
      const { mb } = w;
      let assignedAt = -1;
      let arrivedAt = -1;
      let overshootAtArrive = Number.NaN;
      try {
        every(() => {
          if (assignedAt >= 0 || w.now() < 5) return;
          const l = loc(w);
          if (l.path === 'C' && l.rest < 0.7 && l.v > 1.0) {
            assignedAt = w.now();
            getDefaultAgvFleet().get('F')!.assign({
              destination: 'C', serviceSec: 1,
              onArrive: () => { arrivedAt = w.now(); overshootAtArrive = mb.overshootOf('F'); },
            });
          }
        });
        runUntil(w, () => arrivedAt >= 0);
        expect(assignedAt).toBeGreaterThan(0);
        expect(mb.stats.serviceStopsMissed).toBe(1);
        expect(arrivedAt).toBeGreaterThan(assignedAt + 20); // one lap (36 m) later
        expect(Math.abs(overshootAtArrive)).toBeLessThanOrEqual(1e-3);
        expectClean(mb);
      } finally {
        w.dispose();
      }
    }, 180000);

    it(`${mode} (b) short ring, turn point twice in the horizon: re-walked after the go-around reset`, () => {
      const r = runStubMiss(mode, 'short', false);
      expect(r.assigned).toBe(true);
      expect(r.beyond).toBe(false);
      expect(r.missed).toBe(1);
      expect(r.goAroundResets).toBeGreaterThanOrEqual(1);
      expect(r.served).toBe(true);
      expect(r.servedPath).toBe('S');
      expect(r.turnArrivals).toBe(2);
      expect(r.dirRefused).toBe(0);
      expect(r.guardTrips).toBe(0);
      expectClean(r.mb);
    }, 180000);
  }
});

// ── 9.5 The destination itself is a dead end ────────────────────────────────

describe('plan-634 9.5 — missed destination on a dead end: no service, reported', () => {
  for (const mode of MODES) {
    it(mode, () => {
      spur();
      const w = world(mode, 'E0', 0);
      const { mb } = w;
      let assigned = false;
      let taskArrivals = 0;
      let dockCalls = 0;
      let settledAt = -1;
      try {
        every(() => {
          if (!assigned) {
            const l = loc(w);
            if (l.path === 'X' && l.rest < 0.6 && l.v > 1.0) {
              assigned = true;
              // The continuation disappears at this moment: X becomes the last piece.
              getDefaultPathNetwork().unregister('Y');
              getDefaultPathDockRegistry().register('X', { onVehicleArrive: (_v, release) => { dockCalls++; release(); } });
              getDefaultAgvFleet().get('F')!.assign({ destination: 'X', serviceSec: 1, onArrive: () => { taskArrivals++; } });
            }
          } else if (settledAt < 0 && mb.speedOf('F', w.now()) < 1e-9 && mb.planOf('F')!.profile.tEnd <= w.now()) {
            settledAt = w.now();
          }
        });
        runUntil(w, () => settledAt >= 0 && w.now() > settledAt + 10); // a late service would show up here
        expect(assigned).toBe(true);
        expect(settledAt).toBeGreaterThan(0);
        expect(mb.stats.serviceStopsMissed).toBe(1);
        expect(mb.stopCauseOf('F')).toBe('deadend');
        expect(taskArrivals).toBe(0);
        expect(dockCalls).toBe(0);
        const pr = problemsOf('agv-service-stop-missed-no-return');
        expect(pr).toHaveLength(1);
        expect(pr[0].title).toContain("'F'");
        expect(pr[0].title).toContain("'X'");
        expectClean(mb);
      } finally {
        w.dispose();
      }
    }, 180000);
  }
});

// ── 9.6 Turn-point guard ────────────────────────────────────────────────────

describe('plan-634 9.6 — turn-point guard', () => {
  for (const mode of MODES) {
    for (const how of ['assign', 'clear'] as const) {
      it(`${mode} (a) a router callback at the turn point ${how === 'assign' ? 'replaces the task' : 'clears the task'}: decided on the new state`, () => {
        stubLayout();
        const w = world(mode, 'L0', 3500);
        const { mb } = w;
        const fleet = getDefaultAgvFleet();
        let fired = false;
        let newDone = false;
        let reversed = false;
        let leftAt = -1;
        const setDir = mb.setDirection.bind(mb);
        mb.setDirection = (id, dir, route = null) => {
          const ok = setDir(id, dir, route);
          if (id === 'F' && dir === -1 && ok) reversed = true;
          return ok;
        };
        getDefaultPathNetwork().setRouter({
          onArrive: (pathId, id) => {
            if (id !== 'F' || pathId !== 'Turn2' || fired) return;
            fired = true;
            if (how === 'assign') fleet.get('F')!.assign({ destination: 'L3', serviceSec: 1, onServiceEnd: () => { newDone = true; } });
            else fleet.get('F')!.clear();
          },
        }, 'plan-634-test');
        try {
          fleet.get('F')!.assign({ destination: 'S2', approach: 'reverse', serviceSec: 1 });
          every(() => { if (how === 'clear' && fired && leftAt < 0 && loc(w).path !== 'Turn2') leftAt = w.now(); });
          runUntil(w, () => (how === 'assign' ? newDone : leftAt >= 0));
          expect(fired).toBe(true);
          expect(reversed).toBe(false);
          if (how === 'assign') expect(newDone).toBe(true);
          else expect(leftAt).toBeGreaterThan(0); // cruises on instead of turning
          expect(mb.stats.turnGuardTrips).toBe(0);
          expect(mb.stats.dirRefused).toBe(0);
          expectClean(mb);
        } finally {
          w.dispose();
        }
      }, 180000);
    }

    it(`${mode} (b) negative test: rule off locally — the guard detects the overshoot and does nothing`, () => {
      stubLayout();
      const w = world(mode, 'L0', 3500);
      const { mb } = w;
      const internal = mb as unknown as { serviceReachCheck: boolean };
      let assigned = false;
      let expectedMm = Number.NaN;
      let tolMm = 1;
      let tripAt = -1;
      let posAtTrip = Number.NaN;
      let dirCallsAfterTrip = 0;
      const setDir = mb.setDirection.bind(mb);
      mb.setDirection = (id, dir, route = null) => {
        if (id === 'F' && tripAt >= 0) dirCallsAfterTrip++;
        return setDir(id, dir, route);
      };
      internal.serviceReachCheck = false;
      try {
        every(() => {
          if (!assigned) {
            const l = loc(w);
            if (l.path === 'Turn2' && l.rest < 0.7 && l.v > 1.0) {
              assigned = true;
              expectedMm = (l.s + (l.v * l.v) / (2 * DECEL) - 3) * 1000;
              // Continuous kernel: the vehicle's own time may lag the clock (plan-632) — tolerance v·dt.
              tolMm = mode === 'continuous' ? Math.max(1, l.v * TICK * 1000 + 1) : 1;
              getDefaultAgvFleet().get('F')!.assign({ destination: 'S2', approach: 'reverse', serviceSec: 1 });
            }
          }
          if (tripAt < 0 && mb.stats.turnGuardTrips > 0) {
            tripAt = w.now();
            posAtTrip = positionAt(mb.planOf('F')!.profile, w.now());
          }
        });
        runUntil(w, () => tripAt >= 0 && w.now() > tripAt + 20);
        expect(assigned).toBe(true);
        expect(mb.stats.serviceStopsMissed).toBe(0);         // the rule was off
        expect(mb.stats.serviceOvershoot).toBeGreaterThan(0); // the old overshoot happened
        expect(mb.stats.turnGuardTrips).toBe(1);
        expect(mb.stats.dirRefused).toBe(0);
        expect(dirCallsAfterTrip).toBe(0);                   // no further direction-change attempt
        expect(mb.planDirOf('F')).toBe(1);
        const pr = problemsOf('agv-turn-point-overshoot');
        expect(pr).toHaveLength(1);
        const mm = Number(/overshoot (-?\d+) mm/.exec(pr[0].detail)?.[1]);
        expect(expectedMm).toBeGreaterThan(100);
        expect(Math.abs(mm - expectedMm)).toBeLessThanOrEqual(tolMm);
        // No position change after the detection.
        expect(Math.abs(positionAt(mb.planOf('F')!.profile, w.now()) - posAtTrip)).toBeLessThan(1e-9);
        expect(loc(w).path).toBe('Turn2');
      } finally {
        internal.serviceReachCheck = true;
        w.dispose();
      }
    }, 180000);
  }
});

// ── 9.7 Reachable stops are unchanged ───────────────────────────────────────

describe('plan-634 9.7 — reachable stops unchanged', () => {
  for (const mode of MODES) {
    it(`${mode} (a) just enough braking distance, re-planned on every poll while braking`, () => {
      dockRing();
      // No docking crawl: the profile brakes with exactly the own deceleration — the rounding case.
      const w = world(mode, 'A0', 2000, { DockingDistance: 0 });
      const { mb } = w;
      let added = false;
      let calls = 0;
      let pose: { path: string; s: number } | null = null;
      let replansWhileBraking = 0;
      try {
        every(() => {
          if (calls > 0) return;
          const l = loc(w);
          const toEnd = l.rest + (l.path === 'A0' ? 0.4 : 0);
          if (!added) {
            if (l.path === 'A0' && toEnd >= BRAKE_M + 0.01 && toEnd < BRAKE_M + 0.12 && l.v > 1.1) {
              added = true;
              getDefaultPathDockRegistry().register('D1', {
                onVehicleArrive: (_v, release) => {
                  calls++;
                  const p = mb.locate('F', w.now())!;
                  pose = { path: p.path.id, s: p.s };
                  release();
                },
              });
              kick(w);
            }
          } else if (l.v > 1e-6) {
            replansWhileBraking++;
            kick(w);
          }
        });
        runUntil(w, () => calls > 0);
        expect(added).toBe(true);
        expect(replansWhileBraking).toBeGreaterThan(20);
        expect(calls).toBe(1);
        expect(pose!.path).toBe('D1');
        expect(Math.abs(pose!.s - 0.4)).toBeLessThanOrEqual(1e-3);
        expect(mb.stats.serviceStopsMissed).toBe(0);
        expect(mb.stats.serviceUndershoot).toBe(0);
        expectClean(mb);
      } finally {
        w.dispose();
      }
    }, 180000);

    it(`${mode} (b) standing at the stop: a task to the piece is served at once`, () => {
      spur();
      const w = world(mode, 'E0', 0);
      const { mb } = w;
      let assignedAt = -1;
      let arrivedAt = -1;
      try {
        every(() => {
          if (assignedAt >= 0 || w.now() < 5) return;
          if (loc(w).path === 'Y' && mb.speedOf('F', w.now()) < 1e-9) {
            assignedAt = w.now();
            getDefaultAgvFleet().get('F')!.assign({ destination: 'Y', serviceSec: 1, onArrive: () => { arrivedAt = w.now(); } });
          }
        });
        runUntil(w, () => arrivedAt >= 0);
        expect(assignedAt).toBeGreaterThan(0);
        expect(arrivedAt - assignedAt).toBeLessThan(0.1);
        expect(mb.stats.serviceStopsMissed).toBe(0);
        expectClean(mb);
      } finally {
        w.dispose();
      }
    }, 180000);

    it(`${mode} (c) docks in the plan from the start: braked in time`, () => {
      dockRing();
      const calls: Record<string, number> = { D1: 0, D2: 0 };
      for (const id of ['D1', 'D2']) {
        getDefaultPathDockRegistry().register(id, { onVehicleArrive: (_v, release) => { calls[id]++; release(); } });
      }
      const w = world(mode, 'A0', 2000);
      const { mb } = w;
      let onA1 = false;
      try {
        every(() => { if (loc(w).path === 'A1') onA1 = true; });
        runUntil(w, () => onA1);
        expect(onA1).toBe(true);
        expect(calls).toEqual({ D1: 1, D2: 1 });
        expect(mb.stats.serviceStopsMissed).toBe(0);
        expectClean(mb);
      } finally {
        w.dispose();
      }
    }, 180000);
  }
});

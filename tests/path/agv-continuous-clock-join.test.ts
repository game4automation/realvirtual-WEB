// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-632 §9 — continuous AGV fleet: ONE tick time per fixed step (#202).
 *
 * Before plan-632 every vehicle advanced the shared authority clock itself, so
 * vehicle i was drawn at (n+i)·dt, and a vehicle re-planned inside a later
 * vehicle's advance was synced BEFORE its new plan start t0 (clamped → a
 * one-tick jump of +25.03 mm in AGVDemo). The fix ("bk"): per fixed step the
 * inputs of all vehicles, ONE `clock.advanceTo(now + dt)`, then sync / pose /
 * signals of all at the same `clock.now`; the step key is the host's
 * `fixedStepCount` ({@link stepFleet}).
 *
 * The cases come from the plan-632 spike (C1 re-plan at a piece boundary, C2 a
 * vehicle skips ticks, C3 mixed fleet with a legacy vehicle, lifecycle). The
 * acceptance is EQUALITY of the drawn pose to the analytic plan location
 * `mb.locate(id, clock.now)` after every fixed step (1 µm), not a step bound.
 * The last block pins the restricted fallback contract of a host WITHOUT
 * `fixedStepCount` — including its one known lost step (C2).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { iterateFixedUpdate, type BindContextHandle } from '../../src/core/behavior-runtime';
import { getDefaultMovementAuthority, type MovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { setSignalLiveControlled } from '../../src/core/engine/rv-live-control';
import type { RVPath } from '../../src/core/engine/rv-path';
import { getDefaultAgvFleet, type AgvTravelerState } from '../../src/core/engine/rv-agv-fleet';
import { agvFleetStepDiagnostics } from '../../src/behaviors/Agv';
import {
  TICK, makeHost, makeAgvRoot, bindContinuous, clearShared, footprint, satOverlap, centredBody, stepFleet,
  type AgvTestHost,
} from '../helpers/agv-harness';
import { stubLayout, carCfg, delay } from '../helpers/agv-stub-world';

/** Pose equality to the analytic plan location (mm). */
const POSE_EPS_MM = 1e-3;
/** Clock advance equality to dt (s). */
const CLOCK_EPS = 1e-12;

// ── Introspection of the authority's vehicle records (read only) ───────────

interface HostLike { onHandOver?: (prev: RVPath, next: RVPath) => void }
interface VehicleRec { host: HostLike; curIdx: number; plan: { route: { path: { id: string } }[] }; usedLeaders: Map<string, number> }
const recOf = (mb: MovementAuthority, id: string): VehicleRec | undefined =>
  (mb as unknown as { vehicles: Map<string, VehicleRec> }).vehicles.get(id);

interface VStat {
  maxErrMm: number; samples: number;
  sBackwards: number; nonSuccessor: number; pathChanges: number;
  handovers: string[]; chainBreaks: number; dupHandovers: number;
  replanPlusHandover: number; curIdxBack: number; curPathMismatch: number;
}

/** Per-step meter: drawn pose vs `locate(id, clock.now)`, monotony, handovers, clock advance. */
class Meter {
  readonly v = new Map<string, VStat>();
  /** Steps whose clock advance differs from dt, as `k:advance/dt`. */
  readonly badClock: string[] = [];
  /** Steps in which not all members were synced at clock.now. */
  readonly skewedSteps: string[] = [];
  steps = 0;
  private prevNow: number | null = null;
  private readonly prev = new Map<string, { path: RVPath | null; s: number; ver: number; nHand: number; cur: number }>();
  private readonly wrapped = new WeakSet<object>();
  constructor(private readonly mb: MovementAuthority, private readonly roots: Map<string, Object3D>) {}

  stat(id: string): VStat {
    let s = this.v.get(id);
    if (!s) {
      s = { maxErrMm: 0, samples: 0, sBackwards: 0, nonSuccessor: 0, pathChanges: 0, handovers: [], chainBreaks: 0,
        dupHandovers: 0, replanPlusHandover: 0, curIdxBack: 0, curPathMismatch: 0 };
      this.v.set(id, s);
    }
    return s;
  }

  /** Wrap the vehicle's host.onHandOver (lazily — a re-registration creates a new host). */
  private wrap(id: string): void {
    const rec = recOf(this.mb, id);
    if (!rec || this.wrapped.has(rec.host)) return;
    this.wrapped.add(rec.host);
    const orig = rec.host.onHandOver;
    const st = this.stat(id);
    rec.host.onHandOver = (prev, next) => {
      const last = st.handovers[st.handovers.length - 1];
      if (last && last !== '|') {
        const [lp, ln] = last.split('>');
        if (ln !== prev.id) st.chainBreaks++;
        if (lp === prev.id && ln === next.id) st.dupHandovers++;
      }
      st.handovers.push(`${prev.id}>${next.id}`);
      orig?.(prev, next);
    };
  }

  arm(ids: Iterable<string>): void { for (const id of ids) this.wrap(id); }

  /** A removed / reset vehicle starts a fresh chain. */
  drop(id: string): void { this.prev.delete(id); this.stat(id).handovers.push('|'); }

  /** After one fixed step `k`: sample the observed vehicles. */
  sample(k: number, ids: Iterable<string>): void {
    const mb = this.mb;
    const now = mb.clock.now;
    const d = now - (this.prevNow ?? 0);
    if (Math.abs(d - TICK) > CLOCK_EPS) this.badClock.push(`k${k}:${(d / TICK).toFixed(3)}`);
    this.prevNow = now;
    this.steps++;
    const sync = agvFleetStepDiagnostics().syncTimes;
    for (const id of ids) {
      this.wrap(id);
      const st = this.stat(id);
      const loc = mb.locate(id, now);
      if (!loc) continue;
      if (sync[id] !== now) this.skewedSteps.push(`k${k}:${id}:${sync[id]}!=${now}`);
      const ref = loc.path.getAbsPosition(loc.s, new Vector3());
      const err = this.roots.get(id)!.position.distanceTo(ref) * 1000;
      if (err > st.maxErrMm) st.maxErrMm = err;
      st.samples++;
      const rec = recOf(mb, id)!;
      const t = (rec as unknown as { traveler?: { path: RVPath | null; s: number } }).traveler;
      const path = t?.path ?? null;
      const s = t?.s ?? 0;
      if (rec.plan.route[rec.curIdx]?.path.id !== path?.id) st.curPathMismatch++;
      const ver = mb.versionOf(id);
      const p = this.prev.get(id);
      if (p) {
        if (path && p.path && path.id === p.path.id && s < p.s - 1e-9) st.sBackwards++;
        if (path && p.path && path.id !== p.path.id) {
          st.pathChanges++;
          if (!p.path.successorIds.includes(path.id)) st.nonSuccessor++;
        }
        if (ver !== p.ver && st.handovers.length !== p.nHand) st.replanPlusHandover++;
        if (ver === p.ver && rec.curIdx < p.cur) st.curIdxBack++;
      }
      this.prev.set(id, { path, s, ver, nHand: st.handovers.length, cur: rec.curIdx });
    }
  }
}

// ── A small continuous world on the stub ring (short pieces) ───────────────

interface Ev { emit(e: string): void }
/** makeHost() plus an event emitter the test can fire (simulation-reset / -start). */
function hostWithEvents(): AgvTestHost & Ev {
  const base = makeHost();
  const subs = new Map<string, Set<(...a: unknown[]) => void>>();
  return Object.assign(base, {
    on: (e: string, cb: (...a: unknown[]) => void) => {
      let s = subs.get(e); if (!s) { s = new Set(); subs.set(e, s); }
      s.add(cb); return () => { s!.delete(cb); };
    },
    emit: (e: string) => { subs.get(e)?.forEach((cb) => cb()); },
  });
}

interface World {
  mb: MovementAuthority;
  host: AgvTestHost & Ev;
  roots: Map<string, Object3D>;
  handles: Map<string, BindContextHandle>;
  /** Run-edge re-plan requests: clock time of the request minus the step's start time (s). */
  runMarks: { k: number; id: string; lag: number }[];
  bind(name: string, cfg: Record<string, unknown>): void;
  /** One fixed step: keyed (stepFleet, default) or by direct per-handle calls (fallback). */
  step(k: number): void;
  restore(): void;
}

/** Ring with short pieces (preLen 0.5 m); vehicles bound in `specs` order (= iteration order). */
function world(specs: [string, Record<string, unknown>][], keyed = true): World {
  stubLayout({ preLen: 0.5, split: false });
  const host = hostWithEvents();
  const roots = new Map<string, Object3D>();
  const handles = new Map<string, BindContextHandle>();
  const mb = getDefaultMovementAuthority('continuous');
  const runMarks: World['runMarks'] = [];
  let curK = 0;
  let stepStart = 0;
  const m = mb as unknown as Record<string, unknown>;
  const proto = Object.getPrototypeOf(mb) as { markDirty(id: string, why?: string): void };
  m.markDirty = function (this: MovementAuthority, id: string, why?: string): void {
    if (why === 'run') runMarks.push({ k: curK, id, lag: this.clock.now - stepStart });
    proto.markDirty.call(this, id, why);
  };
  const w: World = {
    mb, host, roots, handles, runMarks,
    bind: (name, cfg) => { const r = makeAgvRoot(name, cfg); roots.set(name, r); handles.set(name, bindContinuous(r, host)); },
    step: (k) => {
      curK = k;
      stepStart = mb.clock.now;
      if (keyed) stepFleet(host, handles.values(), TICK);
      else for (const h of handles.values()) iterateFixedUpdate(h, TICK);
    },
    restore: () => { delete m.markDirty; for (const h of handles.values()) h.dispose(); },
  };
  for (const [n, c] of specs) w.bind(n, c);
  return w;
}

/** The parked timer vehicles {@link delay} uses (Clock0..3 on Park0..3). */
function bindClocks(w: World): void {
  for (let k = 0; k < 4; k++) {
    w.bind(`Clock${k}`, { PathId: `Park${k}`, StartPosition: 4000, VehicleLength: 1000, VehicleWidth: 600, ScannerFields: false });
  }
}

/** The common acceptance of a planned vehicle's run: pose == locate, monotonic, handover exactly once. */
function expectClean(meter: Meter, ids: string[]): void {
  for (const id of ids) {
    const st = meter.v.get(id)!;
    expect(st.samples, `${id} sampled`).toBeGreaterThan(0);
    expect(st.maxErrMm, `${id} pose == locate(now)`).toBeLessThan(POSE_EPS_MM);
    expect(st.sBackwards, `${id} s monotonic`).toBe(0);
    expect(st.curIdxBack, `${id} curIdx monotonic`).toBe(0);
    expect(st.curPathMismatch, `${id} route[curIdx] == traveler.path`).toBe(0);
    expect(st.nonSuccessor, `${id} successor-only path changes`).toBe(0);
    expect(st.dupHandovers + st.chainBreaks, `${id} handover exactly once`).toBe(0);
    expect(st.handovers.filter((h) => h !== '|').length, `${id} handovers == path changes`).toBe(st.pathChanges);
  }
}

beforeEach(() => clearShared());
afterEach(() => { clearShared(); vi.restoreAllMocks(); });

// ── F1: one time per step ─────────────────────────────────────────────────

describe('plan-632 F1 — one shared sync time per fixed step', () => {
  it('after every step all vehicles are synced at clock.now, the clock advances exactly dt', () => {
    const w = world([['F', carCfg('L0', 0)], ['M', carCfg('L0', 2500)], ['Lead', carCfg('L0', 5000, { TargetSpeed: 600 })]]);
    const meter = new Meter(w.mb, w.roots);
    let end = Number.NaN;
    let d: ReturnType<typeof agvFleetStepDiagnostics>;
    try {
      for (let k = 1; k <= 600; k++) { w.step(k); meter.sample(k, ['F', 'M', 'Lead']); }
      end = w.mb.clock.now; // before the dispose (the last vehicle leaving resets the clock)
      d = agvFleetStepDiagnostics();
    } finally { w.restore(); }
    expect(meter.skewedSteps, 'sync time != clock.now').toEqual([]);
    expect(meter.badClock, 'clock advance != dt').toEqual([]);
    expect(end).toBeCloseTo(600 * TICK, 9);
    expect(d!.advances, 'one advance per step').toBe(600);
    expect(d!.keyedSteps).toBe(600);
    expect(d!.fallbackSteps).toBe(0);
    expect(d!.fallbackWarned).toBe(false);
  });

  it('the first step starts at clock 0 for every vehicle (no join offset)', () => {
    const w = world([['A', carCfg('L0', 0)], ['B', carCfg('L0', 2500)], ['C', carCfg('L0', 5000)]]);
    try {
      expect(w.mb.clock.now).toBe(0);
      w.step(1);
      const sync = agvFleetStepDiagnostics().syncTimes;
      expect(Object.keys(sync).sort()).toEqual(['A', 'B', 'C']);
      for (const id of ['A', 'B', 'C']) expect(sync[id], id).toBe(TICK);
      expect(w.mb.clock.now).toBe(TICK);
    } finally { w.restore(); }
  });
});

// ── F1/F2: follow-up travel with dependent re-plans ───────────────────────

describe('plan-632 F1/F2 — following with dependent re-plans', () => {
  it('pose == locate(now) every step, no sync before t0, while the leader re-plans its followers', () => {
    // Follower FIRST in the iteration order (as AGV_1 in AGVDemo), slow leader last; the
    // leader's Run off/on re-plans the followers inside the step (the #202 trigger).
    const w = world([['F', carCfg('L0', 0)], ['M', carCfg('L0', 2500)], ['Lead', carCfg('L0', 5000, { TargetSpeed: 600 })]]);
    bindClocks(w);
    const meter = new Meter(w.mb, w.roots);
    meter.arm(['F', 'M', 'Lead']);
    let dependentReplans = 0;
    try {
      for (let k = 1; k <= Math.round(30 / TICK); k++) {
        if (k % Math.round(4 / TICK) === 0) {
          w.host.signalStore!.set('Lead.Agv.Run', false);
          delay(0.7, () => w.host.signalStore!.set('Lead.Agv.Run', true));
        }
        const vF = w.mb.versionOf('F');
        w.step(k);
        if (w.mb.versionOf('F') !== vF && recOf(w.mb, 'F')?.usedLeaders.size) dependentReplans++;
        meter.sample(k, ['F', 'M', 'Lead']);
      }
    } finally { w.restore(); }
    expect(dependentReplans, 'precondition: F was re-planned against a leader').toBeGreaterThan(0);
    expect(agvFleetStepDiagnostics().syncBeforeT0, 'syncs before the plan start t0').toBe(0);
    expect(meter.skewedSteps).toEqual([]);
    expect(meter.badClock).toEqual([]);
    expectClean(meter, ['F', 'M', 'Lead']);
  });
});

// ── C1: re-plan exactly at a piece boundary ──────────────────────────────

describe('plan-632 C1 — re-plan at a piece boundary (SOL #4)', () => {
  it('curIdx / s monotonic, handover exactly once, pose == locate — the coincidence happened', () => {
    // The leader's Run edge is fired in the step in which the follower crosses onto the
    // next (short) piece: the follower's dependent re-plan and its handover share ONE step.
    const w = world([['F', carCfg('L0', 0)], ['Lead', carCfg('L0', 2500, { TargetSpeed: 800 })]]);
    const meter = new Meter(w.mb, w.roots);
    meter.arm(['F', 'Lead']);
    let lastToggle = -1000, runOn = true;
    try {
      for (let k = 1; k <= 3600; k++) {
        const rec = recOf(w.mb, 'F');
        const t = (rec as unknown as { traveler?: { path: RVPath | null; s: number } } | undefined)?.traveler;
        if (t?.path && k - lastToggle > 20) {
          const rem = t.path.length - t.s;
          const v = w.mb.speedOf('F', w.mb.clock.now);
          if (v > 0.05 && rem > 0 && rem < v * TICK * 0.999) {
            runOn = !runOn;
            w.host.signalStore!.set('Lead.Agv.Run', runOn);
            lastToggle = k;
          }
        }
        // never leave the leader parked for long
        if (!runOn && k - lastToggle > 45) { runOn = true; w.host.signalStore!.set('Lead.Agv.Run', true); lastToggle = k; }
        w.step(k);
        meter.sample(k, ['F', 'Lead']);
      }
    } finally { w.restore(); }
    expect(meter.v.get('F')!.replanPlusHandover, 'precondition: re-plan + handover in one step occurred').toBeGreaterThan(0);
    expect(agvFleetStepDiagnostics().syncBeforeT0).toBe(0);
    expect(meter.badClock).toEqual([]);
    expectClean(meter, ['F', 'Lead']);
  });
});

// ── C2: a vehicle skips ticks ────────────────────────────────────────────

/** C2 run: W (iterated first) skips 120..150, Q skips 400..430 (live-controlled → fixedUpdate silent). */
function runC2(keyed: boolean): { meter: Meter; resumeErrMm: number[] } {
  const w = world([['W', carCfg('L0', 5000)], ['Q', carCfg('L0', 0)]], keyed);
  const meter = new Meter(w.mb, w.roots);
  meter.arm(['W', 'Q']);
  const skips: [string, number, number][] = [['W', 120, 150], ['Q', 400, 430]];
  const resumeErrMm: number[] = [];
  try {
    for (let k = 1; k <= 1200; k++) {
      const skipped = new Set<string>();
      for (const [id, a, b] of skips) {
        if (k === a) setSignalLiveControlled(`${id}.Agv.Run`, true);
        if (k === b + 1) { setSignalLiveControlled(`${id}.Agv.Run`, false); meter.drop(id); }
        if (k >= a && k <= b) skipped.add(id);
      }
      w.step(k);
      meter.sample(k, ['W', 'Q'].filter((id) => !skipped.has(id)));
      for (const [id, , b] of skips) {
        if (k === b + 1 || k === b + 10) {
          const loc = w.mb.locate(id, w.mb.clock.now)!;
          resumeErrMm.push(w.roots.get(id)!.position.distanceTo(loc.path.getAbsPosition(loc.s, new Vector3())) * 1000);
        }
      }
    }
  } finally {
    for (const [id] of skips) setSignalLiveControlled(`${id}.Agv.Run`, false);
    w.restore();
  }
  return { meter, resumeErrMm };
}

describe('plan-632 C2 — a vehicle skips ticks and resumes (F4)', () => {
  it('after the resume the pose == locate, the clock never stands still', () => {
    const { meter, resumeErrMm } = runC2(true);
    expect(resumeErrMm).toHaveLength(4);
    for (const e of resumeErrMm) expect(e, 'error after the resume').toBeLessThan(POSE_EPS_MM);
    expect(meter.badClock, 'clock advance != dt').toEqual([]);
    expect(meter.skewedSteps).toEqual([]);
    expect(agvFleetStepDiagnostics().advances).toBe(1200);
    for (const id of ['W', 'Q']) expect(meter.v.get(id)!.maxErrMm, id).toBeLessThan(POSE_EPS_MM);
  });
});

// ── C3: mixed fleet ──────────────────────────────────────────────────────

interface C3Run { lags: number[]; overlapFrames: number; legBack: number; stops: string[]; meter: Meter; runEdges: number }

/** C3: a LEGACY vehicle between two planned ones; Run edges of the first / last iterated vehicle. */
function runC3(order: string[]): C3Run {
  const cfgs: Record<string, Record<string, unknown>> = {
    P1: carCfg('L0', 0),
    Leg: carCfg('L0', 3000, { UseAcceleration: false, TargetSpeed: 600 }),
    P2: carCfg('L0', 6000),
  };
  const w = world(order.map((id) => [id, cfgs[id]]));
  const meter = new Meter(w.mb, w.roots);
  meter.arm(['P1', 'P2']);
  const body = centredBody(1.2, 0.8);
  const ids = ['P1', 'Leg', 'P2'];
  let overlapFrames = 0, legBack = 0;
  let legPrev: { p: string; s: number } | null = null;
  const legState: AgvTravelerState = { path: null, s: 0, speed: 0, atEnd: false };
  const stops: string[] = [];
  const script: Record<number, [string, boolean][]> = {
    300: [['P2', false]], 480: [['P2', true]],
    700: [['P1', false]], 880: [['P1', true]],
    1100: [['P1', false], ['P2', false]], 1280: [['P1', true], ['P2', true]],
  };
  const stopAt: Record<number, string[]> = { 450: ['P2'], 850: ['P1'], 1250: ['P1', 'P2'] };
  try {
    for (let k = 1; k <= 1500; k++) {
      for (const [id, on] of script[k] ?? []) w.host.signalStore!.set(`${id}.Agv.Run`, on);
      w.step(k);
      meter.sample(k, ['P1', 'P2']);
      const fp = ids.map((id) => footprint(w.roots.get(id)!, body));
      let hit = false;
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (satOverlap(fp[i], fp[j]) > 1e-6) hit = true;
      if (hit) overlapFrames++;
      getDefaultAgvFleet().get('Leg')!.travelerState!(legState);
      const lp = legState.path?.id ?? '';
      if (legPrev && legPrev.p === lp && legState.s < legPrev.s - 1e-9) legBack++;
      legPrev = { p: lp, s: legState.s };
      for (const id of stopAt[k] ?? []) {
        const p = w.roots.get(id)!.position;
        stops.push(`${id}@k${k}=${p.x.toFixed(9)},${p.z.toFixed(9)}`);
      }
    }
  } finally { w.restore(); }
  return { lags: w.runMarks.map((r) => r.lag), overlapFrames, legBack, stops, meter, runEdges: w.runMarks.length };
}

describe('plan-632 C3 — mixed fleet (SOL #3)', () => {
  it('Run-edge latency 0 independent of the iteration order, no legacy overlap, same stop poses', () => {
    const fwd = runC3(['P1', 'Leg', 'P2']);
    clearShared();
    const rev = runC3(['P2', 'Leg', 'P1']);
    for (const r of [fwd, rev]) {
      expect(r.runEdges, 'precondition: the Run edges were observed').toBeGreaterThanOrEqual(8);
      for (const lag of r.lags) expect(Math.abs(lag), 'Run-edge re-plan at the step start time').toBeLessThan(CLOCK_EPS);
      expect(r.overlapFrames, 'SAT overlap frames').toBe(0);
      expect(r.legBack, 'legacy vehicle never moves backwards').toBe(0);
      expect(r.meter.badClock).toEqual([]);
      expect(r.meter.skewedSteps).toEqual([]);
      for (const id of ['P1', 'P2']) expect(r.meter.v.get(id)!.maxErrMm, id).toBeLessThan(POSE_EPS_MM);
    }
    expect(fwd.stops.length).toBe(4);
    expect(rev.stops, 'stop poses independent of the iteration order').toEqual(fwd.stops);
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────

describe('plan-632 lifecycle — pause, late join, remove / rejoin, reset (F4)', () => {
  it('pose == locate(now) for every vehicle through the whole script', () => {
    const w = world([['F', carCfg('L0', 0)], ['M', carCfg('L0', 2500)], ['Lead', carCfg('L0', 5000, { TargetSpeed: 600 })]]);
    bindClocks(w);
    const meter = new Meter(w.mb, w.roots);
    const observed = new Set(['F', 'M', 'Lead']);
    meter.arm(observed);
    const events: string[] = [];
    try {
      for (let k = 1; k <= Math.round(30 / TICK); k++) {
        if (k === Math.round(3 / TICK)) {
          w.host.signalStore!.set('Lead.Agv.Run', false);
          delay(1.0, () => w.host.signalStore!.set('Lead.Agv.Run', true));
          events.push('pause');
        }
        if (k === Math.round(5 / TICK)) { w.bind('J', carCfg('R2', 20000)); observed.add('J'); meter.arm(['J']); events.push('join'); }
        if (k === Math.round(12 / TICK)) {
          w.handles.get('M')!.dispose(); w.handles.delete('M'); observed.delete('M'); meter.drop('M'); events.push('remove');
        }
        if (k === Math.round(14 / TICK)) { w.bind('M', carCfg('R3', 2000)); observed.add('M'); meter.arm(['M']); events.push('rejoin'); }
        if (k === Math.round(20 / TICK)) {
          w.host.emit('simulation-reset'); w.host.emit('simulation-start');
          for (const id of observed) meter.drop(id);
          events.push('reset');
        }
        w.step(k);
        meter.sample(k, observed);
      }
    } finally { w.restore(); }
    expect(events).toEqual(['pause', 'join', 'remove', 'rejoin', 'reset']);
    expect(meter.badClock, 'clock advance != dt').toEqual([]);
    expect(meter.skewedSteps).toEqual([]);
    expect(agvFleetStepDiagnostics().syncBeforeT0).toBe(0);
    for (const id of ['F', 'M', 'Lead', 'J']) {
      const st = meter.v.get(id)!;
      expect(st.samples, id).toBeGreaterThan(0);
      expect(st.maxErrMm, `${id} pose == locate(now)`).toBeLessThan(POSE_EPS_MM);
      expect(st.dupHandovers + st.chainBreaks, `${id} handover exactly once`).toBe(0);
    }
  });

  it('a vehicle bound during a running step joins at that step time without a second advance', () => {
    const w = world([['A', carCfg('L0', 0)], ['B', carCfg('L0', 3000)]]);
    try {
      for (let k = 1; k <= 30; k++) w.step(k);
      const before = agvFleetStepDiagnostics().advances;
      // One host step, and in the middle of it (after A drove the fleet step) a new vehicle binds.
      w.host.fixedStepCount = (w.host.fixedStepCount ?? 0) + 1;
      iterateFixedUpdate(w.handles.get('A')!, TICK);
      const now = w.mb.clock.now;
      w.bind('C', carCfg('R2', 20000));
      for (const h of w.handles.values()) if (h !== w.handles.get('A')) iterateFixedUpdate(h, TICK);
      const d = agvFleetStepDiagnostics();
      expect(d.advances - before, 'one advance for the step').toBe(1);
      expect(w.mb.clock.now).toBe(now);
      expect(d.syncTimes.C, 'C synced at the step time').toBe(now);
      const loc = w.mb.locate('C', now)!;
      expect(w.roots.get('C')!.position.distanceTo(loc.path.getAbsPosition(loc.s, new Vector3())) * 1000).toBeLessThan(POSE_EPS_MM);
      // ...and from the next step on it is a regular member.
      w.step(31);
      expect(agvFleetStepDiagnostics().syncTimes.C).toBe(w.mb.clock.now);
    } finally { w.restore(); }
  });

  it('a clock that runs backwards (authority cleared) starts a fresh step record', () => {
    const w = world([['A', carCfg('L0', 0)]]);
    try {
      for (let k = 1; k <= 20; k++) w.step(k);
      expect(agvFleetStepDiagnostics().advances).toBe(20);
      // The only vehicle leaves → the continuous clock resets to 0.
      w.handles.get('A')!.dispose(); w.handles.delete('A');
      expect(w.mb.clock.now).toBe(0);
      w.bind('A', carCfg('L0', 0));
      w.step(21);
      const d = agvFleetStepDiagnostics();
      expect(d.advances, 'fresh record: one advance').toBe(1);
      expect(w.mb.clock.now).toBe(TICK);
      expect(d.syncTimes.A).toBe(TICK);
    } finally { w.restore(); }
  });
});

// ── Restricted fallback contract (host without fixedStepCount) ───────────

describe('plan-632 fallback — a host without fixedStepCount (restricted contract)', () => {
  it('the repeat-caller heuristic is active and warns exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = world([['F', carCfg('L0', 0)], ['M', carCfg('L0', 2500)], ['Lead', carCfg('L0', 5000, { TargetSpeed: 600 })]], false);
    const meter = new Meter(w.mb, w.roots);
    try {
      for (let k = 1; k <= 300; k++) { w.step(k); meter.sample(k, ['F', 'M', 'Lead']); }
    } finally { w.restore(); }
    const d = agvFleetStepDiagnostics();
    expect(w.host.fixedStepCount).toBeUndefined();
    expect(d.fallbackSteps).toBe(300);
    expect(d.keyedSteps).toBe(0);
    expect(d.fallbackWarned).toBe(true);
    const ours = warn.mock.calls.filter((c) => String(c[0]).includes('provides no fixedStepCount'));
    expect(ours, 'one-time warning').toHaveLength(1);
    // Exact for a fleet in which every vehicle runs once per step:
    expect(meter.badClock).toEqual([]);
    expect(meter.skewedSteps).toEqual([]);
    for (const id of ['F', 'M', 'Lead']) expect(meter.v.get(id)!.maxErrMm, id).toBeLessThan(POSE_EPS_MM);
  });

  it('pins the known C2 loss: the leading vehicle skips → the fleet loses exactly ONE step', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { meter, resumeErrMm } = runC2(false);
    // W resumes at k151 behind Q's lead; when Q (now leading) goes silent at k400, the step
    // boundary slips once: no advance in that step. Known and accepted for hosts without the
    // step key (plan-632 §2); the viewer always provides it.
    expect(meter.badClock, 'steps whose clock advance != dt').toEqual(['k400:0.000']);
    expect(agvFleetStepDiagnostics().advances).toBe(1199);
    expect(w2mm(resumeErrMm)).toBeLessThan(POSE_EPS_MM);
    expect(meter.skewedSteps).toEqual([]);
  });
});

/** Largest entry (mm). */
function w2mm(errs: number[]): number { return Math.max(...errs); }

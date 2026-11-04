// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-559 §9.4 (SOL #4) — the FIRST dispatch of a freshly bound vehicle comes
 * from `AgvFleet.onRegister`, without any timer: the vehicle is `'cruising'`
 * (no task yet, so `onIdle` never fires for it) and gets its task synchronously
 * inside `register()`. Both bind orders — core first (subscriber already there)
 * and vehicles first (the core reads `all()` once, then `onRegister`) — plus a
 * DES re-bind with a fresh handle (no `fleet-id-collision`).
 *
 * Further Phase-1 seams on the real Agv:
 * - S1 `onTaskChanged`: a replacement requested during the reverse leg / the
 *   dock stay of a stub manoeuvre is reported `effective: false` first and
 *   `effective: true` when the manoeuvre applies it;
 * - S2 `AgvHandle.locate`: two vehicles on one path report different `s`, the
 *   value is the movement authority's `locate(id, now)`, not `traveler.s`;
 *   a legacy (step-mode) vehicle reports nothing.
 *
 * Sim time only — no wall clock, no timers; every "until" loop is bounded.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import {
  getDefaultAgvFleet, FLEET_ID_COLLISION_CODE,
  type AgvHandle, type AgvLocation, type AgvTask, type AgvTaskChange, type AgvTravelerState,
} from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultMovementAuthority, setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { iterateFixedUpdate, type BindContextHandle } from '../../src/core/behavior-runtime';
import { getProblems } from '../../src/core/hmi/problems-store';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { TICK, makeHost, makeAgvRoot, bindDes, bindContinuous, clearShared } from '../helpers/agv-harness';
import { stubLayout, makeStubWorld, forkCfg, FORK, FORK_MESH, delay } from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

// ── Lanes: per vehicle `In_<id>` (10 m) → `Dest_<id>` (3 m, dead end) — no interaction ──

function lanes(ids: string[]): void {
  const net = getDefaultPathNetwork();
  ids.forEach((id, i) => {
    const z = 5 * i;
    net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], id: `In_${id}`,
      segments: [{ kind: 'line', from: [0, 0, z], to: [10, 0, z] }], successors: [`Dest_${id}`] }, `In_${id}`)!);
    net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], id: `Dest_${id}`,
      segments: [{ kind: 'line', from: [10, 0, z], to: [13, 0, z] }], successors: [] }, `Dest_${id}`)!);
  });
  net.resolveGraph();
}

const laneCfg = (id: string): Record<string, unknown> =>
  ({ PathId: `In_${id}`, StartPosition: 1000, TargetSpeed: 1000, VehicleLength: 1000, VehicleWidth: 600 });

/**
 * A minimal fleet core: dispatches every cruising vehicle exactly once per
 * handle to its own `Dest_<id>` — from `all()` when it binds late, from
 * `onRegister` for every vehicle registered afterwards.
 */
interface Core {
  /** One entry per dispatch: the handle, its phase and whether it held a task BEFORE the assign. */
  dispatched: { handle: AgvHandle; phase: string; hadTask: boolean }[];
  /** Completed tasks (onServiceEnd) per vehicle id. */
  done: Map<string, number>;
  /** The task each dispatch assigned (same order as `dispatched`). */
  tasks: AgvTask[];
  bind(): void;
}

function makeCore(): Core {
  const fleet = getDefaultAgvFleet();
  const core: Core = {
    dispatched: [], done: new Map(), tasks: [],
    bind(): void {
      for (const h of fleet.all()) dispatch(h); // vehicles that were there before the core
      fleet.onRegister(dispatch);               // and every one registered afterwards
    },
  };
  function dispatch(h: AgvHandle): void {
    core.dispatched.push({ handle: h, phase: h.phase, hadTask: h.task !== null });
    if (h.phase !== 'cruising' || h.task !== null) return;
    const task: AgvTask = {
      destination: `Dest_${h.id}`, serviceSec: 1,
      onServiceEnd: (id) => { core.done.set(id, (core.done.get(id) ?? 0) + 1); },
    };
    core.tasks.push(task);
    h.assign(task);
  }
  return core;
}

const collisionEntries = (): string[] =>
  getProblems().filter((p) => p.code === FLEET_ID_COLLISION_CODE).map((p) => p.id);

function runDes(runner: DESRunner, until: () => boolean, maxSec = 60): void {
  for (let f = 0; f < Math.round(maxSec / TICK) && !until(); f++) { runner.tick(TICK); runner.lateTick(TICK); }
}

describe('plan-559 9.4 — first dispatch through onRegister (no timer)', () => {
  it('DES, core first: each vehicle gets its task inside register() while cruising', () => {
    const ids = ['V1', 'V2'];
    lanes(ids);
    const fleet = getDefaultAgvFleet();
    const core = makeCore();
    core.bind();                                    // nothing registered yet
    expect(core.dispatched).toEqual([]);
    const host = makeHost();
    const runner = new DESRunner({ subMode: 'animated' });
    for (const id of ids) bindDes(runner, makeAgvRoot(id, laneCfg(id)), host);
    runner.start([], { root: new Object3D() });
    // Synchronously in register() (the runner's setup), before any tick:
    expect(core.dispatched.map((d) => [d.handle.id, d.phase, d.hadTask])).toEqual([['V1', 'cruising', false], ['V2', 'cruising', false]]);
    expect(ids.map((id) => fleet.get(id)!.task)).toEqual(core.tasks);
    expect(ids.map((id) => fleet.get(id)!.phase)).toEqual(['driving', 'driving']);
    runDes(runner, () => ids.every((id) => core.done.get(id) === 1));
    expect(ids.map((id) => core.done.get(id) ?? 0)).toEqual([1, 1]);
    expect(ids.map((id) => fleet.get(id)!.phase)).toEqual(['idle', 'idle']);
    runner.dispose();
  }, 120000);

  it('DES, vehicles first: the late core dispatches from all() once, never twice', () => {
    const ids = ['V1', 'V2'];
    lanes(ids);
    const fleet = getDefaultAgvFleet();
    const host = makeHost();
    const runner = new DESRunner({ subMode: 'animated' });
    for (const id of ids) bindDes(runner, makeAgvRoot(id, laneCfg(id)), host);
    runner.start([], { root: new Object3D() });
    expect(ids.map((id) => fleet.get(id)!.phase)).toEqual(['cruising', 'cruising']);
    const core = makeCore();
    core.bind();
    expect(core.dispatched.map((d) => [d.handle.id, d.phase])).toEqual([['V1', 'cruising'], ['V2', 'cruising']]);
    expect(ids.map((id) => fleet.get(id)!.task)).toEqual(core.tasks);
    runDes(runner, () => ids.every((id) => core.done.get(id) === 1));
    expect(ids.map((id) => core.done.get(id) ?? 0)).toEqual([1, 1]);
    expect(core.dispatched).toHaveLength(2);        // no replay through onRegister
    runner.dispose();
  }, 120000);

  it('continuous, mixed order: one vehicle before the core, one after — each dispatched exactly once', () => {
    const ids = ['V1', 'V2'];
    lanes(ids);
    const fleet = getDefaultAgvFleet();
    const host = makeHost();
    const handles: BindContextHandle[] = [bindContinuous(makeAgvRoot('V1', laneCfg('V1')), host)];
    const core = makeCore();
    core.bind();                                    // V1 from all()
    handles.push(bindContinuous(makeAgvRoot('V2', laneCfg('V2')), host)); // V2 through onRegister
    expect(core.dispatched.map((d) => [d.handle.id, d.phase, d.hadTask])).toEqual([['V1', 'cruising', false], ['V2', 'cruising', false]]);
    expect(ids.map((id) => fleet.get(id)!.task)).toEqual(core.tasks);
    for (let f = 0; f < Math.round(60 / TICK) && !ids.every((id) => core.done.get(id) === 1); f++) {
      for (const h of handles) iterateFixedUpdate(h, TICK);
    }
    expect(ids.map((id) => core.done.get(id) ?? 0)).toEqual([1, 1]);
    expect(core.dispatched).toHaveLength(2);
    for (const h of handles) h.dispose();
  }, 120000);

  it('DES re-bind with a fresh handle: dispatched again through onRegister, no id collision', () => {
    lanes(['V1']);
    const fleet = getDefaultAgvFleet();
    const core = makeCore();
    core.bind();
    const host = makeHost();
    const root = makeAgvRoot('V1', laneCfg('V1'));

    let runner = new DESRunner({ subMode: 'animated' });
    bindDes(runner, root, host);
    runner.start([], { root: new Object3D() });
    const first = fleet.get('V1')!;
    runDes(runner, () => core.done.get('V1') === 1);
    expect(core.done.get('V1')).toBe(1);
    runner.dispose();

    runner = new DESRunner({ subMode: 'animated' });
    bindDes(runner, root, host);                    // same root → same fleet id, fresh self + handle
    runner.start([], { root: new Object3D() });
    const second = fleet.get('V1')!;
    expect(second).not.toBe(first);
    expect(core.dispatched.map((d) => [d.handle, d.phase, d.hadTask])).toEqual([[first, 'cruising', false], [second, 'cruising', false]]);
    expect(second.task).toBe(core.tasks[1]);
    expect(collisionEntries()).toEqual([]);         // a re-bind of the same vehicle is no collision
    runDes(runner, () => core.done.get('V1') === 2);
    expect(core.done.get('V1')).toBe(2);
    runner.dispose();
  }, 120000);
});

// ── S1: onTaskChanged during a stub manoeuvre (plan-595 world) ───────────────

type When = 'reverse' | 'dock';

interface TaskEvent { t: number; task: AgvTask | null; effective: boolean; current: AgvTask | null }

function runReplacement(when: When): {
  events: TaskEvent[]; reverseTask: AgvTask; replacement: AgvTask; abortAt: number;
  locAtAbort: { ok: boolean; loc: AgvLocation; planDir: number }; replacementDone: boolean;
} {
  stubLayout();
  const w = makeStubWorld('animated', [{ name: 'F', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, body: FORK }], 400);
  const fleet = getDefaultAgvFleet();
  const events: TaskEvent[] = [];
  fleet.onTaskChanged((id: string, c: AgvTaskChange) => {
    if (id === 'F') events.push({ t: w.now(), task: c.requested, effective: c.effective, current: fleet.get('F')!.task });
  });
  let replacementDone = false;
  const replacement: AgvTask = { destination: 'L2', serviceSec: 1, onServiceEnd: () => { replacementDone = true; } };
  const reverseTask: AgvTask = { destination: 'S2', approach: 'reverse' };
  let abortAt = -1;
  const locAtAbort = { ok: false, loc: { pathId: '', s: Number.NaN, dir: 1, t: Number.NaN } as AgvLocation, planDir: 0 };
  const abort = (): void => {
    if (abortAt >= 0) return;
    abortAt = w.now();
    locAtAbort.ok = fleet.get('F')!.locate!(locAtAbort.loc);
    locAtAbort.planDir = w.mb.planDirOf('F');
    fleet.get('F')!.assign(replacement);
  };
  getDefaultPathDockRegistry().register('S2', {
    onVehicleArrive: (_id, release) => {
      if (when === 'dock') { delay(5, abort); delay(10, release); } // the late release is void
      else delay(8, release);
    },
  });
  getDefaultPathNetwork().setRouter({
    onArrive: (pathId, id) => { if (id === 'F' && when === 'reverse' && pathId === 'Turn2') delay(3, abort); },
  }, 'fleet-first-dispatch');
  fleet.get('F')!.assign(reverseTask);
  while (!w.done() && !replacementDone) w.step();
  w.dispose();
  return { events, reverseTask, replacement, abortAt, locAtAbort, replacementDone };
}

describe('plan-559 S1 — onTaskChanged reports requested and effective', () => {
  it('replacement during the reverse leg: effective:false at the request, effective:true later at the handling position', () => {
    const r = runReplacement('reverse');
    expect(r.replacementDone).toBe(true);
    expect(r.abortAt).toBeGreaterThan(0);
    expect(r.events.map((e) => [e.task, e.effective])).toEqual([
      [r.reverseTask, true],    // no manoeuvre yet: applied at once
      [r.replacement, false],   // held back — the vehicle reverses on to the handling position
      [r.replacement, true],    // applied when the manoeuvre ends
    ]);
    expect(r.events[1].t).toBe(r.abortAt);
    expect(r.events[1].current).toBe(r.reverseTask);  // still the old task while deferred
    expect(r.events[2].t).toBeGreaterThan(r.abortAt);  // later, in sim time
    expect(r.events[2].current).toBe(r.replacement);
    // S2 on a reverse leg: the plan's direction, consistent with the authority.
    expect(r.locAtAbort.ok).toBe(true);
    expect(r.locAtAbort.planDir).toBe(-1);
    expect(r.locAtAbort.loc.dir).toBe(-1);
    expect(r.locAtAbort.loc.t).toBe(r.abortAt);
  }, 120000);

  it('replacement during the dock stay: the stay ends at once — effective:false, then effective:true at the same instant', () => {
    const r = runReplacement('dock');
    expect(r.replacementDone).toBe(true);
    expect(r.events.map((e) => [e.task, e.effective])).toEqual([
      [r.reverseTask, true],
      [r.replacement, false],
      [r.replacement, true],
    ]);
    expect(r.events[1].t).toBe(r.abortAt);
    expect(r.events[2].t).toBe(r.abortAt);
    expect(r.events[2].current).toBe(r.replacement);
  }, 120000);
});

// ── S2: locate from the plan / clock state ───────────────────────────────────

describe('plan-559 S2 — AgvHandle.locate', () => {
  function longLine(): void {
    const net = getDefaultPathNetwork();
    net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], id: 'Long',
      segments: [{ kind: 'line', from: [0, 0, 0], to: [80, 0, 0] }] }, 'Long')!);
    net.resolveGraph();
  }

  it('DES: two vehicles on one path report different s — the authority locate(id, now), not traveler.s', () => {
    longLine();
    const fleet = getDefaultAgvFleet();
    const host = makeHost();
    const runner = new DESRunner({ subMode: 'animated' });
    bindDes(runner, makeAgvRoot('Lead', { PathId: 'Long', StartPosition: 8000, VehicleLength: 1000, VehicleWidth: 600 }), host);
    bindDes(runner, makeAgvRoot('Follow', { PathId: 'Long', StartPosition: 2000, VehicleLength: 1000, VehicleWidth: 600 }), host);
    runner.start([], { root: new Object3D() });
    // The DES clock (`currentTime`) stands on EVENT times — between events only
    // the runner's render clock moves. Run until the first model event after the
    // start has been processed (bounded), so `now` is a real event time > 0 at
    // which both vehicles have moved away from their start positions.
    runDes(runner, () => runner.getManager().currentTime > 0, 30);
    const mb = getDefaultMovementAuthority('des');
    const now = runner.getManager().currentTime;
    expect(now).toBeGreaterThan(0);
    expect(mb.speedOf('Lead', now)).toBeGreaterThan(0);   // both in motion at the query time
    expect(mb.speedOf('Follow', now)).toBeGreaterThan(0);

    // Record what the handle asks the authority.
    const orig = mb.locate;
    const calls: { id: string; t: number; s: number; path: string }[] = [];
    mb.locate = function (this: typeof mb, id: string, t: number) {
      const r = orig.call(this, id, t);
      if (r) calls.push({ id, t, s: r.s, path: r.path.id });
      return r;
    };
    const lead: AgvLocation = { pathId: '', s: Number.NaN, dir: 1, t: Number.NaN };
    const follow: AgvLocation = { pathId: '', s: Number.NaN, dir: 1, t: Number.NaN };
    let okLead = false, okFollow = false;
    try {
      okLead = fleet.get('Lead')!.locate!(lead);
      okFollow = fleet.get('Follow')!.locate!(follow);
    } finally {
      mb.locate = orig;
    }
    expect([okLead, okFollow]).toEqual([true, true]);
    expect(calls.map((c) => c.id)).toEqual(['Lead', 'Follow']);
    expect(lead).toEqual({ pathId: 'Long', s: calls[0].s, dir: 1, t: calls[0].t });
    expect(follow).toEqual({ pathId: 'Long', s: calls[1].s, dir: 1, t: calls[1].t });
    expect(lead.t).toBe(now);                       // the DES host clock (event time)
    expect(follow.t).toBe(now);
    expect(lead.s).toBeGreaterThan(follow.s);       // same path, different arc positions
    expect(lead.s).toBeGreaterThan(8);              // both moved since the start
    expect(follow.s).toBeGreaterThan(2);

    // Source proof: a value only the authority can hand out ends up in `out`.
    const sentinel = 70.0625; // out of reach at the first event time (seconds at <= 1 m/s from 8 m)
    const real = orig.call(mb, 'Lead', now)!;
    mb.locate = () => ({ path: real.path, s: sentinel, x: real.x, v: real.v });
    const probe: AgvLocation = { pathId: '', s: Number.NaN, dir: 1, t: Number.NaN };
    try { expect(fleet.get('Lead')!.locate!(probe)).toBe(true); } finally { mb.locate = orig; }
    expect(probe.s).toBe(sentinel);
    const trav: AgvTravelerState = { path: null, s: Number.NaN, speed: 0, atEnd: false };
    expect(fleet.get('Lead')!.travelerState!(trav)).toBe(true);
    expect(trav.s).not.toBe(sentinel);              // travelerState is untouched by the seam
    runner.dispose();
  }, 120000);

  it('continuous: the shared authority clock is the time base; a legacy step-mode vehicle reports false', () => {
    longLine();
    const fleet = getDefaultAgvFleet();
    const host = makeHost();
    const planned = bindContinuous(makeAgvRoot('P', { PathId: 'Long', StartPosition: 20000, VehicleLength: 1000, VehicleWidth: 600 }), host);
    const legacy = bindContinuous(makeAgvRoot('L', { PathId: 'Long', StartPosition: 2000, VehicleLength: 1000, VehicleWidth: 600, UseAcceleration: false }), host);
    for (let f = 0; f < Math.round(2 / TICK); f++) { iterateFixedUpdate(planned, TICK); iterateFixedUpdate(legacy, TICK); }
    const mb = getDefaultMovementAuthority('continuous');
    const out: AgvLocation = { pathId: '', s: Number.NaN, dir: 1, t: Number.NaN };
    expect(fleet.get('P')!.locate!(out)).toBe(true);
    expect(out.t).toBe(mb.clock.now);
    const ref = mb.locate('P', out.t)!;
    expect(out).toEqual({ pathId: 'Long', s: ref.s, dir: 1, t: mb.clock.now });
    expect(out.s).toBeGreaterThan(20);

    const untouched: AgvLocation = { pathId: 'x', s: -1, dir: 1, t: -1 };
    expect(fleet.get('L')!.locate!(untouched)).toBe(false);  // no movement-authority host → no fallback to traveler.s
    expect(untouched).toEqual({ pathId: 'x', s: -1, dir: 1, t: -1 });
    planned.dispose();
    legacy.dispose();
  }, 120000);
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.2 (F3/F4/F5) — the full stub cycle over the public task API.
 *
 * A forklift (forks at the rear) gets `approach: 'reverse'` to stub S2: forward
 * to the END of the merge piece Turn2, standstill, reverse at ReverseSpeed into
 * the stub, ONE dock call at the stub START (s = 0, reverse plan, stub zone
 * held, pose on the handling position), an 8 s dock hold with stable pose and
 * the task's serviceState, then out FORWARD without a second service — in DES
 * Animated, DES FastForward and the continuous kernel.
 *
 * Plus: a direction change commanded WHILE DRIVING is refused and leaves the
 * running plan untouched (F3); ReverseSpeed = 0 inherits DockingSpeed; a
 * refused direction change at the turn point is RETRIED (gate closed for 2 s),
 * the manoeuvre is not lost; without AllowReverse the task never reverses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vector3 } from 'three';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { TICK, clearShared } from '../helpers/agv-harness';
import { stubLayout, makeStubWorld, forkCfg, FORK, FORK_MESH, delay, type Mode } from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true)); // restore the default

interface Cycle {
  dockCalls: number;
  arrive: { t: number; path: string; s: number; dir: number; heldK: boolean } | null;
  releaseT: number;
  stateAtRelease: string;
  done: boolean;
  maxReverseSpeed: number;
  reverseFrames: number;
  reverseUnheld: number;
  poseErr: number; dirErr: number;
  holdDeviations: number;
  refusedWhileMoving: boolean | null;
  versionKept: boolean | null;
  firstReverseT: number;
  turnArriveT: number;
  gateOpenT: number;
  leftForward: boolean;
  dirRefused: number;
  violations: number;
  watchdog: number;
}

function cycle(mode: Mode, opts: { cfg?: Record<string, unknown>; gateClosedAtTurnSec?: number; simLimit?: number } = {}): Cycle {
  stubLayout();
  const w = makeStubWorld(mode, [{ name: 'F', cfg: forkCfg('L0', 3500, opts.cfg), mesh: FORK_MESH, body: FORK }], opts.simLimit ?? 300);
  const { mb } = w;
  const net = getDefaultPathNetwork();
  const zones = getDefaultZoneRegistry();
  const stub = net.get('S2')!;
  const c: Cycle = {
    dockCalls: 0, arrive: null, releaseT: -1, stateAtRelease: '', done: false, maxReverseSpeed: 0, reverseFrames: 0,
    reverseUnheld: 0, poseErr: -1, dirErr: -1, holdDeviations: 0, refusedWhileMoving: null, versionKept: null,
    firstReverseT: -1, turnArriveT: -1, gateOpenT: -1, leftForward: false, dirRefused: 0, violations: 0, watchdog: 0,
  };
  getDefaultPathDockRegistry().register('S2', {
    onVehicleArrive: (_id, release) => {
      c.dockCalls++;
      const loc = mb.locate('F', w.now())!;
      c.arrive = { t: w.now(), path: loc.path.id, s: loc.s, dir: mb.planDirOf('F'), heldK: zones.isHolder('K2', 'F') };
      delay(8, () => { c.releaseT = w.now(); c.stateAtRelease = w.desState ? w.desState('F') : ''; release(); });
    },
  });
  getDefaultAgvFleet().get('F')!.assign({
    destination: 'S2', approach: 'reverse', serviceState: 'Handling',
    onServiceEnd: () => { c.done = true; getDefaultAgvFleet().get('F')!.clear(); },
  });
  // Event-exact observation (the DES manager clock jumps between events): the end of Pre2
  // (onto the merge piece) closes the gate, the end of Turn2 is the turn point.
  let gateClosed = false;
  getDefaultPathNetwork().setRouter({
    onArrive: (pathId, id) => {
      if (id !== 'F') return;
      if (pathId === 'Pre2' && opts.gateClosedAtTurnSec !== undefined && !gateClosed) {
        gateClosed = true;
        setReverseGateOpen(false);
        delay(opts.gateClosedAtTurnSec, () => { c.gateOpenT = w.now(); setReverseGateOpen(true); });
      }
      if (pathId === 'Turn2' && c.turnArriveT < 0) c.turnArriveT = w.now();
    },
  }, 'agv-reverse-stub-cycle');
  const visual = mode !== 'fastforward';
  // plan-632: the pose is sampled at the end of the very step of the dock call (0 ticks) in
  // every mode. The continuous fleet syncs all vehicles at the step's shared clock time after
  // the one advance in which the arrival ran, so the drawn pose is already the handling
  // position; the former 5 x TICK allowance (F + 4 timer vehicles joining the clock one tick
  // apart, #202) would hide a regression of exactly that.
  const lag = 0;
  const p = new Vector3(), d = new Vector3(), z = new Vector3();
  while (!w.done() && !(c.done && c.leftForward)) {
    w.step();
    const now = w.now();
    const loc = mb.locate('F', now)!;
    const dir = mb.planDirOf('F');
    // F3: a direction change commanded while driving is refused; the plan stays as it is.
    if (visual && c.refusedWhileMoving === null && dir === 1 && mb.speedOf('F', now) > 0.5) {
      const before = mb.stats.dirRefused, ver = mb.versionOf('F');
      c.refusedWhileMoving = !mb.setDirection('F', -1, [net.get('Turn2')!, net.get('Mouth2')!, stub]) && mb.stats.dirRefused === before + 1;
      c.versionKept = mb.versionOf('F') === ver && mb.planDirOf('F') === 1;
    }
    if (dir === -1 && c.arrive === null) {
      if (c.firstReverseT < 0) c.firstReverseT = now;
      c.reverseFrames++;
      c.maxReverseSpeed = Math.max(c.maxReverseSpeed, mb.speedOf('F', now));
      if (!loc.path.zoneId || !zones.isHolder(loc.path.zoneId, 'F')) c.reverseUnheld++;
    }
    if (c.arrive && c.releaseT < 0) {
      // dock hold: pose, zone and phase unchanged
      const bad = loc.path !== stub || Math.abs(loc.s) > 1e-9 || !zones.isHolder('K2', 'F')
        || getDefaultAgvFleet().get('F')!.phase !== 'servicing' || mb.speedOf('F', now) !== 0;
      if (bad) c.holdDeviations++;
      if (visual && c.poseErr < 0 && now - c.arrive.t >= lag) {
        stub.getAbsPosition(0, p); stub.getAbsDirection(0, d);
        c.poseErr = w.roots.F.position.distanceTo(p);
        z.set(0, 0, 1).applyQuaternion(w.roots.F.quaternion);
        c.dirErr = 1 - z.dot(d);
      }
    }
    if (c.done && dir === 1 && loc.path.id === 'L2') c.leftForward = true;
  }
  if (mode === 'fastforward') c.leftForward = mb.planDirOf('F') === 1 && c.done;
  c.dirRefused = mb.stats.dirRefused;
  c.violations = mb.stats.violations;
  c.watchdog = mb.stats.watchdogFires;
  w.dispose();
  return c;
}

describe('plan-595 9.2 — stub cycle over the task API', () => {
  for (const mode of ['continuous', 'animated', 'fastforward'] as Mode[]) {
    it(`${mode}: forward to the turn point, reverse in, one dock call at s = 0, 8 s hold, out forward`, () => {
      const c = cycle(mode);
      expect(c.done).toBe(true);
      expect(c.dockCalls).toBe(1);
      expect(c.arrive!.path).toBe('S2');
      expect(Math.abs(c.arrive!.s)).toBeLessThan(1e-9);
      expect(c.arrive!.dir).toBe(-1);
      expect(c.arrive!.heldK).toBe(true);
      expect(c.releaseT - c.arrive!.t).toBeCloseTo(8, 2);
      expect(c.holdDeviations).toBe(0);
      expect(c.leftForward).toBe(true);
      expect(c.violations).toBe(0);
      expect(c.watchdog).toBe(0);
      if (mode !== 'continuous') expect(c.stateAtRelease).toBe('Handling');
      if (mode === 'fastforward') return; // one FF tick drains the run — no per-frame observation
      expect(c.poseErr).toBeGreaterThanOrEqual(0);
      expect(c.poseErr).toBeLessThan(1e-6);
      expect(c.dirErr).toBeLessThan(1e-9);
      expect(c.reverseFrames).toBeGreaterThan(0);
      expect(c.reverseUnheld).toBe(0);
      expect(c.maxReverseSpeed).toBeLessThanOrEqual(0.3 + 1e-9); // ReverseSpeed 300 mm/s
      expect(c.maxReverseSpeed).toBeGreaterThan(0.29);
      expect(c.refusedWhileMoving).toBe(true);                  // F3
      expect(c.versionKept).toBe(true);
    }, 120000);
  }

  it('animated: ReverseSpeed = 0 inherits DockingSpeed', () => {
    const c = cycle('animated', { cfg: { ReverseSpeed: 0, DockingSpeed: 200 } });
    expect(c.done).toBe(true);
    expect(c.maxReverseSpeed).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(c.maxReverseSpeed).toBeGreaterThan(0.19);
  }, 120000);

  for (const mode of ['continuous', 'animated'] as Mode[]) {
    it(`${mode}: a refused direction change at the turn point is retried, not dropped`, () => {
      const c = cycle(mode, { gateClosedAtTurnSec: 6 });
      expect(c.turnArriveT).toBeGreaterThan(0);
      expect(c.gateOpenT).toBeGreaterThan(c.turnArriveT);     // stood at the turn point with the gate closed
      expect(c.dirRefused).toBeGreaterThanOrEqual(1 + 3);     // F3 probe + refusals at the turn point (retry every 0.5 s)
      expect(c.firstReverseT).toBeGreaterThanOrEqual(c.gateOpenT - 1e-9);
      expect(c.firstReverseT - c.gateOpenT).toBeLessThanOrEqual(0.5 + 2 * TICK); // the next retry takes it
      expect(c.done).toBe(true);
      expect(c.dockCalls).toBe(1);
      expect(c.watchdog).toBe(0);
    }, 120000);
  }

  it('animated: without AllowReverse the task never reverses', () => {
    const c = cycle('animated', { cfg: { AllowReverse: false }, simLimit: 120 });
    expect(c.reverseFrames).toBe(0);
    expect(c.dockCalls).toBe(0);
  }, 120000);
});

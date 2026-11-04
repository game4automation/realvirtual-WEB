// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-595 §9.14 (R3-1) — no wait cycle at a shared stub: K before M.
 *
 * Two forklifts A and B get a reverse task to the SAME stub S2 (split zones:
 * stub zone K2, merge zone M2 = Pre2 + Turn2 + Mouth2). A arrives first and its
 * dock holds it for 300 s. B may claim M2 only together with K2, so it waits
 * OUTSIDE M2 (never holds M2 while A holds K2) instead of standing at the turn
 * point blocking A's exit. The lane stays free for a third vehicle C while A is
 * docked (C passes the merge piece during the stay), both forklifts finish
 * their tasks, the SAT oracle sees no overlap and no watchdog fires — in DES
 * Animated, DES FastForward (geometry by materialisation of the applied plans)
 * and the continuous kernel.
 *
 * Variant "shared waiting place of two stubs": a second stub S2b from the other
 * side into the same merge zone. While A is docked in S2 and B waits for K2,
 * forklift D serves S2b and leaves again.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { clearShared } from '../helpers/agv-harness';
import {
  stubLayout, makeStubWorld, forkCfg, carCfg, FORK, FORK_MESH, CAR, delay, frameOverlap, type Mode, type VehicleSpec,
} from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true)); // restore the default

const HOLD_SEC = 300;

/** Stop state of one vehicle (from the authority's diagnostics line). */
interface StopState { cause: string; waits: string[]; leaders: string[] }
interface WatchdogFire { t: number; id: string; state: Record<string, StopState> }

/** Parse `MovementAuthority.describe` lines into the stop state per vehicle. */
function stopStates(lines: string[]): Record<string, StopState> {
  const out: Record<string, StopState> = {};
  for (const ln of lines) {
    const id = ln.slice(0, ln.indexOf(' '));
    const field = (k: string): string => (new RegExp(` ${k}=([^ ]*)`).exec(ln)?.[1] ?? '');
    out[id] = {
      cause: field('cause'),
      waits: field('waits').split(',').filter(Boolean).map((w) => w.slice(0, w.indexOf('@'))),
      leaders: field('leaders').split(',').filter(Boolean),
    };
  }
  return out;
}

interface Shared {
  done: Record<string, number>;
  dock: Record<string, { arrive: number; release: number }>;
  cPassesDuringHold: number;
  /** Frames of A's dock stay in which A still holds the merge zone (the lane would be blocked). */
  mergeHeldByDockedFrames: number;
  holdFrames: number;
  bHoldsMWhileAHoldsK: number;
  overlapFrames: number; maxPen: number; pairs: Set<string>;
  materialised: { frames: number; samples: number } | null;
  watchdog: number;
  /** Every watchdog fire: time, subject and the stop state of every vehicle at that instant. */
  watchdogs: WatchdogFire[];
  violations: number;
}

function runShared(mode: Mode, twin: boolean, ghost = false): Shared {
  stubLayout(twin ? { twinAt: 2 } : {});
  // Ring order along travel: A (front) … D … C … B. C reaches the stub mouth only after A is
  // docked, B (far behind C) only after C passed — so C shows whether the lane is free.
  const specs: VehicleSpec[] = [
    { name: 'A', cfg: forkCfg('L0', 5000), mesh: FORK_MESH, body: FORK },
    ...(twin ? [{ name: 'D', cfg: forkCfg('L0', 1500), mesh: FORK_MESH, body: FORK }] : []),
    { name: 'C', cfg: carCfg('R2', 20000), body: CAR },
    { name: 'B', cfg: forkCfg('R2', 8000), mesh: FORK_MESH, body: FORK },
  ];
  const w = makeStubWorld(mode, specs, 900);
  const zones = getDefaultZoneRegistry();
  const fleet = getDefaultAgvFleet();
  // Every watchdog with the stop state of the whole fleet at its own event time.
  const onEvent = w.mb.onEvent.bind(w.mb);
  w.mb.onEvent = (id, kind, data) => {
    if (kind === 'watchdog') r.watchdogs.push({ t: w.now(), id, state: stopStates(w.mb.describe(w.now())) });
    onEvent(id, kind, data);
  };
  // Negative control: a zone held by nobody that drives (C waits there for ever — a stall).
  if (ghost) zones.claim('M3', 'ghost');
  // Event-exact zone invariants (FastForward has no frames): checked at every claim.
  const claim = zones.claim.bind(zones);
  zones.claim = (zoneId: string, agvId: string): boolean => {
    const ok = claim(zoneId, agvId);
    if (ok && zoneId === 'M2' && agvId === 'B' && r.done.B === undefined && zones.isHolder('K2', 'A')) r.bHoldsMWhileAHoldsK++;
    if (ok && zoneId === 'M2' && agvId === 'A' && inHold()) r.mergeHeldByDockedFrames++;
    return ok;
  };
  const r: Shared = {
    done: {}, dock: {}, cPassesDuringHold: 0, mergeHeldByDockedFrames: 0, holdFrames: 0, bHoldsMWhileAHoldsK: 0, overlapFrames: 0, maxPen: 0, pairs: new Set(),
    materialised: null, watchdog: 0, watchdogs: [], violations: 0,
  };
  const inHold = (): boolean => r.dock.A !== undefined && r.dock.A.release < 0;
  getDefaultPathNetwork().setRouter({
    onArrive: (pathId, id) => { if (id === 'C' && pathId === 'Turn2' && inHold()) r.cPassesDuringHold++; },
  }, 'agv-reverse-shared-stub');
  for (const sid of twin ? ['S2', 'S2b'] : ['S2']) {
    getDefaultPathDockRegistry().register(sid, {
      onVehicleArrive: (id, release) => {
        const v = { arrive: w.now(), release: -1 };
        r.dock[id] = v;
        if (id === 'A' && zones.isHolder('M2', 'A')) r.mergeHeldByDockedFrames++; // docked with the merge zone still held
        delay(id === 'A' ? HOLD_SEC : 8, () => { v.release = w.now(); release(); });
      },
    });
  }
  const task = (id: string, stub: string): void => fleet.get(id)!.assign({
    destination: stub, approach: 'reverse',
    onServiceEnd: () => { r.done[id] = w.now(); fleet.get(id)!.clear(); },
  });
  task('A', 'S2');
  task('B', 'S2');
  if (twin) task('D', 'S2b');
  const want = twin ? 3 : 2;
  while (!w.done() && Object.keys(r.done).length < want) {
    w.step();
    if (r.done.B === undefined && zones.isHolder('K2', 'A') && zones.isHolder('M2', 'B')) r.bHoldsMWhileAHoldsK++;
    if (inHold()) { r.holdFrames++; if (zones.isHolder('M2', 'A')) r.mergeHeldByDockedFrames++; }
    if (mode !== 'fastforward') {
      const o = frameOverlap(w);
      if (o.hit) { r.overlapFrames++; r.maxPen = Math.max(r.maxPen, o.maxPen); for (const p of o.pairs) r.pairs.add(p); }
    }
  }
  zones.claim = claim;
  if (mode === 'fastforward') r.materialised = w.materialisedOverlap();
  r.watchdog = w.mb.stats.watchdogFires;
  w.mb.onEvent = onEvent;
  r.violations = w.mb.stats.violations;
  w.dispose();
  return r;
}

/** Zones of the occupied stub a waiter may legitimately wait for. */
const STUB_ZONES = ['K2', 'M2'];

/**
 * True when `id` stands because of the occupied stub: it waits for K2 / M2
 * (zone stop), or it stands behind a vehicle that does (leader stop, transitively).
 */
function blockedByStub(st: Record<string, StopState>, id: string, depth = 0): boolean {
  const s = st[id];
  if (!s || depth > 8) return false;
  if (s.cause === 'zone') return s.waits.length > 0 && s.waits.every((z) => STUB_ZONES.includes(z));
  if (s.cause === 'leader') return s.leaders.length > 0 && s.leaders.some((l) => blockedByStub(st, l, depth + 1));
  return false;
}

/**
 * A traffic stop longer than the watchdog period (60 s) fires the watchdog once
 * per plan — waiting behind a 300 s dock stay is such a stop. Every fire must
 * fall INSIDE A's stay, its subject must never be A, and at its own event time
 * the subject stands BECAUSE OF the occupied stub (waits for K2 / M2, or queues
 * behind such a waiter). None after the stay — nobody stalls.
 */
function expectWatchdogsOnlyWhileDocked(r: Shared): void {
  expect(r.watchdogs.length).toBeGreaterThan(0); // an empty list would make the subject check vacuous
  expect(r.watchdogs.length).toBe(r.watchdog);
  for (const e of r.watchdogs) {
    expect(e.id).not.toBe('A');
    expect(e.t).toBeGreaterThan(r.dock.A.arrive);
    expect(e.t).toBeLessThanOrEqual(r.dock.A.release + 1e-9);
    expect(blockedByStub(e.state, e.id), `${e.id} @${e.t.toFixed(3)} ${JSON.stringify(e.state[e.id])}`).toBe(true);
  }
}

describe('plan-595 9.14 — two forklifts at one stub (R3-1: K before M)', () => {
  for (const mode of ['animated', 'fastforward', 'continuous'] as Mode[]) {
    it(`${mode}: B waits outside M2 during A's 300 s stay; the lane stays free; both finish`, () => {
      const r = runShared(mode, false);
      expect(r.done.A).toBeDefined();
      expect(r.done.B).toBeDefined();
      expect(r.dock.A.release - r.dock.A.arrive).toBeCloseTo(HOLD_SEC, 2);
      expect(r.dock.B.arrive).toBeGreaterThan(r.dock.A.release); // B serves only after A left
      expect(r.bHoldsMWhileAHoldsK).toBe(0);                      // never waiting inside M2
      expectWatchdogsOnlyWhileDocked(r);
      expect(r.violations).toBe(0);
      expect(r.cPassesDuringHold).toBeGreaterThan(0);             // the lane is free for third vehicles
      if (mode !== 'fastforward') expect(r.holdFrames).toBeGreaterThan(0);
      expect(r.mergeHeldByDockedFrames).toBe(0);                  // the docked forklift does not block M2
      if (mode === 'fastforward') {
        expect(r.materialised!.samples).toBeGreaterThan(1000);
        expect(r.materialised!.frames).toBe(0);
      } else {
        expect(r.overlapFrames).toBe(0);
      }
    }, 300000);
  }

  for (const mode of ['animated', 'continuous'] as Mode[]) {
    it(`${mode}: negative control — a watchdog for another reason inside the window fails the check`, () => {
      const r = runShared(mode, false, true);
      expect(r.watchdogs.some((e) => e.id === 'C' && e.state.C.waits.includes('M3'))).toBe(true); // the stall happened
      expect(() => expectWatchdogsOnlyWhileDocked(r)).toThrow();
      // … and an EMPTY list fails as well (the check is never vacuous).
      expect(() => expectWatchdogsOnlyWhileDocked({ ...r, watchdogs: [], watchdog: 0 })).toThrow();
    }, 300000);
  }

  for (const mode of ['animated', 'fastforward', 'continuous'] as Mode[]) {
    it(`${mode}: shared waiting place of two stubs — D serves S2b while A is docked and B waits`, () => {
      const r = runShared(mode, true);
      expect(r.done.A).toBeDefined();
      expect(r.done.B).toBeDefined();
      expect(r.done.D).toBeDefined();
      expect(r.dock.D.arrive).toBeGreaterThan(r.dock.A.arrive);
      expect(r.done.D).toBeLessThan(r.dock.A.release);            // D is through while A is still docked
      expect(r.dock.B.arrive).toBeGreaterThan(r.dock.A.release);
      expect(r.bHoldsMWhileAHoldsK).toBe(0);
      expect(r.cPassesDuringHold).toBeGreaterThan(0);
      expect(r.mergeHeldByDockedFrames).toBe(0);
      expectWatchdogsOnlyWhileDocked(r);
      expect(r.violations).toBe(0);
      if (mode === 'fastforward') expect(r.materialised!.frames).toBe(0);
      else expect(r.overlapFrames).toBe(0);
    }, 300000);
  }
});

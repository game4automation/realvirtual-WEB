// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-686 §9.2 / §9.3 — orphaned zone claims are released at the end of a
 * plan build (F1), and the release never frees a zone the body may cover.
 *
 * Regression (§9.2), built after the Phase-0 measurement of the PalletYard
 * deadlock (180 s takt, t ≈ 14990 s): a forklift `A` heading down the lane
 * claims the NEXT merge zone `M2` inside its claim window, then gets a reverse
 * task into the stub `S1` (task change while approaching) — the route now ends
 * at the turn point, `M2` is on no route any more, the direction change makes
 * its key ∞, and before plan-686 it stayed held until a later route drove
 * through it. A cart `B` behind takes `M1` once `A` is in the stub, stops in
 * the 1.0 m gap before `M2` with its rear still in `M1`, and waits for `M2`;
 * `A` leaves the stub and waits for `M1` — a hold-and-wait cycle. With F1 the
 * orphaned `M2` is released and both vehicles go on, in both kernels.
 *
 * §9.3: claims that must stay (zone ahead on the route, rear still inside after a
 * task change, manoeuvre companions), the clamping supplement and the spatial /
 * undirected occupancy check, and an independent geometric safety check of every
 * step-4 release (body OBB vs. the zone corridor and the other bodies in it),
 * with a falsification test that proves the check can fail.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parsePathExtras, type RVPath } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import {
  getDefaultMovementAuthority, setReverseGateOpen,
  type MbHost, type MbParams, type MovementAuthority,
} from '../../src/core/engine/rv-movement-authority';
import { stationaryProfile } from '../../src/core/engine/rv-motion-profile';
import type { PathTraveler } from '../../src/core/engine/rv-path-traveler';
import { clearShared } from '../helpers/agv-harness';
import { watchStaleReleases as watchReleases, type StaleReleaseLog as SafetyLog } from '../helpers/agv-release-safety';
import { stubLayout, makeStubWorld, delay, forkCfg, carCfg, FORK, FORK_MESH, CAR, type Mode, type StubWorld } from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

// ── §9.2 regression ───────────────────────────────────────────────────────

interface Scenario {
  cycles: unknown[];
  heldM2AtSwitch: boolean;
  aServed: boolean;
  aLeftStub: boolean;
  bPassedM2: boolean;
  stale: number;
  unexpected: number;
  safety: SafetyLog;
  violations: number;
  wd: number;
}

/**
 * Lane with a 1.0 m free gap after each merge piece (`preLen` 6: Turn_i ends at 10·i + 3,
 * Pre_{i+1} starts at 10·i + 4), as on the PalletYard south straight.
 */
function scenario(mode: Mode, opts: { disableStep4?: boolean } = {}): Scenario {
  stubLayout({ preLen: 6 });
  const w: StubWorld = makeStubWorld(mode, [
    { name: 'A', cfg: forkCfg('Turn1', 300), mesh: FORK_MESH, body: FORK },
    { name: 'B', cfg: carCfg('R3', 6000), body: CAR },
  ], 400);
  const { mb } = w;
  if (opts.disableStep4) (mb as unknown as { releaseStaleClaims: () => void }).releaseStaleClaims = () => {};
  const safety = watchReleases(mb, () => w.names);
  const zones = getDefaultZoneRegistry();
  const fleet = getDefaultAgvFleet();
  const r: Scenario = {
    cycles: [], heldM2AtSwitch: false, aServed: false, aLeftStub: false, bPassedM2: false,
    stale: 0, unexpected: 0, safety, violations: 0, wd: 0,
  };
  getDefaultPathDockRegistry().register('S1', { onVehicleArrive: (_id, release) => { r.aServed = true; release(); } });
  fleet.get('A')!.assign({ destination: 'R1' });
  fleet.get('B')!.assign({ destination: 'R1' });
  // Task change while approaching, as soon as A holds M2 inside its claim window (sim-time
  // polling through the timer vehicles, works in every kernel): the reverse task into S1.
  const trySwitch = (tries: number): void => {
    if (!zones.isHolder('M2', 'A') && tries > 0) { delay(0.1, () => trySwitch(tries - 1)); return; }
    r.heldM2AtSwitch = zones.isHolder('M2', 'A');
    fleet.get('A')!.assign({
      destination: 'S1', approach: 'reverse', serviceSec: 4,
      onServiceEnd: () => fleet.get('A')!.assign({ destination: 'R2' }),
    });
  };
  // A starts from rest at Turn1 s = 0.3 m: its first plan claims M2 inside the claim window.
  delay(0.3, () => trySwitch(8));
  getDefaultPathNetwork().setRouter({
    onArrive: (pathId, id) => {
      if (id === 'A' && pathId === 'Turn1' && r.aServed) r.aLeftStub = true;
      if (id === 'B' && pathId === 'Turn2') r.bPassedM2 = true;
    },
  }, 'agv-zone-stale-hold-deadlock');
  while (!w.done() && !(r.aLeftStub && r.bPassedM2)) w.step();
  r.cycles = mb.findZoneWaitCycles();
  r.stale = mb.stats.staleClaimsReleased;
  r.unexpected = mb.stats.staleClaimsUnexpected;
  r.violations = mb.stats.violations;
  r.wd = mb.stats.watchdogFires;
  safety.restore();
  if (opts.disableStep4) delete (mb as unknown as { releaseStaleClaims?: unknown }).releaseStaleClaims;
  w.dispose();
  return r;
}

describe('plan-686 9.2 — a stub vehicle does not keep the next merge zone (was a deadlock)', () => {
  for (const mode of ['continuous', 'fastforward'] as Mode[]) {
    it(`${mode}: the orphaned M2 claim is released, A is served and leaves, B passes M2`, () => {
      const r = scenario(mode);
      expect(r.heldM2AtSwitch).toBe(true); // precondition: the formation of the measured case
      expect(r.cycles).toEqual([]);
      expect(r.aServed).toBe(true);
      expect(r.aLeftStub).toBe(true);
      expect(r.bPassedM2).toBe(true);
      expect(r.stale).toBeGreaterThan(0);
      expect(r.unexpected).toBe(0); // released at its source (the route change), not by the safety net
      expect(r.safety.releases.map((x) => x.zone)).toContain('M2');
      expect(r.safety.releases.every((x) => !x.zone.startsWith('K'))).toBe(true); // companions / stub zones never by step 4
      expect(r.safety.violations).toEqual([]);
      expect(r.violations).toBe(0);
    }, 180000);

    it(`${mode}: without the orphan release (= main before plan-686) the same run deadlocks`, () => {
      const r = scenario(mode, { disableStep4: true });
      expect(r.heldM2AtSwitch).toBe(true);
      expect(r.cycles).toEqual([{ vehicles: ['A', 'B'], zones: ['M1', 'M2'] }]);
      expect(r.aLeftStub).toBe(false);
      expect(r.bPassedM2).toBe(false);
    }, 180000);
  }
});

// ── Release at the reverse direction change (the source of a manoeuvre) ───

describe('plan-686 — release at the direction change and the safety net', () => {
  for (const mode of ['continuous', 'fastforward'] as Mode[]) {
    it(`${mode}: a claim the reverse route does not contain is given back AT the direction change (plan-build release off)`, () => {
      stubLayout(); // 4 m free lane after each merge piece
      const w = makeStubWorld(mode, [
        { name: 'A', cfg: forkCfg('Turn1', 300), mesh: FORK_MESH, body: FORK },
        { name: 'B', cfg: carCfg('L1', 500), body: CAR },
      ], 200);
      const { mb } = w;
      // Only the release inside setDirection may act — the plan-build path is switched off.
      const m = mb as unknown as { releaseStaleClaims: (...a: unknown[]) => void; setDirection: (...a: unknown[]) => boolean };
      const origRel = m.releaseStaleClaims, origDir = m.setDirection;
      let inDir = false;
      m.releaseStaleClaims = function (this: unknown, ...a: unknown[]) { if (inDir) origRel.apply(this, a); };
      m.setDirection = function (this: unknown, ...a: unknown[]) { inDir = true; try { return origDir.apply(this, a); } finally { inDir = false; } };
      const safety = watchReleases(mb, () => w.names);
      const zones = getDefaultZoneRegistry();
      const fleet = getDefaultAgvFleet();
      // A leftover claim of an earlier route (exit unknown), as the PalletYard stacker had on Merge_P2_P3.
      expect(mb.holdZone('A', 'M2', w.now())).toBe(true);
      expect(mb.holdZone('A', 'M3', w.now())).toBe(true); // two claims to give back in one call (review 686 #1)
      let releasedAt = -1, turnT = -1, bPassed = -1;
      getDefaultPathNetwork().setRouter({
        onArrive: (pathId, id) => {
          if (id === 'A' && pathId === 'Turn1' && turnT < 0) turnT = w.now();
          if (id === 'B' && pathId === 'Turn2' && bPassed < 0) bPassed = w.now();
        },
      }, 'agv-zone-stale-hold-dirchange');
      fleet.get('A')!.assign({ destination: 'S1', approach: 'reverse', serviceSec: 20 });
      fleet.get('B')!.assign({ destination: 'R1' });
      while (!w.done() && bPassed < 0) {
        w.step();
        if (releasedAt < 0 && !zones.isHolder('M2', 'A')) releasedAt = w.now();
      }
      expect(safety.releases.map((x) => x.zone).sort()).toEqual(['M2', 'M3']);
      expect(new Set(safety.releases.map((x) => x.t)).size).toBe(1); // both in the same direction change
      expect(mb.stats.staleClaimsUnexpected).toBe(0);
      expect(safety.violations).toEqual([]);
      expect(bPassed).toBeGreaterThan(0); // B was not blocked by A's leftover claim
      if (mode !== 'fastforward') expect(releasedAt).toBeGreaterThanOrEqual(turnT - 1e-9);
      safety.restore();
      delete (m as Partial<typeof m>).releaseStaleClaims;
      delete (m as Partial<typeof m>).setDirection;
      w.dispose();
    }, 120000);

    it(`${mode}: the safety net releases an orphan nobody handled at its origin and warns once`, () => {
      stubLayout({ preLen: 6 });
      const w = makeStubWorld(mode, [{ name: 'A', cfg: carCfg('R3', 6000), body: CAR }], 120);
      const { mb } = w;
      const zones = getDefaultZoneRegistry();
      zones.define('X9', 1);
      const warns: string[] = [];
      const origWarn = console.warn;
      console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
      try {
        getDefaultAgvFleet().get('A')!.assign({ destination: 'R2' });
        let injected = false;
        getDefaultPathNetwork().setRouter({
          onArrive: (pathId, id) => {
            // Inject an orphan with a FINITE key outside every known source (no route change).
            if (id === 'A' && pathId === 'L0' && !injected) {
              injected = true;
              zones.claim('X9', 'A');
              (mb as unknown as { vehicles: Map<string, { held: Map<string, number> }> }).vehicles.get('A')!.held.set('X9', 1e6);
            }
          },
        }, 'agv-zone-stale-hold-net');
        while (!w.done()) w.step();
        expect(injected).toBe(true);
        expect(zones.isHolder('X9', 'A')).toBe(false);
        expect(mb.stats.staleClaimsUnexpected).toBe(1);
        expect(warns.filter((x) => x.includes('X9') && x.includes('safety net'))).toHaveLength(1);
      } finally {
        console.warn = origWarn;
        w.dispose();
      }
    }, 120000);
  }
});

// ── §9.3 claim retention ──────────────────────────────────────────────────

describe('plan-686 9.3 — claims that must stay', () => {
  for (const mode of ['continuous', 'fastforward'] as Mode[]) {
    it(`${mode}: a) normal traffic through three merges releases nothing by step 4`, () => {
      stubLayout({ preLen: 6 });
      const w = makeStubWorld(mode, [
        { name: 'A', cfg: carCfg('R3', 6000), body: CAR },
        { name: 'B', cfg: carCfg('R3', 2500), body: CAR },
      ], 200);
      const safety = watchReleases(w.mb, () => w.names);
      getDefaultAgvFleet().get('A')!.assign({ destination: 'R2', serviceSec: 5 });
      getDefaultAgvFleet().get('B')!.assign({ destination: 'R1' });
      while (!w.done()) w.step();
      expect(w.mb.stats.staleClaimsReleased).toBe(0);
      expect(safety.releases).toEqual([]);
      safety.restore();
      w.dispose();
    }, 120000);

    it(`${mode}: b) a task change right after leaving a merge keeps the zone the rear is still in`, () => {
      stubLayout({ preLen: 6 });
      const w = makeStubWorld(mode, [{ name: 'A', cfg: forkCfg('R3', 6000), mesh: FORK_MESH, body: FORK }], 200);
      const safety = watchReleases(w.mb, () => w.names);
      const fleet = getDefaultAgvFleet();
      fleet.get('A')!.assign({ destination: 'R1' });
      let changed = false, heldAtChange = false;
      getDefaultPathNetwork().setRouter({
        onArrive: (pathId, id) => {
          // A at the end of L1 (1.0 m gap): its rear (1.6 m) is still in M1; the new route (to the
          // turn point of S2) no longer contains M1.
          if (id === 'A' && pathId === 'L1' && !changed) {
            changed = true;
            heldAtChange = getDefaultZoneRegistry().isHolder('M1', 'A');
            fleet.get('A')!.assign({ destination: 'S2', approach: 'reverse', serviceSec: 2 });
          }
        },
      }, 'agv-zone-stale-hold-b');
      while (!w.done()) w.step();
      expect(changed).toBe(true);
      expect(heldAtChange).toBe(true);
      expect(safety.violations).toEqual([]);
      expect(safety.releases.filter((x) => x.zone === 'M1')).toEqual([]); // released by the rear, not by step 4
      expect(w.mb.stats.staleClaimsUnexpected).toBe(0);
      expect(getDefaultZoneRegistry().isHolder('M1', 'A')).toBe(false);
      safety.restore();
      w.dispose();
    }, 120000);
  }
});

// ── §9.3 occupancy check (unit level) ─────────────────────────────────────

const P: MbParams = { vmax: 1, a: 0.5, b: 0.5, aLat: 0.5, front: 0.5, rear: 1.5, width: 0.8, gap: 0.2, dockSpeed: 0.2, dockDist: 0.3, scanner: null };

function stubHost(t: number): MbHost {
  return { now: () => t, nextEventTime: () => Infinity, schedule: () => -1, cancel: () => {}, legTween: () => null, serviceStopAt: () => false, canMove: () => true };
}

interface V { held: Map<string, number>; plan: { route: { path: RVPath; x0: number }[]; profile: unknown; dir: 1 | -1 }; curIdx: number }

function addPath(id: string, from: number[], to: number[], succ: string[], zone?: string): void {
  getDefaultPathNetwork().register(parsePathExtras({
    type: 'Path', version: 1, closed: false, align: [0, 1, 0], id,
    segments: [{ kind: 'line', from, to }], successors: succ, ...(zone ? { zone, zoneCapacity: 1 } : {}),
  }, id)!);
}

/** Private occupancy check of the instance (test seam). */
function occupied(mb: MovementAuthority, id: string, z: string, t: number): boolean {
  return (mb as unknown as { zoneMayBeOccupied(v: unknown, z: string, now: number): boolean })
    .zoneMayBeOccupied((mb as unknown as { vehicles: Map<string, unknown> }).vehicles.get(id), z, t);
}

describe('plan-686 9.3 — occupancy check', () => {
  it('c) clamping supplement: inner position adds nothing, overrun at either end (and in reverse) adds |overrun|', () => {
    // A - B - C in a row; the zone piece Z lies on a separate line 3.0 m beyond C's end (graph-far, space-far).
    addPath('A', [0, 0, 0], [5, 0, 0], ['B']);
    addPath('B', [5, 0, 0], [10, 0, 0], ['C']);
    addPath('C', [10, 0, 0], [12, 0, 0], ['Z']);
    addPath('Z', [12.0, 0, 0], [15, 0, 0], [], 'ZZ');
    getDefaultPathNetwork().resolveGraph();
    const mb = getDefaultMovementAuthority('des');
    const B = getDefaultPathNetwork().get('B')!;
    // Root on B at s = 5 (its end): distance to Z (start of Z) = 2.0 (C) -> R = 1.5 + 0.06 = 1.56 < 2.0 graph-free;
    // spatial: rb = hypot(1.5, 0.4) = 1.552 + 0.4 + 0.025 + 0.05 = 2.027 > 2.0 -> occupied by space. Use s = 4.8.
    mb.register('V', { id: 'V', path: B, s: 4.8 } as unknown as PathTraveler, stubHost(1), P);
    const v = (mb as unknown as { vehicles: Map<string, V> }).vehicles.get('V')!;
    const at = (x: number, dir: 1 | -1 = 1): boolean => {
      v.plan.route = [{ path: B, x0: 0 }];
      v.plan.profile = stationaryProfile(1, x);
      v.plan.dir = dir;
      v.curIdx = 0;
      return occupied(mb, 'V', 'ZZ', 1);
    };
    expect(at(4.8)).toBe(false);           // inner position: c = 0 -> free
    expect(at(5.6)).toBe(true);            // overrun beyond the end by 0.8 m -> R and the disc grow by 0.8
    expect(at(-0.8)).toBe(true);           // overrun before the start (|u|) counts the same
    expect(at(5.6, -1)).toBe(true);        // reverse plan: the same clamping distance
  });

  it('c2) a laterally adjacent zone (graph-far) is occupied by space; another entry of a reached merge piece by the undirected graph', () => {
    // Lane L1 (0..10, z = 0); a parallel lane Q at z = 1.2 in zone ZQ, connected only far away.
    addPath('L1', [0, 0, 0], [10, 0, 0], ['L2']);
    addPath('L2', [10, 0, 0], [12, 0, 0], ['M']);
    addPath('Q', [0, 0, 1.2], [10, 0, 1.2], ['Q2'], 'ZQ');
    addPath('Q2', [10, 0, 1.2], [30, 0, 1.2], ['Q3']);
    addPath('Q3', [30, 0, 1.2], [30, 0, 40], []);
    // Merge piece M (zone ZM) with two entries: L2 and a side branch S (zone ZS) ending at M's start.
    addPath('S', [12, 0, -1.0], [12, 0, 0], ['M'], 'ZS');
    addPath('M', [12, 0, 0], [14, 0, 0], [], 'ZM');
    getDefaultPathNetwork().resolveGraph();
    const mb = getDefaultMovementAuthority('des');
    const L1 = getDefaultPathNetwork().get('L1')!;
    const L2 = getDefaultPathNetwork().get('L2')!;
    mb.register('V', { id: 'V', path: L1, s: 5 } as unknown as PathTraveler, stubHost(1), P);
    expect(occupied(mb, 'V', 'ZQ', 1)).toBe(true);  // 1.2 m beside the root
    mb.register('W', { id: 'W', path: L2, s: 1.2 } as unknown as PathTraveler, stubHost(1), { ...P, width: 0.1 });
    // W's front reaches M within R; the side entry S shares M's start point -> undirected neighbour.
    expect(occupied(mb, 'W', 'ZS', 1)).toBe(true);
    // A far zone is free.
    addPath('F', [100, 0, 100], [101, 0, 100], [], 'ZF');
    getDefaultPathNetwork().resolveGraph();
    expect(occupied(mb, 'W', 'ZF', 1)).toBe(false);
  });

  it('e) falsification: the geometric helper reports a release of an occupied zone', () => {
    stubLayout({ preLen: 6 });
    const w = makeStubWorld('fastforward', [{ name: 'A', cfg: forkCfg('R3', 6000), mesh: FORK_MESH, body: FORK }], 200);
    // Deliberately broken occupancy: every candidate counts as free.
    (w.mb as unknown as { zoneMayBeOccupied: () => boolean }).zoneMayBeOccupied = () => false;
    const safety = watchReleases(w.mb, () => w.names);
    const fleet = getDefaultAgvFleet();
    fleet.get('A')!.assign({ destination: 'R1' });
    let changed = false;
    getDefaultPathNetwork().setRouter({
      onArrive: (pathId, id) => {
        if (id === 'A' && pathId === 'L1' && !changed) { changed = true; fleet.get('A')!.assign({ destination: 'S2', approach: 'reverse', serviceSec: 2 }); }
      },
    }, 'agv-zone-stale-hold-e');
    while (!w.done()) w.step();
    expect(changed).toBe(true);
    expect(safety.releases.some((x) => x.zone === 'M1')).toBe(true);
    expect(safety.violations.length).toBeGreaterThan(0); // the helper sees the body in M1
    safety.restore();
    delete (w.mb as unknown as { zoneMayBeOccupied?: unknown }).zoneMayBeOccupied;
    w.dispose();
  }, 120000);
});

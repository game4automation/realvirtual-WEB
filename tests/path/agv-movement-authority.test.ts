// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 §9.3 / §9.4 — the trajectory-based moving block
 * (rv-movement-authority) on the real Agv in the DES kernel.
 *
 * §9.3 route walk (unit block, observed through the applied plan): horizon
 * always ends in a stop that keeps the body out of unknown track, many short
 * pieces, ring laps as separate route entries, service stop marking.
 * §9.4 integration: leader trajectory following (exact + 60 Hz oracle),
 * dependents on slower / faster leader plans, the re-plan cap with its SAFE
 * hold plan (R2-2), zone wake-ups by foreign releases / releaseAll /
 * capacity increase as a coalesced flush at the release time (R2-4),
 * watchdog never firing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { positionAt } from '../../src/core/engine/rv-motion-profile';
import { DESRunner } from '@rv/plugins/des/des-runner';
import {
  TICK, makeHost, makeAgvRoot, bindDes, clearShared, runAnimated, centredBody,
} from '../helpers/agv-harness';

beforeEach(() => clearShared());

const net = (): ReturnType<typeof getDefaultPathNetwork> => getDefaultPathNetwork();
function add(raw: Record<string, unknown>): void {
  net().register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], ...raw }, raw.id as string)!);
}
const line = (x0: number, x1: number, z = 0): Record<string, unknown> => ({ kind: 'line', from: [x0, 0, z], to: [x1, 0, z] });

function startRunner(specs: Array<[string, Record<string, unknown>]>): { runner: DESRunner; roots: Object3D[] } {
  const runner = new DESRunner({ subMode: 'animated' });
  const host = makeHost();
  const roots = specs.map(([n, c]) => makeAgvRoot(n, { VehicleLength: 1000, VehicleWidth: 600, ...c }));
  roots.forEach((r) => bindDes(runner, r, host));
  runner.start([], { root: new Object3D() });
  return { runner, roots };
}

function tickTo(runner: DESRunner, from: number, to: number, each?: (t: number) => void): void {
  for (let f = Math.round(from / TICK) + 1; f <= Math.round(to / TICK); f++) {
    runner.tick(TICK);
    runner.lateTick(TICK);
    each?.(f * TICK);
  }
}

describe('route walk (plan-558 §9.3)', () => {
  it('the horizon ends in a stop that keeps the body on known track, over ≥ 20 short pieces', () => {
    const ids = Array.from({ length: 80 }, (_, i) => `P${i}`);
    ids.forEach((id, i) => add({ id, segments: [line(i * 0.4, (i + 1) * 0.4)], successors: i + 1 < ids.length ? [ids[i + 1]] : [] }));
    net().resolveGraph();
    const { runner } = startRunner([['V', { PathId: 'P0', StartPosition: 100 }]]);
    tickTo(runner, 0, 0.1);
    const plan = getDefaultMovementAuthority('des').planOf('V')!;
    expect(plan.stopCause).toBe('horizon');
    expect(plan.route.length).toBeGreaterThanOrEqual(20);
    const end = plan.route[plan.route.length - 1];
    // Body front never beyond the walked track (front 0.5 m + margin).
    expect(plan.profile.xStop + 0.5).toBeLessThanOrEqual(end.x0 + end.path.length + 1e-9);
    // Extended before the vehicle has to brake: it keeps cruising.
    let minV = Infinity;
    tickTo(runner, 0.1, 25, (t) => { if (t > 3) minV = Math.min(minV, getDefaultMovementAuthority('des').speedOf('V', t)); });
    expect(minV).toBeGreaterThan(0.99);
    runner.dispose();
  });

  it('a closed ring is walked as separate laps (same path, increasing route offsets)', () => {
    add({ id: 'Ring', closed: true, segments: [{ kind: 'arc', center: [0, 0, 0], radius: 2, startAngle: 0, degrees: 360, plane: 'XZ' }] });
    net().resolveGraph();
    const { runner } = startRunner([['V', { PathId: 'Ring', StartPosition: 0, LateralAcceleration: 2000 }]]);
    tickTo(runner, 0, 0.1);
    const plan = getDefaultMovementAuthority('des').planOf('V')!;
    expect(plan.route.length).toBeGreaterThanOrEqual(2);
    expect(plan.route.every((e) => e.path.id === 'Ring')).toBe(true);
    for (let i = 1; i < plan.route.length; i++) expect(plan.route[i].x0).toBeCloseTo(plan.route[i - 1].x0 + 4 * Math.PI, 9);
    runner.dispose();
  });

  it('a dock / task destination ends the walk as a service stop at the piece end', () => {
    add({ id: 'A', segments: [line(0, 5)], successors: ['B'] });
    add({ id: 'B', segments: [line(5, 9)], successors: ['C'] });
    add({ id: 'C', segments: [line(9, 20)] });
    net().resolveGraph();
    getDefaultPathDockRegistry().register('B', { onVehicleArrive: (_id, release) => release() });
    const { runner } = startRunner([['V', { PathId: 'A', StartPosition: 1000 }]]);
    tickTo(runner, 0, 0.1);
    const plan = getDefaultMovementAuthority('des').planOf('V')!;
    expect(plan.stopCause).toBe('service');
    expect(plan.route.map((e) => e.path.id)).toEqual(['A', 'B']);
    expect(plan.profile.xStop).toBeCloseTo(9, 9);
    runner.dispose();
  });
});

describe('moving block integration (plan-558 §9.4)', () => {
  function straight(): void {
    add({ id: 'S1', segments: [line(0, 20)], successors: ['C1'] });
    add({ id: 'C1', segments: [{ kind: 'arc', center: [20, 0, 3], radius: 3, startAngle: -90, degrees: 90, plane: 'XZ' }], successors: ['S2'] });
    add({ id: 'S2', segments: [{ kind: 'line', from: [23, 0, 3], to: [23, 0, 30] }] });
    net().resolveGraph();
  }

  it('a fast follower behind a slow leader keeps ≥ SafetyGap over the whole leader trajectory', () => {
    straight();
    const { runner, roots } = startRunner([
      ['Lead', { PathId: 'S1', StartPosition: 5000, TargetSpeed: 500, ScannerFields: false }],
      ['Follow', { PathId: 'S1', StartPosition: 600, TargetSpeed: 1000, ScannerFields: false }],
    ]);
    const mb = getDefaultMovementAuthority('des');
    let minFR = Infinity, tCatch = -1;
    const m = runAnimated(runner, { roots, names: ['Lead', 'Follow'], bodies: roots.map(() => centredBody(1, 0.6)) }, 60, (f) => {
      const g = mb.minFrontRearGap(f * TICK);
      if (g < minFR) minFR = g;
      if (tCatch < 0 && g < 0.3 + 0.006) tCatch = f * TICK; // bisection resolution 5 mm
    });
    runner.dispose();
    expect(mb.stats.violations).toBe(0);
    expect(m.overlapFrames).toBe(0);
    expect(minFR).toBeGreaterThanOrEqual(0.3 - 1e-6);
    expect(tCatch).toBeGreaterThan(0); // it does catch up to exactly the gap (no stop-and-go reserve)
    expect(mb.stats.watchdogFires).toBe(0);
  });

  it('a SLOWER leader plan re-plans every dependent at once (hard); a FASTER one only the bound followers', () => {
    straight();
    const { runner } = startRunner([
      ['Lead', { PathId: 'S1', StartPosition: 4000, ScannerFields: false }],
      ['Follow', { PathId: 'S1', StartPosition: 1500, ScannerFields: false }],
    ]);
    const mb = getDefaultMovementAuthority('des');
    tickTo(runner, 0, 3);
    const v0 = mb.versionOf('Follow');
    // Leader gets a destination right ahead → slower plan (brakes earlier).
    getDefaultAgvFleet().get('Lead')!.assign({ destination: 'S1', serviceSec: 4 });
    tickTo(runner, 3, 3.1);
    expect(mb.stats.dirtyBy['dependent-hard'] ?? 0).toBeGreaterThan(0);
    expect(mb.versionOf('Follow')).toBeGreaterThan(v0);
    // After the service the leader drives off again (faster plan): the bound follower re-plans.
    tickTo(runner, 3.1, 40);
    expect((mb.stats.dirtyBy['dependent-soft'] ?? 0) + mb.stats.softDeferred).toBeGreaterThan(0);
    expect(mb.stats.violations).toBe(0);
    expect(mb.stats.forced).toBe(0);
    runner.dispose();
  });

  it('R2-2: a re-plan cap hit after the start yields an immediately SAFE hold plan (independent distance check)', () => {
    add({ id: 'Long', segments: [line(0, 80)] });
    add({ id: 'Park', segments: [line(0, 4, 5)] });
    net().resolveGraph();
    const { runner, roots } = startRunner([
      ['Lead', { PathId: 'Long', StartPosition: 6000, ScannerFields: false }],
      ['Mid', { PathId: 'Long', StartPosition: 3500, ScannerFields: false }],
      ['Tail', { PathId: 'Long', StartPosition: 1000, ScannerFields: false }],
      ['Clock', { PathId: 'Park', StartPosition: 0, ScannerFields: false }],
    ]);
    const mb = getDefaultMovementAuthority('des');
    let tCap = -1;
    // At the end of Clock's service (an event, mid-run, all three cruising in
    // a tight queue): from now on EVERY re-plan is a cap hit, and the leader
    // must stop (Run off) — its hold and every follower re-plan go through
    // the safe-hold path.
    getDefaultAgvFleet().get('Clock')!.assign({
      destination: 'Park', serviceSec: 6,
      onServiceEnd: () => {
        tCap = runner.getManager().currentTime;
        mb.replanCap = 0;
        (roots[0].userData.__runSig as ((v: boolean) => void) | undefined)?.(false);
        getDefaultAgvFleet().get('Lead')!.clear();
      },
    });
    // Run=false on the leader through its own signal accessor.
    const leadSelf = (runner.liveInstances.find((i) => i.self.root === roots[0])!.self) as unknown as {
      sig: { Run: { set(v: boolean): void } };
    };
    roots[0].userData.__runSig = (v: boolean): void => leadSelf.sig.Run.set(v);
    let minFR = Infinity;
    const vehicles = roots.slice(0, 3);
    const m = runAnimated(runner, { roots: vehicles, names: ['Lead', 'Mid', 'Tail'], bodies: vehicles.map(() => centredBody(1, 0.6)) }, 40, (f) => {
      const g = mb.minFrontRearGap(f * TICK);
      if (g < minFR) minFR = g;
    });
    // Independent oracle: root distances along the straight line (x axis).
    const xs = vehicles.map((r) => r.position.x);
    runner.dispose();
    console.log(`[agv-mb] cap tCap=${tCap.toFixed(2)} overlap=${m.overlapFrames} minFR=${minFR.toFixed(3)} capHits=${mb.stats.cascadeCapHitsAfterStart}`
      + ` safeHolds=${mb.stats.safeHolds} forced=${mb.stats.forced} xs=${xs.map((z) => z.toFixed(3)).join(',')}`);
    expect(tCap).toBeGreaterThan(5);
    // plan-595 wake-up guard: with the cap at 0 the standing vehicles get wake-up re-plans with a
    // back-off — bounded per vehicle and BEGUN sim minute (analytic worst case 70, bound 120; see
    // agv-reverse-safe-hold.test.ts). Without the back-off this would be ~60 000.
    // SCOPE: calibrated for operation with a cap (replanCap >= 1) and for THIS small cap-0 stand (three
    // vehicles on a straight lane). NOT for cap 0 on a full fleet / the constructed FastForward path of
    // agv-forward-hold-parity — ~477 per vehicle and minute from `soft-recheck` re-plans are normal there;
    // do not carry the bound over unchecked.
    // WHICH TEST CATCHES WHICH FAULT: missing wake-up (standstill) -> 9.10 Animated (tasks not done),
    // not this guard (a standstill produces FEWER safe holds); missing back-off (wake-up flood) -> THIS
    // test + the guard (mutation: Lead 25 045 per minute). In 9.10 the guard is practically toothless
    // (load only on the timer vehicle).
    const capMin = Math.max(1, Math.ceil((40 - tCap) / 60));
    const perVehicle = Object.entries(mb.stats.safeHoldsBy).map(([id, n]) => [id, n / capMin] as const);
    console.log(`[agv-mb] cap safe holds per vehicle and begun sim minute: ${perVehicle.map(([id, r]) => `${id}=${r.toFixed(1)}`).join(' ')} wakes=${mb.stats.wakes}`);
    for (const [id, r] of perVehicle) expect(r, id).toBeLessThanOrEqual(120); // measured after the fix: max 37 (Clock), 35-36 (Lead/Mid/Tail)
    expect(mb.stats.cascadeCapHitsAfterStart).toBeGreaterThanOrEqual(2);
    expect(mb.stats.safeHolds).toBeGreaterThanOrEqual(2);
    expect(m.overlapFrames).toBe(0);
    expect(minFR).toBeGreaterThanOrEqual(0.3 - 1e-6);
    expect(mb.stats.forced).toBe(0);
    expect(mb.stats.violations).toBe(0);
    expect(xs[0] - xs[1]).toBeGreaterThanOrEqual(1.3 - 1e-6);
    expect(xs[1] - xs[2]).toBeGreaterThanOrEqual(1.3 - 1e-6);
    // The leader really stopped (Run off); the followers hold behind it.
    expect(mb.speedOf('Lead', 40)).toBe(0);
  });

  function zoneCourse(): void {
    add({ id: 'In', segments: [line(0, 10)], successors: ['Z'] });
    add({ id: 'Z', segments: [line(10, 12)], successors: ['Out'], zone: 'Z' });
    add({ id: 'Out', segments: [line(12, 30)] });
    add({ id: 'Park', segments: [line(0, 4, 5)] });
    net().resolveGraph();
  }

  for (const how of ['release', 'releaseAll', 'capacity'] as const) {
    it(`R2-4: a foreign ${how} wakes a QUIET waiting fleet at exactly the release time`, () => {
      zoneCourse();
      const zones = getDefaultZoneRegistry();
      zones.claim('Z', 'PLC');
      const { runner } = startRunner([
        ['A', { PathId: 'In', StartPosition: 1000, ScannerFields: false }],
        ['B', { PathId: 'Park', StartPosition: 0, ScannerFields: false }],
      ]);
      const mb = getDefaultMovementAuthority('des');
      // B's service ends ~16 s after its arrival and frees the zone from its
      // callback — an event of another vehicle, while A has long stopped.
      let tB = -1;
      getDefaultAgvFleet().get('B')!.assign({
        destination: 'Park', serviceSec: 16,
        onServiceEnd: () => {
          tB = runner.getManager().currentTime;
          if (how === 'release') zones.release('Z', 'PLC');
          else if (how === 'releaseAll') zones.releaseAll('PLC');
          else zones.redefine('Z', 2);
        },
      });
      let tRelease = -1;
      tickTo(runner, 0, 15);
      expect(mb.stopCauseOf('A')).toBe('zone');
      expect(mb.speedOf('A', 15)).toBe(0);
      tickTo(runner, 15, 30, (t) => { if (tRelease < 0 && mb.speedOf('A', t) > 0) tRelease = t; });
      const plan = mb.planOf('A')!;
      const tStart = plan.profile.t0;
      runner.dispose();
      expect(mb.stats.dirtyBy.zoneWake ?? 0).toBeGreaterThan(0);
      // The wake re-planned A at the release instant (B's service end), not at a poll.
      expect(tB).toBeGreaterThan(15);
      expect(tRelease).toBeGreaterThan(0);
      expect(Math.abs(tRelease - tB)).toBeLessThanOrEqual(TICK + 1e-6);
      expect(tStart).toBeLessThanOrEqual(tB + 1e-6);
      expect(positionAt(plan.profile, 30)).toBeGreaterThan(plan.profile.x0);
    });
  }

  it('the watchdog never fires on the ring stress case (12 AGVs, one capacity-1 zone, scanner off)', () => {
    add({ id: 'PathSouth', segments: [{ kind: 'line', from: [-5, 0, -3], to: [5, 0, -3] }], successors: ['PathEast'] });
    add({ id: 'PathEast', segments: [{ kind: 'arc', center: [5, 0, 0], radius: 3, startAngle: -90, degrees: 180, plane: 'XZ' }],
      successors: ['PathNorth'], zone: 'EastCurve', zoneCapacity: 1 });
    add({ id: 'PathNorth', segments: [{ kind: 'line', from: [5, 0, 3], to: [-5, 0, 3] }], successors: ['PathWest'] });
    add({ id: 'PathWest', segments: [{ kind: 'arc', center: [-5, 0, 0], radius: 3, startAngle: 90, degrees: 180, plane: 'XZ' }],
      successors: ['PathSouth'] });
    net().resolveGraph();
    const place: Array<[string, number]> = [
      ['PathSouth', 600], ['PathSouth', 3600], ['PathSouth', 6600], ['PathSouth', 9400], ['PathEast', 4700],
      ['PathNorth', 600], ['PathNorth', 3600], ['PathNorth', 6600], ['PathNorth', 9400],
      ['PathWest', 1000], ['PathWest', 3800], ['PathWest', 6600],
    ];
    const { runner, roots } = startRunner(place.map(([p, s], i) => [`R${String(i + 1).padStart(2, '0')}`, { PathId: p, StartPosition: s, ScannerFields: false }]));
    const mb = getDefaultMovementAuthority('des');
    const m = runAnimated(runner, { roots, names: roots.map((r) => r.name), bodies: roots.map(() => centredBody(1, 0.6)) }, 300);
    runner.dispose();
    console.log(`[agv-mb] ring overlap=${m.overlapFrames} maxStopped=${m.maxStoppedSec.toFixed(1)} violations=${mb.stats.violations}`
      + ` forced=${mb.stats.forced} watchdog=${mb.stats.watchdogFires} capHits=${mb.stats.cascadeCapHitsAfterStart}`);
    expect(mb.stats.violations).toBe(0);
    expect(mb.stats.forced).toBe(0);
    expect(mb.stats.watchdogFires).toBe(0);
    expect(m.overlapFrames).toBe(0);
    expect(m.maxStoppedSec).toBeLessThan(60);
    expect(mb.stats.events['Replan:zoneRelease'] ?? 0).toBeGreaterThan(20);
  });
});

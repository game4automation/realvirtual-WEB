// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-921 — low-level AGV task control: destination + dwell + callbacks.
 *
 * The primitive fleet logic builds on: `assign({destination, serviceSec,
 * onArrive, onServiceEnd})` drives the vehicle to ANY path segment by SHORTEST
 * DRIVING DISTANCE (Dijkstra over path lengths), dwells, fires the two
 * callbacks, chains follow-up tasks assigned inside `onServiceEnd`, and parks
 * idle (fleet idle channel) without one. A registered network router (central
 * control) wins every junction decision over the mechanical shortest path.
 *
 * Also covered here because they are task-adjacent physics guarantees:
 * continuous acceleration (bounded dv/dt, capped at TargetSpeed) and queueing
 * behind a dwelling vehicle (gap ∈ [MinGap, ~SafetyDistance], Blocked=true).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { iterateFixedUpdate } from '../../src/core/behavior-runtime';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet, type AgvTask } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { clearLiveControl } from '../../src/core/engine/rv-live-control';
import { AgvFlow } from '../../src/behaviors/Agv';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { makeHost, makeAgvRoot as makeAgv, bindContinuous, bindDes, clearShared, sig,
  type AgvTestHost as Host,
} from '../helpers/agv-harness';

const AgvDef = AgvFlow as unknown as MaterialFlowDefinition;
const TICK = 1 / 60;

// ─── Harness (agv-des-parity pattern) ───────────────────────────────────────

function line(id: string, x: number, z0: number, z1: number, successors: string[] = []): void {
  getDefaultPathNetwork().register(parsePathExtras({
    type: 'Path', id,
    segments: [{ kind: 'line', from: [x, 0, z0], to: [x, 0, z1] }],
    successors,
  }, id)!);
}

/** Y graph: A → (Short | Long) → C. Short branch wins by driving distance. */
function makeYGraph(): void {
  line('A', 0, 0, 2, ['Short', 'Long']);
  line('Short', 0, 2, 3, ['C']);   // 1 m
  line('Long', 1, 2, 12, ['C']);   // 10 m
  line('C', 0, 3, 5);              // 2 m — the destination segment
}

beforeEach(() => {
  clearShared(); // path network, spacing, zones, fleet, BOTH movement authorities, live control
  getDefaultPathDockRegistry().clear();
});
afterEach(() => clearLiveControl());

// ─── nextHopToward ──────────────────────────────────────────────────────────

describe('RVPathNetwork.nextHopToward — shortest driving distance', () => {
  it('picks the shorter branch toward the destination segment', () => {
    makeYGraph();
    const net = getDefaultPathNetwork();
    net.resolveGraph();
    expect(net.nextHopToward(net.get('A')!, 'C')!.id).toBe('Short');
  });

  it('unreachable / unknown destinations return null; from === target returns null', () => {
    makeYGraph();
    line('Island', 5, 0, 1); // no edges
    const net = getDefaultPathNetwork();
    net.resolveGraph();
    expect(net.nextHopToward(net.get('A')!, 'Island')).toBeNull();
    expect(net.nextHopToward(net.get('A')!, 'DoesNotExist')).toBeNull();
    expect(net.nextHopToward(net.get('C')!, 'C')).toBeNull();
  });

  it('the memoised hop follows a graph change (cache invalidation)', () => {
    makeYGraph();
    const net = getDefaultPathNetwork();
    net.resolveGraph();
    expect(net.nextHopToward(net.get('A')!, 'C')!.id).toBe('Short');
    // Shorten the LONG branch to 0.5 m — now it wins.
    net.register(parsePathExtras({
      type: 'Path', id: 'Long',
      segments: [{ kind: 'line', from: [1, 0, 2], to: [1, 0, 2.5] }],
      successors: ['C'],
    }, 'Long')!);
    net.resolveGraph();
    expect(net.nextHopToward(net.get('A')!, 'C')!.id).toBe('Long');
  });
});

// ─── Continuous task control ────────────────────────────────────────────────

describe('Agv task — destination + dwell + callbacks (continuous)', () => {
  const CFG = { PathId: 'A', TargetSpeed: 2000, UseAcceleration: false, SafetyDistance: 500, MinGap: 100 };

  it('drives the SHORT branch to the destination, dwells, fires callbacks in order, then idles', () => {
    makeYGraph();
    const host = makeHost();
    const root = makeAgv('V1', CFG);
    const h = bindContinuous(root, host);
    const fleet = getDefaultAgvFleet();
    const events: string[] = [];
    let arriveTick = -1, serviceEndTick = -1, idleTick = -1;
    fleet.onIdle((id) => { events.push('idle:' + id); idleTick = tick; });

    let tick = 0;
    fleet.get('V1')!.assign({
      destination: 'C',
      serviceSec: 0.5,
      onArrive: (id) => { events.push('arrive:' + id); arriveTick = tick; },
      onServiceEnd: (id) => { events.push('serviceEnd:' + id); serviceEndTick = tick; },
    });
    for (; tick < 900; tick++) {
      iterateFixedUpdate(h, TICK);
      if (idleTick >= 0) break;
    }

    expect(events).toEqual(['arrive:V1', 'serviceEnd:V1', 'idle:V1']);
    // Dwell length: 0.5 s at 60 Hz ≈ 30 ticks (±2 — entry/exit tick rounding).
    expect(serviceEndTick - arriveTick).toBeGreaterThanOrEqual(28);
    expect(serviceEndTick - arriveTick).toBeLessThanOrEqual(32);
    // Parked at the END of the destination segment 'C' (z = 5), on the SHORT
    // branch's x lane (x = 0 — the long branch detours via x = 1).
    expect(root.position.z).toBeCloseTo(5, 2);
    expect(root.position.x).toBeCloseTo(0, 3);
    expect(fleet.get('V1')!.phase).toBe('idle');
    expect(sig(host, 'V1', 'Moving')).toBe(false);
    // Total travel: A rest (2 m) + Short (1 m) + C (2 m) = 5 m at 2 m/s = 2.5 s
    // (150 ticks) + 30 dwell — the LONG branch (13 m) would need > 390 ticks.
    expect(arriveTick).toBeLessThan(190);
  });

  it('a follow-up task assigned inside onServiceEnd chains without idling', () => {
    line('P1', 0, 0, 2, ['P2']);
    line('P2', 0, 2, 4, ['P1']); // loop back so both directions route
    const host = makeHost();
    const root = makeAgv('V1', { PathId: 'P1', TargetSpeed: 2000, UseAcceleration: false });
    const h = bindContinuous(root, host);
    const fleet = getDefaultAgvFleet();
    const visits: string[] = [];
    let idles = 0;
    fleet.onIdle(() => { idles++; });

    const secondLeg: AgvTask = { destination: 'P1', serviceSec: 0, onArrive: () => visits.push('P1') };
    fleet.get('V1')!.assign({
      destination: 'P2',
      serviceSec: 0.1,
      onArrive: () => visits.push('P2'),
      onServiceEnd: () => fleet.get('V1')!.assign(secondLeg),
    });
    for (let i = 0; i < 1200 && visits.length < 2; i++) iterateFixedUpdate(h, TICK);

    expect(visits).toEqual(['P2', 'P1']);
    // The chain re-armed immediately — the vehicle never went idle in between.
    expect(fleet.get('V1')!.phase).not.toBe('cruising');
    for (let i = 0; i < 120 && idles === 0; i++) iterateFixedUpdate(h, TICK);
    expect(idles).toBe(1); // second task had no follow-up → idle exactly once
  });

  it('a registered network router (central control) overrides the shortest-path hop', () => {
    makeYGraph();
    const net = getDefaultPathNetwork();
    net.setRouter({ selectNextPath: (c) => (c.includes('Long') ? 'Long' : undefined) }, 'test');
    const host = makeHost();
    const root = makeAgv('V1', { PathId: 'A', TargetSpeed: 4000, UseAcceleration: false });
    const h = bindContinuous(root, host);
    getDefaultAgvFleet().get('V1')!.assign({ destination: 'C' });
    let onLong = false;
    for (let i = 0; i < 600; i++) {
      iterateFixedUpdate(h, TICK);
      if (Math.abs(root.position.x - 1) < 1e-3) onLong = true; // long branch lane x=1
      if (getDefaultAgvFleet().get('V1')!.phase === 'idle') break;
    }
    expect(onLong).toBe(true); // took the router's pick, not the short branch
    expect(root.position.z).toBeCloseTo(5, 2);
  });

  it('the declarative config task (Destination/ServiceTime) drives and idles', () => {
    makeYGraph();
    const host = makeHost();
    const root = makeAgv('V1', { ...CFG, Destination: 'C', ServiceTime: 0.1 });
    const h = bindContinuous(root, host);
    for (let i = 0; i < 900 && getDefaultAgvFleet().get('V1')!.phase !== 'idle'; i++) {
      iterateFixedUpdate(h, TICK);
    }
    expect(getDefaultAgvFleet().get('V1')!.phase).toBe('idle');
    expect(root.position.z).toBeCloseTo(5, 2);
  });
});

// ─── Physics guarantees around tasks ────────────────────────────────────────

describe('Agv physics — continuous acceleration + queueing behind a dwell', () => {
  it('accelerates continuously (bounded dv/dt) and caps at TargetSpeed', () => {
    line('Straight', 0, 0, 50);
    const host = makeHost();
    const root = makeAgv('V1', {
      PathId: 'Straight', TargetSpeed: 1000, Acceleration: 1000, UseAcceleration: true,
    });
    const h = bindContinuous(root, host);
    const t = (getDefaultSpacingController() as unknown as {
      byId: Map<string, { traveler: { v: number } }>;
    }).byId.get('V1')!.traveler;

    let prevV = 0;
    for (let i = 0; i < 90; i++) {
      iterateFixedUpdate(h, TICK);
      const dv = t.v - prevV;
      expect(dv).toBeGreaterThanOrEqual(0);                 // monotone ramp-up
      expect(dv).toBeLessThanOrEqual(1000 * TICK * 1.01);   // bounded by Acceleration
      expect(t.v).toBeLessThanOrEqual(1000 + 1e-6);         // capped at TargetSpeed
      prevV = t.v;
    }
    expect(prevV).toBeCloseTo(1000, 3); // reached max speed (1 s ramp + margin)
  });

  it('a follower queues behind a dwelling vehicle: body gap = SafetyGap (plan-558), Blocked', () => {
    line('P1', 0, 0, 5, ['P2']);
    line('P2', 0, 5, 10);
    const host = makeHost();
    const leader = makeAgv('Lead', {
      PathId: 'P1', StartPosition: 4000, TargetSpeed: 1000, UseAcceleration: false,
    });
    const follower = makeAgv('Follow', {
      PathId: 'P1', StartPosition: 0, TargetSpeed: 1500, Acceleration: 1500,
      UseAcceleration: true, SafetyDistance: 1000, MinGap: 200,
    });
    const hL = bindContinuous(leader, host);
    const hF = bindContinuous(follower, host);
    getDefaultAgvFleet().get('Lead')!.assign({ destination: 'P2', serviceSec: 60 });

    // 25 s: the follower's scanner warning field holds it at DockingSpeed
    // (0.3 m/s) over the last metres of the approach to the standing leader.
    for (let i = 0; i < 1500; i++) {
      iterateFixedUpdate(hL, TICK);
      iterateFixedUpdate(hF, TICK);
    }
    // Leader dwells at the end of P2 (z=10); follower parked behind it.
    expect(leader.position.z).toBeCloseTo(10, 2);
    expect(getDefaultAgvFleet().get('Lead')!.phase).toBe('servicing');
    // plan-558: the planned follower keeps SafetyGap (300 mm default) between
    // its front and the leader's rear — 1 m fallback bodies → 1.3 m root gap
    // (the legacy leader is an obstacle for the planner, mixed fleet).
    const gapMm = (leader.position.z - follower.position.z) * 1000;
    expect(gapMm).toBeGreaterThanOrEqual(1300 - 1e-6);
    expect(gapMm).toBeLessThanOrEqual(1300 + 10);
    expect(sig(host, 'Follow', 'Moving')).toBe(false);
    expect(sig(host, 'Follow', 'Blocked')).toBe(true);
  });
});

// ─── Path docks — the generic station adapter ───────────────────────────────

describe('PathDock — a station bound to a segment controls the stay', () => {
  it('a THROUGH dock holds every passing vehicle until release(), then it drives on', () => {
    line('P1', 0, 0, 2, ['P2']);
    line('P2', 0, 2, 4, ['P3']);   // docked segment — station at its end
    line('P3', 0, 4, 6);
    const host = makeHost();
    const root = makeAgv('V1', { PathId: 'P1', TargetSpeed: 2000, UseAcceleration: false });
    const h = bindContinuous(root, host);
    let releaseFn: (() => void) | null = null;
    const arrivals: string[] = [];
    getDefaultPathDockRegistry().register('P2', {
      onVehicleArrive: (id, release) => { arrivals.push(id); releaseFn = release; },
    });

    // Cruising (no task) — the dock must still capture the vehicle at P2's end.
    let held = 0;
    for (let i = 0; i < 600 && arrivals.length === 0; i++) iterateFixedUpdate(h, TICK);
    expect(arrivals).toEqual(['V1']);
    for (let i = 0; i < 60; i++) { iterateFixedUpdate(h, TICK); held++; }
    expect(root.position.z).toBeCloseTo(4, 3);     // parked at the dock (end of P2)
    expect(held).toBe(60);
    releaseFn!();
    for (let i = 0; i < 300; i++) iterateFixedUpdate(h, TICK);
    expect(root.position.z).toBeCloseTo(6, 2);     // continued to the dead end of P3
  });

  it('a dock at the TASK destination overrides serviceSec (the station decides)', () => {
    line('P1', 0, 0, 2, ['P2']);
    line('P2', 0, 2, 4);
    const host = makeHost();
    const root = makeAgv('V1', { PathId: 'P1', TargetSpeed: 2000, UseAcceleration: false });
    const h = bindContinuous(root, host);
    const events: string[] = [];
    getDefaultPathDockRegistry().register('P2', {
      onVehicleArrive: (_id, release) => { events.push('dock'); release(); }, // zero-time handling
    });
    getDefaultAgvFleet().get('V1')!.assign({
      destination: 'P2',
      serviceSec: 60, // would park for a minute — the dock overrides
      onArrive: () => events.push('arrive'),
      onServiceEnd: () => events.push('serviceEnd'),
    });
    let idle = false;
    getDefaultAgvFleet().onIdle(() => { idle = true; });
    for (let i = 0; i < 600 && !idle; i++) iterateFixedUpdate(h, TICK);
    expect(idle).toBe(true); // finished WAY before 60 s
    expect(events).toEqual(['arrive', 'dock', 'serviceEnd']);
  });
});

// ─── DES task control ───────────────────────────────────────────────────────

describe('Agv task — DES mode (event-driven dwell)', () => {
  it('drives to the destination, dwells by event, chains and idles — with correct timing', () => {
    line('A', 0, 0, 2, ['B']);
    line('B', 0, 2, 4);
    const host = makeHost();
    const root = makeAgv('V1', { PathId: 'A', TargetSpeed: 1000, UseAcceleration: false });
    const runner = new DESRunner({ subMode: 'animated' });
    const self = bindDes(runner, root, host);
    const fleet = getDefaultAgvFleet();
    const marks: Array<[string, number]> = [];
    fleet.onIdle(() => marks.push(['idle', self.now]));

    runner.start([AgvDef], { root: new Object3D() });
    fleet.get('V1')!.assign({
      destination: 'B',
      serviceSec: 2,
      onArrive: () => marks.push(['arrive', self.now]),
      onServiceEnd: () => marks.push(['serviceEnd', self.now]),
    });
    for (let i = 0; i < 60 * 10 && marks.length < 3; i++) {
      runner.tick(TICK);
      runner.lateTick(TICK);
    }
    runner.dispose();

    expect(marks.map(m => m[0])).toEqual(['arrive', 'serviceEnd', 'idle']);
    // Travel: 4 m at 1 m/s = 4 s; dwell 2 s → dwellEnd ≈ 6 s (event timing, ±tick).
    expect(marks[0][1]).toBeGreaterThan(3.8);
    expect(marks[0][1]).toBeLessThan(4.3);
    expect(marks[1][1] - marks[0][1]).toBeCloseTo(2, 1);
    expect(fleet.get('V1')!.phase).toBe('idle');
    expect(sig(host, 'V1', 'Position')).toBeCloseTo(2000, 0); // end of B (2 m segment)
  });
});

describe('Agv docks — DES mode', () => {
  it('a dock holds the DES leg chain until release(), then the vehicle continues', () => {
    line('A', 0, 0, 2, ['B']);
    line('B', 0, 2, 4, ['C']);   // docked through-segment
    line('C', 0, 4, 6);
    const host = makeHost();
    const root = makeAgv('V1', { PathId: 'A', TargetSpeed: 1000, UseAcceleration: false });
    const runner = new DESRunner({ subMode: 'animated' });
    const self = bindDes(runner, root, host);
    let releaseFn: (() => void) | null = null;
    let arriveTime = -1;
    getDefaultPathDockRegistry().register('B', {
      onVehicleArrive: (_id, release) => { arriveTime = self.now; releaseFn = release; },
    });
    runner.start([AgvDef], { root: new Object3D() });

    // Arrival at B's end after 4 m at 1 m/s = 4 s; hold 2 s, then release.
    for (let i = 0; i < 60 * 6 && !releaseFn; i++) { runner.tick(TICK); runner.lateTick(TICK); }
    expect(arriveTime).toBeGreaterThan(3.8);
    expect(arriveTime).toBeLessThan(4.3);
    for (let i = 0; i < 120; i++) { runner.tick(TICK); runner.lateTick(TICK); } // 2 s held
    expect(sig(host, 'V1', 'Position')).toBeCloseTo(2000, 0); // still at B's end
    releaseFn!();
    for (let i = 0; i < 60 * 4; i++) { runner.tick(TICK); runner.lateTick(TICK); }
    runner.dispose();
    expect(sig(host, 'V1', 'Position')).toBeCloseTo(2000, 0); // end of C (2 m segment)
  });
});

describe('Agv DES parity — segment occupancy queueing (Stau an Pfadenden)', () => {
  it('plan-558: no segment-occupancy rule — the follower queues SafetyGap behind the serving leader; both finish in order', () => {
    // Corridor P1 → P2 → P3; the leader serves 3 s at the end of P2 (its
    // destination). The old one-vehicle-per-segment rule is gone: the follower
    // drives up to SafetyGap behind the leader's rear (on P2 if it fits) and
    // waits there; bodies never overlap.
    line('P1', 0, 0, 2, ['P2']);
    line('P2', 0, 2, 4, ['P3']);
    line('P3', 0, 4, 6);
    const host = makeHost();
    // Scanner fields off: the warning field would cap the follower's approach.
    const leader = makeAgv('Lead', { PathId: 'P1', StartPosition: 1500, TargetSpeed: 1000, UseAcceleration: false, ScannerFields: false });
    const follower = makeAgv('Follow', { PathId: 'P1', StartPosition: 0, TargetSpeed: 1000, UseAcceleration: false, ScannerFields: false });
    const runner = new DESRunner({ subMode: 'animated' });
    bindDes(runner, leader, host);
    bindDes(runner, follower, host);
    const fleet = getDefaultAgvFleet();
    runner.start([AgvDef], { root: new Object3D() });
    fleet.get('Lead')!.assign({ destination: 'P2', serviceSec: 3,
      onServiceEnd: () => fleet.get('Lead')!.assign({ destination: 'P3' }) });
    fleet.get('Follow')!.assign({ destination: 'P2' });

    let minGap = Infinity;
    let followWaited = false;
    for (let i = 0; i < 60 * 30; i++) {
      runner.tick(TICK);
      runner.lateTick(TICK);
      // 1 m fallback bodies: root distance − 1 m = front-to-rear gap.
      const gap = leader.position.z - follower.position.z - 1;
      if (gap < minGap) minGap = gap;
      if (fleet.get('Lead')!.phase === 'servicing' && sig(host, 'Follow', 'Blocked') === true) followWaited = true;
      if (fleet.get('Lead')!.phase === 'idle' && fleet.get('Follow')!.phase === 'idle') break;
    }
    runner.dispose();
    expect(minGap).toBeGreaterThanOrEqual(0.3 - 1e-6);
    expect(followWaited).toBe(true);
    expect(fleet.get('Lead')!.phase).toBe('idle');
    expect(fleet.get('Follow')!.phase).toBe('idle');
    expect(leader.position.z).toBeCloseTo(6, 4);
    expect(follower.position.z).toBeCloseTo(4, 4);
  });
});

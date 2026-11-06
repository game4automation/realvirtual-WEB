// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Controlled AGV diagnostic fixture: real FleetJobRunner, WaitWatch, movement
 * authority freeze notifications and zone registry, on an injected sim clock.
 * Like the zone-wait equivalence tests, seed applied plans / waiter entries
 * directly so every blocker (including cycles) is placed deterministically.
 * No WebGL scene or calibrated stochastic failure instant is needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgvFleet, type AgvHandle, type AgvLocation, type AgvMotionInfo } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority, type MbHost, type MbParams, type MbPlan } from '../../src/core/engine/rv-movement-authority';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { PathDockRegistry } from '../../src/core/engine/rv-path-dock';
import type { PathTraveler } from '../../src/core/engine/rv-path-traveler';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { createBatteryModel, type BatteryRates } from '../../src/core/fleet/core/battery';
import { FleetDispatcher } from '../../src/core/fleet/core/dispatcher';
import type { RouteTable } from '../../src/core/fleet/core/route-table';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';
import { forkliftConsumption, type Job } from '../../src/core/fleet/core/strategies';
import type { HandoverBackend, LiftBackend } from '../../src/core/fleet/exec/backends';
import { FleetJobRunner, type FleetSite, type JobLeg } from '../../src/core/fleet/exec/job-runner';
import { WaitWatch, type WaitCause, type WaitProblem, type WaitResolver } from '../../src/core/fleet/exec/wait-watch';
import { clearShared, makeAgvRoot } from '../helpers/agv-harness';

const IDS = ['Stapler_3', 'Stapler_2', 'Stapler_1']; // deliberately not id order
const RATES: BatteryRates = {
  drivePerMin: 0.01, liftPerM: 0.01, idlePerMin: 0.001, chargePerMin: 5,
  threshold: 30, target: 80, reserveToCharger: 1, chargerWaitReserveSec: 0,
};
const FORK = { travelHeightMm: 150, handlingDeltaMm: 30, liftSpeedLoadedMmS: 150, liftSpeedEmptyMmS: 300 };
const BODY: MbParams = {
  vmax: 1, a: 0.5, b: 0.5, aLat: 0.5, front: 0.5, rear: 0.5, width: 0.6,
  gap: 0.2, dockSpeed: 0.2, dockDist: 0.3, scanner: null,
};

interface VehicleProbe { id: string; at: string; job: Job | null; leg: JobLeg }
interface RunnerProbe { vehicles: Map<string, VehicleProbe>; beginExit(v: VehicleProbe): void }
const cleanups: Array<() => void> = [];

beforeEach(() => clearShared());
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  clearShared();
});

function world(kind: 'des' | 'continuous') {
  const clock = new ContinuousSimClock();
  const fleet = new AgvFleet();
  const zones = getDefaultZoneRegistry();
  const network = getDefaultPathNetwork();
  for (const [id, zone] of [['Lane', undefined], ['S_A1', 'Stich_A1'], ['Pending', 'Merge']] as const) {
    network.register(parsePathExtras({ type: 'Path', version: 1,
      segments: [{ kind: 'line', from: [0, 0, 0], to: [0, 0, 100] }], zone,
    }, id)!);
    if (zone) zones.define(zone, 1);
  }
  network.resolveGraph();
  const authority = getDefaultMovementAuthority(kind);
  const host: MbHost = {
    now: () => clock.now(), nextEventTime: () => clock.now(),
    // Keep the seeded diagnostic plans: kinematics are outside this fixture.
    schedule: () => -1, cancel: () => {}, legTween: () => null,
    serviceStopAt: () => false, canMove: () => true,
  };
  const handles = new Map(IDS.map(id => {
    const h = {
      id, phase: 'driving' as const, speed: 0, s: 0,
      assign: vi.fn(), clear: vi.fn(),
      motion(out: AgvMotionInfo): boolean { out.speed = h.speed; out.field = 'clear'; return true; },
      locate(out: AgvLocation): boolean { out.pathId = 'Lane'; out.s = h.s; out.dir = 1; return true; },
    };
    fleet.register(h as unknown as AgvHandle);
    authority.register(id, { id, path: network.get('Lane')!, s: 0, v: 0, blocked: false, atEnd: false } as unknown as PathTraveler, host, { ...BODY });
    return [id, h] as const;
  }));
  const nodes = new Map(IDS.map(id => [id, makeAgvRoot(id, { PathId: 'Lane' })]));
  const handover: HandoverBackend = {
    onPalletReady: null, onInputFreed: null,
    produce: () => false, headFree: () => true, setPickHandler: () => {}, awaitPick: () => {},
    inputFree: () => true, putOnHead: () => false, setInputRun: () => {}, store: () => false,
    retrieve: () => null, carried: () => null, onSlot: () => null, reconcile: () => 0,
    vehicleNode: id => nodes.get(id) ?? null, releaseVisuals: () => {}, resetState: () => {}, dispose: () => {},
  };
  const lift: LiftBackend = {
    position: () => FORK.travelHeightMm, move: vi.fn(), cancel: () => {}, snap: () => {}, setDoneHandler: () => {},
  };
  const site: FleetSite = {
    stations: [{ id: 'A1', pathId: 'S_A1', role: 'pick', approachM: 4, handlingHeightMm: 500 }],
    turnOf: new Map([['S_A1', 'Lane']]), nextOf: new Map(), zoneOf: () => 'Stich_A1',
    waitPointPathId: 'Wait', stichLengthM: 4,
    vehicles: IDS.map(id => ({ id, startPathId: 'Lane' })),
  };
  const dispatcher = new FleetDispatcher({ stations: site.stations, battery: createBatteryModel(RATES),
    consumption: forkliftConsumption(() => ({ ...FORK, travelSpeedMmS: 1000, reverseSpeedMmS: 300,
      travelSlack: 1, idleReserveSec: 0 })),
  });
  const reports: WaitProblem[] = [];
  const runner = new FleetJobRunner({ kind, clock, handover, lift }, site, dispatcher, {
    fork: FORK, battery: RATES, startSoc: [100, 100, 100],
    production: { intervalSec: 1e9, phaseSec: [1e9] },
    pauses: { everySec: 1e9, durationSec: 0, offsetSec: [] },
  }, {
    fleet, zones, docks: new PathDockRegistry(), routes: { networkM: () => 10 } as unknown as RouteTable,
    waitLimits: { exit: 60, standstill: 120 }, waitProblems: { report: p => reports.push(p), clear: () => {} },
  });
  cleanups.push(() => { runner.dispose(); clock.dispose(); });
  const probe = runner as unknown as RunnerProbe;
  const watch = runner.waitWatch;
  const plan = (id: string) => authority.planOf(id)! as MbPlan;
  const leader = (id: string, by: string): void => {
    plan(id).stopCause = 'leader'; plan(id).stopLeaderId = by;
  };
  const waitForZone = (id: string, zone: string, since = clock.now()): void => {
    plan(id).stopCause = 'zone';
    (authority as unknown as { addWaiter(z: string, id: string, t: number): void }).addWaiter(zone, id, since);
  };
  const begin = (waitKind: 'exit' | 'standstill', id = 'Stapler_2'): void => {
    const v = probe.vehicles.get(id)!;
    if (waitKind === 'exit') {
      v.at = 'S_A1';
      expect(zones.claim('Stich_A1', id)).toBe(true);
      probe.beginExit(v);
    } else {
      v.job = { kind: 'park', vehicle: id }; v.leg = 'toWait';
      runner.frame(); // production trackStandstill + begin path
    }
    expect(watch.isWaiting(id, waitKind)).toBe(true);
  };
  const advance = (to: number): void => { clock.advanceTo(to); runner.frame(); };
  const detail = (waitKind: 'exit' | 'standstill'): WaitCause => {
    // Read the installed resolver without invoking a timeout or mutating validity.
    const resolver = (watch as unknown as { resolver: WaitResolver }).resolver;
    return resolver.detail('Stapler_2', waitKind, waitKind === 'exit' ? { zone: 'Stich_A1' } : {}) as WaitCause;
  };
  const executionState = () => {
    const { vehicles, ...state } = runner.exportState();
    // Status is derived output (including projected SOC), not execution state.
    return { ...state, vehicles: vehicles.map(({ status: _status, ...v }) => v) };
  };
  return { runner, watch, authority, zones, clock, reports, handles, lift, dispatcher,
    plan, leader, waitForZone, begin, advance, detail, executionState };
}

describe.each(['des', 'continuous'] as const)('%s: waits behind a broken vehicle', kernel => {
  it.each(['exit', 'standstill'] as const)('pauses %s begun during the breakdown, names its leader and ends after recovery', kind => {
    const w = world(kernel);
    w.leader('Stapler_2', 'Stapler_1');
    w.authority.freeze('Stapler_1');
    w.begin(kind);
    expect(w.authority.isFrozen('Stapler_2')).toBe(false);
    expect(w.detail(kind).heldBy).toBe('Stapler_1 (breakdown, repair pending)');
    expect(w.watch.edges(0)).toContainEqual(expect.objectContaining({ waiterId: 'Stapler_2', ownerIds: [] }));
    const runnerState = w.executionState(), jobs = w.dispatcher.exportState();
    w.advance(300); // exceeds BOTH normal deadlines; catches the pre-fix timeout
    expect(w.reports).toEqual([]);
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(0);
    expect(w.executionState()).toEqual(runnerState);
    expect(w.dispatcher.exportState()).toEqual(jobs);
    for (const h of w.handles.values()) { expect(h.assign).not.toHaveBeenCalled(); expect(h.clear).not.toHaveBeenCalled(); }
    expect(w.lift.move).not.toHaveBeenCalled();
    w.authority.resume('Stapler_1');
    if (kind === 'exit') {
      expect(w.zones.isHolder('Stich_A1', 'Stapler_2')).toBe(true);
      w.zones.release('Stich_A1', 'Stapler_2');
    } else w.handles.get('Stapler_2')!.speed = 1;
    w.advance(301);
    expect(w.watch.isWaiting('Stapler_2', kind)).toBe(false);
    expect(w.reports).toEqual([]);
  });

  it.each(['exit', 'standstill'] as const)('restarts the full %s budget after a foreign blocker recovers and still reports a real hang', kind => {
    const w = world(kernel), limit = kind === 'exit' ? 60 : 120;
    w.leader('Stapler_2', 'Stapler_3'); w.leader('Stapler_3', 'Stapler_1');
    w.begin(kind);
    w.advance(20);
    w.authority.freeze('Stapler_1'); // affects active waits of OTHER vehicles, transitively
    w.advance(320);
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(20);
    expect(w.detail(kind).heldBy).toBe('Stapler_1 (breakdown, repair pending)');
    expect(w.reports).toEqual([]);
    w.authority.resume('Stapler_1');
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(0);
    w.advance(320 + limit - 1);
    expect(w.reports).toEqual([]);
    w.advance(320 + limit);
    expect(w.reports.map(p => p.id)).toEqual([`fleet-wait-timeout:Stapler_2:${kind}`]);
    expect(w.reports[0].detail).not.toContain('Held by: Stapler_2');
  });

  it.each(['exit', 'standstill'] as const)('checks a new blocker at the %s deadline without querying plans each frame', kind => {
    const w = world(kernel), limit = kind === 'exit' ? 60 : 120;
    w.authority.freeze('Stapler_1');
    w.begin(kind); // no blocker yet; own plan is hold
    w.leader('Stapler_2', 'Stapler_1'); // appears after the last freeze notification
    const read = vi.spyOn(w.authority, 'planOf');
    w.advance(10); w.advance(20);
    expect(read).not.toHaveBeenCalled();
    w.advance(limit);
    expect(read).toHaveBeenCalledWith('Stapler_2');
    expect(w.reports).toEqual([]);
    w.advance(300);
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(limit);
    w.authority.resume('Stapler_1');
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(0);
    w.advance(308); // the real PalletYard follower needs about 8 s to leave after repair
    expect(w.reports).toEqual([]);
    w.advance(300 + limit - 1);
    expect(w.reports).toEqual([]);
    w.advance(300 + limit); // a real hang still times out a full limit after recovery
    expect(w.reports.map(p => p.id)).toEqual([`fleet-wait-timeout:Stapler_2:${kind}`]);
    expect(w.reports[0].detail).toContain('active since sim time 300 s');
  });

  it.each(['exit', 'standstill'] as const)('grants a full %s budget after a deadline blocker pause, own freeze, blocker repair and own repair', kind => {
    const w = world(kernel), limit = kind === 'exit' ? 60 : 120;
    w.advance(7263);
    w.waitForZone('Stapler_1', 'Merge');
    w.plan('Stapler_1').stopCause = 'hold';
    w.authority.freeze('Stapler_1');
    w.advance(7270);
    w.begin(kind);
    w.waitForZone('Stapler_2', 'Merge'); // blocker appears after begin, detected at the deadline
    w.advance(7270 + limit);
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(limit);
    expect(w.detail(kind).heldBy).toBe('Stapler_1 (breakdown, repair pending)');
    expect(w.reports).toEqual([]);
    w.advance(8484);
    w.authority.freeze('Stapler_2');
    w.advance(8800);
    w.authority.resume('Stapler_1');
    expect(w.authority.isFrozen('Stapler_2')).toBe(true);
    w.advance(9200);
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(limit);
    expect(w.reports).toEqual([]);
    w.authority.resume('Stapler_2');
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(0);
    w.advance(9202.9); // the observed vehicle only starts moving after this delay
    expect(w.reports).toEqual([]);
    w.advance(9200 + limit - 1);
    expect(w.reports).toEqual([]);
    w.advance(9200 + limit); // still diagnose a real hang after the full new limit
    expect(w.reports.map(p => p.id)).toEqual([`fleet-wait-timeout:Stapler_2:${kind}`]);
  });

  it('follows a blocking companion zone through its holder to a frozen leader', () => {
    const w = world(kernel);
    w.waitForZone('Stapler_2', 'Companion');
    expect(w.zones.claim('Companion', 'Stapler_3')).toBe(true);
    w.leader('Stapler_3', 'Stapler_1');
    w.authority.freeze('Stapler_1');
    w.begin('exit');
    expect(w.detail('exit').heldBy).toBe('Stapler_1 (breakdown, repair pending)');
    expect(w.detail('exit').ownerIds).toEqual([]); // keep diagnostic wait edges unchanged
    w.advance(300);
    expect(w.reports).toEqual([]);
    expect(w.zones.holdersOf('Companion')).toEqual(['Stapler_3']);
  });

  it.each(['exit', 'standstill'] as const)('pauses %s behind a frozen hold waiter on a free zone and grants a full budget after repair', kind => {
    const w = world(kernel), limit = kind === 'exit' ? 60 : 120;
    w.waitForZone('Stapler_1', 'Merge', 205.7);
    w.plan('Stapler_1').stopCause = 'hold';
    w.authority.freeze('Stapler_1');
    w.advance(222.804);
    w.waitForZone('Stapler_2', 'Merge');
    expect(w.zones.holdersOf('Merge')).toEqual([]);
    expect(w.authority.planOf('Stapler_1')!.stopCause).toBe('hold');
    expect(w.authority.zoneWaitEdges({ holders: 'all' })).toEqual([]); // the frozen hold waiter is not a zone node
    w.begin(kind);
    expect(w.detail(kind).heldBy).toBe('Stapler_1 (breakdown, repair pending)');
    const authorityState = w.authority.exportState(), executionState = w.executionState();
    w.advance(600);
    expect(w.reports).toEqual([]);
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(0);
    expect(w.authority.exportState()).toEqual(authorityState);
    expect(w.executionState()).toEqual(executionState);
    w.authority.resume('Stapler_1'); // still queued, but healthy: a real hang must time out
    w.advance(600 + limit - 1);
    expect(w.reports).toEqual([]);
    w.advance(600 + limit);
    expect(w.reports.map(p => p.id)).toEqual([`fleet-wait-timeout:Stapler_2:${kind}`]);
  });

  it.each(['freeze', 'deadline'] as const)('detects a frozen FIFO predecessor at the %s hook without querying it each frame', hook => {
    const w = world(kernel);
    w.waitForZone('Stapler_1', 'Merge', 0);
    w.plan('Stapler_1').stopCause = 'hold';
    w.advance(10);
    if (hook === 'freeze') w.waitForZone('Stapler_2', 'Merge');
    else w.authority.freeze('Stapler_1');
    w.begin('exit');
    w.advance(20);
    if (hook === 'freeze') w.authority.freeze('Stapler_1');
    else w.waitForZone('Stapler_2', 'Merge'); // dependency appears after begin / freeze
    const read = vi.spyOn(w.authority, 'waitersAhead');
    w.advance(30); w.advance(40);
    expect(read).not.toHaveBeenCalled();
    w.advance(70);
    if (hook === 'deadline') expect(read).toHaveBeenCalledWith('Merge', 'Stapler_2');
    expect(w.reports).toEqual([]);
    expect(w.detail('exit').heldBy).toBe('Stapler_1 (breakdown, repair pending)');
    w.advance(300);
    expect(w.watch.currentSec('Stapler_2', 'exit')).toBe(hook === 'freeze' ? 10 : 60);
    expect(w.reports).toEqual([]);
  });

  it('reads FIFO predecessors in wait-start / id order without changing authority state', () => {
    const w = world(kernel);
    w.waitForZone('Stapler_2', 'Merge', 20);
    w.waitForZone('Stapler_3', 'Merge', 10); // reverse insertion order at the same time
    w.waitForZone('Stapler_1', 'Merge', 10);
    w.waitForZone('Stapler_2', 'Earlier', 20);
    w.waitForZone('Stapler_3', 'Earlier', 5); // earlier time takes precedence over smaller id
    w.waitForZone('Stapler_1', 'Earlier', 10);
    w.waitForZone('Stapler_2', 'Tied', 20);
    w.waitForZone('Stapler_3', 'Tied', 20);
    w.waitForZone('Stapler_1', 'Tied', 20);
    w.waitForZone('Stapler_2', 'Passive', NaN);
    w.waitForZone('Stapler_1', 'Passive', 10);
    w.waitForZone('Stapler_2', 'Later', 20);
    w.waitForZone('Stapler_1', 'Later', NaN);
    w.waitForZone('Stapler_3', 'Later', 30);
    const before = w.authority.exportState();
    const ahead = w.authority.waitersAhead('Merge', 'Stapler_2');
    expect(ahead).toEqual(['Stapler_1', 'Stapler_3']);
    ahead.length = 0; // returned arrays cannot edit the queue
    expect(w.authority.waitersAhead('Merge', 'Stapler_2')).toEqual(['Stapler_1', 'Stapler_3']);
    expect(w.authority.waitersAhead('Earlier', 'Stapler_2')).toEqual(['Stapler_3', 'Stapler_1']);
    expect(w.authority.waitersAhead('Tied', 'Stapler_2')).toEqual(['Stapler_1']);
    expect(w.authority.waitersAhead('Passive', 'Stapler_2')).toEqual([]);
    expect(w.authority.waitersAhead('Later', 'Stapler_2')).toEqual([]);
    expect(w.authority.waitersAhead('Unknown', 'Stapler_2')).toEqual([]);
    expect(w.authority.waitersAhead('Merge', 'Unknown')).toEqual([]);
    expect(w.authority.exportState()).toEqual(before);
  });

  it.each([
    { blocker: 'Stapler_1', blockerSince: 20, waiterSince: 10 }, // later, even with a smaller id
    { blocker: 'Stapler_3', blockerSince: 10, waiterSince: 10 }, // same time, larger id
    { blocker: 'Stapler_1', blockerSince: NaN, waiterSince: 10 }, // passive predecessor
    { blocker: 'Stapler_1', blockerSince: 0, waiterSince: NaN }, // passive waiter has no FIFO edge
  ])('does not pause for a frozen waiter outside FIFO precedence: %j', ({ blocker, blockerSince, waiterSince }) => {
    const w = world(kernel);
    w.waitForZone(blocker, 'Merge', blockerSince);
    w.plan(blocker).stopCause = 'hold';
    w.waitForZone('Stapler_2', 'Merge', waiterSince);
    w.authority.freeze(blocker);
    w.begin('exit'); w.advance(60);
    expect(w.reports.map(p => p.id)).toEqual(['fleet-wait-timeout:Stapler_2:exit']);
    expect(w.reports[0].detail).not.toContain('(breakdown, repair pending)');
  });

  it.each(['exit', 'standstill'] as const)('pauses %s behind a field stop with an explicit frozen vehicle leader', kind => {
    const w = world(kernel);
    w.leader('Stapler_2', 'Stapler_1');
    w.plan('Stapler_2').stopCause = 'field';
    w.authority.freeze('Stapler_1');
    w.begin(kind);
    expect(w.detail(kind).heldBy).toBe('Stapler_1 (breakdown, repair pending)');
    w.advance(300);
    expect(w.reports).toEqual([]);
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(0);
  });

  it('terminates a mixed FIFO / leader cycle despite an unrelated breakdown', () => {
    const w = world(kernel);
    w.waitForZone('Stapler_2', 'Merge', 10);
    w.waitForZone('Stapler_3', 'Merge', 0);
    w.leader('Stapler_3', 'Stapler_2');
    w.authority.freeze('Stapler_1'); // outside the cycle
    w.begin('exit'); w.advance(60);
    expect(w.reports.map(p => p.id)).toEqual(['fleet-wait-timeout:Stapler_2:exit']);
  });

  it('follows FIFO predecessors for zonePending before its own waiter entry exists', () => {
    const w = world(kernel), p = w.plan('Stapler_2');
    w.waitForZone('Stapler_1', 'Merge', 0);
    w.plan('Stapler_1').stopCause = 'hold';
    w.authority.freeze('Stapler_1');
    w.advance(20);
    p.stopCause = 'zonePending';
    p.route.push({ path: getDefaultPathNetwork().get('Pending')!, x0: 100 });
    expect(w.authority.describeZoneHolds('Stapler_2')!.waits).toEqual([]);
    expect(w.zones.holdersOf('Merge')).toEqual([]);
    w.begin('standstill');
    expect(w.detail('standstill').heldBy).toBe('Stapler_1 (breakdown, repair pending)');
    w.advance(300);
    expect(w.reports).toEqual([]);
  });

  it('follows zonePending before a zone waiter has been registered', () => {
    const w = world(kernel), p = w.plan('Stapler_2');
    p.stopCause = 'zonePending';
    p.route.push({ path: getDefaultPathNetwork().get('Pending')!, x0: 100 });
    expect(w.authority.describeZoneHolds('Stapler_2')!.waits).toEqual([]);
    expect(w.zones.claim('Merge', 'Stapler_1')).toBe(true);
    w.authority.freeze('Stapler_1');
    w.begin('standstill');
    expect(w.detail('standstill').heldBy).toBe('Stapler_1 (breakdown, repair pending)');
    w.advance(300);
    expect(w.reports).toEqual([]);
  });

  it('does not follow a later frozen zone holder beyond the pending zone', () => {
    const w = world(kernel), p = w.plan('Stapler_2');
    p.stopCause = 'zonePending';
    p.route.push({ path: getDefaultPathNetwork().get('Pending')!, x0: 100 },
      { path: getDefaultPathNetwork().get('S_A1')!, x0: 200 });
    w.zones.claim('Merge', 'Stapler_3'); // actual pending zone has a healthy holder
    w.zones.claim('Stich_A1', 'Stapler_1'); // later zone is irrelevant
    w.authority.freeze('Stapler_1');
    w.begin('standstill'); w.advance(120);
    expect(w.reports.map(p => p.id)).toEqual(['fleet-wait-timeout:Stapler_2:standstill']);
  });

  it.each(['leader', 'zone'] as const)('a healthy %s blocker still times out', cause => {
    const w = world(kernel);
    if (cause === 'leader') w.leader('Stapler_2', 'Stapler_1');
    else { w.waitForZone('Stapler_2', 'Merge'); w.zones.claim('Merge', 'Stapler_1'); }
    w.begin('exit');
    w.advance(60);
    expect(w.reports.map(p => p.id)).toEqual(['fleet-wait-timeout:Stapler_2:exit']);
    expect(w.reports[0].detail).not.toContain('Held by: Stapler_2');
  });

  it.each(['field', 'horizon', 'hold', 'service', 'deadend'] as const)('does not infer a frozen blocker from %s without a vehicle dependency', cause => {
    const w = world(kernel);
    w.leader('Stapler_2', 'Stapler_1'); // stale leader id must not be trusted for other causes
    w.plan('Stapler_2').stopCause = cause;
    if (cause === 'field') w.plan('Stapler_2').stopLeaderId = null; // a scanner obstacle without a vehicle
    w.authority.freeze('Stapler_1');
    w.begin('standstill');
    w.advance(120);
    expect(w.reports.map(p => p.id)).toEqual(['fleet-wait-timeout:Stapler_2:standstill']);
  });

  it.each(['fork', 'target', 'charge'])('keeps the %s deadline running during a breakdown', kind => {
    const w = world(kernel);
    w.watch.begin('Stapler_2', kind, 10);
    w.authority.freeze('Stapler_2');
    w.advance(10);
    expect(w.reports.map(p => p.id)).toEqual([`fleet-wait-timeout:Stapler_2:${kind}`]);
  });

  it.each(['exit', 'standstill'] as const)('pauses %s when the waiting vehicle itself fails', kind => {
    const w = world(kernel);
    w.begin(kind); w.advance(10);
    w.authority.freeze('Stapler_2');
    w.advance(300);
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(10);
    expect(w.reports).toEqual([]);
    expect(w.detail(kind).heldBy).not.toContain('Stapler_2');
    w.authority.resume('Stapler_2');
    w.advance(301);
    expect(w.watch.currentSec('Stapler_2', kind)).toBe(11);
    const limit = kind === 'exit' ? 60 : 120;
    w.advance(300 + limit - 11);
    expect(w.reports).toEqual([]);
    w.advance(300 + limit - 10);
    expect(w.reports.map(p => p.id)).toEqual([`fleet-wait-timeout:Stapler_2:${kind}`]);
  });

  it('terminates a leader cycle and still reports it despite an unrelated breakdown', () => {
    const w = world(kernel);
    w.leader('Stapler_2', 'Stapler_3'); w.leader('Stapler_3', 'Stapler_2');
    w.authority.freeze('Stapler_1');
    w.begin('standstill'); w.advance(120);
    expect(w.reports.map(p => p.id)).toEqual(['fleet-wait-timeout:Stapler_2:standstill']);
  });

  it('explores all zone holders in id order, excluding self and a cyclic branch', () => {
    const w = world(kernel);
    w.zones.define('Shared', 3);
    for (const id of IDS) expect(w.zones.claim('Shared', id)).toBe(true);
    w.waitForZone('Stapler_2', 'Shared');
    w.leader('Stapler_1', 'Stapler_2');
    w.authority.freeze('Stapler_3');
    w.begin('standstill'); w.advance(300);
    expect(w.detail('standstill').heldBy).toBe('Stapler_3 (breakdown, repair pending)');
    expect(w.reports).toEqual([]);
  });

  it('a zone cycle that holds its own resources still times out', () => {
    const w = world(kernel);
    w.waitForZone('Stapler_2', 'Merge'); w.waitForZone('Stapler_3', 'Stich_A1');
    w.zones.claim('Merge', 'Stapler_3');
    w.authority.freeze('Stapler_1'); // outside the cycle
    w.begin('exit'); // Stapler_2 holds Stich_A1
    w.advance(60);
    expect(w.reports.map(p => p.id)).toEqual(['fleet-wait-timeout:Stapler_2:exit']);
  });

  it('chooses the smallest id when several zone holders are frozen', () => {
    const w = world(kernel);
    w.zones.define('Shared', 2);
    w.zones.claim('Shared', 'Stapler_3'); w.zones.claim('Shared', 'Stapler_1');
    w.waitForZone('Stapler_2', 'Shared');
    w.authority.freeze('Stapler_3'); w.authority.freeze('Stapler_1');
    w.begin('standstill');
    expect(w.detail('standstill').heldBy).toBe('Stapler_1 (breakdown, repair pending)');
    w.authority.resume('Stapler_1');
    w.advance(300);
    expect(w.detail('standstill').heldBy).toBe('Stapler_3 (breakdown, repair pending)');
    expect(w.reports).toEqual([]);
  });

  it('reevaluates all active waits and schedules resumed deadlines in vehicle id order', () => {
    const w = world(kernel);
    for (const id of IDS) {
      if (id !== 'Stapler_1') w.leader(id, 'Stapler_1');
      w.watch.begin(id, 'exit', 60, { zone: 'Stich_A1' });
    }
    w.advance(10);
    w.authority.freeze('Stapler_1');
    const schedule = vi.spyOn(w.clock, 'scheduleAction');
    w.advance(300);
    expect(w.reports).toEqual([]);
    w.authority.resume('Stapler_1');
    expect(schedule.mock.calls.map(c => [c[0], c[1], c[2]])).toEqual([
      [350, 'fleet.wait.limit', expect.objectContaining({ vehicle: 'Stapler_1' })],
      [360, 'fleet.wait.limit', expect.objectContaining({ vehicle: 'Stapler_2' })],
      [360, 'fleet.wait.limit', expect.objectContaining({ vehicle: 'Stapler_3' })],
    ]);
  });
});

describe.each(['exit', 'standstill'] as const)('%s pause snapshots', kind => {
  it.each(['self', 'blocker'] as const)('remembers a foreign blocker across a change to %s and a snapshot restore without moving its pause time', reason => {
    const clock = new ContinuousSimClock();
    const watch = new WaitWatch({ clock, defaultLimitSec: 60, problems: { report: () => {}, clear: () => {} } });
    cleanups.push(() => { watch.reset(); clock.dispose(); });
    watch.begin('V', kind, 60, {}, { passive: kind === 'standstill' });
    clock.advanceTo(20);
    watch.setPaused('V', kind, true, reason === 'self' ? 'blocker' : 'self');
    clock.advanceTo(100);
    const schedule = vi.spyOn(clock, 'scheduleAction');
    watch.setPaused('V', kind, true, reason);
    const state = watch.exportState();
    expect(state.entries[0]).toMatchObject({ pausedAt: 20, pauseReason: 'blocker' });
    expect(watch.validateState(state)).toEqual([]);
    watch.swapState(watch.prepareState(state));
    expect(schedule).not.toHaveBeenCalled();
    clock.advanceTo(300);
    watch.setPaused('V', kind, false);
    expect(watch.currentSec('V', kind)).toBe(0);
  });

  it.each(['self', 'blocker', 'legacy'] as const)('restores %s pause semantics without scheduling an event during restore', reason => {
    const clock = new ContinuousSimClock(), reports: WaitProblem[] = [];
    const watch = new WaitWatch({ clock, defaultLimitSec: 60, problems: { report: p => reports.push(p), clear: () => {} } });
    cleanups.push(() => { watch.reset(); clock.dispose(); });
    watch.begin('V', kind, 60, {}, { passive: kind === 'standstill' });
    clock.advanceTo(20);
    watch.setPaused('V', kind, true, reason === 'blocker' ? 'blocker' : 'self');
    clock.advanceTo(300);
    const state = watch.exportState();
    expect(state.entries[0].pauseReason).toBe(reason === 'blocker' ? 'blocker' : 'self');
    if (reason === 'legacy') delete state.entries[0].pauseReason;
    expect(watch.validateState(state)).toEqual([]);
    const schedule = vi.spyOn(clock, 'scheduleAction');
    watch.swapState(watch.prepareState(state));
    expect(schedule).not.toHaveBeenCalled();
    watch.setPaused('V', kind, false);
    const elapsed = reason === 'blocker' ? 0 : 20;
    expect(watch.currentSec('V', kind)).toBe(elapsed);
    const deadline = 300 + 60 - elapsed;
    if (kind === 'exit') expect(schedule.mock.calls).toEqual([
      [deadline, 'fleet.wait.limit', expect.objectContaining({ vehicle: 'V', kind })],
    ]);
    else expect(schedule).not.toHaveBeenCalled();
    clock.advanceTo(deadline - 1); watch.poll();
    expect(reports).toEqual([]);
    clock.advanceTo(deadline); watch.poll();
    expect(reports.map(p => p.id)).toEqual([`fleet-wait-timeout:V:${kind}`]);
  });

  it('rejects an invalid pause reason and still accepts snapshots without pause fields', () => {
    const clock = new ContinuousSimClock();
    const watch = new WaitWatch({ clock, defaultLimitSec: 60, problems: { report: () => {}, clear: () => {} } });
    cleanups.push(() => { watch.reset(); clock.dispose(); });
    watch.begin('V', kind, 60, {}, { passive: kind === 'standstill' });
    const state = watch.exportState();
    const legacy = structuredClone(state) as unknown as { entries: Array<Record<string, unknown>> };
    delete legacy.entries[0].pausedAt;
    delete legacy.entries[0].pauseReason;
    expect(watch.validateState(legacy)).toEqual([]);
    watch.swapState(watch.prepareState(legacy));
    expect(watch.currentSec('V', kind)).toBe(0);
    for (const pauseReason of ['unknown', null, 42]) {
      const invalid = { ...state, entries: state.entries.map(w => ({ ...w, pauseReason })) };
      expect(watch.validateState(invalid).length).toBeGreaterThan(0);
      expect(() => watch.prepareState(invalid)).toThrow();
    }
  });
});

it('read-only validity / edge queries cannot invoke the deadline hook', () => {
  const clock = new ContinuousSimClock(), beforeTimeout = vi.fn();
  const watch = new WaitWatch({ clock, defaultLimitSec: 1, problems: { report: () => {}, clear: () => {} } });
  cleanups.push(() => { watch.reset(); clock.dispose(); });
  watch.setResolver({ valid: () => true, detail: () => ({ waitingFor: 'motion', resourceId: 'Lane' }), beforeTimeout });
  watch.begin('V', 'standstill', 1, {}, { passive: true });
  watch.edges(10);
  expect(beforeTimeout).not.toHaveBeenCalled();
  clock.advanceTo(1); watch.poll();
  expect(beforeTimeout).toHaveBeenCalledOnce();
});

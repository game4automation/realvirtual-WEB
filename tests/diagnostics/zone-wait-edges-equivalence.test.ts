// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { enumerateCycles, probeBlockages } from '../../src/core/diagnostics/rv-blockage-probes';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import { candidate } from './blockage-test-data';
import { WaitRegistry, zoneWaitSource } from '../../src/core/diagnostics/rv-wait-registry';
import { WaitWatch } from '../../src/core/fleet/exec/wait-watch';
import { ReservationTable } from '../../src/core/fleet/core/reservations';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
/**
 * plan-686 §9.1 — semantics of the read-only wait-cycle query
 * `MovementAuthority.findZoneWaitCycles()`.
 *
 * Unit level: vehicles are registered on a tiny network with a stub host, and
 * the traffic state (held zones, waiter lists, stop cause, standstill) is set
 * directly — the query reads that state and nothing else. Holder edges, FIFO
 * edges over a free zone, the capacity-1 restriction, normalisation and the
 * read-only contract are checked.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultMovementAuthority, setReverseGateOpen, type MbHost, type MbParams, type MovementAuthority } from '../../src/core/engine/rv-movement-authority';
import { planProfile } from '../../src/core/engine/rv-motion-profile';
import type { PathTraveler } from '../../src/core/engine/rv-path-traveler';
import { clearShared } from '../helpers/agv-harness';

const T = 10;

const P: MbParams = { vmax: 1, a: 0.5, b: 0.5, aLat: 0.5, front: 0.5, rear: 0.5, width: 0.6, gap: 0.2, dockSpeed: 0.2, dockDist: 0.3, scanner: null };

function host(): MbHost {
  return {
    now: () => T, nextEventTime: () => Infinity, schedule: () => -1, cancel: () => {},
    legTween: () => null, serviceStopAt: () => false, canMove: () => true,
  };
}

interface VehicleState { held: Map<string, number>; usedLeaders: Map<string, number>; plan: { stopCause: string; stopLeaderId?: string; profile: unknown } }

/** Internal state access (test seam): the query only reads it. */
function internals(mb: MovementAuthority): { vehicles: Map<string, VehicleState>; addWaiter(z: string, id: string, t: number): void } {
  const m = mb as unknown as { vehicles: Map<string, VehicleState>; addWaiter(z: string, id: string, t: number): void };
  return { vehicles: m.vehicles, addWaiter: (z, id, t) => m.addWaiter(z, id, t) };
}

let mb: MovementAuthority;

beforeEach(() => {
  clearShared();
  const net = getDefaultPathNetwork();
  for (let i = 0; i < 6; i++) {
    net.register(parsePathExtras({ type: 'Path', version: 1, closed: false, align: [0, 1, 0], id: `P${i}`,
      segments: [{ kind: 'line', from: [10 * i, 0, 0], to: [10 * i + 5, 0, 0] }], successors: [] }, `P${i}`)!);
  }
  net.resolveGraph();
  const zones = getDefaultZoneRegistry();
  for (const z of ['Z1', 'Z2', 'Z3']) zones.define(z, 1);
  zones.define('W2', 2);
  mb = getDefaultMovementAuthority('des');
});

/** Register a vehicle standing at a zone stop (stop cause 'zone', plan ended). */
function stand(id: string, pathIdx: number, cause = 'zone'): void {
  const path = getDefaultPathNetwork().get(`P${pathIdx}`)!;
  mb.register(id, { id, path, s: 1 } as unknown as PathTraveler, host(), P);
  internals(mb).vehicles.get(id)!.plan.stopCause = cause;
}

/** Make a registered vehicle MOVE (a plan that has not ended). */
function drive(id: string): void {
  const v = internals(mb).vehicles.get(id)!;
  v.plan.profile = planProfile(T - 1, 0, 0.5, [{ x0: 0, x1: 100, c0: 1, c1: 0 }], P.a, P.b, 50, true);
  v.plan.stopCause = 'zone';
}

function hold(id: string, z: string): void {
  expect(getDefaultZoneRegistry().claim(z, id)).toBe(true);
  internals(mb).vehicles.get(id)!.held.set(z, Infinity);
}

function waitFor(id: string, z: string, since: number): void { internals(mb).addWaiter(z, id, since); }

it('pulls a follow cycle only into the checker and excludes moving/non-leader plans', () => {
  stand('A', 0, 'leader'); stand('B', 1, 'leader');
  internals(mb).vehicles.get('A')!.usedLeaders.set('B', 0);
  internals(mb).vehicles.get('B')!.usedLeaders.set('A', 0);
  internals(mb).vehicles.get('A')!.plan.stopLeaderId = 'B';
  internals(mb).vehicles.get('B')!.plan.stopLeaderId = 'A';
  // Other consulted leaders did not supply the terminal bound.
  stand('C', 2, 'hold');
  internals(mb).vehicles.get('A')!.usedLeaders.set('C', 0);
  const source = zoneWaitSource(() => mb);
  expect(mb.findZoneWaitCycles()).toEqual([]);
  expect(mb.zoneWaitEdges({ holders: 'nodes' })).toEqual([]);
  const edges = source.edges(T);
  expect(enumerateCycles(edges).cycles).toEqual([['A', 'leader:B', 'B', 'leader:A', 'A']]);
  expect(probeBlockages({ candidates: [candidate('A'), candidate('B')], edges,
    budgets: new BudgetResolver(), now: 200 })).toContainEqual(expect.objectContaining({ cls: 'deadlock' }));
  drive('A');
  internals(mb).vehicles.get('A')!.plan.stopCause = 'leader';
  expect(source.edges(T).map(e => e.waiterId)).toEqual(['B']);
  internals(mb).vehicles.get('B')!.plan.stopCause = 'hold';
  expect(source.edges(T)).toEqual([]);
  internals(mb).vehicles.get('B')!.plan.stopCause = 'field';
  expect(source.edges(T)).toContainEqual(expect.objectContaining({ waiterId: 'B', ownerIds: ['A'] }));
  internals(mb).vehicles.get('B')!.plan.stopLeaderId = undefined;
  expect(source.edges(T)).toEqual([]); // Geometric scanner obstacle has no known leader.
});

describe('plan-2038 edge equivalence / plan-686 9.1 — findZoneWaitCycles', () => {
  it('a) two standing vehicles holding each other\'s zone form one cycle', () => {
    stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'Z2');
    waitFor('A', 'Z2', 1); waitFor('B', 'Z1', 2);
    expect(checkCycles(mb)).toEqual([{ vehicles: ['A', 'B'], zones: ['Z2', 'Z1'] }]);
  });

  it('b) a waiter whose holder drives is no cycle', () => {
    stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'Z2');
    waitFor('A', 'Z2', 1); waitFor('B', 'Z1', 2);
    drive('B');
    expect(checkCycles(mb)).toEqual([]);
  });

  it('c) a passive waiter behind a driving leader is no cycle', () => {
    stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'Z2');
    waitFor('A', 'Z2', Number.NaN); // passive
    waitFor('B', 'Z1', 2);
    drive('B');
    expect(checkCycles(mb)).toEqual([]);
  });

  it('d) a FIFO-blocked free zone closes a cycle; without the back edge there is none', () => {
    stand('V', 0); stand('W', 1);
    hold('V', 'Z1');
    // Z2 is FREE: W waits for it since t = 1, V since t = 3 — V queues behind W.
    waitFor('W', 'Z2', 1); waitFor('V', 'Z2', 3);
    expect(checkCycles(mb)).toEqual([]); // W waits for nothing V holds
    waitFor('W', 'Z1', 2);                         // back edge: W waits for V's Z1
    expect(checkCycles(mb)).toEqual([{ vehicles: ['V', 'W'], zones: ['Z2', 'Z1'] }]);
  });

  it('e) a zone of capacity 2 is not analysed', () => {
    stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'W2'); hold('A', 'W2');
    waitFor('B', 'Z1', 1);
    // A "waits" for the capacity-2 zone B holds — ignored.
    waitFor('A', 'W2', 2);
    expect(checkCycles(mb)).toEqual([]);
  });

  it('f) two overlapping cycles of three vehicles: both, normalised, sorted, stable', () => {
    stand('C', 2); stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'Z2'); hold('C', 'Z3');
    waitFor('A', 'Z2', 1); waitFor('B', 'Z1', 2); // A <-> B
    waitFor('C', 'Z1', 3); waitFor('B', 'Z3', 4); // B <-> ... C waits for A's Z1, B waits for C's Z3
    waitFor('A', 'Z3', 5);                         // A -> C closes A -> C -> A
    const one = checkCycles(mb);
    const two = checkCycles(mb);
    expect(one).toEqual(two);
    expect(one).toEqual([
      { vehicles: ['A', 'B', 'C'], zones: ['Z2', 'Z3', 'Z1'] },
      { vehicles: ['A', 'B'], zones: ['Z2', 'Z1'] },
      { vehicles: ['A', 'C'], zones: ['Z3', 'Z1'] },
    ]);
    for (const c of one) expect(c.vehicles[0]).toBe([...c.vehicles].sort()[0]);
  });

  it('g) the query changes nothing: claims, waiters and statistics before == after', () => {
    stand('A', 0); stand('B', 1);
    hold('A', 'Z1'); hold('B', 'Z2');
    waitFor('A', 'Z2', 1); waitFor('B', 'Z1', 2);
    const snap = (): string => JSON.stringify({
      a: mb.describeZoneHolds('A'), b: mb.describeZoneHolds('B'), stats: mb.stats,
      reg: ['Z1', 'Z2'].map((z) => getDefaultZoneRegistry().holderCount(z)),
    });
    const before = snap();
    checkCycles(mb);
    checkCycles(mb);
    expect(snap()).toBe(before);
    expect(mb.describeZoneHolds('A')).toEqual({ held: [{ zone: 'Z1', exitOdo: Infinity }], waits: [{ zone: 'Z2', since: 1, passive: false }] });
  });
});

/** Reconstruct cycle edges independently: collapse the smallest resource per pair,
 * then enumerate only these tiny, uncapped test graphs. */
function checkCycles(authority: MovementAuthority) {
  const edges = authority.zoneWaitEdges({ holders: 'nodes' }).filter(e => e.analysed);
  const graph = new Map<string, Map<string, string>>();
  for (const e of edges) for (const owner of e.ownerIds) {
    if (!graph.has(e.waiterId)) graph.set(e.waiterId, new Map());
    const links = graph.get(e.waiterId)!;
    if (!links.has(owner) || e.resourceId < links.get(owner)!) links.set(owner, e.resourceId);
  }
  const cycles: { vehicles: string[]; zones: string[] }[] = [];
  const visit = (path: string[], zones: string[]) => {
    for (const [next, zone] of graph.get(path[path.length - 1]) ?? []) {
      if (next === path[0]) cycles.push({ vehicles: path, zones: [...zones, zone] });
      else if (next > path[0] && !path.includes(next)) visit([...path, next], [...zones, zone]);
    }
  };
  for (const id of [...graph.keys()].sort()) visit([id], []);
  const key = (c: typeof cycles[number]) => c.vehicles.join('\0') + '\u0001' + c.zones.join('\0');
  cycles.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  expect(cycles).toEqual(authority.findZoneWaitCycles());
  const enumerated = enumerateCycles(authority.zoneWaitEdges({ holders: 'nodes' }));
  expect(enumerated.truncated).toBe(false);
  expect(enumerated.cycles.map(chain => ({
    vehicles: chain.slice(0, -1).filter((_, i) => i % 2 === 0),
    zones: chain.filter((_, i) => i % 2 === 1),
  }))).toEqual(cycles);
  return cycles;
}

it('enumerates a fresh cycle without producing an early finding', () => {
  stand('A', 0); stand('B', 1); hold('A', 'Z1'); hold('B', 'Z2');
  waitFor('A', 'Z2', 1); waitFor('B', 'Z1', 2);
  expect(checkCycles(mb)).toHaveLength(1);
  expect(probeBlockages({ candidates: [candidate('A'), candidate('B')],
    edges: mb.zoneWaitEdges({ holders: 'nodes' }), budgets: new BudgetResolver(), now: 30 })).toEqual([]);
});

it('all holders includes a non-zone-stopped holder; nodes preserves the legacy rule', () => {
  stand('A', 0); stand('B', 1, 'destination'); hold('B', 'Z2'); waitFor('A', 'Z2', 1);
  expect(mb.zoneWaitEdges({ holders: 'nodes' })).toEqual([]);
  expect(mb.zoneWaitEdges({ holders: 'all' })).toContainEqual({ waiterId: 'A', resourceId: 'Z2',
    ownerIds: ['B'], kind: 'zone-holder', sinceSimSec: 1, analysed: true });
});
it('finds a mixed cycle through real zone, wait-watch, and reservation sources', () => {
  stand('A', 0); stand('B', 1, 'destination'); hold('B', 'Z2'); waitFor('A', 'Z2', 1);
  const reservations = new ReservationTable();
  reservations.tryReserve('station', 'Station', 'A', 0);
  const clock = new ContinuousSimClock();
  const watch = new WaitWatch({ clock, defaultLimitSec: 1000, problems: { report() {}, clear() {} } });
  const registry = new WaitRegistry();
  registry.addSource(zoneWaitSource(() => mb)); registry.addSource(reservations); registry.addSource(watch);
  try {
    watch.setResolver({ valid: () => true, detail: () => ({ waitingFor: 'Station', waiterId: 'B', resourceId: 'Station',
      ownerIds: [reservations.ownerOf('Station')!] }) });
    watch.begin('B', 'target', undefined, {});
    expect(mb.zoneWaitEdges({ holders: 'nodes' })).toEqual([]);
    const findings = probeBlockages({ candidates: [candidate('A'), candidate('B')], edges: registry.collect(200),
      budgets: new BudgetResolver(), now: 200 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ cls: 'deadlock', chain: ['A', 'Z2', 'B', 'Station', 'A'] });
  } finally { watch.reset(); clock.dispose(); }
});
it('capacity two and external holders are explicit unanalysed edges', () => {
  stand('A', 0); stand('B', 1); hold('B', 'W2'); waitFor('A', 'W2', 2);
  getDefaultZoneRegistry().claim('Z2', 'external'); waitFor('A', 'Z2', NaN);
  expect(mb.zoneWaitEdges({ holders: 'all' }).map(e => e.analysed)).toEqual([false, false]);
});

import { watchStaleReleases as watchReleases, type StaleReleaseLog as SafetyLog } from '../helpers/agv-release-safety';
import { stubLayout, makeStubWorld, delay, forkCfg, carCfg, FORK, FORK_MESH, CAR, type Mode, type StubWorld } from '../helpers/agv-stub-world';


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
  clearShared();
  setReverseGateOpen(true);
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
  r.cycles = checkCycles(mb);
  r.stale = mb.stats.staleClaimsReleased;
  r.unexpected = mb.stats.staleClaimsUnexpected;
  r.violations = mb.stats.violations;
  r.wd = mb.stats.watchdogFires;
  safety.restore();
  if (opts.disableStep4) delete (mb as unknown as { releaseStaleClaims?: unknown }).releaseStaleClaims;
  w.dispose();
  return r;
}


it.each(['continuous', 'fastforward'] as Mode[])('stale hold equivalence in %s', mode => {
  const r = scenario(mode, { disableStep4: true });
  expect(r.cycles).toEqual([{ vehicles: ['A', 'B'], zones: ['M1', 'M2'] }]);
}, 180000);

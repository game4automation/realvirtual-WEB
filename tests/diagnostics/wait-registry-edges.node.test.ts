import type { LiftDone, PickWait } from '../../src/core/fleet/exec/backends';
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Reuses the task-ownership test world without changing the existing acceptance test. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgvFleet, type AgvHandle, type AgvTask, type AgvLocation, type AgvMotionInfo } from '../../src/core/engine/rv-agv-fleet';
import type { PathDockRegistry, PathDock } from '../../src/core/engine/rv-path-dock';
import type { ZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import { createBatteryModel, type BatteryRates } from '../../src/core/fleet/core/battery';
import { FleetDispatcher } from '../../src/core/fleet/core/dispatcher';
import type { FleetStation } from '../../src/core/fleet/core/orders';
import type { RouteTable } from '../../src/core/fleet/core/route-table';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';
import { forkliftConsumption } from '../../src/core/fleet/core/strategies';
import type { HandoverBackend, LiftBackend } from '../../src/core/fleet/exec/backends';
import { FLEET_TASK_HIJACKED_CODE, FleetJobRunner, type FleetSite } from '../../src/core/fleet/exec/job-runner';
import type { OrderSignalStore } from '../../src/core/fleet/exec/order-request';

const STATIONS: FleetStation[] = [
  { id: 'A1', role: 'pick', pathId: 'S_A1', storageGroup: 'Buffer', approachM: 4, handlingHeightMm: 500 },
  { id: 'V1', role: 'drop', pathId: 'S_V1', approachM: 4, handlingHeightMm: 500 },
  { id: 'P1', role: 'storage', pathId: 'S_P1', storageGroup: 'Buffer', approachM: 4, handlingHeightMm: 100 },
  { id: 'L1', role: 'charger', pathId: 'S_L1', approachM: 4, handlingHeightMm: 0 },
];
const RATES: BatteryRates = {
  drivePerMin: 0.01, liftPerM: 0.01, idlePerMin: 0.001, chargePerMin: 5, threshold: 30, target: 80,
  reserveToCharger: 1, chargerWaitReserveSec: 0,
};
const FORK = { travelHeightMm: 150, handlingDeltaMm: 30, liftSpeedLoadedMmS: 150, liftSpeedEmptyMmS: 300 };

/** Fake hand-over: one MU per pick, kept on the fork until it is put down. */
class FakeHandover implements HandoverBackend {
  onPalletReady: ((station: string, mu: string) => void) | null = null;
  onInputFreed: ((station: string) => void) | null = null;
  readonly fork = new Map<string, string>();
  readonly waiters = new Map<string, { vehicle: string; cb: (mu: string) => void }>();
  readonly cancelled: string[] = [];
  produce(): boolean { return false; }
  headFree(): boolean { return true; }
  private pickHandler: (output: string, wait: PickWait, mu: string) => void = () => {};
  setPickHandler(h: (output: string, wait: PickWait, mu: string) => void): void { this.pickHandler = h; }
  awaitPick(station: string, vehicle: string, wait: PickWait): void {
    this.waiters.set(station, { vehicle, cb: mu => this.pickHandler(station, wait, mu) });
  }
  cancelPick(station: string, vehicle: string): void {
    if (this.waiters.get(station)?.vehicle !== vehicle) return;
    this.waiters.delete(station);
    this.cancelled.push(`${station}:${vehicle}`);
  }
  /** The MU `mu` reaches the end of `station`: a docked vehicle takes it. */
  deliver(station: string, mu: string): void {
    const w = this.waiters.get(station);
    if (!w) return;
    this.waiters.delete(station);
    this.fork.set(w.vehicle, mu);
    w.cb(mu);
  }
  inputFree(): boolean { return true; }
  putOnHead(vehicle: string): boolean { return this.fork.delete(vehicle); }
  setInputRun(): void { /* no pauses */ }
  store(vehicle: string): boolean { return this.fork.delete(vehicle); }
  retrieve(): string | null { return null; }
  carried(vehicle: string): string | null { return this.fork.get(vehicle) ?? null; }
  onSlot(): string | null { return null; }
  reconcile(): number { return 0; }
  vehicleNode(): null { return null; }
  releaseVisuals(): void { /* none */ }
  resetState(): void { this.fork.clear(); this.waiters.clear(); }
  dispose(): void { /* none */ }
}

/** Fake lift: every stroke takes 1 s of simulation time. */
class FakeLift implements LiftBackend {
  readonly pos = new Map<string, number>();
  readonly running = new Map<string, { h: ReturnType<ContinuousSimClock['schedule']> }>();
  private doneHandler: (v: string, d: LiftDone) => void = () => {};
  setDoneHandler(h: (v: string, d: LiftDone) => void): void { this.doneHandler = h; }
  cancels = 0;
  constructor(private readonly clock: ContinuousSimClock) {}
  position(v: string): number { return this.pos.get(v) ?? 0; }
  move(v: string, to: number, _speed: number, done: LiftDone): void {
    this.cancel(v);
    const h = this.clock.schedule(this.clock.now() + 1, () => { this.running.delete(v); this.pos.set(v, to); this.doneHandler(v, done); });
    this.running.set(v, { h });
  }
  cancel(v: string): void {
    const r = this.running.get(v);
    if (!r) return;
    this.running.delete(v);
    this.clock.cancel(r.h);
    this.cancels++;
  }
  snap(v: string, mm: number): void { this.cancel(v); this.pos.set(v, mm); }
}

/**
 * A fleet handle that reports its task changes like the Agv does: immediately
 * effective, or — with `hold` set (a reverse manoeuvre in progress) — first
 * `effective: false` and `effective: true` only at {@link applyHeld}.
 */
function handle(fleet: AgvFleet, id: string) {
  const h = {
    id, phase: 'cruising' as AgvHandle['phase'], task: null as AgvTask | null,
    speed: 0, path: 'Lane', s: 0,
    motion(out: AgvMotionInfo): boolean { out.speed = h.speed; out.field = 'clear'; return true; },
    locate(out: AgvLocation): boolean { out.pathId = h.path; out.s = h.s; return true; },
    hold: false, held: undefined as AgvTask | null | undefined,
    request(t: AgvTask | null): void {
      if (h.hold) { h.held = t; fleet.notifyTaskChanged(id, { requested: t, effective: false }); return; }
      h.task = t;
      fleet.notifyTaskChanged(id, { requested: t, effective: true });
    },
    assign(t: AgvTask): void { h.request(t); },
    clear(): void { h.request(null); },
    /** The manoeuvre ends: the last held request becomes effective. */
    applyHeld(): void {
      h.hold = false;
      if (h.held === undefined) return;
      const t = h.held;
      h.held = undefined;
      h.task = t;
      fleet.notifyTaskChanged(id, { requested: t, effective: true });
    },
  };
  return h;
}

function world(opts: { registered?: boolean; orderSignals?: OrderSignalStore } = {}) {
  const clock = new ContinuousSimClock();
  const fleet = new AgvFleet();
  const ho = new FakeHandover();
  const lift = new FakeLift(clock);
  const docks = new Map<string, PathDock>();
  const dockRegistry = { register: (p: string, d: PathDock) => { docks.set(p, d); return () => docks.delete(p); } } as unknown as PathDockRegistry;
  const zones = { holdersOf: () => [] as string[], onAvailabilityChanged: () => () => {}, isHolder: () => false, holderCount: () => 0 } as unknown as ZoneRegistry;
  const routes = { networkM: () => 10 } as unknown as RouteTable;
  const params = {
    fork: FORK, battery: RATES, startSoc: [100],
    production: { intervalSec: 1e9, phaseSec: [1e9] }, pauses: { everySec: 1e9, durationSec: 0, offsetSec: [1e9] },
  };
  const dispatcher = new FleetDispatcher({
    stations: STATIONS, battery: createBatteryModel(RATES),
    consumption: forkliftConsumption(() => ({ ...FORK, travelSpeedMmS: 1000, reverseSpeedMmS: 300, travelSlack: 1, idleReserveSec: 0 })),
  });
  const turnOf = new Map([...STATIONS.map((s) => [s.pathId, `T_${s.id}`] as [string, string]), ['S_W', 'T_W']]);
  const site: FleetSite = {
    stations: STATIONS, turnOf, nextOf: new Map([...turnOf.values()].map((t) => [t, `N_${t}`])),
    zoneOf: (id) => `Stich_${id}`, waitPointPathId: 'S_W', stichLengthM: 4,
    vehicles: [{ id: 'F1', startPathId: 'Lane' }],
  };
  const h = handle(fleet, 'F1');
  if (opts.registered !== false) fleet.register(h as unknown as AgvHandle);
  const rt = new FleetJobRunner({ kind: 'continuous', clock, lift, handover: ho }, site, dispatcher, params, {
    fleet, docks: dockRegistry, zones, routes, orderSignals: opts.orderSignals,
  });
  const t = { now: 0 };
  const advance = (dt = 0): void => { t.now += dt; clock.advanceTo(t.now); };
  /** The vehicle's current task ends (arrival + service end). */
  const serviceEnd = (): void => { const task = h.task!; task.onServiceEnd?.('F1', task); advance(); };
  /** The vehicle completes the stich `path` (the dock holds it until release). */
  const releases: string[] = [];
  const dock = (path: string): void => { docks.get(path)!.onVehicleArrive('F1', () => { releases.push(path); }); advance(); };
  return { zones, clock, fleet, ho, lift, docks, dispatcher, rt, h, advance, serviceEnd, dock, releases };
}

/** Bring a fresh world to "pick A1 → V1 assigned": the turn task to A1 is out. */
function assignedPick() {
  const w = world();
  w.rt.start();
  w.advance();
  w.ho.onPalletReady!('A1', 'mu1');
  w.advance();
  expect(w.rt.stats('F1')!.job).toBe('pick');
  expect(w.h.task!.destination).toBe('T_A1');
  return w;
}

/** … then into the stich A1 (reverse task out). */
function entering() {
  const w = assignedPick();
  w.serviceEnd();          // at the turn point: fork wait + pre-stroke
  w.advance(1);            // pre-stroke done → the reverse task
  expect(w.h.task).toMatchObject({ destination: 'S_A1', approach: 'reverse' });
  return w;
}

/** … then docked at A1 with the touch stroke running (hand-over phase). */
function handing() {
  const w = entering();
  w.dock('S_A1');
  expect(w.rt.stats('F1')!.leg).toBe('atFrom');
  expect(w.lift.running.has('F1')).toBe(true);
  return w;
}

/** … then carrying towards V1 (the turn task to V1 is out). */
function carrying() {
  const w = handing();
  w.advance(1);                 // touch stroke done → docked for the pick
  w.ho.deliver('A1', 'mu1');    // the MU arrives on the fork
  w.advance();                  // picked (own event)
  w.advance(1);                 // up-stroke done → the stay ends
  expect(w.releases).toEqual(['S_A1']);
  w.serviceEnd();               // out of the stich: on to V1
  expect(w.rt.stats('F1')!.leg).toBe('toTo');
  expect(w.h.task!.destination).toBe('T_V1');
  return w;
}


import { WaitRegistry } from '../../src/core/diagnostics/rv-wait-registry';
import { ReservationTable } from '../../src/core/fleet/core/reservations';
import { ProgressWiring } from '../../src/core/diagnostics/rv-progress-wiring';

afterEach(() => clearAllProblems());
it('pulls deterministically, snapshots owners, unsubscribes, and never collects per tick', () => {
  const wiring = new ProgressWiring({ clock: { now: () => 0 }, running: () => true,
    fleet: { all: () => [] }, transport: { surfaces: [], sinks: [], mus: [] } });
  const registry = wiring.waitRegistry;
  const owners = ['Z', 'A'];
  const source = { id: 'fake', edges: vi.fn(() => [{ waiterId: 'B', resourceId: 'R', ownerIds: owners,
    kind: 'test', sinceSimSec: 0, analysed: true }]) };
  const off = registry.addSource(source);
  for (let i = 0; i < 120; i++) wiring.fixedStep();
  expect(source.edges).not.toHaveBeenCalled();
  const edges = registry.collect(2);
  expect(source.edges).toHaveBeenCalledWith(2);
  expect(edges[0].ownerIds).toEqual(['A', 'Z']);
  owners.push('C'); expect(edges[0].ownerIds).toEqual(['A', 'Z']);
  const other = { id: 'aaa', edges: () => [{ ...edges[0], waiterId: 'A' }] };
  registry.addSource(other);
  const reverse = new WaitRegistry(); reverse.addSource(other); reverse.addSource(source);
  expect(registry.collect(3)).toEqual(reverse.collect(3));
  off(); off(); expect(registry.sources()).toEqual(['aaa', 'grips', 'surfaces']);
  wiring.dispose(); expect(registry.sources()).toEqual([]);
});
it('reservations expose only holders and cannot manufacture a waiter', () => {
  const table = new ReservationTable();
  table.tryReserve('station', 'S', 'A', 3);
  expect(table.tryReserve('station', 'S', 'B', 4)).toBe(false);
  expect(table.edges(5)).toEqual([{ waiterId: '', resourceId: 'S', ownerIds: ['A'],
    kind: 'reservation', sinceSimSec: 3, analysed: false, nodePath: 'S' }]);
  table.release('S', 'A'); expect(table.edges(6)).toEqual([]);
});
it('reads the real standstill and fork begin sites without scheduling or reporting', () => {
  const w = assignedPick();
  try {
    w.rt.frame();
    expect(w.rt.waitWatch.edges(0)).toContainEqual(expect.objectContaining({
      waiterId: 'F1', resourceId: 'Lane', kind: 'fleet:standstill', ownerIds: [] }));
    w.serviceEnd();
    const schedule = vi.spyOn(w.clock, 'schedule');
    expect(w.rt.waitWatch.edges(9999)).toContainEqual(expect.objectContaining({
      waiterId: 'F1', resourceId: 'fork:F1', kind: 'fleet:fork', ownerIds: [] }));
    expect(schedule).not.toHaveBeenCalled(); expect(getProblems()).toEqual([]);
  } finally { w.rt.dispose(); }
});
it('reads the real occupied-target begin site', () => {
  const w = carrying();
  try {
    w.ho.inputFree = () => false;
    w.serviceEnd(); w.advance(1); w.dock('S_V1'); w.advance(1);
    expect(w.rt.waitWatch.edges(w.clock.now())).toContainEqual(expect.objectContaining({
      waiterId: 'F1', resourceId: 'V1', kind: 'fleet:target', nodePath: 'V1', ownerIds: [] }));
  } finally { w.rt.dispose(); }
});
it('reads the real exit begin site while the departing vehicle still holds its stich', () => {
  const w = handing();
  try {
    w.zones.isHolder = () => true; w.zones.holdersOf = () => ['F1'];
    w.advance(1); w.ho.deliver('A1', 'mu1'); w.advance(); w.advance(1); w.serviceEnd();
    expect(w.rt.waitWatch.edges(w.clock.now())).toContainEqual(expect.objectContaining({
      waiterId: 'F1', resourceId: 'Stich_A1', kind: 'fleet:exit', ownerIds: [] }));
  } finally { w.rt.dispose(); }
});
it('reads the real charger-queue begin site', () => {
  const w = world();
  try {
    // Enter the dispatch boundary with a queue job; all execution below it is real.
    const runner = w.rt as unknown as { vehicles: Map<string, unknown>; startJob(v: unknown, j: unknown): void };
    runner.startJob(runner.vehicles.get('F1'), { kind: 'queue', vehicle: 'F1' });
    expect(w.rt.waitWatch.edges(w.clock.now())).toContainEqual(expect.objectContaining({
      waiterId: 'F1', resourceId: 'fleet:chargers', kind: 'fleet:charge', ownerIds: [] }));
  } finally { w.rt.dispose(); }
});

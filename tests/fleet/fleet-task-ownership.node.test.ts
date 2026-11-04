// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { LiftDone, PickWait } from '../../src/core/fleet/exec/backends';
/**
 * plan-559 §9.5 (SOL #8, S1) — task ownership of the fleet executor.
 *
 * A task change of a fleet vehicle that is not the executor's own is a hijack:
 * a pick not yet loaded goes back to the pool and frees its reservations; a
 * loaded one fails (Problems `fleet-task-hijacked`, the MU stays on the fork);
 * the running step is aborted (lift stroke, pick dock, waits). The executor's
 * own assign / clear never counts. The vehicle comes back when it is idle again
 * (foreign task) or at once (foreign clear).
 *
 * Node test on a fake world: the real `FleetJobRunner`, `FleetDispatcher`,
 * `AgvFleet` and `ContinuousSimClock`; fake hand-over, lift, docks and zones.
 */
import { expectNoWaitTimeouts } from './expect-no-wait-timeouts';
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
  const zones = { onAvailabilityChanged: () => () => {}, isHolder: () => false, holderCount: () => 0 } as unknown as ZoneRegistry;
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
  return { clock, fleet, ho, lift, docks, dispatcher, rt, h, advance, serviceEnd, dock, releases };
}

describe('external fleet orders', () => {
  function signals(initial?: boolean) {
    const listeners = new Map<string, (value: boolean | number) => void>();
    return {
      listeners,
      subscribe(name: string, cb: (value: boolean | number) => void) {
        listeners.set(name, cb);
        if (initial !== undefined) cb(initial);
        return () => { listeners.delete(name); };
      },
      emit(value: boolean) { listeners.get('A1.Order.Request')?.(value); },
    };
  }

  it('binds before start, dispatches rising edges once, deduplicates open orders and unsubscribes', () => {
    const store = signals();
    const w = world({ orderSignals: store });
    expect([...store.listeners.keys()]).toEqual(['A1.Order.Request']);
    store.emit(false);
    expect(w.dispatcher.orders.openOf('A1')).toBeNull();
    store.emit(true);
    const order = w.dispatcher.orders.openOf('A1')!;
    expect(order).toMatchObject({ id: 1, state: 'pending', mu: null });
    expect(w.h.task).toBeNull();
    w.advance();
    expect(w.h.task?.destination).toBe('T_A1');
    expect(order.state).toBe('assigned');
    store.emit(true);
    store.emit(false);
    store.emit(true);
    expect(w.rt.orders.request('A1')).toBe(false);
    expect(w.dispatcher.orders.openOf('A1')).toBe(order);
    expect(w.rt.orders.add({ source: 'A1' }).id).toBe(2);
    w.rt.dispose();
    expect(store.listeners.size).toBe(0);
  });

  it('ignores an already-true subscription snapshot until a new rising edge', () => {
    const store = signals(true);
    const w = world({ orderSignals: store });
    store.emit(true);
    expect(w.dispatcher.orders.openOf('A1')).toBeNull();
    store.emit(false);
    expect(w.dispatcher.orders.openOf('A1')).toBeNull();
    store.emit(true);
    expect(w.dispatcher.orders.openOf('A1')?.id).toBe(1);
    w.rt.dispose();
  });

  it('validates explicit sources and preserves order inputs and simulation time', () => {
    const w = world();
    w.advance(3);
    expect(() => w.rt.orders.add({ source: 'unknown' })).toThrow('unknown source station "unknown"');
    const input = { source: 'A1', mu: 'external', priority: 2, earliest: 3, latest: 20 };
    const order = w.rt.orders.add(input);
    expect(order).toMatchObject({ ...input, id: 1, times: { created: 3 }, state: 'pending' });
    w.advance();
    expect(w.h.task?.destination).toBe('T_A1');
    w.rt.dispose();
  });
});

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

const hijacks = () => getProblems().filter((p) => p.code === FLEET_TASK_HIJACKED_CODE);

describe('9.5 fleet task ownership (SOL #8, S1)', () => {
  afterEach(() => clearAllProblems());

  it('own tasks and own clear() are never a hijack', () => {
    const w = carrying();
    w.advance(1);
    expect(hijacks()).toEqual([]);
    expect(w.dispatcher.jobOf('F1')?.kind).toBe('pick');
  });

  it('foreign assign() on an assigned pick: the order goes back to the pool, reservations free, the vehicle returns when idle', () => {
    const w = assignedPick();
    const order = w.dispatcher.orders.openOf('A1')!;
    expect(order.state).toBe('assigned');
    w.h.assign({ destination: 'Elsewhere' });
    w.advance();
    expect(order.state).toBe('pending');
    expect(order.vehicle).toBeNull();
    expect(w.dispatcher.reservedBy('A1')).toBeNull();
    expect(w.dispatcher.reservedBy('V1')).toBeNull();
    expect(w.dispatcher.jobOf('F1')).toBeNull();
    expect(w.rt.stats('F1')!.leg).toBe('foreign');
    expect(hijacks()).toEqual([]);
    // Idle again (the foreign task ended): back in the fleet — the requeued order is picked up again.
    w.fleet.notifyIdle('F1');
    w.advance();
    expect(order.state).toBe('assigned');
    expect(order.vehicle).toBe('F1');
    expect(w.h.task!.destination).toBe('T_A1');
  });

  it('foreign clear() while entering the stich: the order goes back, the vehicle is dispatched again at once', () => {
    const w = entering();
    w.h.clear();
    w.advance();
    const order = w.dispatcher.orders.openOf('A1')!;
    // Back in the pool; the vehicle stands on A1's turn piece, which the route table rates
    // unreachable for A1 itself (the former PalletYard semantics) — so it gets another own job.
    expect(order.state).toBe('pending');
    expect(w.dispatcher.reservedBy('A1')).toBeNull();
    expect(w.rt.stats('F1')!.leg).not.toBe('foreign');
    expect(w.rt.stats('F1')!.job).not.toBeNull();
    expect(hijacks()).toEqual([]);
  });

  it('foreign assign() during the touch stroke: the stroke is aborted, no pick dock is ever wired', () => {
    const w = handing();
    w.h.assign({ destination: 'Elsewhere' });
    expect(w.lift.cancels).toBeGreaterThan(0);
    w.advance(5);
    expect(w.ho.waiters.size, 'the aborted stroke never docks at the output').toBe(0);
    expect(w.dispatcher.orders.openOf('A1')!.state).toBe('pending');
    expect(w.releases, 'the dock stay is not released by the executor').toEqual([]);
  });

  it('foreign assign() while docked for the pick: the waiting pick dock is withdrawn, the MU stays on the belt', () => {
    const w = handing();
    w.advance(1);                                   // touch stroke done → docked, waiting for the MU
    expect(w.ho.waiters.get('A1')?.vehicle).toBe('F1');
    w.h.assign({ destination: 'Elsewhere' });
    expect(w.ho.cancelled).toEqual(['A1:F1']);
    w.ho.deliver('A1', 'mu1');
    expect(w.ho.carried('F1'), 'the MU does not jump onto the fork').toBeNull();
    w.advance(5);
    expect(w.dispatcher.orders.openOf('A1')!.state).toBe('pending');
  });

  it('foreign assign() after the take but before its booking event: the order fails (the MU IS on the fork)', () => {
    const w = handing();
    w.advance(1);
    w.ho.deliver('A1', 'mu1');                      // physically on the fork; the booking is an own event later
    expect(w.rt.counters.picks).toBe(0);
    const order = w.dispatcher.orders.openOf('A1')!;
    w.h.assign({ destination: 'Elsewhere' });
    w.advance(5);
    expect(order.state).toBe('failed');
    expect(w.rt.counters.picks, 'booked by the hijack, not twice').toBe(1);
    expect(w.ho.carried('F1')).toBe('mu1');
    expect(hijacks()).toHaveLength(1);
  });

  it('a vehicle that keeps a load stays out of the dispatch, also when it is idle again', () => {
    const w = carrying();
    w.h.assign({ destination: 'Elsewhere' });
    w.advance();
    w.fleet.notifyIdle('F1');
    w.advance();
    expect(w.rt.stats('F1')!.leg).toBe('foreign');
    w.ho.onPalletReady!('A1', 'mu9');
    w.advance(1);
    expect(w.dispatcher.orders.openOf('A1')!.state, 'no empty-fork job for a loaded vehicle').toBe('pending');
    expect(w.dispatcher.jobOf('F1')).toBeNull();
  });

  it('foreign assign() then foreign clear(): the vehicle comes back at the clear', () => {
    const w = assignedPick();
    w.h.assign({ destination: 'Elsewhere' });
    w.advance();
    expect(w.rt.stats('F1')!.leg).toBe('foreign');
    w.h.clear();
    w.advance();
    expect(w.rt.stats('F1')!.leg).toBe('toFrom');
    expect(w.dispatcher.orders.openOf('A1')!.vehicle).toBe('F1');
  });

  it('deferred effect (reverse manoeuvre): own assign and own clear held back, then effective — no hijack', () => {
    const w = entering();
    w.h.hold = true;                     // the vehicle is in its manoeuvre
    w.h.assign({ destination: 'Elsewhere' });   // a FOREIGN request, held back …
    w.h.applyHeld();                     // … becomes effective: hijack
    w.advance();
    expect(w.rt.stats('F1')!.leg).toBe('foreign');
    clearAllProblems();
    const w2 = assignedPick();
    w2.h.hold = true;
    w2.serviceEnd();                     // own: fork wait at the turn point …
    w2.advance(1);                       // … own reverse task requested (held)
    expect(w2.h.held).toMatchObject({ destination: 'S_A1', approach: 'reverse' });
    w2.h.applyHeld();                    // own task effective after the manoeuvre
    w2.advance();
    expect(w2.rt.stats('F1')!.leg).toBe('toFrom');
    expect(hijacks()).toEqual([]);
  });

  it('the watchdog delivering a task that found no handle is the executor own task', () => {
    const w = world({ registered: false });
    w.rt.start();
    w.advance();
    expect(w.rt.hasPendingAssignments).toBe(true);
    w.fleet.register(w.h as unknown as AgvHandle);
    w.rt.kick();
    w.advance();
    expect(w.rt.hasPendingAssignments).toBe(false);
    expect(w.rt.stats('F1')!.leg).not.toBe('foreign');
  });

  it('a foreign assign() from another subscriber INSIDE the executor own notification is seen', () => {
    const w = assignedPick();
    let fired = false;
    w.fleet.onTaskChanged((id, ch) => {
      if (fired || id !== 'F1' || !ch.effective || ch.requested?.destination !== 'S_A1') return;
      fired = true;
      w.h.assign({ destination: 'Elsewhere' });   // re-entrant, during the executor's own assign()
    });
    w.serviceEnd();
    w.advance(1);                                  // the own reverse task → the other subscriber overrides it
    expect(fired).toBe(true);
    expect(w.rt.stats('F1')!.leg).toBe('foreign');
  });

  it('foreign assign() on a carrying vehicle: the order fails, Problems entry, the MU stays on the fork', () => {
    const w = carrying();
    const job = w.dispatcher.jobOf('F1')!;
    expect(job.kind === 'pick' && job.loaded).toBe(true);
    const order = job.kind === 'pick' ? job.order! : null;
    w.h.assign({ destination: 'Elsewhere' });
    w.advance();
    expect(order!.state).toBe('failed');
    expect(w.dispatcher.reservedBy('V1')).toBeNull();
    expect(w.ho.carried('F1'), 'MU balance: still on the fork').toBe('mu1');
    expect(hijacks().map((p) => p.id)).toEqual([`${FLEET_TASK_HIJACKED_CODE}:F1`]);
    // A restart clears the entry.
    w.rt.start();
    expect(hijacks()).toEqual([]);
  });

  it('foreign assign() while dropping (down-stroke at the drop): the order fails, the stroke is aborted', () => {
    const w = carrying();
    w.serviceEnd();            // at V1's turn point: pre-stroke
    w.advance(1);              // → reverse task into V1
    w.dock('S_V1');
    expect(w.rt.stats('F1')!.leg).toBe('atTo');
    w.h.assign({ destination: 'Elsewhere' });
    w.advance(5);
    expect(w.ho.carried('F1'), 'not put down').toBe('mu1');
    expect(w.rt.counters.delivered).toBe(0);
    expect(hijacks()).toHaveLength(1);
  });
});


it('status and fleet snapshots observe any reported wait without scheduling or dispatching', () => {
  const w = world();
  try {
    w.rt.waitWatch.begin('F1', 'target', 1);
    w.advance(1);
    const action = vi.spyOn(w.clock, 'scheduleAction');
    const schedule = vi.spyOn(w.clock, 'schedule'), assign = vi.spyOn(w.h, 'assign');
    const before = w.rt.fleetStats();
    expect(w.rt.statusOf('F1')).toMatchObject({ fault: true, faultCode: 3, free: false });
    expect(before).toMatchObject({ ordersPending: 0, ordersDone: 0, faults: 1,
      waits: { target: { active: 1, timeouts: 1 } } });
    w.rt.frame();
    expect(w.rt.lamps.states.get('F1')?.StackRed.on).toBe(true);
    expect(w.rt.fleetStats()).toEqual(before);
    expect(schedule).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    w.rt.waitWatch.end('F1', 'target');
    expect(w.rt.statusOf('F1')).toMatchObject({ fault: false, faultCode: 0 });
    expect(w.rt.fleetStats().waits.target.active).toBe(0);
    expect(before.waits.target.active).toBe(1);
  } finally { w.rt.dispose(); clearAllProblems(); }
});


describe('passive runner faults', () => {
  afterEach(() => clearAllProblems());
  it('reports an occupied target with order/cause and fault code 3', () => {
    const w = carrying();
    w.ho.inputFree = () => false;
    w.serviceEnd(); w.advance(1);
    w.dock('S_V1'); w.advance(1);
    expect(w.rt.waitWatch.isWaiting('F1', 'target')).toBe(true);
    w.advance(3600); w.rt.frame();
    const p = getProblems().find(p => p.id === 'fleet-wait-timeout:F1:target')!;
    expect(p.detail).toContain('Vehicle: F1\nOrder: pick A1>V1 (');
    expect(p.detail).toContain('Waiting for: drop at V1\nHeld by: input occupied');
    expect(w.rt.statusOf('F1')).toMatchObject({ fault: true, faultCode: 3 });
    w.rt.dispose();
  });
  it('reports stationary travel with fault code 5', () => {
    const w = assignedPick();
    const action = vi.spyOn(w.clock, 'scheduleAction');
    const schedule = vi.spyOn(w.clock, 'schedule');
    w.rt.frame(); w.advance(120); w.rt.frame();
    expect(schedule).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    const p = getProblems().find(p => p.id === 'fleet-wait-timeout:F1:standstill')!;
    expect(p.detail).toContain('Vehicle: F1\nOrder: pick A1>V1 (');
    expect(p.detail).toContain('Waiting for: motion on path Lane at s 0 m\nHeld by: motion field: clear');
    const status = w.rt.statusOf('F1');
    expect(status).toMatchObject({ fault: true, faultCode: 5 });
    expect(w.rt.statusOf('F1')).toBe(status);
    w.h.speed = 1; w.rt.frame();
    expect(getProblems().some(p => p.id === 'fleet-wait-timeout:F1:standstill')).toBe(false);
    expect(w.rt.statusOf('F1')).toMatchObject({ fault: false, faultCode: 0 });
    expect(() => expectNoWaitTimeouts(w.rt)).toThrow(/fleet-wait-timeout:F1:standstill/);
    expect(() => expectNoWaitTimeouts(w.rt)).toThrow(/Order: pick A1>V1/);
    w.rt.dispose();
  });
  it.each(['path', 's'] as const)('does not infer standstill across far-apart frames with changed %s', field => {
    const w = assignedPick();
    w.rt.frame();
    if (field === 'path') w.h.path = 'Next'; else w.h.s = 5;
    w.advance(600);
    w.rt.waitWatch.begin('Other', 'target', 0, undefined, { passive: true });
    w.rt.frame();
    expect(w.rt.waitWatch.stats('standstill').timeouts).toBe(0);
    expect(w.rt.statusOf('F1')?.fault).toBe(false);
    w.rt.dispose();
  });
});

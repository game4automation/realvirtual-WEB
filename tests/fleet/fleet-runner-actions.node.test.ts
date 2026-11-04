import type { LiftDone, PickWait } from '../../src/core/fleet/exec/backends';
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

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


import { WaitWatch } from '../../src/core/fleet/exec/wait-watch';

describe('runner named actions', () => {
  it('ignores stale stroke epoch and hijack data through the installed handler', () => {
    const w = world();
    w.rt.start();
    const picked = vi.spyOn(w.dispatcher, 'picked');
    w.lift.move('F1', 0, 1, { e: w.rt.epoch - 1, hj: 0,
      cont: { k: 'retrieveTouch', station: 'P1', h: 130 } });
    w.advance(1);
    w.lift.move('F1', 0, 1, { e: w.rt.epoch, hj: -1,
      cont: { k: 'retrieveTouch', station: 'P1', h: 130 } });
    w.advance(1);
    expect(picked).not.toHaveBeenCalled();
    w.rt.dispose();
  });

  it('keeps the legacy per-call dispatch and wake order, without coalescing', () => {
    const w = world();
    const trace: string[] = [];
    vi.spyOn(w.rt, 'dispatchAll').mockImplementation(() => { trace.push('dispatch'); });
    const named = vi.spyOn(w.clock, 'scheduleAction');
    w.rt.orders.request('A1');
    w.ho.onInputFreed?.('V1');
    w.rt.orders.request('A1');
    expect(named.mock.calls.map(c => [c[0], c[1], c[2]])).toEqual([
      [0, 'fleet.runner.later', { k: 'dispatch', e: 0 }],
      [0, 'fleet.runner.later', { k: 'wakeInput', e: 0, input: 'V1' }],
      [0, 'fleet.runner.later', { k: 'dispatch', e: 0 }],
    ]);
    // The unchanged defer bodies each called dispatch once, in enqueue order.
    w.advance();
    expect(trace).toEqual(['dispatch', 'dispatch', 'dispatch']);
    w.advance();
    expect(trace).toHaveLength(3);
    w.rt.dispose();
  });

  it('drops stale epoch and hijack actions and stale task callbacks', () => {
    const w = world();
    w.rt.start();
    const task = w.rt.rebuildTask('F1')!;
    const dispatch = vi.spyOn(w.rt, 'dispatchAll');
    const picked = vi.spyOn(w.dispatcher, 'picked');
    w.clock.scheduleAction(0, 'fleet.runner.later', { k: 'dispatch', e: w.rt.epoch - 1 });
    w.clock.scheduleAction(0, 'fleet.runner.later', { k: 'pickBooked', e: w.rt.epoch, v: 'F1', hj: -1, station: 'A1', h: 530 });
    w.h.assign({ destination: 'Foreign' });
    w.advance();
    dispatch.mockClear();
    task.onServiceEnd?.('F1', task);
    expect(dispatch).not.toHaveBeenCalled();
    expect(picked).not.toHaveBeenCalled();
    expect(w.h.task?.destination).toBe('Foreign');
    w.rt.dispose();
  });

  it('rebuilds an equivalent task and retains the same guards', () => {
    const w = world();
    expect(w.rt.rebuildTask('unknown')).toBeNull();
    w.rt.start();
    const original = w.h.task!;
    const rebuilt = w.rt.rebuildTask('F1')!;
    expect({ ...rebuilt, onServiceEnd: null }).toEqual({ ...original, onServiceEnd: null });
    expect(rebuilt).not.toBe(original);
    w.rt.dispose();
  });

  it('counts transient scheduleNow closures including invalid callbacks', () => {
    const w = world();
    const fn = vi.fn();
    w.rt.scheduleNow(fn, () => false, { afterModelEvents: true });
    expect(w.rt.pendingScheduleNow).toBe(1);
    w.advance();
    expect(w.rt.pendingScheduleNow).toBe(0);
    expect(fn).not.toHaveBeenCalled();
    w.rt.dispose();
  });

  it('exports descriptors and resolves live detail and validity after restore', () => {
    const clock = new ContinuousSimClock();
    const report = vi.fn();
    const watch = new WaitWatch({ clock, defaultLimitSec: 2, problems: { report, clear() {} } });
    let valid = true, holder = 'first';
    watch.setResolver({ valid: () => valid, detail: (v, k, d) => `${v}:${k}:${JSON.stringify(d)}:${holder}` });
    watch.begin('V', 'target', 2, { station: 'B' }, { passive: true });
    const state = watch.exportState();
    expect(watch.validateState(state)).toEqual([]);
    watch.swapState(watch.prepareState(state));
    holder = 'second';
    clock.advanceTo(2); watch.poll();
    expect(report.mock.calls[0][0].detail).toContain('V:target:{"station":"B"}:second');
    watch.end('V', 'target');
    watch.begin('V', 'target', 2, { station: 'B' }, { passive: true });
    valid = false;
    clock.advanceTo(4); watch.poll();
    expect(watch.isWaiting('V', 'target')).toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
    clock.dispose();
  });
});

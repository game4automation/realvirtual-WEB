// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * job-runner.ts — the FIXED forklift executor of the fleet core (plan-559
 * Phase 5, §2.4, V2). It turns the dispatcher's jobs into `AgvTask`s, docks,
 * fork strokes and hand-overs, kernel-neutrally through {@link FleetKernelAdapters}
 * (DES: `src/plugins/des/fleet/`, continuous: the binding's adapters). Moved from
 * the PalletYard runtime (plan-612) with its behaviour unchanged — the exact DES
 * parity of plan-559 D8 is measured against it.
 *
 * Status derivation, lamps and signals are core-owned, read-only frame output.
 *
 * Rules the executor keeps (plan-612 §2.4, plan-595 §2.3):
 * - Everything runs on SIMULATION time ({@link SimClock}); the only wall-clock
 *   timer is the binding's watchdog that STARTS work after a bind ({@link kick}).
 * - A vehicle never stays idle in a stich: after every stay it gets the next
 *   job, the wait point, or `clear()` (cruising the loop).
 * - The wait point holds ONE vehicle. Precedence: the head of the charger
 *   queue, then a parked vehicle; every other waiting vehicle cruises and is
 *   re-dispatched at the next event. A queued vehicle evicts a parked one.
 * - Every scheduled callback, dock release and task callback carries the run
 *   EPOCH (and a task its sequence number); a reset / rebind draws a new epoch
 *   and stale callbacks fall through (F16).
 * - FORK FIRST: the fork stands at the APPROACH height of a handling stich
 *   before the vehicle backs in — under the load for a pick / retrieve
 *   (handling − delta), above the support for a delivery (handling + delta). On
 *   the lane the fork is at travel height. The vehicle first drives forward to
 *   the stich's turn point; the pre-stroke runs THERE, at standstill, and the
 *   reverse task is handed out when it is done. That stand is the wait `fork`.
 * - STICH EXIT: after a handling stay the fork does not move until the vehicle
 *   has LEFT the stich (the movement authority releases the stich zone when the
 *   trailing body end has passed the dock piece end; the executor listens to
 *   `ZoneRegistry.onAvailabilityChanged`, no timer) — the wait `exit`.
 * - Wait states report themselves through {@link WaitWatch} (F8): `fork`,
 *   `exit`, `target` (an occupied / paused drop), `charge` (the charger queue),
 *   each with its own limit ({@link WaitLimits}).
 * - TASK OWNERSHIP (SOL #8, S1): every task carries `data.__fleetOwner`; a task
 *   change of a fleet vehicle that is not the executor's own is a hijack — the
 *   step is aborted (lift, pick dock, waits), a pick not yet loaded goes back to
 *   the pool, a loaded one fails (Problems `fleet-task-hijacked`, the MU stays on
 *   the fork). The vehicle comes back when it is idle again (`AgvFleet.onIdle`)
 *   or at once after a foreign `clear()`.
 * - HOLD CHECK (plan-634, P4-E6): the hold target of every task handed to a
 *   moving vehicle (a forward destination, a reverse task's turn point) is
 *   checked against the braking distance at hand-over; a target that can no
 *   longer be braked for is counted ({@link unbrakeableHolds}) and NOT treated as
 *   reached — the vehicle passes it and is served on its next visit (the
 *   movement authority's missed-stop lap). An own re-route would move the exact
 *   M3 parity: M3 has 3 such hand-overs, all charge jobs (plan-559 P5-E3).
 */

import { getDefaultAgvFleet, type AgvFleet, type AgvLocation, type AgvMotionInfo, type AgvSignalStatus, type AgvTask, type AgvTaskChange } from '../../engine/rv-agv-fleet';
import { getDefaultPathDockRegistry, type PathDockRegistry } from '../../engine/rv-path-dock';
import { getDefaultZoneRegistry, type ZoneRegistry } from '../../engine/rv-zone-registry';
import { getDefaultMovementAuthority } from '../../engine/rv-movement-authority';
import { getDefaultPathNetwork } from '../../engine/rv-path-network';
import { clearProblemsOfCode, reportProblem } from '../../hmi/problems-store';
import { validateShape } from '../core/source-state';
import { chargeFor, chargeTimeSec, consume, type BatteryRates } from '../core/battery';
import type { FleetDispatcher } from '../core/dispatcher';
import type { FleetStation, OrderPool, StationId, TransportOrder } from '../core/orders';
import { bindOrderRequests, type OrderSignalStore } from './order-request';
import { TaktSource, PauseSource, type PausePlan, type TaktPlan, type RngFactory } from '../core/order-sources';
import type { RngStream } from '../../rv-rng-distribution';
export type { RngFactory } from '../core/order-sources';
import { RouteTable, pathNetworkRouteGraph } from '../core/route-table';
import type { SimClock } from '../core/sim-clock';
import type { Job, VehicleView } from '../core/strategies';
import type { FleetKernelAdapters, HandoverBackend, LiftBackend, LiftDone, StrokeCont } from './backends';
import { deriveVehicleStatus, type VehicleStatusFlags, type VehicleStatusInput } from './vehicle-status';
import { FleetStatusOutput, type StatusSignalSink } from './status-output';
import type { LampMap, LampNames } from './lamp-map';
import { FLEET_WAIT_TIMEOUT_CODE, WaitWatch, type WaitProblemSink, type WaitKindStats, type WaitCause } from './wait-watch';

/** Started jobs kept in {@link FleetJobRunner.jobLog} (ring buffer). */
export const JOB_LOG_LIMIT = 256;
/** The first started jobs of a run, kept apart from the ring ({@link FleetJobRunner.firstJobs}). */
export const FIRST_JOBS_KEPT = 10;
/** Problems code: a foreign task took a vehicle while it carried an MU (id suffix = vehicle). */
export const FLEET_TASK_HIJACKED_CODE = 'fleet-task-hijacked';

/**
 * Wait limits per kind (sim s; 0 = never reported). Defaults = the scene
 * `Fleet` defaults (plan-559 Phase 3 E3): step waits 60 s, target and charger
 * waits 3600 s.
 */
export interface WaitLimits { fork: number; exit: number; target: number; charge: number; standstill: number }
export const DEFAULT_WAIT_LIMITS: Readonly<WaitLimits> = { fork: 60, exit: 60, target: 3600, charge: 3600, standstill: 120 };

/** Where the executor works: stations, stich turn points, the wait point, the vehicles. */
export interface FleetSite {
  /** The dispatcher's stations, in configuration order. */
  readonly stations: readonly FleetStation[];
  /** Stich path → its turn piece (the end of its merge piece); includes the wait point's stich. */
  readonly turnOf: ReadonlyMap<string, string>;
  /** Lane piece → its first successor (the free lane after a turn piece — the way around). */
  readonly nextOf: ReadonlyMap<string, string>;
  /** Station id → its stich zone (released by the movement authority when the body has left). */
  zoneOf(station: string): string;
  /** The wait point's stich (path id). */
  readonly waitPointPathId: string;
  /** Stich run (m) added to a route that ends at a turn piece. */
  readonly stichLengthM: number;
  /** The vehicles (fleet ids) in configuration order, with their start path. */
  readonly vehicles: readonly { readonly id: string; readonly startPathId: string }[];
}

/** Fork handling values of the vehicles (read live at every step). */
export interface ForkParams {
  readonly travelHeightMm: number;
  readonly handlingDeltaMm: number;
  readonly liftSpeedLoadedMmS: number;
  readonly liftSpeedEmptyMmS: number;
}

/** Live configuration objects (planning edits mutate them in place; the executor reads them at each decision). */
export interface JobRunnerParams {
  readonly fork: ForkParams;
  readonly battery: BatteryRates;
  /** Start SOC per vehicle in site order (%), read at every start; missing = 100. */
  readonly startSoc: readonly number[];
  /** Takt of the pick stations (in station order). */
  readonly production: TaktPlan;
  /** Pause plan of the drop stations (in station order). */
  readonly pauses: PausePlan;
}

/** The read-only part of the movement authority the hold check uses. */
export interface HoldCheckAuthority {
  locate(id: string, t: number): { path: { id: string; length: number }; s: number; v: number } | null;
}

export interface JobRunnerOptions {
  orderSignals?: OrderSignalStore | null;
  fleet?: AgvFleet;
  docks?: PathDockRegistry;
  zones?: ZoneRegistry;
  /** Wait limits per kind (default {@link DEFAULT_WAIT_LIMITS}). */
  waitLimits?: Partial<WaitLimits>;
  /** Problems sink of the waits (default: the Problems store). */
  waitProblems?: WaitProblemSink;
  /** Status output per frame (lamps / signals). */
  status?: { signals?: StatusSignalSink | null; lampMap?: Partial<LampMap>;
    lampNames?: Partial<LampNames>; fleetName?: string };
  /** `node.userData` key the SOC of a vehicle is published under (DES tooltip), null = none. */
  socUserDataKey?: string | null;
  /** Route lengths (default: a RouteTable over the shared PathNetwork). */
  routes?: RouteTable;
  /** Deceleration of the vehicles (m/s²) for the hold check; 0 = no check. */
  decelerationMS2?: number;
  /** Movement authority the hold check reads (default: the kernel's shared one). */
  authority?: HoldCheckAuthority | null;
  /**
   * Seeded RNG of a stochastic production takt (plan-2051, `TaktPlan.stochastic`);
   * null (default) = no seed, the takt stays fixed. The lifecycle owner replaces it
   * on every bind ({@link FleetJobRunner.setRng}); every {@link FleetJobRunner.start}
   * replays it from the state it was set with.
   */
  rng?: RngStream | RngFactory | null;
}

export type JobLeg =
  | 'idle'                // no job (transient)
  | 'toFrom' | 'atFrom'   // pick / retrieve: on the way to / at the source station
  | 'toTo' | 'atTo'       // pick / retrieve: on the way to / at the destination
  | 'toCharger' | 'charging'
  | 'toWait' | 'atWait'   // the wait point (park / charger queue)
  | 'cruise'              // no place at the wait point: clear() — cruising the loop
  | 'foreign';            // a foreign task drives the vehicle (SOL #8) until it is idle again

/** Counters of one run (tests, statistics, the M3 parity). */
export interface JobRunnerCounters {
  produced: number;
  blockedTakts: number;
  picks: number;
  delivered: number;
  stored: number;
  retrieved: number;
  bufferPeak: number;
  /** Times a vehicle stood at a turn point for its fork pre-stroke (every handling approach). */
  forkWaits: number;
  /** Longest of those waits (sim s) — a wait still running past the limit counts with the limit. */
  maxForkWaitSec: number;
  /** Laps because the target stich was taken at the turn point. */
  goArounds: number;
}

/** Read-only diagnostics data, detached from the executor's mutable counters. */
export type FleetStats = Readonly<Pick<JobRunnerCounters,
  'picks' | 'delivered' | 'stored' | 'retrieved' | 'produced' | 'blockedTakts'> & {
  ordersPending: number; ordersDone: number; faults: number;
  waits: Readonly<Record<string, Readonly<WaitKindStats>>>;
}>;

/** Per-vehicle progress of {@link FleetJobRunner.stats}. */
export interface VehicleJobStats {
  soc: number;
  minSoc: number;
  ordersDone: number;
  charges: number;
  leg: JobLeg;
  job: Job['kind'] | null;
  /** Drop / storage station the vehicle waits at in the dock (loaded). */
  waitingAt: string | null;
  /** Pending fork pre-stroke for the handling stich it heads for. */
  approach: { station: string; heightMm: number; ready: boolean } | null;
  /** Set while the vehicle stands at the turn point waiting for that stroke. */
  forkWait: { station: string; targetMm: number; actualMm: number; sinceSec: number } | null;
}

/** Fork pre-stroke for the handling stich a vehicle heads for (FORK FIRST). */
interface Approach {
  /** Per-vehicle approach number - stale stroke / task / timeout callbacks compare it. */
  readonly id: number;
  readonly station: string;
  readonly pathId: string;
  /** Approach height (mm). */
  readonly heightMm: number;
  readonly loaded: boolean;
  /** The pre-stroke has reached `heightMm`. */
  ready: boolean;
  /** The vehicle stands at the turn point and waits for the stroke. */
  atTurn: boolean;
  /** Sim time the wait began (-1 = not waiting). */
  waitSince: number;
  /** The wait limit was exceeded and reported. */
  reported: boolean;
}

export interface TaskDesc {
  kind: 'hop' | 'main' | 'turn' | 'around';
  destination: string;
  approach?: AgvTask['approach'];
  serviceState?: string;
  seq: number;
  e: number;
  pathId?: string;
  station?: string;
  aid?: number;
  turn?: string;
  next?: string;
}
type LaterData = { v?: string; x?: number; a?: number; input?: string; station?: string; h?: number; hj?: number; e?: number };
type LaterKind = 'dispatch' | 'wakeInput' | 'endExit' | 'preStroke' | 'pickBooked';

interface Vehicle {
  status: VehicleStatusFlags;
  standPath: string;
  standS: number;
  standTask: number;
  readonly id: string;
  readonly index: number;
  soc: number;
  socAt: number;
  mode: 'drive' | 'idle' | 'charge';
  /** Last known path (for route lengths) — the last dock, or the start path. */
  at: string;
  job: Job | null;
  leg: JobLeg;
  /** Sequence number of the current task (a stale task callback is ignored). */
  taskSeq: number;
  releaseHeld: boolean;
  /** Drop / storage station the vehicle waits at (loaded, in the dock). */
  waitingAt: string | null;
  /** A task that found no fleet handle yet — the watchdog retries. */
  unassigned: TaskDesc | null;
  task: TaskDesc | null;
  /** clear() requested while no handle was there. */
  unassignedClear: boolean;
  /** Own clear() requests not yet reported `effective` (task ownership; an own assign supersedes them). */
  ownClears: number;
  /** Bumped by a hijack — the step callbacks of the aborted job compare it. */
  hijacks: number;
  ordersDone: number;
  charges: number;
  minSoc: number;
  /** Pending fork pre-stroke (null = none). */
  approach: Approach | null;
  approachSeq: number;
  /** Set from a handling stay's end until the vehicle has left that stich (zone released) — the fork does not move. */
  exitSeq: number;
  exiting: { id: number; zone: string; station: string; since: number; reported?: boolean } | null;
}

export interface FleetRunnerState {
  epoch: number;
  waitOwner: string | null;
  counters: JobRunnerCounters;
  firstJobs: string[];
  jobRing: (string | null)[];
  jobHead: number;
  jobCount: number;
  unbrakeableHolds: number;
  vehicles: Array<Omit<Vehicle, 'job'> & { job: Job['kind'] | null; terminalJob: Job | null }>;
}
export interface PreparedFleetRunner {
  state: FleetRunnerState;
  vehicles: Map<string, Vehicle>;
}

/** Shape of the executor's task payload (task ownership, SOL #8). */
interface OwnTaskData { __fleetOwner: number; epoch: number; seq: number }

const emptyCounters = (): JobRunnerCounters => ({
  produced: 0, blockedTakts: 0, picks: 0, delivered: 0, stored: 0, retrieved: 0, bufferPeak: 0, forkWaits: 0, maxForkWaitSec: 0, goArounds: 0,
});

let nextOwnerToken = 1;
const liveOwnerTokens = new Set<number>();

/** The fixed forklift executor — see the module doc. */
export class FleetJobRunner {
  /** External orders share the existing pool and deferred dispatch round. */
  readonly orders = {
    /** The destination is chosen by the dispatcher (strategies), never by the caller. */
    add: (input: Omit<Parameters<OrderPool['add']>[0], 'destination'>): TransportOrder => {
      if (!this.site.stations.some((s) => s.id === input.source)) {
        throw new Error(`FleetJobRunner: unknown source station "${input.source}"`);
      }
      const order = this.dispatcher.orders.add(input, this.clock.now());
      this.later('dispatch');
      return order;
    },
    request: (station: StationId): boolean => {
      const existing = this.dispatcher.orders.openOf(station);
      this.dispatcher.orderReady(station, this.clock.now(), null);
      this.later('dispatch');
      return !existing && this.dispatcher.orders.openOf(station) !== null;
    },
  };
  readonly counters: JobRunnerCounters = emptyCounters();
  /** The first {@link FIRST_JOBS_KEPT} started jobs of the run (`vehicle:kind:from>to`). */
  readonly firstJobs: string[] = [];
  /** The kernel's clock. */
  readonly clock: SimClock;
  /** The kernel's hand-over. */
  readonly handover: HandoverBackend;
  /** The kernel's fork lift. */
  readonly lift: LiftBackend;
  /** Core-owned lamps and status signals. */
  readonly lamps: FleetStatusOutput;
  private readonly fleetName: string;
  /** Hold targets handed to a moving vehicle that could no longer be braked for (plan-634), this run. */
  unbrakeableHolds = 0;
  /** Ring of the last {@link JOB_LOG_LIMIT} started jobs (bounded memory over a soak run). */
  private readonly jobRing: string[] = new Array<string>(JOB_LOG_LIMIT);
  private jobHead = 0;
  private jobCount = 0;
  private readonly vehicles = new Map<string, Vehicle>();
  private readonly fleet: AgvFleet;
  private readonly docks: PathDockRegistry;
  private readonly zones: ZoneRegistry;
  private readonly routes: RouteTable;
  private readonly waits: WaitWatch;
  private readonly limits: WaitLimits;
  private readonly socKey: string | null;
  private readonly decel: number;
  private authority: HoldCheckAuthority | null | undefined;
  private readonly signalScratch: AgvSignalStatus = { run: false, moving: false, blocked: false, speed: 0 };
  private readonly statusInput: VehicleStatusInput = { leg: 'idle' };
  private readonly locScratch: AgvLocation = { pathId: '', s: 0, dir: 1, t: 0 };
  private readonly motionScratch: AgvMotionInfo = {
    speed: 0, field: 'clear', protectiveLength: 0, warningLength: 0, front: 0, width: 0, rear: 0, dir: 1, scanner: false,
  };
  private readonly stationByPath = new Map<string, FleetStation>();
  private readonly pickIds: string[];
  private readonly dropIds: string[];
  private readonly takt: TaktSource;
  private readonly pauses: PauseSource;
  private readonly disposers: Array<() => void> = [];
  /** Start path per vehicle. */
  private readonly startPaths = new Map<string, string>();
  private readonly ownerToken = nextOwnerToken++;
  private _epoch = 0;
  private waitOwner: string | null = null;
  private dispatching = false;
  private redispatch = false;
  private disposed = false;

  constructor(
    readonly adapters: FleetKernelAdapters,
    readonly site: FleetSite,
    readonly dispatcher: FleetDispatcher,
    readonly params: JobRunnerParams,
    opts: JobRunnerOptions = {},
  ) {
    this.clock = adapters.clock;
    this.handover = adapters.handover;
    this.lift = adapters.lift;
    this.lift.setDoneHandler((vehicle, done) => this.onStrokeDone(vehicle, done));
    this.handover.setPickHandler((station, wait) => {
      this.later('pickBooked', { v: wait.v, station, h: wait.h, hj: wait.hj });
    });
    for (const v of site.vehicles) this.startPaths.set(v.id, v.startPathId);
    this.fleet = opts.fleet ?? getDefaultAgvFleet();
    this.docks = opts.docks ?? getDefaultPathDockRegistry();
    this.zones = opts.zones ?? getDefaultZoneRegistry();
    this.lamps = new FleetStatusOutput(opts.status?.signals ?? null, opts.status);
    this.fleetName = opts.status?.fleetName ?? 'Fleet';
    this.socKey = opts.socUserDataKey ?? null;
    this.limits = { ...DEFAULT_WAIT_LIMITS, ...opts.waitLimits };
    this.decel = opts.decelerationMS2 ?? 0;
    this.authority = opts.authority;
    this.disposers.push(this.clock.registerAction('fleet.runner.later', data => this.onLater(data as LaterData & { k: LaterKind; e: number })));
    this.disposers.push(this.clock.registerAction('fleet.runner.chargeDone', data => this.chargeDone(data as { v: string; e: number; hj: number; target: number })));
    this.waits = new WaitWatch({
      clock: this.clock, defaultLimitSec: this.limits.fork, problems: opts.waitProblems,
      cancelOnEnd: false, onTimeout: (vehicle, kind, limit) => this.onWaitTimeout(vehicle, kind, limit),
    });
    const failureAuthority = getDefaultMovementAuthority(this.adapters.kind);
    this.disposers.push(failureAuthority.onFrozenChanged((id, frozen) => this.waits.setPaused(id, 'exit', frozen)));
    this.waits.setResolver({
      valid: (vehicle, kind) => {
        if (kind !== 'standstill') return true;
        const v = this.vehicles.get(vehicle);
        return !!v && this.standing(v) && v.taskSeq === v.standTask
          && this.locScratch.pathId === v.standPath && Math.abs(this.locScratch.s - v.standS) <= 1e-6;
      },
      detail: (vehicle, kind, desc) => {
        const v = this.vehicles.get(vehicle);
        if (!v || desc === null) return undefined;
        const d = desc as { zone?: string; station?: string; heightMm?: number };
        if (kind === 'exit') { const zone = d.zone!; return {
      waiterId: v.id, resourceId: zone, ownerIds: this.zones.holdersOf(zone).filter(id => id !== v.id),
      order: this.orderText(v), waitingFor: `stich zone ${zone} to be released`,
      heldBy: this.zones.holdersOf(zone).join(', ') || 'no current holder',
      extra: `fork stays at ${this.lift.position(v.id).toFixed(0)} mm until the stich zone is released.`,
    }; }
        if (kind === 'fork') { const a = { station: d.station!, heightMm: d.heightMm! }; return {
      waiterId: v.id, resourceId: `fork:${v.id}`, ownerIds: [], nodePath: a.station,
      order: this.orderText(v), waitingFor: `fork to reach ${a.heightMm} mm (actual ${this.lift.position(v.id).toFixed(0)} mm)`,
      heldBy: `fork lift drive of ${v.id} (no progress)`,
      extra: `At the turn point of stich ${a.station}; enters when the fork reaches the approach height.`,
    }; }
        return this.waitCause(v, kind as 'target' | 'charge' | 'standstill', d.station);
      },
    });
    // STICH EXIT: the release of a stich zone is the exit event (module doc).
    this.disposers.push(this.zones.onAvailabilityChanged((z) => this.onZoneFreed(z)));
    liveOwnerTokens.add(this.ownerToken);
    this.disposers.push(() => { liveOwnerTokens.delete(this.ownerToken); });
    this.disposers.push(this.fleet.registerTaskCodec({
      owns: task => {
        const data = task.data as { desc?: unknown; __fleetOwner?: number } | undefined;
        // The snapshot token is canonical (0): ownership is the vehicle - exactly one runner of the fleet has it.
        const vehicleId = (data?.desc as { vehicleId?: unknown } | undefined)?.vehicleId;
        return !!data?.desc && typeof data.__fleetOwner === 'number'
          && typeof vehicleId === 'string' && this.vehicles.has(vehicleId)
          && (data.__fleetOwner === this.ownerToken || !liveOwnerTokens.has(data.__fleetOwner));
      },
      validate: (task, vehicleId) =>
        (task.data as { desc: { vehicleId: string } }).desc.vehicleId === vehicleId
          ? null : 'task vehicle differs from owner',
      // The owner token is process-unique: a snapshot carries 0, `attach` sets the live token again.
      exportData: data => ({ ...(data as object), __fleetOwner: 0 }),
      attach: task => {
        const data = task.data as { desc: TaskDesc & { vehicleId: string }; __fleetOwner: number };
        data.__fleetOwner = this.ownerToken;
        task.onServiceEnd = () => {
          const v = this.vehicles.get(data.desc.vehicleId);
          if (v) this.onTaskServiceEnd(v, data.desc);
        };
      },
    }));
    // TASK OWNERSHIP (SOL #8, S1).
    this.disposers.push(this.fleet.onTaskChanged((id, ch) => this.onTaskChanged(id, ch)));
    this.disposers.push(this.fleet.onIdle((id) => this.onVehicleIdle(id)));
    this.routes = opts.routes ?? new RouteTable(pathNetworkRouteGraph(getDefaultPathNetwork()));
    for (const s of site.stations) this.stationByPath.set(s.pathId, s);
    this.pickIds = site.stations.filter((s) => s.role === 'pick').map((s) => s.id);
    this.dropIds = site.stations.filter((s) => s.role === 'drop').map((s) => s.id);
    this.takt = new TaktSource(this.clock, params.production, this.pickIds.length, {
      headFree: (i) => this.handover.headFree(this.pickIds[i]),
      release: (i) => { if (this.handover.produce(this.pickIds[i])) this.counters.produced++; },
      blocked: () => { this.counters.blockedTakts++; },
    }, opts.rng ?? null, this.pickIds);
    this.pauses = new PauseSource(this.clock, params.pauses, this.dropIds.length, {
      setRun: (i, run) => this.handover.setInputRun(this.dropIds[i], run),
      wake: (i) => this.wakeInput(this.dropIds[i]),
      resumed: () => this.dispatchAll(),
    });
    site.vehicles.forEach((v, index) => this.vehicles.set(v.id, this.freshVehicle(v.id, index)));
    this.handover.onPalletReady = (output, mu) => this.onPalletReady(output, mu);
    this.handover.onInputFreed = (input) => this.later('wakeInput', { input });
    if (opts.orderSignals) this.disposers.push(bindOrderRequests(opts.orderSignals, this.orders, site.stations));
    // One dock per stich (stations + wait point). A dock acts on every vehicle that
    // completes the segment — stiches are dedicated segments, nothing passes through.
    for (const p of [...site.stations.map((s) => s.pathId), site.waitPointPathId]) {
      this.disposers.push(this.docks.register(p, {
        id: `Fleet:${p}`,
        onVehicleArrive: (agvId, release) => this.onDock(p, agvId, release),
      }));
    }
  }

  /** The last {@link JOB_LOG_LIMIT} started jobs in order, oldest first (a copy — tests, diagnostics). */
  get jobLog(): string[] {
    const out: string[] = [];
    const start = (this.jobHead - this.jobCount + JOB_LOG_LIMIT) % JOB_LOG_LIMIT;
    for (let i = 0; i < this.jobCount; i++) out.push(this.jobRing[(start + i) % JOB_LOG_LIMIT]);
    return out;
  }

  /** Current run epoch (bumped by every start). */
  get epoch(): number { return this._epoch; }
  /** Who stands at / heads for the wait point. */
  get waitPointOwner(): string | null { return this.waitOwner; }
  /** Vehicle ids in configuration order. */
  get vehicleIds(): string[] { return [...this.vehicles.keys()]; }
  /** Simulation seconds of the current run (key figures). */
  get simSeconds(): number { return this.clock.now(); }
  /** The wait states of the vehicles (F8). */
  get waitWatch(): WaitWatch { return this.waits; }

  /** Start (or restart after an engine reset): fresh state, takt + pauses armed, everyone dispatched. */
  start(): void {
    if (this.disposed) return;
    this._epoch++;
    this.clock.reset();
    this.pendingNow = 0;
    this.dockReleases.clear();
    this.handover.resetState();
    this.dispatcher.reset();
    this.waits.reset();
    this.waitOwner = null;
    this.firstJobs.length = 0;
    this.jobHead = 0;
    this.jobCount = 0;
    Object.assign(this.counters, emptyCounters());
    this.unbrakeableHolds = 0;
    clearProblemsOfCode(FLEET_WAIT_TIMEOUT_CODE);
    clearProblemsOfCode(FLEET_TASK_HIJACKED_CODE);
    this.lamps.scan(this.site.vehicles.map(({ id }) => ({ id, root: this.handover.vehicleNode(id) })));
    const now = this.clock.now();
    for (const v of this.vehicles.values()) {
      Object.assign(v, this.freshVehicle(v.id, v.index), { socAt: now, taskSeq: v.taskSeq + 1, hijacks: v.hijacks });
      this.lift.snap(v.id, this.params.fork.travelHeightMm);
      this.publishSoc(v, now);
    }
    this.takt.start();
    this.pauses.start();
    this.dispatchAll();
  }

  /** Before the engine reset (viewer `simulation-reset`): no MU may stay parented to a fork or a slot. */
  prepareReset(): void { this.handover.releaseVisuals(); }

  // ── Live changes (planning, plan-630 §2.5 / §2.13) ────────────────────────

  /**
   * Run `fn` as an own event of the simulation clock at the current instant
   * (DES: optionally after model events; continuous: the next fixed
   * tick). A restart before that event drops it.
   */
  snapshotWorld() {
    return { takt: this.takt, pause: this.pauses, wait: this.waits,
      dispatcher: this.dispatcher, lift: this.lift, handover: this.handover };
  }

  exportState(): FleetRunnerState {
    if (this.dispatching || this.redispatch || this.pendingNow)
      throw new Error('fleet.runner: plan-2059 phase 5: dispatch or scheduleNow closure is pending');
    for (const v of this.vehicles.values()) if (v.releaseHeld && !this.fleet.get(v.id)?.releaseStay)
      throw new Error(`fleet.runner: plan-2059 phase 5: live dock release for ${v.id}`);
    return JSON.parse(JSON.stringify({ epoch: this._epoch, waitOwner: this.waitOwner,
      counters: this.counters, firstJobs: this.firstJobs,
      jobRing: Array.from(this.jobRing, x => x ?? null), jobHead: this.jobHead, jobCount: this.jobCount,
      unbrakeableHolds: this.unbrakeableHolds,
      vehicles: [...this.vehicles.values()].map(v => ({ ...v, job: v.job?.kind ?? null, terminalJob: v.job && !this.dispatcher.jobOf(v.id) ? v.job : null })) }));
  }

  validateState(json: unknown, checkJobs = true): string[] {
    const errors: string[] = [];
    if (!json || typeof json !== 'object') return ['fleet.runner: expected state'];
    const s = json as FleetRunnerState;
    const uint = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
    for (const k of ['epoch', 'jobHead', 'jobCount', 'unbrakeableHolds'] as const)
      if (!uint(s[k])) errors.push(`fleet.runner: invalid ${k}`);
    if (s.jobHead >= JOB_LOG_LIMIT || s.jobCount > JOB_LOG_LIMIT) errors.push('fleet.runner: invalid ring bounds');
    if (!Array.isArray(s.jobRing) || s.jobRing.length !== JOB_LOG_LIMIT || s.jobRing.some(x => x !== null && typeof x !== 'string')) errors.push('fleet.runner: invalid jobRing');
    if (!Array.isArray(s.firstJobs) || s.firstJobs.length > FIRST_JOBS_KEPT || s.firstJobs.some(x => typeof x !== 'string')) errors.push('fleet.runner: invalid firstJobs');
    if (!s.counters || Object.keys(emptyCounters()).some(k => !Number.isFinite(s.counters[k as keyof JobRunnerCounters]) || s.counters[k as keyof JobRunnerCounters] < 0)) errors.push('fleet.runner: invalid counters');
    if (s.waitOwner !== null && !this.site.vehicles.some(v => v.id === s.waitOwner)) errors.push('fleet.runner: invalid waitOwner');
    if (!Array.isArray(s.vehicles)) return [...errors, 'fleet.runner: invalid vehicles'];
    if (s.vehicles.length !== this.vehicles.size) errors.push('fleet.runner: vehicle count mismatch');
    const ids = [...this.vehicles.keys()];
    s.vehicles.forEach((v, i) => {
      if (!v || v.id !== ids[i] || v.index !== i) { errors.push('fleet.runner: vehicle configuration mismatch'); return; }
      const template = this.freshVehicle(v.id, i);
      const { terminalJob, ...vehicleState } = v;
      errors.push(...validateShape({ ...vehicleState, job: null, waitingAt: null, status: template.status }, template));
      if (!v.status || ['free', 'orderActive', 'busy', 'handling', 'charging', 'fault', 'moving'].some(k => typeof (v.status as unknown as Record<string, unknown>)[k] !== 'boolean')) errors.push('fleet.runner: invalid status');
      // Delivery removes the dispatcher job before the final stroke/service end.
      if (terminalJob !== null) {
        const j = terminalJob;
        if (!j || j.vehicle !== v.id || j.kind !== v.job || (checkJobs && this.dispatcher.jobOf(v.id) !== null) || !(v.leg === 'atTo' && (j.kind === 'pick' || j.kind === 'retrieve') && j.loaded || v.leg === 'charging' && j.kind === 'charge')) errors.push('fleet.runner: invalid terminal job');
      }
      if (checkJobs && v.terminalJob === null && v.job !== null && this.dispatcher.jobOf(v.id)?.kind !== v.job) errors.push(`fleet.runner: job link mismatch for ${v.id}`);
      if (v.waitingAt !== null && typeof v.waitingAt !== 'string') errors.push('fleet.runner: invalid waitingAt');
      if (!['drive', 'idle', 'charge'].includes(v.mode)) errors.push('fleet.runner: invalid mode');
      if (!['idle', 'toFrom', 'atFrom', 'toTo', 'atTo', 'toCharger', 'charging', 'toWait', 'atWait', 'cruise', 'foreign'].includes(v.leg)) errors.push('fleet.runner: invalid leg');
      for (const task of [v.task, v.unassigned]) if (task !== null) {
        if (!task || !['hop', 'main', 'turn', 'around'].includes(task.kind) || typeof task.destination !== 'string'
          || !uint(task.seq) || !uint(task.e)) errors.push('fleet.runner: invalid task descriptor');
      }
      if (v.approach !== null) errors.push(...validateShape(v.approach, {
        id: 0, station: '', pathId: '', heightMm: 0, loaded: false, ready: false, atTurn: false, waitSince: 0, reported: false,
      }));
      if (v.exiting !== null && (!v.exiting || !uint(v.exiting.id) || typeof v.exiting.zone !== 'string'
        || typeof v.exiting.station !== 'string' || !Number.isFinite(v.exiting.since))) errors.push('fleet.runner: invalid exit');
      if (v.releaseHeld && !this.fleet.get(v.id)?.releaseStay) errors.push('fleet.runner: plan-2059 phase 5: live dock release');
      if (v.job !== null && !['pick', 'retrieve', 'charge', 'queue', 'park'].includes(v.job)) errors.push(`fleet.runner: invalid job link for ${v.id}`);
      for (const k of ['soc', 'socAt', 'standS', 'minSoc'] as const) if (!Number.isFinite(v[k])) errors.push(`fleet.runner: invalid ${k}`);
      for (const k of ['taskSeq', 'standTask', 'ownClears', 'hijacks', 'ordersDone', 'charges', 'approachSeq', 'exitSeq'] as const)
        if (!uint(v[k])) errors.push(`fleet.runner: invalid ${k}`);
    });
    return errors;
  }

  prepareState(json: unknown, checkJobs = true): PreparedFleetRunner {
    const errors = this.validateState(json, checkJobs);
    if (errors.length) throw new Error(errors.join('; '));
    const state = structuredClone(json as FleetRunnerState);
    return { state, vehicles: new Map(state.vehicles.map(({ terminalJob: _terminalJob, ...v }) => [v.id, { ...v, job: null }])) };
  }

  swapState({ state: s, vehicles }: PreparedFleetRunner): void {
    // The status de-dupe cache belongs to the replaced run: the next frame writes every status signal again.
    this.lamps.invalidate();
    this._epoch = s.epoch;
    this.waitOwner = s.waitOwner;
    Object.assign(this.counters, s.counters);
    this.firstJobs.splice(0, this.firstJobs.length, ...s.firstJobs);
    for (let i = 0; i < JOB_LOG_LIMIT; i++) this.jobRing[i] = s.jobRing[i] ?? undefined!;
    this.jobHead = s.jobHead;
    this.jobCount = s.jobCount;
    this.unbrakeableHolds = s.unbrakeableHolds;
    this.vehicles.clear();
    for (const [id, v] of vehicles) {
      const kind = s.vehicles[v.index].job;
      v.job = kind === null ? null : this.dispatcher.jobOf(id) ?? s.vehicles[v.index].terminalJob;
      this.vehicles.set(id, v);
    }
    this.dockReleases.clear();
  }

  relinkStateJobs(): void {
    for (const v of this.vehicles.values()) {
      if (v.job) v.job = this.dispatcher.jobOf(v.id) ?? v.job;
      if (v.releaseHeld) this.dockReleases.set(v.id, () => this.fleet.get(v.id)?.releaseStay?.());
    }
  }

  private readonly dockReleases = new Map<string, () => void>();
  private pendingNow = 0;
  get pendingScheduleNow(): number { return this.pendingNow; }

  scheduleNow(fn: () => void, isValid?: () => boolean, opts?: { afterModelEvents?: boolean }): void {
    if (this.disposed) return;
    const e = this._epoch;
    this.pendingNow++;
    this.clock.schedule(this.clock.now(), () => {
      this.pendingNow--;
      if (e !== this._epoch || this.disposed || (isValid && !isValid())) return;
      fn();
    }, opts);
  }

  /** The takt of pick station number `index` (station order) re-bases on its last release (after an interval change). */
  retimeTakt(index: number): void { this.takt.retime(index); }

  /**
   * Replace the seeded RNG of the stochastic takt (plan-2051; null = fixed takt).
   * Call before {@link start}: the RNG's current state becomes the start of every
   * run of this runner, so a restart without reconstruction replays the same stream.
   */
  setRng(rng: RngStream | RngFactory | null): void { this.takt.setRng(rng); }

  /** The pause plan changed: restart it from now (state switched at once, next change re-planned), then a dispatch round. */
  replanPauses(): void {
    this.pauses.replan();
    this.dispatchAll();
  }

  /** Per frame: seat reconcile, SOC display, status. */
  frame(): void {
    if (this.disposed) return;
    this.handover.reconcile();
    const now = this.clock.now();
    this.waits.poll(now);
    for (const v of this.vehicles.values()) {
      this.trackStandstill(v);
      this.publishSoc(v, now);
      this.lamps.apply(v.id, this.statusOf(v.id)!, now);
    }
    this.lamps.fleetCounts(this.fleetName, this.dispatcher.orders.pendingCount, this.dispatcher.orders.doneCount);
  }

  /** Reused per-vehicle view; copy to retain a snapshot. Reads simulation state without advancing it. */
  statusOf(id: string): VehicleStatusFlags | null {
    const v = this.vehicles.get(id);
    if (!v) return null;
    const h = this.fleet.get(id);
    const input = this.statusInput;
    input.jobKind = v.job?.kind; input.leg = v.leg; input.soc = this.socAt(id);
    input.speed = h?.motion?.(this.motionScratch) ? this.motionScratch.speed : undefined;
    input.phase = h?.phase;
    input.reportedKind = this.waits.firstReportedKind(id);
    return deriveVehicleStatus(input, v.status);
  }

  private orderText(v: Vehicle): string {
    const job = this.dispatcher.jobOf(v.id) ?? v.job;
    if (!job) return 'none';
    if (job.kind === 'pick' || job.kind === 'retrieve') return `${job.kind} ${job.from}>${job.kind === 'pick' ? job.to.station : job.to}`
      + (job.kind === 'pick' && job.order ? ` (${job.order.id})` : '');
    return `${job.kind} ${v.at}>${job.kind === 'charge' ? job.charger : this.site.waitPointPathId}`;
  }

  private waitCause(v: Vehicle, kind: 'target' | 'charge' | 'standstill', station = v.waitingAt!): WaitCause {
    const order = this.orderText(v);
    if (kind === 'target') {
      const paused = this.pauses.paused(this.dropIds.indexOf(station), this.clock.now());
      const reserved = this.dispatcher.reservedBy(station);
      const occupant = this.handover.inputOccupant?.(station);
      return { waiterId: v.id, resourceId: station, ownerIds: !paused && occupant ? [occupant] : [], ownerMUs: true,
        nodePath: station, order, waitingFor: `drop at ${station}`, heldBy: paused ? 'input paused (pause plan)'
        : !this.handover.inputFree(station) ? `input occupied${occupant ? ` by MU ${occupant}` : ''}` : 'hand-over refused',
        extra: reserved ? `Reserved by: ${reserved}` : undefined };
    }
    if (kind === 'charge') return { waiterId: v.id, resourceId: 'fleet:chargers',
      ownerIds: this.vehicleIds.filter(id => !!this.chargingAt(id)), order, waitingFor: 'a free charger',
      heldBy: this.vehicleIds.filter(id => this.chargingAt(id)).map(id => `${id} at ${this.chargingAt(id)}`).join(', ') || 'no vehicle charging now',
      extra: `Charger queue: ${this.dispatcher.chargerQueue.join(' > ')}` };
    const h = this.fleet.get(v.id);
    const field = h?.motion?.(this.motionScratch) ? this.motionScratch.field : 'unknown';
    const network = getDefaultPathNetwork();
    const zone = network.get(v.standPath)?.zoneId;
    const holders = zone ? this.zones.holdersOf(zone).filter(id => id !== v.id) : [];
    const blocked = h?.signalStatus ? (h.signalStatus(this.signalScratch), `, blocked: ${this.signalScratch.blocked}`) : '';
    return { waiterId: v.id, resourceId: zone ?? v.standPath, ownerIds: holders,
      nodePath: v.standPath, order, waitingFor: `motion on path ${v.standPath} at s ${v.standS} m`,
      heldBy: holders.length ? `${holders.join(', ')} (zone ${zone})` : `motion field: ${field}${blocked}`,
      extra: holders.length ? `Motion field: ${field}${blocked}` : undefined };
  }

  private standing(v: Vehicle): boolean {
    if (!v.job || (v.leg !== 'toFrom' && v.leg !== 'toTo' && v.leg !== 'toCharger' && v.leg !== 'toWait')) return false;
    if (this.waits.isWaiting(v.id, 'fork') || this.waits.isWaiting(v.id, 'exit')
      || this.waits.isWaiting(v.id, 'target') || this.waits.isWaiting(v.id, 'charge')) return false;
    const h = this.fleet.get(v.id);
    return !!h?.motion?.(this.motionScratch) && Math.abs(this.motionScratch.speed) <= 1e-3 && !!h.locate?.(this.locScratch);
  }

  private trackStandstill(v: Vehicle): void {
    if (!this.standing(v) || this.waits.isWaiting(v.id, 'standstill')) return;
    v.standPath = this.locScratch.pathId; v.standS = this.locScratch.s; v.standTask = v.taskSeq;
    this.waits.begin(v.id, 'standstill', this.limits.standstill, {}, { passive: true });
  }

  /** Detached diagnostics snapshot; no clock events or simulation mutations. */
  fleetStats(): FleetStats {
    const { picks, delivered, stored, retrieved, produced, blockedTakts } = this.counters;
    return {
      ordersPending: this.dispatcher.orders.pendingCount, ordersDone: this.dispatcher.orders.doneCount,
      picks, delivered, stored, retrieved, produced, blockedTakts,
      waits: Object.fromEntries(this.waits.kinds().map(kind => [kind, { ...this.waits.stats(kind) }])),
      faults: this.vehicleIds.filter(id => this.waits.isOverLimit(id)).length,
    };
  }

  /** True while a task or clear waits for a fleet handle (the watchdog only runs then). */
  get hasPendingAssignments(): boolean {
    if (this.disposed) return false;
    for (const v of this.vehicles.values()) if (v.unassigned || v.unassignedClear) return true;
    return false;
  }

  /** Watchdog (wall clock, STARTS work only): tasks that found no fleet handle, then a dispatch round. */
  kick(): void {
    if (this.disposed) return;
    for (const v of this.vehicles.values()) {
      const h = this.fleet.get(v.id);
      if (!h) continue;
      if (v.unassigned) {
        const t = this.buildTask(v, v.unassigned);
        v.unassigned = null;
        this.checkHold(v, t);
        h.assign(t);
      } else if (v.unassignedClear) { v.unassignedClear = false; v.ownClears++; h.clear(); }
    }
    this.dispatchAll();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this._epoch++;
    this.takt.stop();
    this.pauses.stop();
    for (const d of this.disposers) { try { d(); } catch { /* ignore */ } }
    this.disposers.length = 0;
    this.waits.reset();
    this.handover.dispose();
  }

  /**
   * Charger a vehicle is charging at RIGHT NOW (from the start of the charge
   * until its end: charging leg AND battery in charge mode), else null.
   */
  chargingAt(id: string): string | null {
    const v = this.vehicles.get(id);
    if (!v || v.leg !== 'charging' || v.mode !== 'charge' || v.job?.kind !== 'charge') return null;
    return v.job.charger;
  }

  /** SOC of a vehicle at `t` (projected from the last event, no state change). */
  socAt(id: string, t = this.clock.now()): number {
    const v = this.vehicles.get(id);
    return v ? this.projectSoc(v, t) : 0;
  }

  /** Per-vehicle progress (tests, statistics). */
  stats(id: string): VehicleJobStats | null {
    const v = this.vehicles.get(id);
    if (!v) return null;
    const a = v.approach;
    return {
      soc: this.socAt(id), minSoc: v.minSoc, ordersDone: v.ordersDone, charges: v.charges, leg: v.leg,
      job: v.job?.kind ?? null, waitingAt: v.waitingAt,
      approach: a ? { station: a.station, heightMm: a.heightMm, ready: a.ready } : null,
      forkWait: a && a.atTurn && !a.ready
        ? { station: a.station, targetMm: a.heightMm, actualMm: this.lift.position(id), sinceSec: this.clock.now() - a.waitSince }
        : null,
    };
  }

  // ── Vehicle state ─────────────────────────────────────────────────────────

  private freshVehicle(id: string, index: number): Vehicle {
    const soc = this.params.startSoc[index] ?? 100;
    return {
      status: deriveVehicleStatus({ leg: 'idle' }), standPath: '', standS: 0, standTask: 0,
      id, index, soc, socAt: 0, mode: 'idle', at: this.startPaths.get(id) ?? '',
      job: null, leg: 'idle', task: null, exitSeq: 0, taskSeq: 0, releaseHeld: false, waitingAt: null, unassigned: null, unassignedClear: false,
      ownClears: 0, hijacks: 0, ordersDone: 0, charges: 0, minSoc: soc, approach: null, approachSeq: 0, exiting: null,
    };
  }

  private projectSoc(v: Vehicle, t: number): number {
    const dt = Math.max(0, t - v.socAt);
    const b = this.params.battery;
    if (v.mode === 'charge') return chargeFor(v.soc, dt, b);
    if (v.mode === 'drive') return consume(v.soc, { driveSec: dt, liftM: 0, idleSec: 0 }, b);
    return consume(v.soc, { driveSec: 0, liftM: 0, idleSec: dt }, b);
  }

  /** Book the time since the last event in the current mode, then switch to `mode`. */
  private account(v: Vehicle, mode: Vehicle['mode']): void {
    const now = this.clock.now();
    v.soc = this.projectSoc(v, now);
    v.socAt = now;
    v.mode = mode;
    v.minSoc = Math.min(v.minSoc, v.soc);
  }

  private publishSoc(v: Vehicle, now: number): void {
    if (!this.socKey) return;
    const node = this.handover.vehicleNode(v.id);
    if (node) node.userData[this.socKey] = this.projectSoc(v, now);
  }

  // ── Lift ──────────────────────────────────────────────────────────────────

  /** One fork stroke (books the lift metres); the continuation runs at its end — epoch- and hijack-guarded. */
  private stroke(v: Vehicle, toMm: number, loaded: boolean, cont: StrokeCont): void {
    const from = this.lift.position(v.id);
    this.account(v, v.mode);
    v.soc = consume(v.soc, { driveSec: 0, liftM: Math.abs(toMm - from) / 1000, idleSec: 0 }, this.params.battery);
    v.minSoc = Math.min(v.minSoc, v.soc);
    const fork = this.params.fork;
    const e = this._epoch;
    const hj = v.hijacks;
    this.lift.move(v.id, toMm, loaded ? fork.liftSpeedLoadedMmS : fork.liftSpeedEmptyMmS, { e, hj, cont });
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  private onStrokeDone(vehicle: string, done: LiftDone): void {
    const v = this.vehicles.get(vehicle);
    if (!v || done.e !== this._epoch || done.hj !== v.hijacks) return;
    const c = done.cont;
    switch (c.k) {
      case 'none': return;
      case 'finishStay': this.finishStay(v); return;
      case 'approachReady': {
        const a = v.approach;
        if (!a || a.id !== c.a) return;
        a.ready = true;
        this.enterStich(v, a);
        return;
      }
      case 'pickTouch': this.handover.awaitPick(c.station, v.id, { v: v.id, h: c.h, hj: done.hj }); return;
      case 'retrieveTouch':
        if (this.handover.retrieve(c.station, v.id) === null) console.warn(`[Fleet] ${v.id}: slot ${c.station} is empty`);
        this.dispatcher.picked(v.id, this.clock.now());
        this.counters.retrieved++;
        this.stroke(v, c.h, true, { k: 'finishStay' });
        return;
      case 'deliver': {
        const s = this.dispatcher.station(c.station);
        if (s.role === 'drop') this.tryDrop(v, s); else this.storeAt(v, s);
      }
    }
  }

  private taskData(e: number, seq: number, extra?: Record<string, unknown>): OwnTaskData & Record<string, unknown> {
    return { __fleetOwner: this.ownerToken, epoch: e, seq, ...extra };
  }

  private isOwn(t: AgvTask): boolean {
    return (t.data as Partial<OwnTaskData> | undefined)?.__fleetOwner === this.ownerToken;
  }

  private assign(v: Vehicle, pathId: string, serviceState?: string): void {
    const seq = ++v.taskSeq;
    const e = this._epoch;
    if (pathId === v.at && this.site.turnOf.has(pathId)) {
      // The vehicle stands in (or last left) this very stich: a task to the segment it is on
      // would be served at the stich END. First out to the turn point (forward), then back in.
      // plan-2059 phase 5: reattach through rebuildTask after restoring the Agv.
      this.handOver(v, { kind: 'hop', destination: this.site.turnOf.get(pathId)!, e, seq, pathId, ...(serviceState ? { serviceState } : {}) });
      return;
    }
    // plan-2059 phase 5: reattach through rebuildTask after restoring the Agv.
    this.handOver(v, { kind: 'main', destination: pathId, approach: 'reverse', e, seq, ...(serviceState ? { serviceState } : {}) });
  }

  rebuildTask(agvId: string): AgvTask | null {
    const v = this.vehicles.get(agvId);
    return v?.task ? this.buildTask(v, v.task) : null;
  }

  private buildTask(v: Vehicle, desc: TaskDesc): AgvTask {
    const extra = desc.kind === 'hop' ? { hop: true } : desc.kind === 'turn' ? { turn: desc.station } : desc.kind === 'around' ? { around: desc.station } : undefined;
    return { destination: desc.destination, ...(desc.approach ? { approach: desc.approach } : {}),
      ...(desc.serviceState ? { serviceState: desc.serviceState } : {}),
      data: this.taskData(desc.e, desc.seq, { ...extra, desc: JSON.parse(JSON.stringify({ ...desc, vehicleId: v.id })) }), // By id: swapState replaces the Vehicle objects, a task built before it must reach the new one.
      onServiceEnd: () => { const cur = this.vehicles.get(v.id); if (cur) this.onTaskServiceEnd(cur, desc); } };
  }

  private onTaskServiceEnd(v: Vehicle, d: TaskDesc): void {
    if (d.e !== this._epoch || d.seq !== v.taskSeq) return;
    if (d.kind === 'main') { this.onServiceEnd(v.id); return; }
    if (d.kind === 'hop') { v.at = d.destination; this.assign(v, d.pathId!, d.serviceState); return; }
    const a = v.approach;
    if (!a || a.id !== d.aid) return;
    v.at = d.destination;
    if (d.kind === 'around') {
      v.approach = null;
      this.approachStich(v, this.dispatcher.station(d.station!), a.heightMm, a.loaded);
      return;
    }
    const k = this.site.zoneOf(d.station!);
    if (this.zones.holderCount(k) > 0 && !this.zones.isHolder(k, v.id)) { this.goAround(v, a, d.destination); return; }
    this.beginForkWait(v, a);
    this.later('preStroke', { v: v.id, a: a.id });
  }

  private handOver(v: Vehicle, desc: TaskDesc): void {
    const t = this.buildTask(v, desc);
    v.task = desc;
    this.account(v, 'drive');
    v.releaseHeld = false;
    this.dockReleases.delete(v.id);
    v.ownClears = 0;
    const h = this.fleet.get(v.id);
    v.unassignedClear = false;
    if (h) {
      v.unassigned = null;
      this.checkHold(v, t);
      h.assign(t);
    } else v.unassigned = desc;
  }

  private cruise(v: Vehicle): void {
    v.taskSeq++;
    v.task = null;
    this.account(v, 'drive');
    v.leg = 'cruise';
    v.releaseHeld = false;
    this.dockReleases.delete(v.id);
    this.dropApproach(v);
    if (this.waitOwner === v.id) this.waitOwner = null;
    const h = this.fleet.get(v.id);
    v.unassigned = null;
    if (h) {
      v.unassignedClear = false;
      v.ownClears++;
      h.clear();
    } else v.unassignedClear = true;
  }

  /** Drop a pending approach (its fork wait ends). */
  private dropApproach(v: Vehicle): void {
    if (v.approach) this.waits.end(v.id, 'fork');
    v.approach = null;
  }

  private startJob(v: Vehicle, job: Job): void {
    v.job = job;
    this.dropApproach(v); // a pick / retrieve sets its own below
    if (job.kind !== 'queue') this.waits.end(v.id, 'charge');
    if (this.waitOwner === v.id && job.kind !== 'park' && job.kind !== 'queue') this.waitOwner = null;
    switch (job.kind) {
      case 'pick':
      case 'retrieve': {
        const to = job.kind === 'pick' ? job.to.station : job.to;
        this.logJob(`${v.id}:${job.kind}:${job.from}>${to}`);
        v.leg = 'toFrom';
        const from = this.dispatcher.station(job.from);
        // Pick / retrieve: the fork goes in UNDER the load.
        this.approachStich(v, from, Math.max(0, from.handlingHeightMm - this.params.fork.handlingDeltaMm), false);
        return;
      }
      case 'charge':
        this.logJob(`${v.id}:charge:${job.charger}`);
        v.leg = 'toCharger';
        this.assign(v, this.dispatcher.station(job.charger).pathId, 'Charging');
        return;
      case 'queue':
        this.waits.begin(v.id, 'charge', this.limits.charge, {}, { passive: true });
        this.goWait(v);
        return;
      case 'park':
        this.goWait(v);
        return;
    }
  }

  private logJob(entry: string): void {
    if (this.firstJobs.length < FIRST_JOBS_KEPT) this.firstJobs.push(entry);
    this.jobRing[this.jobHead] = entry;
    this.jobHead = (this.jobHead + 1) % JOB_LOG_LIMIT;
    if (this.jobCount < JOB_LOG_LIMIT) this.jobCount++;
  }

  /** The wait point for a queued / parked vehicle — or cruising while it is taken (module doc). */
  private goWait(v: Vehicle): void {
    if (v.leg === 'toWait' || v.leg === 'atWait') { this.waitOwner = v.id; return; }
    const owner = this.waitOwner ? this.vehicles.get(this.waitOwner) ?? null : null;
    if (owner && owner !== v) {
      if (v.job?.kind === 'queue' && owner.job?.kind === 'park') this.cruise(owner); // the queue has precedence
      else { this.cruise(v); return; }
    }
    this.waitOwner = v.id;
    v.leg = 'toWait';
    this.assign(v, this.site.waitPointPathId);
  }

  /** The wait point is free: the head of the charger queue first, then a parked vehicle (id order). */
  private fillWaitPoint(): void {
    if (this.waitOwner) return;
    let next: Vehicle | null = null;
    for (const id of this.dispatcher.chargerQueue) {
      const v = this.vehicles.get(id);
      if (v && v.leg === 'cruise') { next = v; break; }
    }
    if (!next) for (const v of this.vehicles.values()) if (v.leg === 'cruise' && v.job?.kind === 'park') { next = v; break; }
    if (next) this.goWait(next);
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  private views(now: number): VehicleView[] {
    const out: VehicleView[] = [];
    for (const v of this.vehicles.values()) {
      // A vehicle inside a stay (between delivered/chargeDone and its service end) is not free yet.
      if (v.leg === 'idle' || v.leg === 'cruise' || v.leg === 'toWait' || v.leg === 'atWait') {
        out.push({ id: v.id, soc: this.projectSoc(v, now), at: v.at });
      }
    }
    return out;
  }

  /** Hand out jobs to every free vehicle. Re-entrant calls coalesce into one more round. */
  dispatchAll(): void {
    if (this.disposed) return;
    if (this.dispatching) { this.redispatch = true; return; }
    this.dispatching = true;
    try {
      do {
        this.redispatch = false;
        const now = this.clock.now();
        const jobs = this.dispatcher.dispatch(this.views(now), {
          t: now,
          distanceM: (a, b) => this.distanceM(a, b),
          canReceive: (s, t) => this.handover.inputFree(s) && !this.pauses.paused(this.dropIds.indexOf(s), t),
        });
        for (const j of jobs) {
          const v = this.vehicles.get(j.vehicle);
          if (v) this.startJob(v, j);
        }
        // Safety net — never idle in a stich: a vehicle without a job cruises.
        for (const v of this.vehicles.values()) if (v.leg === 'idle') this.cruise(v);
        this.fillWaitPoint();
      } while (this.redispatch);
    } finally {
      this.dispatching = false;
    }
  }

  /** Run `fn` as an own clock event at `now` — never re-enter a conveyor / Agv stack. */
  private later(k: LaterKind, data: LaterData = {}): void {
    this.clock.scheduleAction(this.clock.now(), 'fleet.runner.later', { k, e: this._epoch, ...data });
  }

  private onLater(d: LaterData & { k: LaterKind; e: number }): void {
    if (d.e !== this._epoch) return;
    if (d.k === 'dispatch') { this.dispatchAll(); return; }
    if (d.k === 'wakeInput') { this.wakeInput(d.input!); this.dispatchAll(); return; }
    const v = this.vehicles.get(d.v!);
    if (!v) return;
    if (d.k === 'endExit' && v.exiting?.id === d.x) this.endExit(v);
    const a = v.approach;
    if (d.k === 'preStroke' && a && a.id === d.a && !v.exiting) this.preStroke(v, a);
    if (d.k === 'pickBooked' && d.hj === v.hijacks) {
      this.bookPick(v, d.station!);
      this.stroke(v, d.h!, true, { k: 'finishStay' });
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private onPalletReady(output: string, mu: string): void {
    this.dispatcher.orderReady(output, this.clock.now(), mu);
    this.later('dispatch');
  }

  private onDock(pathId: string, agvId: string, release: () => void): void {
    const v = this.vehicles.get(agvId);
    if (!v || this.disposed) { release(); return; }
    const station = this.stationByPath.get(pathId) ?? null;
    const job = v.job;
    this.account(v, 'idle');
    v.at = pathId;
    v.releaseHeld = true;
    this.dockReleases.set(v.id, release);
    if (pathId === this.site.waitPointPathId && v.leg === 'toWait') { v.leg = 'atWait'; return; } // held until a job comes
    if (station && job && v.leg === 'toFrom' && (job.kind === 'pick' || job.kind === 'retrieve') && job.from === station.id) {
      v.leg = 'atFrom';
      if (job.kind === 'pick') this.doPick(v, station); else this.doRetrieve(v, station);
      return;
    }
    if (station && job && v.leg === 'toTo' && (job.kind === 'pick' || job.kind === 'retrieve')
      && (job.kind === 'pick' ? job.to.station : job.to) === station.id) {
      v.leg = 'atTo';
      this.doDeliver(v, station);
      return;
    }
    if (station && job && v.leg === 'toCharger' && job.kind === 'charge' && job.charger === station.id) {
      v.leg = 'charging';
      this.startCharge(v);
      return;
    }
    // Not the stay this vehicle was sent for — let it go on.
    this.finishStay(v);
  }

  private finishStay(v: Vehicle): void {
    this.releaseDock(v);
  }

  // Live releases are services; restore binds them to the current Agv handle.
  private releaseDock(v: Vehicle): void {
    const r = this.dockReleases.get(v.id);
    v.releaseHeld = false;
    this.dockReleases.delete(v.id);
    r?.();
  }

  /** Service end of a stay (task `onServiceEnd`): the vehicle leaves the stich forward. */
  private onServiceEnd(agvId: string): void {
    const v = this.vehicles.get(agvId);
    if (!v) return;
    this.account(v, 'drive');
    // A handling stay: the fork is in / under the load it just released — hands off until the
    // vehicle has left the stich (STICH EXIT); then travel height or the next pre-stroke.
    if (v.leg === 'atFrom' || v.leg === 'atTo') this.beginExit(v);
    const job = v.job;
    if (v.leg === 'atFrom' && job && (job.kind === 'pick' || job.kind === 'retrieve')) {
      v.leg = 'toTo';
      const to = this.dispatcher.station(job.kind === 'pick' ? job.to.station : job.to);
      // Delivery: the load comes in ABOVE the support.
      this.approachStich(v, to, to.handlingHeightMm + this.params.fork.handlingDeltaMm, true);
      return;
    }
    v.job = null;
    v.leg = 'idle';
    this.dispatchAll();
  }

  // ── Stich exit ────────────────────────────────────────────────────────────

  /** A handling stay ends: the fork is held until the stich zone is released (module doc, STICH EXIT). */
  private beginExit(v: Vehicle): void {
    const station = this.stationByPath.get(v.at);
    if (!station) return;
    const zone = this.site.zoneOf(station.id);
    const x: NonNullable<Vehicle['exiting']> = { id: ++v.exitSeq, zone, station: station.id, since: this.clock.now() };
    if (v.exiting) this.waits.end(v.id, 'exit');
    v.exiting = x;
    // Already out (no claim held — defensive): exit as an own event.
    if (!this.zones.isHolder(zone, v.id)) { this.later('endExit', { v: v.id, x: x.id }); return; }
    this.waits.begin(v.id, 'exit', this.limits.exit, { zone });
    this.waits.setPaused(v.id, 'exit', getDefaultMovementAuthority(this.adapters.kind).isFrozen(v.id));
  }

  /** Zone availability (ZoneRegistry): a released stich zone ends the exit of the vehicle that left it. */
  private onZoneFreed(zone: string): void {
    if (this.disposed) return;
    for (const v of this.vehicles.values()) {
      const x = v.exiting;
      if (!x || x.zone !== zone || this.zones.isHolder(zone, v.id)) continue;
      // Inside the movement authority's release — continue as an own event.
      this.later('endExit', { v: v.id, x: x.id });
    }
  }

  /** The vehicle has left the stich: the pending pre-stroke, else travel height. */
  private endExit(v: Vehicle): void {
    v.exiting = null;
    this.waits.end(v.id, 'exit');
    if (v.releaseHeld) return; // a new stay owns the fork
    const a = v.approach;
    // Already standing at the next turn point (exit reported late): straight to the approach height.
    if (a && a.atTurn && !a.ready) { this.preStroke(v, a); return; }
    const travel = this.params.fork.travelHeightMm;
    if (Math.abs(this.lift.position(v.id) - travel) <= 0.5) return;
    this.stroke(v, travel, this.handover.carried(v.id) !== null, { k: 'none' });
  }

  // ── Fork first ────────────────────────────────────────────────────────────

  /**
   * Head for the handling stich `s` with the fork at `heightMm` (module doc,
   * FORK FIRST): forward to the stich's turn point at travel height, the
   * pre-stroke there, the reverse task once it is done.
   */
  private approachStich(v: Vehicle, s: FleetStation, heightMm: number, loaded: boolean): void {
    if (v.approach) this.waits.end(v.id, 'fork');
    const a: Approach = {
      id: ++v.approachSeq, station: s.id, pathId: s.pathId, heightMm, loaded,
      ready: false, atTurn: false, waitSince: -1, reported: false,
    };
    v.approach = a;
    const turn = this.site.turnOf.get(s.pathId)!;
    const seq = ++v.taskSeq;
    const e = this._epoch;
    this.handOver(v, { kind: 'turn', destination: turn, e, seq, station: s.id, aid: a.id });
  }

  /** One lap at travel height, then the same approach again. */
  private goAround(v: Vehicle, a: Approach, turn: string): void {
    this.counters.goArounds++;
    const seq = ++v.taskSeq;
    const e = this._epoch;
    const next = this.site.nextOf.get(turn)!;
    this.handOver(v, { kind: 'around', destination: next, e, seq, station: a.station, aid: a.id });
  }

  /** The approach stroke; at its end the reverse task (replacing the turn task, or ending the wait). */
  private preStroke(v: Vehicle, a: Approach): void {
    this.stroke(v, a.heightMm, a.loaded, { k: 'approachReady', a: a.id });
  }

  /** The fork is at approach height: back into the stich (the plain reverse task). */
  private enterStich(v: Vehicle, a: Approach): void {
    if (a.atTurn) {
      const waited = this.clock.now() - a.waitSince;
      this.counters.maxForkWaitSec = Math.max(this.counters.maxForkWaitSec, waited);
      a.atTurn = false;
      this.waits.end(v.id, 'fork');
      if (a.reported) console.warn(`[Fleet] ${v.id}: fork at ${a.heightMm} mm after ${waited.toFixed(1)} s — entering stich ${a.station}`);
    }
    v.approach = null;
    this.assign(v, a.pathId);
  }

  /** The vehicle stands at the turn point before its fork is ready: wait, counted and watched. */
  private beginForkWait(v: Vehicle, a: Approach): void {
    this.account(v, 'idle');
    a.atTurn = true;
    a.waitSince = this.clock.now();
    this.counters.forkWaits++;
    this.waits.begin(v.id, 'fork', this.limits.fork, { station: a.station, heightMm: a.heightMm });
  }

  /** A wait reached its limit (WaitWatch, before its Problems entry): status flag + counter. */
  private onWaitTimeout(vehicle: string, kind: string, limit: number): void {
    const v = this.vehicles.get(vehicle);
    if (!v) return;
    if (kind === 'fork' && v.approach) {
      v.approach.reported = true;
      this.counters.maxForkWaitSec = Math.max(this.counters.maxForkWaitSec, limit);
      console.warn(`[Fleet] ${vehicle} waits at the turn point of stich ${v.approach.station} for its fork: `
        + `target ${v.approach.heightMm} mm, actual ${this.lift.position(vehicle).toFixed(0)} mm, for ${limit} s (sim)`);
    } else if (kind === 'exit' && v.exiting) {
      v.exiting.reported = true;
      console.warn(`[Fleet] ${vehicle} has not left stich ${v.exiting.station} ${limit} s (sim) after its stay `
        + `(zone ${v.exiting.zone} still held); fork stays at ${this.lift.position(vehicle).toFixed(0)} mm`);
    }
  }

  private doPick(v: Vehicle, s: FleetStation): void {
    this.stroke(v, s.handlingHeightMm, false, { k: 'pickTouch', station: s.id, h: s.handlingHeightMm + this.params.fork.handlingDeltaMm });
  }

  /** The MU of pick station `station` is on the fork: dispatcher, counter, takt (head free again). */
  private bookPick(v: Vehicle, station: string): void {
    this.dispatcher.picked(v.id, this.clock.now());
    this.counters.picks++;
    const i = this.pickIds.indexOf(station);
    if (i >= 0) this.takt.headFreed(i);
  }

  private doRetrieve(v: Vehicle, s: FleetStation): void {
    this.stroke(v, s.handlingHeightMm, false, { k: 'retrieveTouch', station: s.id, h: s.handlingHeightMm + this.params.fork.handlingDeltaMm });
  }

  private doDeliver(v: Vehicle, s: FleetStation): void {
    // In ABOVE the support (h + d, done at the turn point), then down to h: the load
    // bottom stands on the support, the hand-over keeps its pose. A vehicle that has
    // to wait for a paused / occupied input waits with the load set down.
    this.stroke(v, s.handlingHeightMm, true, { k: 'deliver', station: s.id });
  }

  /** Drop at a drop station — the vehicle waits in the dock while the input is paused or occupied (wait `target`). */
  private tryDrop(v: Vehicle, s: FleetStation): boolean {
    const i = this.dropIds.indexOf(s.id);
    const now = this.clock.now();
    if (this.pauses.paused(i, now) || !this.handover.inputFree(s.id) || !this.handover.putOnHead(v.id, s.id)) {
      v.waitingAt = s.id;
      this.waits.begin(v.id, 'target', this.limits.target, { station: s.id }, { passive: true });
      return false;
    }
    v.waitingAt = null;
    this.waits.end(v.id, 'target');
    this.counters.delivered++;
    this.completeDelivery(v, s);
    return true;
  }

  private storeAt(v: Vehicle, s: FleetStation): void {
    if (!this.handover.store(v.id, s.id)) {
      console.warn(`[Fleet] ${v.id}: slot ${s.id} refused the load — keeping it`);
      v.waitingAt = s.id;
      return;
    }
    this.counters.stored++;
    this.completeDelivery(v, s);
    this.counters.bufferPeak = Math.max(this.counters.bufferPeak, this.dispatcher.storage(s.storageGroup!).occupancy());
  }

  private completeDelivery(v: Vehicle, s: FleetStation): void {
    this.dispatcher.delivered(v.id, this.clock.now());
    v.ordersDone++;
    this.stroke(v, Math.max(0, s.handlingHeightMm - this.params.fork.handlingDeltaMm), false, { k: 'finishStay' });
    this.later('dispatch');
  }

  /** Drop station `input` may take an MU again: the first waiting vehicle (id order) drops. */
  private wakeInput(input: string): void {
    const s = this.dispatcher.station(input);
    for (const v of this.vehicles.values()) {
      if (v.waitingAt === input) { this.tryDrop(v, s); return; }
    }
  }

  private startCharge(v: Vehicle): void {
    this.account(v, 'charge');
    const e = this._epoch;
    const hj = v.hijacks;
    const target = this.params.battery.target;
    this.clock.scheduleAction(this.clock.now() + chargeTimeSec(v.soc, this.params.battery), 'fleet.runner.chargeDone', { v: v.id, e, hj, target });
  }

  private chargeDone(d: { v: string; e: number; hj: number; target: number }): void {
    const v = this.vehicles.get(d.v);
    if (!v || d.e !== this._epoch || d.hj !== v.hijacks) return;
    this.account(v, 'idle');
    v.soc = Math.max(v.soc, d.target);
    v.charges++;
    this.dispatcher.chargeDone(v.id);
    this.finishStay(v);
    this.dispatchAll();
  }

  /**
   * Route length (m) from path `from` to station path `to` (its turn point + stich run).
   * A vehicle standing on the turn piece itself counts as unreachable — the semantics of the
   * former PalletYard route table (its search never returned to the start piece).
   */
  private distanceM(from: string, to: string): number {
    if (from === to) return 0;
    const via = this.site.turnOf.get(to) ?? to;
    const extra = this.site.turnOf.has(to) ? this.site.stichLengthM : 0;
    return (from === via ? Infinity : this.routes.networkM(from, via)) + extra;
  }

  // ── Hold check (plan-634) ─────────────────────────────────────────────────

  /**
   * A hold target handed to a moving vehicle: can it still brake for the END of
   * `destination`? Read-only (movement authority plan at the hand-over instant +
   * the network way); an unbrakeable target is counted — the vehicle passes it
   * and is served on its next visit.
   */
  private checkHold(v: Vehicle, t: AgvTask): void {
    if (this.decel <= 0) return;
    if (this.authority === undefined) this.authority = getDefaultMovementAuthority(this.adapters.kind);
    if (!this.authority) return;
    // The hold target: a forward task stops at its destination's end, a reverse task first at
    // the stub's turn point (the end of its merge piece) — the plan-634 case.
    const destination = t.approach === 'reverse' ? this.site.turnOf.get(t.destination) ?? t.destination : t.destination;
    // A vehicle reversing into a stub takes a new task only after the manoeuvre (from the stub, forward).
    if (this.fleet.get(v.id)?.locate?.(this.locScratch) && this.locScratch.dir === -1) return;
    const loc = this.authority.locate(v.id, this.clock.now());
    if (!loc || loc.v <= 1e-6) return;
    const rest = loc.path.length - loc.s;
    const remaining = loc.path.id === destination ? rest : rest + this.routes.networkM(loc.path.id, destination);
    if (remaining < (loc.v * loc.v) / (2 * this.decel) - 1e-3) this.unbrakeableHolds++;
  }

  // ── Task ownership (SOL #8, S1) ───────────────────────────────────────────

  private onTaskChanged(agvId: string, ch: AgvTaskChange): void {
    if (this.disposed || !ch.effective) return;
    const v = this.vehicles.get(agvId);
    if (!v) return;
    const t = ch.requested;
    if (t) { if (this.isOwn(t)) return; } else if (v.ownClears > 0) { v.ownClears--; return; }
    this.hijacked(v, t);
  }

  /**
   * A foreign task (or clear) took `v`: abort the step — lift stroke, pick dock,
   * pending approach / exit, waits — and settle its job with the dispatcher.
   */
  private hijacked(v: Vehicle, task: AgvTask | null): void {
    const job = v.job;
    const now = this.clock.now();
    v.hijacks++;
    v.taskSeq++;
    v.task = null;
    v.ownClears = 0;
    this.lift.cancel(v.id);
    if (job && job.kind === 'pick' && !job.loaded) {
      // The MU may already be on the fork (taken in the conveyor's release stack, booked one
      // own event later): book it now, so the order fails instead of going back to the pool.
      if (this.handover.carried(v.id) !== null) this.bookPick(v, job.from);
      else this.handover.cancelPick?.(job.from, v.id);
    }
    this.waits.endAllOf(v.id);
    v.approach = null;
    v.exiting = null;
    v.releaseHeld = false;
    this.dockReleases.delete(v.id);
    v.waitingAt = null;
    v.unassigned = null;
    v.unassignedClear = false;
    if (this.waitOwner === v.id) this.waitOwner = null;
    const outcome = job ? this.dispatcher.abandon(v.id, now) : null;
    v.job = null;
    this.account(v, 'drive');
    // A vehicle with a load left on its fork stays out of the dispatch until the next start —
    // an empty-fork job could not take anything (the Problems entry says so).
    v.leg = task || this.handover.carried(v.id) !== null ? 'foreign' : 'idle';
    if (outcome === 'failed') {
      reportProblem({
        id: `${FLEET_TASK_HIJACKED_CODE}:${v.id}`, severity: 'warning', code: FLEET_TASK_HIJACKED_CODE,
        title: `Fleet: ${v.id} was taken by a foreign task while carrying`,
        detail: `A task that is not the fleet's own replaced ${job!.kind} ${job!.kind === 'pick' || job!.kind === 'retrieve' ? job!.from : ''} `
          + `of ${v.id} at sim time ${now.toFixed(1)} s. The order failed; the load stays on the vehicle `
          + `(${this.handover.carried(v.id) ?? 'none'}), which leaves the fleet until the next start.`,
      });
    }
    this.later('dispatch');
  }

  /** A vehicle a foreign task drove is idle again: it belongs to the fleet again. */
  private onVehicleIdle(agvId: string): void {
    if (this.disposed) return;
    const v = this.vehicles.get(agvId);
    if (!v || v.leg !== 'foreign' || this.handover.carried(v.id) !== null) return;
    v.leg = 'idle';
    this.later('dispatch');
  }
}

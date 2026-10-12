// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-movement-authority.ts — trajectory-based MOVING BLOCK for AGVs
 * (plan-558): the vehicle-traffic planner shared by the DES and the
 * continuous kernel.
 *
 * Every vehicle owns ONE versioned plan: a route (path pieces with route
 * offsets; coordinate 0 = start of the path the vehicle stood on at plan time)
 * and a closed-form motion profile (rv-motion-profile, meters/seconds) that
 * always ENDS IN A STOP. `positionAt(simTime)` of that plan is the
 * authoritative position for every traffic query — `traveler.s` is only the
 * bookkeeping copy, synced lazily at the vehicle's own events.
 *
 * Terms (VDA 5050 vocabulary): the plan's stop is the MOVEMENT AUTHORITY
 * ("released base"); the route walk beyond it is the horizon. An AUTHORITY
 * EXTENSION is a re-plan event.
 *
 * SAFETY — a follower F plans against the PLANNED TRAJECTORY of every vehicle
 * U ahead on F's OWN route: U's profile, shifted into F's route coordinates
 * (δ) and back by G = F.front + U.rear + F.gap, is a v²-over-x LIMIT (each
 * constant-acceleration phase is linear in v²) plus a stop authority at U's
 * stop. The envelope start is refined by bisection to the largest value whose
 * plan still passes the exact time-domain check `minSeparation` (no stop-and-
 * go), and every applied plan is verified once more (counter `violations`,
 * must stay 0). Every leader plan change invalidates the dependent followers.
 *
 * RE-PLANS are coalesced: triggers only mark a vehicle dirty; ONE flush per
 * sim instant processes them leaders-first, then by vehicle id (deterministic,
 * never by Map insertion order). At most {@link REPLAN_CAP} re-plans per
 * vehicle and instant — a vehicle hitting the cap gets an immediately SAFE
 * hold plan (stop before the CURRENT rear of its leader; a leader never
 * reverses), never its old plan (review R2-2).
 *
 * ZONES (merge control points) are claimed before the FRONT reaches the
 * entrance — including the body overhang of a service stop at a piece end —
 * and released when the REAR has cleared the exit. Every availability change
 * of the zone registry wakes the waiters through a coalesced flush (R2-4).
 *
 * ROUTING is decided at PLANNING time: the route walk asks `peekNext` (task
 * hop / project router) once per junction and the decision is stored in the
 * plan; re-plans reuse it until the task changes (R2-5). With a project router
 * installed, every piece end of a plan gets a `notify` event at its exact
 * arrival time so `router.onArrive` fires once per arrival, in order.
 *
 * SCANNER FIELDS (optional per vehicle): a planning-time state machine
 * clear → warning → protective against the nearest leader's planned
 * trajectory. Warning caps the speed at max(DockingSpeed, v_leader); the
 * protective field stops the vehicle; exit needs the field length computed
 * with the cap plus a hysteresis, a protective stop restarts 0.5 s after the
 * exit (R2-7). Field events carry the plan versions and are dropped when stale.
 *
 * MOTION STATE for statistics: `stopped` (standing at a traffic stop), `slowed`
 * (driving below the free profile because of a leader envelope, a traffic
 * stop or the warning cap) and `free`; transitions inside a leg are scheduled
 * as exact `stat` events.
 *
 * Event kinds the host dispatches back: `arrival` (plan end at a service stop /
 * dead end), `stop` (plan end elsewhere), `flush`, `extend`, `zoneRelease`,
 * `watchdog`, `notify`, `field`, `stat`. The DES kernel routes them through the
 * Agv `Arrival` / `Replan` hooks; the continuous kernel through the
 * {@link MotionEventClock} the continuous authority owns.
 */

import { Vector3 } from 'three';
import type { RVPath } from './rv-path';
import type { PathTraveler } from './rv-path-traveler';
import type { RVPathNetwork } from './rv-path-network';
import { getDefaultPathNetwork } from './rv-path-network';
import { getDefaultZoneRegistry } from './rv-zone-registry';
import {
  planProfile, positionAt, speedAt, timeAt, stationaryProfile, profileAsLimit, minSeparation, minLimits,
  shiftProfile, clipLimits, earliestGapCrossing as earliestCrossing,
  type LimitPiece, type MotionProfile,
} from './rv-motion-profile';

// ── Public types ──────────────────────────────────────────────────────────

export type StopCause = 'service' | 'deadend' | 'horizon' | 'zone' | 'zonePending' | 'leader' | 'hold' | 'field';
export type MbEventKind =
  | 'arrival' | 'stop' | 'flush' | 'extend' | 'zoneRelease' | 'watchdog' | 'notify' | 'field' | 'stat';
/** Scanner field state of a vehicle (plan-558 R2-7). */
export type FieldState = 'clear' | 'warning' | 'protective';
/** Traffic-related motion state (statistics): free, slowed below the free profile, stopped by traffic. */
export type MotionState = 'free' | 'slowed' | 'stopped';

/** One route piece of a plan: the path and its start in route coordinates (m). */
export interface RouteEntry { path: RVPath; x0: number }

/** One planned movement (immutable once applied, except the bookkeeping flags). */
export interface MbPlan {
  route: RouteEntry[];
  profile: MotionProfile;
  stopCause: StopCause;
  /** A leader trajectory actually shapes this plan (stop or a non-relaxed envelope). */
  leaderBound: boolean;
  /** Route coordinate of the natural end (service / dead end / horizon) — the free reference. */
  freeEnd: number;
  /** Static limits (cruise, curves, docking) without traffic — the free reference profile. */
  staticLimits: LimitPiece[];
  /** Odometer of route coordinate 0 (zone claims are keyed on odometer positions). */
  odo0: number;
  /** The scanner warning cap shapes this plan. */
  capped: boolean;
}

/** Stop causes that are traffic stops (Stopped statistics / Blocked signal). */
export function isTrafficStop(c: StopCause): boolean {
  return c === 'leader' || c === 'zone' || c === 'zonePending' || c === 'horizon' || c === 'field';
}

/** Multi-path arc-length sampler over a plan route (route coordinates) — the DES leg tween target. */
export interface RouteSampler {
  getAbsPosition(m: number, out: Vector3): Vector3;
  getAbsDirection(m: number, out: Vector3): Vector3;
  readonly align: Vector3;
}

/** Vehicle-side callbacks — the authority never imports the behavior. */
export interface MbHost {
  /** Current sim time (s). */
  now(): number;
  /** Time of the next queued event (+∞ when none) — decides inline vs deferred flush. */
  nextEventTime(): number;
  /** Schedule one of this vehicle's events `delay` s from now; returns the event id. */
  schedule(delay: number, kind: MbEventKind, data: Record<string, unknown> | null, tween: unknown | null, priority?: number): number;
  cancel(id: number): void;
  /** Build the leg tween (DES pose sampling); null when the kernel needs none (continuous). */
  legTween(sampler: RouteSampler, fromX: number, toX: number, sAt: (t: number) => number): unknown | null;
  /** End of `path` is a service stop (task destination / dock); `current` = the vehicle's own path. */
  serviceStopAt(path: RVPath, current: boolean): boolean;
  /** Run && phase driving/cruising && not frozen. */
  canMove(): boolean;
  /** A plan was applied — publish Moving / Blocked. */
  onPlanApplied?(moving: boolean, stoppedByTraffic: boolean): void;
  /** The vehicle reached the end of `prev` (arrival hooks / router notification, de-duplicated by the host). */
  onArrivedAt?(prev: RVPath): void;
  /** The vehicle continues from `prev` onto `next` (piece hand-over of the bookkeeping). */
  onHandOver?(prev: RVPath, next: RVPath): void;
  /** Traffic motion state changed (statistics, Slowed signal). */
  onMotionState?(state: MotionState): void;
  /** Scanner field state changed (FieldWarning / FieldProtective signals). */
  onFieldState?(state: FieldState): void;
}

/** Scanner field parameters (meters / seconds). */
export interface ScannerParams {
  reactionTime: number;
  protectiveMargin: number;
  warningMargin: number;
  /** Exit hysteresis (m). */
  hysteresis: number;
  /** Restart delay after the protective field cleared (s). */
  restartDelay: number;
}

/** Vehicle parameters (meters / seconds). */
export interface MbParams {
  vmax: number; a: number; b: number; aLat: number;
  /** Body reach ahead of / behind the root along travel (m), and width (m). */
  front: number; rear: number; width: number;
  /** Front-to-rear standstill gap behind a leader (m). */
  gap: number;
  /** Docking crawl: speed (m/s) over the last `dockDist` (m) before a service stop. */
  dockSpeed: number; dockDist: number;
  /** Scanner fields — null = no scanner. */
  scanner: ScannerParams | null;
}

export interface MbStats {
  replans: number;
  replansChanged: number;
  /** Re-plans skipped because the inputs (leader versions, state) were unchanged. */
  replansSkipped: number;
  maxReplansAtInstant: number;
  /** Same, excluding the t = 0 start-up instant (every vehicle plans once there). */
  maxReplansAtInstantAfterStart: number;
  instantsWithReplans: number;
  infeasible: number;
  keptOld: number;
  forced: number;
  violations: number;
  minMargin: number;
  watchdogFires: number;
  cascadeCapHits: number;
  cascadeCapHitsAfterStart: number;
  safeHolds: number;
  authorityBehind: number;
  bisections: number;
  dependentSkipped: number;
  /** Faster-leader re-plans deferred to the follower's next slowed mark / leg end. */
  softDeferred: number;
  staleLeaderReplans: number;
  fieldEvents: number;
  fieldStale: number;
  /** Wall-clock milliseconds spent inside flush() (re-planning cost). */
  flushMs: number;
  dirtyBy: Record<string, number>;
  events: Record<string, number>;
}

/** One entry of the optional event trace (determinism checks). */
export interface MbTraceEntry { t: number; kind: string; id: string }

// ── Constants ─────────────────────────────────────────────────────────────

/** Route walk horizon (m) — the unobserved horizon end is always a stop. */
const HORIZON_M = 30;
/** Max route pieces per walk (pathological graphs). */
const MAX_ROUTE_PIECES = 64;
/** Stop this far (m) before an unconfirmed horizon end / zone entrance. */
const STOP_MARGIN = 0.05;
/** A traffic stop without progress for this long (s) fires the watchdog (counted; must stay 0). */
const WATCHDOG_SEC = 60;
/** Re-plans per vehicle and sim instant before the safe hold plan takes over. */
const DEFAULT_REPLAN_CAP = 4;
/** Zone claim window beyond the braking distance: vmax · this (s) + {@link CLAIM_MARGIN_M}. */
const CLAIM_LEAD_SEC = 1.0;
const CLAIM_MARGIN_M = 0.5;
/** Rear clearance margin (m) before a zone counts as left. */
const REAR_CLEAR_M = 0.01;
/** Bisection resolution (m) of the leader envelope start. */
const BISECT_TOL_M = 5e-3;
const BISECT_MAX = 12;
/** Lane length (m) checked behind a branch point for the leader clearance. */
const CLEARANCE_LANE_M = 6;
const CLEARANCE_STEP_M = 0.05;
/** Speed-squared tolerance (m²/s²) of the slowed-vs-free comparison. */
const SLOWED_TOL_V2 = 1e-4;
const EPS = 1e-7;

function newStats(): MbStats {
  return {
    replans: 0, replansChanged: 0, replansSkipped: 0, maxReplansAtInstant: 0, maxReplansAtInstantAfterStart: 0,
    instantsWithReplans: 0, infeasible: 0, keptOld: 0, forced: 0, violations: 0, minMargin: Infinity,
    watchdogFires: 0, cascadeCapHits: 0, cascadeCapHitsAfterStart: 0, safeHolds: 0, authorityBehind: 0,
    bisections: 0, dependentSkipped: 0, softDeferred: 0, staleLeaderReplans: 0, fieldEvents: 0, fieldStale: 0,
    flushMs: 0, dirtyBy: {}, events: {},
  };
}

// ── Internal state ────────────────────────────────────────────────────────

interface LeaderRef {
  u: Vehicle;
  /** δ: u-route x → my-route x. */
  shift: number;
  /** Envelope domain in u's route coords. */
  domainStart: number;
  /** u coords where u is clear of my route (∞ = whole plan). */
  domainEnd: number;
  /** u's projected root now, in my coords. */
  xNow: number;
  G: number;
  /** u already left my route (its rear may still sweep my lane). */
  diverged: boolean;
}

interface MotionMark { t: number; state: MotionState }

/** Cached location of a vehicle on its plan (see `MovementAuthority.loc`). */
interface LocCache { t: number; plan: MbPlan | null; cur: number; path: RVPath; s: number; x: number; v: number; idx: number }

const NO_LEADERS: readonly LeaderRef[] = [];

interface Vehicle {
  id: string;
  traveler: PathTraveler;
  host: MbHost;
  p: MbParams;
  plan: MbPlan;
  curIdx: number;
  version: number;
  usedLeaders: Map<string, number>;
  dirty: boolean;
  replansAtInstant: number;
  legEvent: number;
  extendEvent: number;
  watchdogEvent: number;
  fieldEvent: number;
  statEvent: number;
  notifyEvents: number[];
  releaseEvents: Map<string, number>;
  /** Held zone → odometer of the end of the run it was claimed for (∞ = not routed yet). */
  held: Map<string, number>;
  prevPathId: string | null;
  /** False after a task change: routing beyond the current piece is re-decided. */
  routeDecided: boolean;
  frozen: boolean;
  field: FieldState;
  fieldCap: number;
  fieldRestartAt: number;
  /** Nearest leader of the current plan (scanner) — null = none. */
  fieldLeader: LeaderRef | null;
  motion: MotionState;
  motionMarks: MotionMark[];
  motionIdx: number;
  /** Last time the leg tween sampled this vehicle (render clock) — overlay speed. */
  renderT: number;
  /** Sim time of the last executed extend event (no second extend at the same instant). */
  lastExtendT: number;
  /** Not planned here: an obstacle that moves on its own (legacy step mode). */
  external: boolean;
  /** A leader got only faster since this plan — re-plan at the next slowed mark / leg end. */
  softStale: boolean;
  /** Fire time of the pending stat event. */
  statEventT: number;
  locCache: LocCache;
  /** Fire time of each pending zone release event. */
  releaseTimes: Map<string, number>;
}

/** Ordering key for the continuous clock heap. */
interface ClockEvent { id: number; time: number; prio: number; seq: number; fn: () => void; cancelled: boolean }

/**
 * Minimal deterministic event clock for the CONTINUOUS kernel: the same
 * ordering contract as the DES queue (time, higher priority first, then FIFO)
 * so both kernels execute the authority's events identically. Events run at
 * their EXACT time while the fixed tick advances the clock (`advanceTo`) — a
 * tick that spans several path ends or profile breakpoints processes each at
 * its own time (review finding 7).
 */
export class MotionEventClock {
  private _now = 0;
  private heap: ClockEvent[] = [];
  private readonly byId = new Map<number, ClockEvent>();
  private nextId = 1;
  private seq = 0;

  get now(): number { return this._now; }

  get nextEventTime(): number {
    this.dropCancelledTop();
    return this.heap.length > 0 ? this.heap[0].time : Number.POSITIVE_INFINITY;
  }

  schedule(time: number, prio: number, fn: () => void): number {
    const ev: ClockEvent = { id: this.nextId++, time: Math.max(time, this._now), prio, seq: this.seq++, fn, cancelled: false };
    this.byId.set(ev.id, ev);
    this.push(ev);
    return ev.id;
  }

  cancel(id: number): void {
    const ev = this.byId.get(id);
    if (!ev) return;
    ev.cancelled = true;
    this.byId.delete(id);
  }

  /** Run every event due up to `t` in order (each at its own time), then stand at `t`. */
  advanceTo(t: number): void {
    for (;;) {
      this.dropCancelledTop();
      const top = this.heap[0];
      if (!top || top.time > t) break;
      this.pop();
      this.byId.delete(top.id);
      this._now = top.time;
      top.fn();
    }
    if (t > this._now) this._now = t;
  }

  /** Drop every event and restart at time 0. */
  reset(): void {
    this.heap = [];
    this.byId.clear();
    this._now = 0;
  }

  private before(a: ClockEvent, b: ClockEvent): boolean {
    if (a.time !== b.time) return a.time < b.time;
    if (a.prio !== b.prio) return a.prio > b.prio;
    return a.seq < b.seq;
  }

  private dropCancelledTop(): void {
    while (this.heap.length > 0 && this.heap[0].cancelled) this.pop();
  }

  private push(ev: ClockEvent): void {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(h[i], h[parent])) break;
      [h[i], h[parent]] = [h[parent], h[i]];
      i = parent;
    }
  }

  private pop(): void {
    const h = this.heap;
    const last = h.pop()!;
    if (h.length === 0) return;
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && this.before(h[l], h[m])) m = l;
      if (r < h.length && this.before(h[r], h[m])) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }
}

// ── The authority ─────────────────────────────────────────────────────────

/** Unzoned merge found by {@link findUnzonedMerges}. */
export interface UnzonedMerge { pathId: string; incoming: string[] }

export class MovementAuthority {
  private readonly vehicles = new Map<string, Vehicle>();
  private order: Vehicle[] = [];
  private flushing = false;
  private callbackDepth = 0;
  private flushEventTime = Number.NaN;
  private instant = -1;
  private replansThisInstant = 0;
  private lastNow = 0;
  /** Branch clearance cache: geometry pair → entries per body-reach pair (R2-6). */
  private readonly clearance = new Map<number, { lo: number; hi: number; c: number }[]>();
  /** zone → vehicle id → wait start (NaN = passive waiter: woken, no head priority). */
  private readonly waiters = new Map<string, Map<string, number>>();
  private prevWaits: Map<string, number> | null = null;
  private listenersInstalled = false;
  private network: RVPathNetwork | null = null;
  stats: MbStats = newStats();
  /** Optional event trace (tests / determinism checks); null = off. */
  trace: MbTraceEntry[] | null = null;
  /** Re-plans per vehicle and instant before the safe hold (tests may lower it). */
  replanCap = DEFAULT_REPLAN_CAP;
  /** The continuous kernel's clock (only used by the continuous authority). */
  readonly clock = new MotionEventClock();

  constructor(readonly kind: 'des' | 'continuous') {}

  /** Drop every vehicle, waiter and statistic (model switch / test reset). */
  clear(): void {
    this.vehicles.clear();
    this.order = [];
    this.flushing = false;
    this.callbackDepth = 0;
    this.flushEventTime = Number.NaN;
    this.instant = -1;
    this.replansThisInstant = 0;
    this.lastNow = 0;
    this.clearance.clear();
    this.waiters.clear();
    this.stats = newStats();
    this.trace = null;
    this.replanCap = DEFAULT_REPLAN_CAP;
    this.clock.reset();
  }

  has(id: string): boolean { return this.vehicles.has(id); }

  /** Number of registered vehicles. */
  get size(): number { return this.vehicles.size; }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Register (or re-register) a vehicle standing at its traveler position. A
   * re-registration under the same id replaces the old entry (runner restart
   * re-runs setup); a host clock that went BACKWARDS starts a new epoch — all
   * entries of the previous run are dropped (reset / model switch: their events
   * died with the old queue, they must not stay obstacles).
   */
  register(id: string, traveler: PathTraveler, host: MbHost, p: MbParams): void {
    this.installListeners();
    const now = host.now();
    if (now < this.lastNow - 1e-9) this.newEpoch();
    this.lastNow = Math.max(this.lastNow, now);
    const stale = this.vehicles.get(id);
    if (stale) {
      // Re-setup under the same id: the old entry's event ids may already be
      // reused by a restarted queue — forget them, never cancel them.
      this.forgetEventIds(stale);
      this.vehicles.delete(id);
      for (const w of this.waiters.values()) w.delete(id);
    }
    const path = traveler.path!;
    const v: Vehicle = {
      id, traveler, host, p,
      plan: {
        route: [{ path, x0: 0 }], profile: stationaryProfile(now, traveler.s), stopCause: 'hold',
        leaderBound: false, freeEnd: traveler.s, staticLimits: [], capped: false, odo0: 0,
      },
      curIdx: 0, version: 0, usedLeaders: new Map(), dirty: true, replansAtInstant: 0,
      legEvent: -1, extendEvent: -1, watchdogEvent: -1, fieldEvent: -1, statEvent: -1, notifyEvents: [],
      releaseEvents: new Map(), held: new Map(), prevPathId: null, routeDecided: true, frozen: false,
      field: 'clear', fieldCap: Infinity, fieldRestartAt: -1, fieldLeader: null,
      motion: 'free', motionMarks: [], motionIdx: 0, renderT: now, lastExtendT: -Infinity, external: false, softStale: false, statEventT: -1,
      locCache: { t: Number.NaN, plan: null, cur: -1, path, s: 0, x: 0, v: 0, idx: 0 }, releaseTimes: new Map(),
    };
    // A zone the vehicle starts in is held up to the end of its current piece.
    if (path.zoneId && getDefaultZoneRegistry().isHolder(path.zoneId, id)) v.held.set(path.zoneId, path.length);
    this.vehicles.set(id, v);
    this.rebuildOrder();
  }

  /**
   * Remove a vehicle (reset / despawn / teardown): cancel its events, drop it
   * from every waiter list and wake every follower that planned against it
   * (they re-plan without the obstacle). Zone claims are the caller's
   * (`ZoneRegistry.releaseAll`). `wake = false` skips the follower flush.
   */
  unregister(id: string, wake = true): void {
    const v = this.vehicles.get(id);
    if (!v) return;
    this.cancelAllEvents(v);
    for (const w of this.waiters.values()) w.delete(id);
    this.vehicles.delete(id);
    this.rebuildOrder();
    if (!wake) return;
    let host: MbHost | null = null;
    for (const u of this.order) {
      if (!u.usedLeaders.has(id)) continue;
      u.usedLeaders.delete(id);
      this.dirty(u, 'leader-removed');
      host ??= u.host;
    }
    if (host) this.requestFlush(host);
    if (this.kind === 'continuous' && this.vehicles.size === 0) this.clock.reset();
  }

  /**
   * Freeze (DES component failure): the vehicle brakes to a stop with its own
   * deceleration from NOW on and stays until {@link resume}; its followers
   * re-plan against that trajectory. The caller has already cancelled the
   * vehicle's queued events (the adapter's freeze) — the ids are dropped here.
   */
  freeze(id: string): void {
    const v = this.vehicles.get(id);
    if (!v || v.frozen) return;
    v.frozen = true;
    this.forgetEventIds(v);
    this.dirty(v, 'freeze');
    this.requestFlush(v.host);
  }

  /** Resume after a freeze: the vehicle re-plans from its standstill. */
  resume(id: string): void {
    const v = this.vehicles.get(id);
    if (!v || !v.frozen) return;
    v.frozen = false;
    this.forgetEventIds(v);
    this.dirty(v, 'resume');
    this.requestFlush(v.host);
  }

  isFrozen(id: string): boolean { return this.vehicles.get(id)?.frozen ?? false; }

  /**
   * Register a vehicle that is NOT planned here but moves on its own (the
   * continuous legacy step mode, `UseAcceleration = false`) as an OBSTACLE:
   * its plan is a standstill at its current position, refreshed by
   * {@link updateExternal} whenever it moved. Planned vehicles behind it stop
   * before its current rear and re-plan when it advances (it never reverses),
   * so mixed fleets stay safe.
   */
  registerExternal(id: string, traveler: PathTraveler, p: MbParams, clockNow: () => number): void {
    const host: MbHost = {
      now: clockNow,
      nextEventTime: () => Number.POSITIVE_INFINITY,
      schedule: () => -1,
      cancel: () => {},
      legTween: () => null,
      serviceStopAt: () => false,
      canMove: () => false,
    };
    this.register(id, traveler, host, p);
    const v = this.vehicles.get(id)!;
    v.external = true;
    v.dirty = false;
  }

  /** Refresh an external obstacle's standstill plan after it moved (followers re-plan). */
  updateExternal(id: string): void {
    const v = this.vehicles.get(id);
    if (!v || !v.external) return;
    const t = v.traveler;
    const r0 = v.plan.route[0];
    if (t.path === r0.path && Math.abs(t.s - v.plan.profile.xStop) < 1e-9) return;
    const now = v.host.now();
    v.plan = {
      route: [{ path: t.path!, x0: 0 }], profile: stationaryProfile(now, t.s), stopCause: 'hold', leaderBound: false,
      freeEnd: t.s, staticLimits: [], capped: false, odo0: 0,
    };
    v.curIdx = 0;
    v.version++;
    let host: MbHost | null = null;
    for (const u of this.order) {
      if (u === v || !u.usedLeaders.has(id)) continue;
      this.dirty(u, 'external-moved');
      host ??= u.host;
    }
    if (host) this.requestFlush(host);
  }

  /** Task change: routing decisions beyond the current piece are re-made at the next plan. */
  invalidateRoute(id: string): void {
    const v = this.vehicles.get(id);
    if (v) v.routeDecided = false;
  }

  private newEpoch(): void {
    this.vehicles.clear();
    this.order = [];
    this.waiters.clear();
    this.flushing = false;
    this.callbackDepth = 0;
    this.flushEventTime = Number.NaN;
    this.instant = -1;
    this.replansThisInstant = 0;
    this.lastNow = 0;
    this.stats = newStats();
  }

  private rebuildOrder(): void {
    this.order = [...this.vehicles.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  }

  private installListeners(): void {
    if (this.listenersInstalled) return;
    this.listenersInstalled = true;
    getDefaultZoneRegistry().onAvailabilityChanged((z) => this.onZoneAvailable(z));
    this.network = getDefaultPathNetwork();
    this.network.onPathChanged((pathId) => this.onPathChanged(pathId));
  }

  // ── Queries ───────────────────────────────────────────────────────────

  /** Record one dispatched event (statistics + optional trace). */
  recordEvent(kind: string, id: string, t: number): void {
    this.stats.events[kind] = (this.stats.events[kind] ?? 0) + 1;
    if (this.trace) this.trace.push({ t, kind, id });
  }

  /** Authoritative location at sim time t (the route piece holding the root). */
  locate(id: string, t: number): { path: RVPath; s: number; x: number; v: number } | null {
    const v = this.vehicles.get(id);
    if (!v) return null;
    return this.loc(v, t);
  }

  /** Speed (m/s) of the vehicle's plan at sim time t (0 when unknown). */
  speedOf(id: string, t: number): number {
    const v = this.vehicles.get(id);
    return v ? speedAt(v.plan.profile, t) : 0;
  }

  /** Speed (m/s) at the last time the leg tween sampled the vehicle (render clock). */
  renderSpeedOf(id: string): number {
    const v = this.vehicles.get(id);
    return v ? speedAt(v.plan.profile, v.renderT) : 0;
  }

  /** Stop cause of the current plan. */
  stopCauseOf(id: string): StopCause | null {
    return this.vehicles.get(id)?.plan.stopCause ?? null;
  }

  /** Current scanner field state. */
  fieldStateOf(id: string): FieldState {
    return this.vehicles.get(id)?.field ?? 'clear';
  }

  /** Current traffic motion state (statistics). */
  motionStateOf(id: string): MotionState {
    return this.vehicles.get(id)?.motion ?? 'free';
  }

  /** Protective / warning field length (m) of a vehicle at speed v (m/s); null without scanner. */
  fieldLengths(id: string, speed: number): { protective: number; warning: number } | null {
    const v = this.vehicles.get(id);
    const sc = v?.p.scanner;
    if (!v || !sc) return null;
    const protective = fieldLength(speed, sc.reactionTime, v.p.b, sc.protectiveMargin);
    return { protective, warning: protective + sc.warningMargin };
  }

  /** Protective field length (m) at speed v (0 without scanner) — allocation-free. */
  protectiveFieldLength(id: string, speed: number): number {
    const v = this.vehicles.get(id);
    const sc = v?.p.scanner;
    return v && sc ? fieldLength(speed, sc.reactionTime, v.p.b, sc.protectiveMargin) : 0;
  }

  /** Body reach (m) ahead of the root and width (m) — overlay geometry. */
  bodyOf(id: string): { front: number; rear: number; width: number } | null {
    const v = this.vehicles.get(id);
    return v ? { front: v.p.front, rear: v.p.rear, width: v.p.width } : null;
  }

  /** The current plan (read-only diagnostics). */
  planOf(id: string): Readonly<MbPlan> | null {
    return this.vehicles.get(id)?.plan ?? null;
  }

  /** Plan version (bumps on every physically different plan). */
  versionOf(id: string): number {
    return this.vehicles.get(id)?.version ?? -1;
  }

  /**
   * Location on the plan at time t — cached per vehicle while (t, plan,
   * current piece) are unchanged: one flush evaluates every vehicle's position
   * many times at the same instant. The returned object is shared: read only.
   */
  private loc(v: Vehicle, t: number): Readonly<LocCache> {
    const c = v.locCache;
    if (c.t === t && c.plan === v.plan && c.cur === v.curIdx) return c;
    const x = positionAt(v.plan.profile, t);
    const idx = this.idxAt(v, x);
    const e = v.plan.route[idx];
    c.t = t; c.plan = v.plan; c.cur = v.curIdx;
    c.path = e.path; c.x = x; c.idx = idx;
    c.s = Math.min(Math.max(0, x - e.x0), e.path.length);
    c.v = speedAt(v.plan.profile, t);
    return c;
  }

  /** Route entry holding route coordinate x (a point exactly AT a piece end stays on it). */
  private idxAt(v: Vehicle, x: number): number {
    const r = v.plan.route;
    let i = v.curIdx;
    while (i + 1 < r.length && x > r[i + 1].x0 + 1e-9) i++;
    return i;
  }

  /**
   * Hand the traveler over every piece passed by `now` (or up to `forceIdx`,
   * a notify event at a piece end) and refresh its bookkeeping `s`.
   */
  private sync(v: Vehicle, now: number, forceIdx = -1): void {
    const r = v.plan.route;
    const x = positionAt(v.plan.profile, now);
    const idx = Math.max(this.idxAt(v, x), Math.min(forceIdx, r.length - 1));
    for (let k = v.curIdx + 1; k <= idx; k++) {
      const prev = r[k - 1].path;
      if (v.host.onArrivedAt) {
        this.callbackDepth++;
        try { v.host.onArrivedAt(prev); } finally { this.callbackDepth--; }
      }
      if (v.plan.route !== r) return; // re-planned from inside the callback
      // A task change from inside the arrival callback re-decides the
      // junction the vehicle stands AT: no hand-over, it re-plans from the end
      // of `prev` (the deferred flush follows).
      if (!v.routeDecided && x <= r[k].x0 + 1e-9) {
        v.curIdx = k - 1;
        v.traveler.s = prev.length;
        return;
      }
      v.prevPathId = prev.id;
      v.curIdx = k;
      v.host.onHandOver?.(prev, r[k].path);
    }
    v.curIdx = idx;
    v.traveler.s = Math.min(Math.max(0, x - r[idx].x0), r[idx].path.length);
  }

  /** Sync the traveler bookkeeping to `now` (piece hand-overs included). */
  syncTo(id: string, now: number): void {
    const v = this.vehicles.get(id);
    if (v) this.sync(v, now);
  }

  // ── Triggers ──────────────────────────────────────────────────────────

  markDirty(id: string, why = 'host'): void {
    const v = this.vehicles.get(id);
    if (v) this.dirty(v, why);
  }

  private dirty(v: Vehicle, why: string): void {
    if (!v.dirty) this.stats.dirtyBy[why] = (this.stats.dirtyBy[why] ?? 0) + 1;
    v.dirty = true;
  }

  /**
   * The vehicle's leg ended (plan end reached: arrival or traffic stop). Syncs
   * the bookkeeping and checks the leader versions the plan was made against
   * (R2-2): a stale leader that was skipped as "dominating" is re-checked now.
   */
  onLegEnd(id: string): void {
    const v = this.vehicles.get(id);
    if (!v) return;
    v.legEvent = -1;
    const now = v.host.now();
    this.sync(v, now);
    this.advanceMotion(v, now);
    if (v.softStale) { this.dirty(v, 'soft-recheck'); return; }
    for (const [lid, ver] of v.usedLeaders) {
      if (this.vehicles.get(lid)?.version !== ver) {
        this.stats.staleLeaderReplans++;
        this.dirty(v, 'stale-leader');
        break;
      }
    }
  }

  /**
   * Dispatch one authority event of vehicle `id` (everything except the leg
   * end itself): flush / extend / watchdog / zoneRelease / notify / field /
   * stat. The caller requests the flush afterwards.
   */
  onEvent(id: string, kind: MbEventKind, data: Record<string, unknown> | null): void {
    const v = this.vehicles.get(id);
    if (kind === 'flush') {
      this.flushEventTime = Number.NaN;
      if (v) this.flush(v.host.now());
      return;
    }
    if (!v) return;
    const now = v.host.now();
    switch (kind) {
      case 'extend':
        v.extendEvent = -1;
        v.lastExtendT = now;
        this.dirty(v, 'extend');
        break;
      case 'watchdog':
        v.watchdogEvent = -1;
        this.stats.watchdogFires++;
        this.dirty(v, 'watchdog');
        break;
      case 'zoneRelease': {
        const zone = typeof data?.zone === 'string' ? data.zone : '';
        v.releaseEvents.delete(zone);
        v.releaseTimes.delete(zone);
        if (v.held.has(zone)) this.releaseHeld(v, zone);
        break;
      }
      case 'notify': {
        const ver = Number(data?.ver ?? -1);
        const idx = Number(data?.idx ?? -1);
        const i = v.notifyEvents.indexOf(Number(data?.ev ?? -1));
        if (i >= 0) v.notifyEvents.splice(i, 1);
        if (ver === v.version && idx > v.curIdx) this.sync(v, now, idx);
        break;
      }
      case 'field':
        v.fieldEvent = -1;
        this.onFieldEvent(v, data, now);
        break;
      case 'stat':
        v.statEvent = -1;
        if (v.softStale) this.dirty(v, 'soft-recheck');
        this.advanceMotion(v, now);
        break;
      default:
        break;
    }
  }

  /** Always defer the flush to an event at this instant (start: all vehicles register first). */
  requestFlushDeferred(host: MbHost): void {
    const now = host.now();
    if (this.flushEventTime === now) return;
    this.flushEventTime = now;
    host.schedule(0, 'flush', null, null, -1);
  }

  /**
   * Run the flush now — synchronously when no other event shares this
   * instant (and no host callback is on the stack), otherwise as one deferred
   * event (priority −1: after every same-time event).
   */
  requestFlush(host: MbHost): void {
    if (this.flushing) return;
    let any = false;
    for (const v of this.order) if (v.dirty) { any = true; break; }
    if (!any) return;
    const now = host.now();
    if (this.callbackDepth === 0 && host.nextEventTime() > now + 1e-12) {
      this.flush(now);
      return;
    }
    if (this.flushEventTime === now) return;
    this.flushEventTime = now;
    host.schedule(0, 'flush', null, null, -1);
  }

  private onZoneAvailable(zone: string): void {
    const w = this.waiters.get(zone);
    if (!w || w.size === 0) return;
    // Wake the ACTIVE waiters in FIFO order (wait start, then id), as many as
    // the zone has free places; passive waiters (queued behind a leader that
    // claims first) follow their leader as dependents. Without an active
    // waiter every waiter is woken. The coalesced flush runs on the first
    // woken vehicle's host (R2-4) — a release by a foreign holder (script,
    // PLC, capacity change) wakes a quiet fleet at the release time.
    const zones = getDefaultZoneRegistry();
    let free = zones.capacityOf(zone) - zones.holderCount(zone);
    if (free <= 0) return;
    const active: Vehicle[] = [];
    for (const v of this.order) {
      const t = w.get(v.id);
      if (t !== undefined && !Number.isNaN(t)) active.push(v);
    }
    active.sort((a, b) => w.get(a.id)! - w.get(b.id)! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let host: MbHost | null = null;
    if (active.length > 0) {
      for (const v of active) {
        if (free-- <= 0) break;
        this.dirty(v, 'zoneWake');
        host ??= v.host;
      }
    } else {
      for (const v of this.order) {
        if (!w.has(v.id)) continue;
        this.dirty(v, 'zoneWake');
        host ??= v.host;
      }
    }
    if (host) this.requestFlush(host);
  }

  private onPathChanged(pathId: string): void {
    // Live geometry edit: every plan routed over the path re-plans on the
    // fresh RVPath object (the traveler was re-projected by the network).
    let host: MbHost | null = null;
    for (const v of this.order) {
      if (!v.plan.route.some((e) => e.path.id === pathId)) continue;
      v.routeDecided = false;
      this.dirty(v, 'path-edit');
      host ??= v.host;
    }
    if (host) this.requestFlush(host);
  }

  // ── Flush ─────────────────────────────────────────────────────────────

  /** Process every dirty vehicle at sim time `now` (leaders first, then id). */
  flush(now: number): void {
    if (this.flushing) return;
    this.flushing = true;
    this.lastNow = Math.max(this.lastNow, now);
    const w0 = performance.now();
    try {
      if (now !== this.instant) {
        this.instant = now;
        this.replansThisInstant = 0;
        for (const v of this.order) v.replansAtInstant = 0;
      }
      for (;;) {
        // Leaders first: a dirty vehicle none of whose used leaders is dirty;
        // cycles (rings) fall back to the lowest id. Deterministic either way.
        let pick: Vehicle | null = null;
        let fallback: Vehicle | null = null;
        for (const v of this.order) {
          if (!v.dirty) continue;
          if (!fallback) fallback = v;
          let blocked = false;
          for (const lid of v.usedLeaders.keys()) {
            const u = this.vehicles.get(lid);
            if (u && u.dirty && u !== v) { blocked = true; break; }
          }
          if (!blocked) { pick = v; break; }
        }
        const v = pick ?? fallback;
        if (!v) break;
        v.dirty = false;
        if (v.external) continue; // moves on its own — never planned here
        let changed: 0 | 1 | 2;
        if (v.replansAtInstant >= this.replanCap) {
          this.stats.cascadeCapHits++;
          if (now > 0) this.stats.cascadeCapHitsAfterStart++;
          changed = this.applySafeHold(v, now);
        } else {
          v.replansAtInstant++;
          this.replansThisInstant++;
          if (this.replansThisInstant === 1) this.stats.instantsWithReplans++;
          if (this.replansThisInstant > this.stats.maxReplansAtInstant) {
            this.stats.maxReplansAtInstant = this.replansThisInstant;
          }
          if (now > 0 && this.replansThisInstant > this.stats.maxReplansAtInstantAfterStart) {
            this.stats.maxReplansAtInstantAfterStart = this.replansThisInstant;
          }
          changed = this.replan(v, now);
        }
        if (changed !== 0) {
          // Non-dominating change → every dependent MUST re-plan (safety).
          // Dominating (only faster, same route) → only followers whose plan
          // the leader actually shapes; the rest stay safe as they are.
          for (const u of this.order) {
            if (u === v || !u.usedLeaders.has(v.id)) continue;
            if (changed === 2) this.dirty(u, 'dependent-hard');
            else if (!u.plan.leaderBound) this.stats.dependentSkipped++;
            else if (u.motion !== 'free' || u.plan.profile.tEnd <= now + 1e-9) this.dirty(u, 'dependent-soft');
            else {
              // Only faster: u's plan stays SAFE — it re-plans lazily when it
              // would start to feel the leader (its next slowed mark / leg
              // end), not in a cascade down the queue right now.
              u.softStale = true;
              this.stats.softDeferred++;
            }
          }
        }
      }
    } finally {
      this.flushing = false;
      this.stats.flushMs += performance.now() - w0;
    }
  }

  // ── Planning ──────────────────────────────────────────────────────────

  /** Re-plan one vehicle. 0 = same trajectory (no version bump), 1 = dominating change, 2 = other change. */
  private replan(v: Vehicle, now: number): 0 | 1 | 2 {
    this.stats.replans++;
    v.softStale = false;
    this.sync(v, now);
    const cur = this.loc(v, now);
    const path = v.traveler.path!;
    const s = path === cur.path ? cur.s : v.traveler.s;
    const speed = cur.v;
    const p = v.p;

    const canMove = !v.frozen && v.host.canMove();
    if (!canMove && speed <= 1e-9 && v.plan.profile.tEnd <= now) {
      // Already standing at the end of the plan — a hold changes nothing.
      v.usedLeaders.clear();
      v.fieldLeader = null;
      const c = v.plan.stopCause;
      if (c !== 'service' && c !== 'deadend' && c !== 'hold') {
        v.plan.stopCause = 'hold';
        this.publishPlan(v, now);
      }
      if (v.watchdogEvent >= 0) { v.host.cancel(v.watchdogEvent); v.watchdogEvent = -1; }
      if (v.fieldEvent >= 0) { v.host.cancel(v.fieldEvent); v.fieldEvent = -1; }
      this.scheduleReleases(v, now);
      this.computeMotion(v, now);
      return 0;
    }
    v.usedLeaders.clear();
    v.fieldLeader = null;
    let plan: MbPlan;
    if (!canMove) {
      // Run off / frozen / servicing: brake to a stop with the own deceleration
      // — but never earlier than the vehicles queued behind can absorb (and
      // never beyond the authority already granted).
      const off = v.plan.route[v.curIdx]?.path === path ? v.plan.route[v.curIdx].x0 : 0;
      const granted = Math.max(s, v.plan.profile.xStop - off);
      const xs = Math.max(s + (speed * speed) / (2 * p.b), Math.min(this.chainNeed(v, now), granted));
      const lim: LimitPiece[] = [{ x0: s, x1: xs + 1, c0: Math.max(p.vmax, speed) ** 2, c1: 0 }];
      plan = {
        route: this.reanchoredRoute(v, path), stopCause: 'hold', leaderBound: false, freeEnd: xs,
        staticLimits: lim, capped: false, odo0: this.odoAt(v, now) - s,
        profile: speed > 1e-6 ? planProfile(now, s, speed, lim, p.a, p.b, xs) : stationaryProfile(now, s),
      };
    } else {
      plan = this.buildPlan(v, path, s, speed, now);
    }
    return this.adopt(v, plan, now);
  }

  /**
   * Compare a new plan with the current one and apply it: the SAME physical
   * trajectory keeps the old plan object (events and tween closures stay
   * valid, no version bump — so no follower cascade).
   */
  private adopt(v: Vehicle, plan: MbPlan, now: number): 0 | 1 | 2 {
    const old = v.plan;
    const oldOff = old.route[v.curIdx].x0;
    let comparable = true;
    let sameRoute = true;
    let diverge = -1; // first new-route index that differs from the old route
    for (let i = 0; i < plan.route.length && v.curIdx + i < old.route.length; i++) {
      if (plan.route[i].path !== old.route[v.curIdx + i].path) {
        sameRoute = false;
        diverge = i;
        if (old.route[v.curIdx + i].x0 - oldOff < old.profile.xStop - oldOff - EPS) comparable = false;
        break;
      }
    }
    let same = false;
    let dominating = false;
    if (comparable) {
      const up = minSeparation(old.profile, plan.profile, oldOff, now);
      const down = minSeparation(plan.profile, old.profile, -oldOff, now);
      same = up >= -1e-6 && down >= -1e-6;
      // Only faster everywhere AND the same route: no follower can lose margin.
      dominating = sameRoute && up >= -1e-6;
    }
    if (same) {
      old.leaderBound = plan.leaderBound;
      old.capped = plan.capped;
      if (old.stopCause !== plan.stopCause) {
        old.stopCause = plan.stopCause;
        const c = plan.stopCause;
        if (!isTrafficStop(c) && v.watchdogEvent >= 0) {
          v.host.cancel(v.watchdogEvent);
          v.watchdogEvent = -1;
        }
        this.publishPlan(v, now);
      }
      // Routing decisions beyond the stop that changed (task change) or grew
      // (horizon walk) are adopted for the routing record — the trajectory
      // itself is unchanged, so no version bump.
      const from = diverge >= 0 ? diverge : old.route.length - v.curIdx;
      if (from < plan.route.length || diverge >= 0) {
        old.route.length = v.curIdx + from;
        for (let i = from; i < plan.route.length; i++) old.route.push({ path: plan.route[i].path, x0: plan.route[i].x0 + oldOff });
      }
      this.scheduleReleases(v, now);
      this.ensureEvents(v, now);
      this.scheduleField(v, now);
      this.computeMotion(v, now);
      return 0;
    }
    this.stats.replansChanged++;
    v.plan = plan;
    v.curIdx = 0;
    v.version++;
    v.routeDecided = true;
    this.applyEvents(v, now);
    return dominating ? 1 : 2;
  }

  /** The current plan's route re-anchored at the current piece (coordinate 0 = its start). */
  private reanchoredRoute(v: Vehicle, path: RVPath): RouteEntry[] {
    const r = v.plan.route;
    if (r[v.curIdx]?.path !== path) return [{ path, x0: 0 }];
    const off = r[v.curIdx].x0;
    const out: RouteEntry[] = [];
    for (let i = v.curIdx; i < r.length; i++) out.push({ path: r[i].path, x0: r[i].x0 - off });
    return out;
  }

  /**
   * R2-2: the cap was hit — an immediately SAFE plan, never the old one: stop
   * no later than the current plan's authority AND before the CURRENT rear of
   * every leader on the route minus the gap (a leader never reverses, so that
   * point stays clear for all future time). Braking uses the own deceleration;
   * an unavoidable overrun is an emergency stop (counted `forced`).
   */
  private applySafeHold(v: Vehicle, now: number): 0 | 1 | 2 {
    this.stats.safeHolds++;
    this.sync(v, now);
    const cur = this.loc(v, now);
    const path = v.traveler.path!;
    const s = path === cur.path ? cur.s : v.traveler.s;
    const speed = cur.v;
    const p = v.p;
    const route = this.reanchoredRoute(v, path);
    const off = v.plan.route[v.curIdx]?.path === path ? v.plan.route[v.curIdx].x0 : 0;
    let stopX = Math.max(s, v.plan.profile.xStop - off);
    let cause: StopCause = v.plan.stopCause;
    if (v.frozen || !v.host.canMove()) {
      // A vehicle that may not move brakes now (queue behind permitting).
      const xs = Math.max(s + (speed * speed) / (2 * p.b), Math.min(this.chainNeed(v, now), stopX));
      if (xs < stopX) { stopX = xs; cause = 'hold'; }
    }
    v.usedLeaders.clear();
    v.fieldLeader = null;
    for (const L of this.findLeaders(v, route, s, now)) {
      v.usedLeaders.set(L.u.id, L.u.version);
      const x = L.xNow - L.G;
      if (x < stopX) { stopX = Math.max(s, x); cause = 'leader'; }
    }
    const lim: LimitPiece[] = [{ x0: s, x1: Math.max(stopX, s) + 1, c0: Math.max(p.vmax, speed) ** 2, c1: 0 }];
    let profile = planProfile(now, s, speed, lim, p.a, p.b, stopX);
    if (!profile.feasible) this.stats.forced++;
    if (!Number.isFinite(profile.tEnd)) profile = stationaryProfile(now, s);
    const changed = this.adopt(v, {
      route, profile, stopCause: cause, leaderBound: true, freeEnd: profile.xStop, staticLimits: lim, capped: false,
      odo0: this.odoAt(v, now) - s,
    }, now);
    // Liveness: the hold is conservative — the vehicle re-plans normally at
    // its next own event (leg end / stat mark) after this instant.
    v.softStale = true;
    return changed;
  }

  private buildPlan(v: Vehicle, path: RVPath, s: number, speed: number, now: number): MbPlan {
    this.prevWaits = this.takeWaits(v.id);
    try {
      return this.buildPlanInner(v, path, s, speed, now);
    } finally {
      this.prevWaits = null;
    }
  }

  /**
   * Route walk from the current piece: reuses the routing decisions of the
   * current plan (R2-5) and asks `peekNext` only beyond them. Ends at a
   * service stop, a dead end or the horizon (an unconfirmed horizon end is a
   * stop that keeps the body out of unknown track).
   */
  private walkRoute(v: Vehicle, path: RVPath, s: number): { route: RouteEntry[]; acc: number; stopX: number; cause: StopCause } {
    const host = v.host;
    const route: RouteEntry[] = [{ path, x0: 0 }];
    let acc = path.length;
    if (host.serviceStopAt(path, true)) return { route, acc, stopX: path.length, cause: 'service' };
    v.traveler.network?.resolveGraph();
    const old = v.plan.route;
    let reuse = v.routeDecided && old[v.curIdx]?.path === path ? v.curIdx + 1 : -1;
    let last = path;
    while (acc - s < HORIZON_M && route.length < MAX_ROUTE_PIECES) {
      let next: RVPath | null;
      if (reuse > 0 && reuse < old.length) {
        next = old[reuse].path;
        reuse++;
      } else {
        reuse = -1;
        // A closed path continues onto itself (one route entry per lap); a
        // single successor needs no routing decision (no hook round trip).
        next = last.closed ? last
          : last.successors.length === 1 ? last.successors[0]
            : v.traveler.peekNext(last, 1);
      }
      if (!next) return { route, acc, stopX: acc, cause: 'deadend' };
      route.push({ path: next, x0: acc });
      acc += next.length;
      last = next;
      if (host.serviceStopAt(next, false)) return { route, acc, stopX: acc, cause: 'service' };
    }
    return { route, acc, stopX: acc - v.p.front - STOP_MARGIN, cause: 'horizon' };
  }

  /**
   * Cruise + curve (v² ≤ aLat·R) + docking limits over the route as ONE
   * contiguous, disjoint, sorted piece list over [0, acc] (route coords).
   * Built from the per-path curvature intervals (cached by the path) in a
   * single pass; equal neighbours are merged so the planner sees few pieces.
   */
  private staticLimits(v: Vehicle, route: readonly RouteEntry[], acc: number, serviceStop: number): LimitPiece[] {
    const p = v.p;
    const vmax2 = p.vmax * p.vmax;
    const out: LimitPiece[] = [];
    const push = (x0: number, x1: number, c0: number): void => {
      if (x1 - x0 <= 1e-12) return;
      const last = out[out.length - 1];
      if (last && last.c0 === c0 && Math.abs(last.x1 - x0) < 1e-12) { last.x1 = x1; return; }
      out.push({ x0, x1, c0, c1: 0 });
    };
    for (const e of route) {
      const ivs = e.path.curvatureIntervals();
      if (ivs.length === 0) { push(e.x0, e.x0 + e.path.length, vmax2); continue; }
      for (const c of ivs) {
        const lim = Number.isFinite(c.radiusM) ? Math.min(vmax2, p.aLat * c.radiusM) : vmax2;
        push(e.x0 + c.s0, e.x0 + c.s1, lim);
      }
    }
    if (out.length === 0 || out[out.length - 1].x1 < acc - 1e-9) push(out.length ? out[out.length - 1].x1 : 0, acc, vmax2);
    const dock2 = p.dockSpeed * p.dockSpeed;
    if (serviceStop < 0 || p.dockDist <= 0 || dock2 >= vmax2) return out;
    // Docking crawl: overlay min(dock²) on [serviceStop − dockDist, serviceStop].
    const d0 = Math.max(0, serviceStop - p.dockDist), d1 = serviceStop;
    const res: LimitPiece[] = [];
    for (const q of out) {
      if (q.x1 <= d0 || q.x0 >= d1 || q.c0 <= dock2) { res.push(q); continue; }
      if (q.x0 < d0) res.push({ x0: q.x0, x1: d0, c0: q.c0, c1: 0 });
      res.push({ x0: Math.max(q.x0, d0), x1: Math.min(q.x1, d1), c0: dock2, c1: 0 });
      if (q.x1 > d1) res.push({ x0: d1, x1: q.x1, c0: q.c0, c1: 0 });
    }
    return res;
  }

  private buildPlanInner(v: Vehicle, path: RVPath, s: number, speed: number, now: number): MbPlan {
    const p = v.p;
    // 1. Route walk (decisions reused, R2-5).
    const walk = this.walkRoute(v, path, s);
    const route = walk.route;
    let stopX = walk.stopX;
    let cause = walk.cause;
    const freeEnd = stopX;
    // 2. Static limits: cruise + curve v² ≤ aLat·R + docking crawl.
    const statics = this.staticLimits(v, route, walk.acc, cause === 'service' ? stopX : -1);

    // 3. Leaders on the own route (trajectory projection). Only the NEAREST
    // leader binds (it is itself held behind the ones ahead — transitivity);
    // further ones only while the nearer one diverges off this route. A just
    // diverged vehicle (rear still sweeping the lane) always counts.
    const all = this.findLeaders(v, route, s, now).sort((x, y) => x.xNow - y.xNow
      || (x.u.id < y.u.id ? -1 : x.u.id > y.u.id ? 1 : 0));
    const leaders: LeaderRef[] = [];
    let open = true;
    for (const L of all) {
      if (L.diverged) { leaders.push(L); continue; }
      if (!open) continue;
      leaders.push(L);
      if (v.fieldLeader === null) v.fieldLeader = L;
      if (L.domainEnd === Infinity) open = false;
    }
    for (const L of leaders) {
      v.usedLeaders.set(L.u.id, L.u.version);
      const up = L.u.plan.profile;
      if (up.xStop <= L.domainEnd + EPS) {
        const auth = up.xStop + L.shift - L.G;
        if (auth < stopX) { stopX = auth; cause = 'leader'; }
      }
    }

    // 4. Zones.
    const odo0 = this.odoAt(v, now) - s;
    const z = this.planZones(v, route, s, now, stopX, leaders, odo0);
    if (z.stopX < stopX) { stopX = z.stopX; cause = z.cause; }

    // 5. Scanner fields (inline transitions at `now`, cap / stop).
    let capped = false;
    let fieldCap = Infinity;
    if (p.scanner) {
      this.updateFieldInline(v, s, speed, now);
      if (v.field === 'protective') {
        // Protective halt: brake with the own deceleration, but not earlier
        // than the queue behind can absorb (the moving block stays safe).
        const xs = Math.max(s + (speed * speed) / (2 * p.b), this.chainNeed(v, now));
        if (xs < stopX) { stopX = xs; cause = 'field'; }
      } else if (v.field === 'warning' && v.fieldCap < p.vmax) {
        fieldCap = v.fieldCap;
        capped = true;
      }
    }

    if (stopX < s - 1e-6) this.stats.authorityBehind++;
    stopX = Math.max(stopX, s);
    const xHi = Math.max(stopX, s + 1e-6);
    // Static base over [s, xHi] (cap included) — merged once, reused by every build.
    // The cap is a braking TARGET: from the current speed it ramps down with the
    // own deceleration (never an instant limit below the current speed).
    const capPieces: LimitPiece[] = [];
    if (capped) {
      const xc = Math.min(xHi, s + Math.max(0, speed * speed - fieldCap * fieldCap) / (2 * p.b));
      if (xc > s + 1e-9) capPieces.push({ x0: s, x1: xc, c0: speed * speed, c1: -2 * p.b });
      if (xHi > xc + 1e-9) capPieces.push({ x0: xc, x1: xHi, c0: fieldCap * fieldCap, c1: 0 });
    }
    const baseFns: LimitPiece[][] = capped ? [statics, capPieces] : [statics];
    const base = capped ? minLimits(baseFns, s, xHi) : clipLimits(statics, s, xHi);

    // 6. Leader envelopes: v² over x of the leader's planned phases, shifted by
    // δ − G. The envelope START per leader is refined by bisection to the
    // largest value whose plan still passes the exact time-domain check (the
    // domain start itself is the provably safe baseline) — removes the stop-
    // and-go of the plain envelope (catch-up to exactly G behind the trajectory).
    let prof: MotionProfile;
    let checked = false;
    let leaderBound = cause === 'leader';
    if (leaders.length === 0) {
      prof = planProfile(now, s, speed, base, p.a, p.b, stopX, true);
    } else {
      const starts = leaders.map((L) => L.domainStart);
      const envEnd = (L: LeaderRef): number => Math.min(L.domainEnd, L.u.plan.profile.xStop);
      const fns: LimitPiece[][] = [base];
      const build = (): MotionProfile => {
        fns.length = 1;
        for (let i = 0; i < leaders.length; i++) {
          const L = leaders[i];
          const env = profileAsLimit(L.u.plan.profile, L.shift - L.G, starts[i], envEnd(L));
          if (env.length > 0) fns.push(env);
        }
        return planProfile(now, s, speed, fns.length === 1 ? base : minLimits(fns, s, xHi), p.a, p.b, stopX, true);
      };
      const safe = (pr: MotionProfile): boolean => {
        for (const L of leaders) {
          if (minSeparation(pr, L.u.plan.profile, L.shift - L.G, now, L.domainEnd) < -1e-9) return false;
        }
        return true;
      };
      // Fast path: without any envelope (stop authorities only) the plan is
      // often already safe — a leader far ahead or faster.
      for (let i = 0; i < leaders.length; i++) starts[i] = envEnd(leaders[i]);
      let q = build();
      this.stats.bisections++;
      let relaxed = safe(q);
      if (relaxed) { prof = q; checked = true; }
      else {
        for (let i = 0; i < leaders.length; i++) starts[i] = leaders[i].domainStart;
        prof = build(); // the provably safe baseline
      }
      for (let i = 0; i < leaders.length && !relaxed; i++) {
        const L = leaders[i];
        const lo0 = starts[i];
        const hi0 = envEnd(L);
        if (hi0 <= lo0 + 1e-6) continue;
        if (leaders.length > 1) {
          starts[i] = hi0;
          q = build();
          this.stats.bisections++;
          if (safe(q)) { prof = q; checked = true; continue; }
        }
        let lo = lo0, hi = hi0;
        for (let k = 0; k < BISECT_MAX && hi - lo > BISECT_TOL_M; k++) {
          const mid = (lo + hi) / 2;
          starts[i] = mid;
          q = build();
          this.stats.bisections++;
          if (safe(q)) { lo = mid; prof = q; checked = true; } else hi = mid;
        }
        starts[i] = lo;
      }
      for (let i = 0; i < leaders.length && !leaderBound && !relaxed; i++) {
        if (starts[i] < envEnd(leaders[i]) - 1e-6) leaderBound = true;
      }
    }
    if (!prof.feasible) {
      this.stats.infeasible++;
      // Keep the previous plan when it is still safe against every current leader.
      const old = v.plan;
      const off = old.route[v.curIdx].x0;
      let ok = old.route[v.curIdx].path === path && old.profile.xStop - off <= stopX + 1e-6;
      if (ok) {
        for (const L of leaders) {
          const m = minSeparation(old.profile, L.u.plan.profile, L.shift - L.G + off, now, L.domainEnd);
          if (m < -1e-6) { ok = false; break; }
        }
      }
      if (ok) {
        this.stats.keptOld++;
        return {
          route: this.reanchoredRoute(v, path), profile: shiftProfile(old.profile, -off), stopCause: old.stopCause,
          leaderBound: true, freeEnd, staticLimits: statics, capped, odo0,
        };
      }
      this.stats.forced++;
    }
    // 7. Exact verification against every leader trajectory (must never fail)
    // — for every profile that did not already pass the same check above.
    for (const L of checked ? NO_LEADERS : leaders) {
      const m = minSeparation(prof, L.u.plan.profile, L.shift - L.G, now, L.domainEnd);
      if (m < this.stats.minMargin) this.stats.minMargin = m;
      if (m < -1e-6) this.stats.violations++;
    }
    if (!Number.isFinite(prof.tEnd)) prof = stationaryProfile(now, s);
    return { route, profile: prof, stopCause: cause, leaderBound, freeEnd, staticLimits: statics, capped, odo0 };
  }

  /**
   * Zone claims along the route: claim before the FRONT can enter (also the
   * front overhang of a service stop at a piece end), hold at the entrance
   * otherwise; release visits whose REAR has cleared.
   *
   * Held zones are keyed on the ODOMETER position of the end of the run they
   * were claimed for (`odo0` = odometer of route coordinate 0 of the plan
   * being built), so a ring that revisits the same path ids never confuses
   * this visit with the next lap. An unknown run end (the run continues
   * beyond the walked route, or the body overhangs a successor at a stop) is
   * `Infinity` — kept until a later plan routes through the run.
   */
  private planZones(
    v: Vehicle, route: readonly RouteEntry[], s: number, now: number, stopX: number,
    leaders: readonly LeaderRef[], odo0: number,
  ): { stopX: number; cause: StopCause } {
    const p = v.p;
    const zones = getDefaultZoneRegistry();
    const n = route.length;
    let outStop = Infinity;
    let outCause: StopCause = 'zone';
    // 1. Release visits whose rear has cleared the run end.
    const odoRear = odo0 + s - p.rear;
    for (const [z, ex] of [...v.held]) {
      if (!Number.isFinite(ex) || odoRear < ex + REAR_CLEAR_M - EPS) continue;
      this.releaseHeld(v, z);
    }
    // 2. Re-key every held zone on the end of the run this route takes
    // through it — independent of how far this plan's authority reaches, so a
    // release never fires at a piece end while the run continues.
    for (let i = 0; i < n; i++) {
      const z = route[i].path.zoneId;
      if (!z || (i > 0 && route[i - 1].path.zoneId === z) || !v.held.has(z)) continue;
      const run = this.zoneRun(route, i, odo0);
      const ex = v.held.get(z)!;
      const mine = (i === 0 && run.start <= odo0 + s + EPS)
        || (Number.isFinite(ex) ? ex > run.start + EPS && ex <= run.end + EPS : this.firstRunOf(route, z) === i);
      if (mine) v.held.set(z, run.open ? Infinity : run.end);
    }
    // 3. Zone runs along the route, plus the run the body overhangs at a stop.
    for (let i = 0; i <= n; i++) {
      let z: string | null;
      let entry: number;
      let exitVal: number;
      if (i < n) {
        z = route[i].path.zoneId;
        if (!z) continue;
        if (i > 0 && route[i - 1].path.zoneId === z) continue; // not a run start
        const run = this.zoneRun(route, i, odo0);
        entry = route[i].x0;
        exitVal = run.open ? Infinity : run.end;
      } else {
        // Overhang beyond the route end (service stop / dead end at a piece
        // end): the body front reaches into the successor's zone — claimed
        // open-ended until a later plan routes through it.
        const last = route[n - 1].path;
        const end = route[n - 1].x0 + last.length;
        if (Math.min(stopX, outStop) + p.front <= end + EPS) break;
        const succ = last.successors.find((q) => q.zoneId && q.zoneId !== last.zoneId) ?? null;
        if (!succ) break;
        z = succ.zoneId!;
        entry = end;
        exitVal = Infinity;
      }
      if (entry >= Math.min(stopX, outStop) + p.front - EPS) break; // the front never reaches it
      if (zones.isHolder(z, v.id)) {
        const ex = v.held.get(z);
        if (ex === undefined || ex === exitVal || i === 0) {
          v.held.set(z, exitVal);
          continue;
        }
        // Still held from an EARLIER visit (rear not clear) — cannot take this
        // one yet; the own release wakes it like any waiter.
        const zs = Math.max(s, entry - p.front - STOP_MARGIN);
        if (zs < outStop) { outStop = zs; outCause = 'zone'; }
        this.addWaiter(z, v.id, now);
        break;
      }
      const zStop = Math.max(s, entry - p.front - STOP_MARGIN);
      if (entry <= s + EPS) {
        // root already inside an unheld zone (start-up) — take it if possible
        if (zones.claim(z, v.id)) { v.held.set(z, exitVal); continue; }
        if (s < outStop) { outStop = s; outCause = 'zone'; }
        this.addWaiter(z, v.id, now);
        break;
      }
      const claimWindow = (p.vmax * p.vmax) / (2 * p.b) + p.vmax * CLAIM_LEAD_SEC + CLAIM_MARGIN_M;
      if (entry - (s + p.front) > claimWindow) {
        if (zStop < outStop) { outStop = zStop; outCause = 'zonePending'; }
        break;
      }
      // Queue-order guard: a vehicle between me and the entrance claims first.
      let leaderBefore = false;
      for (const L of leaders) if (L.xNow > s && L.xNow <= entry + EPS) { leaderBefore = true; break; }
      if (leaderBefore || !this.isHeadWaiter(z, v.id, now) || !zones.claim(z, v.id)) {
        // Behind a leader that claims first: PASSIVE waiter (woken on release,
        // no priority — it must never outrank the leader it queues behind).
        this.addWaiter(z, v.id, leaderBefore ? Number.NaN : now);
        if (zStop < outStop) { outStop = zStop; outCause = 'zone'; }
        break;
      }
      this.removeWaiter(z, v.id);
      v.held.set(z, exitVal);
    }
    return { stopX: outStop, cause: outCause };
  }

  /** The zone run starting at route index i: odometer start / end, open = continues beyond the route. */
  private zoneRun(route: readonly RouteEntry[], i: number, odo0: number): { start: number; end: number; open: boolean } {
    const z = route[i].path.zoneId;
    let j = i;
    while (j + 1 < route.length && route[j + 1].path.zoneId === z) j++;
    const open = j === route.length - 1 && route[j].path.successors.some((q) => q.zoneId === z);
    return { start: odo0 + route[i].x0, end: odo0 + route[j].x0 + route[j].path.length, open };
  }

  /** Route index of the first piece of zone z (−1 = none). */
  private firstRunOf(route: readonly RouteEntry[], z: string): number {
    for (let i = 0; i < route.length; i++) if (route[i].path.zoneId === z) return i;
    return -1;
  }

  /** Release one held zone (cancels its pending release event). */
  private releaseHeld(v: Vehicle, z: string): void {
    v.held.delete(z);
    const ev = v.releaseEvents.get(z);
    if (ev !== undefined) { v.host.cancel(ev); v.releaseEvents.delete(z); }
    v.releaseTimes.delete(z);
    getDefaultZoneRegistry().release(z, v.id); // → onZoneAvailable → waiters
  }

  /** Odometer (m along everything the vehicle has driven) at sim time t. */
  private odoAt(v: Vehicle, t: number): number {
    return v.plan.odo0 + positionAt(v.plan.profile, t);
  }

  /**
   * The earliest stop (route coords anchored at u's CURRENT piece) that every
   * vehicle queued behind u — transitively — can still respect when each
   * brakes with its own deceleration from now: max over followers f of
   * (need(f) + G − δ), need(f) ≥ f's emergency stop. A halt of u at or
   * beyond this point keeps the whole upstream chain feasible (freeze, Run
   * off, protective field). −∞ = nobody behind.
   */
  private chainNeed(u: Vehicle, now: number, depth = 0, seen: Set<Vehicle> = new Set([u])): number {
    let need = -Infinity;
    if (depth > 16) return need;
    const lu = this.loc(u, now);
    const uAnchor = u.plan.route[lu.idx].x0;
    for (const f of this.order) {
      if (seen.has(f) || !f.usedLeaders.has(u.id)) continue;
      const lf = this.loc(f, now);
      const base = f.plan.route[lf.idx].x0;
      const route: RouteEntry[] = [];
      for (let i = lf.idx; i < f.plan.route.length; i++) route.push({ path: f.plan.route[i].path, x0: f.plan.route[i].x0 - base });
      let ref: LeaderRef | null = null;
      for (const L of this.findLeaders(f, route, lf.s, now)) if (L.u === u && !L.diverged) { ref = L; break; }
      if (!ref) continue;
      seen.add(f);
      const fStop = Math.max(lf.s + (lf.v * lf.v) / (2 * f.p.b), this.chainNeed(f, now, depth + 1, seen));
      const n = fStop + ref.G - ref.shift - uAnchor;
      if (n > need) need = n;
    }
    return need;
  }

  /** Vehicles ahead on v's route (or just diverged off it) with their projection. */
  private findLeaders(v: Vehicle, route: readonly RouteEntry[], s: number, now: number): LeaderRef[] {
    const out: LeaderRef[] = [];
    for (const u of this.order) {
      if (u === v) continue;
      const lu = this.loc(u, now);
      const uRoute = u.plan.route;
      const uIdx = lu.idx;
      const uStart = uRoute[uIdx].x0;
      let e = -1;
      for (let i = 0; i < route.length; i++) {
        if (route[i].path !== lu.path) continue;
        if (i > 0 || lu.s > s + 1e-9) { e = i; break; }
      }
      const G = v.p.front + u.p.rear + v.p.gap;
      if (e >= 0) {
        const shift = route[e].x0 - uStart;
        let k = 0;
        while (e + k < route.length && uIdx + k < uRoute.length && route[e + k].path === uRoute[uIdx + k].path) k++;
        let domainEnd = Infinity;
        if (e + k < route.length && uIdx + k < uRoute.length) {
          const branch = uRoute[uIdx + k];
          domainEnd = branch.x0 + this.clearanceOf(route[e + k - 1].path, branch.path, v.p, u.p);
        }
        out.push({ u, shift, domainStart: Math.max(u.plan.profile.x0, uStart), domainEnd, xNow: lu.x + shift, G, diverged: false });
        continue;
      }
      // Just diverged off v's route: its rear may still sweep v's lane.
      const uPrev = uIdx > u.curIdx ? uRoute[uIdx - 1].path.id : u.prevPathId;
      if (uPrev === null) continue;
      for (let i = 0; i < route.length; i++) {
        if (route[i].path.id !== uPrev) continue;
        const cont = route[i + 1]?.path;
        if (!cont || cont === lu.path) break;
        const C = this.clearanceOf(route[i].path, lu.path, v.p, u.p);
        if (lu.s >= C) break;
        const shift = route[i].x0 + route[i].path.length - uStart;
        out.push({ u, shift, domainStart: Math.max(u.plan.profile.x0, uStart), domainEnd: uStart + C, xNow: lu.x + shift, G, diverged: true });
        break;
      }
    }
    return out;
  }

  /**
   * Arc length along `branch` (from its start) after which a vehicle rooted on
   * it can no longer touch a vehicle rooted anywhere on the lane after `from`
   * (every successor chain of `from`, {@link CLEARANCE_LANE_M}): root distance
   * ≥ reach(a) + reach(b) + 5 cm, reach = the body's farthest point from its
   * root. Cached per GEOMETRY (path geometry ids) and BODY reaches (R2-6) — a
   * live edit or a different vehicle size never reuses a stale value.
   */
  private clearanceOf(from: RVPath, branch: RVPath, a: MbParams, b: MbParams): number {
    const ra = Math.hypot(Math.max(a.front, a.rear), a.width / 2);
    const rb = Math.hypot(Math.max(b.front, b.rear), b.width / 2);
    const lo = Math.min(ra, rb), hi = Math.max(ra, rb);
    const key = from.geometryId * 4194304 + branch.geometryId;
    let entries = this.clearance.get(key);
    if (entries) {
      for (const e of entries) if (Math.abs(e.lo - lo) < 1e-6 && Math.abs(e.hi - hi) < 1e-6) return e.c;
    } else {
      entries = [];
      this.clearance.set(key, entries);
    }
    const dClear = ra + rb + 0.05;
    const pts: Vector3[] = [];
    // Lane = every successor chain of `from` except the branch itself, up to the lane length.
    const stack: Array<[RVPath, number]> = [];
    for (const q of from.successors) if (q !== branch) stack.push([q, 0]);
    const seen = new Set<RVPath>();
    for (let sm = 0; sm <= from.length; sm += CLEARANCE_STEP_M) pts.push(from.getAbsPosition(sm, new Vector3()));
    while (stack.length > 0) {
      const [m, len] = stack.pop()!;
      if (seen.has(m) || len >= CLEARANCE_LANE_M) continue;
      seen.add(m);
      for (let sm = 0; sm <= m.length; sm += CLEARANCE_STEP_M) pts.push(m.getAbsPosition(sm, new Vector3()));
      for (const q of m.successors) stack.push([q, len + m.length]);
    }
    const q = new Vector3();
    let lastBad = -1;
    for (let sb = 0; sb <= branch.length + 1e-9; sb += CLEARANCE_STEP_M) {
      branch.getAbsPosition(sb, q);
      let dmin = Infinity;
      for (const pt of pts) { const d = pt.distanceTo(q); if (d < dmin) dmin = d; }
      if (dmin < dClear) lastBad = sb;
    }
    const c = lastBad < 0 ? 0 : lastBad + CLEARANCE_STEP_M;
    entries.push({ lo, hi, c });
    return c;
  }

  // ── Events from a plan ───────────────────────────────────────────────

  private cancelAllEvents(v: Vehicle): void {
    const h = v.host;
    if (v.legEvent >= 0) h.cancel(v.legEvent);
    if (v.extendEvent >= 0) h.cancel(v.extendEvent);
    if (v.watchdogEvent >= 0) h.cancel(v.watchdogEvent);
    if (v.fieldEvent >= 0) h.cancel(v.fieldEvent);
    if (v.statEvent >= 0) h.cancel(v.statEvent);
    for (const id of v.notifyEvents) h.cancel(id);
    for (const id of v.releaseEvents.values()) h.cancel(id);
    this.forgetEventIds(v);
  }

  /** Forget the event ids (the queue already dropped them — freeze / epoch). */
  private forgetEventIds(v: Vehicle): void {
    v.legEvent = -1;
    v.extendEvent = -1;
    v.watchdogEvent = -1;
    v.fieldEvent = -1;
    v.statEvent = -1;
    v.notifyEvents.length = 0;
    v.releaseEvents.clear();
    v.releaseTimes.clear();
    v.statEventT = -1;
  }

  private applyEvents(v: Vehicle, now: number): void {
    const h = v.host;
    if (v.legEvent >= 0) { h.cancel(v.legEvent); v.legEvent = -1; }
    if (v.extendEvent >= 0) { h.cancel(v.extendEvent); v.extendEvent = -1; }
    if (v.watchdogEvent >= 0) { h.cancel(v.watchdogEvent); v.watchdogEvent = -1; }
    for (const id of v.notifyEvents) h.cancel(id);
    v.notifyEvents.length = 0;
    this.scheduleLeg(v, now);
    this.scheduleExtend(v, now);
    this.scheduleNotify(v, now);
    const prof = v.plan.profile;
    if (isTrafficStop(v.plan.stopCause)) {
      v.watchdogEvent = h.schedule(Math.max(0, prof.tEnd - now) + WATCHDOG_SEC, 'watchdog', null, null);
    }
    this.scheduleReleases(v, now);
    this.scheduleField(v, now);
    this.computeMotion(v, now);
    this.publishPlan(v, now);
  }

  private publishPlan(v: Vehicle, now: number): void {
    const moving = v.plan.profile.tEnd > now + 1e-9;
    v.host.onPlanApplied?.(moving, !moving && isTrafficStop(v.plan.stopCause));
  }

  /** A vehicle whose plan was kept must still own its leg / extend event. */
  private ensureEvents(v: Vehicle, now: number): void {
    if (v.legEvent < 0) this.scheduleLeg(v, now);
    if (v.extendEvent < 0) this.scheduleExtend(v, now);
  }

  /** Extend: braking point of an unconfirmed stop (horizon / pending zone). */
  private scheduleExtend(v: Vehicle, now: number): void {
    const prof = v.plan.profile;
    const c = v.plan.stopCause;
    if ((c !== 'horizon' && c !== 'zonePending') || prof.phases.length === 0) return;
    const xb = prof.xStop - (v.p.vmax * v.p.vmax) / (2 * v.p.b) - 0.3;
    const tb = timeAt(prof, Math.max(xb, positionAt(prof, now)));
    // One extension per instant: a re-check that confirmed nothing new waits
    // for the next trigger instead of re-firing at the same time.
    if (tb < prof.tEnd && tb > v.lastExtendT + 1e-9) v.extendEvent = v.host.schedule(Math.max(0, tb - now), 'extend', null, null);
  }

  /** ONE leg to the plan end — Arrival at a service stop / dead end, Stop otherwise. */
  private scheduleLeg(v: Vehicle, now: number): void {
    const h = v.host;
    const prof = v.plan.profile;
    if (prof.tEnd <= now + 1e-9) {
      // Already standing AT a service stop (a task / dock assigned there):
      // the arrival happens now — no leg to drive.
      const r = v.plan.route;
      const end = r[r.length - 1].x0 + r[r.length - 1].path.length;
      if (v.plan.stopCause === 'service' && !v.frozen && h.canMove() && prof.xStop >= end - 1e-9) {
        v.legEvent = h.schedule(0, 'arrival', null, null);
      }
      return;
    }
    const x = positionAt(prof, now);
    const sampler = routeSampler(v.plan.route);
    const sAt = (t: number): number => { v.renderT = t; return positionAt(prof, t); };
    const c = v.plan.stopCause;
    const kind: MbEventKind = c === 'service' || c === 'deadend' ? 'arrival' : 'stop';
    v.legEvent = h.schedule(prof.tEnd - now, kind, null, h.legTween(sampler, x, prof.xStop, sAt));
  }

  /**
   * Router subscribers (R2-5): with a project router installed every piece end
   * inside the plan gets a `notify` event at its exact arrival time, so
   * `router.onArrive` fires once per arrival, in route order.
   */
  private scheduleNotify(v: Vehicle, now: number): void {
    if (!this.network?.hasRouter) return;
    const r = v.plan.route;
    const prof = v.plan.profile;
    for (let k = v.curIdx + 1; k < r.length; k++) {
      const xe = r[k].x0;
      if (xe > prof.xStop + EPS) break;
      const tA = timeAt(prof, xe);
      if (!Number.isFinite(tA)) break;
      const data: Record<string, unknown> = { ver: v.version, idx: k, ev: -1 };
      const id = v.host.schedule(Math.max(0, tA - now), 'notify', data, null);
      data.ev = id;
      v.notifyEvents.push(id);
    }
  }

  /** Release events: when the rear passes the end of each held run (odometer keyed). */
  private scheduleReleases(v: Vehicle, now: number): void {
    const h = v.host;
    const prof = v.plan.profile;
    const x = positionAt(prof, now);
    for (const [zone, ex] of [...v.held]) {
      if (!Number.isFinite(ex)) continue; // run end not routed yet — kept
      const relX = ex + v.p.rear + REAR_CLEAR_M - v.plan.odo0;
      if (x >= relX - EPS) { this.releaseHeld(v, zone); continue; }
      const tR = prof.xStop >= relX - EPS ? timeAt(prof, relX) : Infinity;
      const prevEv = v.releaseEvents.get(zone);
      if (prevEv !== undefined && Math.abs((v.releaseTimes.get(zone) ?? -1) - tR) < 1e-9) continue; // unchanged
      if (prevEv !== undefined) { h.cancel(prevEv); v.releaseEvents.delete(zone); v.releaseTimes.delete(zone); }
      if (tR < Infinity) {
        v.releaseTimes.set(zone, tR);
        v.releaseEvents.set(zone, h.schedule(Math.max(0, tR - now), 'zoneRelease', { zone }, null));
      }
    }
  }

  // ── Scanner fields (R2-7) ───────────────────────────────────────────────

  /** Body gap (m, front of v to rear of the field leader) at time t; +∞ without leader. */
  private fieldGap(v: Vehicle, s: number, t: number): number {
    const L = v.fieldLeader;
    if (!L) return Infinity;
    if (L.domainEnd < Infinity && positionAt(L.u.plan.profile, t) > L.domainEnd) return Infinity;
    return positionAt(L.u.plan.profile, t) + L.shift - L.u.p.rear - v.p.front - s;
  }

  /** Field transitions that hold AT `now` (no event — e.g. already inside at start). */
  private updateFieldInline(v: Vehicle, s: number, speed: number, now: number): void {
    const sc = v.p.scanner!;
    const gap = this.fieldGap(v, s, now);
    const P = fieldLength(speed, sc.reactionTime, v.p.b, sc.protectiveMargin);
    const W = P + sc.warningMargin;
    const prev = v.field;
    if (v.field === 'clear') {
      if (gap < P - EPS) v.field = 'protective';
      else if (gap < W - EPS) this.enterWarning(v, now);
    } else if (v.field === 'warning') {
      if (gap < P - EPS) v.field = 'protective';
      else if (gap > this.warningExitLength(v) + EPS) { v.field = 'clear'; v.fieldCap = Infinity; }
    }
    if (v.field === 'protective') {
      v.fieldCap = Infinity;
      if (speed <= 1e-9 && gap > sc.protectiveMargin + sc.hysteresis + EPS) {
        if (v.fieldRestartAt < 0) v.fieldRestartAt = now + sc.restartDelay;
        if (now >= v.fieldRestartAt - 1e-9) { v.field = 'clear'; v.fieldRestartAt = -1; }
      } else {
        v.fieldRestartAt = -1;
      }
    }
    if (v.field !== prev) v.host.onFieldState?.(v.field);
  }

  /** Gap (m) above which the warning field releases: W(cruise speed) + hysteresis. */
  private warningExitLength(v: Vehicle): number {
    const sc = v.p.scanner!;
    return fieldLength(v.p.vmax, sc.reactionTime, v.p.b, sc.protectiveMargin) + sc.warningMargin + sc.hysteresis;
  }

  private enterWarning(v: Vehicle, now: number): void {
    const L = v.fieldLeader;
    const vl = L ? speedAt(L.u.plan.profile, now) : 0;
    v.field = 'warning';
    v.fieldCap = Math.max(v.p.dockSpeed, vl);
  }

  /**
   * Predict the next field transition on the applied plan against the field
   * leader's planned trajectory and schedule it (carrying both plan versions).
   */
  private scheduleField(v: Vehicle, now: number): void {
    if (v.fieldEvent >= 0) { v.host.cancel(v.fieldEvent); v.fieldEvent = -1; }
    const sc = v.p.scanner;
    if (!sc) return;
    const L = v.fieldLeader;
    let tNext = Infinity;
    let to: FieldState = 'clear';
    const off = v.plan.route[v.curIdx].x0;
    const shiftBody = L ? L.shift - L.u.p.rear - v.p.front + off : 0;
    if (v.field === 'protective') {
      if (v.fieldRestartAt >= 0) { tNext = v.fieldRestartAt; to = 'clear'; }
      else {
        // Exit = standstill AND gap > protective margin + hysteresis (a leader
        // never reverses, so the gap of a standing vehicle only grows); the
        // restart follows after the restart delay.
        const te = L
          ? earliestCrossing(v.plan.profile, L.u.plan.profile, shiftBody, now, L.domainEnd,
            0, 0, v.p.b, sc.protectiveMargin + sc.hysteresis, +1)
          : now;
        if (te < Infinity) { tNext = Math.max(te, v.plan.profile.tEnd, now) + sc.restartDelay; to = 'clear'; }
      }
    } else if (L) {
      // Entry into the protective field (both from clear and warning).
      const tp = earliestCrossing(v.plan.profile, L.u.plan.profile, shiftBody, now, L.domainEnd,
        1, sc.reactionTime, v.p.b, sc.protectiveMargin, -1);
      if (v.field === 'clear') {
        const tw = earliestCrossing(v.plan.profile, L.u.plan.profile, shiftBody, now, L.domainEnd,
          1, sc.reactionTime, v.p.b, sc.protectiveMargin + sc.warningMargin, -1);
        if (tw <= tp) { tNext = tw; to = 'warning'; } else { tNext = tp; to = 'protective'; }
      } else {
        // Exit: the gap exceeds the warning field at the speed the vehicle
        // drives once the cap is lifted (its cruise speed), plus the
        // hysteresis — so neither its own braking under the cap nor the
        // re-acceleration after the release re-triggers the field at once.
        const tx = earliestCrossing(v.plan.profile, L.u.plan.profile, shiftBody, now, L.domainEnd, 0, 0, v.p.b,
          this.warningExitLength(v), +1);
        if (tp <= tx) { tNext = tp; to = 'protective'; } else { tNext = tx; to = 'clear'; }
      }
    } else if (v.field === 'warning') {
      tNext = now; to = 'clear';
    }
    if (!(tNext < Infinity)) return;
    v.fieldEvent = v.host.schedule(Math.max(0, tNext - now), 'field', {
      to, ver: v.version, lid: L?.u.id ?? '', lver: L?.u.version ?? -1,
    }, null);
  }

  /** Re-project the nearest leader on the current (unchanged) plan route. */
  private refreshFieldLeader(v: Vehicle, now: number): void {
    this.sync(v, now);
    const cur = this.loc(v, now);
    const base = v.plan.route[cur.idx].x0;
    const route: RouteEntry[] = [];
    for (let i = cur.idx; i < v.plan.route.length; i++) route.push({ path: v.plan.route[i].path, x0: v.plan.route[i].x0 - base });
    let best: LeaderRef | null = null;
    for (const L of this.findLeaders(v, route, cur.s, now)) {
      if (L.diverged) continue;
      if (!best || L.xNow < best.xNow || (L.xNow === best.xNow && L.u.id < best.u.id)) best = L;
    }
    v.fieldLeader = best;
  }

  private onFieldEvent(v: Vehicle, data: Record<string, unknown> | null, now: number): void {
    this.stats.fieldEvents++;
    const ver = Number(data?.ver ?? -1);
    const lid = typeof data?.lid === 'string' ? data.lid : '';
    const lver = Number(data?.lver ?? -1);
    const leader = lid ? this.vehicles.get(lid) : undefined;
    if (ver !== v.version) {
      // Own plan changed since the prediction: the re-plan re-predicts.
      this.stats.fieldStale++;
      this.dirty(v, 'field-stale');
      return;
    }
    if (lid && leader?.version !== lver) {
      // Only the leader's plan changed: refresh the leader projection and
      // re-predict on the unchanged own plan (no re-plan).
      this.stats.fieldStale++;
      this.refreshFieldLeader(v, now);
      this.scheduleField(v, now);
      return;
    }
    const to = data?.to as FieldState;
    const prev = v.field;
    if (to === 'warning') this.enterWarning(v, now);
    else if (to === 'protective') { v.field = 'protective'; v.fieldCap = Infinity; v.fieldRestartAt = -1; }
    else { v.field = 'clear'; v.fieldCap = Infinity; v.fieldRestartAt = -1; }
    if (v.field !== prev) v.host.onFieldState?.(v.field);
    this.dirty(v, 'field');
  }

  // ── Motion state (statistics, Phase 6) ─────────────────────────────────

  /**
   * Classify the applied plan into free / slowed / stopped intervals and
   * schedule the first transition. Slowed = v below the FREE profile (static
   * limits, natural end, same start state) at the same position.
   */
  private computeMotion(v: Vehicle, now: number): void {
    const marks = v.motionMarks;
    marks.length = 0;
    v.motionIdx = 0;
    const plan = v.plan;
    const prof = plan.profile;
    const traffic = isTrafficStop(plan.stopCause);
    const endState: MotionState = traffic ? 'stopped' : 'free';
    if (prof.tEnd <= now + 1e-9) {
      marks.push({ t: now, state: endState });
    } else if (!traffic && !plan.leaderBound && !plan.capped) {
      marks.push({ t: now, state: 'free' }, { t: prof.tEnd, state: endState });
    } else {
      const s = positionAt(prof, now);
      const sp = speedAt(prof, now);
      let free: MotionProfile | null = null;
      try {
        free = planProfile(now, s, sp, plan.staticLimits, v.p.a, v.p.b, Math.max(plan.freeEnd, s), true);
      } catch { free = null; }
      if (!free || !free.feasible) {
        marks.push({ t: now, state: 'free' }, { t: prof.tEnd, state: endState });
      } else {
        slowedMarks(prof, free, now, marks);
        marks.push({ t: prof.tEnd, state: endState });
      }
    }
    // Compress: a mark at the same time as its predecessor replaces it; equal
    // neighbouring states collapse.
    let w = 0;
    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      if (w > 0 && m.t - marks[w - 1].t < 1e-9) { marks[w - 1] = m; }
      else marks[w++] = m;
      if (w > 1 && marks[w - 1].state === marks[w - 2].state) w--;
    }
    marks.length = w;
    this.advanceMotion(v, now);
  }

  /** Apply every motion mark due at `now` and schedule the next one. */
  private advanceMotion(v: Vehicle, now: number): void {
    const marks = v.motionMarks;
    let state = v.motion;
    while (v.motionIdx < marks.length && marks[v.motionIdx].t <= now + 1e-9) {
      state = marks[v.motionIdx].state;
      v.motionIdx++;
    }
    this.setMotion(v, state, now);
    // One pending stat event per vehicle; an unchanged next mark keeps it.
    let tNext = v.motionIdx < marks.length ? marks[v.motionIdx].t : Infinity;
    // The final mark at the plan end rides on the leg event (onLegEnd).
    if (v.motionIdx === marks.length - 1 && v.legEvent >= 0 && Math.abs(tNext - v.plan.profile.tEnd) < 1e-9) tNext = Infinity;
    if (v.statEvent >= 0 && Math.abs(v.statEventT - tNext) < 1e-9) return;
    if (v.statEvent >= 0) { v.host.cancel(v.statEvent); v.statEvent = -1; }
    if (tNext < Infinity) {
      v.statEventT = tNext;
      v.statEvent = v.host.schedule(Math.max(0, tNext - now), 'stat', null, null);
    }
  }

  private setMotion(v: Vehicle, state: MotionState, _now: number): void {
    if (state === v.motion) return;
    v.motion = state;
    v.host.onMotionState?.(state);
  }

  // ── Zone waiters (deterministic: earliest wait, then id) ───────────────

  private addWaiter(zone: string, id: string, now: number): void {
    let w = this.waiters.get(zone);
    if (!w) { w = new Map(); this.waiters.set(zone, w); }
    const prev = this.prevWaits?.get(zone);
    if (!w.has(id)) w.set(id, Number.isNaN(now) ? Number.NaN : (prev !== undefined && !Number.isNaN(prev) ? prev : now));
  }

  private removeWaiter(zone: string, id: string): void {
    this.waiters.get(zone)?.delete(id);
  }

  /**
   * True when `id` may claim `zone` now: no other ACTIVE waiter started waiting
   * earlier (ties → smaller id). The vehicle's own wait start survives its
   * re-plan through `prevWaits` (it was taken out of the list for the plan).
   */
  private isHeadWaiter(zone: string, id: string, now: number): boolean {
    const w = this.waiters.get(zone);
    if (!w || w.size === 0) return true;
    const prev = this.prevWaits?.get(zone);
    const myT = prev !== undefined && !Number.isNaN(prev) ? prev : now;
    for (const [wid, t] of w) {
      if (wid === id || Number.isNaN(t)) continue; // self / passive
      if (t < myT || (t === myT && wid < id)) return false;
    }
    return true;
  }

  /** Drop v from every waiter list, remembering its wait start (FIFO survives re-plans). */
  private takeWaits(id: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const [z, w] of this.waiters) {
      const t = w.get(id);
      if (t !== undefined) { out.set(z, t); w.delete(id); }
    }
    return out;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────

  /** One line per vehicle (debugging). */
  describe(t: number): string[] {
    return this.order.map((v) => {
      const l = this.loc(v, t);
      const pr = v.plan.profile;
      return `${v.id} path=${l.path.id} s=${l.s.toFixed(3)} v=${l.v.toFixed(3)} cause=${v.plan.stopCause}`
        + ` xStop=${pr.xStop.toFixed(3)} tEnd=${pr.tEnd.toFixed(3)} ver=${v.version}`
        + ` leaders=${[...v.usedLeaders.keys()].join(',')} held=${[...v.held.keys()].join(',')}`
        + ` field=${v.field} motion=${v.motion} dirty=${v.dirty} leg=${v.legEvent} wd=${v.watchdogEvent}`
        + ` waits=${[...this.waiters].filter(([, w]) => w.has(v.id)).map(([z, w]) => `${z}@${w.get(v.id)}`).join(',')}`;
    });
  }

  /** Minimum front-to-rear gap (m) over all follower/leader pairs at time t (route projection). */
  minFrontRearGap(t: number): number {
    let min = Infinity;
    for (const v of this.order) {
      const cur = this.loc(v, t);
      const base = v.plan.route[cur.idx].x0;
      const route = v.plan.route.slice(cur.idx).map((e) => ({ path: e.path, x0: e.x0 - base }));
      for (const L of this.findLeaders(v, route, cur.s, t)) {
        if (L.diverged || (L.domainEnd < Infinity && positionAt(L.u.plan.profile, t) > L.domainEnd)) continue;
        const g = L.xNow - L.u.p.rear - (cur.s + v.p.front);
        if (g < min) min = g;
      }
    }
    return min;
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/** Scanner field length (m) at speed v: v·t_r + v²/(2b) + margin. */
export function fieldLength(v: number, reactionTime: number, b: number, margin: number): number {
  return v * reactionTime + (v * v) / (2 * b) + margin;
}

/**
 * Append free/slowed marks for the plan `prof` against the free reference
 * profile over the plan's position range — exact on the piecewise-linear v²
 * (one merge walk over both phase lists, no sorting).
 */
function slowedMarks(prof: MotionProfile, free: MotionProfile, now: number, out: { t: number; state: MotionState }[]): void {
  const xStart = positionAt(prof, now);
  const xEnd = prof.xStop;
  const pp = prof.phases, fp = free.phases;
  let i = 0, j = 0;
  while (i + 1 < pp.length && pp[i + 1].x0 <= xStart) i++;
  while (j + 1 < fp.length && fp[j + 1].x0 <= xStart) j++;
  let state: MotionState | null = null;
  let a = xStart;
  for (let guard = 0; guard < 100000 && a < xEnd - 1e-9; guard++) {
    const nextP = i + 1 < pp.length ? pp[i + 1].x0 : Infinity;
    const nextF = j + 1 < fp.length ? fp[j + 1].x0 : Infinity;
    const b = Math.min(nextP, nextF, xEnd);
    if (b - a > 1e-9) {
      // d(x) = free v² − plan v², linear on [a, b].
      const da = phaseV2(free, j, a + 1e-9) - phaseV2(prof, i, a + 1e-9);
      const db = phaseV2(free, j, b - 1e-9) - phaseV2(prof, i, b - 1e-9);
      const sa: MotionState = da > SLOWED_TOL_V2 ? 'slowed' : 'free';
      const sb: MotionState = db > SLOWED_TOL_V2 ? 'slowed' : 'free';
      if (sa !== state) { state = sa; out.push({ t: Math.max(now, timeAt(prof, a)), state: sa }); }
      if (sa !== sb) {
        state = sb;
        out.push({ t: Math.max(now, timeAt(prof, a + ((SLOWED_TOL_V2 - da) / (db - da)) * (b - a))), state: sb });
      }
    }
    a = b;
    if (nextP <= a + 1e-12) i++;
    if (nextF <= a + 1e-12) j++;
  }
  if (state === null) out.push({ t: now, state: 'free' });
}

/** v² of a profile at x inside its phase k (no phases: v0; at/after the end: vEnd). */
function phaseV2(p: MotionProfile, k: number, x: number): number {
  const ph = p.phases;
  if (ph.length === 0) return p.v0 * p.v0;
  if (x >= p.xStop) return p.vEnd * p.vEnd;
  const q = ph[Math.min(k, ph.length - 1)];
  return Math.max(0, q.v0 * q.v0 + 2 * q.a * (x - q.x0));
}

/** Multi-path arc-length sampler over a plan route (route coordinates). */
function routeSampler(route: readonly RouteEntry[]): RouteSampler {
  const find = (m: number): number => {
    let lo = 0, hi = route.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (route[mid].x0 <= m) lo = mid; else hi = mid - 1; }
    return lo;
  };
  return {
    getAbsPosition: (m, out) => { const e = route[find(m)]; return e.path.getAbsPosition(m - e.x0, out); },
    getAbsDirection: (m, out) => { const e = route[find(m)]; return e.path.getAbsDirection(m - e.x0, out); },
    align: route[0].path.align,
  };
}

/**
 * Merges without a shared zone (plan-558): a path with two or more incoming
 * paths where the merging pieces and the successor do not all carry the SAME
 * zone id — vehicles from both branches may enter the merge together.
 */
export function findUnzonedMerges(paths: Iterable<RVPath>): UnzonedMerge[] {
  const out: UnzonedMerge[] = [];
  for (const p of paths) {
    if (p.predecessors.length < 2) continue;
    const z = p.zoneId;
    const ok = z !== null && p.predecessors.every((q) => q.zoneId === z);
    if (!ok) out.push({ pathId: p.id, incoming: p.predecessors.map((q) => q.id).sort() });
  }
  return out.sort((a, b) => (a.pathId < b.pathId ? -1 : a.pathId > b.pathId ? 1 : 0));
}

const authorities = {
  des: new MovementAuthority('des'),
  continuous: new MovementAuthority('continuous'),
};

/** The shared authority of a kernel (DES events or the continuous fixed tick). */
export function getDefaultMovementAuthority(kind: 'des' | 'continuous' = 'des'): MovementAuthority {
  return authorities[kind];
}

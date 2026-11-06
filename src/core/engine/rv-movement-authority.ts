// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { WaitEdge } from '../diagnostics/rv-wait-registry';
import { tagLegTween } from './rv-leg-tween';
import { vehicleStateKeys } from './rv-movement-authority-state';
import { encodeAuthorityData, decodeAuthorityData, encodeRoute, decodeRoute, decodeMotionProfile,
  decodeLimitPieces, resolveSnapshotPath, tupleMap, record, numeric, snapshotError } from './rv-movement-authority-snapshot';
import type { SnapshotJson } from './rv-snapshot-contract';
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
 * hold plan (stop before the CURRENT trailing end of its leader; a leader
 * never drives back toward its follower — true for every SAME-direction pair,
 * and an opposite-direction vehicle is never a leader: reverse travel runs only
 * inside held capacity-1 zones, plan-595 G2), never its old plan (review R2-2).
 * Its limits are the route's cruise and curve limits of the plan's direction
 * (plan-595 R3-5).
 *
 * TRAVEL DIRECTION (plan-595): a plan drives forward (+1) or in reverse (−1).
 * Reverse travel is forward travel in a MIRRORED route frame — the route is
 * walked over the predecessors, piece-local route coordinates map to
 * L − s — so profiles, odometer and every v² computation stay unchanged; only
 * the leading / trailing body ends swap (`lead` / `trail`). A direction change
 * happens at standstill (`setDirection`) and is a new plan.
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
import { reportProblem, clearProblem } from '../hmi/problems-store';
import {
  planProfile, positionAt, speedAt, timeAt, stationaryProfile, profileAsLimit, minSeparation, minLimits,
  shiftProfile, clipLimits, earliestGapCrossing as earliestCrossing,
  type LimitPiece, type MotionProfile,
} from './rv-motion-profile';

// ── Public types ──────────────────────────────────────────────────────────

export type StopCause = 'service' | 'deadend' | 'horizon' | 'zone' | 'zonePending' | 'leader' | 'hold' | 'field';
export type MbEventKind =
  | 'arrival' | 'stop' | 'flush' | 'extend' | 'zoneRelease' | 'watchdog' | 'notify' | 'field' | 'stat' | 'wake';
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
  /** Diagnostic identity of the leader that supplied the terminal stop bound. */
  stopLeaderId?: string | null;
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
  /**
   * Travel direction of this plan (plan-595). +1: the body drives FRONT first and a
   * route coordinate on a piece is its arc length. -1: the route is MIRRORED — walked
   * over the predecessors, route coordinate x on a piece maps to arc length
   * L − (x − x0) — and the body drives REAR first. Profiles, odometer and route
   * coordinates stay monotone in both directions.
   */
  readonly dir: 1 | -1;
}

/** Body reach (m) of the LEADING end in travel direction `dir` (front forward, rear in reverse). */
export function lead(p: MbParams, dir: 1 | -1): number { return dir === 1 ? p.front : p.rear; }
/** Body reach (m) of the TRAILING end in travel direction `dir` (rear forward, front in reverse). */
export function trail(p: MbParams, dir: 1 | -1): number { return dir === 1 ? p.rear : p.front; }
/** Piece-local route coordinate <-> arc length on the path in travel direction `dir` (involutive). */
function mirrorS(dir: 1 | -1, path: RVPath, s: number): number { return dir === 1 ? s : path.length - s; }

/**
 * Internal switch of the reverse travel (plan-595). Closed until the follower
 * safety (Phase 5) had landed; OPEN since — `AllowReverse` takes effect for
 * project code. Kept as an internal kill switch (and for the retry tests).
 */
let reverseGateOpen = true;

/** @internal plan-595 — open / close the reverse switch (default open; tests close it to provoke refusals). */
export function setReverseGateOpen(open: boolean): void { reverseGateOpen = open; }

/** True while reverse travel is admitted (plan-595 internal gate). */
export function isReverseGateOpen(): boolean { return reverseGateOpen; }

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
  /**
   * End of `path` IN TRAVEL DIRECTION `dir` is a service stop (task destination / dock);
   * `current` = the vehicle's own path. For `dir = -1` the end of a piece is its
   * geometric START (plan-595).
   */
  serviceStopAt(path: RVPath, current: boolean, dir: 1 | -1): boolean;
  /**
   * Zones that must be claimed TOGETHER with `zone` (atomically: all or none) —
   * plan-595 R3-1: a stub manoeuvre claims the merge zone only with its stub zone,
   * so nobody holds the merge zone while waiting for an occupied stub. Absent /
   * null = no companions (every vehicle without a manoeuvre).
   */
  zoneCompanions?(zone: string): readonly string[] | null;
  /** Run && phase driving/cruising && not frozen. */
  canMove(): boolean;
  /** A plan was applied — publish Moving / Blocked. */
  onPlanApplied?(moving: boolean, stoppedByTraffic: boolean): void;
  /** The vehicle reached the end of `prev` (arrival hooks / router notification, de-duplicated by the host). */
  onArrivedAt?(prev: RVPath): void;
  /** The vehicle continues from `prev` onto `next` (piece hand-over of the bookkeeping). */
  onHandOver?(prev: RVPath, next: RVPath): void;
  /**
   * The service stop at the end of `path` (forward) is no longer reachable with
   * the own deceleration — this occurrence is MISSED: the route walk drives on
   * and the vehicle comes back on a later visit (plan-634 F3). Fired once per
   * occurrence (path + odometer of its end), inside the route walk of a re-plan.
   * MUTATION CONTRACT: set host-owned flags only — no assign, no re-plan request,
   * no zone call (the hook runs inside `flush` / `replan`).
   */
  onServiceStopMissed?(path: RVPath): void;
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

/**
 * A GEOMETRIC sensor limit pushed into the authority by a scanner coupling
 * (plan-664 Phase 0). It is the only capability the sensor plan adds to the
 * authority: an obstacle the analytic leader machine cannot see, so it cannot
 * be expressed as a leader.
 *
 * The obstacle position is kept in the vehicle's ODOMETER frame, never in
 * route coordinates (plan-664 R1): route coordinates are re-anchored on every
 * re-plan (`odo0`), so a limit stored in them would silently move with the
 * next plan. Every plan path converts it back with its own `odo0`.
 *
 * The limit is a MEASUREMENT, not a prediction: it is valid for the travel
 * direction it was measured in and is discarded (until the next measurement)
 * when the vehicle turns around or has driven past the obstacle.
 */
export interface SensorLimit {
  /** `clear` = no limit, `warning` = speed cap, `protective` = stop before the obstacle. */
  state: FieldState;
  /** Odometer (m) of the nearest corridor hit — +∞ when the corridor is free. */
  odoObs: number;
  /** Travel direction the measurement was taken in; a plan in the other direction ignores it. */
  dir: 1 | -1;
  /**
   * Protective supplement (m) kept free in front of the obstacle. Carried WITH
   * the limit rather than read from {@link MbParams.scanner}, so the geometric
   * machine works on a vehicle that runs no analytic scanner fields at all
   * (`ScannerFields = false`, plan-664 §2.4 step 2).
   */
  margin: number;
  /** Sim time (s) of the measurement (diagnostics / staleness). */
  measuredAt: number;
}

/**
 * Shift (m) of the obstacle position that counts as a new limit. Below it a
 * fresh measurement of the SAME obstacle neither re-plans nor marks the
 * vehicle dirty (plan-664: `stats.dirtyBy.scanner` must stay bounded).
 */
const SENSOR_SHIFT_M = 0.02;

/**
 * Problems-panel code: a protective sensor halt that a follower can no longer
 * respect with its own deceleration (plan-664 R4). Expected behaviour, not a
 * crash — the follower brakes as hard as it can and the case is named once.
 */
export const SENSOR_CHAIN_INFEASIBLE_CODE = 'sensor-chain-infeasible';

/** Result of {@link MovementAuthority.sensorLimitFor} — a shared scratch, read immediately. */
const _sensorOut = { stopX: Infinity, cap: Infinity };

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
  /** Cruise speed (m/s) of a reverse (dir = -1) plan, capped at `vmax`; absent = vmax (plan-595). */
  reverseVmax?: number;
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
  /** A vehicle met another one on a shared route piece travelling the OPPOSITE way — not projected (plan-595 G2, diagnostics). */
  oppositeEncounters: number;
  /**
   * Hold plans by reason (plan-595 R3-5 parity evidence): `safe` = safe hold after
   * the re-plan cap, `stopped` = brake-to-stop because the vehicle may not move
   * (Run off / servicing), `frozen` = DES failure.
   */
  holdsBy: Record<string, number>;
  /** Safe holds per vehicle id (plan-595 — per-vehicle guard for the tests). */
  safeHoldsBy: Record<string, number>;
  /** Wake-up re-plans after a standing, unchanged safe hold (plan-595). */
  wakes: number;
  /** Refused direction changes (not at standstill, reverse gate closed or exclusivity precondition failed). */
  dirRefused: number;
  /** Service stops missed because they were no longer reachable with the own deceleration — one per occurrence (plan-634 F1/F3). */
  serviceStopsMissed: number;
  /** Applied service plans that stop BEYOND their service stop (> 1 mm) — must stay 0 (plan-634 F8). */
  serviceOvershoot: number;
  /** Applied service plans that stop BEFORE their service stop (> 1 mm): static limits / docking crawl (plan-634 F8, pre-existing, counted only). */
  serviceUndershoot: number;
  /** Turn-point arrivals whose plan position was not the end of the turn piece — no direction change, reported (plan-634 F5). */
  turnGuardTrips: number;
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
  /** Protective sensor halts that could not be reached with the own deceleration (plan-664 §2.4). */
  sensorUnbrakeable: number;
  /** Dependent re-plans caused by a vehicle whose own plan was bound by a sensor limit (plan-664 R4). */
  sensorChainReplans: number;
  /** Sensor halts a follower could no longer respect with its own deceleration (plan-664 R4). */
  sensorChainInfeasible: number;
  /**
   * Orphaned zone claims given back (plan-686 F1): held, on no piece of the new route, not
   * claimed by the plan build, no protected manoeuvre companion, not occupied by the body.
   * Released where the route changes — at a reverse direction change and in the plan build
   * after a route change — or later, once the body has cleared a claim that was occupied then.
   */
  staleClaimsReleased: number;
  /**
   * Orphaned claims found by the safety net only: a plan build WITHOUT a route change released
   * a finite-key claim that was never registered as orphaned (plan-686) — an orphan source
   * nobody handles at its origin. Logged once per vehicle and zone; must stay 0.
   */
  staleClaimsUnexpected: number;
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
/**
 * Wake-up re-plan after a safe hold that left a STANDING vehicle unchanged
 * (plan-595): first after this delay (s), doubled while nothing moves, at most
 * {@link WAKE_MAX_SEC} — one pending per vehicle, never at the same instant.
 */
const WAKE_MIN_SEC = 1e-3;
const WAKE_MAX_SEC = 1;
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
/**
 * Tolerance (m) of the service-stop reachability (plan-634): a stop more than this
 * before the own braking point is missed; also the key tolerance of a missed
 * occurrence and the over- / undershoot threshold of a service plan (F8).
 */
export const SERVICE_STOP_TOL_M = 1e-3;

function newStats(): MbStats {
  return {
    replans: 0, replansChanged: 0, replansSkipped: 0, maxReplansAtInstant: 0, maxReplansAtInstantAfterStart: 0,
    instantsWithReplans: 0, infeasible: 0, keptOld: 0, forced: 0, violations: 0, oppositeEncounters: 0, dirRefused: 0,
    serviceStopsMissed: 0, serviceOvershoot: 0, serviceUndershoot: 0, turnGuardTrips: 0, holdsBy: {}, safeHoldsBy: {}, wakes: 0, minMargin: Infinity,
    watchdogFires: 0, cascadeCapHits: 0, cascadeCapHitsAfterStart: 0, safeHolds: 0, authorityBehind: 0,
    bisections: 0, dependentSkipped: 0, softDeferred: 0, staleLeaderReplans: 0, fieldEvents: 0, fieldStale: 0,
    sensorUnbrakeable: 0, sensorChainReplans: 0, sensorChainInfeasible: 0, staleClaimsReleased: 0, staleClaimsUnexpected: 0,
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
  /**
   * Scanner-field obstacle only (plan-595 R3-3): an OPPOSITE-direction vehicle,
   * held as a standing obstacle at the closest point it reaches on my route
   * (`profile` in my route coordinates, shift 0) with its facing body reach.
   * Absent = a regular leader (u's own profile, trailing end).
   */
  field?: { profile: MotionProfile; reach: number };
}

/** Profile of a field obstacle in its LeaderRef frame (position + shift = my route coordinate). */
function fieldProfileOf(L: LeaderRef): MotionProfile { return L.field ? L.field.profile : L.u.plan.profile; }
/** Body reach (m) of a field obstacle toward me: the trailing end of a leader, the leading end of an opposite vehicle. */
function fieldReachOf(L: LeaderRef): number { return L.field ? L.field.reach : trail(L.u.p, L.u.plan.dir); }

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
  /** Geometric sensor limit pushed in by a scanner coupling (plan-664) — null = none. */
  sensor: SensorLimit | null;
  /** The applied plan is bound (stop or cap) by {@link sensor} — dependents count as sensor cascades. */
  sensorBound: boolean;
  /** `sensor-chain-infeasible` already reported for the current limit (reported once, plan-664 R4). */
  sensorInfeasibleReported: boolean;
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
  /** Travel direction of the NEXT built plan (+1 default, plan-595). */
  dir: 1 | -1;
  /** Explicit route of a dir = -1 plan (stub manoeuvre) — reverse travel makes no routing decisions. */
  fixedRoute: RVPath[] | null;
  /** Fire time of the pending stat event. */
  statEventT: number;
  /** Pending wake-up re-plan after a standing safe hold (−1 = none, plan-595). */
  wakeEvent: number;
  /** Delay (s) of the next wake-up re-plan — doubles while the vehicle stays put. */
  wakeDelay: number;
  locCache: LocCache;
  /** Fire time of each pending zone release event. */
  releaseTimes: Map<string, number>;
  /**
   * Missed service-stop OCCURRENCES (plan-634 F2): path id + odometer of the piece end
   * in travel direction. Skipped by the route walk without a second report; dropped
   * once the rear passed the end, cleared on an executed direction change.
   */
  missedStops: { pathId: string; odoEnd: number }[];
  /**
   * Orphaned claims (plan-686): dropped off the route by a route change while the body still
   * covered them — released silently by a later plan build once the body has cleared them.
   */
  orphans: Set<string>;
  /** Zones the safety net already warned about for this vehicle (one console warning each). */
  orphanWarned: Set<string>;
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
  /** Pure observers of {@link advanceTo} (plan-629) — kept apart from the event state, so they survive {@link reset}. */
  private readonly advanceListeners: ((t: number) => void)[] = [];

  get now(): number { return this._now; }

  /** Number of scheduled events not yet run or cancelled (diagnostics, plan-647 F5). */
  get pendingCount(): number { return this.byId.size; }

  /**
   * Observe the clock (plan-629 gate R2-1): `fn(t)` runs inside
   * {@link advanceTo} BEFORE every due event is taken off the queue (with that
   * event's time) and once after the event loop for the end horizon
   * (`max(t, now)`), before `advanceTo` returns. At each call every event with
   * a time < the argument is processed and none after it is. The listener
   * must only READ (no schedule / cancel); it adds no queue event and changes no
   * order. Listeners survive {@link reset}. Returns the unsubscribe function.
   */
  onBeforeAdvance(fn: (t: number) => void): () => void {
    this.advanceListeners.push(fn);
    return () => {
      const i = this.advanceListeners.indexOf(fn);
      if (i >= 0) this.advanceListeners.splice(i, 1);
    };
  }

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
    const ls = this.advanceListeners;
    for (;;) {
      this.dropCancelledTop();
      const top = this.heap[0];
      if (!top || top.time > t) break;
      if (ls.length > 0) for (let i = 0; i < ls.length; i++) ls[i](top.time);
      this.pop();
      this.byId.delete(top.id);
      this._now = top.time;
      top.fn();
    }
    if (ls.length > 0) {
      const h = t > this._now ? t : this._now;
      for (let i = 0; i < ls.length; i++) ls[i](h);
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

/**
 * One circular wait over capacity-1 zones found by {@link MovementAuthority.findZoneWaitCycles}
 * (plan-686 F2): every member stands with stop cause `zone`; `zones[i]` is the zone
 * `vehicles[i]` waits for - held by `vehicles[i + 1]` (cyclically) or, for a free zone,
 * queued for by `vehicles[i + 1]` ahead of it in the FIFO. Rotated to the smallest id.
 */
export interface ZoneWaitCycle { vehicles: string[]; zones: string[] }

/** Held and awaited zones of one vehicle ({@link MovementAuthority.describeZoneHolds}, plan-686). */
export interface ZoneHoldReport {
  /** Held zones in claim order with the odometer key of the run end (Infinity = exit not routed yet). */
  held: { zone: string; exitOdo: number }[];
  /** Awaited zones: wait start (s, NaN for a passive waiter) and whether the vehicle waits passively. */
  waits: { zone: string; since: number; passive: boolean }[];
}

/** Sampling step (m) of the spatial occupancy check (plan-686 F1, same as the merge-entry check). */
const OCC_STEP_M = 0.05;

export class MovementAuthority {
  private readonly frozenListeners = new Set<(id: string, frozen: boolean) => void>();
  /** Failure transitions, at their exact simulation time. */
  onFrozenChanged(fn: (id: string, frozen: boolean) => void): () => void {
    this.frozenListeners.add(fn);
    return () => { this.frozenListeners.delete(fn); };
  }

  private vehicles = new Map<string, Vehicle>();
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
  private waiters = new Map<string, Map<string, number>>();
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
  /** Opposite-direction field obstacles of the current search (reused, plan-595 R3-3). */
  private readonly oppositeScratch: LeaderRef[] = [];
  /**
   * Service-stop reachability rule (plan-634 F1). Always on — an INTERNAL instance
   * field, no exported switch: only the negative test of the turn-point guard sets it
   * false locally (and restores it in `finally`); `clear()` restores it too.
   */
  private serviceReachCheck = true;
  /** Zones the running {@link planZones} step 3 claimed or confirmed (plan-686 F1, reused). */
  private readonly touchedZones = new Set<string>();
  /** Stale-claim candidates of one plan build (reused). */
  private readonly staleScratch: string[] = [];
  /** Occupancy search labels: shortest distance (m) to the start / end of a piece (reused). */
  private readonly occStart = new Map<RVPath, number>();
  private readonly occEnd = new Map<RVPath, number>();
  private readonly occQueue: RVPath[] = [];
  private readonly occPos = new Vector3();
  private readonly occSample = new Vector3();

  constructor(readonly kind: 'des' | 'continuous') {}

  /** Drop every vehicle, waiter and statistic (model switch / test reset). */
  clear(): void {
    for (const v of this.vehicles.values()) this.forgetSensorProblem(v);
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
    this.serviceReachCheck = true;
    this.clock.reset();
  }

  /**
   * Drop every vehicle, its waits and the per-run flush/instant bookkeeping (a
   * DES run reset) but keep the motion clock, clearance cache, stats, trace and
   * policies — unlike {@link clear}.
   * The next run's setup registers all start poses against an empty fleet.
   */
  releaseVehicles(): void {
    for (const v of this.vehicles.values()) this.forgetSensorProblem(v);
    this.vehicles.clear();
    this.order = [];
    this.waiters.clear();
    // The queue is cleared with the run: a stale flushEventTime (e.g. 0 from the
    // previous start) would suppress the new run's deferred start flush — the
    // first run after a rebuild then differed from the next one.
    this.flushEventTime = Number.NaN;
    this.instant = -1;
    this.replansThisInstant = 0;
    this.lastNow = 0;
  }

  has(id: string): boolean { return this.vehicles.has(id); }

  /** Recreate a visual leg from a saved plan, without scheduling or routing. */
  rebuildLegTween(vehicleId: string, planVersion: number, fromX: number, toX: number,
    saved?: ReturnType<MovementAuthority['prepareState']>): unknown {
    const v = (saved?.vehicles ?? this.vehicles).get(vehicleId);
    if (!v || v.version !== planVersion || !Number.isFinite(fromX) || !Number.isFinite(toX)
      || fromX < v.plan.profile.x0 || fromX > toX || toX !== v.plan.profile.xStop)
      snapshotError('invalid queued leg descriptor');
    const prof = v.plan.profile;
    const sAt = (t: number): number => {
      // Queue prepare precedes container commit. Resolve the committed identity
      // when sampled, rather than closing over a detached preflight vehicle.
      const live = this.vehicles.get(vehicleId);
      if (live?.version === planVersion) live.renderT = t;
      return positionAt(prof, t);
    };
    return v.host.legTween(routeSampler(v.plan.route, v.plan.dir), fromX, toX, sAt);
  }

  /** Data only; capture is forbidden while synchronous planning owns scratch. */
  exportState(): SnapshotJson {
    if (this.flushing || this.callbackDepth > 0 || this.prevWaits !== null)
      throw Object.assign(new Error('fleet.authority: capture during flush/callback'), { code: 'des-snapshot-authority-busy' });
    const vehicles = [...this.vehicles.values()].map(v => {
      const data: Record<string, unknown> = {};
      for (const key of vehicleStateKeys) data[key] = v[key];
      // A plan built without a leader leaves `stopLeaderId` undefined (plan-2059 phase 8: AGV in downtime); store it as null.
      data.plan = { ...v.plan, stopLeaderId: v.plan.stopLeaderId ?? null, route: encodeRoute(v.plan.route) };
      data.fixedRoute = v.fixedRoute?.map(p => p.id) ?? null;
      for (const key of ['usedLeaders', 'releaseEvents', 'held', 'releaseTimes'] as const) data[key] = [...v[key]];
      data.orphans = [...v.orphans]; data.orphanWarned = [...v.orphanWarned];
      data.fieldLeader = v.fieldLeader ? { ...v.fieldLeader, u: v.fieldLeader.u.id } : null;
      data.traveler = { pathId: v.traveler.path?.id ?? null, s: v.traveler.s, v: v.traveler.v,
        blocked: v.traveler.blocked, atEnd: v.traveler.atEnd };
      data.leg = { vehicleId: v.id, planVersion: v.version, fromX: v.plan.profile.x0, toX: v.plan.profile.xStop };
      return data;
    });
    return encodeAuthorityData({ vehicles, waiters: [...this.waiters].map(([z, w]) => [z, [...w]]),
      flushEventTime: this.flushEventTime, instant: this.instant, replansThisInstant: this.replansThisInstant,
      lastNow: this.lastNow, stats: { ...this.stats, flushMs: 0 /* wall-clock profiling, not model state */ }, trace: this.trace, replanCap: this.replanCap, serviceReachCheck: this.serviceReachCheck });
  }

  validateState(json: unknown): readonly string[] {
    try { this.prepareState(json); return []; }
    catch (error) { return [error instanceof Error ? error.message : String(error)]; }
  }

  /** Allocate and link without changing live travelers, caches, hosts or registries. */
  prepareState(json: unknown) {
    const data = record(decodeAuthorityData(json));
    if (!Array.isArray(data.vehicles)) snapshotError('vehicles missing');
    const vehicles = new Map<string, Vehicle>();
    const travelers: Array<{ live: PathTraveler; path: RVPath | null; s: number; v: number; blocked: boolean; atEnd: boolean }> = [];
    const leaders = new Map<string, Record<string, any>>();
    for (const item of data.vehicles) {
      const d = record(item), live = this.vehicles.get(d.id);
      if (!live || vehicles.has(d.id)) snapshotError(`unknown or duplicate vehicle '${d.id}'`);
      for (const key of vehicleStateKeys) if (!Object.hasOwn(d, key)) snapshotError(`missing vehicle field '${key}'`);
      const v = {} as Vehicle;
      for (const key of vehicleStateKeys) Object.assign(v, { [key]: d[key] });
      const p = record(d.plan);
      v.plan = { ...p, route: decodeRoute(p.route), profile: decodeMotionProfile(encodeAuthorityData(p.profile)),
        staticLimits: decodeLimitPieces(encodeAuthorityData(p.staticLimits)) } as MbPlan;
      if (![1, -1].includes(p.dir) || ![1, -1].includes(d.dir)
        || !['service', 'deadend', 'horizon', 'zone', 'zonePending', 'leader', 'hold', 'field'].includes(p.stopCause)
        || typeof p.leaderBound !== 'boolean' || typeof p.capped !== 'boolean') snapshotError('invalid plan');
      numeric(p.freeEnd); numeric(p.odo0, true);
      if (p.stopLeaderId !== undefined && p.stopLeaderId !== null && typeof p.stopLeaderId !== 'string') snapshotError('invalid stop leader');
      for (const key of ['curIdx', 'version', 'replansAtInstant', 'motionIdx'])
        if (!Number.isSafeInteger(d[key]) || d[key] < 0) snapshotError(`invalid ${key}`);
      if (d.curIdx >= v.plan.route.length) snapshotError('route cursor out of range');
      for (const key of ['dirty', 'routeDecided', 'frozen', 'sensorBound', 'sensorInfeasibleReported', 'external', 'softStale'])
        if (typeof d[key] !== 'boolean') snapshotError(`invalid ${key}`);
      for (const key of ['fieldCap', 'fieldRestartAt', 'renderT', 'lastExtendT', 'statEventT', 'wakeDelay']) numeric(d[key]);
      if (d.prevPathId !== null) resolveSnapshotPath(d.prevPathId);
      if (!Array.isArray(d.motionMarks) || !Array.isArray(d.missedStops)) snapshotError('invalid vehicle lists');
      for (const m of d.motionMarks) {
        numeric(record(m).t, true);
        if (!['free', 'slowed', 'stopped'].includes(m.state)) snapshotError('invalid motion mark');
      }
      for (const m of d.missedStops) { resolveSnapshotPath(record(m).pathId); numeric(m.odoEnd, true); }
      if (d.sensor !== null) {
        const s = record(d.sensor);
        if (!['clear', 'warning', 'protective'].includes(s.state) || ![1, -1].includes(s.dir)) snapshotError('invalid sensor');
        numeric(s.odoObs); numeric(s.margin, true); numeric(s.measuredAt, true);
      }
      if (!['clear', 'warning', 'protective'].includes(d.field) || !['free', 'slowed', 'stopped'].includes(d.motion)) snapshotError('invalid vehicle state');
      const params = record(d.p);
      if (params.reverseVmax !== undefined) numeric(params.reverseVmax, true);
      for (const key of ['vmax', 'a', 'b', 'aLat', 'front', 'rear', 'width', 'gap', 'dockSpeed', 'dockDist']) numeric(params[key], true);
      if (params.scanner !== null) for (const key of ['reactionTime', 'protectiveMargin', 'warningMargin', 'hysteresis', 'restartDelay']) numeric(record(params.scanner)[key], true);
      for (const key of ['usedLeaders', 'releaseEvents', 'held', 'releaseTimes'] as const) {
        v[key] = tupleMap(d[key]); for (const n of v[key].values()) numeric(n);
      }
      for (const key of ['held', 'releaseEvents', 'releaseTimes'] as const)
        for (const zone of v[key].keys()) if (!getDefaultZoneRegistry().has(zone)) snapshotError(`unknown zone '${zone}'`);
      for (const key of ['orphans', 'orphanWarned'] as const) {
        if (!Array.isArray(d[key]) || d[key].some((s: unknown) => typeof s !== 'string') || new Set(d[key]).size !== d[key].length) snapshotError('invalid zone set');
        v[key] = new Set(d[key]);
      }
      const handle = (n: unknown): void => { if (!Number.isSafeInteger(n) || (n as number) < -1 || (n as number) >= 2 ** 32) snapshotError('invalid event handle'); };
      for (const key of ['legEvent', 'extendEvent', 'watchdogEvent', 'fieldEvent', 'statEvent', 'wakeEvent']) handle(d[key]);
      if (!Array.isArray(d.notifyEvents)) snapshotError('invalid notify handles');
      d.notifyEvents.forEach(handle); v.releaseEvents.forEach(handle);
      if (d.fixedRoute !== null && !Array.isArray(d.fixedRoute)) snapshotError('invalid fixed route');
      v.fixedRoute = d.fixedRoute === null ? null : d.fixedRoute.map(resolveSnapshotPath);
      const tr = record(d.traveler);
      numeric(tr.s, true); numeric(tr.v, true);
      if (typeof tr.blocked !== 'boolean' || typeof tr.atEnd !== 'boolean') snapshotError('invalid traveler');
      const path = tr.pathId === null ? null : resolveSnapshotPath(tr.pathId);
      const leg = record(d.leg);
      if (leg.vehicleId !== d.id || leg.planVersion !== d.version || leg.fromX !== v.plan.profile.x0 || leg.toX !== v.plan.profile.xStop) snapshotError('invalid leg descriptor');
      travelers.push({ live: live.traveler, path, s: tr.s, v: tr.v, blocked: tr.blocked, atEnd: tr.atEnd });
      v.traveler = live.traveler; v.host = live.host;
      v.locCache = { t: NaN, plan: null, cur: -1, path: path ?? v.plan.route[0].path, s: 0, x: 0, v: 0, idx: 0 };
      if (d.fieldLeader !== null) leaders.set(v.id, record(d.fieldLeader));
      v.fieldLeader = null;
      vehicles.set(v.id, v);
    }
    if (vehicles.size !== this.vehicles.size) snapshotError('missing vehicle ID');
    for (const [id, l] of leaders) {
      const u = vehicles.get(l.u); if (!u) snapshotError(`unknown leader '${l.u}'`);
      for (const key of ['shift', 'domainStart', 'domainEnd', 'xNow', 'G']) numeric(l[key]);
      if (typeof l.diverged !== 'boolean') snapshotError('invalid leader projection');
      const field = l.field ? { profile: decodeMotionProfile(encodeAuthorityData(l.field.profile)), reach: l.field.reach } : undefined;
      if (field) numeric(field.reach, true);
      vehicles.get(id)!.fieldLeader = { ...l, u, ...(field ? { field } : {}) } as LeaderRef;
    }
    const waiters = new Map<string, Map<string, number>>();
    for (const [z, entries] of tupleMap(data.waiters)) {
      if (!getDefaultZoneRegistry().has(z)) snapshotError(`unknown zone '${z}'`);
      const w = tupleMap(entries);
      for (const [id, n] of w) { if (!vehicles.has(id)) snapshotError(`unknown waiter '${id}'`); numeric(n); }
      waiters.set(z, w);
    }
    for (const key of ['flushEventTime', 'instant', 'replansThisInstant', 'lastNow', 'replanCap']) numeric(data[key]);
    if (!Number.isFinite(data.lastNow) || !Number.isSafeInteger(data.replanCap) || data.replanCap < 1
      || !Number.isSafeInteger(data.replansThisInstant) || data.replansThisInstant < 0) snapshotError('invalid authority counters');
    if (typeof data.serviceReachCheck !== 'boolean') snapshotError('invalid service reach policy');
    const stats = record(data.stats);
    for (const [key, value] of Object.entries(this.stats)) {
      if (typeof value === 'number') numeric(stats[key]);
      else for (const n of Object.values(record(stats[key]))) numeric(n);
    }
    if (data.trace !== null && !Array.isArray(data.trace)) snapshotError('invalid trace');
    if (data.trace) for (const entry of data.trace) {
      const e = record(entry); numeric(e.t, true);
      if (typeof e.kind !== 'string' || typeof e.id !== 'string') snapshotError('invalid trace entry');
    }
    return { vehicles, waiters, travelers, order: [...vehicles.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), data };
  }

  /** Commit only prepared references/scalars. No callbacks, scheduling or routing. */
  swapState(prepared: ReturnType<MovementAuthority['prepareState']>): void {
    this.vehicles = prepared.vehicles; this.waiters = prepared.waiters; this.order = prepared.order;
    for (const t of prepared.travelers) {
      t.live.path = t.path; t.live.s = t.s; t.live.v = t.v; t.live.blocked = t.blocked; t.live.atEnd = t.atEnd;
    }
    this.clearance.clear();
    const d = prepared.data;
    this.flushEventTime = d.flushEventTime; this.instant = d.instant; this.replansThisInstant = d.replansThisInstant;
    this.lastNow = d.lastNow; this.stats = d.stats; this.trace = d.trace;
    this.replanCap = d.replanCap; this.serviceReachCheck = d.serviceReachCheck;
  }

  /** @internal Own-key guard seam; exposes no mutable vehicle state. */
  __vehicleKeysForTest(id: string): (string | symbol)[] {
    const vehicle = this.vehicles.get(id);
    if (!vehicle) throw new Error(`Unknown vehicle: ${id}`);
    return Reflect.ownKeys(vehicle);
  }

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
        leaderBound: false, freeEnd: traveler.s, staticLimits: [], capped: false, odo0: 0, dir: 1,
      },
      curIdx: 0, version: 0, usedLeaders: new Map(), dirty: true, replansAtInstant: 0,
      legEvent: -1, extendEvent: -1, watchdogEvent: -1, fieldEvent: -1, statEvent: -1, notifyEvents: [],
      releaseEvents: new Map(), held: new Map(), prevPathId: null, routeDecided: true, frozen: false,
      field: 'clear', fieldCap: Infinity, fieldRestartAt: -1, fieldLeader: null,
      sensor: null, sensorBound: false, sensorInfeasibleReported: false,
      motion: 'free', motionMarks: [], motionIdx: 0, renderT: now, lastExtendT: -Infinity, external: false, softStale: false, dir: 1, fixedRoute: null, statEventT: -1, wakeEvent: -1, wakeDelay: WAKE_MIN_SEC,
      locCache: { t: Number.NaN, plan: null, cur: -1, path, s: 0, x: 0, v: 0, idx: 0 }, releaseTimes: new Map(),
      missedStops: [], orphans: new Set(), orphanWarned: new Set(),
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
    this.forgetSensorProblem(v);
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
    for (const fn of this.frozenListeners) fn(id, true);
    this.forgetEventIds(v);
    this.dirty(v, 'freeze');
    this.requestFlush(v.host);
  }

  /** Resume after a freeze: the vehicle re-plans from its standstill. */
  resume(id: string): void {
    const v = this.vehicles.get(id);
    if (!v || !v.frozen) return;
    v.frozen = false;
    for (const fn of this.frozenListeners) fn(id, false);
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
   * so mixed fleets stay safe. This holds for EXTERNAL vehicles only — they have
   * no travel direction; planned vehicles may reverse (plan-595), and an external
   * one that reverses is outside this guarantee (residual of plan-595).
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
      freeEnd: t.s, staticLimits: [], capped: false, odo0: 0, dir: 1,
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

  /**
   * Change the travel direction of the NEXT plan (plan-595, stub manoeuvre).
   * Only at STANDSTILL (plan ended, speed 0) — otherwise refused (false, counted
   * in `dirRefused`). `route` (dir = -1 only) is the explicit mirrored route,
   * starting with the piece the vehicle stands on. The change invalidates the
   * routing record. A reverse change is refused while the internal reverse gate
   * is closed ({@link setReverseGateOpen}).
   */
  setDirection(id: string, dir: 1 | -1, route: RVPath[] | null = null): boolean {
    const v = this.vehicles.get(id);
    if (!v) return false;
    const now = v.host.now();
    if (dir === -1 && !reverseGateOpen) { this.stats.dirRefused++; return false; }
    if (speedAt(v.plan.profile, now) > 1e-9 || v.plan.profile.tEnd > now + 1e-9) { this.stats.dirRefused++; return false; }
    if (dir === -1) {
      // Exclusivity precondition (G2): every piece of the reverse route lies in a
      // capacity-1 zone and the vehicle HOLDS the zone of the piece it starts on.
      // Further zones are claimed by planZones before the LEADING end (lead = rear)
      // enters them — the reverse plan stops at the entrance otherwise, so the
      // vehicle never reverses into a piece it does not own.
      const zones = getDefaultZoneRegistry();
      if (!route || route[0] !== v.traveler.path) { this.stats.dirRefused++; return false; }
      for (const q of route) {
        if (!q.zoneId || zones.capacityOf(q.zoneId) !== 1) { this.stats.dirRefused++; return false; }
      }
      if (!zones.isHolder(route[0].zoneId!, id)) { this.stats.dirRefused++; return false; }
    }
    // An executed direction change starts a new frame: missed occurrences of the old
    // direction are meaningless now (plan-634 F2) — a refused or same-direction call keeps them.
    if (dir !== v.dir) v.missedStops.length = 0;
    v.dir = dir;
    v.fixedRoute = dir === -1 ? route : null;
    // plan-686: the reverse route is known here — claims of the old route that it does not
    // contain are given back NOW (the body standing at the turn point may still cover one:
    // that one is registered as orphaned and released once the body has left it).
    v.routeDecided = false;
    this.dirty(v, 'direction');
    if (dir === -1 && route && v.held.size > 0) {
      // A release wakes waiters (onZoneAvailable -> requestFlush): no synchronous flush may
      // run in the middle of this call (shared scratch state, half-applied direction change)
      // — the callback depth defers it to a flush event at this instant (review 686 #1).
      const entries: RouteEntry[] = route.map((path) => ({ path, x0: 0 }));
      this.callbackDepth++;
      try {
        this.touchedZones.clear();
        this.releaseStaleClaims(v, entries, now, true);
      } finally {
        this.callbackDepth--;
      }
      // The caller requests the re-plan (unchanged contract); woken waiters got a deferred flush.
    }
    return true;
  }

  /** Travel direction (+1 / -1) of the applied plan of `id` (+1 when unknown). */
  planDirOf(id: string): 1 | -1 {
    const v = this.vehicles.get(id);
    return v ? v.plan.dir : 1;
  }

  /**
   * Claim `zone` for `id` outside a route walk (plan-595 manoeuvre admission):
   * held with an unknown exit until a plan routes through it. False when the
   * zone is full or another vehicle waits for it longer.
   */
  holdZone(id: string, zone: string, now: number): boolean {
    const v = this.vehicles.get(id);
    if (!v) return false;
    const zones = getDefaultZoneRegistry();
    if (zones.isHolder(zone, id)) { if (!v.held.has(zone)) v.held.set(zone, Infinity); return true; }
    if (!this.isHeadWaiter(zone, id, now) || !zones.claim(zone, id)) { this.addWaiter(zone, id, now); return false; }
    this.removeWaiter(zone, id);
    v.held.set(zone, Infinity);
    return true;
  }

  /**
   * Give up a claim taken by {@link holdZone} / a companion claim that no route
   * has run through yet (unknown exit) — the vehicle is not in that zone
   * (plan-595 manoeuvre abort before the reverse leg). No-op otherwise.
   */
  dropZone(id: string, zone: string): void {
    const v = this.vehicles.get(id);
    if (!v || v.held.get(zone) !== Infinity) return;
    if (v.traveler.path?.zoneId === zone) return;
    this.removeWaiter(zone, id);
    this.releaseHeld(v, zone);
  }

  private newEpoch(): void {
    for (const v of this.vehicles.values()) this.forgetSensorProblem(v);
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

  /**
   * Remaining distance (m) along the APPLIED plan to the next service stop
   * ahead; +∞ when the plan reaches none (plan-664 Phase 0, docking field).
   *
   * Walks the plan's own route and asks the host — `plan.stopCause` alone is not
   * enough (it carries the BINDING cause, so a traffic stop in front of the dock
   * hides it) and a MISSED occurrence (plan-634) must not count as a stop. A
   * task change rebuilds the route, so the answer follows it without extra state.
   */
  serviceStopAheadOf(id: string, t: number): number {
    const v = this.vehicles.get(id);
    if (!v) return Infinity;
    const plan = v.plan;
    const x = positionAt(plan.profile, t);
    for (let i = v.curIdx; i < plan.route.length; i++) {
      const e = plan.route[i];
      const end = e.x0 + e.path.length;
      if (end < x - SERVICE_STOP_TOL_M) continue;
      if (!v.host.serviceStopAt(e.path, i === v.curIdx, plan.dir)) continue;
      if (plan.dir === 1 && this.findMissed(v, e.path, plan.odo0 + end) >= 0) continue;
      return Math.max(0, end - x);
    }
    return Infinity;
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

  /**
   * Plan position (m, UNclamped) at the host's now minus the end of the current,
   * synchronised route entry (plan-634 F5): 0 = standing exactly at the end of the
   * piece, > 0 = beyond it, < 0 = short of it. The plan state, not the clamped
   * `traveler.s` — read it after the leg end synced the vehicle (0 when unknown).
   */
  overshootOf(id: string): number {
    const v = this.vehicles.get(id);
    if (!v) return 0;
    const e = v.plan.route[v.curIdx];
    return positionAt(v.plan.profile, v.host.now()) - (e.x0 + e.path.length);
  }

  /**
   * The end of the current route entry is a MISSED service-stop occurrence of `id`
   * (plan-634 F2a): same path, odometer of the end within {@link SERVICE_STOP_TOL_M}.
   * Read at an arrival — such an arrival serves nothing.
   */
  missedAtEnd(id: string): boolean {
    const v = this.vehicles.get(id);
    if (!v || v.missedStops.length === 0) return false;
    const e = v.plan.route[v.curIdx];
    return this.findMissed(v, e.path, v.plan.odo0 + e.x0 + e.path.length) >= 0;
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
    c.s = mirrorS(v.plan.dir, e.path, Math.min(Math.max(0, x - e.x0), e.path.length));
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
        v.traveler.s = v.plan.dir === 1 ? prev.length : 0;
        return;
      }
      v.prevPathId = prev.id;
      v.curIdx = k;
      v.host.onHandOver?.(prev, r[k].path);
    }
    v.curIdx = idx;
    v.traveler.s = mirrorS(v.plan.dir, r[idx].path, Math.min(Math.max(0, x - r[idx].x0), r[idx].path.length));
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

  /**
   * Push the geometric sensor limit of `id` (plan-664 Phase 0). The vehicle is
   * marked dirty ONLY when the limit really changed — a different state, or the
   * obstacle shifted by more than {@link SENSOR_SHIFT_M} — so a scanner
   * delivering the same obstacle 25 times a second re-plans once. Returns true
   * when the limit changed.
   *
   * A real change re-plans RIGHT HERE (`requestFlush` on the vehicle's own
   * host): called from the fleet input stage that is before `clock.advanceTo`,
   * so the step that measures an obstacle is the step that brakes for it
   * (plan-664 SOL #2). The caller needs no second call and cannot forget it.
   *
   * `state: 'clear'` is equivalent to {@link clearSensorLimit}.
   */
  setSensorLimit(id: string, limit: SensorLimit): boolean {
    const v = this.vehicles.get(id);
    if (!v) return false;
    if (limit.state === 'clear' || !Number.isFinite(limit.odoObs)) return this.clearSensorLimit(id);
    const old = v.sensor;
    const same = old !== null && old.state === limit.state && old.dir === limit.dir
      && Math.abs(old.odoObs - limit.odoObs) <= SENSOR_SHIFT_M && old.margin === limit.margin;
    v.sensor = { state: limit.state, odoObs: limit.odoObs, dir: limit.dir, margin: limit.margin, measuredAt: limit.measuredAt };
    if (same) return false;
    this.forgetSensorProblem(v);
    this.dirty(v, 'scanner');
    this.requestFlush(v.host);
    return true;
  }

  /** Drop the geometric sensor limit of `id`; true when one was dropped (the vehicle re-plans at once). */
  clearSensorLimit(id: string): boolean {
    const v = this.vehicles.get(id);
    if (!v || !v.sensor) return false;
    v.sensor = null;
    this.forgetSensorProblem(v);
    this.dirty(v, 'scanner');
    this.requestFlush(v.host);
    return true;
  }

  /**
   * Retire the `sensor-chain-infeasible` entry of `v` and re-arm the one-shot
   * report. Called whenever the limit it described is replaced or gone — the
   * panel must not keep warning about an obstacle that is no longer there.
   */
  private forgetSensorProblem(v: Vehicle): void {
    if (!v.sensorInfeasibleReported) return;
    v.sensorInfeasibleReported = false;
    clearProblem(`${SENSOR_CHAIN_INFEASIBLE_CODE}:${v.id}`);
  }

  /** The geometric sensor limit currently held for `id` (read-only diagnostics). */
  sensorLimitOf(id: string): Readonly<SensorLimit> | null {
    return this.vehicles.get(id)?.sensor ?? null;
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
    // A late task can make the docking crawl infeasible even though the
    // destination is beyond the emergency braking point. Finish braking,
    // then plan the remaining distance from rest; this is not an arrival.
    if (v.plan.stopCause === 'service' && !v.plan.profile.feasible &&
      v.plan.profile.xStop < v.plan.freeEnd - SERVICE_STOP_TOL_M) {
      this.dirty(v, 'service-short-stop');
    }
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
      case 'wake':
        v.wakeEvent = -1;
        this.stats.wakes++;
        this.dirty(v, 'wake');
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
          v.wakeDelay = WAKE_MIN_SEC;
        }
        if (changed !== 0) {
          // Non-dominating change → every dependent MUST re-plan (safety).
          // Dominating (only faster, same route) → only followers whose plan
          // the leader actually shapes; the rest stay safe as they are.
          // plan-664 R4: re-plans a SENSOR-bound vehicle pushes down its queue are
          // counted separately — the cascade a geometric obstacle costs.
          const sensorCascade = v.sensorBound;
          for (const u of this.order) {
            if (u === v || !u.usedLeaders.has(v.id)) continue;
            if (changed === 2) { this.dirty(u, 'dependent-hard'); if (sensorCascade) this.stats.sensorChainReplans++; }
            else if (!u.plan.leaderBound) this.stats.dependentSkipped++;
            else if (u.motion !== 'free' || u.plan.profile.tEnd <= now + 1e-9) { this.dirty(u, 'dependent-soft'); if (sensorCascade) this.stats.sensorChainReplans++; }
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
    const sGeo = path === cur.path ? cur.s : v.traveler.s;
    const speed = cur.v;
    const p = v.p;

    const canMove = !v.frozen && v.host.canMove();
    // A hold keeps the frame of the applied plan, a new plan is built in v.dir (plan-595).
    const oldDir = v.plan.dir;
    const s = mirrorS(canMove ? v.dir : oldDir, path, sGeo);
    if (!canMove && speed <= 1e-9 && v.plan.profile.tEnd <= now) {
      // Already standing at the end of the plan — a hold changes nothing (and a
      // standing vehicle respects every limit ahead of it, plan-664 R2).
      v.usedLeaders.clear();
      v.fieldLeader = null;
      v.sensorBound = false;
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
      const why = v.frozen ? 'frozen' : 'stopped';
      this.stats.holdsBy[why] = (this.stats.holdsBy[why] ?? 0) + 1;
      // Run off / frozen / servicing: brake to a stop with the own deceleration
      // — but never earlier than the vehicles queued behind can absorb (and
      // never beyond the authority already granted).
      const off = v.plan.route[v.curIdx]?.path === path ? v.plan.route[v.curIdx].x0 : 0;
      const granted = Math.max(s, v.plan.profile.xStop - off);
      const xBrakeHold = s + (speed * speed) / (2 * p.b);
      let xs = Math.max(xBrakeHold, Math.min(this.chainNeed(v, now), granted));
      // plan-664 R2: the hold path must honour the sensor limit too — this plan
      // bypasses `buildPlanInner`, so without this a Run-off hold could end
      // BEHIND the obstacle the scanner just stopped for.
      let holdCause: StopCause = 'hold';
      v.sensorBound = false;
      const slHold = this.sensorLimitFor(v, s, now, oldDir);
      if (slHold.stopX < Infinity) {
        if (slHold.stopX < xBrakeHold - 1e-9) this.stats.sensorUnbrakeable++;
        const xSens = Math.max(xBrakeHold, slHold.stopX);
        if (xSens < xs) { xs = xSens; holdCause = 'field'; v.sensorBound = true; }
      }
      const route = this.reanchoredRoute(v, path);
      const lim = this.holdLimits(v, route, s, xs, speed, oldDir);
      plan = {
        route, stopCause: holdCause, leaderBound: false, freeEnd: xs,
        staticLimits: lim, capped: false, odo0: this.odoAt(v, now) - s, dir: oldDir,
        profile: speed > 1e-6 ? planProfile(now, s, speed, lim, p.a, p.b, xs) : stationaryProfile(now, s),
      };
    } else {
      plan = this.buildPlan(v, path, s, speed, now);
      const changed = this.adopt(v, plan, now);
      // plan-634 F8: the FINAL plan of this re-plan (never a bisection candidate) —
      // a service plan ends AT its service stop (freeEnd; no traffic stop lowered it).
      if (plan.stopCause === 'service') {
        const d = plan.profile.xStop - plan.freeEnd;
        if (d > SERVICE_STOP_TOL_M) this.stats.serviceOvershoot++;
        else if (d < -SERVICE_STOP_TOL_M) this.stats.serviceUndershoot++;
      }
      return changed;
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
    let comparable = plan.dir === old.dir; // a direction change is never "the same trajectory"
    let sameRoute = comparable;
    let diverge = -1; // first new-route index that differs from the old route
    for (let i = 0; comparable && i < plan.route.length && v.curIdx + i < old.route.length; i++) {
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
      old.stopLeaderId = plan.stopLeaderId;
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
   * no later than the current plan's authority AND before the CURRENT trailing
   * end of every leader on the route minus the gap (a same-direction leader
   * never drives back in route coordinates, and an opposite-direction vehicle
   * is never projected as a leader — G2 —, so that point stays clear for all
   * future time). Cruise and curve limits of the plan's direction apply (R3-5).
   * Braking uses the own deceleration;
   * an unavoidable overrun is an emergency stop (counted `forced`).
   */
  private applySafeHold(v: Vehicle, now: number): 0 | 1 | 2 {
    this.stats.safeHolds++;
    this.stats.holdsBy.safe = (this.stats.holdsBy.safe ?? 0) + 1;
    this.sync(v, now);
    const cur = this.loc(v, now);
    const path = v.traveler.path!;
    const holdDir = v.plan.dir; // the safe hold stays in the frame of the applied plan
    const s = mirrorS(holdDir, path, path === cur.path ? cur.s : v.traveler.s);
    const speed = cur.v;
    const p = v.p;
    const route = this.reanchoredRoute(v, path);
    const off = v.plan.route[v.curIdx]?.path === path ? v.plan.route[v.curIdx].x0 : 0;
    let stopX = Math.max(s, v.plan.profile.xStop - off);
    let cause: StopCause = v.plan.stopCause;
    let stopLeaderId = v.plan.stopLeaderId ?? null;
    if (v.frozen || !v.host.canMove()) {
      // A vehicle that may not move brakes now (queue behind permitting).
      const xs = Math.max(s + (speed * speed) / (2 * p.b), Math.min(this.chainNeed(v, now), stopX));
      if (xs < stopX) { stopX = xs; cause = 'hold'; }
    }
    v.usedLeaders.clear();
    v.fieldLeader = null;
    for (const L of this.findLeaders(v, route, s, now, holdDir, null)) {
      v.usedLeaders.set(L.u.id, L.u.version);
      const x = L.xNow - L.G;
      if (x < stopX) { stopX = Math.max(s, x); cause = 'leader'; stopLeaderId = L.u.id; }
    }
    // plan-664 R2: the safe hold is the third plan path — it must not end behind
    // the scanner obstacle either.
    v.sensorBound = false;
    const slSafe = this.sensorLimitFor(v, s, now, holdDir);
    if (slSafe.stopX < Infinity) {
      const xSens = Math.max(s + (speed * speed) / (2 * p.b), slSafe.stopX);
      if (xSens < stopX) { stopX = xSens; cause = 'field'; stopLeaderId = null; v.sensorBound = true; }
    }
    const lim = this.holdLimits(v, route, s, Math.max(stopX, s), speed, holdDir);
    let profile = planProfile(now, s, speed, lim, p.a, p.b, stopX);
    if (!profile.feasible) this.stats.forced++;
    if (!Number.isFinite(profile.tEnd)) profile = stationaryProfile(now, s);
    const changed = this.adopt(v, {
      route, profile, stopCause: cause, stopLeaderId, leaderBound: true, freeEnd: profile.xStop, staticLimits: lim, capped: false,
      odo0: this.odoAt(v, now) - s, dir: holdDir,
    }, now);
    this.stats.safeHoldsBy[v.id] = (this.stats.safeHoldsBy[v.id] ?? 0) + 1;
    // Liveness: the hold is conservative — a MOVING vehicle (or a changed plan)
    // re-plans normally at its next own event (leg end / stat mark) after this
    // instant. A vehicle STANDING at the end of an unchanged plan has no own
    // event left (plan-595: found as a permanent standstill after a cap hit at
    // a DES resume) — it gets a wake-up re-plan at a later instant.
    v.softStale = true;
    if (changed === 0 && v.plan.profile.tEnd <= now + EPS) this.scheduleWake(v);
    return changed;
  }

  /**
   * Schedule the wake-up re-plan of a standing vehicle (one pending at most).
   * Never at the same instant (its re-plan count must be fresh) — the delay
   * starts at {@link WAKE_MIN_SEC} and doubles up to {@link WAKE_MAX_SEC} while
   * the vehicle keeps landing in an unchanged standing safe hold (e.g. a cap of
   * 0); a normal re-plan resets it.
   */
  private scheduleWake(v: Vehicle): void {
    if (v.wakeEvent >= 0) return;
    v.wakeEvent = v.host.schedule(v.wakeDelay, 'wake', null, null);
    v.wakeDelay = Math.min(WAKE_MAX_SEC, v.wakeDelay * 2);
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
   *
   * plan-634 F1: a FORWARD service stop before `xBrake - tol` (the own braking
   * point) is unreachable — it is missed (once per occurrence, see
   * {@link serviceStopMissed}) and the walk drives on. `odoPiece` = odometer of
   * route coordinate 0 (start of the current piece) — the key frame of the
   * missed occurrences. Reverse plans are unchanged (F9).
   */
  private walkRoute(
    v: Vehicle, path: RVPath, s: number, xBrake: number, odoPiece: number,
  ): { route: RouteEntry[]; acc: number; stopX: number; cause: StopCause } {
    const host = v.host;
    const route: RouteEntry[] = [{ path, x0: 0 }];
    let acc = path.length;
    if (host.serviceStopAt(path, true, v.dir)
      && (v.dir === -1 || !this.serviceStopMissed(v, path, acc, xBrake, odoPiece))) {
      return { route, acc, stopX: path.length, cause: 'service' };
    }
    if (v.dir === -1) {
      // A reverse plan follows its EXPLICIT stub route (no reverse routing decisions)
      // and always ends in a stop at its end (service stop or dead end).
      const fr = v.fixedRoute ?? [];
      const k = fr.indexOf(path);
      for (let i = k + 1; k >= 0 && i < fr.length; i++) {
        route.push({ path: fr[i], x0: acc });
        acc += fr[i].length;
        if (host.serviceStopAt(fr[i], false, -1)) return { route, acc, stopX: acc, cause: 'service' };
      }
      return { route, acc, stopX: acc, cause: 'deadend' };
    }
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
      if (host.serviceStopAt(next, false, 1) && !this.serviceStopMissed(v, next, acc, xBrake, odoPiece)) {
        return { route, acc, stopX: acc, cause: 'service' };
      }
    }
    return { route, acc, stopX: acc - lead(v.p, v.dir) - STOP_MARGIN, cause: 'horizon' };
  }

  /**
   * plan-634 F1-F3: is the forward service stop at route coordinate `x` (end of
   * `path`) a MISSED occurrence? Already listed (same path, odometer of the end
   * within the tolerance) → yes, silently. Otherwise unreachable (`x` before the
   * own braking point `xBrake` by more than the tolerance) → listed, counted and
   * reported once through the host hook. Reachable → no (a stop as before).
   */
  private serviceStopMissed(v: Vehicle, path: RVPath, x: number, xBrake: number, odoPiece: number): boolean {
    const odoEnd = odoPiece + x;
    if (this.findMissed(v, path, odoEnd) >= 0) return true;
    if (!this.serviceReachCheck || x >= xBrake - SERVICE_STOP_TOL_M) return false;
    v.missedStops.push({ pathId: path.id, odoEnd });
    this.stats.serviceStopsMissed++;
    if (v.host.onServiceStopMissed) {
      this.callbackDepth++;
      try { v.host.onServiceStopMissed(path); } finally { this.callbackDepth--; }
    }
    return true;
  }

  /** Index of the missed occurrence (path, end odometer) of `v` (−1 = none). */
  private findMissed(v: Vehicle, path: RVPath, odoEnd: number): number {
    const list = v.missedStops;
    for (let i = 0; i < list.length; i++) {
      if (list[i].pathId === path.id && Math.abs(list[i].odoEnd - odoEnd) <= SERVICE_STOP_TOL_M) return i;
    }
    return -1;
  }

  /**
   * Cruise + curve (v² ≤ aLat·R) + docking limits over the route as ONE
   * contiguous, disjoint, sorted piece list over [0, acc] (route coords).
   * Built from the per-path curvature intervals (cached by the path) in a
   * single pass; equal neighbours are merged so the planner sees few pieces.
   */
  private staticLimits(v: Vehicle, route: readonly RouteEntry[], acc: number, serviceStop: number, dir: 1 | -1): LimitPiece[] {
    const p = v.p;
    const vmax = this.vmaxOf(v, dir);
    const vmax2 = vmax * vmax;
    const out: LimitPiece[] = [];
    const push = (x0: number, x1: number, c0: number): void => {
      if (x1 - x0 <= 1e-12) return;
      const last = out[out.length - 1];
      if (last && last.c0 === c0 && Math.abs(last.x1 - x0) < 1e-12) { last.x1 = x1; return; }
      out.push({ x0, x1, c0, c1: 0 });
    };
    const mirrored = dir === -1;
    for (const e of route) {
      const ivs = e.path.curvatureIntervals();
      if (ivs.length === 0) { push(e.x0, e.x0 + e.path.length, vmax2); continue; }
      const L = e.path.length;
      for (let k = 0; k < ivs.length; k++) {
        // A mirrored piece is walked from its end: intervals in reverse order, both
        // bounds mirrored — the limit list stays sorted and on the right stretch.
        const c = mirrored ? ivs[ivs.length - 1 - k] : ivs[k];
        const lim = Number.isFinite(c.radiusM) ? Math.min(vmax2, p.aLat * c.radiusM) : vmax2;
        if (mirrored) push(e.x0 + (L - c.s1), e.x0 + (L - c.s0), lim);
        else push(e.x0 + c.s0, e.x0 + c.s1, lim);
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

  /**
   * Limits of a HOLD plan (Run off / frozen / servicing brake, safe hold) over
   * [s, xEnd + 1] in direction `dir` (the frame of the applied plan): the
   * route's cruise and (mirrored) curve limits — a hold never drives faster
   * than the plan it replaces (plan-595 R3-5). The current speed stays
   * admissible on the first piece (the hold brakes from it); beyond the route
   * the cruise speed of `dir` applies.
   */
  private holdLimits(v: Vehicle, route: readonly RouteEntry[], s: number, xEnd: number, speed: number, dir: 1 | -1): LimitPiece[] {
    const last = route[route.length - 1];
    const statics = this.staticLimits(v, route, last.x0 + last.path.length, -1, dir);
    const hi = xEnd + 1;
    const out: LimitPiece[] = [];
    for (const q of statics) {
      if (q.x1 <= s || q.x0 >= hi) continue;
      out.push({ x0: Math.max(q.x0, s), x1: Math.min(q.x1, hi), c0: q.c0, c1: 0 });
    }
    const vm = this.vmaxOf(v, dir);
    const end = out.length ? out[out.length - 1].x1 : s;
    if (end < hi) out.push({ x0: end, x1: hi, c0: vm * vm, c1: 0 });
    out[0].c0 = Math.max(out[0].c0, speed * speed);
    return out;
  }

  /** Cruise speed (m/s) in travel direction `dir` — a reverse plan uses `reverseVmax` (plan-595). */
  private vmaxOf(v: Vehicle, dir: 1 | -1): number {
    return dir === -1 && v.p.reverseVmax !== undefined ? Math.min(v.p.vmax, v.p.reverseVmax) : v.p.vmax;
  }

  private buildPlanInner(v: Vehicle, path: RVPath, s: number, speed: number, now: number): MbPlan {
    const p = v.p;
    // 0. Odometer of route coordinate 0 and the own braking point (plan-634 F1):
    // v²/(2b) is exactly the emergency stop of the profile (no jerk limit). The
    // missed-stop keys use the piece start of the APPLIED plan when the vehicle is
    // still on it in the same direction — that frame survives a clamped `s`.
    const odo0 = this.odoAt(v, now) - s;
    const xBrake = s + (speed * speed) / (2 * p.b);
    const curE = v.plan.route[v.curIdx];
    const odoPiece = curE?.path === path && v.plan.dir === v.dir ? v.plan.odo0 + curE.x0 : odo0;
    // A route change (task change, routing re-decision, path edit, direction change) is where
    // claims of the old route can drop off it (plan-686) — captured before the walk re-decides.
    const routeChanged = !v.routeDecided || v.plan.dir !== v.dir;
    // 1. Route walk (decisions reused, R2-5).
    const walk = this.walkRoute(v, path, s, xBrake, odoPiece);
    const route = walk.route;
    let stopX = walk.stopX;
    let cause = walk.cause;
    let stopLeaderId: string | null = null;
    const freeEnd = stopX;
    // 2. Static limits: cruise + curve v² ≤ aLat·R + docking crawl.
    const statics = this.staticLimits(v, route, walk.acc, cause === 'service' ? stopX : -1, v.dir);

    // 3. Leaders on the own route (trajectory projection). Only the NEAREST
    // leader binds (it is itself held behind the ones ahead — transitivity);
    // further ones only while the nearer one diverges off this route. A just
    // diverged vehicle (rear still sweeping the lane) always counts.
    const opposite = this.oppositeScratch;
    opposite.length = 0;
    const all = this.findLeaders(v, route, s, now, v.dir, opposite).sort((x, y) => x.xNow - y.xNow
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
    // The scanner field sees opposite-direction vehicles too (R3-3) — the nearest facing end wins.
    for (const O of opposite) {
      if (!v.fieldLeader || O.xNow - O.field!.reach < this.fieldFront(v.fieldLeader, now)) v.fieldLeader = O;
    }
    opposite.length = 0;
    for (const L of leaders) {
      v.usedLeaders.set(L.u.id, L.u.version);
      const up = L.u.plan.profile;
      if (up.xStop <= L.domainEnd + EPS) {
        const auth = up.xStop + L.shift - L.G;
        if (auth < stopX) { stopX = auth; cause = 'leader'; stopLeaderId = L.u.id; }
      }
    }

    // 4. Zones.
    const z = this.planZones(v, route, s, now, stopX, leaders, odo0, routeChanged);
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
        if (xs < stopX) { stopX = xs; cause = 'field'; stopLeaderId = v.fieldLeader?.u.id ?? null; }
      } else if (v.field === 'warning' && v.fieldCap < this.vmaxOf(v, v.dir)) {
        fieldCap = v.fieldCap;
        capped = true;
      }
    }

    // 5b. Geometric sensor limit (plan-664). An obstacle the leader machine
    // cannot see: the protective halt is deliberately NOT pushed out to
    // `chainNeed` (a real obstacle must not be driven over). A queue behind that
    // can no longer absorb the halt brakes with its own deceleration and is
    // reported once (R4). The warning state feeds the SAME cap as the analytic
    // field (R3) — one mechanism, not a second one.
    v.sensorBound = false;
    const sl = this.sensorLimitFor(v, s, now, v.dir);
    if (sl.stopX < Infinity) {
      if (sl.stopX < xBrake - 1e-9) this.stats.sensorUnbrakeable++;
      const xs = Math.max(xBrake, sl.stopX);
      if (xs < stopX) {
        stopX = xs;
        cause = 'field';
        stopLeaderId = null;
        v.sensorBound = true;
        this.checkSensorChain(v, xs, now);
      }
    } else if (sl.cap < this.vmaxOf(v, v.dir) && sl.cap < fieldCap) {
      fieldCap = sl.cap;
      capped = true;
      v.sensorBound = true;
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
      let ok = old.dir === v.dir && old.route[v.curIdx].path === path && old.profile.xStop - off <= stopX + 1e-6;
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
          stopLeaderId: old.stopLeaderId,
          leaderBound: true, freeEnd, staticLimits: statics, capped, odo0, dir: old.dir,
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
    return { route, profile: prof, stopCause: cause, stopLeaderId, leaderBound, freeEnd, staticLimits: statics, capped, odo0, dir: v.dir };
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
    leaders: readonly LeaderRef[], odo0: number, routeChanged = false,
  ): { stopX: number; cause: StopCause } {
    const zones = getDefaultZoneRegistry();
    const n = route.length;
    // Leading body end in travel direction of the plan being built (plan-595).
    const front = lead(v.p, v.dir);
    let outStop = Infinity;
    let outCause: StopCause = 'zone';
    // 0. Direction change (plan-595 B): every held key is an odometer exit in the
    // frame of the APPLIED plan — meaningless once the body drives the other way
    // (the odometer keeps growing while the body moves back into the zone). All
    // keys become "exit unknown": step 2 re-keys every zone this route runs
    // through in the NEW frame, every other one stays held until a later plan
    // routes through it (conservative — never released while the body covers it).
    if (v.plan.dir !== v.dir) for (const z of v.held.keys()) v.held.set(z, Infinity);
    // 1. Release visits whose rear has cleared the run end (trailing end in the
    // frame the keys were made in — equal to v.dir after step 0).
    const odoRear = odo0 + s - trail(v.p, v.plan.dir);
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
      const run = this.zoneRun(route, i, odo0, v.dir);
      const ex = v.held.get(z)!;
      const mine = (i === 0 && run.start <= odo0 + s + EPS)
        || (Number.isFinite(ex) ? ex > run.start + EPS && ex <= run.end + EPS : this.firstRunOf(route, z) === i);
      if (mine) v.held.set(z, run.open ? Infinity : run.end);
    }
    // 3. Zone runs along the route, plus the run the body overhangs at a stop.
    const touched = this.touchedZones;
    touched.clear();
    for (let i = 0; i <= n; i++) {
      let z: string | null;
      let entry: number;
      let exitVal: number;
      if (i < n) {
        z = route[i].path.zoneId;
        if (!z) continue;
        if (i > 0 && route[i - 1].path.zoneId === z) continue; // not a run start
        const run = this.zoneRun(route, i, odo0, v.dir);
        entry = route[i].x0;
        exitVal = run.open ? Infinity : run.end;
      } else {
        // Overhang beyond the route end (service stop / dead end at a piece
        // end): the body front reaches into the successor's zone — claimed
        // open-ended until a later plan routes through it.
        const last = route[n - 1].path;
        const end = route[n - 1].x0 + last.length;
        if (Math.min(stopX, outStop) + front <= end + EPS) break;
        const succ = (v.dir === 1 ? last.successors : last.predecessors).find((q) => q.zoneId && q.zoneId !== last.zoneId) ?? null;
        if (!succ) break;
        z = succ.zoneId!;
        entry = end;
        exitVal = Infinity;
      }
      if (entry >= Math.min(stopX, outStop) + front - EPS) break; // the front never reaches it
      if (zones.isHolder(z, v.id)) {
        touched.add(z);
        const ex = v.held.get(z);
        if (ex === undefined || ex === exitVal || i === 0) {
          v.held.set(z, exitVal);
          continue;
        }
        // Still held from an EARLIER visit (rear not clear) — cannot take this
        // one yet; the own release wakes it like any waiter.
        const zs = Math.max(s, entry - front - STOP_MARGIN);
        if (zs < outStop) { outStop = zs; outCause = 'zone'; }
        this.addWaiter(z, v.id, now);
        break;
      }
      // Zone stop (plan-595 #194, plan-618 F5): assumes the zone geometry
      // encloses the BODIES of its participants — only the own front enters
      // here; the width / rear overhang of a body on another branch or on the
      // merge piece does not. That gap is covered as a REPORT by
      // findShortMergeEntries (Problems `agv-merge-entry-too-short`, counted in
      // Agv getMergeEntryCheckStats); pulling the stop back (variant b) is
      // deferred until those numbers justify it. Deliberately unchanged.
      const zStop = Math.max(s, entry - front - STOP_MARGIN);
      if (entry <= s + EPS) {
        // root already inside an unheld zone (start-up) — take it if possible
        if (this.claimWithCompanions(v, z, now) === 'ok') { v.held.set(z, exitVal); touched.add(z); continue; }
        if (s < outStop) { outStop = s; outCause = 'zone'; }
        this.addWaiter(z, v.id, now);
        break;
      }
      const vm = this.vmaxOf(v, v.dir);
      const claimWindow = (vm * vm) / (2 * v.p.b) + vm * CLAIM_LEAD_SEC + CLAIM_MARGIN_M;
      if (entry - (s + front) > claimWindow) {
        if (zStop < outStop) { outStop = zStop; outCause = 'zonePending'; }
        break;
      }
      // Queue-order guard: a vehicle between me and the entrance claims first.
      let leaderBefore = false;
      for (const L of leaders) if (L.xNow > s && L.xNow <= entry + EPS) { leaderBefore = true; break; }
      const claim = leaderBefore || !this.isHeadWaiter(z, v.id, now) ? 'zone' : this.claimWithCompanions(v, z, now);
      if (claim !== 'ok') {
        // Behind a leader that claims first: PASSIVE waiter (woken on release,
        // no priority — it must never outrank the leader it queues behind).
        // Blocked by a companion zone (R3-1): passive as well — the vehicle in
        // the stub needs `z` to leave, and only that frees the companion.
        this.addWaiter(z, v.id, leaderBefore || claim === 'companion' ? Number.NaN : now);
        if (zStop < outStop) { outStop = zStop; outCause = 'zone'; }
        break;
      }
      this.removeWaiter(z, v.id);
      v.held.set(z, exitVal);
      touched.add(z);
    }
    // 4. Orphaned claims (plan-686 F1): a vehicle holds only zones its body may occupy or
    // its current route still runs through. Claims drop off the route where the route
    // changes — a task change, a routing re-decision, a path edit, a direction change — and
    // the route only ever comes into being here, so this is their source: a held zone on no
    // piece of the new route, not claimed or confirmed by step 3, no protected manoeuvre
    // companion (K before M, plan-595 R3-1) and not occupied by the body is given back.
    // One the body still covers is registered as orphaned and released by a later plan
    // build once the body has left it. Zones beyond the stop on the route stay.
    if (v.held.size > touched.size) this.releaseStaleClaims(v, route, now, routeChanged);
    else if (v.orphans.size > 0) this.pruneOrphans(v, route);
    return { stopX: outStop, cause: outCause };
  }

  /**
   * plan-686 F1 (see {@link planZones} step 4 and {@link setDirection}): give back the held
   * zones that lie on no piece of `route`, were not claimed by the running plan build
   * ({@link touchedZones}), are no protected manoeuvre companion and are not occupied.
   *
   * Expected (silent) releases: at a route change (`routeChanged`), a claim registered as
   * orphaned earlier ({@link Vehicle.orphans}) and a claim with an unknown exit (key ∞: taken
   * outside a route walk — holdZone / companion / overhang — or made unknown by a direction
   * change). Anything else is the SAFETY NET: an orphan source nobody handled at its origin —
   * released all the same, counted in `staleClaimsUnexpected` and warned once per vehicle and
   * zone. Short-circuits when every held zone is on the route.
   */
  private releaseStaleClaims(v: Vehicle, route: readonly { path: RVPath }[], now: number, routeChanged: boolean): void {
    const cand = this.staleScratch;
    cand.length = 0;
    for (const z of v.held.keys()) {
      if (this.touchedZones.has(z)) continue;
      let onRoute = false;
      for (let i = 0; i < route.length; i++) if (route[i].path.zoneId === z) { onRoute = true; break; }
      if (!onRoute) cand.push(z);
    }
    if (cand.length === 0) { if (v.orphans.size > 0) this.pruneOrphans(v, route); return; }
    const companions = v.host.zoneCompanions;
    if (companions) {
      for (const h of v.held.keys()) {
        const ks = companions(h);
        if (!ks) continue;
        for (const k of ks) { const j = cand.indexOf(k); if (j >= 0) cand.splice(j, 1); }
      }
    }
    for (let i = 0; i < cand.length; i++) {
      const z = cand[i];
      // Key Infinity = an exit no route walk ever confirmed: a claim taken outside a route walk
      // (holdZone, companion, overhang, open run) or made unknown by a direction change —
      // all of them sources this release handles by design.
      const known = routeChanged || v.orphans.has(z) || v.held.get(z) === Infinity;
      if (this.zoneMayBeOccupied(v, z, now)) {
        // Still covered: released once the body has left it (a finite key of the current
        // route frame is released by step 1 anyway — only route-change orphans are kept here).
        if (known) v.orphans.add(z);
        continue;
      }
      this.removeWaiter(z, v.id);
      this.releaseHeld(v, z);
      this.stats.staleClaimsReleased++;
      if (!known) {
        this.stats.staleClaimsUnexpected++;
        if (!v.orphanWarned.has(z)) {
          v.orphanWarned.add(z);
          console.warn(`[MovementAuthority] '${v.id}': orphaned claim on zone '${z}' released by the safety net at t=${now.toFixed(3)} s `
            + '(no route change, not registered as orphaned) — an orphan source that is not handled at its origin (plan-686)');
        }
      }
    }
    cand.length = 0;
    if (v.orphans.size > 0) this.pruneOrphans(v, route);
  }

  /** Drop orphan marks of zones the vehicle no longer holds or that its route (any piece) runs through again. */
  private pruneOrphans(v: Vehicle, route: readonly { path: RVPath }[]): void {
    for (const z of v.orphans) {
      let onRoute = this.touchedZones.has(z);
      for (let i = 0; !onRoute && i < route.length; i++) if (route[i].path.zoneId === z) onRoute = true;
      if (!v.held.has(z) || onRoute) v.orphans.delete(z);
    }
  }

  /**
   * Conservative occupancy of zone `z` by the body of `v` (plan-686 F1): true when the
   * GRAPH check (an undirected shortest-path search over the pieces from the geometric
   * pose; radius = longest body reach + rear clearance + stop margin + the actual clamping
   * distance of the applied plan) or the SPATIAL check (body disc around the world pose
   * against centre-line samples of the zone's pieces, widened by the widest registered
   * body) can reach it. A superset of every body orientation.
   */
  private zoneMayBeOccupied(v: Vehicle, z: string, now: number): boolean {
    const path = v.traveler.path;
    if (!path || path.zoneId === z) return true;
    const p = v.p;
    const len = path.length;
    const s = Math.min(Math.max(v.traveler.s, 0), len);
    // Clamping distance: how far the plan position lies outside the piece the pose is clamped to.
    let c = 0;
    const e = v.plan.route[v.curIdx];
    if (e && e.path === path) {
      const u = positionAt(v.plan.profile, now) - e.x0;
      c = Math.abs(u - Math.min(Math.max(u, 0), len));
    }
    const reach = Math.max(p.front, p.rear);
    const R = reach + REAR_CLEAR_M + STOP_MARGIN + c;
    // 1. Graph check over piece end points, undirected: a junction point is the end of
    // every predecessor and the start of every successor of a piece.
    const dS = this.occStart, dE = this.occEnd, q = this.occQueue;
    dS.clear(); dE.clear(); q.length = 0;
    let hit = false;
    const relax = (m: Map<RVPath, number>, piece: RVPath, d: number): void => {
      if (d >= R) return;
      const old = m.get(piece);
      if (old !== undefined && old <= d) return;
      m.set(piece, d);
      if (piece.zoneId === z) hit = true;
      q.push(piece);
    };
    relax(dS, path, s);
    relax(dE, path, len - s);
    for (let guard = 0; q.length > 0 && !hit && guard < 4096; guard++) {
      const piece = q.shift()!;
      const ds = dS.get(piece), de = dE.get(piece);
      if (ds !== undefined) {
        relax(dE, piece, ds + piece.length);
        for (const pr of piece.predecessors) relax(dE, pr, ds);
      }
      if (de !== undefined) {
        relax(dS, piece, de + piece.length);
        for (const sc of piece.successors) relax(dS, sc, de);
      }
    }
    dS.clear(); dE.clear(); q.length = 0;
    if (hit) return true;
    // 2. Spatial check: body disc around the reference point vs. the zone's centre lines.
    let wMax = p.width;
    for (const u of this.order) if (u.p.width > wMax) wMax = u.p.width;
    const lim = Math.hypot(reach, p.width / 2) + wMax / 2 + OCC_STEP_M / 2 + STOP_MARGIN + c;
    const pos = path.getAbsPosition(s, this.occPos);
    const net = this.network ?? getDefaultPathNetwork();
    for (const piece of net.all()) {
      if (piece.zoneId !== z) continue;
      const k = Math.max(1, Math.ceil(piece.length / OCC_STEP_M));
      for (let i = 0; i <= k; i++) {
        const sp = piece.getAbsPosition(Math.min(piece.length, (i * piece.length) / k), this.occSample);
        if (Math.hypot(sp.x - pos.x, sp.z - pos.z) < lim) return true;
      }
    }
    return false;
  }

  /**
   * Claim `z` together with the host's companion zones of `z` — all or none
   * (plan-595 R3-1, K before M). A companion that is full or has an earlier
   * waiter blocks the whole claim (the vehicle waits for it, outside `z`);
   * claimed companions are held with an unknown exit until a plan routes
   * through them. Without companions this is exactly `zones.claim`.
   * 'companion' = blocked by a companion zone, 'zone' = `z` itself is full.
   */
  private claimWithCompanions(v: Vehicle, z: string, now: number): 'ok' | 'zone' | 'companion' {
    const zones = getDefaultZoneRegistry();
    const extra = v.host.zoneCompanions?.(z) ?? null;
    if (extra) {
      for (const k of extra) {
        if (zones.isHolder(k, v.id)) continue;
        if (zones.holderCount(k) >= zones.capacityOf(k) || !this.isHeadWaiter(k, v.id, now)) {
          this.addWaiter(k, v.id, now);
          return 'companion';
        }
      }
    }
    if (!zones.claim(z, v.id)) return 'zone';
    if (extra) {
      for (const k of extra) {
        this.touchedZones.add(k);
        if (zones.isHolder(k, v.id)) continue;
        zones.claim(k, v.id);
        this.removeWaiter(k, v.id);
        v.held.set(k, Infinity);
      }
    }
    return 'ok';
  }

  /** The zone run starting at route index i: odometer start / end, open = continues beyond the route. */
  private zoneRun(route: readonly RouteEntry[], i: number, odo0: number, dir: 1 | -1): { start: number; end: number; open: boolean } {
    const z = route[i].path.zoneId;
    let j = i;
    while (j + 1 < route.length && route[j + 1].path.zoneId === z) j++;
    // A mirrored route continues over the predecessors.
    const open = j === route.length - 1 && (dir === 1 ? route[j].path.successors : route[j].path.predecessors).some((q) => q.zoneId === z);
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
    v.orphans.delete(z);
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
      for (const L of this.findLeaders(f, route, mirrorS(f.plan.dir, lf.path, lf.s), now, f.plan.dir, null)) if (L.u === u && !L.diverged) { ref = L; break; }
      if (!ref) continue;
      seen.add(f);
      const fStop = Math.max(mirrorS(f.plan.dir, lf.path, lf.s) + (lf.v * lf.v) / (2 * f.p.b), this.chainNeed(f, now, depth + 1, seen));
      const n = fStop + ref.G - ref.shift - uAnchor;
      if (n > need) need = n;
    }
    return need;
  }

  /** Vehicles ahead on v's route (or just diverged off it) with their projection. */
  private findLeaders(
    v: Vehicle, route: readonly RouteEntry[], s: number, now: number, vdir: 1 | -1, opposite: LeaderRef[] | null,
  ): LeaderRef[] {
    const out: LeaderRef[] = [];
    for (const u of this.order) {
      if (u === v) continue;
      const lu = this.loc(u, now);
      const uRoute = u.plan.route;
      const uIdx = lu.idx;
      const uStart = uRoute[uIdx].x0;
      const udir = u.plan.dir;
      let e = -1;
      for (let i = 0; i < route.length; i++) {
        if (route[i].path !== lu.path) continue;
        // Compare in v's route coordinates (u's piece-local coordinate is v's only when both travel the same way).
        if (i > 0 || mirrorS(vdir, lu.path, lu.s) > s + 1e-9) { e = i; break; }
      }
      if (e >= 0 && udir !== vdir) {
        // G2 (plan-595): an OPPOSITE-direction vehicle on v's route is never projected — the
        // exclusivity invariant (reverse travel only inside a held capacity-1 zone run) keeps v
        // out of that run; counted for the tests.
        this.stats.oppositeEncounters++;
        // R3-3: for the scanner field it stays an obstacle. It moves TOWARD v, so the field sees
        // it standing at the closest point it reaches on v's route — its current position or,
        // further on, where its plan stops — with its LEADING end facing v. Conservative, and the
        // gap to it can never shrink (the field exit stays a first crossing).
        if (opposite) {
          let X = route[e].x0 + mirrorS(vdir, lu.path, lu.s);
          const xStop = u.plan.profile.xStop;
          let j = e;
          for (let k = uIdx; k < uRoute.length && uRoute[k].x0 <= xStop + EPS; k++) {
            const q = uRoute[k].path;
            while (j >= 0 && route[j].path !== q) j--; // u drives toward v: earlier pieces of v's route
            if (j < 0) break;
            const local = Math.max(0, Math.min(q.length, xStop - uRoute[k].x0));
            X = Math.min(X, route[j].x0 + mirrorS(vdir, q, mirrorS(udir, q, local)));
          }
          const reach = lead(u.p, udir);
          opposite.push({
            u, shift: 0, domainStart: -Infinity, domainEnd: Infinity, xNow: X, G: lead(v.p, vdir) + reach + v.p.gap,
            diverged: false, field: { profile: stationaryProfile(now, X), reach },
          });
        }
        continue;
      }
      const G = lead(v.p, vdir) + trail(u.p, udir) + v.p.gap;
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
      // Only for two forward vehicles (a reverse run is exclusive — G2).
      if (vdir !== 1 || udir !== 1) continue;
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
    if (v.wakeEvent >= 0) h.cancel(v.wakeEvent);
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
    v.wakeEvent = -1;
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
    // The extension point must use the SAME cruise speed as the claim window of this
    // plan's direction — with p.vmax (forward) a reverse plan re-checks too early, stays
    // 'zonePending' and gets no second extension (stands until the watchdog).
    const vm = this.vmaxOf(v, v.plan.dir);
    const xb = prof.xStop - (vm * vm) / (2 * v.p.b) - 0.3;
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
    const sampler = routeSampler(v.plan.route, v.plan.dir);
    const sAt = (t: number): number => { v.renderT = t; return positionAt(prof, t); };
    const c = v.plan.stopCause;
    const shortService = c === 'service' && !prof.feasible && prof.xStop < v.plan.freeEnd - SERVICE_STOP_TOL_M;
    const kind: MbEventKind = (c === 'service' && !shortService) || c === 'deadend' ? 'arrival' : 'stop';
    const tween = h.legTween(sampler, x, prof.xStop, sAt);
    tagLegTween(tween, { leg: { vehicleId: v.id, planVersion: v.version, fromX: x, toX: prof.xStop },
      t0: now, t1: now + (prof.tEnd - now), duration: prof.tEnd - now });
    v.legEvent = h.schedule(prof.tEnd - now, kind, null, tween);
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
    if (v.missedStops.length > 0) {
      // plan-634 F2: a missed occurrence is done once the rear passed its end (same odometer frame).
      const odoRear = v.plan.odo0 + x - trail(v.p, v.plan.dir);
      const list = v.missedStops;
      let w = 0;
      for (let i = 0; i < list.length; i++) if (odoRear <= list[i].odoEnd + SERVICE_STOP_TOL_M) list[w++] = list[i];
      list.length = w;
    }
    for (const [zone, ex] of [...v.held]) {
      if (!Number.isFinite(ex)) continue; // run end not routed yet — kept
      const relX = ex + trail(v.p, v.plan.dir) + REAR_CLEAR_M - v.plan.odo0;
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

  // ── Geometric sensor limit (plan-664 Phase 0) ───────────────────────────

  /**
   * Translate the pushed sensor limit into the frame of the plan being built
   * (R1): the obstacle is stored in the ODOMETER frame, `odo0` of this plan is
   * `odoAt(v, now) − s`. Returns `{ stopX, cap }`, each `+∞` when it does not
   * bind. The returned object is a shared scratch — read it before the next call.
   *
   * A limit measured in the other travel direction, or one the vehicle has
   * already driven past, is DROPPED here (not just ignored): it is a
   * measurement, and the next scan delivers a fresh one.
   *
   * `stopX` is a ROOT coordinate, so the LEADING body reach comes off as well:
   * `odoObs` is where the obstacle is, the body must keep `margin` in front of
   * it, and route coordinates address the root (the same bookkeeping the
   * analytic field does through {@link lead} in `fieldGap`). Without it the
   * vehicle's nose would stop `front` metres INSIDE the obstacle.
   */
  private sensorLimitFor(v: Vehicle, s: number, now: number, dir: 1 | -1): { stopX: number; cap: number } {
    _sensorOut.stopX = Infinity;
    _sensorOut.cap = Infinity;
    const lim = v.sensor;
    if (!lim) return _sensorOut;
    const drop = (): void => { v.sensor = null; this.forgetSensorProblem(v); };
    if (lim.dir !== dir) { drop(); return _sensorOut; }
    const xObs = lim.odoObs - (this.odoAt(v, now) - s);
    if (xObs < s - 1e-9) { drop(); return _sensorOut; }
    if (lim.state === 'warning') _sensorOut.cap = v.p.dockSpeed;
    else _sensorOut.stopX = xObs - lim.margin - lead(v.p, dir);
    return _sensorOut;
  }

  /**
   * R4: the sensor halt at `stopX` is binding — can every vehicle queued behind
   * still respect it with its own deceleration? If not, say so ONCE per limit:
   * the followers brake as hard as they can (no silent overlap), and the case is
   * named in the Problems panel and counted.
   */
  private checkSensorChain(v: Vehicle, stopX: number, now: number): void {
    if (v.sensorInfeasibleReported) return;
    const need = this.chainNeed(v, now);
    if (!Number.isFinite(need) || stopX >= need - 1e-6) return;
    v.sensorInfeasibleReported = true;
    this.stats.sensorChainInfeasible++;
    const behind: string[] = [];
    for (const u of this.order) if (u !== v && u.usedLeaders.has(v.id)) behind.push(u.id);
    reportProblem({
      id: `${SENSOR_CHAIN_INFEASIBLE_CODE}:${v.id}`,
      severity: 'warning',
      code: SENSOR_CHAIN_INFEASIBLE_CODE,
      title: `'${v.id}' stops for a scanner obstacle the vehicles behind cannot absorb`,
      detail: `The geometric scanner of '${v.id}' halts it ${(need - stopX).toFixed(2)} m earlier than the queue `
        + `behind it (${behind.length ? behind.join(', ') : 'followers'}) can still respect with its own `
        + 'deceleration. Those vehicles brake as hard as they can; the obstacle keeps priority. Increase the '
        + 'following gap, lower the speed, or keep the obstacle out of the lane.',
    });
  }

  // ── Scanner fields (R2-7) ───────────────────────────────────────────────

  /** Body gap (m, leading end of v to trailing end of the field leader) at time t, plan being built (v.dir); +∞ without leader. */
  private fieldGap(v: Vehicle, s: number, t: number): number {
    const L = v.fieldLeader;
    if (!L) return Infinity;
    if (L.domainEnd < Infinity && positionAt(L.u.plan.profile, t) > L.domainEnd) return Infinity;
    return this.fieldFront(L, t) - lead(v.p, v.dir) - s;
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
      else if (gap > this.warningExitLength(v, v.dir) + EPS) { v.field = 'clear'; v.fieldCap = Infinity; }
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

  /** Gap (m) above which the warning field releases: W(cruise speed in direction `dir`) + hysteresis. */
  private warningExitLength(v: Vehicle, dir: 1 | -1): number {
    const sc = v.p.scanner!;
    return fieldLength(this.vmaxOf(v, dir), sc.reactionTime, v.p.b, sc.protectiveMargin) + sc.warningMargin + sc.hysteresis;
  }

  private enterWarning(v: Vehicle, now: number): void {
    const L = v.fieldLeader;
    const vl = L ? speedAt(fieldProfileOf(L), now) : 0;
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
    const shiftBody = L ? L.shift - fieldReachOf(L) - lead(v.p, v.plan.dir) + off : 0;
    const lp = L ? fieldProfileOf(L) : null;
    if (v.field === 'protective') {
      if (v.fieldRestartAt >= 0) { tNext = v.fieldRestartAt; to = 'clear'; }
      else {
        // Exit = standstill AND gap > protective margin + hysteresis; the restart
        // follows after the restart delay. The gap of a standing vehicle never
        // shrinks: a same-direction leader moves on along the route (it never
        // drives back in route coordinates), an opposite-direction one is held
        // at the closest point it reaches (R3-3) — so the first crossing is the exit.
        const te = L
          ? earliestCrossing(v.plan.profile, lp!, shiftBody, now, L.domainEnd,
            0, 0, v.p.b, sc.protectiveMargin + sc.hysteresis, +1)
          : now;
        if (te < Infinity) { tNext = Math.max(te, v.plan.profile.tEnd, now) + sc.restartDelay; to = 'clear'; }
      }
    } else if (L) {
      // Entry into the protective field (both from clear and warning).
      const tp = earliestCrossing(v.plan.profile, lp!, shiftBody, now, L.domainEnd,
        1, sc.reactionTime, v.p.b, sc.protectiveMargin, -1);
      if (v.field === 'clear') {
        const tw = earliestCrossing(v.plan.profile, lp!, shiftBody, now, L.domainEnd,
          1, sc.reactionTime, v.p.b, sc.protectiveMargin + sc.warningMargin, -1);
        if (tw <= tp) { tNext = tw; to = 'warning'; } else { tNext = tp; to = 'protective'; }
      } else {
        // Exit: the gap exceeds the warning field at the speed the vehicle
        // drives once the cap is lifted (its cruise speed), plus the
        // hysteresis — so neither its own braking under the cap nor the
        // re-acceleration after the release re-triggers the field at once.
        const tx = earliestCrossing(v.plan.profile, lp!, shiftBody, now, L.domainEnd, 0, 0, v.p.b,
          this.warningExitLength(v, v.plan.dir), +1);
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

  /**
   * Re-project the nearest field obstacle on the current (unchanged) plan route:
   * the nearest leader — and, separately from the G2 leader projection, every
   * opposite-direction vehicle on the route (R3-3: it stays a field obstacle).
   */
  private refreshFieldLeader(v: Vehicle, now: number): void {
    this.sync(v, now);
    const cur = this.loc(v, now);
    const base = v.plan.route[cur.idx].x0;
    const route: RouteEntry[] = [];
    for (let i = cur.idx; i < v.plan.route.length; i++) route.push({ path: v.plan.route[i].path, x0: v.plan.route[i].x0 - base });
    const opposite = this.oppositeScratch;
    opposite.length = 0;
    let best: LeaderRef | null = null;
    for (const L of this.findLeaders(v, route, mirrorS(v.plan.dir, cur.path, cur.s), now, v.plan.dir, opposite)) {
      if (L.diverged) continue;
      if (!best || L.xNow < best.xNow || (L.xNow === best.xNow && L.u.id < best.u.id)) best = L;
    }
    for (const O of opposite) if (!best || O.xNow - O.field!.reach < this.fieldFront(best, now)) best = O;
    opposite.length = 0;
    v.fieldLeader = best;
  }

  /** Facing body end of a field obstacle (my route coordinates) at time t. */
  private fieldFront(L: LeaderRef, t: number): number {
    return positionAt(fieldProfileOf(L), t) + L.shift - fieldReachOf(L);
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

  /** Pull-only follower diagnostics; deliberately outside the legacy zone detector. */
  followWaitEdges(): WaitEdge[] {
    const out: WaitEdge[] = [];
    for (const v of this.order) {
      if (v.external || (v.plan.stopCause !== 'leader' && v.plan.stopCause !== 'field')) continue;
      const now = v.host.now(), pr = v.plan.profile;
      if (speedAt(pr, now) > 1e-9 || pr.tEnd > now + 1e-9) continue;
      const id = v.plan.stopLeaderId;
      if (!id || id === v.id || !this.vehicles.has(id)) continue;
      out.push({ waiterId: v.id, resourceId: `leader:${id}`, ownerIds: [id],
        kind: 'follow', sinceSimSec: NaN, analysed: true });
    }
    return out;
  }

  /** Read-only wait graph; holder mode preserves the legacy detector or includes mixed waits. */
  zoneWaitEdges(opts: { holders: 'nodes' | 'all' }): WaitEdge[] {
    const zones = getDefaultZoneRegistry();
    const nodes: Vehicle[] = [];
    for (const v of this.order) {
      if (v.external) continue;
      const now = v.host.now();
      const pr = v.plan.profile;
      if (v.plan.stopCause === 'zone' && speedAt(pr, now) <= 1e-9 && pr.tEnd <= now + 1e-9) nodes.push(v);
    }
    const isNode = new Set(nodes.map(v => v.id));
    const out: WaitEdge[] = [];
    for (const [z, w] of this.waiters) {
      if (w.size === 0) continue;
      const capacityOne = zones.capacityOf(z) === 1;
      const free = zones.holderCount(z) === 0;
      for (const [vid, t] of w) {
        if (!isNode.has(vid)) continue;
        const seen = new Set<string>();
        for (const h of opts.holders === 'nodes' ? nodes : this.order) {
          if (h.id === vid || !h.held.has(z)) continue;
          seen.add(h.id);
          out.push({ waiterId: vid, resourceId: z, ownerIds: [h.id], kind: 'zone-holder',
            sinceSimSec: t, analysed: capacityOne && !h.external,
            ...(!capacityOne ? { notAnalysedReason: 'capacity>1' as const }
              : h.external ? { notAnalysedReason: 'external-holder' as const } : {}) });
        }
        // Registry-only/external holders remain visible without inventing analysable dependencies.
        for (const id of zones.holdersOf(z)) {
          if (id === vid || seen.has(id)) continue;
          const holder = this.vehicles.get(id);
          if (holder && !holder.external) continue;
          out.push({ waiterId: vid, resourceId: z, ownerIds: [id], kind: 'zone-holder',
            sinceSimSec: t, analysed: false, notAnalysedReason: capacityOne ? 'external-holder' : 'capacity>1' });
        }
        if (!free || Number.isNaN(t)) continue;
        for (const [wid, tw] of w) {
          if (wid === vid || !isNode.has(wid) || Number.isNaN(tw)) continue;
          if (tw < t || (tw === t && wid < vid)) out.push({ waiterId: vid, resourceId: z,
            ownerIds: [wid], kind: 'zone-fifo', sinceSimSec: t, analysed: capacityOne,
            ...(!capacityOne ? { notAnalysedReason: 'capacity>1' as const } : {}) });
        }
      }
    }
    return out;
  }

  /**
   * Circular waits over capacity-1 zones (plan-686 F2) — a READ-ONLY diagnosis on call
   * (tests, measurements, soak samples); no hook in the plan / flush path, no state.
   *
   * Nodes: authority-planned vehicles standing at the end of their applied plan with stop
   * cause `zone`. Edges over zones of capacity 1: a HOLDER edge v -> h when v waits
   * (actively or passively) for z and the node h holds z; a FIFO edge v -> w when z is free,
   * v waits actively and the node w waits actively since earlier (tie: smaller id). Between
   * the same pair the lexicographically smallest zone is reported. Zones of capacity > 1
   * and external holders are not analysed (documented limits). Each cycle is rotated to its
   * smallest id; the list is sorted — deterministic for the same state.
   */
  findZoneWaitCycles(): ZoneWaitCycle[] {
    const edges = this.zoneWaitEdges({ holders: 'nodes' });
    const edge = new Map<string, Map<string, string>>();
    for (const e of edges) {
      if (!e.analysed) continue;
      for (const to of e.ownerIds) {
        let m = edge.get(e.waiterId);
        if (!m) { m = new Map(); edge.set(e.waiterId, m); }
        const old = m.get(to);
        if (old === undefined || e.resourceId < old) m.set(to, e.resourceId);
      }
    }
    // Only vertices with outgoing edges can start a cycle; retain authority order and the global cap.
    const nodes = this.order.filter(v => edge.has(v.id));
    // Simple cycles, each found once from its smallest id (this.order is sorted by id).
    const out: ZoneWaitCycle[] = [];
    const pathV: string[] = [];
    const pathZ: string[] = [];
    const onPath = new Set<string>();
    const dfs = (start: string, cur: string): void => {
      const m = edge.get(cur);
      if (!m) return;
      const next = [...m.keys()].sort();
      for (const nx of next) {
        const z = m.get(nx)!;
        if (nx === start) { out.push({ vehicles: [...pathV], zones: [...pathZ, z] }); continue; }
        if (nx < start || onPath.has(nx) || out.length >= 1000) continue;
        pathV.push(nx); pathZ.push(z); onPath.add(nx);
        dfs(start, nx);
        pathV.pop(); pathZ.pop(); onPath.delete(nx);
      }
    };
    for (const v of nodes) {
      pathV.length = 0; pathZ.length = 0; onPath.clear();
      pathV.push(v.id); onPath.add(v.id);
      dfs(v.id, v.id);
    }
    const key = (c: ZoneWaitCycle): string => c.vehicles.join('\u0000') + '\u0001' + c.zones.join('\u0000');
    return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }

  /**
   * Read-only FIFO predecessors, regardless of their stop cause: earlier active
   * wait start, then smaller id. Passive (NaN) entries have no FIFO edges.
   * A pending claim without an entry competes at the vehicle's current sim time,
   * as in isHeadWaiter. Returns a copy in FIFO order; never wakes or re-plans.
   */
  waitersAhead(zone: string, id: string): string[] {
    const waiters = this.waiters.get(zone);
    if (!waiters) return [];
    const since = waiters.get(id) ?? this.vehicles.get(id)?.host.now();
    if (since === undefined || Number.isNaN(since)) return [];
    const ahead: Array<[string, number]> = [];
    for (const [wid, t] of waiters) {
      if (wid === id || Number.isNaN(t)) continue;
      if (t < since || (t === since && wid < id)) ahead.push([wid, t]);
    }
    ahead.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return ahead.map(([wid]) => wid);
  }

  /** Held zones (with run-end key) and awaited zones of a vehicle — diagnostics (plan-686); null when unknown. */
  describeZoneHolds(id: string): ZoneHoldReport | null {
    const v = this.vehicles.get(id);
    if (!v) return null;
    const held: ZoneHoldReport['held'] = [];
    for (const [zone, exitOdo] of v.held) held.push({ zone, exitOdo });
    const waits: ZoneHoldReport['waits'] = [];
    for (const [zone, w] of this.waiters) {
      const t = w.get(id);
      if (t !== undefined) waits.push({ zone, since: t, passive: Number.isNaN(t) });
    }
    waits.sort((a, b) => (a.zone < b.zone ? -1 : a.zone > b.zone ? 1 : 0));
    return { held, waits };
  }

  /** Minimum front-to-rear gap (m) over all follower/leader pairs at time t (route projection). */
  minFrontRearGap(t: number): number {
    let min = Infinity;
    for (const v of this.order) {
      const cur = this.loc(v, t);
      const base = v.plan.route[cur.idx].x0;
      const route = v.plan.route.slice(cur.idx).map((e) => ({ path: e.path, x0: e.x0 - base }));
      for (const L of this.findLeaders(v, route, mirrorS(v.plan.dir, cur.path, cur.s), t, v.plan.dir, null)) {
        if (L.diverged || (L.domainEnd < Infinity && positionAt(L.u.plan.profile, t) > L.domainEnd)) continue;
        // Route coordinate of v and the body ends in travel direction (plan-595 D).
        const g = L.xNow - trail(L.u.p, L.u.plan.dir) - (mirrorS(v.plan.dir, cur.path, cur.s) + lead(v.p, v.plan.dir));
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
function routeSampler(route: readonly RouteEntry[], dir: 1 | -1): RouteSampler {
  const find = (m: number): number => {
    let lo = 0, hi = route.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (route[mid].x0 <= m) lo = mid; else hi = mid - 1; }
    return lo;
  };
  return {
    // Mirrored pieces map route coordinate -> arc length; the direction stays the PATH
    // tangent (the body keeps its orientation and drives rear first).
    getAbsPosition: (m, out) => { const e = route[find(m)]; return e.path.getAbsPosition(mirrorS(dir, e.path, m - e.x0), out); },
    getAbsDirection: (m, out) => { const e = route[find(m)]; return e.path.getAbsDirection(mirrorS(dir, e.path, m - e.x0), out); },
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

/** One waiting branch of a merge whose entry is too short for the bodies (plan-595 R3-2, #194). */
export interface ShortMergeEntry {
  /** The merge piece (>= 2 predecessors). */
  mergePathId: string;
  /** The incoming branch a vehicle waits on. */
  branchId: string;
  /** Length (m) of the merge-zone run on that branch before the junction. */
  pre: number;
  /** Deepest footprint overlap (m) of the waiting body with a body rooted on another branch / the merge piece. */
  penetration: number;
}

/** Body extents (m) for the merge-entry check. */
export interface BodyEnvelope { front: number; rear: number; width: number }

/** Counted coverage of one merge-entry check (plan-618). The caller zeroes it; the check only adds. */
export interface MergeCheckCounts {
  /** Zoned merges examined ({@link isZonedMerge}). */
  merges: number;
  /** Incoming branches of those merges actually tested. */
  branches: number;
}

/** A merge the entry check covers: >= 2 incoming paths and a zone on the merge piece (plan-618). */
export function isZonedMerge(p: RVPath): boolean {
  return p.predecessors.length >= 2 && !!p.zoneId;
}

const ENTRY_STEP_M = 0.05;

/** Pose at arc distance `d` BEFORE the end of `p`, walking back over the first predecessor. */
function poseBefore(p: RVPath, d: number, pos: Vector3, dir: Vector3): void {
  let q = p;
  for (let k = 0; k < MAX_ROUTE_PIECES && d > q.length && q.predecessors.length > 0; k++) { d -= q.length; q = q.predecessors[0]; }
  const s = Math.max(0, q.length - d);
  q.getAbsPosition(s, pos);
  q.getAbsDirection(s, dir);
}

/** Pose at arc distance `d` AFTER the start of `p`, walking on over the first successor. */
function poseAfter(p: RVPath, d: number, pos: Vector3, dir: Vector3): void {
  let q = p;
  for (let k = 0; k < MAX_ROUTE_PIECES && d > q.length && q.successors.length > 0; k++) { d -= q.length; q = q.successors[0]; }
  const s = Math.min(q.length, d);
  q.getAbsPosition(s, pos);
  q.getAbsDirection(s, dir);
}

interface Rect { cx: number; cz: number; fx: number; fz: number; rx: number; rz: number; radius: number }

/** Oriented body rectangle in the XZ plane (root at `pos`, travel `dir`). */
function bodyRect(pos: Vector3, dir: Vector3, b: BodyEnvelope): Rect {
  const l = Math.hypot(dir.x, dir.z) || 1;
  const ux = dir.x / l, uz = dir.z / l;
  const half = (b.front + b.rear) / 2, off = (b.front - b.rear) / 2, hw = b.width / 2;
  return { cx: pos.x + ux * off, cz: pos.z + uz * off, fx: ux * half, fz: uz * half, rx: uz * hw, rz: -ux * hw, radius: Math.hypot(half, hw) };
}

/** Penetration depth (m) of two oriented rectangles (SAT); <= 0 = separated. */
function rectOverlap(a: Rect, b: Rect): number {
  const dx = b.cx - a.cx, dz = b.cz - a.cz;
  if (Math.hypot(dx, dz) > a.radius + b.radius) return -1;
  let min = Infinity;
  for (const [ax, az] of [[a.fx, a.fz], [a.rx, a.rz], [b.fx, b.fz], [b.rx, b.rz]]) {
    const l = Math.hypot(ax, az);
    if (l < 1e-12) continue;
    const ux = ax / l, uz = az / l;
    const ra = Math.abs(a.fx * ux + a.fz * uz) + Math.abs(a.rx * ux + a.rz * uz);
    const rb = Math.abs(b.fx * ux + b.fz * uz) + Math.abs(b.rx * ux + b.rz * uz);
    const pen = ra + rb - Math.abs(dx * ux + dz * uz);
    if (pen <= 0) return pen;
    if (pen < min) min = pen;
  }
  return min;
}

/**
 * Merge entries too short for the bodies (plan-595 R3-2, finding #194). A
 * vehicle waiting for the merge zone stops with its front STOP_MARGIN before
 * the start of the zone run on its branch — `pre` before the junction. For
 * every incoming branch (symmetric) that waiting body is tested against a body
 * rooted anywhere on every OTHER incoming branch and on the merge piece (and
 * on), up to {@link CLEARANCE_LANE_M} from the junction, oriented along its
 * path (sampled every 5 cm, exact footprint overlap). Direction-independent —
 * covers forward and reverse travel. `body` is the envelope of the fleet's
 * bodies (max front, rear, width): the overlap only grows with any extent.
 *
 * `counts` (optional, plan-618) is ADDED to — zoned merges and tested branches —
 * so an empty result is distinguishable from "nothing was checked". The caller
 * zeroes it; a call without `counts` (the stub check) counts nothing.
 */
export function findShortMergeEntries(paths: Iterable<RVPath>, body: BodyEnvelope, counts?: MergeCheckCounts): ShortMergeEntry[] {
  const out: ShortMergeEntry[] = [];
  const pos = new Vector3(), dir = new Vector3();
  for (const p of paths) {
    if (!isZonedMerge(p)) continue;
    const z = p.zoneId;
    if (counts) counts.merges++;
    for (const b of p.predecessors) {
      if (counts) counts.branches++;
      // Merge-zone run on b before the junction.
      let pre = 0;
      for (let q: RVPath | null = b, k = 0; q && q.zoneId === z && k < MAX_ROUTE_PIECES; k++) {
        pre += q.length;
        q = q.predecessors.length === 1 ? q.predecessors[0] : null;
      }
      poseBefore(b, pre + STOP_MARGIN + body.front, pos, dir);
      const waiter = bodyRect(pos, dir, body);
      let pen = 0;
      const n = Math.ceil(CLEARANCE_LANE_M / ENTRY_STEP_M);
      for (const c of p.predecessors) {
        if (c === b) continue;
        for (let i = 0; i <= n; i++) {
          poseBefore(c, i * ENTRY_STEP_M, pos, dir);
          pen = Math.max(pen, rectOverlap(waiter, bodyRect(pos, dir, body)));
        }
      }
      for (let i = 0; i <= n; i++) {
        poseAfter(p, i * ENTRY_STEP_M, pos, dir);
        pen = Math.max(pen, rectOverlap(waiter, bodyRect(pos, dir, body)));
      }
      if (pen > 1e-6) out.push({ mergePathId: p.id, branchId: b.id, pre, penetration: pen });
    }
  }
  return out.sort((a, b) => (a.mergePathId < b.mergePathId ? -1 : a.mergePathId > b.mergePathId ? 1
    : a.branchId < b.branchId ? -1 : a.branchId > b.branchId ? 1 : 0));
}

const authorities = {
  des: new MovementAuthority('des'),
  continuous: new MovementAuthority('continuous'),
};

/** The shared authority of a kernel (DES events or the continuous fixed tick). */
export function getDefaultMovementAuthority(kind: 'des' | 'continuous' = 'des'): MovementAuthority {
  return authorities[kind];
}

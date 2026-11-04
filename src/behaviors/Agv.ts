// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Agv — an autonomous path-following carrier (FTS/AGV, plan-268 / plan-558).
 *
 * The vehicle rides an `RVPath` graph (rv_extras.Path, plan-268 §2.3); its
 * route bookkeeping lives in a `PathTraveler` and the pose comes from
 * `lookRotation(tangent, align)` (rv-pose-align.ts).
 *
 * Plan-558 — DISTANCE CONTROL by a trajectory-based moving block
 * (rv-movement-authority.ts), the SAME planner in both kernels:
 *   - Every vehicle owns one closed-form motion plan (rv-motion-profile.ts:
 *     trapezoid / triangle phases, braking exactly into the stop, curve limit
 *     v ≤ √(LateralAcceleration·R), docking crawl over the last
 *     DockingDistance before a service stop) that always ends in a stop — the
 *     movement AUTHORITY. A follower plans against the PLANNED TRAJECTORY of
 *     the vehicle ahead on its own route and keeps ≥ SafetyGap between its
 *     front and the leader's rear at every instant.
 *   - DES: one event per PLAN (not per path piece); the leg tween samples the
 *     profile position over time (accelerating / braking vehicles), routing is
 *     decided at PLANNING time and stored in the plan. With a project router
 *     installed every piece end is announced at its exact arrival time.
 *   - Continuous: the fixed tick evaluates the SAME plan `x(t)`; plan events
 *     run on the continuous authority's clock at their exact times (several
 *     path ends inside one tick included) — conflict-free trajectories are
 *     identical in both kernels. `UseAcceleration = false` keeps the legacy
 *     car-following step mode (continuous) / an instant ramp (DES).
 *   - Zones (merge control points, ZoneRegistry) are claimed before the FRONT
 *     enters and released when the REAR has left; a release wakes the waiters.
 *   - Scanner fields (optional): protective field
 *     `v·t_r + v²/2b + ProtectiveMargin`, warning field + WarningMargin,
 *     evaluated at planning time against the leader's planned trajectory —
 *     warning caps the speed, protective stops the vehicle.
 *   - Reverse travel (plan-595, `AllowReverse`): a task with
 *     `approach: 'reverse'` to a STUB (authored from the handling position
 *     toward the lane) runs a stub manoeuvre — forward to the end of the merge
 *     piece, standstill, reverse at `ReverseSpeed` into the stub (forks first),
 *     serve at the stub START, leave forward. The merge zone is claimed only
 *     together with the stub zone (no wait inside the merge).
 *
 * Statistics: Transport (driving with a task), Working (service), Slowed
 * (below the free profile because of traffic or the warning field), Stopped
 * (standing at a traffic stop — free time), Empty (no task / Run off),
 * Failure (DES downtime).
 *
 * MECHANICS ONLY: routing/dispatch are project logic — the traveler exposes
 * id-based hooks (`selectNextPath`, `onArrive`), the fleet handle the task
 * API (rv-agv-fleet.ts); without them the vehicle follows `successors[0]`.
 *
 * Signals: `Agv.Run` (command), `Agv.Moving`, `Agv.Position` (mm on the
 * current path), `Agv.AtNode` (one-tick pulse, continuous), `Agv.Blocked`
 * (= Stopped by traffic), `Agv.Speed` (mm/s), `Agv.Slowed`,
 * `Agv.FieldWarning`, `Agv.FieldProtective`, `Agv.Reverse`, `Agv.FieldRear`
 * (plan-595). When the component is PLC-wired
 * (`self.isWired`) the internal simulation stays silent.
 *
 * DES snapshots of scenes with AGVs are an explicit non-goal (the runner
 * refuses the restore); `samplesLiveGeometry` is deliberately NOT declared.
 */

import { Box3, Matrix4, Mesh, Quaternion, Vector3, type Object3D } from 'three';
import { defineLibraryComponent, type RV } from './_shared/behavior-kit';
import { pathFromNode, type RVPath } from '../core/engine/rv-path';
import { getDefaultPathNetwork } from '../core/engine/rv-path-network';
import { PathTraveler } from '../core/engine/rv-path-traveler';
import { computeRampedSpeed } from '../core/engine/rv-drive';
import {
  computeCarFollowingSpeed,
  getDefaultSpacingController,
} from '../core/engine/rv-spacing-controller';
import { getDefaultZoneRegistry, type ZoneRegistry } from '../core/engine/rv-zone-registry';
import {
  getDefaultAgvFleet, AGV_NO_BODY_KEY, type AgvTask, type AgvPhase, type AgvMotionInfo, type AgvLocation,
} from '../core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../core/engine/rv-path-dock';
import {
  getDefaultMovementAuthority, findUnzonedMerges, findShortMergeEntries, isZonedMerge, isTrafficStop, isReverseGateOpen,
  type BodyEnvelope, type MergeCheckCounts, type MbHost, type MbEventKind, type MbParams, type MovementAuthority,
} from '../core/engine/rv-movement-authority';
import { getActiveTrafficKernel, onTrafficRegistriesReset } from '../core/engine/rv-traffic-registries';
import { scopedInstanceId } from '../core/engine/rv-instance-scope';
import { reportProblem, clearProblemsOfCode } from '../core/hmi/problems-store';

// PLC contract — auto-declared as `Agv.<key>` with typed `self.sig.<key>`
// accessors. Run follows the Conveyor convention (command in, status out).
const SIGNALS = {
  Run:             'PLCInputBool',
  Moving:          'PLCOutputBool',
  Position:        'PLCOutputFloat', // arc position on the current path, in mm
  AtNode:          'PLCOutputBool',  // one-tick pulse at a path-end node
  Blocked:         'PLCOutputBool',  // standing at a traffic stop (leader / zone / field) — Stopped
  Speed:           'PLCOutputFloat', // mm/s
  Slowed:          'PLCOutputBool',  // driving below the free profile because of traffic
  FieldWarning:    'PLCOutputBool',  // scanner warning field engaged
  FieldProtective: 'PLCOutputBool',  // scanner protective field engaged (vehicle stops)
  Reverse:         'PLCOutputBool',  // plan-595: the applied plan drives rear first (forks first)
  FieldRear:       'PLCOutputBool',  // plan-595: the active scanner field is the rear field
} as const;

// Schema defaults (stamped as AgvBehavior inspector rows by the factory).
const DEFAULTS = {
  TargetSpeed: 1000,     // mm/s (drive parity)
  Acceleration: 500,     // mm/s²
  UseAcceleration: true,
  PathId: '',
  StartPosition: 0,      // mm — initial arc position on the resolved path
  SafetyDistance: 1000,  // mm — legacy car-following standstill separation (UseAcceleration=false)
  MinGap: 200,           // mm — legacy HARD no-penetration floor (UseAcceleration=false)
  LookAhead: 5000,       // mm — legacy leader search / zone claim window (UseAcceleration=false)
  HeadwayGain: 2,        // 1/s — legacy car-following proportional gain (UseAcceleration=false)
  // Plan-558 — distance control
  Deceleration: 500,        // mm/s²
  LateralAcceleration: 500, // mm/s² — curve limit v ≤ √(aLat·R)
  VehicleLength: 0,         // mm along travel; 0 = from the mesh bounds (root may be off-centre)
  VehicleWidth: 0,          // mm; 0 = from the mesh bounds
  SafetyGap: 300,           // mm — front-to-rear standstill gap behind the vehicle ahead
  DockingSpeed: 300,        // mm/s — crawl speed before a service stop (ISO 3691-4: ≤ 0.3 m/s)
  DockingDistance: 500,     // mm — crawl distance before a service stop
  ScannerFields: true,
  ScannerReactionTime: 0.2, // s — scanner + control reaction time t_r
  ProtectiveMargin: 200,    // mm — protective field supplement
  WarningMargin: 1000,      // mm — warning field length beyond the protective field
  // Plan-595 — reverse travel (stub manoeuvre)
  AllowReverse: false,
  ReverseSpeed: 300,        // mm/s — cruise speed of the reverse leg; 0 = DockingSpeed (ISO 3691-4 crawl)
  // Taken out of service for the next run: evaluated at setup and reset only.
  Active: true,
} as const;

/** Body used when neither VehicleLength/Width nor a mesh defines it (mm). */
const FALLBACK_LENGTH_MM = 1000;
const FALLBACK_WIDTH_MM = 600;

/** Scanner exit hysteresis (m) and restart delay after a protective stop (s). */
const FIELD_HYSTERESIS_M = 0.2;
const FIELD_RESTART_SEC = 0.5;

/** Ramp used for `UseAcceleration = false` in the planner (DES) — a jump within microseconds. */
const INSTANT_RAMP = 1e7; // m/s²

/** Bound on the zone claim walk (pathological graphs / zero-length chains). */
const MAX_ZONE_WALK = 8;

/** Float back-off (mm) so a hard-clamped advance never float-crosses a boundary. */
const HARD_CLAMP_BACKOFF_MM = 1e-6;

/** Clamped advances at/below this (mm, one micrometer) PARK the vehicle (v=0)
 *  — without the snap the float residual of `(L−s)·1000 − backoff` would creep
 *  asymptotically and the speed would never reach exactly 0. */
const PARK_EPS_MM = 1e-3;

/** Minimum DES service duration (s) — keeps zero-time stays ordered after the arrival. */
const DES_MIN_TRANSIT_SEC = 0.001;

/** Retry delay (s) of a refused direction change at the turn point (plan-595). */
const MANEUVER_RETRY_SEC = 0.5;

/** Replan-hook kind of the manoeuvre retry event (DES). */
const MANEUVER_RETRY = 'maneuverRetry';

/**
 * A stub manoeuvre (plan-595 §2.5): FORWARD to the end of the turn (merge)
 * piece, standstill, REVERSE along `route` to the START of the stub (the
 * handling position), serve there, leave FORWARD.
 */
interface StubManeuver {
  /** Task destination; its START is the handling position. */
  stub: RVPath;
  /** Merge piece (>= 2 predecessors) the stub chain runs into — the turn point is its END. */
  turn: RVPath;
  /** Explicit reverse route: the turn first, the stub last. */
  route: RVPath[];
  /** Zone of the turn piece (M). */
  mergeZone: string;
  /** Zones of the reverse route other than M (stub zone K …) — claimed together with M. */
  companions: string[];
  stage: 'approach' | 'reverse' | 'dock';
  /** `maneuverEpoch` at the start — stale retry events are dropped. */
  epoch: number;
  /** Turn point reached while a stub zone was taken: drive on and come back (never wait inside M). */
  goAround: boolean;
  /** clear() / assign() during the reverse leg or the dock stay — applied once the vehicle stands with dir = +1. */
  pending: { task: AgvTask | null } | null;
  retryLogged: boolean;
}

type MbKind = 'des' | 'continuous';

export interface AgvLocal {
  traveler: PathTraveler | null;
  /** False = out of service for this run: no fleet id, no traffic, hidden. */
  active: boolean;
  /** The root is hidden BECAUSE of `Active` — only then does reactivation show it again (a group hide stays). */
  hiddenByActive: boolean;
  targetSpeed: number;     // mm/s
  acceleration: number;    // mm/s²
  useAcceleration: boolean;
  // Plan-921 — low-level task control (destination + service time + callbacks).
  /** Current task (null = cruising, or idle after a completed task). */
  task: AgvTask | null;
  /** The declarative config task (Destination/ServiceTime) — re-armed on reset. */
  startTask: AgvTask | null;
  /** Movement phase — drives the stop/dwell state machine. */
  phase: AgvPhase;
  /** Legacy continuous dwell countdown in seconds (phase 'servicing' only). */
  serviceRemainingSec: number;
  /** Scheduled ServiceEnd event id (−1 = none) — cancelled on reset. */
  desServiceEvent: number;
  /** Who ends the stay: 'timer' = task serviceSec; 'dock' = the dock's release(). */
  serviceMode: 'timer' | 'dock';
  /** Legacy continuous: set by a dock's release() — ends the stay next tick. */
  dockReleaseFlag: boolean;
  /** Segment already served this visit (dock re-trigger guard) — cleared on hand-off. */
  servedPathId: string | null;
  // Legacy car-following parameters (mm, mm/s, 1/s) — UseAcceleration=false.
  safetyDistanceMm: number;
  minGapMm: number;
  lookAheadMm: number;
  headwayGain: number;
  /** Deterministic re-seed for reset: the resolved start path + position (m). */
  startPath: RVPath | null;
  startPosM: number;
  /** Set by onArrive; published as the AtNode pulse (continuous). */
  atNodeId: string | null;
  /** Path id whose END was already announced via onArrive (de-dupe). */
  desArrivedPathId: string | null;
  // Plan-558 — distance control parameters (mm, mm/s, mm/s², s).
  decel: number;
  aLat: number;
  frontMm: number;
  rearMm: number;
  widthMm: number;
  gapMm: number;
  dockSpeed: number;
  dockDist: number;
  scanner: boolean;
  reactionSec: number;
  protectiveMm: number;
  warningMm: number;
  /** Authority the vehicle plans through (null = legacy step mode / not yet registered). */
  mbKind: MbKind | null;
  mbHost: MbHost | null;
  /** Continuous: sim time (s) of the vehicle's last sync — the shared step time of its fleet step (plan-632). */
  cTime: number;
  /** Continuous: last observed canMove (Run edge → re-plan). */
  lastCanMove: boolean;
  /** Continuous: the fleet step this vehicle was last processed in (-1 = none; plan-632). */
  stepFrame: number;
  /** DES freeze (component failure). */
  frozen: boolean;
  /** Remaining service time stashed at a freeze (−1 = none). */
  frozenServiceSec: number;
  /** Inside a plan event's callbacks: task changes only mark the plan dirty (one re-plan per event). */
  inHook: boolean;
  // Pre-allocated pose temps + zone scratch buffers — no GC in the tick.
  _pos: Vector3;
  _quat: Quaternion;
  /** Parent world orientation, for the world->parent-local pose conversion. */
  _parentQuat: Quaternion;
  _relevantZones: string[];
  _heldScratch: string[];
  // Plan-595 — reverse travel.
  /** Reverse travel admitted (schema AllowReverse; the internal gate applies on top). */
  allowReverse: boolean;
  /** Reverse cruise speed (mm/s); 0 = DockingSpeed. */
  reverseSpeed: number;
  /** Active stub manoeuvre of an `approach: 'reverse'` task (null = none). */
  maneuver: StubManeuver | null;
  /** Bumped at every manoeuvre start / end / reset — stale retry events are dropped. */
  maneuverEpoch: number;
  /** Bumped when a service stay is abandoned / reset — a late dock release() is a no-op. */
  serviceEpoch: number;
  /** Kernel of THIS instance (plan-648): 'continuous' = behaviour binding, 'des' = DES runner instance. */
  kernelKind: MbKind;
}

export type AgvSelf = RV.Self<AgvLocal, typeof SIGNALS>;

/** Recover the Agv type after the material-flow registry's generic boundary. */
export function agvSelfForSnapshot(self: unknown): AgvSelf {
  if (!self || typeof self !== 'object' || !('local' in self) || !self.local
    || typeof self.local !== 'object' || !('kernelKind' in self.local)
    || self.local.kernelKind !== 'des') throw new Error('Agv snapshot requires a DES Agv instance');
  return self as AgvSelf;
}

// ── Vehicle-id ownership (plan-648, LOP #219) ───────────────────────────────
//
// One vehicle has TWO instances: the continuous behaviour binding and the DES
// runner instance. Both key the shared traffic state (fleet handle, spacing,
// zone claims, planner) on the same id. Exactly ONE instance owns an id — the
// instance of the ACTIVE traffic kernel (`getActiveTrafficKernel()`, `null` =
// unbound: the first instance wins). Shared entries are written only through
// `acquire` / `attachTraffic` and dropped only through `release`, which is a
// no-op for a non-owner: a foreign instance can never delete the owner's
// entries. A kernel switch hands the ids over explicitly (suspend → active
// kernel → start); the new owner starts from its start pose.

/**
 * The vehicle / traveler id of an instance — the ONE place the id is derived
 * (fleet handle, planner, zones, spacing, ownership all key on it).
 *
 * plan-559 phase 2b: the scope chain of the ENCLOSING placements / InstanceScope
 * markers, then the root name (`scopedInstanceId`) — two placed copies of one
 * asset whose vehicle has the same name get distinct ids. Without a scope it is
 * exactly `root.name || 'Agv'`; a vehicle ON its placement root keeps the root
 * name (`Stapler_1`). Cached per instance (hot path: `ownsTraffic` per tick)
 * and recomputed only when the root name changes, so the id an instance
 * acquired is the id it releases.
 */
export function travelerIdOf(self: AgvSelf): string {
  const name = self.root.name || 'Agv';
  const c = travelerIdCache.get(self);
  if (c && c.name === name) return c.id;
  const id = scopedInstanceId(self.root, name);
  travelerIdCache.set(self, { name, id });
  return id;
}
const travelerIdCache = new WeakMap<AgvSelf, { name: string; id: string }>();

/** Owner instance per vehicle id. Emptied with the traffic registries (model clear / clearShared). */
const trafficOwner = new Map<string, AgvSelf>();
/** Every live continuous binding (activated by the continuous runner after a DES phase). */
const continuousInstances = new Set<AgvSelf>();
onTrafficRegistriesReset(() => { trafficOwner.clear(); });

/** True while this instance's kernel may own traffic ids (active kernel unbound or its own). */
function kernelLive(l: AgvLocal): boolean {
  const k = getActiveTrafficKernel();
  return k === null || k === l.kernelKind;
}

/** True when `self` owns its vehicle id. */
function ownsTraffic(self: AgvSelf): boolean {
  return trafficOwner.get(travelerIdOf(self)) === self;
}
// ── Config (rv_extras bag, defensive `?? default`) ──────────────────────────

function configBag(self: AgvSelf): Record<string, unknown> {
  const rv = (self.root.userData?.realvirtual ?? {}) as Record<string, unknown>;
  return {
    ...((rv['AgvBehavior'] as Record<string, unknown> | undefined) ?? {}),
    ...((rv['Agv'] as Record<string, unknown> | undefined) ?? {}),
  };
}

function cfgNumber(bag: Record<string, unknown>, key: string, def: number): number {
  const n = Number(bag[key]);
  return Number.isFinite(n) ? n : def;
}

function cfgBool(bag: Record<string, unknown>, key: string, def: boolean): boolean {
  return typeof bag[key] === 'boolean' ? (bag[key] as boolean) : def;
}

// ── Shared helpers (logic layer) ────────────────────────────────────────────

/** Place the vehicle root at the traveler's current pose. The traveler's own
 *  pre-allocated temps are written via copy() — never shared references. */
export function applyPose(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler;
  if (!t || !t.path) return;
  // The traveler reports a WORLD pose (the path network is global), while
  // `root.position`/`root.quaternion` are read in the PARENT frame. The two
  // coincide only when the parent's world transform is identity — true for a
  // vehicle placed at scene level, false the moment one is bound from rv_extras
  // somewhere inside a moved or rotated subtree (plan-455 F8). So convert.
  t.getPose(l._pos, l._quat);
  const parent = self.root.parent;
  if (!parent) {
    self.root.position.copy(l._pos);
    self.root.quaternion.copy(l._quat);
    return;
  }
  // Order matters: refresh the parent's world matrix BEFORE reading it.
  // `worldToLocal` uses `matrixWorld` as-is and would otherwise silently apply a
  // stale frame for one tick after the parent moved.
  parent.updateWorldMatrix(true, false);
  if (isIdentityMatrix(parent.matrixWorld)) {
    // Fast path — taken on the strength of the MEASURED transform, never on the
    // assumption that a scene-level parent must be identity.
    self.root.position.copy(l._pos);
    self.root.quaternion.copy(l._quat);
    return;
  }
  // Position: world point through the inverse parent transform. `worldToLocal`
  // rewrites `_pos` in place — safe, because all three temps are per-call
  // scratch that `getPose`/`getWorldQuaternion` refill at the top of every tick.
  self.root.position.copy(parent.worldToLocal(l._pos));
  // Orientation: local = inverse(parentWorld) * world, in that order.
  parent.getWorldQuaternion(l._parentQuat);
  self.root.quaternion.copy(l._parentQuat.invert().multiply(l._quat));
}

/** True when `m` is (numerically) the identity — the guard for applyPose's
 *  no-conversion fast path. Compares against the exact identity elements with a
 *  tight epsilon; allocation-free. */
function isIdentityMatrix(m: Matrix4): boolean {
  const e = m.elements;
  const EPS = 1e-9;
  for (let i = 0; i < 16; i++) {
    const want = IDENTITY_ELEMENTS[i];
    if (Math.abs(e[i] - want) > EPS) return false;
  }
  return true;
}

const IDENTITY_ELEMENTS = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

/**
 * Body extents relative to the root in the root's local frame (+Z = travel):
 * reach ahead (front), behind (rear) and width, in mm, from the mesh bounds.
 * Null when the vehicle carries no mesh.
 */
function meshBodyMm(root: Object3D): { front: number; rear: number; width: number } | null {
  root.updateWorldMatrix(true, true);
  const inv = new Matrix4().copy(root.matrixWorld).invert();
  const box = new Box3();
  const part = new Box3();
  const m = new Matrix4();
  let any = false;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    // Overlays parented to the vehicle (scanner fields) are not body.
    for (let p: Object3D | null = mesh; p && p !== root; p = p.parent) {
      if (p.userData[AGV_NO_BODY_KEY] === true) return;
    }
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb || bb.isEmpty()) return;
    m.multiplyMatrices(inv, mesh.matrixWorld);
    part.copy(bb).applyMatrix4(m);
    box.union(part);
    any = true;
  });
  if (!any) return null;
  return {
    front: Math.max(0, box.max.z) * 1000,
    rear: Math.max(0, -box.min.z) * 1000,
    width: Math.max(0, box.max.x - box.min.x) * 1000,
  };
}

/** Remaining distance (mm) to a positional stop — the end of a TERMINAL path.
 *  ∞ while the graph continues (successors exist) or the path is closed, so
 *  the drive ramp only decelerates into a real dead end. Allocation-free. */
function remainingToStopMm(t: PathTraveler): number {
  const p = t.path;
  if (!p || p.closed) return Number.POSITIVE_INFINITY;
  const hasNext = t.network
    ? t.network.candidateCount(p, 1) > 0
    : p.successors.length > 0;
  if (hasNext) return Number.POSITIVE_INFINITY;
  return Math.max(0, (p.length - t.s) * 1000);
}

/**
 * Zone declaration of a claim walk (plan-647 R3-2 / R4-1): the walked path
 * OBJECT declares its zone — but only while it is the CURRENTLY registered
 * object of its id. A stale object (replaced by a live edit, renamed or
 * removed; e.g. `startPath` re-seeded by a reset) only makes sure the zone
 * exists, so it can never revive an old capacity that nothing withdraws.
 * Repeated walks hit the same (zone, object) key and count nothing up.
 */
function declareWalkedZone(zones: ZoneRegistry, p: RVPath, zoneId: string): void {
  if (getDefaultPathNetwork().get(p.id) === p) zones.declare(zoneId, p, p.zoneCapacity ?? undefined);
  else zones.ensureZone(zoneId);
}

/** Claim (best effort) the zone of the path the traveler currently stands on
 *  — used at setup and reset. Physical occupancy wins over a failed claim. */
function claimCurrentZone(t: PathTraveler): void {
  const p = t.path;
  if (!p || !p.zoneId) return;
  const zones = getDefaultZoneRegistry();
  declareWalkedZone(zones, p, p.zoneId);
  if (!zones.claim(p.zoneId, t.id)) {
    console.warn(
      `[Agv] '${t.id}' starts inside zone '${p.zoneId}' but the capacity is ` +
        'exhausted — proceeding without a claim (check StartPositions).',
    );
  }
}

/** Problems-panel code for merges without a shared zone. */
const UNZONED_MERGE_CODE = 'agv-merge-without-zone';
/** Problems-panel code for merge entries too short for the fleet's bodies (plan-595 R3-2). */
const SHORT_ENTRY_CODE = 'agv-merge-entry-too-short';
/** Problems-panel code for a refused stub manoeuvre (plan-595 R3-2). */
const STUB_REFUSED_CODE = 'agv-reverse-stub-refused';
/** Problems-panel code for a merge-entry check that had zoned merges but no body to test (plan-618). */
const CHECK_SKIPPED_CODE = 'agv-merge-check-skipped';
/** Problems-panel code: a missed service stop on a dead end — no later visit (plan-634 F7). */
const SERVICE_MISSED_NO_RETURN_CODE = 'agv-service-stop-missed-no-return';
/** Problems-panel code: the vehicle stood beyond / short of the turn point — no direction change (plan-634 F5). */
const TURN_OVERSHOOT_CODE = 'agv-turn-point-overshoot';
/** Tolerance (m) of the turn-point position check (plan-634 F5). */
const TURN_POINT_TOL_M = 1e-3;

/** Bodies (m) of the set-up vehicles — the envelope feeds the merge-entry check (plan-595 R3-2). */
const fleetBodies = new Map<string, BodyEnvelope>();

/** Envelope (max front, rear, width, m) of the bodies of `ids`; ids without a body are counted in `missing`. */
function envelopeOf(
  ids: Iterable<string>, bodies: ReadonlyMap<string, BodyEnvelope>, missing?: { n: number },
): BodyEnvelope {
  const e = { front: 0, rear: 0, width: 0 };
  for (const id of ids) {
    const b = bodies.get(id);
    if (!b) { if (missing) missing.n++; continue; }
    e.front = Math.max(e.front, b.front);
    e.rear = Math.max(e.rear, b.rear);
    e.width = Math.max(e.width, b.width);
  }
  return e;
}

/** Ids of the fleet's registered handles. */
function fleetHandleIds(): string[] {
  return getDefaultAgvFleet().handleList.map((h) => h.id);
}

/** Envelope (max front, rear, width) of the bodies of every vehicle in the fleet (m). */
function fleetEnvelope(): BodyEnvelope {
  return envelopeOf(fleetHandleIds(), fleetBodies);
}

/**
 * Body envelope (m) of the fleet's vehicles for authoring checks (plan-628 P11);
 * null without vehicles or when no body is known (front + rear or width 0).
 */
export function getFleetBodyEnvelope(): BodyEnvelope | null {
  if (fleetHandleIds().length === 0) return null;
  const e = fleetEnvelope();
  return e.front + e.rear > 0 && e.width > 0 ? e : null;
}

/** State of the LAST merge-entry check (plan-618) — re-initialised on every check. */
export interface MergeEntryCheckLast {
  /** Zoned merges found in the network. */
  merges: number;
  /** Incoming branches actually tested (0 when skipped). */
  branches: number;
  /** Too-short entries found — after the full setup the deviations of this run (geometric). */
  shortEntries: number;
  /** Body envelope used (m). */
  envelope: BodyEnvelope;
  /** Why nothing was tested; null = the check ran (or there was nothing to test). */
  skipped: 'no-vehicles' | 'empty-envelope' | null;
  /** Fleet handles without a body entry (defensive). */
  bodiesMissing: number;
}

/** Merge-entry check statistics (plan-618). Counters run since the last reset — no run semantics. */
export interface MergeEntryCheckStats {
  last: MergeEntryCheckLast;
  /** Load-time checks since the last reset. */
  checks: number;
  /** Stub manoeuvres rejected for a too-short merge entry since the last reset. */
  stubRejections: number;
}

function freshLast(): MergeEntryCheckLast {
  return {
    merges: 0, branches: 0, shortEntries: 0, envelope: { front: 0, rear: 0, width: 0 },
    skipped: 'no-vehicles', bodiesMissing: 0,
  };
}

const mergeCheckStats: MergeEntryCheckStats = { last: freshLast(), checks: 0, stubRejections: 0 };

/** Statistics of the merge-entry check (plan-618): the last check plus counters since the reset. */
export function getMergeEntryCheckStats(): Readonly<MergeEntryCheckStats> {
  return mergeCheckStats;
}

/** Resets the merge-entry check statistics (plan-618). */
export function resetMergeEntryCheckStats(): void {
  mergeCheckStats.last = freshLast();
  mergeCheckStats.checks = 0;
  mergeCheckStats.stubRejections = 0;
}

/**
 * The merge-entry check with explicit inputs (plan-595 R3-2, plan-618): fills
 * the statistics and reports `agv-merge-entry-too-short` / `agv-merge-check-skipped`.
 * {@link reportUnzonedMerges} passes the live network, fleet handle ids and bodies.
 * A zoned merge that cannot be tested (empty envelope) is REPORTED, never
 * passed silently.
 */
export function runMergeEntryCheck(
  paths: readonly RVPath[], handleIds: readonly string[], bodies: ReadonlyMap<string, BodyEnvelope>,
): void {
  const last = freshLast();
  mergeCheckStats.last = last;
  mergeCheckStats.checks++;
  clearProblemsOfCode(SHORT_ENTRY_CODE);
  clearProblemsOfCode(CHECK_SKIPPED_CODE);
  if (handleIds.length === 0) return; // skipped = 'no-vehicles' — as before, no problem entry
  last.skipped = null;
  const missing = { n: 0 };
  const env = envelopeOf(handleIds, bodies, missing);
  last.envelope = env;
  last.bodiesMissing = missing.n;
  for (const p of paths) if (isZonedMerge(p)) last.merges++;
  if (env.front + env.rear <= 0 || env.width <= 0) {
    if (last.merges === 0) return; // nothing to test
    last.skipped = 'empty-envelope';
    reportProblem({
      id: CHECK_SKIPPED_CODE,
      severity: 'warning',
      code: CHECK_SKIPPED_CODE,
      title: 'AGV merge-entry check skipped',
      detail: `AGV merge-entry check skipped: ${last.merges} zoned merge(s) but no vehicle body known — the check `
        + 'would pass vacuously. Check VehicleLength/VehicleWidth or the vehicle mesh.',
    });
    return;
  }
  const counts: MergeCheckCounts = { merges: 0, branches: 0 };
  const short = findShortMergeEntries(paths, env, counts);
  last.branches = counts.branches;
  last.shortEntries = short.length;
  const missingNote = missing.n > 0
    ? ` Note: ${missing.n} vehicle(s) without a known body (`
      + `${handleIds.filter((id) => !bodies.has(id)).map((id) => `'${id}'`).join(', ')}) are not in the envelope.`
    : '';
  for (const m of short) {
    reportProblem({
      id: `${SHORT_ENTRY_CODE}:${m.mergePathId}:${m.branchId}`,
      severity: 'warning',
      code: SHORT_ENTRY_CODE,
      title: `AGV merge entry too short at '${m.mergePathId}' (branch '${m.branchId}')`,
      detail: `A vehicle waiting on '${m.branchId}' for the merge zone of '${m.mergePathId}' stops ${m.pre.toFixed(2)} m `
        + `before the junction, but a body on another branch reaches ${m.penetration.toFixed(2)} m into it. `
        + 'Lengthen the merge-zone piece before the junction.' + missingNote,
    });
  }
}

/**
 * Load-time validation (plan-558): two paths that merge into the same
 * successor without a shared zone let vehicles from both branches enter the
 * merge together — the moving block only sees vehicles on the OWN route.
 * Reported as warnings in the Problems panel (re-reported idempotently).
 */
function reportUnzonedMerges(): void {
  const net = getDefaultPathNetwork();
  net.resolveGraph();
  clearProblemsOfCode(UNZONED_MERGE_CODE);
  for (const m of findUnzonedMerges(net.all())) {
    reportProblem({
      id: `${UNZONED_MERGE_CODE}:${m.pathId}`,
      severity: 'warning',
      code: UNZONED_MERGE_CODE,
      title: `AGV merge without a zone at path '${m.pathId}'`,
      detail: `Paths ${m.incoming.map((id) => `'${id}'`).join(', ')} merge into '${m.pathId}' without a shared zone — `
        + 'vehicles from both branches may enter the merge at the same time. Give the merging paths and '
        + `'${m.pathId}' one common zone id.`,
    });
  }
  // plan-595 R3-2: merge entries too short for the fleet's bodies (a warning — forward
  // behaviour is unchanged; a stub manoeuvre onto such a merge is refused). Counted and
  // checked for non-emptiness since plan-618; the path list is materialised once.
  runMergeEntryCheck([...net.all()], fleetHandleIds(), fleetBodies);
}

/**
 * Legacy zone claim-ahead walk (UseAcceleration = false, continuous): walk
 * the routed successors up to `LookAhead`, CLAIM every zoned path before
 * entry, and return the distance (mm) to the FIRST entrance whose claim failed.
 * Also rebuilds `l._relevantZones` for the post-advance release pass.
 */
function claimAheadZones(l: AgvLocal, t: PathTraveler): number {
  const zones = getDefaultZoneRegistry();
  const relevant = l._relevantZones;
  relevant.length = 0;
  let p = t.path as RVPath; // caller guards non-null
  if (p.zoneId) relevant.push(p.zoneId);
  if (p.closed) return Number.POSITIVE_INFINITY; // a loop has no entrances to gate
  // Queue-order guard: a leader standing between this vehicle and the entrance
  // must claim first (claiming across it inverts the queue into a gridlock).
  const gapMm = getDefaultSpacingController().gapOf(t.id) * 1000;
  let accMm = (p.length - t.s) * 1000;
  for (let i = 0; i < MAX_ZONE_WALK; i++) {
    if (accMm > l.lookAheadMm) return Number.POSITIVE_INFINITY;
    const next = t.peekNext(p, 1);
    if (!next || next === t.path) return Number.POSITIVE_INFINITY; // dead end / ring back
    const z = next.zoneId;
    if (z) {
      if (relevant.indexOf(z) < 0) relevant.push(z);
      if (!zones.isHolder(z, t.id)) {
        if (gapMm <= accMm) return Number.POSITIVE_INFINITY; // leader before the entrance — its claim, not ours
        declareWalkedZone(zones, next, z);
        if (!zones.claim(z, t.id)) return accMm; // hold at this entrance
      }
    }
    accMm += next.length * 1000;
    p = next;
    if (p.closed) return Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

/** Legacy release pass (UseAcceleration = false) — strictly AFTER the position transfer. */
function releaseStaleZones(l: AgvLocal, t: PathTraveler): void {
  const zones = getDefaultZoneRegistry();
  const relevant = l._relevantZones;
  const currentZone = t.path?.zoneId ?? null;
  if (currentZone && relevant.indexOf(currentZone) < 0) relevant.push(currentZone);
  const held = l._heldScratch;
  const n = zones.collectHeld(t.id, held);
  for (let i = 0; i < n; i++) {
    if (relevant.indexOf(held[i]) < 0) zones.release(held[i], t.id);
  }
}

// ── Task control (plan-921 — destination + service time + callbacks) ───────

/** The authority the vehicle plans through (null = legacy step mode). */
function authorityOf(l: AgvLocal): MovementAuthority | null {
  return l.mbKind ? getDefaultMovementAuthority(l.mbKind) : null;
}

/** Schedule the service end `delay` s from now on the vehicle's kernel clock. */
function scheduleServiceEnd(self: AgvSelf, delay: number): number {
  const l = self.local;
  if (l.mbKind === 'continuous') {
    const clock = getDefaultMovementAuthority('continuous').clock;
    const epoch = l.serviceEpoch;
    return clock.schedule(clock.now + delay, 0, () => {
      if (epoch !== l.serviceEpoch) return;
      l.desServiceEvent = -1;
      handleServiceEnd(self);
      bookStat(self);
    });
  }
  return self.in(delay, 'ServiceEnd', null, null);
}

function cancelServiceEnd(self: AgvSelf): void {
  const l = self.local;
  if (l.desServiceEvent < 0) return;
  if (l.mbKind === 'continuous') getDefaultMovementAuthority('continuous').clock.cancel(l.desServiceEvent);
  else if (self.mode === 'des') self.cancel(l.desServiceEvent);
  l.desServiceEvent = -1;
}

/**
 * Enter the service stay at the segment end. Two triggers, one mechanism:
 * the segment is the TASK DESTINATION (vehicle-side `serviceSec` timer), or a
 * DOCK is bound to it (station-side control — the dock's `release()` ends the
 * stay and OVERRIDES the task timer). The task's `onArrive` fires only at its
 * destination.
 */
function releaseStay(self: AgvSelf, epoch?: number): void {
  const l = self.local;
  if (epoch !== undefined && epoch !== l.serviceEpoch) return;
  if (l.phase !== 'servicing' || l.serviceMode !== 'dock') return;
  if (l.mbHost !== null) {
    if (l.phase === 'servicing' && l.desServiceEvent < 0) {
      l.desServiceEvent = scheduleServiceEnd(self, DES_MIN_TRANSIT_SEC);
    }
  } else {
    l.dockReleaseFlag = true; // legacy fixedUpdate ends the stay next tick
  }
}

function beginService(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler!;
  const dock = getDefaultPathDockRegistry().dockAt(t.path!.id);
  const isDest = atTaskDestination(l);
  l.phase = 'servicing';
  l.serviceMode = dock ? 'dock' : 'timer';
  l.serviceRemainingSec = !dock && isDest ? Math.max(0, Number(l.task!.serviceSec) || 0) : 0;
  l.dockReleaseFlag = false;
  t.v = 0;
  self.sig.Moving.set(false);
  if (isDest) {
    const task = l.task!;
    try { task.onArrive?.(t.id, task); } catch (e) { console.error('[Agv] task onArrive failed:', e); }
  }
  if (dock) {
    let released = false;
    const epoch = l.serviceEpoch;
    const release = (): void => {
      // A stay abandoned in between (manoeuvre abort, reset) ignores its late release.
      if (released || epoch !== l.serviceEpoch) return;
      released = true;
      releaseStay(self);
    };
    try { dock.onVehicleArrive(t.id, release); }
    catch (e) { console.error('[Agv] dock onVehicleArrive failed — releasing:', e); release(); }
  }
}

/**
 * Finish the service stay. At the TASK DESTINATION: fires `onServiceEnd` —
 * assigning a NEW task from inside the callback chains directly (work-plan
 * style); otherwise the vehicle parks idle and the fleet's idle channel fires.
 * At a THROUGH dock the vehicle simply resumes its route. Either way the
 * segment is marked served, so the dock does not re-trigger this visit.
 */
function endService(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler!;
  l.servedPathId = t.path?.id ?? null;
  if (!atTaskDestination(l)) {
    l.phase = l.task ? 'driving' : 'cruising';
    return;
  }
  const finished = l.task;
  self.statOutput(); // one completed job (station stop) — Output/h, Processed
  try { finished?.onServiceEnd?.(t.id, finished); } catch (e) { console.error('[Agv] task onServiceEnd failed:', e); }
  if (l.task === finished) {
    l.task = null;
    l.phase = 'idle';
    getDefaultAgvFleet().notifyIdle(t.id);
  }
}

/** True while the traveler stands ON its destination segment. */
function atTaskDestination(l: AgvLocal): boolean {
  return l.task !== null && l.traveler?.path?.id === l.task.destination;
}

/** True when the CURRENT segment's end requires a service stop this visit:
 *  task destination, or a bound dock that has not served this visit yet. */
function serviceStopAhead(l: AgvLocal): boolean {
  const p = l.traveler?.path;
  if (!p) return false;
  // The turn point of a stub manoeuvre is a stop of the forward approach (plan-595).
  const m = l.maneuver;
  if (m && p === m.turn && m.stage === 'approach') return !m.goAround;
  if (l.servedPathId === p.id) return false; // already served — drive off
  if (atTaskDestination(l)) return true;
  return getDefaultPathDockRegistry().dockAt(p.id) !== null;
}

// ── Statistics ──────────────────────────────────────────────────────────────

/**
 * Category of a service stay (plan-612): the task's `serviceState` while the
 * vehicle stands at the TASK DESTINATION, otherwise `'Working'` (a through-dock,
 * or a task without the field — unchanged behaviour).
 */
function serviceStatOf(l: AgvLocal): string {
  const s = atTaskDestination(l) ? l.task!.serviceState : undefined;
  return typeof s === 'string' && s.length > 0 ? s : 'Working';
}

/**
 * Book the vehicle's statistics category (DES + continuous StateStatistics).
 * Priority (plan-558 Phase 6): Run off → Empty; Failure (DES freeze);
 * servicing → Working (or the task's `serviceState`, plan-612); standing at a traffic stop → Stopped; driving below
 * the free profile because of traffic / the warning field → Slowed; driving
 * with a task → Transport; without → Empty. AGVs never book `Blocked`.
 * `statState` de-dupes, so calling it after every event / tick is cheap.
 */
function bookStat(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler;
  if (!t || self.sig.Run.get() !== true) { self.statState('Empty'); return; }
  if (l.frozen) { self.statState('Failure'); return; }
  if (l.phase === 'servicing') { self.statState(serviceStatOf(l)); return; }
  const mb = l.mbHost ? authorityOf(l) : null; // planned vehicles only (a legacy one books from its step model)
  const motion = mb ? mb.motionStateOf(t.id) : (t.blocked ? 'stopped' : 'free');
  if (motion === 'stopped') self.statState('Stopped');
  else if (motion === 'slowed') self.statState('Slowed');
  else if (l.phase === 'driving' && l.task) self.statState('Transport');
  else self.statState('Empty');
}

// ── Planner registration (both kernels) ─────────────────────────────────────

/** Vehicle parameters for the authority (meters / seconds). */
function plannerParams(l: AgvLocal): MbParams {
  const useAcc = l.useAcceleration;
  return {
    vmax: Math.max(0.001, l.targetSpeed / 1000),
    a: useAcc ? Math.max(0, l.acceleration / 1000) : INSTANT_RAMP,
    b: useAcc ? Math.max(0.001, l.decel / 1000) : INSTANT_RAMP,
    // UseAcceleration = false keeps the legacy jump semantics: no curve / docking limits.
    aLat: useAcc ? Math.max(0.001, l.aLat / 1000) : INSTANT_RAMP * 1000,
    front: l.frontMm / 1000,
    rear: l.rearMm / 1000,
    width: l.widthMm / 1000,
    gap: l.gapMm / 1000,
    dockSpeed: Math.max(0.001, l.dockSpeed / 1000),
    dockDist: useAcc ? Math.max(0, l.dockDist / 1000) : 0,
    reverseVmax: Math.max(0.001, (l.reverseSpeed > 0 ? l.reverseSpeed : l.dockSpeed) / 1000),
    scanner: l.scanner ? {
      reactionTime: Math.max(0, l.reactionSec),
      protectiveMargin: Math.max(0, l.protectiveMm / 1000),
      warningMargin: Math.max(0, l.warningMm / 1000),
      hysteresis: FIELD_HYSTERESIS_M,
      restartDelay: FIELD_RESTART_SEC,
    } : null,
  };
}

/** Host callbacks over `self` for one kernel. */
function makeHost(self: AgvSelf, mb: MovementAuthority, kind: MbKind): MbHost {
  const l = self.local;
  const t = l.traveler!;
  const des = kind === 'des';
  return {
    now: () => (des ? self.now : mb.clock.now),
    nextEventTime: () => (des ? self.nextEventTime : mb.clock.nextEventTime),
    schedule: (delay, k, data, tween, priority) => {
      if (des) {
        if (k === 'arrival') return self.in(delay, 'Arrival', null, tween ?? null);
        const d: Record<string, unknown> = data ?? {};
        d.kind = k;
        if (tween) d.tween = (tween as { tween: unknown }).tween;
        if (priority !== undefined) d.priority = priority;
        return self.in(delay, 'Replan', null, d);
      }
      return mb.clock.schedule(mb.clock.now + delay, priority ?? 0, () => dispatchPlanEvent(self, k, data));
    },
    cancel: (id) => { if (des) self.cancel(id); else mb.clock.cancel(id); },
    legTween: (sampler, fromX, toX, sAt) => (des ? self.pathTween(sampler, fromX, toX, undefined, undefined, sAt) : null),
    serviceStopAt: (path, current, dir) => {
      const m = l.maneuver;
      // Reverse: the only service stop is the handling position (stub START) of the
      // manoeuvre — every other piece of the explicit reverse route is passed through.
      if (dir === -1) return m !== null && path === m.stub && l.servedPathId !== path.id;
      if (current) return serviceStopAhead(l);
      if (m && path === m.turn) return m.stage === 'approach' && !m.goAround;
      return l.task?.destination === path.id || getDefaultPathDockRegistry().dockAt(path.id) !== null;
    },
    zoneCompanions: (zone) => {
      // R3-1 (K before M): the forward approach claims the merge zone only with the stub zones.
      const m = l.maneuver;
      return m && m.stage === 'approach' && !m.goAround && zone === m.mergeZone ? m.companions : null;
    },
    canMove: () => !self.disabled && self.sig.Run.get() === true
      && (l.phase === 'driving' || l.phase === 'cruising'),
    onPlanApplied: (moving, stopped) => {
      t.blocked = stopped;
      self.sig.Moving.set(moving);
      self.sig.Blocked.set(stopped);
      // The field always lies at the LEADING end — at the rear on a reverse plan (plan-595).
      const reverse = mb.planDirOf(t.id) === -1;
      self.sig.Reverse.set(reverse);
      self.sig.FieldRear.set(reverse && l.scanner);
      self.sig.Speed.set(mb.speedOf(t.id, des ? self.now : mb.clock.now) * 1000);
    },
    onArrivedAt: (prev) => {
      // The per-piece arrival of the step model — announced once per visit. A reverse
      // plan passes its pieces backwards (it reaches their START): not announced (plan-595).
      if (prev.closed || l.desArrivedPathId === prev.id || mb.planDirOf(t.id) === -1) return;
      l.desArrivedPathId = prev.id;
      t.hooks.onArrive?.(prev.id, t.id);
      t.network?.notifyArrive(prev.id, t.id);
    },
    onHandOver: (prev, next) => {
      l.desArrivedPathId = null;
      l.servedPathId = null;
      t.path = next;
      // A reverse (mirrored) plan enters the next piece at its END (plan-595).
      t.s = mb.planDirOf(t.id) === -1 ? next.length : 0;
      t.atEnd = false;
      const m = l.maneuver;
      if (m && m.goAround && prev === m.turn) {
        m.goAround = false; // next lap: the turn point counts again
        // plan-634 F4 (SOL R2 #1): the applied plan was walked while going around — a
        // further, reachable occurrence of the turn point in its horizon (short ring)
        // must become a stop again: re-walk from here.
        mb.markDirty(t.id, 'goAround-reset');
      }
    },
    onServiceStopMissed: (path) => {
      // plan-634 F4 — mutation contract: host-owned flags only (runs inside the re-plan).
      // A missed turn point is driven past: the existing go-around lap brings the
      // vehicle back. Task destinations and docks need no flag — the engine no
      // longer plans the missed stop and stops at the next occurrence.
      const m = l.maneuver;
      if (m && m.stage === 'approach' && path === m.turn) m.goAround = true;
    },
    onMotionState: (state) => {
      self.sig.Slowed.set(state === 'slowed');
      bookStat(self);
    },
    onFieldState: (state) => {
      self.sig.FieldWarning.set(state !== 'clear');
      self.sig.FieldProtective.set(state === 'protective');
    },
  };
}

/** (Re-)register the vehicle with the authority of `kind` from its traveler position. */
function registerPlanned(self: AgvSelf, kind: MbKind): MovementAuthority {
  const l = self.local;
  const t = l.traveler!;
  const mb = getDefaultMovementAuthority(kind);
  const host = makeHost(self, mb, kind);
  l.mbKind = kind;
  l.mbHost = host;
  mb.register(t.id, t, host, plannerParams(l));
  l.lastCanMove = host.canMove();
  return mb;
}

/** Re-plan after a state change of this vehicle (task, service, Run). */
function replanNow(self: AgvSelf, why: string): void {
  const l = self.local;
  const t = l.traveler;
  const mb = authorityOf(l);
  if (!t || !mb || !l.mbHost || !mb.has(t.id)) return;
  mb.markDirty(t.id, why);
  if (!l.inHook) mb.requestFlush(l.mbHost);
}

// ── Plan events (shared by the DES hooks and the continuous clock) ──────────

/** Plan end at a service stop / dead end. */
function handleArrival(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler;
  const mb = authorityOf(l);
  if (self.disabled || !t || !t.path || !mb || !l.mbHost) return;
  mb.recordEvent('Arrival', t.id, l.mbHost.now());
  mb.onLegEnd(t.id);
  const p = t.path;
  const dir = mb.planDirOf(t.id);
  // A reverse (mirrored) plan ends at the START of its last piece (plan-595).
  t.s = dir === -1 ? 0 : p.length;
  t.v = 0;
  self.sig.Position.set(t.s * 1000);
  self.sig.Speed.set(0);

  const m0 = l.maneuver;
  // A reverse arrival is announced only at the handling position (task level) — a
  // reverse plan reaches the START of its last piece, not its end (plan-595).
  if (!p.closed && l.desArrivedPathId !== p.id && (dir === 1 || (m0 !== null && p === m0.stub))) {
    l.desArrivedPathId = p.id;
    t.hooks.onArrive?.(p.id, t.id);
    t.network?.notifyArrive(p.id, t.id);
  }
  // plan-634 F6 (SOL R1 #4): a router / arrival callback may have replaced the task or
  // dropped the manoeuvre — decide on the state AFTER the callbacks, never on `m0`.
  const m = l.maneuver;

  // Stub manoeuvre (plan-595): turn point reached → reverse; handling position reached → serve.
  if (m && m.stage === 'approach' && p === m.turn && !m.goAround) { maneuverAtTurn(self); return; }
  if (m && m.stage === 'reverse' && p === m.stub) {
    if (m.pending) { endManeuver(self); return; } // aborted on the way in: leave at once, no service
    m.stage = 'dock';
  }

  // plan-634 F7 (SOL R2 #3): the plan ended at a MISSED service stop — only a dead end
  // does that (the walk drives past a missed stop otherwise). This arrival serves
  // nothing (no task / dock callback); the visit counts as done, reported.
  if (dir === 1 && serviceStopAhead(l) && mb.missedAtEnd(t.id)) {
    l.servedPathId = p.id;
    const what = atTaskDestination(l) ? `destination '${p.id}'` : `dock '${p.id}'`;
    console.warn(`[Agv] '${t.id}': ${what} was missed (not reachable when planned) and has no way back — not served`);
    reportProblem({
      id: `${SERVICE_MISSED_NO_RETURN_CODE}:${t.id}:${p.id}`,
      severity: 'warning',
      code: SERVICE_MISSED_NO_RETURN_CODE,
      title: `Service stop '${p.id}' missed without a way back (vehicle '${t.id}')`,
      detail: `Vehicle '${t.id}' could no longer stop at the end of '${p.id}' when the stop was planned `
        + '(its braking distance was longer than the remaining way) and the piece is a dead end — the stop '
        + 'was not served. Assign the task earlier or give the dead end a way back.',
    });
  }

  if (serviceStopAhead(l)) {
    beginService(self); // dock mode: the dock's release() schedules ServiceEnd
    self.sig.Blocked.set(false);
    if (l.serviceMode === 'timer') {
      l.desServiceEvent = scheduleServiceEnd(self, Math.max(l.serviceRemainingSec, DES_MIN_TRANSIT_SEC));
    }
    replanNow(self, 'serviceBegin'); // → hold plan (same trajectory, no version bump)
    return;
  }

  // A reverse plan has no routing beyond its explicit route — its end is a park
  // point like a dead end (plan-595).
  const next = dir === -1 ? null : t.peekNext(p, 1);
  if (!next) {
    // Dead end: park. The dispatch trigger fires exactly once per stop.
    const wasAtEnd = t.atEnd;
    t.atEnd = true;
    t.blocked = false;
    self.sig.Moving.set(false);
    self.sig.Blocked.set(false);
    if (!wasAtEnd) t.network?.requestDispatch(t.id);
    replanNow(self, 'deadEnd');
    return;
  }
  // The plan ended at a stop that is no longer a service stop (task changed
  // while driving) — re-plan onward.
  replanNow(self, 'arrival');
}

// ── Stub manoeuvre (plan-595) ───────────────────────────────────────────────

/**
 * Resolve the stub manoeuvre of an `approach: 'reverse'` task: the chain runs
 * from the stub over single-successor pieces up to the MERGE piece (>= 2
 * predecessors) — the turn point is the merge piece's END. Every piece of the
 * reverse route needs a capacity-1 zone. Null (with a warning) = the task is
 * approached forward.
 */
function resolveStubManeuver(l: AgvLocal, id: string, task: AgvTask): StubManeuver | null | 'rejected' {
  const refuse = (why: string): null => {
    console.warn(`[Agv] '${id}': reverse approach to '${task.destination}' refused — ${why}; approaching forward`);
    return null;
  };
  if (!l.allowReverse) return refuse('AllowReverse is off');
  if (!isReverseGateOpen()) return refuse('reverse travel is not released yet');
  if (!l.useAcceleration) return refuse('reverse travel needs UseAcceleration');
  const net = getDefaultPathNetwork();
  net.resolveGraph();
  const stub = net.get(task.destination);
  const chain: RVPath[] = [];
  let turn: RVPath | null = null;
  for (let q = stub && !stub.closed ? stub : null; q && chain.length < MAX_ZONE_WALK;) {
    chain.push(q);
    if (q.successors.length !== 1) break;
    const nx = q.successors[0];
    if (nx.predecessors.length >= 2) { turn = nx; break; }
    q = nx;
  }
  if (!stub || !turn) return refuse('no stub (a single-successor chain into a merge piece)');
  const route = [turn, ...chain.reverse()];
  const zones = getDefaultZoneRegistry();
  for (const q of route) {
    if (!q.zoneId || zones.capacityOf(q.zoneId) !== 1) return refuse(`piece '${q.id}' has no capacity-1 zone`);
  }
  // R3-2: the merge entry must be long enough for the fleet's bodies — refused BEFORE the approach.
  const short = findShortMergeEntries([turn], fleetEnvelope());
  if (short.length > 0) {
    mergeCheckStats.stubRejections++; // plan-618 F6
    const why = short.map((m) => `'${m.branchId}' (${m.pre.toFixed(2)} m, overlap ${m.penetration.toFixed(2)} m)`).join(', ');
    console.warn(`[Agv] '${id}': reverse task to '${task.destination}' REJECTED — merge entry of '${turn.id}' too short: ${why}`);
    reportProblem({
      id: `${STUB_REFUSED_CODE}:${id}:${task.destination}`,
      severity: 'warning',
      code: STUB_REFUSED_CODE,
      title: `Reverse task to '${task.destination}' rejected (vehicle '${id}')`,
      detail: `The merge entry of '${turn.id}' is too short for the vehicle bodies: ${why}. The task was not started.`,
    });
    return 'rejected';
  }
  const mergeZone = turn.zoneId!;
  const companions: string[] = [];
  for (const q of route) if (q.zoneId !== mergeZone && !companions.includes(q.zoneId!)) companions.push(q.zoneId!);
  return {
    stub, turn, route, mergeZone, companions, stage: 'approach', epoch: ++l.maneuverEpoch,
    goAround: false, pending: null, retryLogged: false,
  };
}

/**
 * Turn point reached (standstill at the END of the merge piece): switch to the
 * explicit reverse route. The stub zones were claimed together with the merge
 * zone (K before M); a vehicle that was already inside M when the task came
 * claims them now — or, when one is taken, drives on and comes back instead of
 * waiting inside M (no wait cycle with a vehicle leaving the stub).
 */
function maneuverAtTurn(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler!;
  const mb = authorityOf(l)!;
  const m = l.maneuver!;
  self.sig.Moving.set(false);
  // plan-634 F5 — detection only: the direction changes only when the PLAN position
  // (unclamped, not the clamped traveler.s) is the end of the turn piece. Otherwise
  // the vehicle stays visibly where it is: no retry, no recovery, reported.
  const overshoot = mb.overshootOf(t.id);
  if (Math.abs(overshoot) > TURN_POINT_TOL_M) {
    mb.stats.turnGuardTrips++;
    const mm = Math.round(overshoot * 1000);
    console.warn(`[Agv] '${t.id}': turn point '${m.turn.id}' not reached exactly (${mm} mm) — no direction change`);
    reportProblem({
      id: `${TURN_OVERSHOOT_CODE}:${t.id}:${m.turn.id}`,
      severity: 'warning',
      code: TURN_OVERSHOOT_CODE,
      title: `Vehicle '${t.id}' stands ${mm} mm off the turn point '${m.turn.id}'`,
      detail: `Vehicle '${t.id}' stopped ${mm} mm ${overshoot > 0 ? 'beyond' : 'short of'} the end of the turn piece `
        + `'${m.turn.id}' (overshoot ${mm} mm). The reverse manoeuvre into '${m.stub.id}' was not started.`,
    });
    return;
  }
  for (const k of m.companions) {
    if (!mb.holdZone(t.id, k, l.mbHost!.now())) {
      console.warn(`[Agv] '${t.id}': stub zone '${k}' of '${m.stub.id}' is taken — going around`);
      m.goAround = true;
      replanNow(self, 'goAround');
      return;
    }
  }
  if (mb.setDirection(t.id, -1, m.route)) {
    m.stage = 'reverse';
    self.sig.Blocked.set(false);
    replanNow(self, 'reverse');
    return;
  }
  // Refused (gate / standstill): retry — the manoeuvre is never dropped silently.
  if (!m.retryLogged) {
    console.warn(`[Agv] '${t.id}': direction change at '${m.turn.id}' refused — retrying every ${MANEUVER_RETRY_SEC} s`);
    m.retryLogged = true;
  }
  scheduleManeuverRetry(self, m.epoch);
}

/** Retry the direction change of the manoeuvre `epoch` after {@link MANEUVER_RETRY_SEC}. */
function scheduleManeuverRetry(self: AgvSelf, epoch: number): void {
  const l = self.local;
  if (l.mbKind === 'continuous') {
    const clock = getDefaultMovementAuthority('continuous').clock;
    clock.schedule(clock.now + MANEUVER_RETRY_SEC, 0, () => { retryManeuver(self, epoch); bookStat(self); });
    return;
  }
  self.in(MANEUVER_RETRY_SEC, 'Replan', null, { kind: MANEUVER_RETRY, epoch });
}

function retryManeuver(self: AgvSelf, epoch: number): void {
  const l = self.local;
  const m = l.maneuver;
  if (self.disabled || !m || m.epoch !== epoch || m.stage !== 'approach' || l.traveler?.path !== m.turn) return;
  maneuverAtTurn(self);
}

/**
 * End a manoeuvre early (abort contract R3-4) — the vehicle stands in the stub:
 * back to forward travel, no service on this visit, then the pending task.
 */
function endManeuver(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler!;
  const m = l.maneuver!;
  l.maneuver = null;
  l.maneuverEpoch++;
  l.servedPathId = m.stub.id;
  const mb = authorityOf(l);
  if (mb && !mb.setDirection(t.id, 1)) console.warn(`[Agv] '${t.id}': direction change to forward refused in '${m.stub.id}'`);
  const applied = applyTask(self, m.pending ? m.pending.task : l.task);
  // plan-559 S1: the request held back by deferDuringManeuver is in force now.
  if (m.pending && applied) notifyTaskChange(self, m.pending.task, true);
}

/**
 * clear() / assign() while a manoeuvre runs (R3-4). Approach: the manoeuvre is
 * dropped (stub zones that no route ran through are given back) and the new
 * task applies at once. Reverse leg / dock stay: the manoeuvre is finished in
 * order — on the way in up to the handling position, then out without service
 * (a dock stay ends now, its late release is void); the task applies after.
 * True = deferred.
 */
function deferDuringManeuver(self: AgvSelf, task: AgvTask | null): boolean {
  const l = self.local;
  const m = l.maneuver;
  if (!m) return false;
  if (m.stage === 'approach') {
    const mb = authorityOf(l);
    if (mb && l.traveler) for (const k of m.companions) mb.dropZone(l.traveler.id, k);
    l.maneuver = null;
    l.maneuverEpoch++;
    return false;
  }
  m.pending = { task };
  // plan-559 S1: requested, not yet in force — reported BEFORE a dock stay ends below,
  // so the `effective: true` of endManeuver always follows it.
  notifyTaskChange(self, task, false);
  if (m.stage === 'dock') {
    l.serviceEpoch++;
    cancelServiceEnd(self);
    l.phase = 'driving';
    endManeuver(self);
  }
  return true;
}

/**
 * Report a task change requested through the fleet handle (plan-559 S1) —
 * `effective: false` = held back by a manoeuvre, `true` = in force now.
 */
function notifyTaskChange(self: AgvSelf, task: AgvTask | null, effective: boolean): void {
  const t = self.local.traveler;
  if (t) getDefaultAgvFleet().notifyTaskChanged(t.id, { requested: task, effective });
}

/**
 * Apply a task (null = clear) — the shared body of the fleet handle's assign() / clear().
 * False when a reverse task is refused (R3-2) and nothing changed (plan-559 S1 reads it).
 */
function applyTask(self: AgvSelf, task: AgvTask | null): boolean {
  const l = self.local;
  const traveler = l.traveler!;
  const maneuver = task && task.approach === 'reverse' ? resolveStubManeuver(l, traveler.id, task) : null;
  if (maneuver === 'rejected') return false; // R3-2: the vehicle does not start (Problems entry written)
  if (l.phase === 'servicing') l.serviceEpoch++;
  l.task = task;
  l.phase = task ? 'driving' : 'cruising';
  if (task) {
    l.maneuver = maneuver;
    // A new task to the segment the vehicle stands on is a new visit.
    if (task.destination === traveler.path?.id) l.servedPathId = null;
  }
  l.serviceRemainingSec = 0;
  cancelServiceEnd(self);
  traveler.atEnd = false;
  const mb = authorityOf(l);
  if (mb && mb.has(traveler.id)) {
    mb.invalidateRoute(traveler.id); // a new destination re-decides the junctions ahead
    replanNow(self, 'assign');
  }
  bookStat(self);
  return true;
}

/** Plan end at a traffic / hold stop. */
function handleStop(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler;
  const mb = authorityOf(l);
  if (self.disabled || !t || !mb || !l.mbHost) return;
  const now = l.mbHost.now();
  mb.recordEvent('Replan:stop', t.id, now);
  mb.onLegEnd(t.id);
  const loc = mb.locate(t.id, now);
  if (loc) { t.s = loc.s; self.sig.Position.set(loc.s * 1000); }
  t.v = 0;
  self.sig.Moving.set(false);
  self.sig.Speed.set(0);
  const c = mb.stopCauseOf(t.id);
  const stopped = c !== null && isTrafficStop(c);
  t.blocked = stopped;
  self.sig.Blocked.set(stopped);
  mb.requestFlush(l.mbHost);
}

/** Event labels for the planner statistics / trace (no string building per event). */
const REPLAN_LABEL: Partial<Record<MbEventKind, string>> = {
  flush: 'Replan:flush', extend: 'Replan:extend', zoneRelease: 'Replan:zoneRelease', watchdog: 'Replan:watchdog',
  notify: 'Replan:notify', field: 'Replan:field', stat: 'Replan:stat', wake: 'Replan:wake',
};

/** Authority bookkeeping events (flush / extend / zone release / notify / field / stat / watchdog). */
function handlePlanEvent(self: AgvSelf, kind: MbEventKind, data: Record<string, unknown> | null): void {
  const l = self.local;
  const t = l.traveler;
  const mb = authorityOf(l);
  if (self.disabled || !t || !mb || !l.mbHost) return;
  // The shared flush belongs to the fleet, not to the vehicle whose queue slot carried it.
  mb.recordEvent(REPLAN_LABEL[kind] ?? `Replan:${kind}`, kind === 'flush' ? '*' : t.id, l.mbHost.now());
  mb.onEvent(t.id, kind, data);
  mb.requestFlush(l.mbHost);
}

/** End of the dwell — the follow-up task (if any) re-plans via assign(). */
function handleServiceEnd(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler;
  if (self.disabled || !t) return;
  const mb = authorityOf(l);
  if (mb && l.mbHost) mb.recordEvent('ServiceEnd', t.id, l.mbHost.now());
  // The stub stay ends (plan-595): back to forward travel (standstill) BEFORE the
  // callbacks, so a follow-up reverse task from onServiceEnd starts its own manoeuvre.
  const m = l.maneuver;
  if (m && m.stage === 'dock' && t.path === m.stub) {
    l.maneuver = null;
    l.maneuverEpoch++;
    if (mb && !mb.setDirection(t.id, 1)) console.warn(`[Agv] '${t.id}': direction change to forward refused in '${m.stub.id}'`);
  }
  // A follow-up task assigned from onServiceEnd re-plans together with the end.
  l.inHook = true;
  try { endService(self); } finally { l.inHook = false; }
  if (l.phase === 'idle') self.sig.Moving.set(false);
  replanNow(self, 'serviceEnd');
}

/** Continuous-clock dispatch of one plan event (DES routes through the hooks). */
function dispatchPlanEvent(self: AgvSelf, kind: MbEventKind, data: Record<string, unknown> | null): void {
  if (kind === 'arrival') handleArrival(self);
  else if (kind === 'stop') handleStop(self);
  else handlePlanEvent(self, kind, data);
  bookStat(self);
}

/** Drop every trace of the vehicle from the shared traffic state (re-setup / teardown). */
function releaseVehicle(self: AgvSelf, wake: boolean): void {
  const l = self.local;
  const t = l.traveler;
  if (!t) return;
  getDefaultSpacingController().remove(t.id);
  getDefaultZoneRegistry().releaseAll(t.id);
  const mb = authorityOf(l);
  if (mb) mb.unregister(t.id, wake);
  l.mbKind = null;
  l.mbHost = null;
}

// ── Ownership contract (plan-648 §2.2) ──────────────────────────────────────

/** Register this instance's fleet handle — the low-level control surface for project fleet logic. */
function registerFleetHandle(self: AgvSelf): void {
  const l = self.local;
  const traveler = l.traveler!;
  getDefaultAgvFleet().register({
    id: traveler.id,
    kernel: l.kernelKind,
    releaseStay: (epoch?: number) => releaseStay(self, epoch),
    stayEpoch: () => l.serviceEpoch,
    assign: (task: AgvTask) => {
      if (deferDuringManeuver(self, task)) return; // reported there as effective: false (plan-559 S1)
      if (applyTask(self, task)) notifyTaskChange(self, task, true);
    },
    clear: () => {
      if (deferDuringManeuver(self, null)) return;
      if (applyTask(self, null)) notifyTaskChange(self, null, true);
    },
    get task() { return l.task; },
    get phase() { return l.phase; },
    node: self.root,
    get startPathId() { return l.startPath?.id ?? null; },
    motion: (out: AgvMotionInfo): boolean => {
      const mb = l.mbHost ? authorityOf(l) : null;
      if (!mb || !mb.has(traveler.id)) return false;
      const speed = mb.renderSpeedOf(traveler.id);
      out.speed = speed;
      out.field = mb.fieldStateOf(traveler.id);
      out.protectiveLength = mb.protectiveFieldLength(traveler.id, speed);
      out.warningLength = out.protectiveLength + l.warningMm / 1000;
      out.front = l.frontMm / 1000;
      out.rear = l.rearMm / 1000;
      out.dir = mb.planDirOf(traveler.id);
      out.width = l.widthMm / 1000;
      out.scanner = l.scanner;
      return true;
    },
    // plan-629 congestion trace: source = actual planner binding (registerPlanned sets mbHost;
    // registerExternal does not), live while an interface controls the vehicle.
    get traceSource() { return self.isWired ? 'live' : l.mbHost ? 'planned' : 'legacy'; },
    body: (out) => { out.front = l.frontMm / 1000; out.rear = l.rearMm / 1000; out.width = l.widthMm / 1000; },
    signalStatus: (out) => {
      out.run = self.sig.Run.get() === true;
      out.moving = self.sig.Moving.get() === true;
      out.blocked = self.sig.Blocked.get() === true;
      const sp = self.sig.Speed.get();
      out.speed = typeof sp === 'number' && Number.isFinite(sp) ? sp / 1000 : 0;
    },
    travelerState: (out) => {
      if (!traveler.path) return false;
      out.path = traveler.path; out.s = traveler.s; out.speed = traveler.v / 1000; out.atEnd = traveler.atEnd;
      return true;
    },
    // plan-559 S2: the PLAN location at the host's clock (DES: the event time
    // `self.now`; continuous: the shared authority clock) — never traveler.s,
    // which the continuous mode draws shifted (#202). s and dir come from the
    // same applied plan (`locate` mirrors s by that plan's direction).
    locate: (out: AgvLocation): boolean => {
      const host = l.mbHost;
      const mb = host && !self.isWired ? authorityOf(l) : null;
      if (!host || !mb) return false;
      const now = host.now();
      const loc = mb.locate(traveler.id, now);
      if (!loc) return false;
      out.pathId = loc.path.id;
      out.s = loc.s;
      out.dir = mb.planDirOf(traveler.id);
      out.t = now;
      return true;
    },
  });
}

/**
 * Take the vehicle id (plan-648 §2.2 `acquire`, R2-5): only for an instance of
 * the active traffic kernel. (1) a foreign owner of the id is released first,
 * (2) this instance becomes the owner BEFORE anything is registered (a
 * synchronous fleet subscriber already sees the right owner), (3) the fleet
 * handle. Already the owner: the handle is re-registered only on
 * `refreshHandle` (a re-setup of the same instance — the DES restart — fires
 * `onRegister` again, as before plan-648). Returns whether `self` owns the id.
 * Spacing and the start-zone claim follow in {@link attachTraffic}, the
 * planner registration in the kernel's start kick.
 */
function acquire(self: AgvSelf, refreshHandle: boolean): boolean {
  const l = self.local;
  if (self.disabled || !l.active || !l.traveler || !kernelLive(l)) return false;
  const id = travelerIdOf(self);
  const cur = trafficOwner.get(id);
  if (cur === self) {
    if (refreshHandle) registerFleetHandle(self);
    return true;
  }
  if (cur) release(cur, false);
  trafficOwner.set(id, self);
  registerFleetHandle(self);
  return true;
}

/** Owner only: join the shared headway index and claim the zone the vehicle stands in. */
function attachTraffic(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler!;
  getDefaultSpacingController().add(t, { lookAhead: l.lookAheadMm / 1000 });
  getDefaultZoneRegistry().releaseAll(t.id);
  claimCurrentZone(t);
}

/**
 * Give the vehicle id up (plan-648 §2.2 `release`): fleet step, spacing, zones,
 * planner, fleet handle, owner entry. A no-op unless `self` is the owner — a
 * foreign instance can delete nothing.
 */
function release(self: AgvSelf, wake: boolean): void {
  const l = self.local;
  const t = l.traveler;
  if (!t || trafficOwner.get(travelerIdOf(self)) !== self) return;
  // F3: a dock release / service end / manoeuvre retry of the released owner is void from now on.
  l.serviceEpoch++;
  cancelServiceEnd(self);
  l.maneuverEpoch++;
  fleetForget(self, t.id, false);
  releaseVehicle(self, wake);
  getDefaultAgvFleet().unregister(t.id);
  trafficOwner.delete(travelerIdOf(self));
}

/** The continuous planner joins the vehicle from its traveler position at the current clock time (plan-632). */
function attachContinuousPlanner(self: AgvSelf, member: boolean): void {
  const l = self.local;
  const t = l.traveler!;
  const mb = registerPlanned(self, 'continuous');
  // plan-632: join the shared fleet step at the current clock time (never an own clock).
  l.cTime = mb.clock.now;
  l.stepFrame = -1;
  fleetForget(self, t.id, true);
  if (member) fleetStepOf(mb).members.set(t.id, self);
  mb.markDirty(t.id, 'start');
  mb.requestFlushDeferred(l.mbHost!);
}

/**
 * Read `Active` at setup and reset: false takes the vehicle out of service
 * for the next run (no fleet id, no traffic, hidden). Release only its own id.
 */
function applyActive(self: AgvSelf): boolean {
  const l = self.local;
  const active = cfgBool(configBag(self), 'Active', DEFAULTS.Active);
  if (!active && ownsTraffic(self)) release(self, false);
  l.active = active;
  if (!active) { self.root.visible = false; l.hiddenByActive = true; }
  else if (l.hiddenByActive) { self.root.visible = true; l.hiddenByActive = false; }
  return active;
}

/**
 * Restart from the start pose (plan-648 §2.2 / G1 / G3 / G4) — the simulation
 * reset of the continuous binding and the takeover of a continuous binding
 * after a DES phase run the same path:
 *   (1) drop the vehicle's own events and stay (epochs bumped — old dock /
 *       service callbacks die), task / service / manoeuvre back to the
 *       declarative start task;
 *   (2) the owner drops its claims and planner entry (spacing and handle stay);
 *   (3) start path + start position re-resolved, traveler re-seeded;
 *   (4) a non-owner acquires — refused while its kernel is not active: then
 *       NOTHING shared is touched (no pose, no signal, no claim);
 *   (5) owner: start-zone claim, pose, signals, continuous planner + start kick.
 * `activate` (kernel takeover): the vehicle runs again (`Run`, as at setup)
 * and joins the continuous fleet step as a member.
 */
function restartVehicle(self: AgvSelf, activate: boolean): void {
  const l = self.local;
  const t = l.traveler;
  l.atNodeId = null;
  // Plan-921: cancel a pending service stay and re-arm the declarative config
  // task (imperative fleet tasks do NOT survive a reset).
  cancelServiceEnd(self);
  l.serviceRemainingSec = 0;
  l.serviceMode = 'timer';
  l.dockReleaseFlag = false;
  l.servedPathId = null;
  l.task = l.startTask ? { ...l.startTask } : null;
  l.phase = l.task ? 'driving' : 'cruising';
  l.maneuver = null;   // plan-595: a reset ends every manoeuvre (the planner entry restarts with dir = +1)
  l.maneuverEpoch++;
  l.serviceEpoch++;
  l.desArrivedPathId = null;
  l.frozen = false;
  l.frozenServiceSec = -1;
  if (!applyActive(self)) return; // out of service: no id, no traffic, hidden
  const kind = l.mbKind;
  let owned = !t;
  if (t) {
    const owner = ownsTraffic(self);
    if (owner) {
      // Release EVERY held zone and the planner entry FIRST (a reset that keeps
      // a claim or a plan deadlocks / ghosts the traffic), then re-seed the
      // traveler deterministically on its start path.
      getDefaultZoneRegistry().releaseAll(t.id);
      const mb = authorityOf(l);
      if (mb) mb.unregister(t.id);
    }
    // A non-owner never touches the authority entry (it belongs to the owner).
    l.mbKind = null;
    l.mbHost = null;
    // plan-453 §2.4c: a live edit (`RVPathComponent.reapplyConfig`) REPLACES the
    // RVPath object, so the start path is re-resolved from the network — the
    // CONFIGURED PathId first (plan-628 may change it), else the id of the
    // previous start path — and the start position is recomputed from the
    // configuration with the same formula as setup(), clamped to the new length.
    if (l.startPath) {
      const net = getDefaultPathNetwork();
      const bag = configBag(self);
      const cfgPathId = typeof bag['PathId'] === 'string' ? (bag['PathId'] as string) : '';
      l.startPath = (cfgPathId ? net.get(cfgPathId) : null) ?? net.get(l.startPath.id) ?? l.startPath;
      l.startPosM = Math.min(Math.max(0, cfgNumber(bag, 'StartPosition', DEFAULTS.StartPosition) / 1000), l.startPath.length);
    }
    if (l.startPath) t.path = l.startPath;
    t.s = l.startPosM;
    t.v = 0;
    t.atEnd = false;
    t.blocked = false;
    owned = owner;
    if (!owner && acquire(self, false)) {
      owned = true;
      getDefaultSpacingController().add(t, { lookAhead: l.lookAheadMm / 1000 });
    }
    if (owned) {
      claimCurrentZone(t);
      applyPose(self);
      if (activate && !self.isWired) self.sig.Run.set(true);
      // Continuous: re-join the planner from the start pose (DES re-registers at onGenerate).
      const continuous = owner ? kind === 'continuous' : l.kernelKind === 'continuous';
      if (continuous && l.useAcceleration) attachContinuousPlanner(self, activate);
    }
  }
  if (!owned) return; // muted: the shared node's signals belong to the owner
  self.sig.Moving.set(false);
  self.sig.Position.set(l.startPosM * 1000);
  self.sig.AtNode.set(false);
  self.sig.Blocked.set(false);
  self.sig.Speed.set(0);
  self.sig.Slowed.set(false);
  self.sig.FieldWarning.set(false);
  self.sig.FieldProtective.set(false);
  self.sig.Reverse.set(false);
  self.sig.FieldRear.set(false);
}

/**
 * Continuous runner hook, kernel switch OUT of continuous (plan-648 §2.4): every
 * continuous binding gives its id up. The runner clears the continuous
 * authority afterwards.
 */
export function suspendContinuousAgvs(): void {
  for (const s of continuousInstances) release(s, false);
}

/**
 * Continuous runner hook, kernel switch INTO continuous (plan-648 §2.4 / G2):
 * every live continuous binding WITHOUT ownership — suspended, or bound while
 * DES ran (late placement, DES boot) — restarts from its start pose and
 * acquires its id. Owners stay untouched (first start unchanged).
 */
export function activateContinuousAgvs(): void {
  for (const s of continuousInstances) {
    if (s.disabled || !s.local.traveler || ownsTraffic(s)) continue;
    restartVehicle(s, true);
  }
}

/** Diagnostics (plan-648 tests): the kernel of the instance owning `id`, or null. */
export function agvTrafficOwnerKind(id: string): MbKind | null {
  return trafficOwner.get(id)?.local.kernelKind ?? null;
}

// ── Continuous fleet step (plan-632) ────────────────────────────────────────
//
// ONE shared fixed-step time per movement authority. Per fixed step:
//   1. inputs of ALL vehicles — legacy step-model vehicles (UseAcceleration =
//      false) take their step and update their obstacle entry; planned vehicles
//      turn a Run / phase edge into a re-plan request at the step START time;
//   2. exactly ONE `mb.clock.advanceTo(now + dt)` — every plan event due inside
//      the step runs at its exact time;
//   3. every planned vehicle is synced at the SAME `clock.now`, posed and its
//      signals are written (`cTime = clock.now`).
// The first vehicle whose fixedUpdate runs in a step drives the step for the
// whole fleet; the others only mark themselves as seen. Before plan-632 every
// vehicle advanced the clock itself, so vehicle i was drawn at (n+i)·dt and a
// vehicle re-planned inside a later vehicle's advance was synced BEFORE its new
// plan start t0 (clamped to x0 → a one-tick jump, #202).
//
// Step key: `host.fixedStepCount` (BindContextHost; RVViewer = its fixed-step
// counter, catch-up steps included). A new step begins when the key differs
// from the key of the record's last step.
//
// RESTRICTED FALLBACK CONTRACT — a host WITHOUT `fixedStepCount` (minimal test
// hosts that call `iterateFixedUpdate` per handle): a new step begins when a
// vehicle that already ran in the current step is called again, or none ran
// yet (repeat-caller heuristic). Exact for fleets in which every vehicle is
// called once per step. A vehicle that SKIPS steps (wired / live-controlled)
// and resumes ahead of the others in the iteration order shifts the step
// boundary: the fleet loses ONE step of clock advance at that resume — once per
// such resume, with no bound over a run. A one-time dev warning names the
// fallback. RVViewer always provides the key.
//
// Lifecycle: continuous.setup / reset join at the current clock time (no own
// clock); a vehicle that joins while a step is already done (bound, reset or
// re-registered mid-step) is processed on its own at that step's time — the
// clock is NOT advanced a second time. teardown leaves the record. A clock that
// runs backwards (authority cleared, last vehicle gone → clock reset) starts a
// fresh record.

/** Tolerance (s) of the dev counter "synced before the plan start". */
const SYNC_BEFORE_T0_EPS = 1e-9;

interface FleetStep {
  /** Fleet step id of the current step (module-wide monotonic — survives a fresh record). */
  frame: number;
  /** Vehicle ids that already ran in the current step (fallback heuristic). */
  seen: Set<string>;
  /** Every vehicle of this authority's continuous fleet, by id (insertion order = step order). */
  members: Map<string, AgvSelf>;
  /** Clock advances made by fleet steps. */
  advances: number;
  /** Clock time after the last advance — a clock below it restarts the record. */
  lastNow: number;
  /** Host step key of the last step (NaN = none / fallback). */
  lastKey: number;
}

let fleetStepSeq = 0;
const fleetSteps = new WeakMap<MovementAuthority, FleetStep>();
const stepDiag = { syncBeforeT0: 0, keyedSteps: 0, fallbackSteps: 0, fallbackWarned: false };

/** The fleet step record of `mb` (fresh when the clock went backwards). */
function fleetStepOf(mb: MovementAuthority): FleetStep {
  let f = fleetSteps.get(mb);
  if (!f || mb.clock.now < f.lastNow - 1e-12) {
    f = { frame: -1, seen: new Set(), members: new Map(), advances: 0, lastNow: mb.clock.now, lastKey: Number.NaN };
    fleetSteps.set(mb, f);
  }
  return f;
}

/**
 * A vehicle (re-)joins (`keepMember`: it stays a member) or leaves (teardown): it
 * has not run in the current step. Leaving drops the member only while it is
 * still `self` — a rejoin under the same id may already have replaced it.
 */
function fleetForget(self: AgvSelf, id: string, keepMember: boolean): void {
  const f = fleetSteps.get(getDefaultMovementAuthority('continuous'));
  if (!f) return;
  f.seen.delete(id);
  if (!keepMember && f.members.get(id) === self) f.members.delete(id);
}

/** True for a vehicle the continuous fixed step drives at all (mirrors the fixedUpdate guards). */
function fleetEligible(s: AgvSelf): boolean {
  const t = s.local.traveler;
  return !!t && !!t.path && !s.isWired && !s.disabled;
}

/** True for a LEGACY step-model vehicle (UseAcceleration = false, or not planned). */
function fleetLegacy(s: AgvSelf): boolean {
  const l = s.local;
  return !l.useAcceleration || l.mbKind !== 'continuous' || !l.mbHost;
}

/** True for a vehicle planned (and registered) by the continuous authority. */
function fleetPlanned(s: AgvSelf, mb: MovementAuthority): boolean {
  return !fleetLegacy(s) && mb.has(s.local.traveler!.id);
}

/** Input stage of a LEGACY vehicle: its own step, then its obstacle entry for the planned ones. */
function fleetLegacyStep(s: AgvSelf, mb: MovementAuthority, dt: number): void {
  const l = s.local;
  const t = l.traveler!;
  legacyFixedUpdate(s, dt);
  if (!mb.has(t.id)) {
    l.mbKind = 'continuous';
    mb.registerExternal(t.id, t, plannerParams(l), () => mb.clock.now);
  } else {
    mb.updateExternal(t.id);
  }
  bookStat(s);
}

/** Input stage of a PLANNED vehicle: Run / phase edge → re-plan at the current clock time. */
function fleetPlannedInput(s: AgvSelf, mb: MovementAuthority): void {
  const l = s.local;
  const host = l.mbHost!;
  // The DES kernel observes Run at its events only — the continuous step sees it at once.
  const can = host.canMove();
  if (can !== l.lastCanMove) {
    l.lastCanMove = can;
    mb.markDirty(l.traveler!.id, 'run');
    mb.requestFlush(host);
  }
  sensorLimitInput(l.traveler!.id, mb, host);
}

/**
 * plan-664 Phase 0 — push the geometric sensor limit into the authority INSIDE
 * the input stage, i.e. before `clock.advanceTo` of this step. That placement is
 * the point: a new obstacle must change the plan without waiting for a Run or
 * task edge and without a due authority event (SOL #2). `requestFlush` runs the
 * re-plan inline here, so the step that measures the obstacle is already the
 * step that brakes for it.
 *
 * Without a registered source the vehicle is untouched — bit-identical to a
 * fleet that knows no scanner.
 */
function sensorLimitInput(id: string, mb: MovementAuthority, host: MbHost): void {
  const fleet = getDefaultAgvFleet();
  if (!fleet.hasSensorLimitSources) return;
  const src = fleet.sensorLimitSourceOf(id);
  if (!src) return;
  const limit = src(host.now());
  const changed = limit && limit.state !== 'clear' ? mb.setSensorLimit(id, limit) : mb.clearSensorLimit(id);
  if (changed) mb.requestFlush(host);
}

/** Output stage of a PLANNED vehicle: sync to the shared step time, pose, signals. */
function fleetPlannedOutput(s: AgvSelf, mb: MovementAuthority): void {
  const l = s.local;
  const t = l.traveler!;
  const now = mb.clock.now;
  const plan = mb.planOf(t.id);
  if (plan && now < plan.profile.t0 - SYNC_BEFORE_T0_EPS) stepDiag.syncBeforeT0++;
  l.cTime = now;
  mb.syncTo(t.id, now);
  applyPose(s);
  const speed = mb.speedOf(t.id, now);
  t.v = speed * 1000;
  s.sig.Moving.set(speed > 1e-6);
  s.sig.Position.set(t.s * 1000);       // mm — drive parity
  s.sig.Speed.set(speed * 1000);
  s.sig.AtNode.set(l.atNodeId !== null); // one-tick pulse
  l.atNodeId = null;
  bookStat(s);
}

/** One fixed step of the whole fleet of `mb`: inputs of all → one advance → sync + pose of all. */
function runFleetStep(mb: MovementAuthority, f: FleetStep, caller: AgvSelf, dt: number): void {
  // 1. Inputs — legacy vehicles first (they are obstacles of the planned ones). A legacy
  //    member that believes it is registered but is not (its authority was cleared
  //    underneath it) only steps from its OWN call: a stale member must never re-enter
  //    as an obstacle. Fresh / reset legacy vehicles (mbKind null) step here.
  for (const s of f.members.values()) {
    if (!fleetEligible(s) || !fleetLegacy(s)) continue;
    if (s !== caller && s.local.mbKind === 'continuous' && !mb.has(s.local.traveler!.id)) continue;
    fleetLegacyStep(s, mb, dt);
    s.local.stepFrame = f.frame;
  }
  for (const s of f.members.values()) {
    if (fleetEligible(s) && fleetPlanned(s, mb)) fleetPlannedInput(s, mb);
  }
  // 2. ONE advance of the shared clock: every event due in this step at its exact time.
  mb.clock.advanceTo(mb.clock.now + dt);
  f.advances++;
  f.lastNow = mb.clock.now;
  // 3. Outputs — everybody at the same time.
  for (const s of f.members.values()) {
    if (!fleetEligible(s) || !fleetPlanned(s, mb)) continue;
    fleetPlannedOutput(s, mb);
    s.local.stepFrame = f.frame;
  }
}

/** One vehicle's continuous fixedUpdate: starts the fleet step when it is the first of the step. */
function fleetFixedUpdate(self: AgvSelf, dt: number): void {
  const l = self.local;
  const id = l.traveler!.id;
  const mb = getDefaultMovementAuthority('continuous');
  const f = fleetStepOf(mb);
  f.members.set(id, self);
  const key = (self.viewer as { fixedStepCount?: unknown } | null | undefined)?.fixedStepCount;
  let newStep: boolean;
  if (typeof key === 'number') {
    newStep = key !== f.lastKey;
    if (newStep) { f.lastKey = key; stepDiag.keyedSteps++; }
  } else {
    // Restricted fallback contract (see the section note above).
    newStep = f.seen.size === 0 || f.seen.has(id);
    if (newStep) {
      f.lastKey = Number.NaN;
      stepDiag.fallbackSteps++;
      if (!stepDiag.fallbackWarned) {
        stepDiag.fallbackWarned = true;
        if (import.meta.env.DEV) {
          console.warn('[Agv] the host provides no fixedStepCount — the continuous fleet step falls back to the '
            + 'repeat-caller heuristic (restricted: exact while every vehicle runs once per step; a vehicle '
            + 'resuming after skipped steps can cost the fleet ONE step of clock advance). Provide '
            + 'BindContextHost.fixedStepCount.');
        }
      }
    }
  }
  if (newStep) {
    f.seen.clear();
    f.frame = ++fleetStepSeq;
    runFleetStep(mb, f, self, dt);
  }
  f.seen.add(id);
  if (l.stepFrame === f.frame) return;
  // Joined after this step was taken (bound / reset / re-registered mid-step):
  // processed on its own, at the step's time — the clock is NOT advanced again.
  if (fleetPlanned(self, mb)) {
    fleetPlannedInput(self, mb);
    fleetPlannedOutput(self, mb);
  } else if (fleetLegacy(self)) {
    fleetLegacyStep(self, mb, dt);
  }
  l.stepFrame = f.frame;
}

/** Read-only view of the continuous fleet step (plan-632) — tests / diagnostics. */
export interface AgvFleetStepDiagnostics {
  /** Fleet step id of the current step (-1 = none in the current record). */
  readonly frame: number;
  /** Clock advances of the current record (one per fleet step). */
  readonly advances: number;
  /** Members of the current record. */
  readonly members: number;
  /** Last sync time (s) of every member, by id (NaN = not synced yet). */
  readonly syncTimes: Readonly<Record<string, number>>;
  /** Syncs at a time before the applied plan's start t0 (must stay 0 — #202). */
  readonly syncBeforeT0: number;
  /** Steps started by the host step key / by the fallback heuristic. */
  readonly keyedSteps: number;
  readonly fallbackSteps: number;
  /** The one-time fallback warning has been issued. */
  readonly fallbackWarned: boolean;
}

/** Snapshot of the continuous fleet step state (allocates — not for the tick). */
export function agvFleetStepDiagnostics(): AgvFleetStepDiagnostics {
  const f = fleetSteps.get(getDefaultMovementAuthority('continuous'));
  const syncTimes: Record<string, number> = {};
  if (f) for (const [id, s] of f.members) syncTimes[id] = s.local.cTime;
  return {
    frame: f?.frame ?? -1, advances: f?.advances ?? 0, members: f?.members.size ?? 0, syncTimes,
    syncBeforeT0: stepDiag.syncBeforeT0, keyedSteps: stepDiag.keyedSteps, fallbackSteps: stepDiag.fallbackSteps,
    fallbackWarned: stepDiag.fallbackWarned,
  };
}

/** Zero the fleet step counters and re-arm the one-time fallback warning (test isolation). */
export function resetAgvFleetStepDiagnostics(): void {
  stepDiag.syncBeforeT0 = 0;
  stepDiag.keyedSteps = 0;
  stepDiag.fallbackSteps = 0;
  stepDiag.fallbackWarned = false;
}

// ── Legacy step mode (UseAcceleration = false, continuous) ──────────────────

/**
 * The pre-558 continuous model: 1D car-following (`computeCarFollowingSpeed`,
 * SafetyDistance / MinGap / HeadwayGain) + per-tick zone claim walk + hard
 * no-penetration clamp. Kept as the fallback for `UseAcceleration = false`.
 */
function legacyFixedUpdate(self: AgvSelf, dt: number): void {
  const l = self.local;
  const t = l.traveler!;
  const run = self.sig.Run.get() === true;

  if (l.servedPathId !== null && t.path!.id !== l.servedPathId) l.servedPathId = null;

  if (l.phase === 'servicing') {
    t.v = 0;
    if (l.serviceMode === 'dock') {
      if (l.dockReleaseFlag) endService(self);
    } else {
      l.serviceRemainingSec -= dt;
      if (l.serviceRemainingSec <= 0) endService(self);
    }
    self.sig.Moving.set(false);
    self.sig.Blocked.set(false);
    self.sig.Speed.set(0);
    return;
  }
  if (l.phase === 'idle') {
    t.v = 0;
    self.sig.Moving.set(false);
    self.sig.Blocked.set(false);
    self.sig.Speed.set(0);
    return;
  }

  const gapM = getDefaultSpacingController().gapOf(t.id);
  let headwayCap = Number.POSITIVE_INFINITY;
  let headwayFreeMm = Number.POSITIVE_INFINITY;
  let headwayStopMm = Number.POSITIVE_INFINITY;
  if (Number.isFinite(gapM)) {
    const gapMm = gapM * 1000;
    headwayCap = computeCarFollowingSpeed(gapMm, l.safetyDistanceMm, l.headwayGain, l.targetSpeed);
    headwayFreeMm = Math.max(0, gapMm - l.minGapMm);
    headwayStopMm = Math.max(0, gapMm - l.safetyDistanceMm);
  }
  const zoneHoldMm = claimAheadZones(l, t);
  const destStopMm = serviceStopAhead(l)
    ? Math.max(0, (t.path!.length - t.s) * 1000)
    : Number.POSITIVE_INFINITY;
  const stopMm = Math.min(remainingToStopMm(t), zoneHoldMm, headwayStopMm, destStopMm);
  const target = run ? Math.min(l.targetSpeed, headwayCap) : 0;
  if (t.atEnd || stopMm <= 0) {
    t.v = 0;
  } else {
    t.v = computeRampedSpeed(t.v, target, l.acceleration, l.useAcceleration, stopMm, dt);
  }
  let parkedByConstraint = false;
  if (t.v > 0) {
    const hardMm = Math.min(headwayFreeMm, zoneHoldMm, destStopMm);
    if (Number.isFinite(hardMm)) {
      const allowedMm = Math.max(0, hardMm - HARD_CLAMP_BACKOFF_MM);
      if (t.v * dt > allowedMm) {
        if (allowedMm <= PARK_EPS_MM) {
          t.v = 0;
          parkedByConstraint = true;
        } else {
          t.v = allowedMm / dt;
        }
      }
    }
  }
  t.advance(dt);
  applyPose(self);
  releaseStaleZones(l, t);
  if ((l.phase === 'driving' || l.phase === 'cruising') && serviceStopAhead(l)
      && (t.path!.length - t.s) * 1000 <= PARK_EPS_MM) {
    beginService(self);
    self.sig.Position.set(t.s * 1000);
    return;
  }
  const blocked = run && !t.atEnd && t.v === 0 && (
    parkedByConstraint ||
    (Number.isFinite(gapM) && headwayCap === 0) ||
    zoneHoldMm <= PARK_EPS_MM
  );
  t.blocked = blocked;
  self.sig.Moving.set(Math.abs(t.v) > 1e-3);
  self.sig.Position.set(t.s * 1000);
  self.sig.Speed.set(t.v);
  self.sig.AtNode.set(l.atNodeId !== null);
  self.sig.Blocked.set(blocked);
  l.atNodeId = null;
}

// ── Definition ──────────────────────────────────────────────────────────────

const def = {
  type: 'Agv' as const,
  kind: 'conveyor' as const,
  statsKind: 'vehicle' as const, // display only (stats chips / MCP); `kind` stays 'conveyor' (topology)
  bake: 'chunk' as const, // the vehicle moves its own node — its body must be its own chunk
  pick: 'select' as const, // a vehicle is an object of its own: click → inspector + DES statistics
  description: 'Autonomous vehicle (FTS/AGV) that follows an rv_extras.Path graph.',
  mcpDocs:
    'Path-following vehicle (plan-268 / plan-558). Rides the rv_extras.Path graph: PathId selects a ' +
    'registered path (else the first Path node under the root is used). Motion is a closed-form ' +
    'speed profile: TargetSpeed / Acceleration / Deceleration (mm/s, mm/s²), curve limit ' +
    'v <= sqrt(LateralAcceleration * R), docking crawl (DockingSpeed over DockingDistance before a ' +
    'service stop). Distance control is a trajectory-based moving block: a follower keeps SafetyGap ' +
    '(mm) between its front and the leader rear (VehicleLength / VehicleWidth, 0 = from the mesh). ' +
    'Zones (rv_extras.Path zone/zoneCapacity) are claimed before the front enters and released when ' +
    'the rear has left. Optional scanner fields (ScannerFields, ScannerReactionTime, ProtectiveMargin, ' +
    'WarningMargin): warning caps the speed, protective stops. Routing at junctions is a ' +
    'project-injectable id-based hook (selectNextPath); default is successors[0]. Signals: Agv.Run ' +
    '(command), Agv.Moving, Agv.Position (mm), Agv.AtNode (pulse), Agv.Blocked (stopped by traffic), ' +
    'Agv.Speed (mm/s), Agv.Slowed, Agv.FieldWarning, Agv.FieldProtective. UseAcceleration=false keeps ' +
    'the legacy car-following step mode (SafetyDistance/MinGap/LookAhead/HeadwayGain). AllowReverse + ' +
    'ReverseSpeed (mm/s, 0 = DockingSpeed): a task with approach "reverse" to a stub (authored from the ' +
    'handling position toward the lane) is served forks-first — forward to the end of the merge piece, ' +
    'reverse into the stub, serve at its start, leave forward.',
  models: ['*Agv*', '*AGV*'],
  schema: {
    TargetSpeed:         { type: 'number' as const, default: DEFAULTS.TargetSpeed, unit: 'mm/s' },
    Acceleration:        { type: 'number' as const, default: DEFAULTS.Acceleration },
    UseAcceleration:     { type: 'boolean' as const, default: DEFAULTS.UseAcceleration },
    PathId:              { type: 'string' as const, default: DEFAULTS.PathId },
    StartPosition:       { type: 'number' as const, default: DEFAULTS.StartPosition },
    // Plan-921 — declarative one-shot task (no callbacks): drive to
    // Destination (any path id), wait ServiceTime seconds, then idle.
    Destination:         { type: 'string' as const, default: '' },
    ServiceTime:         { type: 'number' as const, default: 0 },
    SafetyDistance:      { type: 'number' as const, default: DEFAULTS.SafetyDistance },
    MinGap:              { type: 'number' as const, default: DEFAULTS.MinGap },
    LookAhead:           { type: 'number' as const, default: DEFAULTS.LookAhead },
    HeadwayGain:         { type: 'number' as const, default: DEFAULTS.HeadwayGain },
    // Plan-558 — distance control (web-only fields, no Unity counterpart).
    Deceleration:        { type: 'number' as const, default: DEFAULTS.Deceleration },
    LateralAcceleration: { type: 'number' as const, default: DEFAULTS.LateralAcceleration },
    VehicleLength:       { type: 'number' as const, default: DEFAULTS.VehicleLength },
    VehicleWidth:        { type: 'number' as const, default: DEFAULTS.VehicleWidth },
    SafetyGap:           { type: 'number' as const, default: DEFAULTS.SafetyGap },
    DockingSpeed:        { type: 'number' as const, default: DEFAULTS.DockingSpeed },
    DockingDistance:     { type: 'number' as const, default: DEFAULTS.DockingDistance },
    ScannerFields:       { type: 'boolean' as const, default: DEFAULTS.ScannerFields },
    ScannerReactionTime: { type: 'number' as const, default: DEFAULTS.ScannerReactionTime },
    ProtectiveMargin:    { type: 'number' as const, default: DEFAULTS.ProtectiveMargin },
    WarningMargin:       { type: 'number' as const, default: DEFAULTS.WarningMargin },
    // Plan-595 — reverse travel (web-only fields, no Unity counterpart).
    AllowReverse:        { type: 'boolean' as const, default: DEFAULTS.AllowReverse },
    ReverseSpeed:        { type: 'number' as const, default: DEFAULTS.ReverseSpeed },
    Active:              { type: 'boolean' as const, default: DEFAULTS.Active },
  },

  signals: SIGNALS,

  state: (): AgvLocal => ({
    traveler: null,
    targetSpeed: DEFAULTS.TargetSpeed,
    acceleration: DEFAULTS.Acceleration,
    useAcceleration: DEFAULTS.UseAcceleration,
    task: null,
    startTask: null,
    phase: 'cruising',
    serviceRemainingSec: 0,
    desServiceEvent: -1,
    serviceMode: 'timer',
    dockReleaseFlag: false,
    servedPathId: null,
    safetyDistanceMm: DEFAULTS.SafetyDistance,
    minGapMm: DEFAULTS.MinGap,
    lookAheadMm: DEFAULTS.LookAhead,
    headwayGain: DEFAULTS.HeadwayGain,
    startPath: null,
    startPosM: 0,
    atNodeId: null,
    desArrivedPathId: null,
    decel: DEFAULTS.Deceleration,
    aLat: DEFAULTS.LateralAcceleration,
    frontMm: FALLBACK_LENGTH_MM / 2,
    rearMm: FALLBACK_LENGTH_MM / 2,
    widthMm: FALLBACK_WIDTH_MM,
    gapMm: DEFAULTS.SafetyGap,
    dockSpeed: DEFAULTS.DockingSpeed,
    dockDist: DEFAULTS.DockingDistance,
    scanner: DEFAULTS.ScannerFields,
    reactionSec: DEFAULTS.ScannerReactionTime,
    protectiveMm: DEFAULTS.ProtectiveMargin,
    warningMm: DEFAULTS.WarningMargin,
    mbKind: null,
    mbHost: null,
    cTime: Number.NaN,
    lastCanMove: false,
    stepFrame: -1,
    frozen: false,
    frozenServiceSec: -1,
    inHook: false,
    _pos: new Vector3(),
    _quat: new Quaternion(),
    _parentQuat: new Quaternion(),
    _relevantZones: [],
    _heldScratch: [],
    allowReverse: DEFAULTS.AllowReverse,
    reverseSpeed: DEFAULTS.ReverseSpeed,
    maneuver: null,
    maneuverEpoch: 0,
    serviceEpoch: 0,
    kernelKind: 'continuous',
    active: true,
    hiddenByActive: false,
  }),

  // plan-648: the instances own their vehicle id (fleet, spacing, zones, planner).
  // `defineLibraryComponent` mutes a continuous instance while DES is the active
  // traffic kernel; the DES runner releases its instances on suspend / dispose.
  trafficOwned: true as const,
  trafficMuted: (self: AgvSelf): boolean => !kernelLive(self.local),
  trafficRelease: (self: AgvSelf): void => { release(self, false); },

  logic: { applyPose },

  // Mode-agnostic init: resolve the path, build the traveler, wire hooks.
  setup(self: AgvSelf): void {
    const l = self.local;
    l.kernelKind = self.mode === 'des' ? 'des' : 'continuous';
    // A re-setup (DES runner restart) must not leave the previous traveler's
    // traces behind — claims, headway entry, planner registration. Only the
    // owner holds any (plan-648); it keeps the id and refreshes the handle below.
    if (l.traveler && ownsTraffic(self)) releaseVehicle(self, false);
    // plan-648 F3 / G7: a re-setup is a fresh start — no task, stay, manoeuvre
    // or freeze of the previous run survives (the queue that held their events
    // is gone). The values of a first setup, so a first start is unchanged.
    l.task = null;
    l.phase = 'cruising';
    l.serviceRemainingSec = 0;
    l.desServiceEvent = -1;
    l.serviceMode = 'timer';
    l.dockReleaseFlag = false;
    l.servedPathId = null;
    l.desArrivedPathId = null;
    l.frozen = false;
    l.frozenServiceSec = -1;
    const bag = configBag(self);
    // Stay clickable while an authoring mode (planner / DES) filters picks to
    // layout objects — selecting a vehicle shows its inspector and statistics.
    self.root.userData._rvSimSelectable = true;
    l.targetSpeed = cfgNumber(bag, 'TargetSpeed', DEFAULTS.TargetSpeed);
    l.acceleration = cfgNumber(bag, 'Acceleration', DEFAULTS.Acceleration);
    l.useAcceleration = cfgBool(bag, 'UseAcceleration', DEFAULTS.UseAcceleration);
    const pathId = typeof bag['PathId'] === 'string' ? (bag['PathId'] as string) : DEFAULTS.PathId;
    l.safetyDistanceMm = Math.max(0, cfgNumber(bag, 'SafetyDistance', DEFAULTS.SafetyDistance));
    l.minGapMm = Math.max(0, cfgNumber(bag, 'MinGap', DEFAULTS.MinGap));
    l.lookAheadMm = Math.max(0, cfgNumber(bag, 'LookAhead', DEFAULTS.LookAhead));
    l.headwayGain = Math.max(0, cfgNumber(bag, 'HeadwayGain', DEFAULTS.HeadwayGain));
    const startPosMm = cfgNumber(bag, 'StartPosition', DEFAULTS.StartPosition);
    l.decel = Math.max(1, cfgNumber(bag, 'Deceleration', DEFAULTS.Deceleration));
    l.aLat = Math.max(1, cfgNumber(bag, 'LateralAcceleration', DEFAULTS.LateralAcceleration));
    l.gapMm = Math.max(0, cfgNumber(bag, 'SafetyGap', DEFAULTS.SafetyGap));
    l.dockSpeed = Math.max(1, cfgNumber(bag, 'DockingSpeed', DEFAULTS.DockingSpeed));
    l.dockDist = Math.max(0, cfgNumber(bag, 'DockingDistance', DEFAULTS.DockingDistance));
    l.scanner = cfgBool(bag, 'ScannerFields', DEFAULTS.ScannerFields);
    l.reactionSec = Math.max(0, cfgNumber(bag, 'ScannerReactionTime', DEFAULTS.ScannerReactionTime));
    l.protectiveMm = Math.max(0, cfgNumber(bag, 'ProtectiveMargin', DEFAULTS.ProtectiveMargin));
    l.warningMm = Math.max(0, cfgNumber(bag, 'WarningMargin', DEFAULTS.WarningMargin));
    l.allowReverse = cfgBool(bag, 'AllowReverse', DEFAULTS.AllowReverse);
    l.reverseSpeed = Math.max(0, cfgNumber(bag, 'ReverseSpeed', DEFAULTS.ReverseSpeed));
    // Body: explicit length → centred on the root; 0 → mesh bounds (the root
    // may sit anywhere on the body, e.g. at the rear axle); no mesh → fallback.
    const lengthMm = Math.max(0, cfgNumber(bag, 'VehicleLength', DEFAULTS.VehicleLength));
    const widthMm = Math.max(0, cfgNumber(bag, 'VehicleWidth', DEFAULTS.VehicleWidth));
    const mesh = lengthMm > 0 && widthMm > 0 ? null : meshBodyMm(self.root);
    if (lengthMm > 0) { l.frontMm = lengthMm / 2; l.rearMm = lengthMm / 2; }
    else if (mesh && mesh.front + mesh.rear > 0) { l.frontMm = mesh.front; l.rearMm = mesh.rear; }
    else { l.frontMm = FALLBACK_LENGTH_MM / 2; l.rearMm = FALLBACK_LENGTH_MM / 2; }
    l.widthMm = widthMm > 0 ? widthMm : (mesh && mesh.width > 0 ? mesh.width : FALLBACK_WIDTH_MM);
    fleetBodies.set(travelerIdOf(self), { front: l.frontMm / 1000, rear: l.rearMm / 1000, width: l.widthMm / 1000 });

    // Path resolution: PathId → shared network; else the first rv_extras.Path
    // node under the root (payload-detected via NODE_KIND_TESTS.path).
    const net = getDefaultPathNetwork();
    let path: RVPath | null = pathId ? net.get(pathId) : null;
    if (!path) {
      const node = self.find('path');
      if (node) {
        path = pathFromNode(node);
        if (path && !net.get(path.id)) net.register(path);
      }
    }
    if (!path) return self.disable('no rv_extras.Path found (PathId or a Path node under the root)');

    const traveler = new PathTraveler(travelerIdOf(self), path, net);
    traveler.hooks.onArrive = (nodeId) => { l.atNodeId = nodeId; };
    // Plan-921 junction resolution — layered: central control first (the
    // registered network router), then the mechanical shortest-distance hop
    // toward the task destination, then the successors[0] default. Installed
    // as the per-traveler hook, so the planner's route walk (peekNext)
    // predicts the SAME route the hand-over takes.
    traveler.hooks.selectNextPath = (candidates, ctx) => {
      const routerPick = net.routerSelect(candidates, ctx);
      if (typeof routerPick === 'string' && candidates.includes(routerPick)) return routerPick;
      // During the approach of a stub manoeuvre the hop target is the turn piece (plan-595).
      const m = l.maneuver;
      const dest = m && m.stage === 'approach' ? m.turn.id : l.task?.destination;
      if (dest) {
        const current = net.get(ctx.currentPathId);
        const hop = current ? net.nextHopToward(current, dest) : null;
        if (hop && candidates.includes(hop.id)) return hop.id;
      }
      return undefined; // → candidates[0]
    };
    l.traveler = traveler;

    // Declarative one-shot task from the config (no callbacks — MCP/inspector
    // authoring): Destination = any path id, ServiceTime seconds, then idle.
    // Set BEFORE the fleet registration (plan-559 F13): a task an onRegister
    // subscriber assigns from inside register() wins over the config task.
    const cfgDest = typeof bag['Destination'] === 'string' ? (bag['Destination'] as string) : '';
    if (cfgDest) {
      l.startTask = { destination: cfgDest, serviceSec: cfgNumber(bag, 'ServiceTime', 0) };
      l.task = { ...l.startTask };
      l.phase = 'driving';
    }

    // Fleet handle (plan-648): only the instance of the active traffic kernel
    // takes the id — the owner check comes BEFORE the handle, so a synchronous
    // fleet subscriber already sees the right owner. A muted instance (its
    // kernel is not active) stays local: no handle, no claim, no pose, no signal.
    applyActive(self); // acquire() refuses an out-of-service vehicle
    const owned = acquire(self, true);

    l.startPath = path;
    l.startPosM = Math.min(Math.max(0, startPosMm / 1000), path.length);
    traveler.s = l.startPosM;
    l.atNodeId = null;
    // plan-595: a (re-)setup re-seeds the vehicle forward at its start — every manoeuvre of the old
    // run ends (stale retry events / dock releases die with the epochs); a reverse task it keeps
    // starts its manoeuvre afresh.
    l.maneuverEpoch++;
    l.serviceEpoch++;
    l.maneuver = null;
    if (l.task?.approach === 'reverse') {
      const m = resolveStubManeuver(l, traveler.id, l.task);
      if (m === 'rejected') { l.task = null; l.phase = 'cruising'; } else l.maneuver = m;
    }

    // Join the shared headway index (legacy model + reprojection on live edits)
    // and claim the starting zone (a fresh vehicle holds nothing yet) — owner only (plan-648 G3).
    if (owned) attachTraffic(self);
    reportUnzonedMerges();

    // The vehicle runs unless told to stop (a live CONNECT source owns Run when bound).
    // Run and the pose of the SHARED node belong to the owner (plan-648 G3).
    if (owned && !self.isWired) self.sig.Run.set(true);
    self.stamp('AgvBehavior', { Path: path.id });
    if (owned) applyPose(self);

    self.contextMenu(self.root, [
      { id: 'run',  label: 'Run',  action: () => self.sig.Run.set(true) },
      { id: 'stop', label: 'Stop', danger: true, dividerBefore: true,
        action: () => self.sig.Run.set(false) },
    ]);
  },

  /**
   * Simulation reset (plan-648 G1): the full restart path — release claims and
   * planner entry → state and start pose → (re-)acquire → start kick. Muted
   * centrally while DES is the active traffic kernel (F6).
   */
  reset(self: AgvSelf): void {
    restartVehicle(self, false);
  },
  start(self: AgvSelf): void {
    if (!self.isWired) self.sig.Run.set(true);
  },

  continuous: {
    /** Join the continuous planner (UseAcceleration = true) — every vehicle registers before the first tick. */
    setup(self: AgvSelf): void {
      const l = self.local;
      const t = l.traveler;
      if (self.disabled || !t || !t.path) return;
      // plan-648 G2: every live binding is known to the continuous runner — BEFORE the
      // UseAcceleration early-return — so a binding made while DES runs is activated later.
      continuousInstances.add(self);
      if (!ownsTraffic(self) || !l.useAcceleration) return; // muted: the runner activates it
      fleetForget(self, t.id, true);           // a re-setup has not run in the current step
      const mb = registerPlanned(self, 'continuous');
      // plan-632: join the shared fleet step at the current clock time, known to the
      // fleet before its first step (see "Continuous fleet step").
      l.cTime = mb.clock.now;
      l.stepFrame = -1;
      fleetStepOf(mb).members.set(t.id, self);
      mb.markDirty(t.id, 'start');
      mb.requestFlushDeferred(l.mbHost!);
    },

    fixedUpdate(self: AgvSelf, dt: number): void {
      const l = self.local;
      const t = l.traveler;
      if (!t || !t.path) return;
      if (self.isWired) return;          // an interface controls the vehicle → stay silent
      if (!l.active) return;             // out of service: not even an obstacle
      // plan-632: one shared step for the whole fleet — the first vehicle of the
      // step runs the inputs of all, ONE clock advance and the sync / pose /
      // signals of all at the same time (legacy step-model vehicles included as
      // obstacles). See "Continuous fleet step".
      fleetFixedUpdate(self, dt);
    },

    teardown(self: AgvSelf): void {
      // Dispose/despawn must leave NO traces in the shared traffic state:
      // a surviving claim or plan would block / ghost the traffic permanently.
      // plan-648: release is owner-checked — the teardown of an instance that does
      // not own the id (the suspended twin) leaves the owner's entries alone.
      continuousInstances.delete(self);
      const t = self.local.traveler;
      if (!t) return;
      fleetForget(self, t.id, false);          // plan-632: leave the continuous fleet step
      release(self, true);                     // fleet step, spacing, zones, planner, handle (plan-921 — no stale handles)
      if (!trafficOwner.has(travelerIdOf(self))) fleetBodies.delete(t.id);
      // plan-618 F2a: the last vehicle is gone — no orphaned merge-entry finding without vehicles.
      if (getDefaultAgvFleet().handleList.length === 0) {
        mergeCheckStats.last = freshLast();
        clearProblemsOfCode(SHORT_ENTRY_CODE);
        clearProblemsOfCode(CHECK_SKIPPED_CODE);
      }
    },
  },

  // ── DES adapter — dispatched ONLY by the private runner; this definition
  // never imports it (public/private boundary). `samplesLiveGeometry` is
  // deliberately NOT declared — the hooks read the parsed path geometry and the
  // plan, never live world transforms, so FastForward keeps its fast path.
  des: {
    movedNodes: (self: AgvSelf) => [self.root],
    /**
     * Start kick: register with the DES authority (a parked vehicle too — it
     * is an obstacle) and defer the first flush to an event at this instant
     * so every vehicle is registered before anyone plans.
     */
    onGenerate(self: AgvSelf): void {
      const l = self.local;
      const t = l.traveler;
      if (self.disabled || !t || !t.path) return;
      // plan-648 G7: the instance acquired its id at setup (the one activation
      // point); a muted DES instance kicks nothing.
      if (!ownsTraffic(self)) return;
      const mb = registerPlanned(self, 'des');
      mb.recordEvent('Generate', t.id, self.now);
      mb.markDirty(t.id, 'start');
      mb.requestFlushDeferred(l.mbHost!);
    },

    /** Plan end at a service stop / dead end. */
    onArrival(self: AgvSelf): void {
      handleArrival(self);
    },

    /** End of the dwell — the follow-up task (if any) re-plans via assign(). */
    onServiceEnd(self: AgvSelf): void {
      self.local.desServiceEvent = -1;
      handleServiceEnd(self);
    },

    /** Planner events: stop / flush / extend / zoneRelease / notify / field / stat / watchdog. */
    onReplan(self: AgvSelf, data: unknown): void {
      const d = (data ?? {}) as Record<string, unknown>;
      if (d.kind === MANEUVER_RETRY) { retryManeuver(self, Number(d.epoch)); return; }
      const kind = (typeof d.kind === 'string' ? d.kind : '') as MbEventKind;
      if (kind === 'stop') handleStop(self);
      else handlePlanEvent(self, kind, d);
    },

    /**
     * Component failure (DES downtime): the adapter cancelled every queued
     * event. The planner's own events are dropped (it re-plans: the vehicle
     * brakes to a stop with its deceleration, followers re-plan against that);
     * a running service stay keeps its remaining time for the resume.
     */
    onFreeze(self: AgvSelf, frozen: { action: string; remaining: number }[]): void {
      const l = self.local;
      const t = l.traveler;
      if (!t) return;
      l.frozen = true;
      l.frozenServiceSec = -1;
      for (let i = frozen.length - 1; i >= 0; i--) {
        const a = frozen[i].action;
        if (a.endsWith('.ServiceEnd')) { l.frozenServiceSec = frozen[i].remaining; frozen.splice(i, 1); }
        else if (a.endsWith('.Arrival') || a.endsWith('.Replan')) frozen.splice(i, 1);
      }
      l.desServiceEvent = -1;
      authorityOf(l)?.freeze(t.id);
    },

    /** Repaired: the stay continues with its remaining time; the vehicle re-plans. */
    onResume(self: AgvSelf): void {
      const l = self.local;
      const t = l.traveler;
      if (!t) return;
      l.frozen = false;
      if (l.frozenServiceSec >= 0 && l.phase === 'servicing') {
        l.desServiceEvent = scheduleServiceEnd(self, Math.max(l.frozenServiceSec, DES_MIN_TRANSIT_SEC));
      }
      l.frozenServiceSec = -1;
      authorityOf(l)?.resume(t.id);
    },
  },
};

// Statistics: book the category after every state-changing entry point instead
// of before each of their many early returns (see bookStat).
const withStat = <A extends unknown[]>(fn: (self: AgvSelf, ...args: A) => void) =>
  (self: AgvSelf, ...args: A): void => { fn(self, ...args); bookStat(self); };
def.des.onGenerate = withStat(def.des.onGenerate);
def.des.onArrival = withStat(def.des.onArrival);
def.des.onServiceEnd = withStat(def.des.onServiceEnd);
def.des.onReplan = withStat(def.des.onReplan);
def.des.onFreeze = withStat(def.des.onFreeze);
def.des.onResume = withStat(def.des.onResume);

/** Agv — path-following vehicle (factory-built; behaviour identical to the def). */
const AgvBehavior = defineLibraryComponent(def);

/** The material-flow definition (schema + logic + continuous + des) — for DES tests / runner. */
export const AgvFlow = def;

export default AgvBehavior;

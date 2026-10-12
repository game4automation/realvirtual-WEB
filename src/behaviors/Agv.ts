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
 * `Agv.FieldWarning`, `Agv.FieldProtective`. When the component is PLC-wired
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
import { getDefaultZoneRegistry } from '../core/engine/rv-zone-registry';
import {
  getDefaultAgvFleet, AGV_NO_BODY_KEY, type AgvTask, type AgvPhase, type AgvMotionInfo,
} from '../core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../core/engine/rv-path-dock';
import {
  getDefaultMovementAuthority, findUnzonedMerges, isTrafficStop,
  type MbHost, type MbEventKind, type MbParams, type MovementAuthority,
} from '../core/engine/rv-movement-authority';
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

type MbKind = 'des' | 'continuous';

interface AgvLocal {
  traveler: PathTraveler | null;
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
  /** Continuous: the vehicle's clock time (s) — joins the authority clock on the first tick. */
  cTime: number;
  /** Continuous: last observed canMove (Run edge → re-plan). */
  lastCanMove: boolean;
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
}

type AgvSelf = RV.Self<AgvLocal, typeof SIGNALS>;

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
function applyPose(self: AgvSelf): void {
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

/** Claim (best effort) the zone of the path the traveler currently stands on
 *  — used at setup and reset. Physical occupancy wins over a failed claim. */
function claimCurrentZone(t: PathTraveler): void {
  const p = t.path;
  if (!p || !p.zoneId) return;
  const zones = getDefaultZoneRegistry();
  zones.define(p.zoneId, p.zoneCapacity ?? undefined);
  if (!zones.claim(p.zoneId, t.id)) {
    console.warn(
      `[Agv] '${t.id}' starts inside zone '${p.zoneId}' but the capacity is ` +
        'exhausted — proceeding without a claim (check StartPositions).',
    );
  }
}

/** Problems-panel code for merges without a shared zone. */
const UNZONED_MERGE_CODE = 'agv-merge-without-zone';

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
        zones.define(z, next.zoneCapacity ?? undefined);
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
    return clock.schedule(clock.now + delay, 0, () => {
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
    const release = (): void => {
      if (released) return;
      released = true;
      if (l.mbHost !== null) {
        if (l.phase === 'servicing' && l.desServiceEvent < 0) {
          l.desServiceEvent = scheduleServiceEnd(self, DES_MIN_TRANSIT_SEC);
        }
      } else {
        l.dockReleaseFlag = true; // legacy fixedUpdate ends the stay next tick
      }
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
  if (l.servedPathId === p.id) return false; // already served — drive off
  if (atTaskDestination(l)) return true;
  return getDefaultPathDockRegistry().dockAt(p.id) !== null;
}

// ── Statistics ──────────────────────────────────────────────────────────────

/**
 * Book the vehicle's statistics category (DES + continuous StateStatistics).
 * Priority (plan-558 Phase 6): Run off → Empty; Failure (DES freeze);
 * servicing → Working; standing at a traffic stop → Stopped; driving below
 * the free profile because of traffic / the warning field → Slowed; driving
 * with a task → Transport; without → Empty. AGVs never book `Blocked`.
 * `statState` de-dupes, so calling it after every event / tick is cheap.
 */
function bookStat(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler;
  if (!t || self.sig.Run.get() !== true) { self.statState('Empty'); return; }
  if (l.frozen) { self.statState('Failure'); return; }
  if (l.phase === 'servicing') { self.statState('Working'); return; }
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
    serviceStopAt: (path, current) => {
      if (current) return serviceStopAhead(l);
      return l.task?.destination === path.id || getDefaultPathDockRegistry().dockAt(path.id) !== null;
    },
    canMove: () => !self.disabled && self.sig.Run.get() === true
      && (l.phase === 'driving' || l.phase === 'cruising'),
    onPlanApplied: (moving, stopped) => {
      t.blocked = stopped;
      self.sig.Moving.set(moving);
      self.sig.Blocked.set(stopped);
      self.sig.Speed.set(mb.speedOf(t.id, des ? self.now : mb.clock.now) * 1000);
    },
    onArrivedAt: (prev) => {
      // The per-piece arrival of the step model — announced once per visit.
      if (prev.closed || l.desArrivedPathId === prev.id) return;
      l.desArrivedPathId = prev.id;
      t.hooks.onArrive?.(prev.id, t.id);
      t.network?.notifyArrive(prev.id, t.id);
    },
    onHandOver: (_prev, next) => {
      l.desArrivedPathId = null;
      l.servedPathId = null;
      t.path = next;
      t.s = 0;
      t.atEnd = false;
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
  t.s = p.length;
  t.v = 0;
  self.sig.Position.set(t.s * 1000);
  self.sig.Speed.set(0);

  if (!p.closed && l.desArrivedPathId !== p.id) {
    l.desArrivedPathId = p.id;
    t.hooks.onArrive?.(p.id, t.id);
    t.network?.notifyArrive(p.id, t.id);
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

  const next = t.peekNext(p, 1);
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
  notify: 'Replan:notify', field: 'Replan:field', stat: 'Replan:stat',
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
    'the legacy car-following step mode (SafetyDistance/MinGap/LookAhead/HeadwayGain).',
  models: ['*Agv*', '*AGV*'],
  schema: {
    TargetSpeed:         { type: 'number' as const, default: DEFAULTS.TargetSpeed },
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
    frozen: false,
    frozenServiceSec: -1,
    inHook: false,
    _pos: new Vector3(),
    _quat: new Quaternion(),
    _parentQuat: new Quaternion(),
    _relevantZones: [],
    _heldScratch: [],
  }),

  logic: { applyPose },

  // Mode-agnostic init: resolve the path, build the traveler, wire hooks.
  setup(self: AgvSelf): void {
    const l = self.local;
    // A re-setup (DES runner restart) must not leave the previous traveler's
    // traces behind — claims, headway entry, planner registration.
    if (l.traveler) releaseVehicle(self, false);
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
    // Body: explicit length → centred on the root; 0 → mesh bounds (the root
    // may sit anywhere on the body, e.g. at the rear axle); no mesh → fallback.
    const lengthMm = Math.max(0, cfgNumber(bag, 'VehicleLength', DEFAULTS.VehicleLength));
    const widthMm = Math.max(0, cfgNumber(bag, 'VehicleWidth', DEFAULTS.VehicleWidth));
    const mesh = lengthMm > 0 && widthMm > 0 ? null : meshBodyMm(self.root);
    if (lengthMm > 0) { l.frontMm = lengthMm / 2; l.rearMm = lengthMm / 2; }
    else if (mesh && mesh.front + mesh.rear > 0) { l.frontMm = mesh.front; l.rearMm = mesh.rear; }
    else { l.frontMm = FALLBACK_LENGTH_MM / 2; l.rearMm = FALLBACK_LENGTH_MM / 2; }
    l.widthMm = widthMm > 0 ? widthMm : (mesh && mesh.width > 0 ? mesh.width : FALLBACK_WIDTH_MM);

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

    const traveler = new PathTraveler(self.root.name || 'Agv', path, net);
    traveler.hooks.onArrive = (nodeId) => { l.atNodeId = nodeId; };
    // Plan-921 junction resolution — layered: central control first (the
    // registered network router), then the mechanical shortest-distance hop
    // toward the task destination, then the successors[0] default. Installed
    // as the per-traveler hook, so the planner's route walk (peekNext)
    // predicts the SAME route the hand-over takes.
    traveler.hooks.selectNextPath = (candidates, ctx) => {
      const routerPick = net.routerSelect(candidates, ctx);
      if (typeof routerPick === 'string' && candidates.includes(routerPick)) return routerPick;
      const dest = l.task?.destination;
      if (dest) {
        const current = net.get(ctx.currentPathId);
        const hop = current ? net.nextHopToward(current, dest) : null;
        if (hop && candidates.includes(hop.id)) return hop.id;
      }
      return undefined; // → candidates[0]
    };
    l.traveler = traveler;

    // Fleet handle — the low-level control surface for project fleet logic.
    const fleet = getDefaultAgvFleet();
    fleet.register({
      id: traveler.id,
      assign: (task: AgvTask) => {
        l.task = task;
        l.phase = 'driving';
        // A new task to the segment the vehicle stands on is a new visit.
        if (task.destination === traveler.path?.id) l.servedPathId = null;
        l.serviceRemainingSec = 0;
        cancelServiceEnd(self);
        traveler.atEnd = false;
        const mb = authorityOf(l);
        if (mb && mb.has(traveler.id)) {
          mb.invalidateRoute(traveler.id); // a new destination re-decides the junctions ahead
          replanNow(self, 'assign');
        }
        bookStat(self);
      },
      clear: () => {
        l.task = null;
        l.phase = 'cruising';
        l.serviceRemainingSec = 0;
        cancelServiceEnd(self);
        traveler.atEnd = false;
        const mb = authorityOf(l);
        if (mb && mb.has(traveler.id)) {
          mb.invalidateRoute(traveler.id);
          replanNow(self, 'assign');
        }
        bookStat(self);
      },
      get task() { return l.task; },
      get phase() { return l.phase; },
      node: self.root,
      motion: (out: AgvMotionInfo): boolean => {
        const mb = l.mbHost ? authorityOf(l) : null;
        if (!mb || !mb.has(traveler.id)) return false;
        const speed = mb.renderSpeedOf(traveler.id);
        out.speed = speed;
        out.field = mb.fieldStateOf(traveler.id);
        out.protectiveLength = mb.protectiveFieldLength(traveler.id, speed);
        out.warningLength = out.protectiveLength + l.warningMm / 1000;
        out.front = l.frontMm / 1000;
        out.width = l.widthMm / 1000;
        out.scanner = l.scanner;
        return true;
      },
    });

    // Declarative one-shot task from the config (no callbacks — MCP/inspector
    // authoring): Destination = any path id, ServiceTime seconds, then idle.
    const cfgDest = typeof bag['Destination'] === 'string' ? (bag['Destination'] as string) : '';
    if (cfgDest) {
      l.startTask = { destination: cfgDest, serviceSec: cfgNumber(bag, 'ServiceTime', 0) };
      l.task = { ...l.startTask };
      l.phase = 'driving';
    }
    l.startPath = path;
    l.startPosM = Math.min(Math.max(0, startPosMm / 1000), path.length);
    traveler.s = l.startPosM;
    l.atNodeId = null;

    // Join the shared headway index (legacy model + reprojection on live edits)
    // and claim the starting zone (a fresh vehicle holds nothing yet).
    getDefaultSpacingController().add(traveler, { lookAhead: l.lookAheadMm / 1000 });
    getDefaultZoneRegistry().releaseAll(traveler.id);
    claimCurrentZone(traveler);
    reportUnzonedMerges();

    // The vehicle runs unless told to stop (a live CONNECT source owns Run when bound).
    if (!self.isWired) self.sig.Run.set(true);
    self.stamp('AgvBehavior', { Path: path.id });
    applyPose(self);

    self.contextMenu(self.root, [
      { id: 'run',  label: 'Run',  action: () => self.sig.Run.set(true) },
      { id: 'stop', label: 'Stop', danger: true, dividerBefore: true,
        action: () => self.sig.Run.set(false) },
    ]);
  },

  reset(self: AgvSelf): void {
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
    l.desArrivedPathId = null;
    l.frozen = false;
    l.frozenServiceSec = -1;
    const kind = l.mbKind;
    if (t) {
      // Release EVERY held zone and the planner entry FIRST (a reset that keeps
      // a claim or a plan deadlocks / ghosts the traffic), then re-seed the
      // traveler deterministically on its start path.
      getDefaultZoneRegistry().releaseAll(t.id);
      const mb = authorityOf(l);
      if (mb) mb.unregister(t.id);
      l.mbKind = null;
      l.mbHost = null;
      if (l.startPath) t.path = l.startPath;
      t.s = l.startPosM;
      t.v = 0;
      t.atEnd = false;
      t.blocked = false;
      claimCurrentZone(t);
      applyPose(self);
      // Continuous: re-join the planner from the start pose (DES re-registers at onGenerate).
      if (kind === 'continuous' && l.useAcceleration) {
        const mb2 = registerPlanned(self, 'continuous');
        l.cTime = Number.NaN;
        mb2.markDirty(t.id, 'start');
        mb2.requestFlushDeferred(l.mbHost!);
      }
    }
    self.sig.Moving.set(false);
    self.sig.Position.set(l.startPosM * 1000);
    self.sig.AtNode.set(false);
    self.sig.Blocked.set(false);
    self.sig.Speed.set(0);
    self.sig.Slowed.set(false);
    self.sig.FieldWarning.set(false);
    self.sig.FieldProtective.set(false);
  },
  start(self: AgvSelf): void {
    if (!self.isWired) self.sig.Run.set(true);
  },

  continuous: {
    /** Join the continuous planner (UseAcceleration = true) — every vehicle registers before the first tick. */
    setup(self: AgvSelf): void {
      const l = self.local;
      const t = l.traveler;
      if (self.disabled || !t || !t.path || !l.useAcceleration) return;
      const mb = registerPlanned(self, 'continuous');
      l.cTime = Number.NaN;
      mb.markDirty(t.id, 'start');
      mb.requestFlushDeferred(l.mbHost!);
    },

    fixedUpdate(self: AgvSelf, dt: number): void {
      const l = self.local;
      const t = l.traveler;
      if (!t || !t.path) return;
      if (self.isWired) return;          // an interface controls the vehicle → stay silent
      if (!l.useAcceleration || l.mbKind !== 'continuous' || !l.mbHost) {
        legacyFixedUpdate(self, dt);
        // A legacy vehicle is an obstacle for the planned ones (mixed fleets).
        const mb = getDefaultMovementAuthority('continuous');
        if (!mb.has(t.id)) {
          l.mbKind = 'continuous';
          mb.registerExternal(t.id, t, plannerParams(l), () => mb.clock.now);
        } else {
          mb.updateExternal(t.id);
        }
        bookStat(self);
        return;
      }
      const mb = getDefaultMovementAuthority('continuous');
      const host = l.mbHost;
      if (!mb.has(t.id)) return;
      if (Number.isNaN(l.cTime)) l.cTime = mb.clock.now;
      // Run / phase edge → re-plan at the current clock time (the DES kernel
      // observes Run at its events only — the continuous tick sees it at once).
      const can = host.canMove();
      if (can !== l.lastCanMove) {
        l.lastCanMove = can;
        mb.markDirty(t.id, 'run');
        mb.requestFlush(host);
      }
      // Advance the shared clock: every plan event due inside this tick runs
      // at its exact time (the first vehicle of the tick advances everybody).
      l.cTime += dt;
      mb.clock.advanceTo(l.cTime);
      mb.syncTo(t.id, l.cTime);
      applyPose(self);
      const speed = mb.speedOf(t.id, l.cTime);
      t.v = speed * 1000;
      self.sig.Moving.set(speed > 1e-6);
      self.sig.Position.set(t.s * 1000);       // mm — drive parity
      self.sig.Speed.set(speed * 1000);
      self.sig.AtNode.set(l.atNodeId !== null); // one-tick pulse
      l.atNodeId = null;
      bookStat(self);
    },

    teardown(self: AgvSelf): void {
      // Dispose/despawn must leave NO traces in the shared traffic state:
      // a surviving claim or plan would block / ghost the traffic permanently.
      const t = self.local.traveler;
      if (!t) return;
      releaseVehicle(self, true);
      getDefaultAgvFleet().unregister(t.id); // plan-921 — no stale handles
    },
  },

  // ── DES adapter — dispatched ONLY by the private runner; this definition
  // never imports it (public/private boundary). `samplesLiveGeometry` is
  // deliberately NOT declared — the hooks read the parsed path geometry and the
  // plan, never live world transforms, so FastForward keeps its fast path.
  des: {
    /**
     * Start kick: register with the DES authority (a parked vehicle too — it
     * is an obstacle) and defer the first flush to an event at this instant
     * so every vehicle is registered before anyone plans.
     */
    onGenerate(self: AgvSelf): void {
      const l = self.local;
      const t = l.traveler;
      if (self.disabled || !t || !t.path) return;
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

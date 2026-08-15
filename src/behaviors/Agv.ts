// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Agv — an autonomous path-following carrier (FTS/AGV, plan-268 Phase 1+2).
 *
 * The vehicle rides an `RVPath` graph (rv_extras.Path, plan-268 §2.3): its
 * ONE movement scalar lives in a `PathTraveler` (`s += v/1000 · dt`, while-
 * carry hand-off at path ends), the speed ramp is the DRIVE's ramp
 * (`computeRampedSpeed`, rv-drive.ts — not re-invented), and the pose comes
 * from `lookRotation(tangent, align)` (rv-pose-align.ts).
 *
 * Phase 2 — traffic WITHOUT raycasts (plan-268 §2.4):
 *   - Headway: the gap to the vehicle ahead is the 1D ARC-LENGTH difference
 *     along the graph (SpacingController — sorted by `s`, across path ends up
 *     to `LookAhead`, wrap on closed paths). The car-following ramp
 *     `v_target = clamp((gap − SafetyDistance)·HeadwayGain, 0, TargetSpeed)`
 *     brakes smoothly to standstill at `SafetyDistance` and restarts smoothly.
 *     A HARD clamp additionally guarantees the gap never drops below `MinGap`
 *     (1D arc-length analogue of the transport-surface accumulation clamp) —
 *     no colliders, no physics, no penetration.
 *   - Zones (control-point model, ZoneRegistry): a path tagged `zone` must be
 *     CLAIMED before entry. The per-tick look-ahead walk claims upcoming zones
 *     within `LookAhead`; on a failed claim the vehicle holds AT the zone
 *     entrance (same stop mechanics as the headway). Claims are released
 *     strictly AFTER the position transfer (one tick later — never before),
 *     and `releaseAll` runs in the reset/teardown hooks so no reset/dispose/
 *     despawn can ever leave a zone permanently held (review finding 2).
 *
 * MECHANICS ONLY (plan-268 §2.4): routing/dispatch are project logic — the
 * traveler exposes id-based hooks (`selectNextPath(candidateIds) → id`,
 * `onArrive(nodeId, agvId)`); without a hook the vehicle plainly follows
 * `successors[0]`.
 *
 * Phase 3 — DES coupling (`des` block, dispatched ONLY by the private runner;
 * this file never imports it):
 *   - One event per path leg: `onGenerate` (runner start kick) schedules the
 *     first Arrival after `transit = remainingLength / TargetSpeed`; every
 *     `onArrival` routes at the segment boundary (IDENTICAL callback
 *     signature as the continuous carry — `onArrive(pathId, agvId)` +
 *     `peekNext`, the same selectNextPath dispatch) and schedules the next leg.
 *     Full-path travel times are cached per path id (`length / v`).
 *   - Visibility via the `path` tween (`self.pathTween`): the vehicle root is
 *     sampled along the arc between events; FastForward writes NO transforms —
 *     the final tween write leaves the root exactly at the arc-length end.
 *   - Blocking is an ARRIVAL RESCHEDULE (plan-268 §2.4): an occupied zone at
 *     the next path holds the vehicle AT the boundary and re-checks the claim
 *     after `DES_BLOCKED_RETRY_SEC` — a discrete poll, no sub-tick, no ramp.
 *     PARITY IS CONFLICT-FREE ONLY (§2.4 final decision / §10 finding 3):
 *     under contention the continuous car-following ramp and the DES
 *     reschedule deliberately diverge in their momentary trajectory; only
 *     arrival ORDER and end state / throughput converge.
 *   - `samplesLiveGeometry` is deliberately NOT set: path geometry is parsed
 *     once (rv-path cache) and the hooks never sample live world transforms,
 *     so FastForward keeps its zero-settle fast path.
 *   - Phase-3 scope note: the DES leg plan reads `Run` at the start kick and
 *     at boundaries; mid-leg Run toggling / live re-speeding is continuous-only.
 *     `AtNode` (a one-TICK pulse — tick semantics) is not published in DES;
 *     arrivals surface through the traveler's `onArrive` hook instead.
 *
 * Path resolution (setup): the `PathId` schema field selects a path from the
 * shared `RVPathNetwork`; otherwise the first `rv_extras.Path` node under the
 * component root is used (payload-detected, never name-detected).
 *
 * Signals (F9): `Agv.Run` (command), `Agv.Moving`, `Agv.Position` (mm, drive
 * parity), `Agv.AtNode` (one-tick pulse at a path-end node), `Agv.Blocked`
 * (v == 0 because of the vehicle ahead or an occupied zone). When the
 * component is PLC-wired (`self.isWired`) the internal simulation stays
 * silent — the live values are authoritative.
 */

import { Quaternion, Vector3 } from 'three';
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
import { getDefaultAgvFleet, type AgvTask, type AgvPhase, type AgvHandle } from '../core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../core/engine/rv-path-dock';

// PLC contract — auto-declared as `Agv.<key>` with typed `self.sig.<key>`
// accessors. Run follows the Conveyor convention (command in, status out).
const SIGNALS = {
  Run:      'PLCInputBool',
  Moving:   'PLCOutputBool',
  Position: 'PLCOutputFloat', // arc position on the current path, in mm
  AtNode:   'PLCOutputBool',  // one-tick pulse at a path-end node
  Blocked:  'PLCOutputBool',  // held at v=0 by the vehicle ahead / an occupied zone (F9)
} as const;

// Schema defaults (stamped as AgvBehavior inspector rows by the factory).
const DEFAULTS = {
  TargetSpeed: 1000,     // mm/s (drive parity)
  Acceleration: 500,     // mm/s²
  UseAcceleration: true,
  PathId: '',
  StartPosition: 0,      // mm — initial arc position on the resolved path
  SafetyDistance: 1000,  // mm — car-following standstill separation (Phase 2)
  MinGap: 200,           // mm — HARD no-penetration floor (< SafetyDistance)
  LookAhead: 5000,       // mm — leader search / zone claim window across path ends
  HeadwayGain: 2,        // 1/s — car-following proportional gain
} as const;

/** Bound on the zone claim walk (pathological graphs / zero-length chains). */
const MAX_ZONE_WALK = 8;

/** Float back-off (mm) so a hard-clamped advance never float-crosses a boundary. */
const HARD_CLAMP_BACKOFF_MM = 1e-6;

/** Clamped advances at/below this (mm, one micrometer) PARK the vehicle (v=0)
 *  — without the snap the float residual of `(L−s)·1000 − backoff` would creep
 *  asymptotically and the speed would never reach exactly 0. */
const PARK_EPS_MM = 1e-3;

/** DES blocked-retry interval (s): an occupied zone reschedules the SAME
 *  arrival check after this delay (Ankunfts-Reschedule, plan-268 §2.4 —
 *  a discrete poll, deliberately NOT the continuous ramp). */
const DES_BLOCKED_RETRY_SEC = 0.5;

/** Minimum DES leg transit (s) — keeps degenerate legs finite (mirrors the
 *  tween registry's own duration guard). */
const DES_MIN_TRANSIT_SEC = 0.001;

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
  /** Continuous dwell countdown in seconds (phase 'servicing' only). */
  serviceRemainingSec: number;
  /** Scheduled DES ServiceEnd event id (−1 = none) — cancelled on reset. */
  desServiceEvent: number;
  /** Who ends the stay: 'timer' = task serviceSec; 'dock' = the dock's release(). */
  serviceMode: 'timer' | 'dock';
  /** Set by a dock's release() in continuous mode — ends the stay next tick. */
  dockReleaseFlag: boolean;
  /** Segment already served this visit (dock re-trigger guard) — cleared on hand-off. */
  servedPathId: string | null;
  // Phase 2 — headway / zone parameters (mm, mm/s, 1/s)
  safetyDistanceMm: number;
  minGapMm: number;
  lookAheadMm: number;
  headwayGain: number;
  /** Deterministic re-seed for reset: the resolved start path + position (m). */
  startPath: RVPath | null;
  startPosM: number;
  /** Set by onArrive during advance(); published as the AtNode pulse. */
  atNodeId: string | null;
  // Phase 3 — DES leg bookkeeping (unused in continuous mode).
  /** Scheduled DES Arrival event id (−1 = none) — cancelled on reset. */
  desLegEvent: number;
  /** Path id whose END was already announced via onArrive — de-dupes the hook
   *  across blocked-arrival retries at the same boundary. */
  desArrivedPathId: string | null;
  /** Reisezeit-Cache: path id → FULL-path transit seconds at `desCacheSpeed`. */
  desTravelSec: Map<string, number>;
  /** TargetSpeed (mm/s) the cache entries assume — speed change clears it. */
  desCacheSpeed: number;
  // Pre-allocated pose temps + zone scratch buffers — no GC in the tick.
  _pos: Vector3;
  _quat: Quaternion;
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

// ── Shared helpers (logic layer) ────────────────────────────────────────────

/** Place the vehicle root at the traveler's current pose. The traveler's own
 *  pre-allocated temps are written via copy() — never shared references. */
function applyPose(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler;
  if (!t || !t.path) return;
  t.getPose(l._pos, l._quat);
  // Phase 1: pose is applied in the root's PARENT frame (identity-parent
  // assumption — scene-level placement). World→local conversion is Phase 2+.
  self.root.position.copy(l._pos);
  self.root.quaternion.copy(l._quat);
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

/**
 * Zone claim-ahead walk (control-point model, plan-268 §2.4): walk the routed
 * successors from the current position up to `LookAhead`, CLAIM every zoned
 * path before entry, and return the distance (mm) to the FIRST entrance whose
 * claim failed — the vehicle then holds there via the stop mechanics.
 * Also rebuilds `l._relevantZones` (current + upcoming zone ids) which the
 * post-advance release pass uses. Infinity = no zone constraint in reach.
 */
function claimAheadZones(l: AgvLocal, t: PathTraveler): number {
  const zones = getDefaultZoneRegistry();
  const relevant = l._relevantZones;
  relevant.length = 0;
  let p = t.path as RVPath; // caller guards non-null
  if (p.zoneId) relevant.push(p.zoneId);
  if (p.closed) return Number.POSITIVE_INFINITY; // a loop has no entrances to gate
  // Queue-order guard: the arc-length gap to the vehicle ahead. A NEW claim is
  // only ours when the entrance lies CLOSER than the leader — a leader standing
  // between this vehicle and the entrance must claim first (headway already
  // gates us behind it). Claiming across the leader inverts the queue into a
  // gridlock: the follower holds the zone the leader is waiting for.
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

/**
 * Release pass — runs every tick AFTER `advance()` (position transfer first,
 * plan-268 §2.4): frees every held zone that is neither the zone the vehicle
 * stands in nor an upcoming zone from THIS tick's claim walk. Because the
 * relevant set was built before the advance, a zone that was just left stays
 * held for exactly one more tick — release strictly after transfer, never a
 * one-tick double occupancy the other way round.
 */
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

// ── Task control (plan-921 — destination + service time + callbacks) ───────────────

/**
 * Enter the service stay at the segment end. Two triggers, one mechanism:
 * the segment is the TASK DESTINATION (vehicle-side `serviceSec` timer), or a
 * DOCK is bound to it (station-side control — the dock's `release()` ends the
 * stay and OVERRIDES the task timer; "die Station definiert selbst, was sie
 * macht"). The task's `onArrive` fires only at its destination.
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
      if (self.mode === 'des') {
        if (l.phase === 'servicing' && l.desServiceEvent < 0) {
          l.desServiceEvent = self.in(DES_MIN_TRANSIT_SEC, 'ServiceEnd', null, null);
        }
      } else {
        l.dockReleaseFlag = true; // fixedUpdate ends the stay next tick
      }
    };
    try { dock.onVehicleArrive(t.id, release); }
    catch (e) { console.error('[Agv] dock onVehicleArrive failed — releasing:', e); release(); }
  }
}

/**
 * Finish the service stay. At the TASK DESTINATION: fires `onServiceEnd` —
 * assigning a NEW task from inside the callback chains directly (work-plan
 * style); otherwise the vehicle parks idle and the fleet's idle channel fires
 * (the dispatch trigger). At a THROUGH dock (not the destination) the vehicle
 * simply resumes its route. Either way the segment is marked served, so the
 * dock does not re-trigger until the vehicle leaves it.
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
  try { finished?.onServiceEnd?.(t.id, finished); } catch (e) { console.error('[Agv] task onServiceEnd failed:', e); }
  if (l.task === finished) {
    l.task = null;
    l.phase = 'idle';
    getDefaultAgvFleet().notifyIdle(t.id);
  }
}

/** True while the traveler stands ON its destination segment (drive → service
 *  is triggered at that segment's END). */
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

// ── DES helpers (plan-268 Phase 3 — leg scheduling + Reisezeit-Cache) ───────

/**
 * FULL-path transit seconds at the current TargetSpeed, cached per path id
 * (Reisezeit-Cache `length / v`). A TargetSpeed change invalidates the cache.
 */
function desFullTravelSec(l: AgvLocal, path: RVPath): number {
  const v = Math.max(0.001, l.targetSpeed); // mm/s, division-protected
  if (l.desCacheSpeed !== v) {
    l.desTravelSec.clear();
    l.desCacheSpeed = v;
  }
  let sec = l.desTravelSec.get(path.id);
  if (sec === undefined) {
    sec = (path.length * 1000) / v; // meters → mm, / (mm/s) = seconds
    l.desTravelSec.set(path.id, sec);
  }
  return sec;
}

/**
 * Schedule the CURRENT leg: one Arrival event after the remaining transit of
 * the traveler's path, with a `path` tween sampling the arc between the events
 * (the vehicle-root default target of `self.pathTween`). The traveler's `s`
 * stays authoritative — the DES hooks set it at boundaries; the tween only
 * renders in between (and its final write lands exactly on the leg end).
 */
function desScheduleLeg(self: AgvSelf): void {
  const l = self.local;
  const t = l.traveler!;
  const p = t.path!;
  const full = desFullTravelSec(l, p);
  const frac = p.length > 0 ? (p.length - t.s) / p.length : 0;
  const transit = Math.max(DES_MIN_TRANSIT_SEC, full * frac);
  l.desLegEvent = self.in(transit, 'Arrival', null, self.pathTween(p, t.s, p.length));
  t.v = l.targetSpeed;
  t.blocked = false;
  self.sig.Moving.set(true);
  self.sig.Blocked.set(false);
}

const def = {
  type: 'Agv' as const,
  kind: 'conveyor' as const,
  description: 'Autonomous vehicle (FTS/AGV) that follows an rv_extras.Path graph.',
  mcpDocs:
    'Path-following vehicle (plan-268). Rides the rv_extras.Path graph: PathId selects a ' +
    'registered path (else the first Path node under the root is used). Speed/ramp come from ' +
    'TargetSpeed/Acceleration (mm/s, mm/s² — drive parity). Traffic is raycast-free: 1D ' +
    'arc-length headway (SafetyDistance/MinGap/LookAhead/HeadwayGain) plus zone reservation ' +
    '(rv_extras.Path zone/zoneCapacity — claim before entry, hold at the entrance when ' +
    'occupied). Routing at junctions is a project-injectable id-based hook (selectNextPath); ' +
    'default is successors[0]. Signals: Agv.Run (command), Agv.Moving, Agv.Position (mm), ' +
    'Agv.AtNode (pulse), Agv.Blocked (held by traffic).',
  models: ['*Agv*', '*AGV*'],
  schema: {
    TargetSpeed:     { type: 'number' as const, default: DEFAULTS.TargetSpeed },
    Acceleration:    { type: 'number' as const, default: DEFAULTS.Acceleration },
    UseAcceleration: { type: 'boolean' as const, default: DEFAULTS.UseAcceleration },
    PathId:          { type: 'string' as const, default: DEFAULTS.PathId },
    StartPosition:   { type: 'number' as const, default: DEFAULTS.StartPosition },
    // Plan-921 — declarative one-shot task (no callbacks): drive to
    // Destination (any path id), wait ServiceTime seconds, then idle.
    Destination:     { type: 'string' as const, default: '' },
    ServiceTime:       { type: 'number' as const, default: 0 },
    SafetyDistance:  { type: 'number' as const, default: DEFAULTS.SafetyDistance },
    MinGap:          { type: 'number' as const, default: DEFAULTS.MinGap },
    LookAhead:       { type: 'number' as const, default: DEFAULTS.LookAhead },
    HeadwayGain:     { type: 'number' as const, default: DEFAULTS.HeadwayGain },
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
    desLegEvent: -1,
    desArrivedPathId: null,
    desTravelSec: new Map(),
    desCacheSpeed: 0,
    _pos: new Vector3(),
    _quat: new Quaternion(),
    _relevantZones: [],
    _heldScratch: [],
  }),

  logic: { applyPose },

  // Mode-agnostic init: resolve the path, build the traveler, wire hooks.
  setup(self: AgvSelf): void {
    const l = self.local;
    const bag = configBag(self);
    l.targetSpeed = cfgNumber(bag, 'TargetSpeed', DEFAULTS.TargetSpeed);
    l.acceleration = cfgNumber(bag, 'Acceleration', DEFAULTS.Acceleration);
    l.useAcceleration = bag['UseAcceleration'] !== undefined
      ? bag['UseAcceleration'] === true
      : DEFAULTS.UseAcceleration;
    const pathId = typeof bag['PathId'] === 'string' ? (bag['PathId'] as string) : DEFAULTS.PathId;
    l.safetyDistanceMm = Math.max(0, cfgNumber(bag, 'SafetyDistance', DEFAULTS.SafetyDistance));
    l.minGapMm = Math.max(0, cfgNumber(bag, 'MinGap', DEFAULTS.MinGap));
    l.lookAheadMm = Math.max(0, cfgNumber(bag, 'LookAhead', DEFAULTS.LookAhead));
    l.headwayGain = Math.max(0, cfgNumber(bag, 'HeadwayGain', DEFAULTS.HeadwayGain));
    const startPosMm = cfgNumber(bag, 'StartPosition', DEFAULTS.StartPosition);

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
    // registered network router — "ask the superordinate control for the new
    // target"), then the mechanical shortest-distance hop toward the task
    // destination, then the successors[0] default. Installed as the
    // per-traveler hook, so peekNext (headway/zone look-ahead) predicts the
    // SAME route the carry takes.
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
        l.serviceRemainingSec = 0;
        if (l.desServiceEvent >= 0) { self.cancel(l.desServiceEvent); l.desServiceEvent = -1; }
        // DES: a parked vehicle has no pending leg — re-kick the event chain.
        if (self.mode === 'des' && l.desLegEvent < 0 && traveler.path) {
          l.desLegEvent = self.in(DES_MIN_TRANSIT_SEC, 'Arrival', null, null);
        }
        traveler.atEnd = false;
      },
      clear: () => {
        l.task = null;
        l.phase = 'cruising';
        l.serviceRemainingSec = 0;
        if (l.desServiceEvent >= 0) { self.cancel(l.desServiceEvent); l.desServiceEvent = -1; }
        if (self.mode === 'des' && l.desLegEvent < 0 && traveler.path) {
          l.desLegEvent = self.in(DES_MIN_TRANSIT_SEC, 'Arrival', null, null);
        }
        traveler.atEnd = false;
      },
      get task() { return l.task; },
      get phase() { return l.phase; },
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

    // Phase 2: join the shared headway fleet + claim the starting zone.
    getDefaultSpacingController().add(traveler, { lookAhead: l.lookAheadMm / 1000 });
    claimCurrentZone(traveler);

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
    // Plan-921: cancel a pending service stay and re-arm the declarative config task
    // (deterministic restart — imperative fleet tasks do NOT survive a reset;
    // fleet logic re-assigns on 'simulation-start').
    if (l.desServiceEvent >= 0) {
      self.cancel(l.desServiceEvent);
      l.desServiceEvent = -1;
    }
    l.serviceRemainingSec = 0;
    l.serviceMode = 'timer';
    l.dockReleaseFlag = false;
    l.servedPathId = null;
    l.task = l.startTask ? { ...l.startTask } : null;
    l.phase = l.task ? 'driving' : 'cruising';
    // Phase 3: drop the pending DES leg (stale ids are ignored by the queue)
    // and the boundary bookkeeping — a restart re-kicks via onGenerate.
    if (l.desLegEvent >= 0) {
      self.cancel(l.desLegEvent);
      l.desLegEvent = -1;
    }
    l.desArrivedPathId = null;
    l.desTravelSec.clear();
    if (t) {
      // Release EVERY held zone FIRST (review finding 2 — a reset that keeps a
      // claim deadlocks the crossing permanently; no timeout can heal it), then
      // re-seed the traveler deterministically on its start path.
      getDefaultZoneRegistry().releaseAll(t.id);
      if (l.startPath) t.path = l.startPath;
      t.s = l.startPosM;
      t.v = 0;
      t.atEnd = false;
      t.blocked = false;
      claimCurrentZone(t);
      applyPose(self);
    }
    self.sig.Moving.set(false);
    self.sig.Position.set(l.startPosM * 1000);
    self.sig.AtNode.set(false);
    self.sig.Blocked.set(false);
  },
  start(self: AgvSelf): void {
    if (!self.isWired) self.sig.Run.set(true);
  },

  continuous: {
    fixedUpdate(self: AgvSelf, dt: number): void {
      const l = self.local;
      const t = l.traveler;
      if (!t || !t.path) return;
      if (self.isWired) return;          // an interface controls the vehicle → stay silent

      const run = self.sig.Run.get() === true;

      // Dock re-trigger guard: leaving the served segment clears the mark.
      if (l.servedPathId !== null && t.path.id !== l.servedPathId) l.servedPathId = null;

      // ── Task phases (plan-921): service countdown / idle park ──
      if (l.phase === 'servicing') {
        t.v = 0;
        if (l.serviceMode === 'dock') {
          if (l.dockReleaseFlag) endService(self); // the dock released the vehicle
        } else {
          l.serviceRemainingSec -= dt;
          if (l.serviceRemainingSec <= 0) endService(self); // may assign the next task
        }
        self.sig.Moving.set(false);
        self.sig.Blocked.set(false);
        return;
      }
      if (l.phase === 'idle') {
        t.v = 0;
        self.sig.Moving.set(false);
        self.sig.Blocked.set(false);
        return;
      }

      // ── Headway (1D arc-length, forward only — plan-268 F4) ──
      // gapOf reads the shared start-of-tick snapshot (auto-refresh per round).
      const gapM = getDefaultSpacingController().gapOf(t.id);
      let headwayCap = Number.POSITIVE_INFINITY;    // mm/s ramp target cap
      let headwayFreeMm = Number.POSITIVE_INFINITY; // hard advance budget (gap − MinGap)
      let headwayStopMm = Number.POSITIVE_INFINITY; // braking target (gap − SafetyDistance)
      if (Number.isFinite(gapM)) {
        const gapMm = gapM * 1000;
        headwayCap = computeCarFollowingSpeed(gapMm, l.safetyDistanceMm, l.headwayGain, l.targetSpeed);
        headwayFreeMm = Math.max(0, gapMm - l.minGapMm);
        headwayStopMm = Math.max(0, gapMm - l.safetyDistanceMm);
      }

      // ── Zone reservation (claims ahead as a side effect — plan-268 F5) ──
      const zoneHoldMm = claimAheadZones(l, t);

      // Plan-921: a service stop (task destination OR a bound dock) is a
      // positioning stop like a dead end — the drive ramp decelerates into it.
      const destStopMm = serviceStopAhead(l)
        ? Math.max(0, (t.path.length - t.s) * 1000)
        : Number.POSITIVE_INFINITY;

      const stopMm = Math.min(remainingToStopMm(t), zoneHoldMm, headwayStopMm, destStopMm);
      const target = run ? Math.min(l.targetSpeed, headwayCap) : 0;

      if (t.atEnd || stopMm <= 0) {
        // Parked — at a dead end, at an occupied zone entrance, or inside the
        // safety envelope of the vehicle ahead (drive parity: a positioning
        // drive clamps at its target; re-evaluated every tick, so the vehicle
        // restarts as soon as the constraint clears).
        t.v = 0;
      } else {
        // The DRIVE's ramp (computeRampedSpeed IS RVDrive.update's ramp): the
        // nearest stop constraint gates the deceleration exactly like a
        // positioning drive approaching its target; the headway cap shapes the
        // car-following approach speed.
        t.v = computeRampedSpeed(t.v, target, l.acceleration, l.useAcceleration, stopMm, dt);
      }

      // ── Hard no-penetration clamp (1D arc-length analogue of the transport-
      // surface gap clamp): this tick's advance may never eat into MinGap nor
      // cross an unclaimed zone entrance — regardless of what the ramp decided.
      let parkedByConstraint = false;
      if (t.v > 0) {
        // destStopMm is HARD too (plan-921): the destination end must never be
        // crossed by a single-tick overshoot (UseAcceleration=false travels
        // v·dt per tick) — the carry would hand the vehicle to a successor
        // before the arrival check runs.
        const hardMm = Math.min(headwayFreeMm, zoneHoldMm, destStopMm);
        if (Number.isFinite(hardMm)) {
          const allowedMm = Math.max(0, hardMm - HARD_CLAMP_BACKOFF_MM);
          if (t.v * dt > allowedMm) {
            if (allowedMm <= PARK_EPS_MM) {
              t.v = 0; // parked at the constraint (see PARK_EPS_MM)
              parkedByConstraint = true;
            } else {
              t.v = allowedMm / dt;
            }
          }
        }
      }

      t.advance(dt);
      applyPose(self);

      // Zone release strictly AFTER the position transfer (plan-268 §2.4).
      releaseStaleZones(l, t);

      // Plan-921: arrival at a service stop (destination or dock) → stay starts.
      if ((l.phase === 'driving' || l.phase === 'cruising') && serviceStopAhead(l)
          && (t.path.length - t.s) * 1000 <= PARK_EPS_MM) {
        beginService(self);
        self.sig.Position.set(t.s * 1000);
        return;
      }

      // ── Signals ──
      const blocked = run && !t.atEnd && t.v === 0 && (
        parkedByConstraint ||                            // standing at MinGap / a zone entrance
        (Number.isFinite(gapM) && headwayCap === 0) ||   // held inside the safety envelope
        zoneHoldMm <= PARK_EPS_MM                        // standing at an occupied zone
      );
      t.blocked = blocked;
      self.sig.Moving.set(Math.abs(t.v) > 1e-3);
      self.sig.Position.set(t.s * 1000);            // mm — drive parity
      self.sig.AtNode.set(l.atNodeId !== null);     // one-tick pulse
      self.sig.Blocked.set(blocked);
      l.atNodeId = null;
    },

    teardown(self: AgvSelf): void {
      // Dispose/despawn must leave NO traces in the shared traffic state:
      // a surviving claim would block the crossing permanently (finding 2).
      const t = self.local.traveler;
      if (!t) return;
      getDefaultSpacingController().remove(t.id);
      getDefaultZoneRegistry().releaseAll(t.id);
      getDefaultAgvFleet().unregister(t.id); // plan-921 — no stale handles
    },
  },

  // ── DES adapter (plan-268 Phase 3) — dispatched ONLY by the private runner;
  // this definition never imports it (public/private boundary, §5.1). NOTE:
  // `samplesLiveGeometry` is deliberately NOT declared — the hooks read the
  // parsed path geometry (static) and traveler state, never live world
  // transforms, so FastForward keeps its zero-settle fast path.
  des: {
    /**
     * Start kick (runner.start): schedule the first leg from the seeded
     * StartPosition. A parked vehicle (Run=false) schedules nothing —
     * mid-run Run toggling is a continuous-mode feature (Phase-3 scope).
     */
    onGenerate(self: AgvSelf): void {
      const l = self.local;
      const t = l.traveler;
      if (self.disabled || !t || !t.path) return;
      if (self.sig.Run.get() !== true) return;
      const p = t.path;
      if (p.length <= 0) return;                    // degenerate — never schedule a 0-length loop storm
      if (!p.closed && p.length - t.s <= 0) {       // seeded AT a dead end
        t.atEnd = true;
        self.sig.Moving.set(false);
        return;
      }
      desScheduleLeg(self);
    },

    /**
     * End of the current leg. Routing at the segment boundary uses the SAME
     * callback signature as the continuous carry: `onArrive(pathId, agvId)`
     * fires once per boundary (de-duped across blocked retries), the next
     * path comes from `peekNext` (the identical selectNextPath hook dispatch).
     * An occupied zone → Ankunfts-Reschedule (hold at the boundary, re-check
     * after DES_BLOCKED_RETRY_SEC); a free/claimed zone → transfer first,
     * release the left zone AFTER the transfer (§2.4), schedule the next leg.
     */
    onArrival(self: AgvSelf): void {
      const l = self.local;
      const t = l.traveler;
      if (self.disabled || !t || !t.path) return;
      const p = t.path;
      l.desLegEvent = -1;
      t.s = p.length; // authoritative end state (the tween's final write is the transform)
      self.sig.Position.set(t.s * 1000); // mm — drive parity

      if (p.closed) {
        // Loop wrap — a closed chain has no end node: no arrival announcement
        // (continuous-carry parity), just the next round.
        t.s = 0;
        desScheduleLeg(self);
        return;
      }

      if (l.desArrivedPathId !== p.id) {
        l.desArrivedPathId = p.id;
        t.hooks.onArrive?.(p.id, t.id);
        // Phase 6: same router notification as the continuous carry —
        // de-duped with the hook across blocked-arrival retries.
        t.network?.notifyArrive(p.id, t.id);
      }

      // Plan-921: destination reached → dwell instead of the next leg. The
      // DwellEnd event ends the stay; a follow-up task assigned from inside
      // onServiceEnd re-kicks the leg chain (fleet handle assign()).
      if (serviceStopAhead(l)) {
        beginService(self); // dock mode: the dock's release() schedules ServiceEnd
        self.sig.Blocked.set(false);
        if (l.serviceMode === 'timer') {
          l.desServiceEvent = self.in(
            Math.max(l.serviceRemainingSec, DES_MIN_TRANSIT_SEC), 'ServiceEnd', null, null);
        }
        return;
      }

      const next = t.peekNext(p, 1);
      if (!next || next === p) {
        // Dead end: park (mirror of the continuous clamp+stop). `atEnd` was
        // false on the way in (cleared at every transfer), so the Phase-6
        // dispatch trigger fires exactly once per stop — carry parity.
        t.v = 0;
        const wasAtEnd = t.atEnd;
        t.atEnd = true;
        t.blocked = false;
        self.sig.Moving.set(false);
        self.sig.Blocked.set(false);
        if (!wasAtEnd) t.network?.requestDispatch(t.id);
        return;
      }

      if (next.zoneId) {
        const zones = getDefaultZoneRegistry();
        if (!zones.isHolder(next.zoneId, t.id)) {
          zones.define(next.zoneId, next.zoneCapacity ?? undefined);
          if (!zones.claim(next.zoneId, t.id)) {
            // Ankunfts-Reschedule (plan-268 §2.4): hold AT the entrance and
            // re-run this SAME arrival check later — a discrete poll, no
            // sub-tick, no ramp. The momentary trajectory deliberately
            // diverges from the continuous car-following here (§10 finding 3).
            t.v = 0;
            t.blocked = true;
            self.sig.Moving.set(false);
            self.sig.Blocked.set(true);
            l.desLegEvent = self.in(DES_BLOCKED_RETRY_SEC, 'Arrival', null, null);
            return;
          }
        }
      }

      // Plan-921 DES parity — SEGMENT OCCUPANCY: one vehicle per segment. The
      // follower brakes/stops only at PATH ENDS (the agreed simplification of
      // the continuous car-following chain); a finer queue is modelled by
      // splitting the path into shorter segments. Same discrete hold-and-poll
      // as an occupied zone — arrival ORDER and throughput converge with the
      // continuous mode, the momentary trajectory deliberately does not.
      if (getDefaultSpacingController().occupantsOf(next.id, t.id) > 0) {
        t.v = 0;
        t.blocked = true;
        self.sig.Moving.set(false);
        self.sig.Blocked.set(true);
        l.desLegEvent = self.in(DES_BLOCKED_RETRY_SEC, 'Arrival', null, null);
        return;
      }

      // Position transfer FIRST, then release the zone that was left (§2.4 —
      // never a gap where the crossing is unheld while the vehicle is inside).
      const leftZone = p.zoneId;
      t.path = next;
      t.s = 0;
      t.atEnd = false;
      l.desArrivedPathId = null;
      l.servedPathId = null; // left the served segment
      if (leftZone && leftZone !== next.zoneId) {
        getDefaultZoneRegistry().release(leftZone, t.id);
      }
      desScheduleLeg(self);
    },

    /**
     * Plan-921: end of the dwell at a task destination. `endService` fires the
     * task's `onServiceEnd`; a follow-up task assigned inside the callback has
     * already re-kicked the leg chain via the fleet handle — without one the
     * vehicle parks idle (and the fleet idle channel fired).
     */
    onServiceEnd(self: AgvSelf): void {
      const l = self.local;
      l.desServiceEvent = -1;
      if (self.disabled || !l.traveler) return;
      endService(self);
      if (l.phase === 'idle') {
        self.sig.Moving.set(false);
        return;
      }
      // Through dock (or a chained follow-up task): resume the leg chain —
      // the re-run arrival is de-duped (announce + served marks) and routes on.
      if (l.desLegEvent < 0) {
        l.desLegEvent = self.in(DES_MIN_TRANSIT_SEC, 'Arrival', null, null);
      }
    },
  },
};

/** Agv — path-following vehicle (factory-built; behaviour identical to the def). */
const AgvBehavior = defineLibraryComponent(def);

/** The material-flow definition (schema + logic + continuous + des) — for DES tests / runner. */
export const AgvFlow = def;

export default AgvBehavior;

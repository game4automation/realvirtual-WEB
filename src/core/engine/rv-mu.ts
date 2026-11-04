// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { isInactiveWithin, hasInactiveDescendant } from './rv-authored-inactive';
import { groupLabelsOf } from './rv-mu-group-labels';
import { computeMUDetectionFrameBox, type DetectPartObb } from './rv-mu-collider-bounds';
import { layerOfNode } from './rv-layers';
import {
  Object3D, Vector3, Quaternion, Matrix4, Box3, Sphere,
  InstancedMesh, DynamicDrawUsage,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import type { Mesh } from 'three';
import { AABB } from './rv-aabb';
import { classifyShadows } from './rv-mesh-classifier';
import { loadSchemaFromSpec, registerComponentSchema } from './rv-component-registry';
import type { RVTransportSurface } from './rv-transport-surface';
import type { MUDissolve, MUGrow } from './rv-mu-dissolve';
import { getTslMaterials } from './materials/material-factory';
import type { MuComputeTransforms } from './materials/rv-mu-compute-tsl';
import type { MuOwner } from './rv-mu-owner';

// Pre-allocated temp vector for getWorldPosition (no GC in hot path)
const _tmpWorldPos = new Vector3();
// Pre-allocated scratch for the rotation-aware AABB-extent recompute in updateAABB().
const _aabbWorldQuat = new Quaternion();

// ─── Engine-wide numeric MU identity (plan-259 / plan-210 gap) ─────────────
// Every MU — clone AND instanced — gets a stable numeric `id` at construction.
// This is the id space `ScriptMuRef.id` uses across the script SDK boundary,
// bridged to the string `InstancedMovingUnit.muId` for instanced MUs.
let _nextEngineMuId = 1;
/** Mint the next engine-wide numeric MU id (monotonic, never reused). */
export function nextEngineMuId(): number {
  return _nextEngineMuId++;
}

/** Subsystems that may hold an MU in place (plan-259 O1b owner tag).
 *  'grip' = RVGrip fix/unfix; 'connection' = typed connection (StopOnExit);
 *  'zone' = a Zone with the Hold effect (plan-521);
 *  'user' = the commissioning drag gesture holds it while the pointer is down (plan-567);
 *  'pusher' = an `MUPusher` carries a pushed MU in front of the pushing one (plan-2016 S6b). */
export type MuHolder = 'grip' | 'connection' | 'zone' | 'user' | 'pusher';

/**
 * IMUAccessor — Unified interface abstracting over clone-based and
 * InstancedMesh-based MU rendering modes.
 *
 * Clone mode: delegates to this.node.position / .quaternion
 * Instance mode: reads/writes parallel Float32Array via pool
 */
export interface IMUAccessor {
  getWorldPosition(out: Vector3): Vector3;
  getPosition(): Vector3;
  setPosition(v: Vector3): void;
  getQuaternion(): Quaternion;
  setQuaternion(q: Quaternion): void;
  rotateOnAxis(axis: Vector3, angle: number): void;
  getName(): string;
  readonly isInstanced: boolean;
  /** True while the physics provider owns this MU's pose (plan-276 F4) — the
   *  kinematic transport pipeline skips it (like `isGripped`, but provider-
   *  owned). Set by the transport manager at the conveyor-end handover;
   *  cleared by the physics plugin on the settle return (F7).
   *  Compatibility view of {@link owner} (plan-661): true for `'rapier'` or
   *  `'box2d'`. Writing it is a legacy path — production code uses `setMuOwner`. */
  physicsOwned: boolean;
  /** Engine that owns the pose (plan-661). Change only via `setMuOwner`. */
  owner: MuOwner;
  /** Physics-provider body handle (`String(mu.id)`); null while kinematic.
   *  Read by `IPhysicsMUHook.onMUDisposed` to free the body on any dispose
   *  path (F14) — hence part of the accessor interface. */
  physicsBodyId: string | null;
  /** Authored rigid-body mass in kg (plan-467 F16), or undefined for the zone
   *  default. Read at handover — an MU's payload weight is what makes the
   *  drive-sizing chart meaningful, and Rapier's density default would give the
   *  standard 0.2 m demo cube 8 g. */
  physicsMassKg?: number;
}

/**
 * RVMovingUnit - A moving unit (part/product) being transported through the system.
 *
 * Created by RVSource, moved by RVTransportSurface, detected by RVSensor, removed by RVSink.
 * Implements IMUAccessor for unified access regardless of rendering backend.
 */
// ── plan-469 spike state (dev-only) ───────────────────────────────

/**
 * A/B prototype switches that live below the transport manager (plan-469 Phase
 * 0c). **Both false in production**; the perf harness flips them from
 * `?proto=walk,bounds` via `RVTransportManager`.
 *
 * A module-level object rather than a manager field because both call sites
 * (`RVMovingUnit.updateAABB`, `MUInstancePool.updateInstanceMatrix`) are reached
 * without a manager reference.
 */
export const rvProtoFlags = {
  oneWalk: false,
  poolBounds: false,
  /**
   * plan-473 F2 — MEASUREMENT/REFERENCE switch, the inverse of a prototype
   * switch: `true` restores the UNCACHED `updateAABB` of the reference path so
   * an ABBA pair and the parity test have a reference side that does not run
   * the production cache. Production is `false` (cache on).
   */
  refAabb: false,
};

/**
 * plan-473 F2 — dev-only evidence that the cache actually fires. Counts the
 * rotated-half-extent recomputations that ran (`recompute`) and the ones the
 * quaternion comparison skipped (`skip`). Incremented only under
 * `import.meta.env.DEV`, so a production bundle drops both branches.
 */
export const rvAabbCacheStats = { recompute: 0, skip: 0 };

/** Reset the plan-473 F2 counters (tests / a fresh measurement window). */
export function resetAabbCacheStats(): void {
  rvAabbCacheStats.recompute = 0;
  rvAabbCacheStats.skip = 0;
}

/** Cumulative pool-growth accounting for the long-step records (plan-469 F6):
 *  `_grow()` is the prime suspect behind the rare 400-800 ms steps, and the
 *  records need to say whether it fired at all in that tick. */
export const muPoolGrowth = { count: 0, ms: 0 };

/** Scratch for the single-walk AABB path — module-level, never allocated in the
 *  hot path. */
const _walkPos = new Vector3();
const _walkQuat = new Quaternion();
const _walkScale = new Vector3();
const _refreshScale = new Vector3();
const _zeroVec = new Vector3();
const _detectBox = new Box3();
const _detectHalf = new Vector3();
const _detectCenter = new Vector3();
const _detectParts: Box3[] = [];
const _detectLayers: number[] = [];
const _detectNodes: Object3D[] = [];
const _detectObbs: DetectPartObb[] = [];

/** One single collider box of an MU's detection shape, in the MU rotation frame
 *  (world units): `center +- half` (plan-2016 S5 Codex fix). */
export interface DetectPartSpec { half: Vector3; center: Vector3 }

type DetectShape = { aabb: AABB; detectAabb?: AABB; detectParts?: readonly AABB[] | null };

/**
 * Sensor overlap of `box` with an MU's detection shape (plan-2016 S5 Codex fix):
 * the union `detectAabb` as broadphase, then the single collider boxes when the
 * MU has several, because the union alone fills the gaps between them.
 */
export function muDetectOverlaps(mu: DetectShape, box: AABB): boolean {
  if (!box.overlaps(mu.detectAabb ?? mu.aabb)) return false;
  const parts = mu.detectParts;
  if (!parts) return true;
  for (let i = 0; i < parts.length; i++) if (box.overlaps(parts[i])) return true;
  return false;
}


/**
 * Authored pose of a pre-placed MU (plan-516), captured at classification and
 * restored by every reset. Runtime only — never serialized.
 */
export interface PreplacedSnapshot {
  parent: Object3D;
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
  visible: boolean;
}

export class RVMovingUnit implements IMUAccessor {
  readonly node: Object3D;
  readonly aabb: AABB;
  /** The box SENSORS test against (plan-2016 S5 fix, Unity parity: a Unity sensor
   *  hits the MU's colliders, not its mesh). Same object as {@link aabb} unless
   *  {@link setDetectionBox} gave the MU its authored BoxCollider shape; transport,
   *  accumulation, grid and sinks keep using {@link aabb}. */
  detectAabb: AABB;
  /** Local half-extents of a separate detection box (null = shares {@link aabb}). */
  private _detectLocalHalf: Vector3 | null = null;
  /** Upper bound (m) of how far {@link detectAabb} can reach beyond {@link aabb} —
   *  the MU grid indexes `aabb`, so a sensor's grid query widens by this. 0 = shared. */
  detectMargin = 0;
  /** The single collider boxes behind {@link detectAabb} when there are two or
   *  more (plan-2016 S5 Codex fix): the union box fills the gaps between them, so
   *  sensors use it only as the broadphase and then test these. null = the
   *  detection box IS the collider. */
  detectParts: AABB[] | null = null;
  private _detectPartHalves: Vector3[] = [];
  /** Unity layer of each {@link detectParts} entry (plan-2016 S6c; null when there
   *  are no parts). -1 = unknown, never filtered. */
  detectPartLayers: number[] | null = null;
  /** Unity layer of the detection box when it has no {@link detectParts}: the one
   *  collider's node, else (mesh box) the MU root. -1 = unknown, never filtered. */
  detectLayer = -1;
  /** Unity layer of the MU root (`extras.layer`, or the clone stash of a spawned
   *  MU); -1 = unknown. What `WebPhysicsZone.LimitToLayers` filters on (plan-2016 S7). */
  get layer(): number { return layerOfNode(this.node); }
  /** The node carrying each {@link detectParts} entry (null when there are no parts,
   *  or for a pooled template copy): the collider's IDENTITY. A raycast sensor
   *  fires a new MU-enter when its beam moves from one collider of the MU to
   *  another (Unity `Sensor.FixedUpdate`: exit + enter on `hit.collider` change). */
  detectPartNodes: Object3D[] | null = null;
  /** Node of the ONE collider when the detection box is a single collider (no parts). */
  private _detectSingleNode: Object3D | null = null;
  /** Exact oriented box + collider index of every collider part (also of a single
   *  one); null = mesh box (plan-2016 Codex review). Index = {@link detectParts}. */
  private _detectObbs: DetectPartObb[] | null = null;
  readonly sourceName: string;

  /** True for an MU authored in the scene (no Source spawned it, plan-516).
   *  Its node belongs to the document: disposal detaches it, a reset puts it
   *  back from {@link snapshot}. */
  preplaced = false;

  /** Authored pose of a pre-placed MU; null for spawned MUs. */
  snapshot: PreplacedSnapshot | null = null;

  /** The MU this one rests on as a PASSIVE load (plan-516 F3). Set ⇒ the MU is
   *  a child of the carrier's node, not in `RVTransportManager.mus` and never
   *  ticked (no transport, accumulation, vanish, physics or sensor pass). */
  loadedOn: RVMovingUnit | null = null;

  /** Passive loads resting on this MU (any number, plan-516 F2). */
  readonly loadedMus: RVMovingUnit[] = [];

  /** How deep (metres) a load may sit below this carrier's collider top and
   *  still rest on it — a part in a jig, a cap over a valve end (plan-577 F2).
   *  0 = the plain plan-516 contact within the tolerance. Authored as
   *  `MU.LoadSeatDepth` in millimetres; read by `readLoadSeatDepth`
   *  (`rv-mu-load.ts`) and limited to 80 % of the collider height where used. */
  loadSeatDepth = 0;

  /** Which transport surface is currently moving this MU (null = free) */
  currentSurface: RVTransportSurface | null = null;

  /** Kinematic surface settle state; preallocated for the transport hot path. */
  settleSpeed = 0;
  settleSurface: RVTransportSurface | null = null;

  /** Most recent surface that drove this MU; survives the MU running off the end
   *  (when `currentSurface` becomes null) so the end-of-line vanish can still
   *  check THAT surface's outgoing-snap connectivity. */
  lastSurface?: RVTransportSurface | null;

  /** Seconds without support — the grace clock of the drop detection
   *  (plan-2022). Reset the moment one of its four conditions breaks again.
   *  Diagnostic only, same pattern as {@link offSurfaceTime}. */
  unsupportedTime?: number;
  /** True once something held, loaded or carried this MU (plan-2022 E7): only such a part can LOSE its support. */
  wasCarried?: boolean;
  /** `unsupportedTime` at the last support ray; gates `SupportRecheckInterval`. */
  supportProbeAt?: number;
  /** Result of the last support ray (true = something underneath). */
  supported?: boolean;

  /** Marked for removal by Sink */
  markedForRemoval = false;

  /** True while the accumulation gap clamp (plan-255) shortened this MU's
   *  advance this tick (it is jammed behind another MU). Diagnostic only —
   *  reset to false by the transport manager before each transport step. */
  blocked = false;
  /** Diagnostic accumulation blocker, in the engine-wide MU id space. */
  blockedBy: number | null = null;

  /** Stable engine-wide numeric MU id (script SDK `mu.id` id space). A clone that
   *  replaces an instanced MU (plan-2016 S4 promote) keeps the instance's id. */
  readonly id: number;

  /** Owner tag (plan-259 O1b): which subsystem currently holds this MU in
   *  place. `'grip'` = attached to an RVGrip; `'connection'` = held by a typed
   *  connection (StopOnExit); `'zone'` = held by a Hold zone (plan-521); `'user'` = the
   *  commissioning drag gesture (plan-567). Each subsystem only releases what it holds
   *  itself — replaces the ownerless `isGripped` bool. Null = free. */
  heldBy: MuHolder | null = null;

  /** True while ANY subsystem holds this MU (transport skips it, sinks don't
   *  consume it). Derived from the `heldBy` owner tag — read-only by design:
   *  writers must set `heldBy` so ownership stays unambiguous. */
  get isGripped(): boolean {
    return this.heldBy !== null;
  }

  /** The original parent before gripping (for restoring on ungrip) */
  parentBeforeGrip: Object3D | null = null;

  /** The `Source.Destination` node this MU was spawned under (plan-2016 S1), else null.
   *  While the MU is still its child, the transport loop leaves it alone so it rides
   *  with that node; a grip that re-parents it ends that. */
  destinationParent: Object3D | null = null;

  /** True while the physics provider owns this MU's pose (plan-276 F4).
   *  The kinematic transport loop, accumulation queries and grips skip it.
   *  Compatibility view of {@link owner} (plan-661). */
  get physicsOwned(): boolean { return this.owner !== 'transport'; }
  /** Legacy write path (tests, old callers): true = Rapier, false = transport. */
  set physicsOwned(v: boolean) { this.owner = v ? 'rapier' : 'transport'; }

  /** Engine that owns the pose (plan-661). Change only via `setMuOwner`. */
  owner: MuOwner = 'transport';

  /** Physics-provider body handle (`String(this.id)`); null while kinematic. */
  physicsBodyId: string | null = null;

  /** Authored rigid-body mass in kg (plan-467 F16); undefined → zone default. */
  physicsMassKg?: number;

  /** Whether this MU uses InstancedMesh rendering (false = clone-based) */
  readonly isInstanced = false;

  /** Tick id (RVTransportSurface._currentTickId) of the most recent successful
   *  `surface.transportMU(this, …)` call. Used by `RVTransportSurface` to
   *  decide whether to carry the MU along with a rotating parent: rotation is
   *  only applied when the MU was on the same surface in the immediately
   *  previous tick (`lastSurfaceTickId === currentTickId - 1`), so a freshly
   *  entered MU is not snapped by a phantom one-tick rotation. */
  lastSurfaceTickId?: number;

  /** True once this MU has been carried by any transport surface. Gates the
   *  end-of-line vanish so freshly-spawned MUs (not yet on a belt) aren't
   *  deleted. See `RVTransportManager.vanishMUsAtEndOfLine`. */
  everOnSurface?: boolean;

  /** True while the MU's current (or most recent) transport surface belongs to a
   *  planner-placed layout object. End-of-line vanish is scoped to layout
   *  objects, and this remembers membership across the moment the MU runs off the
   *  surface (when `currentSurface` becomes null). See
   *  `RVTransportManager.vanishMUsAtEndOfLine`. */
  onLayoutObject?: boolean;

  /** Seconds spent off ALL transport surfaces (the vanish dwell timer). Reset
   *  to 0 whenever a surface picks the MU up again. */
  offSurfaceTime?: number;

  /** Seconds elapsed in the end-of-line dissolve animation (set once the dwell
   *  timer expires; counts up to `RVTransportManager.vanishDurationSec`). */
  vanishElapsed?: number;

  /** Active dissolve effect (cloned burn materials) while this MU is vanishing.
   *  Disposed on removal or if the MU is picked up again before it finishes. */
  dissolve?: MUDissolve | null;

  /** Active spawn grow-out effect (cloned clip materials) while this MU is
   *  growing out of its source. Distance/vector based: a fixed world clip plane
   *  the MU slides through as it travels. Disposed once fully emerged or on
   *  removal. */
  grow?: MUGrow | null;

  /** MU half-extents in its OWN local frame (spawn orientation), captured at
   *  construction. `updateAABB()` re-derives the world axis-aligned footprint
   *  from this under the MU's CURRENT world rotation, so a pallet turned 90° at
   *  a turntable corner keeps a detection box that matches the visible mesh. */
  private readonly _localHalf: Vector3;

  constructor(node: Object3D, sourceName: string, halfSize?: Vector3, localCenter?: Vector3, id?: number) {
    this.id = id ?? nextEngineMuId();
    this.node = node;
    this.sourceName = sourceName;

    if (halfSize) {
      this.aabb = AABB.fromHalfSize(node, halfSize, localCenter);
    } else {
      this.aabb = AABB.fromNode(node);
    }
    this._localHalf = this.aabb.halfSize.clone();
    this.detectAabb = this.aabb;
    this.detectLayer = layerOfNode(node);
  }

  /**
   * Give the MU a separate sensor detection box: the authored BoxCollider shape
   * in the MU's rotation frame (world units, same convention as the constructor's
   * `halfSize` / `localCenter`). Sensors then detect the collider, not the mesh
   * (Unity `Physics.Raycast` / trigger overlap against the MU's colliders).
   */
  setDetectionBox(halfSize: Vector3, localCenter: Vector3): void {
    if (this._detectLocalHalf) {
      this.detectAabb.localCenter.copy(localCenter);
      this._detectLocalHalf.copy(halfSize);
      this.detectMargin = localCenter.distanceTo(this.aabb.localCenter) + halfSize.length();
      this.updateAABB();
      return;
    }
    this.detectAabb = AABB.fromHalfSize(this.node, halfSize, localCenter);
    this._detectLocalHalf = halfSize.clone();
    this.detectMargin = localCenter.distanceTo(this.aabb.localCenter) + halfSize.length();
    this.updateAABB();
  }

  /**
   * Re-measure the MU's mesh box from the CURRENTLY active variant (plan-2016 S5
   * fix): after a MUSwitcher switched groups, transport and grid see the new
   * shape. Inactive variants and the subtrees of passive loads do not count.
   * The sensor detection box is re-derived too: the union of the now ACTIVE
   * colliders (`computeMUDetectionFrameBox`), else the mesh box again.
   * A pre-placed MU is defined by its colliders and keeps its boxes. Returns
   * whether the mesh box was re-measured.
   */
  refreshShapeFromMeshes(): boolean {
    const exclude = this.loadedMus.length > 0 ? new Set(this.loadedMus.map((m) => m.node)) : undefined;
    // A pre-placed MU's transport box comes from its solid colliders and stays;
    // its SENSOR shape follows the active colliders like every other MU's.
    if (!this.preplaced) {
      const info = computeTemplateAABBInfo(this.node, exclude);
      // An empty mesh box (a variant without render geometry) keeps the old
      // transport box; the detection shape below is refreshed regardless.
      if (info.halfSize.lengthSq() > 0) {
        this.node.getWorldScale(_refreshScale);
        info.halfSize.multiply(_refreshScale);
        info.localCenter.multiply(_refreshScale);
        this._localHalf.copy(info.halfSize);
        this.aabb.localCenter.copy(info.localCenter);
      }
    }
    this.refreshDetectionShape(exclude);
    return true;
  }

  /**
   * (Re-)derive the sensor detection shape from the MU's currently ACTIVE
   * colliders (`computeMUDetectionFrameBox`): union box plus, for two or more
   * colliders, the single boxes. No active collider = sensors use the mesh box.
   * Used at classification and after a MUSwitcher switch (plan-2016 S5).
   */
  refreshDetectionShape(exclude?: ReadonlySet<Object3D>): void {
    if (computeMUDetectionFrameBox(this.node, _detectBox, exclude, _detectParts, _detectLayers, _detectNodes, _detectObbs)) {
      this.setDetectionBox(_detectBox.getSize(_detectHalf).multiplyScalar(0.5), _detectBox.getCenter(_detectCenter));
      this.setDetectionParts(_detectParts, _detectLayers, _detectNodes, _detectObbs);
    } else {
      this.detectAabb = this.aabb;
      this._detectLocalHalf = null;
      this.detectMargin = 0;
      this.setDetectionParts(null);
    }
    this.updateAABB();
  }

  /**
   * Set the single collider boxes behind the detection box (frame boxes in the
   * MU rotation frame, world units: the `parts` of `computeMUDetectionFrameBox`).
   * Fewer than two = none kept (the detection box is exact then).
   */
  setDetectionParts(
    parts: readonly Box3[] | null, layers?: readonly number[], nodes?: readonly Object3D[],
    obbs?: readonly DetectPartObb[],
  ): void {
    // plan-2016 S6c: one collider → its node's layer; none (mesh box) → the root's.
    this.detectLayer = parts && parts.length === 1 && layers && layers.length === 1
      ? layers[0] : layerOfNode(this.node);
    this._detectObbs = parts && parts.length > 0 && obbs && obbs.length === parts.length
      ? obbs.map((o) => ({ rot: o.rot.clone(), half: o.half.clone(), colliderIndex: o.colliderIndex }))
      : null;
    if (!parts || parts.length < 2) {
      this.detectParts = null;
      this._detectPartHalves = [];
      this.detectPartLayers = null;
      this.detectPartNodes = null;
      this._detectSingleNode = parts && parts.length === 1 && nodes && nodes.length === 1 ? nodes[0] : null;
      return;
    }
    this._detectSingleNode = null;
    this.detectPartLayers = layers && layers.length === parts.length ? [...layers] : null;
    this.detectPartNodes = nodes && nodes.length === parts.length ? [...nodes] : null;
    this.detectParts = parts.map((b) => AABB.fromHalfSize(
      this.node, b.getSize(new Vector3()).multiplyScalar(0.5), b.getCenter(new Vector3())));
    this._detectPartHalves = this.detectParts.map((a) => a.halfSize.clone());
    this.updateAABB();
  }

  /** Half extents, in the detection frame ({@link detectQuaternion}), of detection
   *  part `i`, or of the single detection box for `i < 0` (plan-2016 sensor parity:
   *  the raycast tests the ORIENTED box, not its world enclosure). */
  detectHalf(i: number): Vector3 {
    if (i >= 0) return this._detectPartHalves[i];
    return this._detectLocalHalf ?? this._localHalf;
  }

  /** World rotation of the detection frame — the MU node's world rotation. */
  detectQuaternion(out: Quaternion): Quaternion {
    return this.node.getWorldQuaternion(out);
  }

  /** Half extents of the EXACT oriented box of part `i` (`i < 0`: the single
   *  detection box) along its own axes ({@link detectObbRotation}); the frame box
   *  half ({@link detectHalf}) when no collider OBB is known (mesh box). */
  detectObbHalf(i: number): Vector3 {
    const obbs = this._detectObbs;
    if (obbs) {
      if (i >= 0 && i < obbs.length) return obbs[i].half;
      if (i < 0 && obbs.length === 1) return obbs[0].half;
    }
    return this.detectHalf(i);
  }

  /** Rotation of part `i`'s oriented box relative to the detection frame
   *  ({@link detectQuaternion}); null = aligned with the frame. */
  detectObbRotation(i: number): Quaternion | null {
    const obbs = this._detectObbs;
    if (obbs) {
      if (i >= 0 && i < obbs.length) return obbs[i].rot;
      if (i < 0 && obbs.length === 1) return obbs[0].rot;
    }
    return null;
  }

  /** Identity of the collider behind detection part `i` (`i < 0`: the single
   *  detection box) — the node carrying it; the MU root for a mesh box. Together
   *  with {@link detectColliderSub} it names ONE collider; the same collider keeps
   *  its identity when a MUSwitcher re-derives the shape. */
  detectColliderKey(i: number): unknown {
    if (i >= 0 && this.detectPartNodes) return this.detectPartNodes[i];
    if (i < 0 && this._detectSingleNode) return this._detectSingleNode;
    return this.node;
  }

  /** Second half of the collider identity ({@link detectColliderKey}): the index of
   *  the collider in its node's collider list (a node can carry several); -1 for a
   *  mesh box. */
  detectColliderSub(i: number): number {
    const obbs = this._detectObbs;
    if (!obbs) return -1;
    if (i >= 0 && i < obbs.length) return obbs[i].colliderIndex;
    if (i < 0 && obbs.length === 1) return obbs[0].colliderIndex;
    return -1;
  }

  // ─── IMUAccessor implementation (clone mode) ────────────────────

  /** Get world position of this MU */
  getWorldPosition(out: Vector3): Vector3 {
    return this.node.getWorldPosition(out);
  }

  /** Get local position (returns reference to node.position for clone mode) */
  getPosition(): Vector3 {
    return this.node.position;
  }

  /** Set local position */
  setPosition(v: Vector3): void {
    this.node.position.copy(v);
  }

  /** Get quaternion (returns reference to node.quaternion for clone mode) */
  getQuaternion(): Quaternion {
    return this.node.quaternion;
  }

  /** Set quaternion */
  setQuaternion(q: Quaternion): void {
    this.node.quaternion.copy(q);
  }

  /** Rotate around local axis */
  rotateOnAxis(axis: Vector3, angle: number): void {
    this.node.rotateOnAxis(axis, angle);
  }

  /** Get display name for this MU */
  getName(): string {
    return this.node.name;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────


  // ── plan-469 accumulation span stamps (probe-only) ─────────────
  // The cell-union CACHE (`?proto=union`) is gone — plan-473 F3 / Alternative 4:
  // it was slower than its reference in both A/B campaigns. The two span stamps
  // below survive because the hit-rate probe still measures how often a query's
  // cell span is stable, which is evidence about the grid, not a cache.
  /** Packed cell span of the last accumulation query (see `SpatialGridXZ.spanKey`). */
  _accumSpanKey = -1;
  /** Tick at which the union was stamped; valid while no cell in the span
   *  changed at or after it. */
  _accumCacheTick = -1;

  /** Update AABB world position after transport movement. Re-derives the world
   *  axis-aligned extent from the MU's local half-extents under its current world
   *  rotation, so the detection/collision footprint follows the part as it is
   *  turned (e.g. by a turntable) — otherwise a rotated part is detected at the
   *  wrong point (a light-barrier beam breaks ~half-a-part-length off). */
  updateAABB(): void {
    // plan-469 F4 prototype: one world-matrix walk instead of three
    // (`getWorldQuaternion` here + `getWorldPosition`/`getWorldQuaternion` inside
    // `aabb.update()`). Position AND quaternion come from a single decompose;
    // the `localCenter` rotation semantics are unchanged (`AABB.updateFrom`).
    // Off in production — then the three-walk reference path below runs.
    if (rvProtoFlags.oneWalk) {
      this.node.updateWorldMatrix(true, false);
      this.node.matrixWorld.decompose(_walkPos, _walkQuat, _walkScale);
      this.aabb.setHalfSizeFromRotatedExtents(this._localHalf, _walkQuat);
      this.aabb.updateFrom(_walkPos, _walkQuat);
      if (this._detectLocalHalf) {
        this.detectAabb.setHalfSizeFromRotatedExtents(this._detectLocalHalf, _walkQuat);
        this.detectAabb.updateFrom(_walkPos, _walkQuat);
      }
      if (this.detectParts) {
        for (let i = 0; i < this.detectParts.length; i++) {
          this.detectParts[i].setHalfSizeFromRotatedExtents(this._detectPartHalves[i], _walkQuat);
          this.detectParts[i].updateFrom(_walkPos, _walkQuat);
        }
      }
      return;
    }
    this.node.getWorldQuaternion(_aabbWorldQuat);
    this.aabb.setHalfSizeFromRotatedExtents(this._localHalf, _aabbWorldQuat);
    this.aabb.update();
    if (this._detectLocalHalf) {
      this.detectAabb.setHalfSizeFromRotatedExtents(this._detectLocalHalf, _aabbWorldQuat);
      this.detectAabb.update();
    }
    if (this.detectParts) {
      for (let i = 0; i < this.detectParts.length; i++) {
        this.detectParts[i].setHalfSizeFromRotatedExtents(this._detectPartHalves[i], _aabbWorldQuat);
        this.detectParts[i].update();
      }
    }
  }

  /**
   * Dispose this MU - remove from scene and clear references.
   * For a pre-placed MU (plan-516) this is detach-and-keep: the node is part
   * of the document, so only its scene membership goes — a reset re-attaches
   * it from the snapshot and `clearModel` hands it back to the model tree.
   * Does NOT dispose geometry or materials — Object3D.clone() shares
   * geometry and materials by reference with the template. Disposing
   * them here would destroy the shared GPU buffers used by the template
   * and all other MU clones. Template geometries are disposed in clearModel().
   */
  dispose(): void {
    // Restore + free any end-of-line dissolve materials we cloned (the originals
    // are shared with the template and must stay alive).
    this.dissolve?.dispose();
    this.dissolve = null;
    this.grow?.dispose();
    this.grow = null;
    this.node.parent?.remove(this.node);
    // Do NOT dispose geometry here — it is shared by reference with the
    // template via Object3D.clone(). Disposing would corrupt all clones.
  }
}

/**
 * Compute half-size from a template node's bounding box.
 * Called once per template, result cached and reused for all clones.
 */
export interface TemplateAABBInfo {
  halfSize: Vector3;
  /** Local-space offset from node origin to mesh bounding box center */
  localCenter: Vector3;
}

export function computeTemplateHalfSize(template: Object3D): Vector3 {
  return computeTemplateAABBInfo(template).halfSize;
}

/**
 * Compute both half-size AND local center offset from the template mesh bounds.
 * The localCenter accounts for meshes not centered on their node origin (e.g.,
 * pivot at the bottom, mesh extends upward).  Without this, the AABB is displaced
 * and overlap checks (grip, sensor) fail.
 */
export function computeTemplateAABBInfo(template: Object3D, exclude?: ReadonlySet<Object3D>): TemplateAABBInfo {
  template.updateWorldMatrix(true, true);
  const inverse = new Matrix4().copy(template.matrixWorld).invert();
  const relative = new Matrix4();
  const meshBox = new Box3();
  const box = new Box3();
  // MU.updateAABB applies the spawn's world orientation. Measure the template
  // in its OWN frame here, or a rotated CAD source gets rotated a second time.
  const visit = (node: Object3D): void => {
    if (exclude?.has(node)) return;
    for (const child of node.children) visit(child);
    const mesh = node as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    // plan-2016 S5: an authored-inactive variant (MUSwitcher group) is not part
    // of the MU's size — like an inactive GameObject in Unity. The template
    // root's own flag does not count (a Source activates every clone's root).
    if (isInactiveWithin(node, template)) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    relative.multiplyMatrices(inverse, node.matrixWorld);
    meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(relative);
    box.union(meshBox);
  };
  visit(template);
  const size = new Vector3();
  box.getSize(size);
  const halfSize = size.multiplyScalar(0.5);
  const boxCenter = new Vector3();
  box.getCenter(boxCenter);
  const localCenter = boxCenter;
  return { halfSize, localCenter };
}

const _cloneScaleTmp = new Vector3();

/**
 * Local scale a CLONE of `template` needs under `spawnParent` to keep the
 * template's WORLD size (plan-655 F10, SOL finding 2): template world scale ÷
 * spawn-parent world scale, per axis. Equals `template.scale` whenever both
 * hang under the same (or an equally scaled) parent — the case every Source had
 * before; it differs for a template inside a millimetre SolidCraft body (0.001)
 * spawning into the unscaled model root. ONE rule for the spawned clone and
 * for `templateSizeOf` (DES sizing), so the two cannot drift.
 */
export function spawnCloneScale(template: Object3D, spawnParent: Object3D, out: Vector3): Vector3 {
  template.updateWorldMatrix(true, false);
  spawnParent.updateWorldMatrix(true, false);
  template.getWorldScale(out);
  spawnParent.getWorldScale(_cloneScaleTmp);
  return out.divide(_cloneScaleTmp);
}

// ─── Pre-allocated temps for InstancedMovingUnit (no GC in hot path) ──

const _tmpQuat = new Quaternion();
const _tmpMat4 = new Matrix4();
const _tmpPos = new Vector3();

/**
 * InstancedMovingUnit — An MU rendered via MUInstancePool (InstancedMesh).
 *
 * Position and rotation are stored in the pool's parallel Float32Arrays.
 * No per-instance Object3D exists. The `node` field points to the pool's
 * InstancedMesh (shared among all instances of this template).
 */
export class InstancedMovingUnit implements IMUAccessor {
  /** The InstancedMesh (shared, NOT per-instance). Used for scene graph membership. */
  private _node: InstancedMesh;
  get node(): InstancedMesh { return this._node; }
  readonly aabb: AABB;
  /** See `RVMovingUnit.detectAabb`: the pool's collider box, else {@link aabb}. */
  readonly detectAabb: AABB;
  /** See `RVMovingUnit.detectMargin`. */
  readonly detectMargin: number;
  /** See `RVMovingUnit.detectParts`. */
  readonly detectParts: AABB[] | null;
  private readonly _detectPartHalves: Vector3[];
  /** See `RVMovingUnit.detectPartLayers` — the pool's, i.e. the same as a clone of
   *  the template (plan-2016 S7). */
  readonly detectPartLayers: number[] | null;
  /** See `RVMovingUnit.detectLayer` — the pool's (plan-2016 S7). */
  readonly detectLayer: number;
  /** See `RVMovingUnit.layer` — the template root's layer, kept by the pool
   *  (plan-2016 S7): an instance has no node of its own to carry it. */
  readonly layer: number;
  /** See `RVMovingUnit.detectPartNodes` — a pooled instance has no nodes. */
  readonly detectPartNodes: Object3D[] | null = null;
  readonly sourceName: string;
  readonly isInstanced = true;

  // ── plan-469 F3 cell-union cache (dev-only prototype) ──────────
  /** See `RVMovingUnit._accumSpanKey` — identical contract for pooled instances. */
  _accumSpanKey = -1;
  _accumCacheTick = -1;

  /** Which transport surface is currently moving this MU (null = free) */
  currentSurface: RVTransportSurface | null = null;

  /** Same settle state as clone MUs (pool positions are world-space). */
  settleSpeed = 0;
  settleSurface: RVTransportSurface | null = null;

  /** See `RVMovingUnit.lastSurface`. */
  lastSurface?: RVTransportSurface | null;

  /** Marked for removal by Sink */
  markedForRemoval = false;

  /** See `RVMovingUnit.blocked`. */
  blocked = false;
  /** Diagnostic accumulation blocker, in the engine-wide MU id space. */
  blockedBy: number | null = null;

  /** See `RVMovingUnit.physicsOwned` (plan-276 F4, plan-661 compat view). */
  get physicsOwned(): boolean { return this.owner !== 'transport'; }
  set physicsOwned(v: boolean) { this.owner = v ? 'rapier' : 'transport'; }

  /** See `RVMovingUnit.owner` (plan-661). */
  owner: MuOwner = 'transport';

  /** See `RVMovingUnit.physicsBodyId`. */
  physicsBodyId: string | null = null;

  /** See `RVMovingUnit.physicsMassKg` (plan-467 F16). */
  physicsMassKg?: number;

  /** See `RVMovingUnit.lastSurfaceTickId`. */
  lastSurfaceTickId?: number;

  /** See `RVMovingUnit.everOnSurface`. */
  everOnSurface?: boolean;

  /** See `RVMovingUnit.onLayoutObject`. */
  onLayoutObject?: boolean;

  /** See `RVMovingUnit.offSurfaceTime`. */
  offSurfaceTime?: number;

  /** See `RVMovingUnit.unsupportedTime` (plan-2022). */
  unsupportedTime?: number;
  /** See `RVMovingUnit.wasCarried`. */
  wasCarried?: boolean;
  /** See `RVMovingUnit.supportProbeAt`. */
  supportProbeAt?: number;
  /** See `RVMovingUnit.supported`. */
  supported?: boolean;

  /** Pool that owns this instance */
  private pool: MUInstancePool;

  /** Current slot index in the pool (mutable — changes on swap-and-pop) */
  slotIndex: number;

  /** Stable unique ID for this MU instance */
  readonly muId: string;

  /** Stable engine-wide numeric MU id (script SDK `mu.id` id space) — the
   *  numeric bridge to the string `muId` (plan-259 Phase 2). */
  readonly id = nextEngineMuId();

  /** Template name for display */
  private templateName: string;

  constructor(
    pool: MUInstancePool,
    slotIndex: number,
    muId: string,
    templateName: string,
    sourceName: string,
    halfSize: Vector3,
    localCenter?: Vector3,
    detectHalf?: Vector3,
    detectCenter?: Vector3,
    detectParts?: readonly DetectPartSpec[],
  ) {
    this.pool = pool;
    this.slotIndex = slotIndex;
    this.muId = muId;
    this.templateName = templateName;
    this._node = pool.instancedMesh;
    this.sourceName = sourceName;

    // Create AABB with position callback backed by pool
    this.aabb = AABB.fromPositionFn(
      (out: Vector3) => this.getWorldPosition(out),
      halfSize,
      localCenter,
    );
    this._localHalf = halfSize.clone();
    if (detectHalf) {
      this.detectAabb = AABB.fromPositionFn((out: Vector3) => this.getWorldPosition(out), detectHalf, detectCenter);
      this._detectLocalHalf = detectHalf.clone();
      this.detectMargin = (detectCenter ?? _zeroVec).distanceTo(localCenter ?? _zeroVec) + detectHalf.length();
    } else {
      this.detectAabb = this.aabb;
      this._detectLocalHalf = null;
      this.detectMargin = 0;
    }
    if (detectHalf && detectParts && detectParts.length > 1) {
      this.detectParts = detectParts.map((p) => AABB.fromPositionFn((out: Vector3) => this.getWorldPosition(out), p.half, p.center));
      this._detectPartHalves = detectParts.map((p) => p.half.clone());
    } else {
      this.detectParts = null;
      this._detectPartHalves = [];
    }
    // plan-2016 S7: the same layers a clone of the template gets
    // (`RVMovingUnit.setDetectionParts`) — shared arrays, never mutated.
    this.layer = pool.layer;
    const layers = pool.detectPartLayers;
    this.detectPartLayers = this.detectParts && layers && layers.length === this.detectParts.length ? layers : null;
    this.detectLayer = !this.detectParts && layers && layers.length === 1 ? layers[0] : pool.layer;
  }

  /** MU half-extents in its own local frame (see RVMovingUnit._localHalf). */
  private readonly _localHalf: Vector3;
  /** Local half-extents of a separate detection box (null = shares `aabb`). */
  private readonly _detectLocalHalf: Vector3 | null;

  /** See `RVMovingUnit.detectHalf`. */
  detectHalf(i: number): Vector3 {
    if (i >= 0) return this._detectPartHalves[i];
    return this._detectLocalHalf ?? this._localHalf;
  }

  /** See `RVMovingUnit.detectQuaternion` — the pool stores world rotations. */
  detectQuaternion(out: Quaternion): Quaternion {
    return out.copy(this.getQuaternion());
  }

  /** The pool's per-part OBB for detection part `i` (`i < 0`: a single collider). */
  private obbOf(i: number): DetectPartObb | null {
    const obbs = this.pool.detectObbs;
    if (!obbs || !this._detectLocalHalf) return null;
    if (i >= 0) return this.detectParts && i < obbs.length ? obbs[i] : null;
    return !this.detectParts && obbs.length === 1 ? obbs[0] : null;
  }

  /** See `RVMovingUnit.detectObbHalf`. */
  detectObbHalf(i: number): Vector3 {
    return this.obbOf(i)?.half ?? this.detectHalf(i);
  }

  /** See `RVMovingUnit.detectObbRotation`. */
  detectObbRotation(i: number): Quaternion | null {
    return this.obbOf(i)?.rot ?? null;
  }

  /** See `RVMovingUnit.detectColliderKey` — a pooled instance has no collider
   *  nodes: the instance itself, with {@link detectColliderSub} naming the collider. */
  detectColliderKey(_i: number): unknown {
    return this;
  }

  /** See `RVMovingUnit.detectColliderSub` — the pool's stable id of the template
   *  collider behind part `i` (one id per template node + collider index, so the
   *  render primitives of one MeshCollider share it); -1 = mesh box. */
  detectColliderSub(i: number): number {
    const ids = this.pool.detectColliderIds;
    if (!ids || !this._detectLocalHalf) return -1;
    if (i >= 0) return this.detectParts && i < ids.length ? ids[i] : -1;
    return !this.detectParts && ids.length === 1 ? ids[0] : -1;
  }

  /** @internal Called by MUInstancePool._grow() to update the backing mesh after pool resize. */
  _updateNode(mesh: InstancedMesh): void {
    this._node = mesh;
  }

  // ─── IMUAccessor implementation (instanced mode) ────────────────

  getWorldPosition(out: Vector3): Vector3 {
    // For root-parented InstancedMesh, pool positions are already in world space
    const idx = this.slotIndex;
    const p = this.pool.positions;
    return out.set(p[idx * 3], p[idx * 3 + 1], p[idx * 3 + 2]);
  }

  getPosition(): Vector3 {
    // Return a copy from the pool's parallel array (caller may mutate)
    const idx = this.slotIndex;
    const p = this.pool.positions;
    return _tmpPos.set(p[idx * 3], p[idx * 3 + 1], p[idx * 3 + 2]);
  }

  setPosition(v: Vector3): void {
    const idx = this.slotIndex;
    const p = this.pool.positions;
    p[idx * 3] = v.x;
    p[idx * 3 + 1] = v.y;
    p[idx * 3 + 2] = v.z;
    this.pool.markDirty();
  }

  getQuaternion(): Quaternion {
    const idx = this.slotIndex;
    const q = this.pool.quaternions;
    return _tmpQuat.set(q[idx * 4], q[idx * 4 + 1], q[idx * 4 + 2], q[idx * 4 + 3]);
  }

  setQuaternion(quat: Quaternion): void {
    const idx = this.slotIndex;
    const q = this.pool.quaternions;
    q[idx * 4] = quat.x;
    q[idx * 4 + 1] = quat.y;
    q[idx * 4 + 2] = quat.z;
    q[idx * 4 + 3] = quat.w;
    this.pool.markDirty();
  }

  rotateOnAxis(axis: Vector3, angle: number): void {
    // Get current quaternion, apply rotation, write back
    const q = this.getQuaternion().clone();
    _tmpQuat.setFromAxisAngle(axis, angle);
    q.premultiply(_tmpQuat);
    this.setQuaternion(q);
  }

  getName(): string {
    return `${this.templateName}#${this.slotIndex}`;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  // ── plan-473 F2: rotated-half-extent cache ──────────────────────
  /** The four quaternion components the cached half-extent was derived from,
   *  plus the slot they were read from. Compared BY VALUE on every tick — not a
   *  dirty flag set in {@link setQuaternion}, because the pool's quaternion
   *  array is also written directly (compute path, DES tween, multiuser
   *  follower) and a setter flag would miss exactly those writes. */
  private _aabbQx = 0;
  private _aabbQy = 0;
  private _aabbQz = 0;
  private _aabbQw = 0;
  /** Slot the cached values were read from; a swap-and-pop moves an MU to a
   *  different slot, whose quaternion is a different four numbers. Comparing it
   *  discards the cache on a slot change without needing a hook in the pool. */
  private _aabbSlot = -1;
  /** Starts INVALID — the first `updateAABB()` of an MU always recomputes. */
  private _aabbCacheValid = false;

  updateAABB(): void {
    // Pool quaternions are stored in WORLD space (instances are root-parented),
    // so the per-instance quaternion is the world rotation directly. Re-derive the
    // world axis-aligned extent so a rotated part is detected at the right point.
    //
    // plan-473 F2: the rotated extent is a pure function of (localHalf,
    // quaternion), and an MU on a straight belt keeps its orientation for its
    // whole life — so the 3x3 rotation build plus nine abs-multiplies run only
    // when the stored orientation actually changed. `aabb.update()` (the
    // position refresh) still runs every tick, unchanged.
    const idx = this.slotIndex;
    const q = this.pool.quaternions;
    const o = idx * 4;
    const qx = q[o], qy = q[o + 1], qz = q[o + 2], qw = q[o + 3];
    if (
      rvProtoFlags.refAabb
      || !this._aabbCacheValid
      || idx !== this._aabbSlot
      || qx !== this._aabbQx || qy !== this._aabbQy || qz !== this._aabbQz || qw !== this._aabbQw
    ) {
      this.aabb.setHalfSizeFromRotatedExtents(this._localHalf, this.getQuaternion());
      if (this._detectLocalHalf) this.detectAabb.setHalfSizeFromRotatedExtents(this._detectLocalHalf, this.getQuaternion());
      if (this.detectParts) {
        const q = this.getQuaternion();
        for (let i = 0; i < this.detectParts.length; i++) this.detectParts[i].setHalfSizeFromRotatedExtents(this._detectPartHalves[i], q);
      }
      this._aabbQx = qx; this._aabbQy = qy; this._aabbQz = qz; this._aabbQw = qw;
      this._aabbSlot = idx;
      this._aabbCacheValid = true;
      if (import.meta.env.DEV) rvAabbCacheStats.recompute++;
    } else if (import.meta.env.DEV) {
      rvAabbCacheStats.skip++;
    }
    this.aabb.update();
    if (this._detectLocalHalf) this.detectAabb.update();
    if (this.detectParts) for (let i = 0; i < this.detectParts.length; i++) this.detectParts[i].update();
  }

  dispose(): void {
    // Release slot back to pool (swap-and-pop)
    this.pool.release(this);
  }
}

// ─── MUInstancePool ──────────────────────────────────────────────────────

const DEFAULT_MAX_INSTANCES = 128;

/**
 * MUInstancePool — Manages one InstancedMesh per MU template.
 *
 * Pre-allocates maxInstances with DynamicDrawUsage. Uses swap-and-pop
 * for O(1) spawn and consume. Parallel Float32Arrays store per-instance
 * positions (3 floats) and quaternions (4 floats).
 *
 * Bidirectional index mapping: slotIndex <-> InstancedMovingUnit
 */
export class MUInstancePool {
  /** Capacity multiplier used when the pool is exhausted. */
  growthFactor = 2;
  /** The Three.js InstancedMesh (added to scene by caller) */
  instancedMesh: InstancedMesh;

  /** Parallel position array: [x0, y0, z0, x1, y1, z1, ...] */
  positions: Float32Array;

  /** Parallel quaternion array: [x0, y0, z0, w0, x1, y1, z1, w1, ...] */
  quaternions: Float32Array;

  /** Current number of active instances */
  activeCount = 0;

  /** Maximum allocated slots */
  maxInstances: number;

  /** Template name (for debug/display) */
  readonly templateName: string;

  /** Cached half-size from template */
  readonly halfSize: Vector3;
  readonly localCenter: Vector3 | undefined;

  /** Sensor detection box of every instance (the template's authored BoxCollider,
   *  plan-2016 S5 fix); unset = sensors use the mesh box. Set before the first spawn. */
  detectHalf: Vector3 | undefined;
  detectCenter: Vector3 | undefined;
  /** The single collider boxes behind `detectHalf`/`detectCenter` (plan-2016 S5 Codex fix). */
  detectParts: DetectPartSpec[] | undefined;
  /** Unity layer of the template root (plan-2016 S7) — every instance reports it as
   *  its `layer`, like a clone's stash; -1 = unknown. Set before the first spawn. */
  layer = -1;
  /** Unity layer of each template collider box behind the detection box (one entry
   *  per collider, also for a single one); undefined = unknown. Set before the first spawn. */
  detectPartLayers: number[] | undefined;
  /** Exact oriented box of each template collider part (one entry per part, also
   *  for a single one; plan-2016 Codex review); undefined = unknown. Set before the first spawn. */
  detectObbs: DetectPartObb[] | undefined;
  /** Stable collider id of each part — equal for parts of the same template node
   *  and collider index (plan-2016 Codex review). Set before the first spawn. */
  detectColliderIds: number[] | undefined;

  /** True when the geometry is a private baked copy (plan-2016 S6) disposed with the pool. */
  ownsGeometry = false;

  /** slotIndex -> InstancedMovingUnit (null for free slots) */
  private slotToMU: (InstancedMovingUnit | null)[];

  /** Whether instance matrix needs to be recomposed from parallel arrays */
  private _dirty = false;

  /** Callback invoked when an MU is released (for external cleanup, e.g. highlight) */
  onRelease?: (mu: InstancedMovingUnit) => void;

  /** Callback invoked when the InstancedMesh is replaced during pool growth.
   *  Used by RaycastManager to update its target list. */
  onMeshChanged?: (oldMesh: InstancedMesh, newMesh: InstancedMesh) => void;

  // ── GPU compute path (plan-271 Phase 4 SPIKE — opt-in, real WebGPU only) ──
  /** Per-pool compute handle (created lazily on the first compute-path
   *  frame from the pre-warmed TSL module; null on the CPU default path). */
  private _compute: MuComputeTransforms | null = null;
  /** Latched after a compute-path failure — the pool then stays on the CPU
   *  path for its lifetime (fail-safe, warned once). */
  private _computeFailed = false;
  /** True while the GPU holds fresher matrices than the CPU-side
   *  `instanceMatrix.array` mirror (raycast syncs lazily, see below). */
  private _cpuMatricesStale = false;

  constructor(
    geometry: BufferGeometry,
    material: Material | Material[],
    templateName: string,
    halfSize: Vector3,
    localCenter?: Vector3,
    maxInstances = DEFAULT_MAX_INSTANCES,
  ) {
    this.templateName = templateName;
    this.halfSize = halfSize.clone();
    this.localCenter = localCenter?.clone();
    this.maxInstances = maxInstances;

    // Create InstancedMesh. A material ARRAY is kept when the geometry carries
    // groups — three.js draws one group per material on an InstancedMesh just
    // like on a Mesh, which is what lets a multi-part template (a loaded pallet:
    // wooden board + carton boxes, merged into one geometry with two groups)
    // take the instanced path without losing a material. Collapsing to
    // `material[0]` here painted every part with the first material
    // (plan-492 Phase 6, 2026-09-25). An array without groups is meaningless
    // and still collapses.
    const mat = Array.isArray(material)
      ? (geometry.groups.length > 0 ? material : material[0])
      : material;
    this.instancedMesh = new InstancedMesh(geometry, mat, maxInstances);
    this.instancedMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.instancedMesh.count = 0; // Start with no visible instances
    this.instancedMesh.frustumCulled = true; // Per-pool frustum culling via computed bounding sphere
    // Shadows: opaque pools cast (per material alpha), all receive — matches
    // the static-scene policy so spawned MUs cast/receive like everything else.
    // No extra shadow-map dirtying needed: the sim loop already sets
    // _shadowsDirty on MU movement (transport drive isRunning) and spawn/despawn.
    this.instancedMesh.castShadow = classifyShadows(this.instancedMesh as unknown as Mesh);
    this.instancedMesh.receiveShadow = true;
    this.instancedMesh.name = `__muPool_${templateName}`;
    // Tag for raycast manager identification
    this.instancedMesh.userData._muPool = this;

    // Allocate parallel arrays
    this.positions = new Float32Array(maxInstances * 3);
    this.quaternions = new Float32Array(maxInstances * 4);
    // Init quaternions to identity (w=1)
    for (let i = 0; i < maxInstances; i++) {
      this.quaternions[i * 4 + 3] = 1;
    }

    // Slot map
    this.slotToMU = new Array(maxInstances).fill(null);
  }

  /** Spawn a new instance at the given world position. Returns the InstancedMovingUnit. */
  spawn(
    worldPos: Vector3,
    quat: Quaternion,
    muId: string,
    sourceName: string,
  ): InstancedMovingUnit {
    if (this.activeCount >= this.maxInstances) {
      this._grow();
    }

    const slot = this.activeCount;
    this.activeCount++;
    this.instancedMesh.count = this.activeCount;
    if (this.activeCount > 0) this.instancedMesh.visible = true;

    // Write position
    this.positions[slot * 3] = worldPos.x;
    this.positions[slot * 3 + 1] = worldPos.y;
    this.positions[slot * 3 + 2] = worldPos.z;

    // Write quaternion
    this.quaternions[slot * 4] = quat.x;
    this.quaternions[slot * 4 + 1] = quat.y;
    this.quaternions[slot * 4 + 2] = quat.z;
    this.quaternions[slot * 4 + 3] = quat.w;

    // Compose and write matrix
    _tmpMat4.compose(worldPos, quat, _oneVec);
    this.instancedMesh.setMatrixAt(slot, _tmpMat4);
    this._dirty = true;
    // plan-2016 S6: keep the culling sphere valid NOW — the per-frame refresh in
    // `updateInstanceMatrix` only runs on a transport tick, and a sphere three.js
    // computed lazily before this spawn would cull the new instance until then.
    _spawnSphere.center.copy(worldPos);
    _spawnSphere.radius = poolGeometryOriginRadius(this.instancedMesh.geometry);
    if (this.instancedMesh.boundingSphere && slot > 0) this.instancedMesh.boundingSphere.union(_spawnSphere);
    else this.instancedMesh.boundingSphere = _spawnSphere.clone();

    // Create MU wrapper
    const mu = new InstancedMovingUnit(
      this, slot, muId, this.templateName, sourceName, this.halfSize, this.localCenter,
      this.detectHalf, this.detectCenter, this.detectParts,
    );
    this.slotToMU[slot] = mu;

    return mu;
  }

  /**
   * Release an instance (swap-and-pop).
   *
   * The slot of the released MU is filled with the data from the
   * last active slot. The moved MU's slotIndex is updated atomically.
   *
   * CRITICAL correctness path — must update all bidirectional maps.
   */
  release(mu: InstancedMovingUnit): void {
    const slot = mu.slotIndex;
    if (slot < 0 || slot >= this.activeCount) return;

    // Fire release callback (for highlight cleanup, physics remap, etc.)
    this.onRelease?.(mu);

    const lastSlot = this.activeCount - 1;

    if (slot !== lastSlot) {
      // Swap: copy last active slot data into the released slot
      // Position
      this.positions[slot * 3] = this.positions[lastSlot * 3];
      this.positions[slot * 3 + 1] = this.positions[lastSlot * 3 + 1];
      this.positions[slot * 3 + 2] = this.positions[lastSlot * 3 + 2];

      // Quaternion
      this.quaternions[slot * 4] = this.quaternions[lastSlot * 4];
      this.quaternions[slot * 4 + 1] = this.quaternions[lastSlot * 4 + 1];
      this.quaternions[slot * 4 + 2] = this.quaternions[lastSlot * 4 + 2];
      this.quaternions[slot * 4 + 3] = this.quaternions[lastSlot * 4 + 3];

      // Copy instance matrix
      this.instancedMesh.getMatrixAt(lastSlot, _tmpMat4);
      this.instancedMesh.setMatrixAt(slot, _tmpMat4);

      // Update the moved MU's slot index. Its AABB position callback (set once
      // at spawn) reads `slotIndex` at call time, so no re-registration needed.
      const movedMU = this.slotToMU[lastSlot]!;
      movedMU.slotIndex = slot;
      this.slotToMU[slot] = movedMU;
    }

    // Clear last slot
    this.slotToMU[lastSlot] = null;

    // Clear the released MU's slot index (invalidate)
    mu.slotIndex = -1;

    this.activeCount--;
    this.instancedMesh.count = this.activeCount;
    if (this.activeCount === 0) this.instancedMesh.visible = false;
    this._dirty = true;
  }

  /** Get the MU at a given slot index (for raycast hit resolution) */
  getMUAtSlot(slotIndex: number): InstancedMovingUnit | null {
    if (slotIndex < 0 || slotIndex >= this.activeCount) return null;
    return this.slotToMU[slotIndex];
  }

  /** Mark instance matrix as needing update */
  markDirty(): void {
    this._dirty = true;
  }

  /**
   * Recompose all instance matrices from parallel arrays.
   * Call once per frame after all transport/physics updates.
   *
   * `computeRenderer` (plan-271 Phase 4 spike): when a real-WebGPU renderer is
   * passed (opt-in, wired through `RVTransportManager.muComputeRenderer`), the
   * compose loop runs as a GPU compute kernel instead — the CPU
   * positions/quaternions arrays stay the single source of truth, only the
   * matrix composition moves to the GPU. Omitted/undefined = CPU path
   * (unchanged default).
   */
  updateInstanceMatrix(computeRenderer?: unknown): void {
    if (!this._dirty) return;

    if (computeRenderer !== undefined && computeRenderer !== null
      && !this._computeFailed && this._tryComputePath(computeRenderer)) {
      this._dirty = false;
      // Bounding sphere stays CPU-side from the truth arrays — NO GPU readback
      // in the frame path (plan-271 §5.2).
      this._updateBoundingSphere();
      return;
    }

    // plan-469 F5 prototype: carry the extents in the compose loop that already
    // touches every position, so the separate O(N) `_updateBoundingSphere()`
    // pass disappears. Conservative by construction — the min/max are the REAL
    // composed positions, so teleports, moving platforms, lateral centring and
    // spawn/release are all covered without any velocity assumption.
    const bounds = rvProtoFlags.poolBounds && this.activeCount > 0;
    let miX = Infinity, miY = Infinity, miZ = Infinity;
    let maX = -Infinity, maY = -Infinity, maZ = -Infinity;

    for (let i = 0; i < this.activeCount; i++) {
      const px = this.positions[i * 3];
      const py = this.positions[i * 3 + 1];
      const pz = this.positions[i * 3 + 2];
      _tmpPos.set(px, py, pz);
      _tmpQuat.set(this.quaternions[i * 4], this.quaternions[i * 4 + 1], this.quaternions[i * 4 + 2], this.quaternions[i * 4 + 3]);
      _tmpMat4.compose(_tmpPos, _tmpQuat, _oneVec);
      this.instancedMesh.setMatrixAt(i, _tmpMat4);
      if (bounds) {
        if (px < miX) miX = px; if (px > maX) maX = px;
        if (py < miY) miY = py; if (py > maY) maY = py;
        if (pz < miZ) miZ = pz; if (pz > maZ) maZ = pz;
      }
    }

    const instanceMatrix = this.instancedMesh.instanceMatrix;
    instanceMatrix.clearUpdateRanges();
    instanceMatrix.addUpdateRange(0, this.activeCount * 16);
    instanceMatrix.needsUpdate = true;
    this._cpuMatricesStale = false;
    this._dirty = false;

    if (bounds) {
      this._setBoundingSphereFromBox(miX, miY, miZ, maX, maY, maZ);
      return;
    }

    // Recompute bounding sphere to cover all active instances for frustum culling.
    // Uses positions array directly (O(n) but n = activeCount, typically small).
    this._updateBoundingSphere();
  }

  /** plan-469 F5: sphere around the axis-aligned box of the composed positions.
   *  Centre = box centre, radius = half the box diagonal + the geometry radius.
   *  Up to sqrt(3)x larger than the centroid radius (SOL R2#5); since the sphere
   *  only drives frustum culling of the whole pool, a larger radius can at worst
   *  cull LATER — never make instances disappear. */
  private _setBoundingSphereFromBox(
    miX: number, miY: number, miZ: number,
    maX: number, maY: number, maZ: number,
  ): void {
    const geoRadius = poolGeometryOriginRadius(this.instancedMesh.geometry);
    const hx = (maX - miX) / 2, hy = (maY - miY) / 2, hz = (maZ - miZ) / 2;
    const sphere = this.instancedMesh.boundingSphere ?? new Sphere();
    sphere.center.set(miX + hx, miY + hy, miZ + hz);
    sphere.radius = Math.sqrt(hx * hx + hy * hy + hz * hz) + geoRadius;
    this.instancedMesh.boundingSphere = sphere;
  }

  // ── GPU compute path internals (plan-271 Phase 4 SPIKE) ──────────────

  /** Run one compute-path frame. Returns false (and latches the fail flag)
   *  when the TSL module is unavailable or the dispatch throws — the caller
   *  then falls through to the unchanged CPU loop. */
  private _tryComputePath(renderer: unknown): boolean {
    try {
      if (!this._compute) {
        const tsl = getTslMaterials();
        if (!tsl || typeof tsl.createMuComputeTransforms !== 'function') {
          this._computeFailed = true;
          console.warn(`[MUInstancePool] "${this.templateName}": compute path requested but the TSL module is not pre-warmed — staying on the CPU path.`);
          return false;
        }
        this._compute = tsl.createMuComputeTransforms(this.maxInstances);
      }
      // No-op unless the pool grew (`_grow()` also calls this eagerly with
      // the explicit old-buffer dispose, see there).
      this._compute.ensureCapacity(this.maxInstances);
      this._compute.writeFrom(this.positions, this.quaternions, this.activeCount);
      this._compute.computeAndApply(renderer, this.instancedMesh);
      this._cpuMatricesStale = true;
      this._installRaycastSync();
      return true;
    } catch (err) {
      console.warn(`[MUInstancePool] "${this.templateName}": GPU compute path failed — falling back to the CPU path permanently for this pool:`, err);
      this._computeFailed = true;
      try {
        this._compute?.dispose(); // detaches + destroys buffers
      } catch { /* best effort */ }
      this._compute = null;
      return false;
    }
  }

  /** Wrap `mesh.raycast` so three's `getMatrixAt`-based InstancedMesh
   *  raycasting keeps working under the compute path: the CPU
   *  `instanceMatrix.array` mirror is recomposed lazily from the truth arrays
   *  ONLY when a ray actually tests this mesh (throttled pointer moves) — the
   *  frame path itself never pays for it. Installed once per mesh (re-applied
   *  automatically after a `_grow()` mesh swap). */
  private _installRaycastSync(): void {
    const mesh = this.instancedMesh as InstancedMesh & { __rvComputeRaycastSync?: boolean };
    if (mesh.__rvComputeRaycastSync) return;
    mesh.__rvComputeRaycastSync = true;
    const base = mesh.raycast.bind(mesh);
    mesh.raycast = (raycaster, intersects) => {
      this._syncCpuMatricesForRaycast();
      base(raycaster, intersects);
    };
  }

  /** Recompose the CPU-side matrix mirror from positions/quaternions (no
   *  `needsUpdate` — the GPU already holds the composed matrices). */
  private _syncCpuMatricesForRaycast(): void {
    if (!this._cpuMatricesStale) return;
    for (let i = 0; i < this.activeCount; i++) {
      _tmpPos.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
      _tmpQuat.set(this.quaternions[i * 4], this.quaternions[i * 4 + 1], this.quaternions[i * 4 + 2], this.quaternions[i * 4 + 3]);
      _tmpMat4.compose(_tmpPos, _tmpQuat, _oneVec);
      this.instancedMesh.setMatrixAt(i, _tmpMat4);
    }
    this._cpuMatricesStale = false;
  }

  /** Compute a bounding sphere encompassing all active instance positions + geometry radius. */
  private _updateBoundingSphere(): void {
    if (this.activeCount === 0) return;

    // Compute centroid of all active positions
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < this.activeCount; i++) {
      cx += this.positions[i * 3];
      cy += this.positions[i * 3 + 1];
      cz += this.positions[i * 3 + 2];
    }
    cx /= this.activeCount;
    cy /= this.activeCount;
    cz /= this.activeCount;

    // Find max distance from centroid
    let maxDistSq = 0;
    for (let i = 0; i < this.activeCount; i++) {
      const dx = this.positions[i * 3] - cx;
      const dy = this.positions[i * 3 + 1] - cy;
      const dz = this.positions[i * 3 + 2] - cz;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > maxDistSq) maxDistSq = distSq;
    }

    // Add geometry's own bounding sphere radius
    const geoRadius = poolGeometryOriginRadius(this.instancedMesh.geometry);

    const sphere = this.instancedMesh.boundingSphere ?? new Sphere();
    sphere.center.set(cx, cy, cz);
    sphere.radius = Math.sqrt(maxDistSq) + geoRadius;
    this.instancedMesh.boundingSphere = sphere;
  }

  /** Grow pool by 2x when exhausted */
  private _grow(): void {
    const growT0 = performance.now();
    muPoolGrowth.count++;
    try {
      this._growInner();
    } finally {
      muPoolGrowth.ms += performance.now() - growT0;
    }
  }

  private _growInner(): void {
    const oldMax = this.maxInstances;
    const newMax = Math.max(oldMax + 1, Math.ceil(oldMax * this.growthFactor));
    console.warn(`[MUInstancePool] "${this.templateName}" pool exhausted (${oldMax}), growing to ${newMax}`);

    // Create new larger InstancedMesh
    const newMesh = new InstancedMesh(
      this.instancedMesh.geometry,
      this.instancedMesh.material,
      newMax,
    );
    newMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    newMesh.count = this.activeCount;
    newMesh.frustumCulled = true;
    newMesh.castShadow = this.instancedMesh.castShadow; // preserve across the swap
    newMesh.receiveShadow = this.instancedMesh.receiveShadow;
    newMesh.name = this.instancedMesh.name;
    newMesh.userData._muPool = this;
    // Carry the culling sphere across the swap (plan-2016 S6) — `spawn()` unions into it.
    if (this.instancedMesh.boundingSphere) newMesh.boundingSphere = this.instancedMesh.boundingSphere.clone();

    // Copy existing matrices
    for (let i = 0; i < this.activeCount; i++) {
      this.instancedMesh.getMatrixAt(i, _tmpMat4);
      newMesh.setMatrixAt(i, _tmpMat4);
    }

    // Copy position/quat arrays
    const newPositions = new Float32Array(newMax * 3);
    newPositions.set(this.positions);
    const newQuaternions = new Float32Array(newMax * 4);
    newQuaternions.set(this.quaternions);
    // Init new quaternion slots to identity
    for (let i = oldMax; i < newMax; i++) {
      newQuaternions[i * 4 + 3] = 1;
    }

    // Extend slot map
    const newSlotToMU = new Array<InstancedMovingUnit | null>(newMax).fill(null);
    for (let i = 0; i < oldMax; i++) {
      newSlotToMU[i] = this.slotToMU[i];
    }

    // Replace old mesh in scene
    const parent = this.instancedMesh.parent;
    if (parent) {
      parent.remove(this.instancedMesh);
      parent.add(newMesh);
    }

    // Update all existing MU references to new mesh
    for (let i = 0; i < this.activeCount; i++) {
      const mu = newSlotToMU[i];
      if (mu) {
        mu._updateNode(newMesh);
      }
    }

    // Notify raycast manager before swapping (needs old ref)
    const oldMesh = this.instancedMesh;

    // Swap references
    this.instancedMesh = newMesh;
    this.positions = newPositions;
    this.quaternions = newQuaternions;
    this.slotToMU = newSlotToMU;
    this.maxInstances = newMax;
    this._dirty = true;

    // Compute path (plan-271 Phase 4): grow the storage buffers now —
    // `ensureCapacity` EXPLICITLY disposes the replaced GPU buffers (unlike
    // the CPU arrays above, dropping the references would leak GPUBuffers).
    // The new mesh is (re-)attached + raycast-wrapped on the next compute
    // frame (`_tryComputePath`), before it is ever rendered.
    if (this._compute) {
      try {
        this._compute.ensureCapacity(newMax);
      } catch (err) {
        console.warn(`[MUInstancePool] "${this.templateName}": compute buffer growth failed — CPU fallback:`, err);
        this._computeFailed = true;
        try {
          this._compute.dispose();
        } catch { /* best effort */ }
        this._compute = null;
      }
    }

    // Notify external listeners (e.g. RaycastManager) about mesh replacement
    this.onMeshChanged?.(oldMesh, newMesh);
  }

  /** Dispose pool and release GPU resources */
  dispose(): void {
    if (this.instancedMesh.parent) {
      this.instancedMesh.parent.remove(this.instancedMesh);
    }
    // Compute-path storage buffers are POOL-SPECIFIC GPU resources — dispose
    // them explicitly (plan-271 finding 14). This is deliberately different
    // from geometry/material below, which are template-shared.
    if (this._compute) {
      try {
        this._compute.dispose();
      } catch { /* best effort */ }
      this._compute = null;
    }
    // Don't dispose geometry/material — shared with template (unless the pool
    // owns a baked copy, plan-2016 S6)
    if (this.ownsGeometry) this.instancedMesh.geometry.dispose();
    this.activeCount = 0;
    this.slotToMU.fill(null);
  }
}

// Unit scale vector (shared, never modified)
const _oneVec = new Vector3(1, 1, 1);
const _analyzeRel = new Matrix4();
const _spawnSphere = new Sphere();

function isIdentityMatrix(m: Matrix4, eps = 1e-6): boolean {
  const e = m.elements;
  for (let i = 0; i < 16; i++) {
    const want = (i % 5 === 0) ? 1 : 0;
    if (Math.abs(e[i] - want) > eps) return false;
  }
  return true;
}

/** Radius of a sphere about the instance ORIGIN that encloses the pool geometry.
 *  The geometry's own bounding sphere is centred on its centre, which is not the
 *  instance origin once a child offset is baked in (plan-2016 S6). */
function poolGeometryOriginRadius(geo: BufferGeometry): number {
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  const bs = geo.boundingSphere;
  return bs ? bs.center.length() + bs.radius : 0;
}

/**
 * Analyze a template node to determine if it can use InstancedMesh.
 * Single-mesh templates (one Mesh child, or the node itself is a Mesh)
 * can use instancing. Multi-mesh templates fall back to clone().
 *
 * Returns the geometry + material for instancing, or null for clone fallback.
 */
export function analyzeTemplate(template: Object3D): {
  geometry: BufferGeometry;
  material: Material | Material[];
  /** True when `geometry` is a private copy (child transform baked in) that the
   *  pool owns and must dispose; false = the template's shared geometry. */
  ownsGeometry: boolean;
} | null {
  // plan-2016 S5 fix: a template with switchable geometry (an authored-inactive
  // node, or a group variant below the root = a MUSwitcher target) needs a real
  // node subtree per MU; one InstancedMesh can neither hide nor switch a part.
  if (hasInactiveDescendant(template)) return null;
  let hasVariant = false;
  template.traverse((child) => {
    if (!hasVariant && child !== template && groupLabelsOf(child).length > 0) hasVariant = true;
  });
  if (hasVariant) return null;

  // Count mesh children
  let meshCount = 0;
  let firstMesh: InstancedMesh | null = null;

  template.traverse((child) => {
    if ((child as { isMesh?: boolean }).isMesh) {
      meshCount++;
      if (!firstMesh) firstMesh = child as unknown as InstancedMesh;
    }
  });

  // Single mesh -> can instance
  if (meshCount === 1 && firstMesh) {
    const mesh = firstMesh as unknown as Object3D & { geometry: BufferGeometry; material: Material | Material[] };
    // plan-2016 S6: an instance matrix carries only the MU ROOT pose, while the
    // geometry lives in the mesh node's own frame. A mesh below the root with its
    // own rotation/offset (the blow-moulding line FassMU/FassMU_1: rotated 90 deg) would otherwise
    // be drawn lying down and offset. Bake the mesh-relative-to-root transform
    // into a private copy of the geometry — the same frame `computeTemplateAABBInfo`
    // measures halfSize/localCenter in.
    template.updateWorldMatrix(true, true);
    const rel = _analyzeRel.copy(template.matrixWorld).invert().multiply(mesh.matrixWorld);
    if (isIdentityMatrix(rel)) {
      return { geometry: mesh.geometry, material: mesh.material, ownsGeometry: false };
    }
    // A mirroring transform would need flipped winding — keep the clone path.
    if (rel.determinant() < 0) return null;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(rel);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { geometry, material: mesh.material, ownsGeometry: true };
  }

  // Multi-mesh or no mesh -> clone fallback
  return null;
}

// Register schema + capabilities for MU. `LoadSeatDepth` (plan-577) is the
// marker's only consumed field; the schema makes it editable in the inspector.
registerComponentSchema('MU', loadSchemaFromSpec('MU'), {
  pick: 'select',
  bake: 'keep',    // MU templates are cloned/spawned at runtime — never baked
  authorable: true, // plan-516: pre-placed MUs are authored in the asset editor
  ui: { badge: '#78909c' },
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import {
  Object3D, Vector3, Quaternion, Matrix4, Box3, Sphere,
  InstancedMesh, DynamicDrawUsage,
} from 'three';
import type { BufferGeometry, Material } from 'three';
import type { Mesh } from 'three';
import { AABB } from './rv-aabb';
import { classifyShadows } from './rv-mesh-classifier';
import { registerCapabilities } from './rv-component-registry';
import type { RVTransportSurface } from './rv-transport-surface';
import type { MUDissolve, MUGrow } from './rv-mu-dissolve';
import { getTslMaterials } from './materials/material-factory';
import type { MuComputeTransforms } from './materials/rv-mu-compute-tsl';

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
 *  'grip' = RVGrip fix/unfix; 'connection' = typed connection (StopOnExit). */
export type MuHolder = 'grip' | 'connection';

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
   *  cleared by the physics plugin on the settle return (F7). */
  physicsOwned: boolean;
  /** Physics-provider body handle (`String(mu.id)`); null while kinematic.
   *  Read by `IPhysicsMUHook.onMUDisposed` to free the body on any dispose
   *  path (F14) — hence part of the accessor interface. */
  physicsBodyId: string | null;
}

/**
 * RVMovingUnit - A moving unit (part/product) being transported through the system.
 *
 * Created by RVSource, moved by RVTransportSurface, detected by RVSensor, removed by RVSink.
 * Implements IMUAccessor for unified access regardless of rendering backend.
 */
export class RVMovingUnit implements IMUAccessor {
  readonly node: Object3D;
  readonly aabb: AABB;
  readonly sourceName: string;

  /** Which transport surface is currently moving this MU (null = free) */
  currentSurface: RVTransportSurface | null = null;

  /** Most recent surface that drove this MU; survives the MU running off the end
   *  (when `currentSurface` becomes null) so the end-of-line vanish can still
   *  check THAT surface's outgoing-snap connectivity. */
  lastSurface?: RVTransportSurface | null;

  /** Marked for removal by Sink */
  markedForRemoval = false;

  /** True while the accumulation gap clamp (plan-255) shortened this MU's
   *  advance this tick (it is jammed behind another MU). Diagnostic only —
   *  reset to false by the transport manager before each transport step. */
  blocked = false;

  /** Stable engine-wide numeric MU id (script SDK `mu.id` id space). */
  readonly id = nextEngineMuId();

  /** Owner tag (plan-259 O1b): which subsystem currently holds this MU in
   *  place. `'grip'` = attached to an RVGrip; `'connection'` = held by a typed
   *  connection (StopOnExit). Each subsystem only releases what it holds
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

  /** True while the physics provider owns this MU's pose (plan-276 F4).
   *  The kinematic transport loop, accumulation queries and grips skip it. */
  physicsOwned = false;

  /** Physics-provider body handle (`String(this.id)`); null while kinematic. */
  physicsBodyId: string | null = null;

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

  constructor(node: Object3D, sourceName: string, halfSize?: Vector3, localCenter?: Vector3) {
    this.node = node;
    this.sourceName = sourceName;

    if (halfSize) {
      this.aabb = AABB.fromHalfSize(node, halfSize, localCenter);
    } else {
      this.aabb = AABB.fromNode(node);
    }
    this._localHalf = this.aabb.halfSize.clone();
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

  /** Update AABB world position after transport movement. Re-derives the world
   *  axis-aligned extent from the MU's local half-extents under its current world
   *  rotation, so the detection/collision footprint follows the part as it is
   *  turned (e.g. by a turntable) — otherwise a rotated part is detected at the
   *  wrong point (a light-barrier beam breaks ~half-a-part-length off). */
  updateAABB(): void {
    this.node.getWorldQuaternion(_aabbWorldQuat);
    this.aabb.setHalfSizeFromRotatedExtents(this._localHalf, _aabbWorldQuat);
    this.aabb.update();
  }

  /**
   * Dispose this MU - remove from scene and clear references.
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
export function computeTemplateAABBInfo(template: Object3D): TemplateAABBInfo {
  const box = new Box3().setFromObject(template);
  const size = new Vector3();
  box.getSize(size);
  const halfSize = size.multiplyScalar(0.5);
  // localCenter = box center relative to node world position
  const boxCenter = new Vector3();
  box.getCenter(boxCenter);
  const nodePos = new Vector3();
  template.getWorldPosition(nodePos);
  const localCenter = boxCenter.sub(nodePos);
  return { halfSize, localCenter };
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
  readonly sourceName: string;
  readonly isInstanced = true;

  /** Which transport surface is currently moving this MU (null = free) */
  currentSurface: RVTransportSurface | null = null;

  /** See `RVMovingUnit.lastSurface`. */
  lastSurface?: RVTransportSurface | null;

  /** Marked for removal by Sink */
  markedForRemoval = false;

  /** See `RVMovingUnit.blocked`. */
  blocked = false;

  /** See `RVMovingUnit.physicsOwned` (plan-276 F4). */
  physicsOwned = false;

  /** See `RVMovingUnit.physicsBodyId`. */
  physicsBodyId: string | null = null;

  /** See `RVMovingUnit.lastSurfaceTickId`. */
  lastSurfaceTickId?: number;

  /** See `RVMovingUnit.everOnSurface`. */
  everOnSurface?: boolean;

  /** See `RVMovingUnit.onLayoutObject`. */
  onLayoutObject?: boolean;

  /** See `RVMovingUnit.offSurfaceTime`. */
  offSurfaceTime?: number;

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
  }

  /** MU half-extents in its own local frame (see RVMovingUnit._localHalf). */
  private readonly _localHalf: Vector3;

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

  updateAABB(): void {
    // Pool quaternions are stored in WORLD space (instances are root-parented),
    // so the per-instance quaternion is the world rotation directly. Re-derive the
    // world axis-aligned extent so a rotated part is detected at the right point.
    this.aabb.setHalfSizeFromRotatedExtents(this._localHalf, this.getQuaternion());
    this.aabb.update();
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

    // Create InstancedMesh
    const mat = Array.isArray(material) ? material[0] : material;
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

    // Create MU wrapper
    const mu = new InstancedMovingUnit(
      this, slot, muId, this.templateName, sourceName, this.halfSize, this.localCenter,
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

    for (let i = 0; i < this.activeCount; i++) {
      _tmpPos.set(this.positions[i * 3], this.positions[i * 3 + 1], this.positions[i * 3 + 2]);
      _tmpQuat.set(this.quaternions[i * 4], this.quaternions[i * 4 + 1], this.quaternions[i * 4 + 2], this.quaternions[i * 4 + 3]);
      _tmpMat4.compose(_tmpPos, _tmpQuat, _oneVec);
      this.instancedMesh.setMatrixAt(i, _tmpMat4);
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;
    this._cpuMatricesStale = false;
    this._dirty = false;

    // Recompute bounding sphere to cover all active instances for frustum culling.
    // Uses positions array directly (O(n) but n = activeCount, typically small).
    this._updateBoundingSphere();
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
    const geo = this.instancedMesh.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const geoRadius = geo.boundingSphere?.radius ?? 0;

    const sphere = this.instancedMesh.boundingSphere ?? new Sphere();
    sphere.center.set(cx, cy, cz);
    sphere.radius = Math.sqrt(maxDistSq) + geoRadius;
    this.instancedMesh.boundingSphere = sphere;
  }

  /** Grow pool by 2x when exhausted */
  private _grow(): void {
    const oldMax = this.maxInstances;
    const newMax = oldMax * 2;
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
    // Don't dispose geometry/material — shared with template
    this.activeCount = 0;
    this.slotToMU.fill(null);
  }
}

// Unit scale vector (shared, never modified)
const _oneVec = new Vector3(1, 1, 1);

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
} | null {
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
    const mesh = firstMesh as unknown as { geometry: BufferGeometry; material: Material | Material[] };
    return { geometry: mesh.geometry, material: mesh.material };
  }

  // Multi-mesh or no mesh -> clone fallback
  return null;
}

// Register capabilities for MU
registerCapabilities('MU', {
  hoverable: true,
  selectable: true,
  badgeColor: '#78909c',
  hoverEnabledByDefault: true,
  exclusiveHoverGroup: true,
});

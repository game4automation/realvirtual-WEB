// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Vector3, Object3D, Box3, Quaternion, Matrix4 } from 'three';
import { unityPositionToGltf } from './rv-coordinate-utils';

// ── Unit contract of `halfSize` / `localCenter` (plan-653 spike, 2026-10-21) ──
//
// `halfSize` is ALWAYS world units and world-axis-aligned once `update()` ran.
// `localCenter` differs per factory — which is why `update()` alone cannot
// decide whether the node's world SCALE applies to it:
//
//   path                                   halfSize (stored)              localCenter (stored)
//   fromNode (loader; MU fallback)         world (Box3 of world mesh)     node-local, scale INCLUDED (worldToLocal)
//   fromBoxCollider (loader, physics zone) collider size/2, local units   Unity collider centre, node-local units
//   fromHalfSize (MU, synthetic line)      world (caller)                 MU rotation frame in WORLD units
//                                                                         (rv-mu-collider-bounds) or template-local
//   fromPositionFn (instanced MU)          world (caller)                 same frame as the position callback
//   TransportSurface.init()                local extents kept aside       node-local incl. scale (_computeLocalAABB)
//   Sensor (via loader)                    as fromNode / fromBoxCollider  as fromNode / fromBoxCollider
//
// `update()` / `updateFrom()` keep the historical rule: offset rotated by the
// world QUATERNION only. That is exact for the MU paths (world-unit rotation
// frame) and for every unit-scale node. Node-local consumers (TransportSurface,
// Sensor) opt in with `useNodeLocalFrame()`: their centre then goes through the
// full `matrixWorld` (rotation × scale, mirrors included) and, for the surface,
// `setHalfSizeFromNodeExtents()` derives the world extents from |M_ij| of the
// linear 3×3. On a rigid (unit-scale, det > 0) node both opt-ins take the
// historical code path, so their result is bit-identical to before. MU paths
// never opt in — scaling a world-unit offset again would double-scale it.
// Known, out of scope: a meshless fromBoxCollider AABB keeps an unscaled
// halfSize on a scaled node (Sink, collider-only surfaces).

// Module-level scratch — pre-allocated to keep `AABB.update()` GC-free in the
// transport hot path. Each `update()` call is single-threaded so reuse is safe.
const _scratchQuat = new Quaternion();
const _scratchOffset = new Vector3();
const _scratchRotMat = new Matrix4();
const _scratchPos = new Vector3();
const _scratchScale = new Vector3();

/** Tolerance on the squared column lengths for "rigid" (unit scale). */
const RIGID_EPS = 1e-9;

/** True when the linear 3×3 of `e` (column-major) is a proper rotation: unit
 *  column lengths and a positive determinant (no scale, no mirror). */
function isRigid(e: ArrayLike<number>): boolean {
  const cx = e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
  const cy = e[4] * e[4] + e[5] * e[5] + e[6] * e[6];
  const cz = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
  if (Math.abs(cx - 1) > RIGID_EPS || Math.abs(cy - 1) > RIGID_EPS || Math.abs(cz - 1) > RIGID_EPS) return false;
  const det =
    e[0] * (e[5] * e[10] - e[9] * e[6]) -
    e[4] * (e[1] * e[10] - e[9] * e[2]) +
    e[8] * (e[1] * e[6] - e[5] * e[2]);
  return det > 0;
}

/**
 * Pre-allocated Axis-Aligned Bounding Box for fast overlap tests.
 * All vectors are pre-allocated — no GC in hot path.
 *
 * Position source is decoupled via a getPositionFn callback.
 * This allows both Object3D-based (clone) and Float32Array-based (InstancedMesh)
 * position sources to work transparently.
 */
export class AABB {
  readonly center = new Vector3();
  readonly halfSize = new Vector3();
  readonly min = new Vector3();
  readonly max = new Vector3();

  /** Local-space offset from node origin (e.g., BoxCollider center) */
  readonly localCenter = new Vector3();
  /** Reference to the scene node for position updates (legacy, used by static factories) */
  private node: Object3D | null = null;
  /** Callback that provides world position — decouples AABB from Object3D */
  private getPositionFn: ((out: Vector3) => Vector3) | null = null;
  /** plan-653: `localCenter` is in the node's LOCAL frame (scale included) —
   *  `update()` maps it through the full `matrixWorld`. Set via `useNodeLocalFrame()`. */
  private nodeLocalFrame = false;

  /**
   * Create AABB from BoxCollider center/size in GLB extras.
   * glTF negates Unity X-axis, so center.x is flipped.
   */
  static fromBoxCollider(
    node: Object3D,
    center: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
  ): AABB {
    const aabb = new AABB();
    aabb.node = node;
    aabb.getPositionFn = (out: Vector3) => node.getWorldPosition(out);
    // Convert Unity LHS BoxCollider center to glTF RHS space
    aabb.localCenter.copy(unityPositionToGltf(center.x, center.y, center.z));
    aabb.halfSize.set(
      Math.abs(size.x) / 2,
      Math.abs(size.y) / 2,
      Math.abs(size.z) / 2,
    );
    aabb.update();
    return aabb;
  }

  /**
   * Create AABB from mesh bounding box (fallback when no BoxCollider data).
   *
   * `localCenter` is captured in true node-local space (via `worldToLocal`)
   * so `update()` can re-apply the node's current world rotation each tick —
   * the AABB then tracks parent rotations (turntable platforms, planner-rotated
   * library objects) instead of staying at a frozen world-axis offset.
   */
  static fromNode(node: Object3D): AABB {
    const aabb = new AABB();
    aabb.node = node;
    aabb.getPositionFn = (out: Vector3) => node.getWorldPosition(out);
    node.updateMatrixWorld(true);
    const box = new Box3().setFromObject(node);
    const size = new Vector3();
    box.getSize(size);
    aabb.halfSize.copy(size).multiplyScalar(0.5);
    // localCenter = box center in NODE-LOCAL space — re-rotated each update().
    const boxCenter = new Vector3();
    box.getCenter(boxCenter);
    node.worldToLocal(boxCenter); // boxCenter is now in node-local space
    aabb.localCenter.copy(boxCenter);
    // plan-653: the construction-time centre goes through the full world matrix
    // (scale included) — identical to before on a unit-scale node, no longer
    // ~1000× off on a mm-scaled SolidCraft body. The opt-in is NOT kept: MU
    // callers own their tick semantics (see the contract at the top).
    aabb.nodeLocalFrame = true;
    aabb.update();
    aabb.nodeLocalFrame = false;
    return aabb;
  }

  /**
   * Create AABB with explicit half-size (for dynamically spawned MUs).
   * Optional localCenter accounts for meshes not centered on their node origin.
   */
  static fromHalfSize(node: Object3D, halfSize: Vector3, localCenter?: Vector3): AABB {
    const aabb = new AABB();
    aabb.node = node;
    aabb.getPositionFn = (out: Vector3) => node.getWorldPosition(out);
    if (localCenter) {
      aabb.localCenter.copy(localCenter);
    } else {
      aabb.localCenter.set(0, 0, 0);
    }
    aabb.halfSize.copy(halfSize);
    aabb.update();
    return aabb;
  }

  /**
   * Create AABB with explicit half-size and a custom position callback.
   * Used by InstancedMesh MUs where position comes from a parallel Float32Array.
   */
  static fromPositionFn(getPositionFn: (out: Vector3) => Vector3, halfSize: Vector3, localCenter?: Vector3): AABB {
    const aabb = new AABB();
    aabb.getPositionFn = getPositionFn;
    if (localCenter) {
      aabb.localCenter.copy(localCenter);
    } else {
      aabb.localCenter.set(0, 0, 0);
    }
    aabb.halfSize.copy(halfSize);
    aabb.update();
    return aabb;
  }

  /** Update world-space min/max from position source + local offset.
   *
   *  When a backing `node` is available the local-space `localCenter` offset
   *  is rotated by the node's current world quaternion before adding — this
   *  keeps the AABB centered correctly when the parent (e.g. a LayoutObject
   *  rotated by a Drive or the planner) rotates. The AABB itself remains
   *  axis-aligned; only its centre moves on a circle around the parent pivot. */
  update(): void {
    if (this.nodeLocalFrame && this.node && this._updateInNodeFrame(this.node)) return;
    if (this.getPositionFn) {
      this.getPositionFn(this.center);
      if (this.node) {
        // Rotate local offset by the node's current world rotation, then add.
        this.node.getWorldQuaternion(_scratchQuat);
        _scratchOffset.copy(this.localCenter).applyQuaternion(_scratchQuat);
        this.center.add(_scratchOffset);
      } else {
        // No node available (e.g. InstancedMesh position callback) — assume
        // localCenter is already in the same frame as the position.
        this.center.add(this.localCenter);
      }
    } else if (this.node) {
      // Legacy fallback (should not happen with new code)
      this.node.getWorldPosition(this.center);
      this.node.getWorldQuaternion(_scratchQuat);
      _scratchOffset.copy(this.localCenter).applyQuaternion(_scratchQuat);
      this.center.add(_scratchOffset);
    }
    this.min.copy(this.center).sub(this.halfSize);
    this.max.copy(this.center).add(this.halfSize);
  }

  /**
   * plan-469 F4 — the same result as {@link update} for a node-backed AABB, but
   * from an ALREADY decomposed world transform instead of two fresh world walks.
   *
   * `update()` on a clone MU costs `getWorldPosition` + `getWorldQuaternion`,
   * each of which walks the parent chain; together with the walk in
   * `RVMovingUnit.updateAABB` that is three walks per MU per tick. The caller
   * can do ONE `updateWorldMatrix` + one `decompose` and hand both parts here.
   *
   * The `localCenter` semantics are identical to `update()`: the local offset is
   * rotated by the world quaternion and added to the world position.
   */
  updateFrom(position: Vector3, quaternion: Quaternion): void {
    this.center.copy(position);
    _scratchOffset.copy(this.localCenter).applyQuaternion(quaternion);
    this.center.add(_scratchOffset);
    this.min.copy(this.center).sub(this.halfSize);
    this.max.copy(this.center).add(this.halfSize);
  }

  /**
   * Set the world axis-aligned `halfSize` as the TIGHT enclosure of a box with
   * the given LOCAL half-extents rotated by `worldQuat`:
   * `worldHalf_i = Σ_j |R_ij|·localHalf_j`. Lets a moving box (a rotated MU, a
   * spinning turntable belt) keep a collision/detection footprint that matches
   * its current orientation instead of staying frozen at the pose it was built
   * at. At 0°/180° this is identical to `localHalf`; at ±90° it swaps the axes.
   * Call BEFORE `update()` (which derives min/max from `center ± halfSize`).
   */
  setHalfSizeFromRotatedExtents(localHalf: Vector3, worldQuat: Quaternion): void {
    const e = _scratchRotMat.makeRotationFromQuaternion(worldQuat).elements;
    this.halfSize.set(
      Math.abs(e[0]) * localHalf.x + Math.abs(e[4]) * localHalf.y + Math.abs(e[8]) * localHalf.z,
      Math.abs(e[1]) * localHalf.x + Math.abs(e[5]) * localHalf.y + Math.abs(e[9]) * localHalf.z,
      Math.abs(e[2]) * localHalf.x + Math.abs(e[6]) * localHalf.y + Math.abs(e[10]) * localHalf.z,
    );
  }

  /**
   * plan-653 — declare `localCenter` as NODE-LOCAL (the node's world scale
   * applies to it). From then on `update()` maps the centre through the node's
   * full `matrixWorld` whenever that matrix is not rigid (scale ≠ 1 or mirror);
   * on a rigid node the historical rotation-only path runs unchanged.
   * Only for node-backed AABBs with the default node position callback
   * (TransportSurface, Sensor). Returns `this` for chaining.
   */
  useNodeLocalFrame(): this {
    this.nodeLocalFrame = true;
    return this;
  }

  /** Whether `useNodeLocalFrame()` is active. */
  get usesNodeLocalFrame(): boolean {
    return this.nodeLocalFrame;
  }

  /**
   * plan-653 — set the world axis-aligned `halfSize` from half-extents in the
   * node's LOCAL frame (scale included): `worldHalf_i = Σ_j |M_ij|·localHalf_j`
   * with M the linear 3×3 of the node's `matrixWorld` (rotation × scale). On a
   * rigid node this is exactly `setHalfSizeFromRotatedExtents(localHalf,
   * worldQuaternion)` — bit-identical to the historical surface footprint.
   * No-op without a backing node. Allocation-free. Call BEFORE `update()`.
   */
  setHalfSizeFromNodeExtents(localHalf: Vector3): void {
    const node = this.node;
    if (!node) return;
    node.updateWorldMatrix(true, false);
    const m = node.matrixWorld;
    const e = m.elements;
    if (isRigid(e)) {
      // The same decompose `getWorldQuaternion()` performs — same bits as before.
      m.decompose(_scratchPos, _scratchQuat, _scratchScale);
      this.setHalfSizeFromRotatedExtents(localHalf, _scratchQuat);
      return;
    }
    this.halfSize.set(
      Math.abs(e[0]) * localHalf.x + Math.abs(e[4]) * localHalf.y + Math.abs(e[8]) * localHalf.z,
      Math.abs(e[1]) * localHalf.x + Math.abs(e[5]) * localHalf.y + Math.abs(e[9]) * localHalf.z,
      Math.abs(e[2]) * localHalf.x + Math.abs(e[6]) * localHalf.y + Math.abs(e[10]) * localHalf.z,
    );
  }

  /** Node-local centre through the full world matrix. Returns false (the caller
   *  then runs the historical path) when the matrix is rigid. */
  private _updateInNodeFrame(node: Object3D): boolean {
    node.updateWorldMatrix(true, false);
    const e = node.matrixWorld.elements;
    if (isRigid(e)) return false;
    const lc = this.localCenter;
    this.center.set(
      e[0] * lc.x + e[4] * lc.y + e[8] * lc.z + e[12],
      e[1] * lc.x + e[5] * lc.y + e[9] * lc.z + e[13],
      e[2] * lc.x + e[6] * lc.y + e[10] * lc.z + e[14],
    );
    this.min.copy(this.center).sub(this.halfSize);
    this.max.copy(this.center).add(this.halfSize);
    return true;
  }

  /** Replace the position callback (used when InstancedMesh slot changes) */
  setPositionFn(fn: (out: Vector3) => Vector3): void {
    this.getPositionFn = fn;
  }

  /** Fast AABB overlap test — no allocations */
  overlaps(other: AABB): boolean {
    return (
      this.min.x <= other.max.x && this.max.x >= other.min.x &&
      this.min.y <= other.max.y && this.max.y >= other.min.y &&
      this.min.z <= other.max.z && this.max.z >= other.min.z
    );
  }

  /** XZ-only overlap test (ignores Y axis). Used for transport surface checks
   *  where MUs sit ON the surface rather than inside it. */
  overlapsXZ(other: AABB): boolean {
    return (
      this.min.x <= other.max.x && this.max.x >= other.min.x &&
      this.min.z <= other.max.z && this.max.z >= other.min.z
    );
  }
}

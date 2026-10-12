// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Vector3, Object3D, Box3, Quaternion, Matrix4 } from 'three';
import { unityPositionToGltf } from './rv-coordinate-utils';

// Module-level scratch — pre-allocated to keep `AABB.update()` GC-free in the
// transport hot path. Each `update()` call is single-threaded so reuse is safe.
const _scratchQuat = new Quaternion();
const _scratchOffset = new Vector3();
const _scratchRotMat = new Matrix4();

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
    aabb.update();
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

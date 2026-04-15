// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Vector3, Object3D, Box3 } from 'three';
import { unityPositionToGltf } from './rv-coordinate-utils';

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
   */
  static fromNode(node: Object3D): AABB {
    const aabb = new AABB();
    aabb.node = node;
    aabb.getPositionFn = (out: Vector3) => node.getWorldPosition(out);
    const box = new Box3().setFromObject(node);
    const size = new Vector3();
    box.getSize(size);
    aabb.halfSize.copy(size).multiplyScalar(0.5);
    // localCenter = box center relative to node position
    const boxCenter = new Vector3();
    box.getCenter(boxCenter);
    node.getWorldPosition(aabb.localCenter);
    aabb.localCenter.subVectors(boxCenter, aabb.localCenter);
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

  /** Update world-space min/max from position source + local offset */
  update(): void {
    if (this.getPositionFn) {
      this.getPositionFn(this.center);
      // localCenter is small for most BoxColliders — add directly (AABB is axis-aligned)
      this.center.add(this.localCenter);
    } else if (this.node) {
      // Legacy fallback (should not happen with new code)
      this.node.getWorldPosition(this.center);
      this.center.add(this.localCenter);
    }
    this.min.copy(this.center).sub(this.halfSize);
    this.max.copy(this.center).add(this.halfSize);
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

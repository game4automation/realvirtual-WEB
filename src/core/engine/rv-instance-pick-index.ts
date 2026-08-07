// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-instance-pick-index.ts — the EDITOR-MODE pick backend: a two-level
 * (TLAS/BLAS-style) structure over the live scene graph, replacing the
 * merged grouped BVH in authoring scenes.
 *
 *   - Broad phase: per pick, every entry's world AABB is recomputed from its
 *     geometry's local bounding box × `matrixWorld` (abs-matrix extents,
 *     ~30 flops each) and slab-tested against the ray. DELIBERATELY no
 *     persistent world-AABB store and no transform invalidation: at editor
 *     scale (100s–low 1000s of meshes, hover throttled at 50 ms) the
 *     recompute costs microseconds, and gizmo drags, undo/redo, kinematic
 *     jog previews and any future mover are correct for free.
 *   - Narrow phase: candidates in ray-entry order raycast against their own
 *     LOCAL-space `boundsTree` (built once by the async BVH pipeline; native
 *     three.js fallback until it lands). Local BVHs ride node transforms and
 *     NEVER need a rebuild.
 *
 * Hit → path resolution is lazy: entries cache their EXACT node path (the
 * mesh's own registry path, falling back to the nearest REGISTERED ancestor
 * for unregistered helper meshes — no component promotion, no kinematic
 * Drive fallback: in the editor, what you see is what you pick) under a
 * global RESOLUTION EPOCH. Structural ops (rename/reparent/add-remove
 * component) just bump the epoch; stale entries re-resolve on the next hit.
 *
 * LOAD-BEARING INVARIANT: the broad phase reads `matrixWorld` raw. Editor
 * scenes freeze static matrices (`matrixWorldAutoUpdate = false`), so every
 * transform WRITER must force-refresh matrices (`updateMatrixWorld(true)`) —
 * all asset-op executors and the transform gizmo do. A writer that forgets
 * would also render stale, so pick correctness ≡ render correctness.
 *
 * Membership is resolution-INDEPENDENT: every `isPickableMesh` mesh is an
 * entry, including authored-hidden and path-less meshes — the broad phase
 * skips invisible chains per pick (hidden ⇒ ray-transparent, hits fall
 * through to geometry behind), and unresolvable entries return a null path
 * (the manager skips the hit without blocking hits behind it). This is what
 * makes `setNodeVisible` and pure transforms ZERO-maintenance ops.
 */

import { Mesh } from 'three';
import type { Intersection, Object3D, Raycaster } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import type { RaycastBackend } from './rv-raycast-manager';
import { isAuthoredHidden, isPickableMesh } from './rv-raycast-geometry';

/**
 * Exact-node resolution: the mesh's own registry path, else the nearest
 * REGISTERED ancestor (unregistered helper meshes). Deliberately no
 * component-ancestor promotion and no kinematic Drive fallback — the editor
 * always picks the object that was actually hit; owning components are
 * surfaced separately (owner info) by the consumers.
 */
function nearestRegisteredPath(mesh: Object3D, registry: NodeRegistry): string | null {
  for (let cur: Object3D | null = mesh; cur; cur = cur.parent) {
    const path = registry.getPathForNode(cur);
    if (path) return path;
  }
  return null;
}

/** True when the chain mesh → … → root is renderable AND not authored-hidden. */
function isChainVisible(mesh: Object3D): boolean {
  for (let cur: Object3D | null = mesh; cur; cur = cur.parent) {
    if (!cur.visible || isAuthoredHidden(cur)) return false;
  }
  return true;
}

interface PickEntry {
  mesh: Mesh;
  /** Cached content path (null = unresolvable → ray-transparent hit). */
  path: string | null;
  /** Epoch the cached path was resolved under (0 = never resolved). */
  epoch: number;
}

export class InstancePickIndex implements RaycastBackend {
  private readonly _entries: PickEntry[] = [];
  private readonly _byMesh = new Map<Object3D, PickEntry>();
  /** Global resolution epoch — bump on any structural op. */
  private _epoch = 1;

  // Pre-allocated scratch (no per-pick allocation).
  private readonly _candIdx: number[] = [];
  private readonly _candT: number[] = [];
  private readonly _candOrder: number[] = [];

  constructor(private readonly registry: NodeRegistry) {}

  /** Number of indexed meshes (DevTools / tests). */
  get size(): number {
    return this._entries.length;
  }

  // ─── Membership maintenance (structural ops) ──────────────────────

  /** Index every pickable mesh under `root` (skips already-indexed meshes). */
  addSubtree(root: Object3D): void {
    root.traverse((node) => {
      if (!(node as Mesh).isMesh) return;
      const mesh = node as Mesh;
      if (this._byMesh.has(mesh) || !isPickableMesh(mesh)) return;
      const entry: PickEntry = { mesh, path: null, epoch: 0 };
      this._entries.push(entry);
      this._byMesh.set(mesh, entry);
    });
  }

  /**
   * Drop every entry under `root`. MANDATORY on delete/trash detach (not an
   * optimization): a trashed mesh with a cached path would alias a node
   * later created at the same path.
   */
  removeSubtree(root: Object3D): void {
    let removed = 0;
    root.traverse((node) => {
      const entry = this._byMesh.get(node);
      if (entry) {
        this._byMesh.delete(node);
        removed++;
      }
    });
    if (removed === 0) return;
    // Compact in place, preserving order (structural ops are rare; N small).
    let w = 0;
    for (let r = 0; r < this._entries.length; r++) {
      const e = this._entries[r];
      if (this._byMesh.has(e.mesh)) this._entries[w++] = e;
    }
    this._entries.length = w;
  }

  /**
   * Invalidate every cached content path (rename / reparent / component
   * add-remove). Entries re-resolve lazily on their next hit.
   */
  bumpResolutionEpoch(): void {
    this._epoch++;
  }

  clear(): void {
    this._entries.length = 0;
    this._byMesh.clear();
    this._epoch = 1;
  }

  // ─── RaycastBackend ───────────────────────────────────────────────

  /** IMPLEMENTS RaycastBackend::raycast — broad phase + per-mesh narrow phase. */
  raycast(raycaster: Raycaster, out: Intersection<Object3D>[]): void {
    const entries = this._entries;
    if (entries.length === 0) return;

    const origin = raycaster.ray.origin;
    const dir = raycaster.ray.direction;
    const near = raycaster.near;
    const far = raycaster.far;

    const candIdx = this._candIdx;
    const candT = this._candT;
    candIdx.length = 0;
    candT.length = 0;

    // Broad phase: local geometry box → world AABB (abs-matrix extents) →
    // ray-slab. No allocation; matrixWorld is read raw (see header invariant).
    for (let i = 0; i < entries.length; i++) {
      const mesh = entries[i].mesh;
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      if (!bb || bb.isEmpty()) continue;

      const e = mesh.matrixWorld.elements;
      // World center = M × local center.
      const cx = (bb.min.x + bb.max.x) * 0.5;
      const cy = (bb.min.y + bb.max.y) * 0.5;
      const cz = (bb.min.z + bb.max.z) * 0.5;
      const wcx = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
      const wcy = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
      const wcz = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
      // World extents = |M3x3| × local extents.
      const ex = (bb.max.x - bb.min.x) * 0.5;
      const ey = (bb.max.y - bb.min.y) * 0.5;
      const ez = (bb.max.z - bb.min.z) * 0.5;
      const wex = Math.abs(e[0]) * ex + Math.abs(e[4]) * ey + Math.abs(e[8]) * ez;
      const wey = Math.abs(e[1]) * ex + Math.abs(e[5]) * ey + Math.abs(e[9]) * ez;
      const wez = Math.abs(e[2]) * ex + Math.abs(e[6]) * ey + Math.abs(e[10]) * ez;

      // Ray-slab vs [center ± extent], clipped to [near, far].
      let tmin = near;
      let tmax = far;
      // X
      let lo = wcx - wex - origin.x;
      let hi = wcx + wex - origin.x;
      if (Math.abs(dir.x) < 1e-12) {
        if (lo > 0 || hi < 0) continue;
      } else {
        const inv = 1 / dir.x;
        let t0 = lo * inv, t1 = hi * inv;
        if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
        if (t0 > tmin) tmin = t0;
        if (t1 < tmax) tmax = t1;
        if (tmin > tmax) continue;
      }
      // Y
      lo = wcy - wey - origin.y;
      hi = wcy + wey - origin.y;
      if (Math.abs(dir.y) < 1e-12) {
        if (lo > 0 || hi < 0) continue;
      } else {
        const inv = 1 / dir.y;
        let t0 = lo * inv, t1 = hi * inv;
        if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
        if (t0 > tmin) tmin = t0;
        if (t1 < tmax) tmax = t1;
        if (tmin > tmax) continue;
      }
      // Z
      lo = wcz - wez - origin.z;
      hi = wcz + wez - origin.z;
      if (Math.abs(dir.z) < 1e-12) {
        if (lo > 0 || hi < 0) continue;
      } else {
        const inv = 1 / dir.z;
        let t0 = lo * inv, t1 = hi * inv;
        if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
        if (t0 > tmin) tmin = t0;
        if (t1 < tmax) tmax = t1;
        if (tmin > tmax) continue;
      }

      // Visibility walk only for slab survivors: hidden chains are
      // ray-TRANSPARENT (hits behind them must win — gate fall-through).
      if (!isChainVisible(mesh)) continue;

      candIdx.push(i);
      candT.push(tmin);
    }

    if (candIdx.length === 0) return;

    // Narrow phase in ray-entry order (cheap cache locality win; the caller
    // sorts the final hit array anyway). acceleratedRaycast uses the mesh's
    // local boundsTree when present, native three.js triangle test until the
    // async build lands.
    const order = this._candOrder;
    order.length = candIdx.length;
    for (let i = 0; i < candIdx.length; i++) order[i] = i;
    order.sort((a, b) => candT[a] - candT[b]);

    for (let i = 0; i < order.length; i++) {
      const mesh = entries[candIdx[order[i]]].mesh;
      mesh.raycast(raycaster, out);
    }
  }

  /** IMPLEMENTS RaycastBackend::resolvePath — lazy epoch-cached resolution. */
  resolvePath(mesh: Object3D): string | null {
    const entry = this._byMesh.get(mesh);
    if (!entry) return null;
    if (entry.epoch !== this._epoch) {
      entry.path = nearestRegisteredPath(entry.mesh, this.registry);
      entry.epoch = this._epoch;
    }
    return entry.path;
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-batch-table.ts — registry of the model's BatchedMesh arenas and the
 * source-mesh → instance mapping.
 *
 * The batched render path (rv-batched-render.ts) collapses static geometry
 * into a small number of `BatchedMesh` arenas (one for all uber-baked
 * statics, one per textured-material group). Every source mesh becomes one
 * batch INSTANCE; visibility is applied per instance (`setVisibleAt`) by the
 * BatchVisibilityService instead of the legacy owner-bucket chunk parenting.
 *
 * Source-mesh contract:
 *   - source meshes keep `visible = true` (pure user-intent bit at every
 *     hierarchy level — all `.visible` mutator sites keep their semantics)
 *   - they are removed from rendering via `layers.mask = 0`
 *   - tags: `userData._rvBatchSource = true`,
 *     `userData._rvBatchInstance = { batch, instanceId }`
 *   - geometry + matrixWorld stay valid (picking BVH, highlight overlays and
 *     GLB export keep reading the originals)
 */

import { BatchedMesh, Box3, Matrix4, Mesh } from 'three';

export interface BatchInstanceRef {
  batch: BatchedMesh;
  instanceId: number;
}

export interface BatchTableStats {
  batches: number;
  instances: number;
  uniqueGeometries: number;
  arenaVertices: number;
  arenaIndices: number;
}

const _tmpBox = new Box3();
const _tmpMat = new Matrix4();

export class BatchTable {
  readonly batches: BatchedMesh[] = [];
  private _byMesh = new Map<Mesh, BatchInstanceRef>();
  /** Per-batch bookkeeping filled by the builders (arena capacities). */
  private _uniqueGeometries = 0;
  private _arenaVertices = 0;
  private _arenaIndices = 0;

  /** Register a new arena. Called once per BatchedMesh by the builders. */
  addBatch(batch: BatchedMesh, uniqueGeometries: number, arenaVertices: number, arenaIndices: number): void {
    this.batches.push(batch);
    this._uniqueGeometries += uniqueGeometries;
    this._arenaVertices += arenaVertices;
    this._arenaIndices += arenaIndices;
  }

  /** Bind a source mesh to its batch instance and apply the source contract
   *  (layers.mask = 0 + tags). The mesh stays in the scene graph. */
  register(mesh: Mesh, ref: BatchInstanceRef): void {
    this._byMesh.set(mesh, ref);
    mesh.layers.mask = 0;
    mesh.userData._rvBatchSource = true;
    mesh.userData._rvBatchInstance = ref;
  }

  refFor(mesh: Mesh): BatchInstanceRef | undefined {
    return this._byMesh.get(mesh);
  }

  get instanceCount(): number {
    return this._byMesh.size;
  }

  /** Iterate all (mesh, ref) bindings — used by the visibility reconcile. */
  entries(): IterableIterator<[Mesh, BatchInstanceRef]> {
    return this._byMesh.entries();
  }

  /** Snapshot per-instance visibility of every batch (index = instanceId). */
  snapshotVisibility(): Uint8Array[] {
    return this.batches.map((batch) => {
      const n = batch.instanceCount;
      const snap = new Uint8Array(n);
      for (let i = 0; i < n; i++) snap[i] = batch.getVisibleAt(i) ? 1 : 0;
      return snap;
    });
  }

  /** Restore a visibility snapshot taken with {@link snapshotVisibility}. */
  restoreVisibility(snap: Uint8Array[]): void {
    for (let b = 0; b < this.batches.length; b++) {
      const batch = this.batches[b];
      const s = snap[b];
      if (!s) continue;
      for (let i = 0; i < s.length; i++) batch.setVisibleAt(i, s[i] === 1);
    }
  }

  /**
   * Union the world-space bounds of every VISIBLE instance into `target`
   * (used by content-fit — the arena geometry bbox alone ignores instance
   * matrices and would return the wrong extent).
   */
  computeVisibleBounds(target: Box3): Box3 {
    for (const batch of this.batches) {
      batch.updateMatrixWorld(false);
      const n = batch.instanceCount;
      for (let i = 0; i < n; i++) {
        if (!batch.getVisibleAt(i)) continue;
        batch.getBoundingBoxAt(batch.getGeometryIdAt(i), _tmpBox);
        batch.getMatrixAt(i, _tmpMat);
        _tmpBox.applyMatrix4(_tmpMat).applyMatrix4(batch.matrixWorld);
        target.union(_tmpBox);
      }
    }
    return target;
  }

  stats(): BatchTableStats {
    return {
      batches: this.batches.length,
      instances: this._byMesh.size,
      uniqueGeometries: this._uniqueGeometries,
      arenaVertices: this._arenaVertices,
      arenaIndices: this._arenaIndices,
    };
  }

  /** Dispose every arena (frees arena geometry + matrices/indirect textures),
   *  remove them from their parents, and clear all source-mesh tags. */
  dispose(): void {
    for (const batch of this.batches) {
      batch.removeFromParent();
      batch.dispose();
    }
    for (const [mesh] of this._byMesh) {
      // Restore the default layer so an aborted build (sources already
      // masked out, arena discarded) leaves the originals renderable.
      mesh.layers.mask = 1;
      delete mesh.userData._rvBatchInstance;
      delete mesh.userData._rvBatchSource;
    }
    this.batches.length = 0;
    this._byMesh.clear();
    this._uniqueGeometries = 0;
    this._arenaVertices = 0;
    this._arenaIndices = 0;
  }
}

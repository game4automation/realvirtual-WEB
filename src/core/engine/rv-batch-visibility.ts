// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-batch-visibility.ts — per-instance visibility reconcile for the
 * BatchedMesh render path.
 *
 * `.visible` on scene nodes stays the single source of truth for user intent
 * (groups window, auto-filters, property inspector, WebVisibility PLC
 * signals, …). Batched source meshes are not rendered themselves
 * (layers.mask = 0), so their EFFECTIVE visibility — own flag AND every
 * ancestor's flag — must be mirrored into `BatchedMesh.setVisibleAt`.
 *
 * Design: mutator sites call `markDirty()` (via
 * `notifyNodeVisibilityChanged`); the viewer calls `reconcile()` once per
 * rendered frame before any pass. Reconcile is ONE flat walk over the model
 * subtree carrying an inherited-visible bool (~0.5-1 ms on a 38.5k-node
 * scene, toggle frames only). A flat resync is deliberately chosen over
 * subtree diffing: it is idempotent and unmissable-correct even if a mutator
 * site forgets to notify — `setVisibleAt` no-ops on unchanged values.
 */

import { Mesh, Object3D } from 'three';
import type { BatchInstanceRef, BatchTable } from './rv-batch-table';

export class BatchVisibilityService {
  private _dirty = true;
  private _changed = 0;

  constructor(
    private readonly _modelRoot: Object3D,
    private readonly _table: BatchTable,
  ) {}

  /** Flag the instance-visibility state as stale. Cheap — call freely. */
  markDirty(): void {
    this._dirty = true;
  }

  get isDirty(): boolean {
    return this._dirty;
  }

  get hasInstances(): boolean {
    return this._table.instanceCount > 0;
  }

  /** Mirror effective node visibility into the batch instances (when dirty).
   *  Returns the number of instances whose visibility actually flipped. */
  reconcile(): number {
    if (!this._dirty) return 0;
    this._dirty = false;
    this._changed = 0;
    this._walk(this._modelRoot, true);
    return this._changed;
  }

  /** Force a full resync regardless of the dirty flag (safety net for missed
   *  mutator notifications). Returns the number of flipped instances. */
  forceReconcile(): number {
    this._dirty = true;
    return this.reconcile();
  }

  private _walk(node: Object3D, inheritedVisible: boolean): void {
    const effective = inheritedVisible && node.visible;
    const ref = (node as Mesh).userData?._rvBatchInstance as BatchInstanceRef | undefined;
    if (ref && ref.batch.getVisibleAt(ref.instanceId) !== effective) {
      ref.batch.setVisibleAt(ref.instanceId, effective);
      this._changed++;
    }
    const children = node.children;
    for (let i = 0; i < children.length; i++) {
      this._walk(children[i], effective);
    }
  }
}

/**
 * Notify the viewer's batch visibility service that a node's `.visible`
 * changed. Safe to call always — no-ops when the batched path is inactive.
 * The parameter is structurally typed so UI/plugin call sites don't need the
 * RVViewer import.
 */
export function notifyNodeVisibilityChanged(
  viewer: { batchVisibility?: BatchVisibilityService | null } | null | undefined,
): void {
  viewer?.batchVisibility?.markDirty();
}

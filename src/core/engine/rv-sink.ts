// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D } from 'three';
import { AABB } from './rv-aabb';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { debug } from './rv-debug';

/**
 * RVSink - Removes MUs that overlap with this sink's AABB.
 *
 * In Unity, Sink uses OnTriggerEnter to delete MUs.
 * In WebViewer, we use explicit AABB overlap checks.
 */
export class RVSink implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Sink');

  readonly node: Object3D;
  readonly aabb: AABB;
  isOwner = true;
  DeleteMus = true;
  DeleteOnlyTag = '';

  accepts(mu: RVMovingUnit | InstancedMovingUnit): boolean {
    return this.DeleteMus && (!this.DeleteOnlyTag || mu.node.userData.tag === this.DeleteOnlyTag);
  }

  /** Callback when a MU is consumed */
  onConsumed?: (mu: RVMovingUnit | InstancedMovingUnit, sink: RVSink) => void;
  private readonly consumedListeners = new Set<(mu: RVMovingUnit | InstancedMovingUnit) => void>();

  subscribeConsumed(cb: (mu: RVMovingUnit | InstancedMovingUnit) => void): () => void {
    this.consumedListeners.add(cb);
    return () => { this.consumedListeners.delete(cb); };
  }

  notifyConsumed(mu: RVMovingUnit | InstancedMovingUnit): void {
    this.onConsumed?.(mu, this);
    for (const cb of this.consumedListeners) cb(mu);
  }

  dispose(): void { this.consumedListeners.clear(); }

  constructor(node: Object3D, aabb: AABB) {
    this.node = node;
    this.aabb = aabb;
  }

  init(context: ComponentContext): void {
    // Register in transport manager
    context.transportManager.sinks.push(this);
    debug('loader', `Sink: ${this.node.name}`);
  }

  /**
   * Mark MUs that overlap this sink for removal.
   * Uses XZ-only overlap (same as transport surfaces) because MUs sit ON
   * surfaces and their Y-axis AABB may not intersect the sink's BoxCollider.
   * Skips gripped MUs — they are controlled by the Grip system.
   *
   * Passive loads (plan-516) are never in `mus`: consuming a carrier takes its
   * whole load tree with it (the loads are children of the carrier's node). A
   * pre-placed carrier is only detached, so a simulation reset restores it
   * together with its loads from their snapshots.
   */
  markOverlapping(mus: (RVMovingUnit | InstancedMovingUnit)[]): void {
    if (!this.isOwner) return; // Server controls MU removal in multiuser
    for (const mu of mus) {
      if (!this.accepts(mu)) continue;
      if (mu.markedForRemoval) continue;
      if (!mu.isInstanced && (mu as RVMovingUnit).isGripped) continue;
      if (this.aabb.overlapsXZ(mu.aabb)) {
        mu.markedForRemoval = true;
        this.notifyConsumed(mu);
      }
    }
  }

  /** Update AABB world position */
  updateAABB(): void {
    this.aabb.update();
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'Sink',
  schema: RVSink.schema,
  needsAABB: true,
  capabilities: {
    authorable: true,   // addable in the asset editor (schema-complete)
    // 'merge' (plan-753 F6): a sink is static geometry — it only destroys MUs
    // that arrive. It sat in the old exclusion list only because Source/Sink
    // were listed together; the OLD pipelines keep the `keep` behaviour via
    // `LEGACY_KEEP_OVERRIDE` (rv-freeze-static.ts) until plan-753 Phase 4b removed it.
    bake: 'merge',
    ui: { badge: '#ef5350', tooltip: 'des-component' },
  },
  create: (node, aabb) => new RVSink(node, aabb!),
});

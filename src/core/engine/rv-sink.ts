// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D } from 'three';
import { AABB } from './rv-aabb';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import { debug } from './rv-debug';

/**
 * RVSink - Removes MUs that overlap with this sink's AABB.
 *
 * In Unity, Sink uses OnTriggerEnter to delete MUs.
 * In WebViewer, we use explicit AABB overlap checks.
 */
export class RVSink implements RVComponent {
  static readonly schema: ComponentSchema = {};

  readonly node: Object3D;
  readonly aabb: AABB;
  isOwner = true;

  /** Callback when a MU is consumed */
  onConsumed?: (mu: RVMovingUnit | InstancedMovingUnit, sink: RVSink) => void;

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
   */
  markOverlapping(mus: (RVMovingUnit | InstancedMovingUnit)[]): void {
    if (!this.isOwner) return; // Server controls MU removal in multiuser
    for (const mu of mus) {
      if (mu.markedForRemoval) continue;
      if (!mu.isInstanced && (mu as RVMovingUnit).isGripped) continue;
      if (this.aabb.overlapsXZ(mu.aabb)) {
        mu.markedForRemoval = true;
        this.onConsumed?.(mu, this);
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
    badgeColor: '#ef5350',
    simulationActive: true,
  },
  create: (node, aabb) => new RVSink(node, aabb!),
});

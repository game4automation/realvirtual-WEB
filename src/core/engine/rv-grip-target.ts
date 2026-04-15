// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVMovingUnit } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import { debug } from './rv-debug';

/**
 * RVGripTarget — Placement marker for precise MU positioning.
 *
 * Port of GripTarget.cs. Tracks occupancy so Grips can find
 * the nearest free target during auto-place.
 */
export class RVGripTarget implements RVComponent {
  static readonly schema: ComponentSchema = {
    AlignPosition: { type: 'boolean', default: true },
    AlignRotation: { type: 'boolean', default: true },
  };

  readonly node: Object3D;
  isOwner = true;
  occupiedBy: RVMovingUnit | null = null;

  // Properties — exact C# Inspector field names
  AlignPosition = true;
  AlignRotation = true;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    // Register in transport manager
    context.transportManager.gripTargets.push(this);
    debug('loader', `  GripTarget: ${this.node.name} alignPos=${this.AlignPosition} alignRot=${this.AlignRotation}`);
  }

  get isFree(): boolean {
    return this.occupiedBy === null;
  }

  setOccupied(mu: RVMovingUnit): void {
    this.occupiedBy = mu;
  }

  clearOccupied(): void {
    this.occupiedBy = null;
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'GripTarget',
  schema: RVGripTarget.schema,
  capabilities: {},
  create: (node) => new RVGripTarget(node),
});

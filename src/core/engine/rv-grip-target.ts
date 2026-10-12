// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVMovingUnit } from './rv-mu';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { debug } from './rv-debug';

/**
 * RVGripTarget — Placement marker for precise MU positioning.
 *
 * Port of GripTarget.cs. Tracks occupancy so Grips can find
 * the nearest free target during auto-place.
 */
export class RVGripTarget implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('GripTarget');

  readonly node: Object3D;
  isOwner = true;
  occupiedBy: RVMovingUnit | null = null;

  // Properties — exact C# Inspector field names
  AlignPosition = true;
  AlignRotation = true;
  /** Grip auto-place (plan-577 F5/F6): align the part at this pose, then make it
   *  a passive load of the MU below it instead of parenting it to this target;
   *  the target stays free. A blocked or ambiguous seat refuses the place, no
   *  MU below falls back to the classic target placement. Zones ignore it. */
  LoadOnCarrier = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    // Register in transport manager
    context.transportManager.gripTargets.push(this);
    debug('loader', `  GripTarget: ${this.node.name} alignPos=${this.AlignPosition} alignRot=${this.AlignRotation} loadOnCarrier=${this.LoadOnCarrier}`);
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
  capabilities: { authorable: true, bake: 'chunk' },   // addable in the asset editor (schema-complete); moves with its gripper
  create: (node) => new RVGripTarget(node),
});

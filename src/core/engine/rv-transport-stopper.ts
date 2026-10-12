// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Box3, Vector3, type Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { loadSchemaFromSpec, registerComponent, setComponentInstance } from './rv-component-registry';
import type { RVTransportManager } from './rv-transport-manager';
import type { AABB } from './rv-aabb';
import { sweptClamp } from './rv-swept-aabb';

/** A moving box collider that arrests kinematically transported MUs at contact. */
export class RVTransportStopper implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('TransportStopper');
  readonly node: Object3D;
  isOwner = true;
  Enabled = true;
  /** Collider center and size in local glTF coordinates, millimetres. */
  Center = new Vector3();
  Size = new Vector3(100, 100, 100);
  readonly bounds = new Box3();
  private readonly localBounds = new Box3();
  private manager: RVTransportManager | null = null;

  constructor(node: Object3D) { this.node = node; }

  init(ctx: ComponentContext): void {
    this.manager = ctx.transportManager;
    this.manager.stoppers.add(this);
  }

  /** Refresh once per transport tick, after the owning axis has moved. */
  updateBounds(): void {
    if (!this.Enabled || !Number.isFinite(this.Size.x + this.Size.y + this.Size.z)
      || this.Size.x <= 0 || this.Size.y <= 0 || this.Size.z <= 0) {
      this.bounds.makeEmpty();
      return;
    }
    this.localBounds.min.copy(this.Center).addScaledVector(this.Size, -0.5).multiplyScalar(0.001);
    this.localBounds.max.copy(this.Center).addScaledVector(this.Size, 0.5).multiplyScalar(0.001);
    this.node.updateWorldMatrix(true, false);
    this.bounds.copy(this.localBounds).applyMatrix4(this.node.matrixWorld);
  }

  /** Swept AABB contact; returns the allowed travel without tunnelling.
   *  Delegates to the shared swept-AABB kernel (plan-521), unchanged behaviour. */
  clampTravel(mu: AABB, direction: Vector3, distance: number): number {
    return sweptClamp(this.bounds, mu, direction, distance);
  }

  dispose(): void {
    this.manager?.stoppers.delete(this);
    this.manager = null;
  }
}

registerComponent({
  type: 'TransportStopper',
  displayName: 'Transport Stopper',
  schema: RVTransportStopper.schema,
  capabilities: { authorable: true, ui: { badge: '#e88a32', filter: 'Transport Stoppers', category: 'transport' } },
  create: node => new RVTransportStopper(node),
  afterCreate: (instance, node) => setComponentInstance(node, instance),
});

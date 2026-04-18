// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVTank — Process-industry tank / vessel component.
 *
 * Holds a process fluid with capacity, current amount, pressure, and temperature.
 * The class owns its tooltip content via `getTooltipData()` and keeps
 * `node.userData._rvTank` in sync so legacy consumers (rv-tank-fill.ts)
 * continue to work.
 *
 * Note: the GLB extras key is `ResourceTank`, but user-facing names use `Tank`.
 */

import type { Object3D } from 'three';
import type { ComponentSchema } from './rv-component-registry';
import { applySchema, setComponentInstance } from './rv-component-registry';
import { validateExtras } from './rv-extras-validator';
import { NodeRegistry } from './rv-node-registry';
import { registerTooltipComponent } from './rv-tooltip-component';

export class RVTank {
  static readonly type = 'ResourceTank';
  static readonly tooltipType = 'tank';
  static readonly displayName = 'Tank';

  static readonly schema: ComponentSchema = {
    resourceName: { type: 'string', default: '' },
    capacity: { type: 'number', default: 0 },
    amount: { type: 'number', default: 0 },
    pressure: { type: 'number', default: 0 },
    temperature: { type: 'number', default: 0 },
  };

  readonly node: Object3D;

  resourceName = '';
  capacity = 0;
  amount = 0;
  pressure = 0;
  temperature = 0;

  constructor(node: Object3D, extras: Record<string, unknown>) {
    this.node = node;
    validateExtras(RVTank.type, extras);
    applySchema(this as unknown as Record<string, unknown>, RVTank.schema, extras);

    setComponentInstance(node, this);
    node.userData._rvType = 'Tank';
    this.syncUserData();
  }

  /** Plugin API: set the process fluid stored in this tank. */
  setResource(name: string): void {
    this.resourceName = name;
    this.syncUserData();
  }

  /** Plugin API: set the current amount (liters). Clamped to [0, capacity]. */
  setAmount(liters: number): void {
    this.amount = this.capacity > 0 ? Math.max(0, Math.min(this.capacity, liters)) : Math.max(0, liters);
    this.syncUserData();
  }

  /** Plugin API: add (positive) or remove (negative) an amount, clamped. */
  addAmount(delta: number): void {
    this.setAmount(this.amount + delta);
  }

  getTooltipData(): { type: 'tank'; nodePath: string } {
    return { type: 'tank', nodePath: NodeRegistry.computeNodePath(this.node) };
  }

  private syncUserData(): void {
    this.node.userData._rvTank = {
      resourceName: this.resourceName,
      capacity: this.capacity,
      amount: this.amount,
      pressure: this.pressure,
      temperature: this.temperature,
    };
  }
}

registerTooltipComponent(RVTank, {
  hoverable: true,
  badgeColor: '#42a5f5',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});

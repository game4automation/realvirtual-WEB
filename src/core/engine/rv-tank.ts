// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVTank — Process-industry tank / vessel component.
 *
 * Holds a process fluid with capacity, current amount, pressure, temperature,
 * plus optional industry-typical instrumentation (density, pH, alarm thresholds,
 * agitator/heater status). Mass is derived (density × volume) when density > 0.
 * The class owns its tooltip content via `getTooltipData()` and keeps
 * `node.userData._rvTank` in sync so legacy consumers (rv-tank-fill.ts)
 * continue to work.
 *
 * Note: the GLB extras key is `ResourceTank`, but user-facing names use `Tank`.
 */

import type { Object3D } from 'three';
import type { ComponentSchema } from './rv-component-registry';
import { applySchema, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import { validateExtras } from './rv-extras-validator';
import { NodeRegistry } from './rv-node-registry';
import { registerTooltipComponent } from './rv-tooltip-component';

export class RVTank {
  static readonly type = 'ResourceTank';
  static readonly tooltipType = 'tank';
  static readonly displayName = 'Tank';

  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('ResourceTank');

  readonly node: Object3D;

  resourceName = '';
  capacity = 0;
  amount = 0;
  pressure = 0;
  temperature = 0;
  density = 0;
  ph = 0;
  agitatorOn = false;
  heatingOn = false;
  tempHighLimit = 0;
  tempLowLimit = 0;
  pressureHighLimit = 0;

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

  /** Plugin API: set temperature (°C). */
  setTemperature(celsius: number): void {
    this.temperature = celsius;
    this.syncUserData();
  }

  /** Plugin API: set pressure (bar gauge). */
  setPressure(bar: number): void {
    this.pressure = bar;
    this.syncUserData();
  }

  /** Plugin API: toggle agitator/mixer state. */
  setAgitator(on: boolean): void {
    this.agitatorOn = on;
    this.syncUserData();
  }

  /** Plugin API: toggle heater jacket state. */
  setHeater(on: boolean): void {
    this.heatingOn = on;
    this.syncUserData();
  }

  /** Derived mass in kg from density × volume (returns 0 when density is unknown). */
  get massKg(): number {
    if (this.density <= 0) return 0;
    return (this.amount / 1000) * this.density; // L → m³, m³ × kg/m³
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
      density: this.density,
      ph: this.ph,
      agitatorOn: this.agitatorOn,
      heatingOn: this.heatingOn,
      tempHighLimit: this.tempHighLimit,
      tempLowLimit: this.tempLowLimit,
      pressureHighLimit: this.pressureHighLimit,
      massKg: this.massKg,
    };
  }
}

registerTooltipComponent(RVTank, {
  hoverable: true,
  badgeColor: '#42a5f5',
  filterLabel: 'Tanks',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});

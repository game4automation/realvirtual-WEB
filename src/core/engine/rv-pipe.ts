// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVPipe — Process-industry pipe component.
 *
 * A pipe carries a resource (fluid) between two endpoints (Tank / Pump / ProcessingUnit).
 * Flow rate may be negative to indicate reverse direction. Carries optional
 * industry-typical instrumentation (line pressure, temperature, fluid velocity,
 * nominal diameter DN). The class owns its tooltip content via `getTooltipData()`
 * and keeps `node.userData._rvPipe` in sync so legacy consumers (rv-pipe-flow.ts)
 * continue to work.
 */

import type { Object3D } from 'three';
import type { ComponentSchema } from './rv-component-registry';
import { applySchema, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import { validateExtras } from './rv-extras-validator';
import { NodeRegistry } from './rv-node-registry';
import { registerTooltipComponent } from './rv-tooltip-component';

/** Raw ComponentReference shape from GLB extras. */
interface ComponentRefRaw {
  path?: string;
  type?: string;
}

export class RVPipe {
  static readonly type = 'Pipe';
  static readonly tooltipType = 'pipe';
  static readonly displayName = 'Pipe';

  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Pipe');

  readonly node: Object3D;

  resourceName = '';
  flowRate = 0;
  uvDirection = 1;
  /** Authoring-time grouping: pipes with the same non-negative circuitId
   *  belong to the same fluid circuit, even if they're not topologically
   *  linked via source/destination references. `-1` = unassigned. */
  circuitId = -1;
  sourcePath: string | null = null;
  destinationPath: string | null = null;
  pressure = 0;
  temperatureC = 0;
  velocityMs = 0;
  dnSize = 0;

  constructor(node: Object3D, extras: Record<string, unknown>) {
    this.node = node;
    validateExtras(RVPipe.type, extras);
    applySchema(this as unknown as Record<string, unknown>, RVPipe.schema, extras);
    // applySchema stores raw ComponentRef objects — extract paths
    const src = (this as unknown as { source?: ComponentRefRaw | null }).source;
    const dst = (this as unknown as { destination?: ComponentRefRaw | null }).destination;
    this.sourcePath = src?.path ?? null;
    this.destinationPath = dst?.path ?? null;

    setComponentInstance(node, this);
    node.userData._rvType = 'Pipe';
    this.syncUserData();
  }

  /** Plugin API: set the flow rate. Negative rate = reverse direction. */
  setFlow(rate: number): void {
    this.flowRate = rate;
    this.syncUserData();
  }

  /** Plugin API: set the process fluid carried by this pipe. */
  setResource(name: string): void {
    this.resourceName = name;
    this.syncUserData();
  }

  /** Plugin API: set line pressure (bar gauge). */
  setPressure(bar: number): void {
    this.pressure = bar;
    this.syncUserData();
  }

  /** Plugin API: set fluid temperature (°C). */
  setTemperature(celsius: number): void {
    this.temperatureC = celsius;
    this.syncUserData();
  }

  /** Plugin API: set fluid velocity (m/s). */
  setVelocity(ms: number): void {
    this.velocityMs = ms;
    this.syncUserData();
  }

  getTooltipData(): { type: 'pipe'; nodePath: string } {
    return { type: 'pipe', nodePath: NodeRegistry.computeNodePath(this.node) };
  }

  /** Keep legacy userData view in sync with instance state. */
  private syncUserData(): void {
    this.node.userData._rvPipe = {
      resourceName: this.resourceName,
      flowRate: this.flowRate,
      sourcePath: this.sourcePath,
      destinationPath: this.destinationPath,
      uvDirection: this.uvDirection,
      pressure: this.pressure,
      temperatureC: this.temperatureC,
      velocityMs: this.velocityMs,
      dnSize: this.dnSize,
    };
  }
}

registerTooltipComponent(RVPipe, {
  hoverable: true,
  badgeColor: '#26c6da',
  filterLabel: 'Pipes',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});

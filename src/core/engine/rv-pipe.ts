// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVPipe — Process-industry pipe component.
 *
 * A pipe carries a resource (fluid) between two endpoints (Tank / Pump / ProcessingUnit).
 * Flow rate may be negative to indicate reverse direction. The class owns its tooltip
 * content via `getTooltipData()` and keeps `node.userData._rvPipe` in sync so legacy
 * consumers (rv-pipe-flow.ts) continue to work.
 */

import type { Object3D } from 'three';
import type { ComponentSchema } from './rv-component-registry';
import { applySchema, setComponentInstance } from './rv-component-registry';
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

  static readonly schema: ComponentSchema = {
    resourceName: { type: 'string', default: '' },
    flowRate: { type: 'number', default: 0 },
    source: { type: 'componentRef' },
    destination: { type: 'componentRef' },
    uvDirection: { type: 'number', default: 1 },
    circuitId: { type: 'number', default: -1 },
  };

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
    };
  }
}

registerTooltipComponent(RVPipe, {
  hoverable: true,
  badgeColor: '#26c6da',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});

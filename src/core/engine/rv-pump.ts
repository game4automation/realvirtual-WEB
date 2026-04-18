// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVPump — Process-industry pump component.
 *
 * Drives flow through a connected pipe. `flowRate > 0` means running; 0 means stopped.
 * The class owns its tooltip content via `getTooltipData()` and keeps
 * `node.userData._rvPump` in sync for tooltip consumers.
 */

import type { Object3D } from 'three';
import type { ComponentSchema } from './rv-component-registry';
import { applySchema, setComponentInstance } from './rv-component-registry';
import { validateExtras } from './rv-extras-validator';
import { NodeRegistry } from './rv-node-registry';
import { registerTooltipComponent } from './rv-tooltip-component';

interface ComponentRefRaw {
  path?: string;
  type?: string;
}

export class RVPump {
  static readonly type = 'Pump';
  static readonly tooltipType = 'pump';
  static readonly displayName = 'Pump';

  static readonly schema: ComponentSchema = {
    flowRate: { type: 'number', default: 0 },
    pipe: { type: 'componentRef' },
  };

  readonly node: Object3D;

  flowRate = 0;
  pipePath: string | null = null;

  constructor(node: Object3D, extras: Record<string, unknown>) {
    this.node = node;
    validateExtras(RVPump.type, extras);
    applySchema(this as unknown as Record<string, unknown>, RVPump.schema, extras);
    const ref = (this as unknown as { pipe?: ComponentRefRaw | null }).pipe;
    this.pipePath = ref?.path ?? null;

    setComponentInstance(node, this);
    node.userData._rvType = 'Pump';
    this.syncUserData();
  }

  /** Plugin API: start the pump at the given rate (l/min). */
  start(rate: number): void {
    this.flowRate = Math.abs(rate);
    this.syncUserData();
  }

  /** Plugin API: stop the pump. */
  stop(): void {
    this.flowRate = 0;
    this.syncUserData();
  }

  get isRunning(): boolean {
    return this.flowRate > 0;
  }

  getTooltipData(): { type: 'pump'; nodePath: string } {
    return { type: 'pump', nodePath: NodeRegistry.computeNodePath(this.node) };
  }

  private syncUserData(): void {
    this.node.userData._rvPump = {
      flowRate: this.flowRate,
      pipePath: this.pipePath,
    };
  }
}

registerTooltipComponent(RVPump, {
  hoverable: true,
  badgeColor: '#7e57c2',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-tooltip-component.ts — Declarative wiring for tooltip-providing components.
 *
 * A component class that owns its tooltip content can register in one line:
 *
 *     registerTooltipComponent(RVPipe, {
 *       hoverable: true, badgeColor: '#26c6da',
 *       hoverEnabledByDefault: true, hoverPriority: 10, pinPriority: 5,
 *     });
 *
 * This registers capabilities on the class's `type` key and installs a
 * tooltip data resolver that looks up the component instance attached at
 * `node.userData._rvComponentInstance` and calls `instance.getTooltipData()`.
 */

import type { Object3D } from 'three';
import { registerCapabilities, type ComponentCapabilities } from './rv-component-registry';
import { tooltipRegistry } from '../hmi/tooltip/tooltip-registry';

/** Shape a class must expose to participate in tooltip auto-wiring. */
export interface TooltipComponentStatic {
  /** GLB extras key (e.g. 'Pipe', 'ResourceTank', 'Pump'). */
  readonly type: string;
  /** Tooltip registry key (e.g. 'pipe', 'tank', 'pump'). */
  readonly tooltipType: string;
  /** Optional short label used as _rvType and as a capability alias so lookups
   *  keyed by _rvType (e.g. rv-raycast-geometry) resolve correctly. Defaults to `type`. */
  readonly displayName?: string;
}

/** Shape instances must expose at runtime. */
interface TooltipInstance {
  getTooltipData(): Record<string, unknown> | null;
}

/**
 * Register capabilities + data resolver for a tooltip-providing component class.
 * The class itself is responsible for attaching its instance to
 * `node.userData._rvComponentInstance` during construction.
 */
export function registerTooltipComponent(
  ctor: TooltipComponentStatic,
  capabilities: ComponentCapabilities,
): void {
  const resolved = { ...capabilities, tooltipType: ctor.tooltipType };
  // Register under the GLB extras key — this is what GenericTooltipController iterates
  // (Object.keys(node.userData.realvirtual)).
  registerCapabilities(ctor.type, resolved);
  // When the _rvType differs from the extras key (e.g. extras='ResourceTank', _rvType='Tank'),
  // also register under the display name so lookups keyed by node.userData._rvType
  // (rv-raycast-geometry, inspector helpers) resolve correctly.
  if (ctor.displayName && ctor.displayName !== ctor.type) {
    registerCapabilities(ctor.displayName, resolved);
  }

  tooltipRegistry.registerDataResolver(ctor.tooltipType, (node: Object3D) => {
    const inst = node.userData._rvComponentInstance as TooltipInstance | undefined;
    if (!inst || typeof inst.getTooltipData !== 'function') return null;
    return inst.getTooltipData();
  });
}

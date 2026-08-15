// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-signal-context-menu.ts — the hierarchy-tree entry point for binding a raw
 * PLC signal node (plan-418 F2).
 *
 * The Signals filter of the hierarchy browser lists every `PLCInput*` /
 * `PLCOutput*` node; right-click (or long-press) on such a row now offers
 * "Link signal…", opening the SAME `SignalBindPopover` the 3D badge opens.
 *
 * Two contract decisions, both from the plan's Entscheidungs-Log:
 *
 *  - **The EXACT node decides.** `findSignalBindTarget()` climbs ancestors, so
 *    a plain mesh inside a drive resolves to that drive. For this item that
 *    would be a lie: the user right-clicked a signal, not the machine around
 *    it. The item therefore appears only when the resolved target actually
 *    carries the PLC slot OF THIS NODE — never a silent ancestor fallback.
 *  - **No item instead of a disabled item.** `ContextMenuItem` has no disabled
 *    state (`condition === false` removes the row), so a fail-closed slot
 *    (`duplicate-signal-name`, `signal-not-registered`) simply produces no
 *    entry. The REASON stays visible — the Property Inspector renders it on the
 *    node's `Value` row (F6).
 *
 * A node inside a Planner placement binds through the placement (the placement
 * is one aggregate bind target), so the label names it explicitly rather than
 * pretending the popover will be about the signal node alone.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { ContextMenuItem, ContextMenuTarget } from '../../core/hmi/context-menu-store';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { PLC_SIGNAL_SLOT } from '../../core/engine/rv-binding-slot-resolver';
import { SIGNAL_TYPES } from '../../core/engine/rv-signal-construction';
import { baseComponentType } from '../../core/hmi/rv-inspector-helpers';
import { openSignalBindPopover } from './signal-bind-store';
import {
  findSignalBindTarget,
  signalBindEligibility,
  signalBindTargetId,
  type SignalBindTarget,
} from './signal-bind-target';

/** Plugin id used for register/unregister — same string as `SignalBindPlugin.id`. */
export const SIGNAL_BIND_MENU_PLUGIN_ID = 'signal-bind';

export interface PLCBindMenuResolution {
  /** The bind target the popover will open for (the node, or its placement). */
  target: SignalBindTarget;
  /** Menu label — names the placement when the signal binds through one. */
  label: string;
}

/** Root-relative component path of `nodePath` under a bind-target root. */
function relativePathUnder(rootPath: string, nodePath: string): string {
  if (nodePath === rootPath) return '.';
  if (rootPath && nodePath.startsWith(`${rootPath}/`)) return nodePath.slice(rootPath.length + 1);
  return nodePath || '.';
}

/** Does the node itself declare a raw PLC signal in its rv_extras? */
function declaresPLCSignal(node: Object3D): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return false;
  return SIGNAL_TYPES.some((type) => rv[type] !== undefined);
}

/**
 * The bind target for a right-clicked PLC signal node, or `null` when this node
 * offers no bindable PLC slot (not a signal node, unregistered, name collision,
 * ineligible element, or no binding manager at all).
 */
export function resolvePLCBindMenuTarget(
  viewer: RVViewer,
  menuTarget: Pick<ContextMenuTarget, 'node' | 'path'>,
): PLCBindMenuResolution | null {
  const node = menuTarget.node;
  const manager = viewer.signalBindingManager;
  if (!manager || !node || !declaresPLCSignal(node)) return null;

  const target = findSignalBindTarget(viewer, node);
  if (!target) return null;
  if (!signalBindEligibility(viewer, target).eligible) return null;

  const nodePath = viewer.registry?.getPathForNode(node)
    ?? menuTarget.path
    ?? NodeRegistry.computeNodePath(node);
  const rootPath = viewer.registry?.getPathForNode(target.node)
    ?? NodeRegistry.computeNodePath(target.node);
  const relPath = relativePathUnder(rootPath, nodePath);

  // The slot OF THIS NODE must be present and bindable — an ancestor's slots
  // are explicitly not an acceptable substitute.
  const slots = manager.getElementSlots(signalBindTargetId(target), target.node);
  const mine = slots.some((slot) => slot.kind !== 'unavailable'
    && slot.slot === PLC_SIGNAL_SLOT
    && slot.componentPath === relPath
    && slot.componentType !== undefined
    && SIGNAL_TYPES.includes(baseComponentType(slot.componentType)));
  if (!mine) return null;

  const placement = target.kind === 'placed' ? (target.label ?? target.node.name) : null;
  return {
    target,
    label: placement ? `Link signal… (on ${placement})` : 'Link signal…',
  };
}

/** The context-menu items contributed by the signal-bind plugin. */
export function signalBindContextMenuItems(viewer: RVViewer): ContextMenuItem[] {
  return [{
    id: 'signal-bind.link-signal',
    // Resolved eagerly at open() time, right after `condition` said yes.
    label: (menuTarget) => resolvePLCBindMenuTarget(viewer, menuTarget)?.label ?? 'Link signal…',
    icon: 'link',
    order: 55,
    condition: (menuTarget) => resolvePLCBindMenuTarget(viewer, menuTarget) !== null,
    action: (menuTarget) => {
      const resolved = resolvePLCBindMenuTarget(viewer, menuTarget);
      if (resolved) openSignalBindPopover(resolved.target);
    },
  }];
}

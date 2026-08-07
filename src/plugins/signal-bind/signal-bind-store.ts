// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-bind-store.ts — tiny external store holding the element the Signal-Bind
 * popover is currently editing.
 *
 * The badge controller / inspector sets the active target (placedId + node) and
 * shows the AnchoredPopover under id `'signal-bind'`; the registered content
 * (`SignalBindPopover`) reads this snapshot. Kept separate from the popover so
 * the content component itself stays a pure, prop-testable React component.
 */

import { Vector3, type Object3D } from 'three';
import { popoverStore } from '../../core/hmi/popover-store';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import type { SignalBindTarget } from './signal-bind-target';
export type { SignalBindTarget } from './signal-bind-target';

class SignalBindStore {
  private _target: SignalBindTarget | null = null;
  private readonly _listeners = new Set<() => void>();

  subscribe = (l: () => void): (() => void) => { this._listeners.add(l); return () => { this._listeners.delete(l); }; };
  getSnapshot = (): SignalBindTarget | null => this._target;

  setTarget(target: SignalBindTarget | null): void {
    this._target = target;
    this._notify();
  }

  clear(): void { this.setTarget(null); }

  private _notify(): void { for (const l of this._listeners) l(); }
}

export const signalBindStore = new SignalBindStore();

/**
 * Open the Signal-Bind popover for a placed element, anchored at its world
 * position (the popover follows the element during orbit/move). Called by the
 * 3D badge click and the inspector "Bind…" action.
 */
export function openSignalBindPopover(target: SignalBindTarget): void {
  signalBindStore.setTarget(target);
  const tmp = new Vector3();
  popoverStore.show({
    id: 'signal-bind',
    // Full hierarchy path of the element (falls back to label/name).
    title: NodeRegistry.computeNodePath(target.node) || target.label || target.node.name,
    getWorld: () => {
      target.node.getWorldPosition(tmp);
      return [tmp.x, tmp.y, tmp.z];
    },
    onClose: () => signalBindStore.clear(),
  });
}

/** Close the Signal-Bind popover (if open) and forget the target. */
export function closeSignalBindPopover(): void {
  popoverStore.hide('signal-bind');
  signalBindStore.clear();
}

/**
 * Nearest enclosing LayoutObject ROOT node (self included), or null if the node
 * is not inside a placed LayoutObject. The root carries
 * `userData.realvirtual.LayoutObject` and its `name` is the de-duplicated
 * placement name (`RollConveyor2m_2`).
 */
export function layoutObjectRoot(node: Object3D): Object3D | null {
  let cur: Object3D | null = node;
  while (cur) {
    const rv = cur.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv && rv.LayoutObject) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Map a CONNECT-discovered signal direction (`input`/`output`/`unknown`) to the
 * planner `SignalLinkDirection`. CONNECT `output` = read by viewer = `plcOutput`;
 * `input` = written by viewer = `plcInput`. `unknown` defaults to the slot's own
 * declared direction (passed by the caller).
 */
export function mapDiscoveredDirection(
  discovered: 'input' | 'output' | 'unknown',
  slotDefault: 'plcInput' | 'plcOutput',
): 'plcInput' | 'plcOutput' {
  if (discovered === 'output') return 'plcOutput';
  if (discovered === 'input') return 'plcInput';
  return slotDefault;
}

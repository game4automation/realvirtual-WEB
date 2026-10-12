// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * layout-predicates.ts — Pure predicate functions for layout instance detection.
 *
 * Extracted to a leaf module to break circular dependencies between
 * index.ts, canvas-interaction.ts, and multi-select-pivot.ts.
 */

import type { Object3D } from 'three';

/** True if the Object3D is a layout instance placed by the planner. */
export function isLayoutInstance(obj: Object3D): boolean {
  return typeof obj.userData?._layoutId === 'string' && !obj.userData?._isGhost;
}

/**
 * True if the Object3D is a spawned MU registered as a selectable scene node
 * (transient, sim-owned — NOT a persisted layout placement). Marked by the
 * MU reconciler with `_muSelectable`; never carries `_layoutId`.
 */
export function isMuSelectable(obj: Object3D): boolean {
  return obj.userData?._muSelectable === true;
}

/**
 * True if the Object3D is a simulation object of the scene that must stay
 * clickable while an authoring mode (planner, DES) filters picks — e.g. an Agv
 * vehicle, whose inspector and DES statistics are the point of selecting it.
 * Set by the component on its own node (`_rvSimSelectable`). Unlike
 * `_muSelectable` it is authored content: persisted, exported, never deleted —
 * and, like an MU, never movable (no `_layoutId`, so no transform gizmo).
 */
export function isSimSelectable(obj: Object3D): boolean {
  return obj.userData?._rvSimSelectable === true;
}

/** True if the Object3D can be selected in the planner (layout, spawned MU or sim object). */
export function isPlannerSelectable(obj: Object3D): boolean {
  return isLayoutInstance(obj) || isMuSelectable(obj) || isSimSelectable(obj);
}

/** Walk parent chain to the nearest planner-selectable ancestor (layout or MU). */
export function findPlannerSelectableAncestor(obj: Object3D): Object3D | null {
  let cur: Object3D | null = obj;
  while (cur) {
    if (isPlannerSelectable(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** True if the layout instance has been locked against editing. */
export function isLockedLayoutInstance(obj: Object3D): boolean {
  const rv = obj.userData?.realvirtual as Record<string, unknown> | undefined;
  const lo = rv?.LayoutObject as Record<string, unknown> | undefined;
  return !!lo?.Locked;
}

/** Walk parent chain to find the nearest layout-instance ancestor (or self). */
export function findLayoutAncestor(obj: Object3D): Object3D | null {
  let cur: Object3D | null = obj;
  while (cur) {
    if (isLayoutInstance(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

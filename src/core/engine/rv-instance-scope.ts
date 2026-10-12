// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Per-instance signal scoping for placed library assets.
 *
 * Signals are keyed globally by name in the SignalStore, so two placed copies of
 * the same library asset would collide on names like `Flow.Run` or `Sensor`.
 * To isolate them, signal names are prefixed with the nearest enclosing
 * LayoutObject root name (which the layout planner de-duplicates per placement,
 * e.g. `RollConveyor2m`, `RollConveyor2m_1`, `RollConveyor2m_2` — the `_N`
 * rule of `rv-node-naming`, plan-758).
 *
 * Both producers of a scoped name (the behavior bind context for declared signals,
 * and RVSensor for its occupied signal) derive the scope from the SAME LayoutObject
 * root, so the names always meet.
 */

import type { Object3D } from 'three';

/**
 * Nearest enclosing LayoutObject root name (self included), or '' if the node is
 * not inside a placed LayoutObject (i.e. a standalone-loaded asset).
 *
 * A LayoutObject root is marked by `userData.realvirtual.LayoutObject` (set in the
 * layout planner's `addPlacedToScene`).
 */
export function instanceScope(node: Object3D): string {
  // plan-589: the FULL chain of enclosing placement roots, outermost first
  // (`Cell.Conv`). For the ordinary one-level placement this is exactly the
  // previous result (the root name); it only grows for a NESTED placement — a
  // reference node inside a placed asset that became a placement of its own
  // (plan-757). Without the chain two nested copies of the same inner asset
  // under two copies of the same outer asset would collide on the inner name.
  const parts: string[] = [];
  for (let cur: Object3D | null = node; cur; cur = cur.parent) {
    if (isScopeRoot(cur)) parts.push(cur.name);
  }
  return parts.reverse().join('.');
}

/**
 * True for a node that opens a signal scope: a planner record's placement root
 * (`realvirtual.LayoutObject`) or a NESTED placement root, which carries no
 * `LayoutObject` stamp but `_layoutNestedOf` (`rv-placement-instancer.ts`
 * `stampNestedPlacementMarkers`). Read inline instead of importing
 * `isNestedPlacementRoot` — the instancer imports half the engine, this module
 * is deliberately dependency-free.
 */
function isScopeRoot(node: Object3D): boolean {
  const ud = node.userData as Record<string, unknown> | undefined;
  if (!ud) return false;
  if (typeof ud._layoutNestedOf === 'string') return true;
  const rv = ud.realvirtual as Record<string, unknown> | undefined;
  return !!(rv && rv.LayoutObject);
}

/**
 * INNERMOST enclosing placement root NODE (self included), or null if the node
 * is not inside a placement. Same walk as {@link instanceScope}, but returns
 * the node itself — used to host the per-component `Signals` container (ONE
 * folder per component, all component signals inside).
 */
export function instanceScopeNode(node: Object3D): Object3D | null {
  let cur: Object3D | null = node;
  while (cur) {
    if (isScopeRoot(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Apply an instance scope to a signal name.
 *   - `''` scope (standalone) → name unchanged (backward compatible).
 *   - leading `/` → global signal: strip the `/`, never prefix (shared E-stop etc.).
 *   - otherwise → `${scope}.${name}`.
 *
 * The scoped name is the PLC-facing SYMBOL (`SignalStore.byName`), which is
 * `.`-separated throughout (`RollConveyor-1m.Flow.Occupied`) so the symbol is a
 * single dotted token. The scene-graph NODE path stays `/`-separated and is built
 * elsewhere (it is the technical hierarchy address, not the PLC symbol).
 */
export function scopeSignalName(scope: string, name: string): string {
  if (name.startsWith('/')) return name.slice(1);
  return scope ? `${scope}.${name}` : name;
}

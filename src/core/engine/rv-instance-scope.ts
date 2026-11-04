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
 *
 * plan-559 Phase 2a: an EMBEDDED copy (part of the document itself, not a
 * placement) opens the same kind of scope with the marker component
 * `InstanceScope`. Its scope name is the NAME of the node `PrefixNode` points
 * at — the node carrying the marker when the field is empty (modelled on
 * `GroupNamePrefix`). Without the marker nothing changes: a model without an
 * `InstanceScope` gets bit-identical signal names.
 */

import type { Object3D } from 'three';

/** Component key of the embedded-copy scope marker (plan-559 Phase 2a). */
export const INSTANCE_SCOPE_TYPE = 'InstanceScope';

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
  // plan-559 Phase 2a: an `InstanceScope` marker is one more link of the chain,
  // named after its `PrefixNode`.
  const parts: string[] = [];
  for (let cur: Object3D | null = node; cur; cur = cur.parent) {
    if (isPlacementScopeRoot(cur)) parts.push(cur.name);
    else if (hasInstanceScopeMarker(cur)) parts.push(instanceScopeMarkerName(cur));
  }
  return parts.reverse().join('.');
}

/**
 * True for a node that opens a signal scope: a placement root (see
 * {@link isPlacementScopeRoot}) or an embedded copy carrying the
 * `InstanceScope` marker (plan-559 Phase 2a).
 */
function isScopeRoot(node: Object3D): boolean {
  return isPlacementScopeRoot(node) || hasInstanceScopeMarker(node);
}

/**
 * True for a PLACEMENT root: a planner record's placement root
 * (`realvirtual.LayoutObject`) or a NESTED placement root, which carries no
 * `LayoutObject` stamp but `_layoutNestedOf` (`rv-placement-instancer.ts`
 * `stampNestedPlacementMarkers`). Read inline instead of importing
 * `isNestedPlacementRoot` — the instancer imports half the engine, this module
 * is deliberately dependency-free.
 */
function isPlacementScopeRoot(node: Object3D): boolean {
  const ud = node.userData as Record<string, unknown> | undefined;
  if (!ud) return false;
  if (typeof ud._layoutNestedOf === 'string') return true;
  // plan-612 #149: a reference node whose placement has not materialised yet
  // IS already that placement's root. The main model binds a component sitting
  // ON the reference node (PalletYard: `Agv` on `Stapler_1..3`) before the
  // instancer stamps it; without this the early bind declared the bare
  // `Agv.Run` for every copy (one shared status + `instance-signal-collision`)
  // instead of the `Stapler_1.Agv.Run` the materialised placement uses.
  // `_rvDeferredPlacement` = `RV_DEFERRED_PLACEMENT_KEY` (load → queued),
  // `_rvPlacementPending` = queued → stamped (`PlacementInstancer`); literals
  // keep this module dependency-free.
  if (ud._rvDeferredPlacement && typeof ud._rvDeferredPlacement === 'object') return true;
  if (ud._rvPlacementPending === true) return true;
  const rv = ud.realvirtual as Record<string, unknown> | undefined;
  return !!(rv && rv.LayoutObject);
}

/** The `InstanceScope` record of a node, or undefined. */
function instanceScopeData(node: Object3D): Record<string, unknown> | undefined {
  const rv = (node.userData as Record<string, unknown> | undefined)?.realvirtual as
    Record<string, unknown> | undefined;
  const data = rv?.[INSTANCE_SCOPE_TYPE];
  return data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
}

/** The node carries an enabled `InstanceScope` marker (plan-559 Phase 2a). */
function hasInstanceScopeMarker(node: Object3D): boolean {
  const data = instanceScopeData(node);
  return !!data && data._enabled !== false;
}

/** `_N` dedup suffix of a Three.js-deduplicated node name (`rv-node-naming`). */
const DEDUP_SUFFIX = /_\d+$/;

/** Resolved prefix name per marker node, keyed by the authored path it came from. */
const _prefixCache = new WeakMap<Object3D, { path: string; name: string }>();

/** Authored path of `PrefixNode` (a ComponentReference record or a bare path string), '' when unset. */
function prefixPathOf(node: Object3D): string {
  const ref = instanceScopeData(node)?.PrefixNode;
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object') {
    const path = (ref as Record<string, unknown>).path;
    if (typeof path === 'string') return path;
  }
  return '';
}

/** Child of `parent` named `segment` — exact first, then its `_N` deduplicated spelling. */
function childNamed(parent: Object3D, segment: string): Object3D | null {
  let dedup: Object3D | null = null;
  for (const c of parent.children) {
    if (c.name === segment) return c;
    if (!dedup && c.name.replace(DEDUP_SUFFIX, '') === segment) dedup = c;
  }
  return dedup;
}

/** Walk `segments` down from `base`; null when a segment has no child. */
function descend(base: Object3D, segments: readonly string[]): Object3D | null {
  let cur: Object3D | null = base;
  for (const seg of segments) {
    if (!cur) return null;
    cur = childNamed(cur, seg);
  }
  return cur;
}

/**
 * Resolve `PrefixNode` of a marker node WITHOUT a registry — signals are
 * scoped during the load traversal, before any reference is resolved, and this
 * module stays dependency-free. The path is asset-relative (or root-inclusive,
 * the Unity form), so it is tried against the marker node and each ancestor,
 * innermost first: as written, then with a first segment equal to that
 * ancestor's name stripped. The innermost hit wins, so two embedded copies each
 * find the target inside their own subtree.
 */
function resolvePrefixNode(marker: Object3D, path: string): Object3D | null {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return marker;
  const head = segments[0];
  for (let base: Object3D | null = marker; base; base = base.parent) {
    const asWritten = descend(base, segments);
    if (asWritten) return asWritten;
    if (base.name === head || base.name.replace(DEDUP_SUFFIX, '') === head) {
      const stripped = descend(base, segments.slice(1));
      if (stripped) return stripped;
    }
  }
  return null;
}

/**
 * Scope name an `InstanceScope` marker opens: the NAME of its `PrefixNode`,
 * or of the marker node itself when the field is empty or does not resolve
 * (warned once per marker and path).
 */
export function instanceScopeMarkerName(node: Object3D): string {
  const path = prefixPathOf(node);
  if (path === '') return node.name;
  const cached = _prefixCache.get(node);
  if (cached && cached.path === path) return cached.name;
  const target = resolvePrefixNode(node, path);
  if (!target) {
    console.warn(`[InstanceScope] '${node.name}': PrefixNode '${path}' not found — using the node's own name`);
  }
  const name = target ? target.name : node.name;
  _prefixCache.set(node, { path, name });
  return name;
}

/** Forget the resolved `PrefixNode` of a marker node (its field was edited). */
export function invalidateInstanceScopeMarker(node: Object3D): void {
  _prefixCache.delete(node);
}

/**
 * INNERMOST enclosing placement root NODE (self included), or null if the node
 * is not inside a placement. Same walk as {@link instanceScope}, but returns
 * the node itself — used to host the per-component `Signals` container (ONE
 * folder per component, all component signals inside). An `InstanceScope`
 * marker node counts as such a root (plan-559 Phase 2a).
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
 * INNERMOST enclosing PLACEMENT root (self included), or null — like
 * {@link instanceScopeNode}, but an `InstanceScope` marker does not count. For
 * the rules that are about placements and nothing else: the
 * `signal-name-collision` warning (two placed copies share an authored name)
 * and the rename blocker (a placed signal is renamed in its asset).
 */
export function placementScopeNode(node: Object3D): Object3D | null {
  let cur: Object3D | null = node;
  while (cur) {
    if (isPlacementScopeRoot(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * Scoped id of a node that names an INSTANCE itself (a vehicle, plan-559 2b):
 * the scope chain of the ENCLOSING scope roots, then `name` — `Cell.Machine_1.Agv`.
 *
 * Unlike {@link instanceScope} the node's own scope link is NOT part of the
 * prefix: a vehicle whose component sits on its placement root (`Stapler_1`)
 * keeps the id `Stapler_1`, not `Stapler_1.Stapler_1`; a vehicle on a child of
 * the placement root (`Stapler_3/AGV_Stacker`) becomes `Stapler_3.AGV_Stacker`.
 * Outside every scope the result is exactly `name` (old scenes bit-identical).
 * No `/` global rule here — that is a signal-name convention only.
 */
export function scopedInstanceId(node: Object3D, name: string): string {
  const scope = node.parent ? instanceScope(node.parent) : '';
  return scope ? `${scope}.${name}` : name;
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

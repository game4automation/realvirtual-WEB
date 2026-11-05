// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-mapping-address — the stored form of a `SignalMapping` (plan-769 F15, Phase 3b).
 *
 * In memory a mapping names its component node by `componentPath` (relative to the bind
 * target: a placement root or a carrier node; `'.'` = the target itself) — the slot
 * resolver, the inspector rows and the MCP tools all speak paths. WHAT IS STORED (the
 * scene GLB's `PlacementMeta.signalMappings`, a node's `SignalLinks.Mappings`, a layout
 * file / autosave) names it by ADDRESS instead:
 *
 *  - `componentAddress` — relative to the bind target's document (§ 2.3): `#<id>` of the
 *    component node in the placement's ASSET (its content occurrence), `'.'` → the asset
 *    root's id; for a carrier node, `#<id>` in the document the carrier lies in;
 *  - `sourceAddress` — for `sourceKind: 'internal'`, the address of the source signal's
 *    node relative to the MAIN document (the signal store's name stays in `signal`: names
 *    are what CONNECT / PLC speak, D12; the address keeps an internal source bound across
 *    a signal rename).
 *
 * {@link toStoredMapping} / {@link fromStoredMapping} are the two directions; a mapping
 * whose component cannot be addressed keeps its `componentPath` (nothing is lost).
 */

import type { Object3D } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import type { SignalStore } from './rv-signal-store';
import type { SignalMapping } from '../../plugins/layout-planner/rv-layout-store';
import { ADDRESS_SEPARATOR, ROOT_OCCURRENCE } from './rv-node-id';
import { relativeAddress } from './rv-reference-writer';
import { relativeComponentPath } from './rv-binding-slot-resolver';

/** The occurrence a bind target's mappings are relative to: a placement's content, else its document. */
function scopeOccurrenceOf(registry: NodeRegistry, bindRoot: Object3D): string | null {
  return registry.isReferenceNode(bindRoot) ? registry.contentOccurrenceOf(bindRoot) : registry.docOccurrenceOf(bindRoot);
}

/** The node a root-relative `componentPath` names below `bindRoot` (`'.'` = the root). */
function nodeAtComponentPath(registry: NodeRegistry, bindRoot: Object3D, componentPath: string): Object3D | null {
  if (componentPath === '.' || componentPath === '') return bindRoot;
  const rootPath = registry.getPathForNode(bindRoot);
  const full = rootPath ? `${rootPath}/${componentPath}` : componentPath;
  return registry.getNode(full) ?? registry.resolvePath(componentPath, bindRoot);
}

/** `componentAddress` of `node` relative to `bindRoot`, or null. */
export function componentAddressOf(registry: NodeRegistry, bindRoot: Object3D, node: Object3D): string | null {
  const occ = scopeOccurrenceOf(registry, bindRoot);
  if (occ === null) return null;
  if (node === bindRoot && registry.isReferenceNode(bindRoot)) {
    // The placement root IS the asset's content root — its forward-only entry.
    const rootId = registry.contentRootIdOf(bindRoot) ?? registry.identityOfOccurrence(occ)?.contentRootId ?? null;
    return rootId ? `${ADDRESS_SEPARATOR}${rootId}` : null;
  }
  const abs = registry.getAddressForNode(node);
  return abs ? relativeAddress(occ, abs) : null;
}

/** The stored copy of an in-memory mapping (see the module doc). */
export function toStoredMapping(
  mapping: SignalMapping,
  bindRoot: Object3D | null,
  registry: NodeRegistry | null,
  store?: SignalStore | null,
): SignalMapping {
  const out: SignalMapping = { ...mapping };
  if (!bindRoot || !registry) return out;
  if (typeof mapping.componentPath === 'string') {
    const node = nodeAtComponentPath(registry, bindRoot, mapping.componentPath);
    const address = node ? componentAddressOf(registry, bindRoot, node) : null;
    if (address) {
      out.componentAddress = address;
      delete out.componentPath;
    }
  }
  // In-memory marker — never written.
  delete out.sourceUnresolved;
  // A carried address is kept, never re-derived from the name (doc-node-paths.md § 5.4).
  if (mapping.sourceKind === 'internal' && typeof mapping.sourceAddress === 'string' && mapping.sourceAddress) {
    return out;
  }
  if (mapping.sourceKind === 'internal' && store && mapping.signal) {
    const path = store.getPath(mapping.signal);
    const node = path ? registry.getNode(path) : null;
    const abs = node ? registry.getAddressForNode(node) : null;
    const rel = abs ? relativeAddress(ROOT_OCCURRENCE, abs) : null;
    if (rel) out.sourceAddress = rel;
  }
  return out;
}

/** What an internal source's `sourceAddress` names right now. */
export type SourceAddressResolution =
  | { status: 'resolved'; name: string; path: string }
  | { status: 'pending' }
  | { status: 'missing' };

/** `sourceAddress` (main document) to the signal name its node carries now; never a stored name. */
export function resolveSourceAddress(
  registry: NodeRegistry,
  store: SignalStore,
  sourceAddress: string,
): SourceAddressResolution {
  const r = registry.resolveRefInOccurrence(ROOT_OCCURRENCE, { address: sourceAddress });
  if (r.status === 'pending') return { status: 'pending' };
  if (r.status !== 'resolved') return { status: 'missing' };
  const path = registry.getPathForNode(r.node);
  const name = path ? store.exactNameForPath(path) : undefined;
  return name && path ? { status: 'resolved', name, path } : { status: 'missing' };
}

/**
 * The in-memory copy of a stored mapping: `componentPath` derived from
 * `componentAddress` when it is missing (a node the address names no more keeps the
 * address only — the binding manager then reports it unresolved), and the signal NAME
 * of an internal source taken from `sourceAddress`; a miss marks `sourceUnresolved`
 * (no name fallback, doc-node-paths.md § 5.4).
 */
export function fromStoredMapping(
  mapping: SignalMapping,
  bindRoot: Object3D | null,
  registry: NodeRegistry | null,
  store?: SignalStore | null,
): SignalMapping {
  const out: SignalMapping = { ...mapping };
  delete out.sourceUnresolved;
  if (!bindRoot || !registry) return out;
  if (out.componentPath === undefined && typeof out.componentAddress === 'string' && out.componentAddress) {
    const node = registry.resolveAddressIn(bindRoot, out.componentAddress);
    if (node) out.componentPath = relativeComponentPath(bindRoot, node, registry);
  }
  if (out.sourceKind === 'internal' && typeof out.sourceAddress === 'string' && out.sourceAddress && store) {
    const r = resolveSourceAddress(registry, store, out.sourceAddress);
    if (r.status === 'resolved') out.signal = r.name;
    else out.sourceUnresolved = r.status;
  }
  return out;
}

/** The placement root a planner record id is rooted at (`_layoutId`), or null. */
export function placementRootOf(registry: NodeRegistry, placedId: string): Object3D | null {
  let hit: Object3D | null = null;
  registry.forEachNode((_p, n) => {
    if (!hit && (n.userData as Record<string, unknown> | undefined)?._layoutId === placedId) hit = n;
  });
  return hit;
}

/**
 * How a placement's in-memory mapping is STORED: the planner plugin installs the
 * converter (it knows the live placement roots); without one (tests, a planner without a
 * viewer) a mapping is stored as it is. Read by the layout serializer and the planner save.
 */
let storedMappingConverter: ((placementId: string, mapping: SignalMapping) => SignalMapping) | null = null;

/** Install (or clear) the stored-mapping converter. */
export function setStoredSignalMappingConverter(
  fn: ((placementId: string, mapping: SignalMapping) => SignalMapping) | null,
): void {
  storedMappingConverter = fn;
}

/** Is a converter installed? */
export function hasStoredSignalMappingConverter(): boolean {
  return storedMappingConverter !== null;
}

/** A placement's mappings in their stored form. */
export function storedSignalMappingsOf(
  placement: { id: string; signalMappings?: SignalMapping[] },
): SignalMapping[] | undefined {
  const list = placement.signalMappings;
  const convert = storedMappingConverter;
  return list && convert ? list.map((m) => convert(placement.id, m)) : list;
}

/** Does any mapping still name its component by path only? (cheap pre-check) */
export function hasPathOnlyMapping(mappings: readonly SignalMapping[] | undefined): boolean {
  return !!mappings?.some((m) => typeof m.componentPath === 'string' && !m.componentAddress);
}


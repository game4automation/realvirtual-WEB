// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-extras-overlay-store.ts — Overlay store for rv-extras overrides.
 *
 * Provides CRUD operations for a user-defined overlay that can modify
 * component properties on GLB nodes without altering the original GLB file.
 *
 * Overlays follow RFC 7396 JSON Merge Patch semantics:
 * - Setting a field to a value replaces it
 * - Setting a field to null deletes it
 *
 * Persistence: localStorage keyed by `rv-extras-overlay:${glbName}`.
 * Import/export: JSON files with `.rv-overrides.json` extension.
 */

import type { Object3D } from 'three';
import { applyComponentPatch } from './rv-asset-reference';
import type { ComponentPatch, OrphanedOverride } from './rv-asset-reference';
import { ROOT_OCCURRENCE } from './rv-node-id';

// ─── Types ───────────────────────────────────────────────────────────────

/** Structure of an extras overlay document. */
export interface RVExtrasOverlay {
  /** Schema identifier for validation. */
  $schema: 'rv-extras-overlay/1.0';
  /** Human-readable source description (e.g. 'manual edit', 'imported'). */
  $source: string;
  /**
   * Overlay data: nodePath -> componentType -> fieldName -> value.
   * A null value means "delete this field" (RFC 7396).
   */
  nodes: Record<string, Record<string, Record<string, unknown>>>;
}

// ─── localStorage Key ────────────────────────────────────────────────────

function storageKey(glbName: string): string {
  return `rv-extras-overlay:${glbName}`;
}

// ─── CRUD ────────────────────────────────────────────────────────────────

/**
 * Load an overlay from localStorage for the given GLB name.
 * Returns null if no overlay is stored or if parsing fails.
 *
 * @deprecated The unified Scene model stores overlays inside `RvScene.overlay`
 * (see `src/core/hmi/scene/rv-scene-types.ts`). This per-GLB keyspace is
 * retained only as a boot-path fallback for direct `?model=` loads that did
 * not go through SceneStore. New code should not write here.
 */
export function loadOverlay(glbName: string): RVExtrasOverlay | null {
  try {
    const raw = localStorage.getItem(storageKey(glbName));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RVExtrasOverlay;
    if (parsed.$schema !== 'rv-extras-overlay/1.0') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save an overlay to localStorage for the given GLB name.
 *
 * @deprecated See `loadOverlay`. Overlays now live on `RvScene.overlay`.
 */
export function saveOverlay(glbName: string, overlay: RVExtrasOverlay): void {
  localStorage.setItem(storageKey(glbName), JSON.stringify(overlay));
}

// ─── Merge / Apply ──────────────────────────────────────────────────────

/**
 * Apply overlay fields onto a node's userData.realvirtual per RFC 7396.
 *
 * For each componentType in the overlay for this nodePath, merges fields
 * into `node.userData.realvirtual[componentType]`. A null value deletes
 * the corresponding field.
 *
 * @returns true if any field was changed.
 */
export function applyOverlayToNode(
  node: Object3D,
  nodePath: string,
  overlay: RVExtrasOverlay,
): boolean {
  const nodeOverrides = overlay.nodes[nodePath];
  if (!nodeOverrides) return false;
  // The merge itself lives in rv-asset-reference: the path-keyed overlay and the
  // NodeId-keyed asset overrides must mean the SAME thing by `null`, and two
  // copies of that rule is precisely how they would come to disagree.
  return applyComponentPatch(node, nodeOverrides as ComponentPatch);
}

/**
 * Apply an overlay whose keys are `NodeId`s rather than node paths (plan-397).
 *
 * The second addressing axis: a path breaks the moment somebody renames a node
 * in a referenced asset, a `NodeId` does not. Same RFC 7396 semantics, same
 * merge implementation — only the lookup differs.
 *
 * Resolution order per plan Phase 1: `NodeId` first, then whatever fallback the
 * caller's resolver implements, then ORPHANED. An override that finds no target
 * is returned, never dropped: the user's decision was that a verwaister Override
 * is reported, and a function that swallows it makes reporting impossible
 * upstream.
 *
 * @param byNodeId NodeId → merge patch.
 * @param resolve  Looks a NodeId up in the frame the overlay belongs to.
 * @param context  Occurrence/asset labels carried into the orphan report.
 */
export function applyOverlayByNodeId(
  byNodeId: Record<string, ComponentPatch>,
  resolve: (nodeId: string) => Object3D | null,
  context: { occurrence?: string; assetId?: string } = {},
): { applied: number; orphaned: OrphanedOverride[] } {
  const orphaned: OrphanedOverride[] = [];
  let applied = 0;

  for (const [nodeId, patch] of Object.entries(byNodeId)) {
    const target = resolve(nodeId);
    if (!target) {
      orphaned.push({
        addressing: 'nodeId',
        key: nodeId,
        occurrence: context.occurrence ?? ROOT_OCCURRENCE,
        assetId: context.assetId ?? '',
        componentTypes: Object.keys(patch ?? {}),
      });
      continue;
    }
    if (applyComponentPatch(target, patch)) applied++;
  }

  return { applied, orphaned };
}

// ─── Originals Sidecar (persist original GLB values for reset after reload) ──

function originalsKey(glbName: string): string {
  return `rv-extras-originals:${glbName}`;
}

/**
 * Save the originals map to localStorage as a sidecar to the overlay.
 * Only stores values for fields that have been overridden.
 */
export function saveOriginals(glbName: string, originals: Map<string, unknown>): void {
  if (originals.size === 0) {
    localStorage.removeItem(originalsKey(glbName));
    return;
  }
  const obj: Record<string, unknown> = {};
  for (const [k, v] of originals) {
    obj[k] = v;
  }
  try {
    localStorage.setItem(originalsKey(glbName), JSON.stringify(obj));
  } catch {
    // LS quota exceeded — silently ignore (reset will use scene values)
  }
}

/**
 * Load the originals sidecar from localStorage.
 * Returns a Map keyed by `nodePath/componentType/fieldName`.
 */
export function loadOriginals(glbName: string): Map<string, unknown> {
  try {
    const raw = localStorage.getItem(originalsKey(glbName));
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

/**
 * Remove specific entries from the persisted originals sidecar.
 */
export function removeOriginals(glbName: string, keys: string[]): void {
  if (keys.length === 0) return;
  const originals = loadOriginals(glbName);
  for (const k of keys) originals.delete(k);
  saveOriginals(glbName, originals);
}

// ─── Query ──────────────────────────────────────────────────────────────

/**
 * Get the list of field names that are overridden for a specific node and component.
 * Returns an empty array if the node/component has no overrides.
 */
export function getOverriddenFields(
  nodePath: string,
  componentType: string,
  overlay: RVExtrasOverlay,
): string[] {
  const nodeOverrides = overlay.nodes[nodePath];
  if (!nodeOverrides) return [];
  const compOverrides = nodeOverrides[componentType];
  if (!compOverrides) return [];
  return Object.keys(compOverrides);
}

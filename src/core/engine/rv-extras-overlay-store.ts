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
 */
export function saveOverlay(glbName: string, overlay: RVExtrasOverlay): void {
  localStorage.setItem(storageKey(glbName), JSON.stringify(overlay));
}

/**
 * Clear (remove) the overlay for the given GLB name from localStorage.
 */
export function clearOverlay(glbName: string): void {
  localStorage.removeItem(storageKey(glbName));
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

  // Ensure userData.realvirtual exists
  const userData = node.userData as Record<string, unknown>;
  let rv = userData['realvirtual'] as Record<string, Record<string, unknown>> | undefined;
  if (!rv) {
    rv = {};
    userData['realvirtual'] = rv;
  }

  let changed = false;

  for (const [componentType, fields] of Object.entries(nodeOverrides)) {
    if (!rv[componentType]) {
      rv[componentType] = {};
    }
    const target = rv[componentType];

    for (const [fieldName, value] of Object.entries(fields)) {
      if (value === null) {
        // RFC 7396: null means delete
        if (fieldName in target) {
          delete target[fieldName];
          changed = true;
        }
      } else {
        if (target[fieldName] !== value) {
          target[fieldName] = value;
          changed = true;
        }
      }
    }
  }

  return changed;
}

// ─── Import / Export ────────────────────────────────────────────────────

/**
 * Trigger a browser download of the overlay as a `.rv-overrides.json` file.
 */
export function downloadOverlay(overlay: RVExtrasOverlay): void {
  const json = JSON.stringify(overlay, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'overlay.rv-overrides.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Import an overlay from a File. Validates the schema field.
 * @throws Error if the file cannot be parsed or has an invalid schema.
 */
export async function importOverlay(file: File): Promise<RVExtrasOverlay> {
  const text = await file.text();
  const parsed = JSON.parse(text) as RVExtrasOverlay;

  if (parsed.$schema !== 'rv-extras-overlay/1.0') {
    throw new Error(`Invalid overlay schema: expected 'rv-extras-overlay/1.0', got '${parsed.$schema}'`);
  }
  if (typeof parsed.nodes !== 'object' || parsed.nodes === null) {
    throw new Error('Invalid overlay: missing or invalid "nodes" field');
  }

  return parsed;
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

/**
 * Clear the entire originals sidecar for a GLB file.
 */
export function clearOriginals(glbName: string): void {
  localStorage.removeItem(originalsKey(glbName));
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

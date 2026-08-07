// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-op-utils — shared primitives for op-log documents.
 *
 * Extracted from `rv-scene-edits.ts` (which re-exports them unchanged) so the
 * asset editor's op log (`src/core/editor/rv-asset-ops.ts`) can share the
 * identity / cloning / coalescing-window primitives WITHOUT importing scene
 * types — the Scene op log and the Asset op log stay deliberately separate
 * documents (see doc-persistence.md).
 *
 * Pure module: no Three.js, no DOM, no storage.
 */

/** Max number of ops kept in an op history. Older ops drop off the front. */
export const MAX_OP_HISTORY = 500;

/** Coalesce window — adjacent same-target ops within this window merge. */
export const COALESCE_WINDOW_MS = 500;

/** Generate a fresh op id. Stable across save/load — never regenerate. */
export function freshOpId(): string {
  return 'op_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** Cheap deep-clone for JSON-safe values. Used to snapshot `prev` payloads for
 *  object/array values so later mutations of the live data don't retroactively
 *  change the stored inverse. */
export function deepCloneJSON<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

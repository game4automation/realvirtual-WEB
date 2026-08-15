// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-op-utils — the identity / cloning / window primitives of the op log.
 *
 * There is ONE op-log document class, {@link RvDocument} (`rv-document.ts`),
 * over ONE op vocabulary (`rv-unified-ops.ts`). The constants below are that
 * document's history cap and coalescing window, and `freshOpId` is where every
 * op id comes from. `SceneStore` and `AssetDocument` are facades over one
 * `RvDocument` instance each; what still differs between them is op
 * CONSTRUCTION (`hmi/scene/rv-scene-edits.ts` and `editor/rv-asset-ops.ts`,
 * both importing from here) and persistence — not the machinery.
 *
 * The module sits under `ops/` rather than beside either constructor so that
 * neither has to import the other's types; `rv-scene-edits.ts` re-exports all
 * four names unchanged for its existing callers.
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

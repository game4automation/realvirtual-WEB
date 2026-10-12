// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-classification — the two questions everything that RENDERS the scene
 * graph asks about a node (plan-754 Phase 2/3).
 *
 * Since the hierarchy panel became the scene graph itself, a row is classified
 * by exactly two predicates:
 *
 *   - **chunk** — the node is a mesh the bake produced (the merged triangles of
 *     one boundary × material). It is not registered, but it IS the document's
 *     geometry, so it carries its own badge and survives "hide runtime objects".
 *   - **runtime** — the `NodeRegistry` (the document's address book) does not
 *     know the node AND it is not a chunk mesh: a light, the floor, a gizmo, a
 *     hover overlay, a pooled MU. Read-only, hideable, not addressable by path.
 *
 * It lives in the engine because BOTH the HMI panel (`hierarchy-rows.ts`) and
 * the MCP observation layer (`rv-scene-snapshot.ts`, `rv-mcp-scene-tools.ts`)
 * must answer identically — F11 is precisely "the agent sees what the panel
 * sees". Engine is the only layer both may import (no engine → hmi).
 */

import type { Object3D } from 'three';

/**
 * Marker the bake writes on every chunk mesh.
 *
 * Deliberately a literal rather than an import of `RV_BAKE_CHUNK_KEY` from
 * `rv-bake-registry.ts`: this module is a leaf that the HMI and the MCP bridge
 * pull in for two predicates, and the registry drags the whole bake machinery
 * behind it. `rv-bake-pipeline.ts:396` mirrors the same key for the same reason.
 */
const RV_BAKE_CHUNK_KEY = '_rvBakeChunk';

/** Is this a chunk mesh — the merged triangles of one boundary × material? */
export function isChunkMesh(object: Object3D): boolean {
  return (object.userData as Record<string, unknown> | undefined)?.[RV_BAKE_CHUNK_KEY] === true;
}

/**
 * Is this node outside the document (D2)?
 *
 * `path` is what the registry answers for the node — `null` when it does not
 * know it. Passed in rather than looked up so the caller keeps its own (usually
 * already computed) lookup and this stays a pure predicate.
 */
export function isRuntimeNode(object: Object3D, path: string | null): boolean {
  return path === null && !isChunkMesh(object);
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The model root predicate (plan-715).
 *
 * The root of the loaded main GLB (`RVViewer.currentModelRoot`) is a real,
 * registered, round-trip-capable node — and it is the one node in the tree that
 * is structurally FROZEN: it cannot be renamed, transformed, hidden, deleted or
 * reparented, because its name is the first segment of every node path
 * (`doc-node-paths.md`) and its pose is the asset's 0,0,0 reference.
 *
 * Before this module that rule lived as nine separate `node === viewer.currentModelRoot`
 * comparisons scattered across delete, transform, kinematics, MCP, the document
 * and the hierarchy — which is exactly why three write paths (rename, transform,
 * visibility) had simply never grown one.
 *
 * ## Why `(node, root)` and not `(node, viewer)`
 *
 * The signature deliberately mirrors {@link isInsideReference} (`rv-reference-scope.ts`):
 * the caller passes the BOUNDARY object, not the viewer. No module under
 * `engine/` imports `RVViewer` today, and this predicate is not the one to start
 * — it would invert the layering for a single identity comparison.
 *
 * ## Identity, never name
 *
 * The comparison is object identity. Matching "the first child of the scene" or
 * a name would fold the planner's `_layoutRoot` (a SIBLING of the model root) in
 * with the model root, and would break for an empty or duplicated root name.
 */

import type { Object3D } from 'three';

/**
 * Is `node` the root of the loaded main GLB?
 *
 * `root` is `viewer.currentModelRoot`. Null/undefined on either side answers
 * false — "no model loaded" is a normal state, not an error.
 */
export function isModelRoot(
  node: Object3D | null | undefined,
  root: Object3D | null | undefined,
): boolean {
  return !!node && !!root && node === root;
}

/**
 * Is the node registered at `nodePath` the model root?
 *
 * The path-keyed form for the write paths (`AssetDocument`, MCP tools, the op
 * executors) which address nodes by path and would otherwise each repeat the
 * same registry lookup.
 */
export function isModelRootPath(
  nodePath: string | null | undefined,
  registry: { getNode(path: string): Object3D | null | undefined } | null | undefined,
  root: Object3D | null | undefined,
): boolean {
  if (!nodePath || !registry || !root) return false;
  return isModelRoot(registry.getNode(nodePath) ?? null, root);
}

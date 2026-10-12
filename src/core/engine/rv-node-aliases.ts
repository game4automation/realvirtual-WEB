// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-aliases.ts — the pre-dedup path spellings of a renamed subtree.
 *
 * Three.js dedups node names FILE-GLOBALLY, so a second `Pusher` becomes
 * `Pusher_1` and every exported path THROUGH it is dead. The cure is a set of
 * alias paths per affected node; computing them is the part that must exist
 * exactly once, because two consumers need the identical set:
 *
 *   - `registerNodeAliases` (rv-scene-loader.ts) — the RUNTIME registry, plus
 *     the SignalStore path aliases and the load diagnostics;
 *   - `buildPreBakeRegistry` (rv-pre-bake.ts) — the `prepare` registry the bake
 *     survival model resolves references against (plan-754 Phase 1c).
 *
 * A second copy of this walk would be invisible until the two registries
 * disagreed about which references resolve — which is exactly the bug this
 * module was extracted for: the alias-less `prepare` registry reported 2422
 * unresolved references on a model where the runtime registry reported 46.
 *
 * Semantics (unchanged from plan-381 F5 / plan-734 F3):
 *  - aliases cover the renamed node AND ITS WHOLE SUBTREE — the suffix fallback
 *    matches on the LEAF, never on a broken middle segment;
 *  - BOTH historical spellings are published, the RAW glTF name and the form
 *    Three.js sanitized it to, de-duplicated when they are equal (the common
 *    case, which must not cost a second registration);
 *  - the renamed set is reduced to its TOPMOST members first and each subtree
 *    is walked once behind a shared visited set, so nested renames stay linear.
 */

import type { Object3D } from 'three';
import { NodeRegistry } from './rv-node-registry';
import { sanitizeLikeThree } from './rv-three-names';

/**
 * Original path = current path with every renamed ANCESTOR (and the node
 * itself) spelled the way the glTF file spelled it.
 *
 * `spell` picks which spelling a renamed segment contributes: the raw glTF
 * name, or the form Three.js sanitized it to. Un-renamed ancestors always fall
 * back to `current.name` in BOTH passes — they were never touched, so there is
 * nothing to spell differently.
 */
function computeOriginalPath(
  node: Object3D,
  renamedNodes: ReadonlyMap<Object3D, string>,
  spell: (raw: string) => string,
): string {
  const parts: string[] = [];
  let current: Object3D | null = node;
  while (current && current.parent) {
    const raw = renamedNodes.get(current);
    parts.unshift(raw !== undefined ? spell(raw) : current.name);
    current = current.parent;
    if (!current.parent) break;
  }
  return parts.join('/');
}

const asRaw = (raw: string): string => raw;

/**
 * Visit every node that needs alias paths, with its CURRENT canonical path and
 * the historical spellings to publish for it.
 *
 * `aliasPaths` is never empty and never contains `currentPath`. A node whose
 * two spellings collapse onto the current one is skipped entirely, so a caller
 * can register unconditionally.
 */
export function forEachNodeAlias(
  renamedNodes: ReadonlyMap<Object3D, string>,
  visit: (node: Object3D, currentPath: string, aliasPaths: readonly string[]) => void,
): void {
  if (renamedNodes.size === 0) return;

  // Topmost renamed nodes only: a renamed node below another renamed node is
  // reached by the ancestor's traversal anyway.
  const roots: Object3D[] = [];
  for (const obj of renamedNodes.keys()) {
    let ancestor: Object3D | null = obj.parent;
    let covered = false;
    while (ancestor) {
      if (renamedNodes.has(ancestor)) { covered = true; break; }
      ancestor = ancestor.parent;
    }
    if (!covered) roots.push(obj);
  }

  const visited = new Set<Object3D>();
  for (const root of roots) {
    root.traverse((node: Object3D) => {
      if (visited.has(node)) return;
      visited.add(node);

      const currentPath = NodeRegistry.computeNodePath(node);
      const raw = computeOriginalPath(node, renamedNodes, asRaw);
      const sanitized = computeOriginalPath(node, renamedNodes, sanitizeLikeThree);
      const aliasPaths: string[] = [];
      if (raw !== currentPath) aliasPaths.push(raw);
      if (sanitized !== currentPath && sanitized !== raw) aliasPaths.push(sanitized);
      if (aliasPaths.length === 0) return;

      visit(node, currentPath, aliasPaths);
    });
  }
}

/**
 * Register every alias spelling of `renamedNodes` in `registry`.
 *
 * The registry-only half of {@link registerNodeAliases} (rv-scene-loader.ts),
 * for callers that have no SignalStore and no load diagnostics to feed — i.e.
 * the `prepare` registry of the destructive pipeline.
 *
 * @returns How many aliases were accepted and how many `registerAlias`
 *   discarded because the path was already claimed.
 */
export function registerNodeAliasesInRegistry(
  renamedNodes: ReadonlyMap<Object3D, string>,
  registry: NodeRegistry,
): { nodeAliases: number; droppedAliases: number } {
  let nodeAliases = 0;
  let droppedAliases = 0;
  forEachNodeAlias(renamedNodes, (node, _currentPath, aliasPaths) => {
    for (const aliasPath of aliasPaths) {
      if (registry.registerAlias(aliasPath, node)) nodeAliases++;
      else droppedAliases++;
    }
  });
  return { nodeAliases, droppedAliases };
}

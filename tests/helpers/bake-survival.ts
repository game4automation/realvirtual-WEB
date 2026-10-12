// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Helpers for the plan-754 survival tests (§9.1–9.3): a registry over a
 * synthetic tree, the survival fate of one node (sibling of `bakeFateOf`), and
 * the G1 assertion `expectNoClaimedNodeRemoved`.
 */
import { expect } from 'vitest';
import type { Object3D } from 'three';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import {
  findClaimedNodesInRemovalSet,
  type SurvivalModel,
  type SurvivalReason,
} from '../../src/core/engine/rv-bake-survival';

/** Path of `node` with the root's own name as the first segment (`Asset/A/B`). */
export function pathFromRoot(node: Object3D, root: Object3D): string {
  const parts: string[] = [];
  for (let n: Object3D | null = node; n; n = n.parent) {
    parts.unshift(n.name);
    if (n === root) break;
  }
  return parts.join('/');
}

/** A real `NodeRegistry` with every node of the tree registered by {@link pathFromRoot}. */
export function registryFor(root: Object3D): NodeRegistry {
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(pathFromRoot(n, root), n));
  return registry;
}

/** A raw ComponentReference as the GLB extras carry it. */
export function refTo(path: string, componentType = 'UnityEngine.Transform'): Record<string, unknown> {
  return { type: 'ComponentReference', path, componentType };
}

export type SurvivalFate = SurvivalReason | 'removed';

/** Why `node` survives, or `'removed'`. */
export function survivalFateOf(model: SurvivalModel, node: Object3D): SurvivalFate {
  return model.reasonOf(node) ?? 'removed';
}

/**
 * G1 (plan-754 §1): zero component-carrying, referenced, snap or plugin-claimed
 * nodes in the removal set, and no unresolved plugin claim. `isNeeded` adds
 * caller-side evidence (e.g. "has a constructed component in the registry").
 */
export function expectNoClaimedNodeRemoved(
  model: SurvivalModel,
  root: Object3D,
  isNeeded?: (node: Object3D) => boolean,
): void {
  const violations = findClaimedNodesInRemovalSet(model, isNeeded).map((n) => pathFromRoot(n, root));
  expect(violations, 'G1: claimed nodes inside the removal set').toEqual([]);
  expect(model.unresolvedClaims, 'G1: unresolved plugin claims').toEqual([]);
  // A removal top's parent survives and the top itself does not.
  for (const top of model.removalTops) {
    expect(model.survives(top)).toBe(false);
    expect(top.parent && model.survives(top.parent)).toBe(true);
  }
}

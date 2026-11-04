// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-baseline-placement-edits — the load half of plan-769 Phase 7 (D23).
 *
 * A placement that came in with the saved file has no `addPlacement` in the op
 * log, so `materialise()` keeps its move and its removal by id
 * (`baselinePlacementTransforms`, `removedPlacementIds`). The save writes them
 * onto the file (`rv-scene-glb-bake.ts`); THIS module applies the same edits to
 * a freshly loaded tree — the replay of a recovered draft tail through
 * `viewer.loadScene`.
 *
 * It runs inside `loadModel`, right after the root is adopted and BEFORE any
 * plugin's `onModelLoaded`: the reference nodes are still empty (the instancer
 * materialises them later), so moving one moves its content-to-be, and removing
 * one keeps it away from the planner's adoption and from the core instancer
 * alike. Nobody ever sees the stale state.
 */

import type { Object3D } from 'three';
import { getAssetReference, isPlacementNode } from './rv-asset-reference';
import { getNodeId } from './rv-node-id';
import { disposeLoadedSubtree } from './rv-scene-loader';
import type { NodeRegistry } from './rv-node-registry';
import type { PlacementTransform } from '../hmi/scene/rv-scene-edits';

const DEG_TO_RAD = Math.PI / 180;

/** Edits on placements the loaded file holds, by placement id (= the reference node's `NodeId`). */
export interface BaselinePlacementEdits {
  transforms?: ReadonlyMap<string, PlacementTransform>;
  removed?: readonly string[];
}

/** What {@link applyBaselinePlacementEdits} did — ids it could not find are simply not listed. */
export interface BaselinePlacementEditsResult {
  moved: string[];
  removed: string[];
}

/** True when `edits` would do nothing. */
export function isEmptyBaselinePlacementEdits(edits: BaselinePlacementEdits | null | undefined): boolean {
  return !edits || ((edits.transforms?.size ?? 0) === 0 && (edits.removed?.length ?? 0) === 0);
}

/**
 * Apply baseline placement edits to the loaded tree under `root`.
 *
 * A move sets the reference node's local TRS (the frame the planner records it
 * in); a removal disposes and unregisters the node's subtree and detaches it.
 * An id the tree does not hold is skipped without a word: a removal is then
 * already the target state, and a move of a placement that is gone has nothing
 * to move (the save reports that case, where it can be acted on).
 */
export function applyBaselinePlacementEdits(
  root: Object3D,
  registry: NodeRegistry | null,
  edits: BaselinePlacementEdits,
): BaselinePlacementEditsResult {
  const result: BaselinePlacementEditsResult = { moved: [], removed: [] };
  if (isEmptyBaselinePlacementEdits(edits)) return result;

  const removed = new Set(edits.removed ?? []);
  const wanted = new Set<string>([...(edits.transforms?.keys() ?? []), ...removed]);
  const nodes = new Map<string, Object3D>();
  root.traverse((node) => {
    if (node === root) return;
    const id = getNodeId(node);
    if (!id || !wanted.has(id) || nodes.has(id)) return;
    if (!isPlacementNode(node) && !getAssetReference(node)) return;
    nodes.set(id, node);
  });

  for (const [id, t] of edits.transforms ?? []) {
    if (removed.has(id)) continue;
    const node = nodes.get(id);
    if (!node) continue;
    node.position.set(t.position[0], t.position[1], t.position[2]);
    node.rotation.set(t.rotation[0] * DEG_TO_RAD, t.rotation[1] * DEG_TO_RAD, t.rotation[2] * DEG_TO_RAD, 'XYZ');
    node.scale.set(t.scale[0], t.scale[1], t.scale[2]);
    node.updateMatrix();
    node.updateMatrixWorld(true);
    result.moved.push(id);
  }

  for (const id of removed) {
    const node = nodes.get(id);
    if (!node) continue;
    if (registry) disposeLoadedSubtree(registry, node);
    else node.parent?.remove(node);
    result.removed.push(id);
  }
  return result;
}

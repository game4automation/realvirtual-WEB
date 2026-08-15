// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-glb-read — recover scene state from a loaded GLB. The way back out
 * of {@link bakeIntoGlb}.
 *
 * ## Why a reader has to exist before the write path may change
 *
 * Phase 6 replaces the debounced op-log autosave with a debounced GLB write.
 * The moment that happens, everything the bake does not write is gone — and
 * everything it writes but nobody reads back is gone just as thoroughly. A
 * component in a file that no code turns back into state is not persistence;
 * it is a comment in binary.
 *
 * So the rule for the precondition was: no field loses its localStorage home
 * until it round-trips. These three functions are the second half of that
 * round-trip, and the tests that call them are the proof.
 *
 * ## What it reads, and what it deliberately does not
 *
 * The `overlay`, `addedNodes` and `nodeTransforms` categories need no reader:
 * they are baked into the tree itself, so the loaded scene simply *is* their
 * restored state. `connections` are read by the connection system from the
 * `Connections` block it already owns. What is left are the three pieces that
 * the running application keeps in its own stores and would otherwise have to
 * invent from nothing:
 *
 *  - **placements** — the layout planner's list;
 *  - **settings** — the workspace's catalogue URLs and grid;
 *  - **camera start** — the per-model preset.
 *
 * ## Placements are not descended into
 *
 * Composition grafts a referenced asset's whole subtree under the reference
 * node, and that subtree may contain reference nodes of its own. Those belong
 * to the referenced file, not to this scene's layout. The walk therefore stops
 * at every placement it finds — a placement's contents are the asset's
 * business.
 */

import type { Object3D } from 'three';
import {
  getAssetReference,
  getPlacementMeta,
  getSceneCamera,
  getSceneSettings,
  cameraStartFromSceneCamera,
  isPlacementNode,
} from '../../engine/rv-asset-reference';
import { getNodeId } from '../../engine/rv-node-id';
import {
  parseClassification,
  type DocumentClassification,
} from '../../project/rv-document-classification';
import type { ModelCameraStart } from '../camera-startpos-types';
import type { SceneEditsSettings } from './rv-scene-edits';
import type {
  PlacedComponent,
  SignalMapping,
} from '../../../plugins/layout-planner/rv-layout-store';

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Every layout placement in a loaded scene, in traversal order.
 *
 * Identity comes from `NodeId`, which is what {@link placementExtras} wrote and
 * therefore what makes a re-save update this placement rather than add a second
 * one. A placement node without an id is skipped: it could not be addressed,
 * updated or deleted afterwards, and handing the planner a row it cannot act on
 * is worse than not handing it one.
 */
export function readPlacementsFromScene(root: Object3D): PlacedComponent[] {
  return collectPlacementNodes(root).map((e) => e.placement);
}

/** One placement, together with the node it was read from. */
export interface PlacementNode {
  node: Object3D;
  placement: PlacedComponent;
}

/**
 * Placements paired with their live nodes.
 *
 * The pairing is what the layout planner needs to **adopt** a composed scene:
 * the node already exists and is already registered, so the planner attaches
 * its bookkeeping to it rather than building a second one. Reconstructing the
 * pairing afterwards by name or by index would be guesswork; here it is simply
 * the node the placement was read from.
 */
export function collectPlacementNodes(root: Object3D): PlacementNode[] {
  const out: PlacementNode[] = [];

  const walk = (node: Object3D): void => {
    if (isPlacementNode(node)) {
      const placement = placementOf(node);
      if (placement) out.push({ node, placement });
      return; // never descend into a placement — see the file header
    }
    for (const child of node.children) walk(child);
  };
  walk(root);

  return out;
}

function placementOf(node: Object3D): PlacedComponent | null {
  const id = getNodeId(node);
  if (!id) return null;

  const meta = getPlacementMeta(node) ?? {};
  const reference = getAssetReference(node);

  const euler = node.rotation;
  const placement: PlacedComponent = {
    id,
    // A splat carries no AssetReference, so its catalog identity is in the meta.
    catalogId: reference?.assetId || meta.catalogId || '',
    glbUrl: reference?.path ?? '',
    label: node.name,
    position: [node.position.x, node.position.y, node.position.z],
    rotation: [euler.x * RAD_TO_DEG, euler.y * RAD_TO_DEG, euler.z * RAD_TO_DEG],
    scale: [node.scale.x, node.scale.y, node.scale.z],
  };
  if (meta.splatUrl) placement.splatUrl = meta.splatUrl;
  if (meta.visible === false) placement.visible = false;
  if (meta.signalMappings?.length) {
    placement.signalMappings = meta.signalMappings as unknown as SignalMapping[];
  }
  return placement;
}

/**
 * The workspace settings stored in the file, or null when it carries none.
 *
 * Returns only what is actually in the file — the caller merges it over its own
 * defaults. Filling gaps here would make "the scene says the grid is 500" and
 * "the scene says nothing about the grid" indistinguishable, and only the second
 * of those may be overridden by a user preference.
 */
export function readSceneSettingsFromScene(root: Object3D): Partial<SceneEditsSettings> | null {
  const settings = getSceneSettings(root);
  if (!settings) return null;

  const out: Partial<SceneEditsSettings> = {};
  if (settings.catalogUrls) out.catalogUrls = [...settings.catalogUrls];
  if (settings.gridSizeMm !== undefined) out.gridSizeMm = settings.gridSizeMm;
  return Object.keys(out).length > 0 ? out : null;
}

/** The camera start preset stored in the file, in the shape the camera store uses. */
export function readCameraStartFromScene(root: Object3D): ModelCameraStart | null {
  const camera = getSceneCamera(root);
  return camera ? cameraStartFromSceneCamera(camera) : null;
}

/**
 * The document classification stored in the file, or null (plan-413 §2.3).
 *
 * The fourth reader, and the one that makes the manifest a cache: whatever this
 * returns beats whatever `project.json` remembers, every time, with no merge
 * (§2.5, "GLB wins"). `null` means the file was never classified — the entire
 * Unity export corpus answers that, which is why it is a normal state and not
 * an error (F5).
 *
 * Reads the scene root's `userData.realvirtual`, which is where GLTFLoader
 * restores `scenes[json.scene ?? 0].extras` to — the same normative location
 * `SceneCamera`, `SceneSettings` and `rv_share` already use.
 */
export function readClassificationFromScene(root: Object3D): DocumentClassification | null {
  const rv = (root.userData as Record<string, unknown> | undefined)?.['realvirtual'];
  return parseClassification(rv);
}

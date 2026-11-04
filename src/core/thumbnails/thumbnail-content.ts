// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * thumbnail-content — WHAT a document's thumbnail shows (plan-776 #11: the
 * picture shows what the file contains).
 *
 * There is one kind of document (plan-716: asset = document = model), so there
 * is one content rule and one capture, whoever saves: the editor, the planner's
 * planner save, an MCP replace. The capture is a filtered clone of the
 * document's content roots, each at its live WORLD transform, which the
 * renderer draws in its private studio scene:
 *
 *  - the content roots are the viewer's model root plus the planner's layout
 *    root (its floor, grid and guides are filtered out; it only holds
 *    placements while no model is loaded);
 *  - a placed reference IS file content: its materialised geometry — the
 *    `_rvBakeChunk` meshes and keep meshes the PlacementInstancer builds UNDER
 *    the reference node — is kept, although the GLB export drops chunks (the
 *    file stores the reference node, the load rebuilds the chunks);
 *  - left out, with their subtrees: spawned MUs, gizmos, ghosts, highlight
 *    overlays, raycast BVH helpers, planner floors/guides, three.js helpers,
 *    every runtime helper of the export table, and the editor's BatchedMesh
 *    arenas (their sources are cloned in arena CAPTURE mode instead, so an
 *    arena would draw them twice);
 *  - a node hidden in the VIEW only is shown; `rv.Hidden` and authored-inactive
 *    nodes stay out together with everything below them.
 *
 * Nothing in the live scene is changed: the clone shares geometry and
 * materials with it, which is why {@link DocumentCapture.dispose} frees only
 * what the clone owns (instance buffers, cloned light shadows) and never a
 * shared geometry or material — freeing those would force the live view to
 * re-upload and recompile them on its next frame.
 */

import { Box3, Group, Layers, type Object3D } from 'three';
import { isRuntimeHelperNode } from '../editor/rv-asset-glb-export';
import { RV_INACTIVE_KEY } from '../engine/rv-authored-inactive';
import { arenaSinkOf, type ArenaVisibilitySink } from '../engine/rv-arena-sink';

/** Planner authoring helpers by NAME (they carry no marker the export table knows). */
const PLANNER_HELPER_NAMES = new Set([
  '_layoutSnapGuide', '_layoutNeighborGuide', '_layoutNeighborDistance', '_layoutSelectionPivot',
]);

/**
 * Is `node` (with its subtree) out of the picture? The ONE predicate for every
 * document thumbnail. What the file does not contain is out — the runtime
 * helpers of the export table, planner floors/guides/gizmos, spawned MUs,
 * three.js helpers and the editor's BatchedMesh arenas — except a baked chunk:
 * the export drops it only because the load rebuilds it, and a materialised
 * placement consists of nothing else.
 */
export function isThumbnailExcludedNode(node: Object3D): boolean {
  const ud = (node.userData ?? {}) as Record<string, unknown>;
  if (ud['_layoutFloor'] || ud['_isGhost'] || ud['_floorGizmoHandle'] || ud['_muRef']) return true;
  if (node.name.startsWith('_floorGizmo') || PLANNER_HELPER_NAMES.has(node.name)) return true;
  // An editor arena draws sources the capture clones directly (capture mode).
  if (ud['_rvBatchedRender']) return true;
  // Main-model chunks and the chunks of every placed reference.
  if (ud['_rvBakeChunk']) return false;
  if (/(Helper|TransformControls\w*)$/.test(node.type)) return true;
  return isRuntimeHelperNode(node);
}

/** The part of a viewer the content rule reads. Structural, so tests need no viewer. */
export interface ThumbnailContentSource {
  scene?: { children?: readonly Object3D[] } | null;
  currentModelRoot?: Object3D | null;
}

/**
 * The document content roots of a viewer: the model root (the open document —
 * in the editor the asset root, in the planner the layout document) and the
 * planner's layout root when it is shown. Empty when nothing is loaded.
 */
export function documentContentRoots(viewer: ThumbnailContentSource): Object3D[] {
  const roots: Object3D[] = [];
  if (viewer.currentModelRoot) roots.push(viewer.currentModelRoot);
  for (const child of viewer.scene?.children ?? []) {
    if (child.userData?._isLayoutRoot === true && child.visible && !roots.includes(child)) roots.push(child);
  }
  return roots;
}

function isDocumentHidden(node: Object3D): boolean {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  return rv?.['Hidden'] === true || node.userData?.[RV_INACTIVE_KEY] === true;
}

function isDrawable(node: Object3D): boolean {
  const n = node as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean };
  return n.isMesh === true || n.isPoints === true || n.isLine === true;
}

/** A node the user hid in the VIEW only — shown in the picture. */
function isViewHidden(node: Object3D): boolean {
  if (node.visible || isDocumentHidden(node)) return false;
  const ud = node.userData ?? {};
  const authored = typeof ud.realvirtual === 'object' && ud.realvirtual !== null;
  return authored || (isDrawable(node) && ud['_rvSynthetic'] !== true);
}

/**
 * One node without its children and without its `userData`: `Object3D.copy`
 * JSON-round-trips the extras of every node, which nothing in a render reads
 * and which dominates the clone of a large document. Geometry and material
 * stay SHARED with the live node.
 */
function shallowClone(node: Object3D): Object3D {
  const userData = node.userData;
  node.userData = {};
  let copy: Object3D;
  try {
    copy = node.clone(false);
  } finally {
    node.userData = userData;
  }
  // A subclass whose clone() ignores `recursive` must not bring its children.
  if (copy.children.length > 0) copy.clear();
  return copy;
}

/** The capture clone of `node`, or null when it is out of the picture. */
function cloneContent(node: Object3D): Object3D | null {
  if (isThumbnailExcludedNode(node)) return null;
  if (!node.visible && !isViewHidden(node)) return null;
  const copy = shallowClone(node);
  copy.visible = true;
  for (const child of node.children) {
    const c = cloneContent(child);
    if (c) copy.add(c);
  }
  return copy;
}

const _layer0 = new Layers();
const _nodeBox = new Box3();

/** Expand `box` by `node`'s own geometry (not its children), in world space. */
export function expandByOwnGeometry(box: Box3, node: Object3D): void {
  const m = node as Object3D & {
    geometry?: { boundingBox: Box3 | null; computeBoundingBox(): void };
    boundingBox?: Box3 | null;
    computeBoundingBox?: () => void;
    isInstancedMesh?: boolean;
    isBatchedMesh?: boolean;
  };
  let local: Box3 | null = null;
  if ((m.isInstancedMesh || m.isBatchedMesh) && typeof m.computeBoundingBox === 'function') {
    m.computeBoundingBox();
    local = m.boundingBox ?? null;
  } else if (m.geometry) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    local = m.geometry.boundingBox;
  }
  if (!local || local.isEmpty()) return;
  _nodeBox.copy(local).applyMatrix4(node.matrixWorld);
  box.union(_nodeBox);
}

/** A document's capture: the clone the renderer draws and the bounds it frames. */
export interface DocumentCapture {
  /** Identity group holding one clone per content root, each at its world transform. */
  root: Group;
  /** World bounds of everything the picture draws (layer-0 drawables of the clone). */
  bounds: Box3;
  /** Free what the clone owns. Geometry and materials are shared — never freed. */
  dispose(): void;
}

/**
 * Clone the document content `roots` for a studio render. Call it when the
 * content is complete (the writer waits for the viewer's scene-ready join), so
 * the bounds — computed from the finished clone — include every placement.
 *
 * With editor arenas (plan-766) the source meshes carry `layers.mask = 0`; the
 * clone is taken in arena capture mode (sources on their original layers for
 * exactly the synchronous clone), and the arenas themselves are left out.
 */
export function captureDocument(roots: readonly Object3D[]): DocumentCapture {
  const root = new Group();
  root.name = '__thumbnailCapture';
  const sinks = new Set<ArenaVisibilitySink>();
  for (const r of roots) {
    const sink = arenaSinkOf(r);
    if (sink) sinks.add(sink);
  }
  for (const sink of sinks) sink.enterCapture();
  try {
    for (const r of roots) {
      r.updateWorldMatrix(true, false);
      const copy = cloneContent(r);
      if (!copy) continue;
      // The clone root takes the live WORLD transform: the studio scene is at
      // identity, so every clone sits where its document content sits.
      copy.matrixAutoUpdate = true;
      copy.matrixWorldAutoUpdate = true;
      r.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
      root.add(copy);
    }
  } finally {
    for (const sink of sinks) sink.leaveCapture();
  }
  root.updateMatrixWorld(true);

  const bounds = new Box3();
  root.traverse((node) => {
    if (isDrawable(node) && node.layers.test(_layer0)) expandByOwnGeometry(bounds, node);
  });

  return {
    root,
    bounds,
    dispose() {
      root.removeFromParent();
      root.traverse((node) => {
        const owned = node as Object3D & {
          isInstancedMesh?: boolean; isBatchedMesh?: boolean; isLight?: boolean; dispose?: () => void;
        };
        // An InstancedMesh / BatchedMesh clone owns its instance buffers, a
        // light clone its shadow — everything else is the live scene's.
        if ((owned.isInstancedMesh || owned.isBatchedMesh || owned.isLight) && typeof owned.dispose === 'function') {
          owned.dispose();
        }
      });
    },
  };
}

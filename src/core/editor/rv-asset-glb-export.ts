// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-glb-export — serialize the authored asset to a binary GLB.
 *
 * Exports a PREPARED CLONE of the asset root: `Object3D.clone(true)` JSON-
 * round-trips `userData` (dropping the non-enumerable `_rvComponentInstance`
 * automatically); we then strip internal marker keys (`__rvAdded`,
 * `_layoutObject`, …) while keeping `realvirtual` (components + CADLink) and
 * any user extras. GLTFExporter writes `userData` into glTF `node.extras`,
 * which is exactly what the scene loader reads back (`extras` →
 * `userData.realvirtual`) — a symmetric round-trip.
 *
 * NOTE (Unity round-trip): both sides write `node.extras.realvirtual` — Unity's
 * active exporter (`GLBExportPluginRefactored.AfterNodeExport`) included. The
 * `REALVIRTUAL` glTF *extension* named in older notes is dead code: the legacy
 * plugin's `CreateInstance` returns null, so nothing ever serialised it.
 *
 * NOTE (which exporter to use): this path RE-ENCODES the whole file, which is
 * right for an authored asset and wrong for patching a large model. To write
 * property overrides into an existing GLB without touching its geometry, use
 * `rv-scene-settings-into-model.ts` — it rewrites only the JSON chunk.
 */

import { Matrix4, Scene } from 'three';
import type { Mesh, Object3D } from 'three';
import { objectToGlb } from '../import/rv-import-object';
import { isGltfWrapperName } from '../engine/rv-gltf-unwrap';
import {
  RV_CHAIN_PROXY,
  RV_CHAIN_SKIN,
  RV_CHAIN_SOURCE,
  RV_CHAIN_SOURCE_VISIBLE,
} from '../engine/rv-traverse-utils';

/**
 * Strip internal marker keys from every node's userData (in place, on the
 * clone). Keys starting with `_` are runtime bookkeeping (never authored) —
 * `realvirtual` and user extras survive. Empty userData objects are fine
 * (GLTFExporter omits empty extras).
 */
export function sanitizeUserDataForExport(root: Object3D): void {
  root.traverse((node) => {
    const ud = node.userData as Record<string, unknown>;
    for (const key of Object.keys(ud)) {
      if (key.startsWith('_')) delete ud[key];
    }
    const rv = ud['realvirtual'] as Record<string, unknown> | undefined;
    if (rv && Object.keys(rv).length === 0) delete ud['realvirtual'];
  });
}

/**
 * Remove runtime helper nodes from the export clone (in place). The grouped
 * raycast BVH parks invisible `__raycastBVH*` meshes INSIDE the asset root
 * (static under the root, kinematic under Drive nodes) — baking those merged
 * position-only mega-meshes into the saved GLB would bloat it and duplicate
 * every part's geometry. The export runs with `onlyVisible: false` (authored
 * hidden nodes must survive the bake), so every runtime overlay that used to
 * be dropped for being invisible is pruned explicitly here — same markers the
 * raycast collector skips (rv-raycast-geometry.ts).
 */
export function pruneRuntimeHelpers(root: Object3D): void {
  const junk: Object3D[] = [];
  root.traverse((node) => {
    const ud = node.userData as Record<string, unknown>;
    if (
      node.name.startsWith('__raycastBVH')
      || ud['_rvRaycastBVH']
      || ud['_rvGizmo']
      || ud['_highlightOverlay']
      || ud['_isGhostOverlay']
      || ud['_driveHoverOverlay']
      || node.name.endsWith('_sensorViz')
      || node.name === '_tankFillViz'
      // EnergyChain runtime rig (plan-362). The export must contain the
      // ORIGINAL CAD meshes, not a skinned reconstruction of them: the rig is
      // deterministically reproducible from the rv_extras on load, and glTF
      // skin round-trips are a known minefield. Everything the rig added is
      // dropped here, which `onlyVisible: false` would otherwise happily bake in.
      || ud[RV_CHAIN_PROXY]
      || ud[RV_CHAIN_SKIN]
      // The bone container takes its whole subtree with it. Matching on
      // `isBone` instead would be over-broad: an imported skinned GLB may carry
      // legitimate authored bones that must survive a save.
      || node.name === '__rvEnergyChainBones'
    ) junk.push(node);
  });
  for (const node of junk) node.removeFromParent();
}

const IDENTITY = new Matrix4();

/** True when the node's local TRS is the identity (nothing to preserve). */
function hasIdentityTransform(node: Object3D): boolean {
  node.updateMatrix();
  return node.matrix.equals(IDENTITY);
}

/**
 * Descend through a leading chain of glTF wrapper nodes (`AuxScene`,
 * `AuxScene_1`, `__root__`, …) that carry a single child and no transform of
 * their own, and return the first real content node.
 *
 * Assets saved before this module exported a `Scene` accumulated one such
 * level per editor↔planner round trip. Collapsing them here means ONE save
 * heals a file no matter how deep the chain got. A wrapper with a transform or
 * with several children is NOT collapsed — that would move or reparent
 * authored content.
 */
export function collapseWrapperChain(root: Object3D): Object3D {
  let node = root;
  while (
    isGltfWrapperName(node.name)
    && node.children.length === 1
    && hasIdentityTransform(node)
  ) {
    node = node.children[0];
  }
  return node;
}

/**
 * Serialize the authored asset (geometry + `userData.realvirtual` incl.
 * CADLink and authored components) to a binary GLB ArrayBuffer.
 *
 * The export target is a real `Scene`, NOT the asset root Object3D. This is
 * load-bearing: handed a non-Scene, `GLTFExporter` invents a wrapper Scene
 * named `AuxScene` (see `processObjectsAsync`). The editor's load path keeps
 * `gltf.scene` as the asset root, so that wrapper came back as the root, got
 * re-exported as a content node on the next save, and the file gained one
 * `AuxScene_N` level on every editor↔planner round trip — with the planner
 * then labelling the placed object `AuxScene_1` instead of the asset name.
 *
 * Exporting `Scene(name = assetName) → [authored children]` makes the round
 * trip a fixed point: reloading yields a root Group named after the asset
 * holding exactly the authored children, which re-exports identically.
 *
 * `assetName` should be the document name; without it the content root's own
 * name is used (and a wrapper-shaped name falls back to `Asset`).
 *
 * Throws when the clone or export fails (e.g. non-JSON-safe userData) — the
 * save flow surfaces the error to the user.
 */
export async function exportAssetGlb(assetRoot: Object3D, assetName?: string): Promise<ArrayBuffer> {
  // clone(true) deep-copies the tree; userData is JSON-cloned by three.
  const clone = assetRoot.clone(true);
  restoreAuthoredLampMaterials(assetRoot, clone);
  restoreEnergyChainSources(clone);
  pruneRuntimeHelpers(clone);
  sanitizeUserDataForExport(clone);

  const content = collapseWrapperChain(clone);

  const scene = new Scene();
  const fallback = isGltfWrapperName(content.name) ? 'Asset' : content.name;
  scene.name = assetName?.trim() || fallback || 'Asset';
  // glTF scene `extras` round-trip through `assignExtrasToUserData` on load,
  // so the asset root's authored extras survive the flattening.
  scene.userData = content.userData;

  if (hasIdentityTransform(content)) {
    // Flatten: the content root becomes the scene itself. Child name-paths are
    // unchanged (the asset root is the path space's root either way).
    scene.add(...[...content.children]);
  } else {
    // A transform on the content root has to be preserved and a glTF scene
    // cannot carry one, so the node level stays. It keeps its OWN name — the
    // scene above it already carries the asset name (which is what the planner
    // labels the placement with), and reusing that name here would make the
    // loader dedup the node to `<asset>_1`. Only a wrapper-shaped name is
    // replaced, so no `AuxScene*` ever reaches the file.
    if (isGltfWrapperName(content.name) || !content.name) content.name = `${scene.name}_Content`;
    scene.add(content);
  }

  // objectToGlb is the ONE Object3D→GLB serializer (it passes onlyVisible:false,
  // so authored-hidden nodes survive — hence the explicit prune above).
  return objectToGlb(scene);
}

/**
 * Undo an EnergyChain rig ON THE EXPORT CLONE (F13, plan-362).
 *
 * A rigged chain hides its original CAD meshes and renders SkinnedMesh
 * sidecars instead. The file has to contain the originals, visible and
 * undeformed. Two things are needed and neither may touch the live scene:
 *
 *   - restore the authored `visible` flag (captured in userData at rig time);
 *   - drop the `skinIndex` / `skinWeight` attributes. They live on the SHARED
 *     geometry, and `Object3D.clone(true)` shares geometry references — so the
 *     clone gets its own geometry copy first. Exporting them on a non-skinned
 *     mesh would write JOINTS_0/WEIGHTS_0 accessors with no skin to bind to.
 *
 * The sidecars, bones and picking hull themselves are removed by
 * {@link pruneRuntimeHelpers}.
 */
function restoreEnergyChainSources(clone: Object3D): void {
  clone.traverse((node) => {
    const ud = node.userData as Record<string, unknown>;
    if (ud[RV_CHAIN_SOURCE] !== true) return;
    node.visible = ud[RV_CHAIN_SOURCE_VISIBLE] !== false;
    const mesh = node as Mesh;
    const geometry = mesh.geometry;
    if (!geometry?.getAttribute?.('skinIndex')) return;
    const bare = geometry.clone();
    bare.deleteAttribute('skinIndex');
    bare.deleteAttribute('skinWeight');
    mesh.geometry = bare;
  });
}

function restoreAuthoredLampMaterials(live: Object3D, clone: Object3D): void {
  const lamp = live.userData?._rvLamp as {
    restoreAuthoredMaterialOn?: (cloneNode: Object3D) => void;
  } | undefined;
  lamp?.restoreAuthoredMaterialOn?.(clone);
  const count = Math.min(live.children.length, clone.children.length);
  for (let i = 0; i < count; i++) {
    restoreAuthoredLampMaterials(live.children[i], clone.children[i]);
  }
}

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
 *
 * NOTE (references): because it clones the LIVE tree, this exporter is the one
 * write path that sees composition's grafts. A reference stays a reference only
 * because {@link pruneComposedReferenceSubtrees} runs first — see there for why
 * that is the format's rule and not a heuristic.
 */

import { Matrix4, Scene } from 'three';
import type { Mesh, Object3D } from 'three';
import { objectToGlb } from '../import/rv-import-object';
import { isGltfWrapperName } from '../engine/rv-gltf-unwrap';
import { isUnresolvedReferenceNode } from '../engine/rv-asset-reference';
import {
  RV_CHAIN_ELEMENT,
  RV_CHAIN_PROXY,
  RV_CHAIN_SKIN,
  RV_CHAIN_SOURCE,
  RV_CHAIN_SOURCE_VISIBLE,
} from '../engine/rv-traverse-utils';
import { RV_SHARE_KEY, RV_SHARE_VERSION, type RvShareMeta } from '../share/rv-share-meta';
import {
  RV_CLASSIFICATION_KEY,
  classificationPayload,
  isEmptyClassification,
  parseClassification,
  type DocumentClassification,
} from '../project/rv-document-classification';

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
      // A spawned MU (plan-711): the SIMULATION's product, never authored
      // content. It only reaches an export at all since scene and editor share
      // a document — the editor projection now holds a tree a Source is
      // spawning into, and the way back writes that tree as the scene's new
      // bake source. Baking the parts that happened to be in flight would add
      // them to the file permanently, and add MORE of them on the next round
      // trip. The marker is the planner's registration flag, which is a plain
      // boolean and therefore survives the clone (unlike its `_muRef` twin —
      // see `detachLiveUserData`).
      || ud['_muSelectable']
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
      // Chain element clones (plan-733). `RVChain` builds `NumberOfElements`
      // copies of its template at load; they are deterministically reproducible
      // from the rv_extras, so the file must keep the TEMPLATE only. The primary
      // defence is that an authoring load never clones at all
      // (`ComponentContext.authoring`) — this is the second half, for a tree that
      // reached the export from a simulating load. Without it a save would bake
      // in N copies, and the next round trip N per copy.
      || ud[RV_CHAIN_ELEMENT]
    ) junk.push(node);
  });
  for (const node of junk) node.removeFromParent();
}

/**
 * Detach the COMPOSED subtree from every unresolved reference node (in place,
 * on the export clone) — so a save keeps a reference a reference.
 *
 * ## What goes wrong without it
 *
 * This module exports a clone of the LIVE tree, and by the time an asset is on
 * screen `compose()` has grafted every referenced file under its reference node
 * (`rv-glb-compose.ts`, `referenceNode.add(clone)`) — plus a wireframe
 * placeholder under every reference that did NOT resolve. Cloning that tree
 * writes the child's geometry into the parent file.
 *
 * The `AssetReference` in `extras` survives the clone, so the result is not
 * merely "the reference was melted in" — it is worse and quieter: the file now
 * contains the subtree AND still asks for it. `isUnresolvedReferenceNode()` is
 * true for it, so the next load fetches the child and grafts a SECOND copy on
 * top of the inlined one, and every save/load cycle from then on adds another.
 *
 * ## Why removing all children is correct rather than convenient
 *
 * rv-ODT §7d.8: a reference node "carries no subtree of its own — its subtree
 * lives in another asset". Everything under one is therefore composed content
 * by definition of the format. {@link unflattenReferences} (`rv-glb-flatten.ts`)
 * already rests on exactly this invariant; a second, different rule here is how
 * the two would drift apart.
 *
 * This is the same answer the scene bake gives, arrived at differently: it
 * builds from the SOURCE bytes (`rv-scene-glb-bake.ts`), where a reference node
 * has no children in the first place, so it never had to prune. The asset editor
 * has no source bytes to build from — the op log is applied to a live tree — so
 * it restores the same shape explicitly.
 *
 * ## What is deliberately NOT pruned
 *
 * An `embedded` reference. The flat export inlined that subtree on purpose and
 * left the reference behind as a provenance note (`markReferencesEmbedded`);
 * its children are real file content and deleting them would destroy the file.
 * `isUnresolvedReferenceNode()` is precisely that distinction, which is why it
 * is imported rather than re-derived here.
 *
 * ## What is NOT lost with the subtree
 *
 * An edit the user made INSIDE a referenced subtree does not live on those
 * nodes: `guardReferenceOp` (`rv-reference-guard.ts`) refuses structural ops
 * there and routes value edits into `AssetOverrides.byNodeId` of the reference
 * node — which is this node's own `userData` and survives untouched.
 *
 * @returns how many composed children were detached (0 on a reference-free
 *          asset, where this is a strict no-op).
 */
export function pruneComposedReferenceSubtrees(root: Object3D): number {
  const emptied: Object3D[] = [];
  // Collected first, and WITHOUT descending into a reference node: everything
  // below one is about to be removed, and a nested reference found down there
  // belongs to the child file, not to the file being written.
  const visit = (node: Object3D): void => {
    if (isUnresolvedReferenceNode(node)) {
      if (node.children.length > 0) emptied.push(node);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);

  let removed = 0;
  for (const node of emptied) {
    // `[...children]` — `remove()` splices the live array, and iterating it
    // while it shrinks would skip every other child.
    for (const child of [...node.children]) {
      node.remove(child);
      removed++;
    }
  }
  return removed;
}

/**
 * Take LIVE ENGINE OBJECTS off `userData` for the duration of the clone, and
 * give them back (plan-711 fix round).
 *
 * `Object3D.copy` clones `userData` with `JSON.parse(JSON.stringify(...))`, so
 * one engine object parked there does not degrade the export — it THROWS, and
 * the whole save (or, on the shared-document return leg, the whole handover)
 * fails with a "Converting circular structure to JSON" that names nothing the
 * user can act on. That is not hypothetical: a running scene parks its moving
 * units on the nodes they occupy (`_muRef` → `RVMovingUnit` → `node` →
 * `userData`, a closed circle) and its instanced pools on the pool mesh
 * (`_muPool`), and since scene and editor share a document those trees are
 * exactly what the editor exports.
 *
 * Narrow by construction, so the output is provably unchanged:
 *
 *  - only `_`-prefixed keys are considered, and {@link sanitizeUserDataForExport}
 *    deletes every one of them from the clone anyway — nothing detached here
 *    could ever have reached the file;
 *  - only CLASS INSTANCES are detached (`constructor !== Object`, arrays
 *    excluded). The runtime MARKERS the prune reads (`_rvGizmo`,
 *    `_highlightOverlay`, `_rvEnergyChainProxy`, `_muSelectable`, …) are plain
 *    booleans and stay exactly where they are.
 *
 * @returns the undo, which the caller MUST run (in a `finally`) — these
 *   references are how the live scene finds its own objects.
 */
export function detachLiveUserData(root: Object3D): () => void {
  const parked: Array<[Record<string, unknown>, string, unknown]> = [];
  root.traverse((node) => {
    const ud = node.userData as Record<string, unknown>;
    for (const key of Object.keys(ud)) {
      if (!key.startsWith('_')) continue;
      const value = ud[key];
      if (typeof value !== 'object' || value === null) continue;
      if (Array.isArray(value) || value.constructor === Object) continue;
      parked.push([ud, key, value]);
      delete ud[key];
    }
  });
  return () => { for (const [ud, key, value] of parked) ud[key] = value; };
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
 *
 * Nor is a wrapper collapsed onto a CHILDLESS child (plan-715 Phase 5). The
 * caller keeps `content`'s CHILDREN and discards `content` itself, so descending
 * onto a leaf exports an empty scene: an asset that is one wrapper-named root
 * over one mesh used to save as no geometry at all, silently. The guard is on
 * the child rather than on `isMesh` because the same hole opens for any leaf.
 */
export function collapseWrapperChain(root: Object3D): Object3D {
  let node = root;
  while (
    isGltfWrapperName(node.name)
    && node.children.length === 1
    && node.children[0].children.length > 0
    && hasIdentityTransform(node)
  ) {
    node = node.children[0];
  }
  return node;
}

/**
 * The userData the exported scene must carry: everything the collapsed wrapper
 * levels held, MERGED, with the content node winning (plan-715 Phase 5).
 *
 * ## The bug this closes
 *
 * `collapseWrapperChain` descends past wrapper-named levels, and the export then
 * read `scene.userData = {...content.userData}` — the userData of the node it
 * descended TO. Anything authored on the levels it descended THROUGH was
 * dropped, silently and permanently, on the next save.
 *
 * That is not a theoretical shape. A wrapper-named root is exactly what an
 * editor↔planner round trip used to produce (`AuxScene_N`, see the module note),
 * and since plan-715 the model root is the addressable anchor for asset
 * metadata — so the node most likely to be wrapper-named is now also the node
 * most likely to carry data worth keeping.
 *
 * Merge order is root → content, so a key set on the content node wins over the
 * same key on a wrapper above it: the content node is the more specific
 * authoring surface, and the wrappers are accidents of a previous save. The
 * `realvirtual` block is merged one level deeper for the same reason — a
 * shallow overwrite there would discard the root's components wholesale the
 * moment the content node had a single component of its own.
 *
 * When nothing collapsed (`root === content`, the overwhelmingly common case)
 * the result is a plain shallow copy of `content.userData` — bit for bit what
 * the export did before.
 */
export function mergeWrapperChainUserData(root: Object3D, content: Object3D): Record<string, unknown> {
  // Collect the chain root→content so the merge runs outermost-first.
  const chain: Object3D[] = [];
  for (let n: Object3D | null = content; n; n = n.parent) {
    chain.unshift(n);
    if (n === root) break;
  }
  // `content` outside `root`'s subtree cannot happen (collapseWrapperChain only
  // ever walks down), but a caller passing an unrelated pair must not silently
  // merge the whole scene above it.
  if (chain[0] !== root) return { ...content.userData };

  const merged: Record<string, unknown> = {};
  const mergedRv: Record<string, unknown> = {};
  for (const node of chain) {
    const ud = node.userData as Record<string, unknown>;
    for (const [key, value] of Object.entries(ud)) {
      if (key === 'realvirtual') continue;
      merged[key] = value;
    }
    const rv = ud['realvirtual'];
    if (isPlainRecord(rv)) Object.assign(mergedRv, rv);
  }
  if (Object.keys(mergedRv).length > 0) merged['realvirtual'] = mergedRv;
  return merged;
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
 * ## `shareMeta` — the `rv_share` stamp (plan-386 §2.4, F6/R7)
 *
 * A shared GLB carries what the receiver needs to know about it *inside the
 * file*: there is no sidecar to fetch and no registry to ask. The block goes on
 * the scene's `userData`, which `GLTFExporter` writes as `scenes[0].extras` and
 * `GLTFLoader` restores through `assignExtrasToUserData` — the same route
 * `userData.realvirtual` already proves.
 *
 * **The key is always overwritten, never merged, and dropped when no
 * `shareMeta` is given.** That is R7 made mechanical instead of conventional:
 * import somebody's shared cell, edit it, re-export — without this the file
 * would still claim their author and their licence, and it would do so silently.
 * `rv_share` is therefore only ever present because *this* export put it there.
 * The strip runs over every node, not only the root, so an inherited block
 * cannot survive on a child that the flattening turns back into a scene later.
 *
 * ## `classification` — what the document IS (plan-413 §2.3)
 *
 * Unlike `rv_share`, the classification is **preserved rather than stripped**:
 * it describes the content, not its publisher, so re-exporting somebody's
 * assembly must not silently turn it back into an unclassified blob. Passing a
 * value replaces it, `null` clears it, omitting the argument keeps whatever the
 * asset root already carried.
 *
 * It is also *lifted* to the scene rather than copied: `Classification` is
 * file-level data like `SceneCamera`, and in the non-identity branch below the
 * content node becomes a CHILD of the scene — leaving the block on both would
 * put a second, node-level classification into the file, which is exactly the
 * ambiguity §2.5 ("GLB wins") cannot resolve.
 *
 * Throws when the clone or export fails (e.g. non-JSON-safe userData) — the
 * save flow surfaces the error to the user.
 */
export async function exportAssetGlb(
  assetRoot: Object3D,
  assetName?: string,
  shareMeta?: RvShareMeta | null,
  classification?: DocumentClassification | null,
): Promise<ArrayBuffer> {
  // clone(true) deep-copies the tree; userData is JSON-cloned by three — which
  // is why the live engine objects come off it first (and go straight back on).
  const restoreLiveUserData = detachLiveUserData(assetRoot);
  let clone: Object3D;
  try {
    clone = assetRoot.clone(true);
  } finally {
    restoreLiveUserData();
  }
  restoreAuthoredLampMaterials(assetRoot, clone);
  restoreEnergyChainSources(clone);
  // Before `pruneRuntimeHelpers`, and deliberately so: this drops whole composed
  // subtrees, which is strictly more than the helper prune would have to walk.
  pruneComposedReferenceSubtrees(clone);
  pruneRuntimeHelpers(clone);
  sanitizeUserDataForExport(clone);
  stripShareMeta(clone);

  const content = collapseWrapperChain(clone);

  const scene = new Scene();
  const fallback = isGltfWrapperName(content.name) ? 'Asset' : content.name;
  scene.name = assetName?.trim() || fallback || 'Asset';
  // glTF scene `extras` round-trip through `assignExtrasToUserData` on load,
  // so the asset root's authored extras survive the flattening.
  //
  // A fresh object rather than an alias so the `rv_share` stamp below lands on
  // the scene only. In the non-identity branch the content node is added as a
  // CHILD of this scene, and a shared reference would write the same block into
  // both the scene extras and a node's extras.
  scene.userData = mergeWrapperChainUserData(clone, content);
  // No leading underscore (`sanitizeUserDataForExport` strips those) and
  // JSON-serialisable by construction — the two conditions §2.4 names.
  if (shareMeta) scene.userData[RV_SHARE_KEY] = { ...shareMeta, v: RV_SHARE_VERSION };
  liftRootExtrasToScene(scene, content, classification);

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
 * Remove every `rv_share` block from the export clone (plan-386 R7).
 *
 * Runs before the stamp, unconditionally. What ships as `rv_share` is a claim
 * about *who published this file and under what licence* — inheriting one from
 * an imported asset is how a re-published file ends up attributed to the wrong
 * person, and the person it hurts is never the one who can see it.
 */
function stripShareMeta(root: Object3D): void {
  root.traverse((node) => {
    const ud = node.userData as Record<string, unknown>;
    if (RV_SHARE_KEY in ud) delete ud[RV_SHARE_KEY];
  });
}

/**
 * Settle the root's `realvirtual` block ON THE SCENE and take it OFF the content
 * node (plan-413 §2.3, generalised in plan-715 Phase 5).
 *
 * ## Why it moves rather than copies
 *
 * The scene's userData is built from the root/wrapper chain, so in the
 * non-identity branch — where the content node ships as a CHILD of the scene —
 * every root-level key would otherwise exist twice in the file: once as
 * `scenes[0].extras`, once as that child's `node.extras`. On reload both come
 * back, and the asset ends up with two of each component: one on the model root,
 * one on its only child. The identity branch never showed this because there the
 * content node is discarded and only its children move up.
 *
 * plan-413 fixed exactly one key this way (`Classification`, on the grounds that
 * it is file-level). The duplication was never specific to that key — a Drive,
 * an AASLink or a plan-714 knowledge block on the root duplicates identically —
 * so the lift now covers the whole block. The rule that results is the same one
 * the identity branch has always followed: **the root's components belong to the
 * scene, and the node level below it is transform-only.**
 *
 * `classification === undefined` keeps whatever was there (a plain field edit
 * must not un-classify a document); `null` clears it.
 */
function liftRootExtrasToScene(
  scene: Object3D,
  content: Object3D,
  classification: DocumentClassification | null | undefined,
): void {
  const sceneUd = scene.userData as Record<string, unknown>;
  const contentUd = content.userData as Record<string, unknown>;
  const contentRv = contentUd['realvirtual'];
  // The scene's block already carries the merged chain (content included).
  const sceneRvSource = sceneUd['realvirtual'];
  const existing = isPlainRecord(sceneRvSource) ? sceneRvSource : undefined;

  const resolved = classification === undefined
    ? parseClassification(existing)
    : classification;

  // Nothing inherited and nothing to write: do not mint an empty `realvirtual`
  // object on the scene just to delete a key from it.
  if (!existing && isEmptyClassification(resolved)) {
    if (isPlainRecord(contentRv)) delete contentUd['realvirtual'];
    return;
  }

  const sceneRv: Record<string, unknown> = { ...(existing ?? {}) };
  if (isEmptyClassification(resolved)) delete sceneRv[RV_CLASSIFICATION_KEY];
  else sceneRv[RV_CLASSIFICATION_KEY] = classificationPayload(resolved!);

  if (Object.keys(sceneRv).length > 0) sceneUd['realvirtual'] = sceneRv;
  else delete sceneUd['realvirtual'];

  // Everything that was on the content root now lives on the scene.
  delete contentUd['realvirtual'];
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
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

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import { isSensorRuntimeVizName } from '../engine/rv-sensor-viz-names';
import {
  RV_CHAIN_ELEMENT,
  RV_CHAIN_PROXY,
  RV_CHAIN_SKIN,
  RV_RIBBON_BAND,
} from '../engine/rv-traverse-utils';

/**
 * Is `node` a runtime helper {@link pruneRuntimeHelpers} drops (with its
 * subtree)? The marker table lives here once, so the prune and
 * {@link exportPrunePredicate} cannot drift apart. Exported for the save-time
 * thumbnail (plan-776 F2): what the file does not contain is not in its picture.
 */
export function isRuntimeHelperNode(node: Object3D): boolean {
  const ud = node.userData as Record<string, unknown>;
  // `!!`: the markers are truthy flags of any type, the prune only ever tested truthiness.
  return !!(
      node.name.startsWith('__raycastBVH')
      || ud['_rvRaycastBVH']
      // A BatchedMesh render arena (`rv-batched-render.ts`). Arenas are parented
      // INTO the model tree (`anchor.add(batch)`) and their source meshes stay in
      // the tree as well — only hidden per instance via `setVisibleAt`. Since the
      // export passes `onlyVisible: false`, keeping the arena writes every batched
      // mesh TWICE: once as the authored subtree, once as a flat, hierarchy-less
      // blob serialised out of the arena geometry. The arena is rebuilt from the
      // sources on every load, so the file must never contain one.
      || ud['_rvBatchedRender']
      // A baked chunk mesh (plan-753 Phase 4a): shared merged geometry under
      // the root / a mover — rebuilt on every load, never file content. Under
      // the destructive bake (plan-754) the merged sources are GONE rather than
      // masked, so dropping the chunk drops their triangles: an export of a
      // baked tree is an export of the survivors. That is why the editor never
      // bakes (`assertBakeAllowed`) and re-decodes through
      // `ModelCache.decodeFresh` — authoring always holds the full tree.
      || ud['_rvBakeChunk']
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
      // A Source's ghost preview of its MU template and its floor marker
      // (rv-source.ts `_buildGhostClone`, rv-source-marker.ts). Both are rebuilt
      // from the rv_extras on every load; saved, the next load builds them AGAIN
      // next to the saved copies, so every round trip added one more pair. The
      // ghost also resets its scale to 1, so a template that carried a CAD scale
      // came back as a 1000x giant.
      || ud['_isSourceGhost']
      || ud['_isSourcePreview']
      || ud['_isSourceMarker']
      || ud['_driveHoverOverlay']
      // WebLabel runtime visual (plan-529): the Billboard sprite and the Plate
      // mesh are rebuilt from the `WebLabel` extras on every load. Saved, the
      // plate would become authored geometry and the next load would add a
      // second one in front of it — every round trip one more.
      || ud['_rvWebLabel']
      // Generic runtime-visual marker: any plugin or component that builds a
      // visual from its extras on every load (a screen plane, an overlay) tags
      // the node `userData._rvRuntimeVisual = true` and it never reaches the
      // file — otherwise every save/load round trip would add one more copy.
      || ud['_rvRuntimeVisual'] === true
      // Sensor box / outline / ray tube, any dedup suffix — the ray was missing
      // here, so every save added one more beam to the file.
      || isSensorRuntimeVizName(node.name)
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
      // The generated web band (plan-459). A `RibbonPath` computes its own geometry
      // from the roller poses on every load, so the band is reproducible and has
      // no business in the file — and its vertex count follows the roll
      // diameters, so baking it in would freeze one arbitrary moment of the
      // simulation as authored content.
      || ud[RV_RIBBON_BAND]
      // The procedural roll a RibbonWinder builds when no RollMesh was authored. Same
      // rule: it exists because the file did NOT contain one.
      || (ud['_rvGenerated'] === true && node.name.endsWith('_Roll'))
      // FMU signal children (plan-498): an `Fmu` component creates one leaf per
      // supported variable on every load and attach — the file's source of
      // truth is `FmuVariables[]`, so the leaves never belong in it. The
      // `Signals` container goes too, but only when the FMU created it AND
      // nothing else lives in it (a drive's provisioned signals may share it).
      || (ud['_rvFmuSignal'] === true && isFmuSignalPrunable(node))
  );
}

/** An FMU-stamped node is pruned when it is a leaf, or a container of FMU leaves only. */
function isFmuSignalPrunable(node: Object3D): boolean {
  return node.children.every((c) => (c.userData as Record<string, unknown>)['_rvFmuSignal'] === true);
}


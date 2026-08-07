// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Scene mutation primitives for the LayoutPlannerPlugin.
 *
 * Pure module functions that add/remove placed layout objects to/from the
 * live Three.js scene with full rv-extras processing, raycast aux-target
 * registration, drive/transport-component sync, and unique-name resolution.
 *
 * Extracted from `index.ts` (Plan-177 Phase 8) to keep the planner class
 * focused on lifecycle + public API. The functions take an explicit deps
 * bundle so the plugin retains ownership of `_objectMap`, `_idByObject`,
 * `_layoutRoot`, and the active `_transformControls` — no hidden state.
 *
 * Behavior is BIT-FOR-BIT equivalent to the previous private methods; the
 * existing lifecycle and persistence tests cover the integration paths.
 */

import { Mesh } from 'three';
import type { Group, Object3D } from 'three';

import type { RVViewer } from '../../core/rv-viewer';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import {
  disposeComponentsInSubtree,
  processExtras,
  type ProcessExtrasResult,
} from '../../core/engine/rv-scene-loader';
import { RVLogicEngine } from '../../core/engine/rv-logic-engine';
import { isRigRaycastExcluded } from '../../core/engine/rv-traverse-utils';
import { applyShadowFlags } from '../../core/engine/rv-mesh-classifier';
import { isGltfWrapperName } from '../../core/engine/rv-gltf-unwrap';
import { scanLibraryComponent } from '../../core/library-component-loader';
import { applyKinematicsSpec } from '../../core/behavior-runtime';
import { attachDriveDatasheets } from '../../behaviors/_shared/aas-link';
import { currentAasLoadGeneration, resolveAasSubtree } from '../aas-resolution';
import type { SnapPoint, SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';

import { alignToFloor, pivotToFloorCenter } from './model-cache';
import { disposePlaceholderNode } from './placeholder-node';
import type { FloorGizmo } from './floor-gizmo';
import type { GaussianSplatPluginApi } from './gaussian-splat-plugin-type';
import { computeSnapAlignedWorldMatrix } from '../snap-point/snap-alignment';
import { parseSnapName } from '../snap-point/snap-name-parser';
import { scanAndRegisterSnaps } from '../snap-point/snap-scanner';
import type { SnapPointPlugin } from '../snap-point';

/** Dependencies needed by the scene-mutation primitives. The planner
 *  passes a stable object whose getters/refs read its own private state,
 *  so mutating `_objectMap` inside these functions mutates the planner.
 *  Live fields (viewer, transformControls) are exposed as getters so the
 *  helpers see the freshest value across the planner's lifecycle. */
export interface SceneMutationDeps {
  /** Live viewer — null only during boot. Same field as `LayoutPlannerPlugin._viewer`. */
  getViewer(): RVViewer | null;
  /** id → root Object3D, mutated by add/remove. */
  readonly objectMap: Map<string, Object3D>;
  /** Reverse lookup, kept in sync with `objectMap`. */
  readonly idByObject: WeakMap<Object3D, string>;
  /** Fallback parent when no GLB model root is available. */
  getLayoutRoot(): Group;
  /** Current FloorGizmo (detached before any removal). */
  getTransformControls(): FloorGizmo | null;
  /** Returns the GLB root node to parent layout objects under, or null. */
  getModelRoot(): Object3D | null;
}

/**
 * Merge the LogicSteps carried by a placed subtree into the viewer's logic
 * engine. `loadGLB()` builds the engine for the main model only; placed
 * library assets register through `processExtras()`, which deliberately
 * handles components but not logic — without this merge a placed asset's
 * sequences (SerialContainer / DriveTo / …) never run. The engine is created
 * lazily when the main model itself carried no logic; roots added after the
 * engine started run immediately (mirrors the post-load `logicEngine.start()`).
 */
function mergePlacedLogic(viewer: RVViewer, clone: Object3D): void {
  if (!viewer.registry || !viewer.signalStore) return;
  if (!RVLogicEngine.hasLogicSteps(clone)) return;
  if (!viewer.logicEngine) {
    viewer.logicEngine = new RVLogicEngine();
    // Mid-session engine: mark started so the roots added below run at once.
    viewer.logicEngine.start();
  }
  viewer.logicEngine.addSubtree(clone, viewer.registry, viewer.signalStore);
}

/**
 * How deeply a placement is wired into the runtime (plan-371).
 *
 * - `'full'` — everything: naming scan, `processExtras` (signals/drives/
 *   components), behaviors, LogicSteps, snap points, BVH rebuild. **The
 *   default**, and the only mode any pre-existing caller may use.
 * - `'light'` — visual + identity only: unique name, object map, root registry
 *   entry, raycast aux targets, shadows. Used exclusively for the pending
 *   PLACEHOLDER of a still-loading asset, which has no `userData.realvirtual`
 *   to process and must not create signal/drive registrations that
 *   {@link swapPlacedGeometry} would then have to duplicate or orphan.
 */
export type PlacementRegistrationMode = 'light' | 'full';

/** Options for {@link addPlacedToScene}. */
export interface AddPlacedOptions {
  /** When true, skip the VISUAL-prep half (markers / shadow flags / pivot /
   *  align / parent.add / render-mode) because the caller already ran
   *  {@link prepPlacedVisual} and the node is parented + positioned. Only the
   *  REGISTRATION half runs. Used by the layout planner's drag-preview commit,
   *  where the dragged node IS the node being placed (no re-clone). */
  alreadyPrepared?: boolean;
  /** When true, skip the AABB floor-center pivot + floor align in
   *  {@link prepPlacedVisual}. Multi-part CAD assemblies with a functional
   *  CAD origin must keep their authored pivot (plan-238). Default: false
   *  (catalog objects keep the auto-align behavior).
   *
   *  NOTE: this flag gates BOTH `pivotToFloorCenter` AND `alignToFloor` in one
   *  condition — it is not a selective switch. A caller that wants the pivot
   *  but not the floor align (that is `swapPlacedGeometry`) must set this and
   *  call `pivotToFloorCenter` itself. */
  skipAutoAlign?: boolean;
  /** Registration depth. Default `'full'` — see
   *  {@link PlacementRegistrationMode}. Only the layout planner's pending
   *  placeholder passes `'light'`. */
  mode?: PlacementRegistrationMode;
}

/**
 * Resolve a unique name for a placed object by checking the model root's
 * direct children. Uses the clone's existing name (GLB internal root name),
 * falling back to the catalog `label` when that name is missing or is a glTF
 * scene wrapper (`AuxScene`, `AuxScene_1`, `__root__`, …) rather than content.
 * Appends `_2`, `_3`, … only when a name collision exists.
 *
 * The wrapper fallback matters for assets saved before `exportAssetGlb` began
 * emitting a named `Scene`: their root really IS called `AuxScene_1`, and
 * without this the placed object would carry that name in the hierarchy.
 */
export function resolveUniqueName(deps: SceneMutationDeps, clone: Object3D, label?: string): void {
  if (!deps.getViewer()?.registry) return;
  const usable = clone.name && !isGltfWrapperName(clone.name);
  const baseName = usable ? clone.name : (label?.trim() || clone.name || 'Object');
  if (baseName !== clone.name) clone.name = baseName;

  const modelRoot = deps.getModelRoot();
  if (!modelRoot) return;

  let suffix = 1;
  let candidate = baseName;
  while (modelRoot.children.some(c => c !== clone && c.name === candidate)) {
    suffix++;
    candidate = `${baseName}_${suffix}`;
  }
  clone.name = candidate;
}

/**
 * Run the naming-convention scanner on a freshly-placed subtree, mirroring
 * what `loadGLB` does for the top-level scene. Without this, library items
 * that rely on `Drive-Lin-*` / `Drive-Rot-*` / `Transport-*` naming get
 * placed as inert meshes — `processExtras` finds nothing in their
 * `userData.realvirtual` because the scanner never ran on the cached clone.
 *
 * Idempotent: deep-merge into existing rv_extras, so a clone that already
 * carries hand-authored extras keeps them.
 */
function _applyNamingConventionScan(deps: SceneMutationDeps, clone: Object3D): void {
  const spec = scanLibraryComponent(clone);
  if ((spec.drives?.length ?? 0) > 0 || (spec.transports?.length ?? 0) > 0 || (spec.sensors?.length ?? 0) > 0) {
    applyKinematicsSpec(clone, spec);
  }
  // Drive datasheet: placed library items load via a separate GLTFLoader path
  // (not the main scene loader), so attach the SEW gearmotor AAS to their motor
  // geometry (DriveMesh / DriveRotate / DriveRolls) here as well.
  attachDriveDatasheets(clone);
  // Classify the freshly attached links straight away. AasLinkPlugin is a model
  // plugin and is NOT loaded while the planner is open, so without this the
  // placed motors would stay 'pending' — i.e. silently datasheet-less — until
  // the next full model load (plan-373 F2b).
  void resolveAasSubtree(clone, deps.getViewer()?.projectAssetsPath, currentAasLoadGeneration());
}

/**
 * Add a placed layout object to the scene under the model root with full
 * rv-extras processing (signals, drives, components — same pipeline as
 * `loadGLB`). Returns the `ProcessExtrasResult` (or `null` if the viewer
 * isn't fully wired) so callers can react to newly registered drives.
 */
export function addPlacedToScene(
  deps: SceneMutationDeps,
  clone: Object3D,
  id: string,
  label: string,
  catalogId: string,
  opts?: AddPlacedOptions,
): ProcessExtrasResult | null {
  if (!opts?.alreadyPrepared) prepPlacedVisual(deps, clone, id, label, catalogId, opts);
  return registerPlaced(deps, clone, id, label, catalogId, opts?.mode ?? 'full');
}

/**
 * VISUAL-prep half of {@link addPlacedToScene}. Makes the node look exactly
 * like a placed object — layout markers, shadow flags, floor pivot/align,
 * parenting under the model root, and active render-mode conversion — WITHOUT
 * any registration (no signals/drives/components/snap-points/raycast). This is
 * the part the layout planner runs eagerly when a library drag begins, so the
 * dragged node is visually identical to the final placement from frame 1.
 *
 * Does NOT touch `visible` — the combined callers expect a visible node, and
 * the planner's drag-preview path manages visibility itself.
 */
export function prepPlacedVisual(
  deps: SceneMutationDeps,
  clone: Object3D,
  id: string,
  label: string,
  catalogId: string,
  opts?: Pick<AddPlacedOptions, 'skipAutoAlign'>,
): void {
  // Mark layout metadata — ADD alongside existing rv-extras, don't overwrite
  clone.userData._layoutObject = true;
  clone.userData._layoutId = id;
  if (clone.userData.realvirtual && typeof clone.userData.realvirtual === 'object') {
    (clone.userData.realvirtual as Record<string, unknown>).LayoutObject = { Label: label, CatalogId: catalogId, Locked: false };
  } else {
    clone.userData.realvirtual = { LayoutObject: { Label: label, CatalogId: catalogId, Locked: false } };
  }
  clone.traverse((child) => { child.userData._layoutObject = true; });
  // Cast/receive shadows using the same opaque-vs-transparent policy as the
  // static GLB scene (processMeshes) so placed library objects match it.
  applyShadowFlags(clone);

  // Center pivot to floor + align — skippable for multi-part CAD imports
  // that must keep their functional CAD origin (plan-238).
  if (!opts?.skipAutoAlign) {
    pivotToFloorCenter(clone as Group);
    alignToFloor(clone as Group);
  }

  // Add to model root (under the GLB root node)
  const modelRoot = deps.getModelRoot();
  if (modelRoot) {
    modelRoot.add(clone);
  } else {
    deps.getLayoutRoot().add(clone); // fallback if no model loaded
  }

  // Capture the original GLB root name BEFORE the rename (in registerPlaced).
  // RVSource's self-template detection compares the authored `ThisObjectAsMU`
  // against this original name — without it the 2nd placement (renamed `Foo_2`)
  // would be mis-classified and resolve its template to the first source's node.
  clone.userData._originalName = clone.name;

  // Match the subtree to the active render mode (toon material swap + shader
  // recompile) so the drag preview is render-mode faithful immediately. Mirrors
  // the `model-loaded` toon hook for full GLB loads. registerPlaced re-applies
  // it after component meshes are created.
  deps.getViewer()?.applyRenderModeToSubtree?.(clone);
}

/**
 * REGISTRATION half of {@link addPlacedToScene}. Wires the (already-prepped,
 * already-positioned) node into every runtime system: signals, drives,
 * components, behaviors, the node registry, raycast aux-targets and snap
 * points. The layout planner runs this at drop/commit time — by then the
 * dragged node is at its final transform, so nothing here moves it.
 *
 * Two mandatory guards run first:
 *   1. Clear `_isGhost` (and the source-preview flags + stale snap cache) on
 *      the whole subtree — `processExtras` SKIPS ghost-flagged nodes, so a
 *      preview node committed without this would get zero drives/signals.
 *   2. Reset the layer mask to layer 0 — the drag preview is `markNoAO`'d
 *      (which REPLACES the mask, dropping layer 0); a placed object must
 *      participate in SSAO. No-op for fresh combined-caller clones.
 *
 * `mode` (plan-371) selects the registration depth and **defaults to `'full'`**
 * — the pre-plan-371 behaviour. `'light'` is reserved for the planner's pending
 * placeholder; see {@link PlacementRegistrationMode} for the exact split.
 * Steps that run in BOTH modes: preview-flag guards, `resolveUniqueName`,
 * object map, node registry, raycast aux targets, `markShadowsDirty`.
 */
export function registerPlaced(
  deps: SceneMutationDeps,
  clone: Object3D,
  id: string,
  label: string,
  catalogId: string,
  mode: PlacementRegistrationMode = 'full',
): ProcessExtrasResult | null {
  const full = mode !== 'light';
  clearPreviewFlags(clone);

  // Resolve unique name (uses GLB root name, adds _2, _3 for dupes; falls back
  // to the catalog label when the GLB root is a bare glTF scene wrapper).
  //
  // Runs in LIGHT mode too (plan-371 H1): `NodeRegistry.registerNode` is a bare
  // `map.set(path, node)` with NO collision check, so two concurrent drags of
  // the same catalog entry would claim the same path and the second would
  // silently overwrite the first — leaving every path-based consumer
  // (SelectionManager, the layout-transform listener) pointing at the wrong
  // object.
  resolveUniqueName(deps, clone, label);

  // Naming-convention scan: inject Drive/TransportSurface rv_extras for
  // nodes whose names follow the standard convention. Mirrors what loadGLB
  // does for the top-level scene; library placements skipped this step
  // before, leaving drives/transports invisible on standard-named assets.
  if (full) _applyNamingConventionScan(deps, clone);

  // Process rv-extras: register signals, create drives, instantiate components
  const viewer = deps.getViewer();
  let result: ProcessExtrasResult | null = null;
  if (full && viewer?.registry && viewer.signalStore && viewer.transportManager) {
    result = processExtras(
      clone,
      viewer.registry,
      viewer.signalStore,
      viewer.transportManager,
      viewer.scene,
      viewer.gizmoManager,
      viewer,
      viewer.errorStore,
      viewer.instructionStore,
      { logicRunState: viewer.logicRunState },
      viewer.outlineManager,
      viewer.lampManager,
      viewer.energyChainManager,
    );
    if (result.deferredLogic) viewer.registerDeferredLogic(result.deferredLogic);

    // The placement may have registered new transport surfaces/sensors —
    // invalidate the transport manager's spatial index + dead-end adjacency
    // cache (plan-240 F4). Defensive optional call: tolerates older/duck-typed
    // manager instances without the method.
    viewer.transportManager.notifyTopologyChanged?.();

    // Append new drives to viewer and rebuild the grouped BVH so the new
    // placement participates in fast hover/click (debounced to coalesce
    // multiple synchronous adds).
    if (result.drives.length > 0) {
      viewer.drives.push(...result.drives);
      viewer.rebuildGroupedBvh();
    }

    // Dispatch any behavior file matching this placed library asset, scoped to
    // its subtree (matched by the asset's GLB root name). Runs after components
    // are constructed + drives registered, so rv.drives.get() resolves them.
    viewer.behaviors?.dispatchPlaced(clone);

    // Instantiate the asset's LogicSteps — after drives/components exist so
    // step ComponentReferences (e.g. DriveTo.drive) resolve via the registry.
    mergePlacedLogic(viewer, clone);
  } else {
    // LIGHT mode (pending placeholder), or a viewer that isn't fully wired:
    // register the root node only, so the placement is addressable by path
    // (selection, hierarchy, the layout-transform listener) without any
    // signal/drive/component side effects.
    if (viewer?.registry) {
      const path = NodeRegistry.computeNodePath(clone);
      viewer.registry.registerNode(path, clone);
    }
  }

  deps.objectMap.set(id, clone);
  deps.idByObject.set(clone, id);

  // Register every Mesh in the placed subtree as an auxiliary raycast target,
  // resolving back to the layout root. The standard raycast pipeline uses
  // pre-built BVH groups for the originally loaded model — placed objects
  // aren't in those groups, so without aux targets they would not be hittable
  // (no hover, no click selection). Aux targets bypass BVH and are added
  // directly to the raycast intersection list.
  if (viewer?.raycastManager) {
    const rm = viewer.raycastManager;
    clone.traverse((node) => {
      if (!(node as Mesh).isMesh) return;
      if (node.userData?._highlightOverlay || node.userData?._isGhostOverlay) return;
      // Runtime deformation-rig sidecars (EnergyChain, plan-362): the
      // SkinnedMesh would be CPU-skin-raycast on every pointer move and the
      // deactivated original still sits frozen in the rest pose. The invisible
      // picking proxy is deliberately NOT excluded - that hull is the target.
      if (isRigRaycastExcluded(node)) return;
      rm.addAuxRaycastTarget(node, clone);
    });
  }

  // Register the placed asset's Snap-<DIR>-<TYPEID> nodes with the snap-point
  // registry so they show markers and can be used as attachment targets for
  // subsequent placements (chaining). Also resize the marker InstancedMesh so
  // the newly registered points become visible. Silently no-ops if the snap
  // plugin isn't installed.
  //
  // FULL only: a placeholder carries no ports, and publishing phantom ones
  // would let a second drag mate against geometry that doesn't exist yet.
  if (full && viewer) {
    const snapPlugin = viewer.getPlugin<SnapPointPlugin>('snap-point');
    const snapRegistry = snapPlugin?.getRegistry();
    if (snapRegistry) {
      scanAndRegisterSnaps(clone, snapRegistry, clone);
      snapPlugin?.getMarkerRenderer?.()?.rebuild(snapRegistry.size);
    }
  }

  // The shadow map runs with autoUpdate=false and only rebuilds when dirtied.
  // Dirty it once so the newly placed object's shadow appears immediately.
  viewer?.markShadowsDirty?.();

  if (full) {
    // Re-apply render mode now that processExtras may have created component
    // sub-meshes (e.g. a Source's preview MU) that weren't present during prep.
    // (In light mode `prepPlacedVisual` already did the single pass it needs.)
    viewer?.applyRenderModeToSubtree?.(clone);

    // Announce the new clippable geometry so overlay tools (Section/Clip) can
    // bind to it — Planner/DES add content AFTER the initial model load.
    //
    // FULL only (plan-371 OF-3): the placeholder's wireframe is not clippable
    // content, and firing here as well would make every pending placement emit
    // twice. As it stands each placement announces itself exactly once — at
    // light-register time nothing is announced, at swap time the real geometry
    // is, which matches the single emit every other placement path produces.
    viewer?.emit?.('layout-content-added', { root: clone });
  }

  return result;
}

/**
 * Take back the LIGHT registration of a placeholder subtree without removing
 * the root from the scene: the half of {@link removePlacedFromScene} that
 * un-wires the node graph but leaves `objectMap` / `idByObject` / the root
 * object itself intact. Only used by {@link swapPlacedGeometry}.
 *
 * Deliberately narrow: a light-registered placeholder has no components, no
 * drives, no transport surfaces and no snap ports, so none of the heavier
 * cleanup in `removePlacedFromScene` applies.
 */
function unregisterPlaceholderSubtree(deps: SceneMutationDeps, root: Object3D): void {
  const viewer = deps.getViewer();

  if (viewer?.raycastManager) {
    const rm = viewer.raycastManager;
    root.traverse((node) => {
      if ((node as Mesh).isMesh) rm.removeAuxRaycastTarget(node);
    });
  }

  // Drops the root's path as well — `registerPlaced` re-registers it (via
  // `processExtras`, or via the root-only fallback) a few lines later, and the
  // root's NAME does not change across the swap, so the path is identical.
  viewer?.registry?.unregisterSubtree(root);
}

/**
 * Swap the real, decoded geometry in underneath an existing placement root
 * (plan-371). The ROOT OBJECT IS NEVER REPLACED — only its children are — so
 * every direct `Object3D` reference survives untouched: `objectMap`, the
 * FloorGizmo's `_target`, MultiSelectPivot members, the path-based selection,
 * and the armed bbox-snap state.
 *
 * Returns `false` when the placement no longer exists (deleted / undone while
 * the GLB was decoding); the caller must then discard `realSource`.
 *
 * `realSource` is consumed: its children are moved out. It always arrives
 * transform-neutral from `ModelCache.getOrLoad` (`ensureNeutralPlacementRoot`),
 * so moving the children preserves any intrinsic transform the asset carries.
 */
export function swapPlacedGeometry(
  deps: SceneMutationDeps,
  id: string,
  realSource: Group,
): boolean {
  const root = deps.objectMap.get(id);
  if (!root) return false;

  // ── 2. Preserve the pose. `dropToSurface` routinely parks a placement on an
  // elevated surface (conveyor, rack), and losing that height would be
  // invisible to the store and therefore not even undoable.
  const keepY = root.position.y;

  // ── 3. Un-wire the placeholder subtree BEFORE the real children are added,
  // so their registry paths cannot collide with the placeholder's.
  unregisterPlaceholderSubtree(deps, root);

  // ── 4. Detach + free the placeholder's own resources. `disposePlaceholderNode`
  // is used because the placeholder owns a Sprite whose geometry is a three.js
  // module singleton (see placeholder-node.ts).
  for (const child of [...root.children]) root.remove(child);
  if (root.userData._rvPendingPlaceholder) {
    disposePlaceholderNode(root as Group);
  }

  // ── 5. Adopt the real geometry.
  for (const child of [...realSource.children]) root.add(child);

  const layoutObject = (root.userData.realvirtual as
    { LayoutObject?: { Label?: string; CatalogId?: string } } | undefined)?.LayoutObject;
  const label = layoutObject?.Label ?? root.name;
  const catalogId = layoutObject?.CatalogId ?? '';

  // Visual prep for the freshly adopted children — markers, shadow flags,
  // render mode. `skipAutoAlign` gates `pivotToFloorCenter` AND `alignToFloor`
  // together (see AddPlacedOptions), so the pivot is re-applied by hand below
  // while `alignToFloor` stays out: it would rewrite `position.y` to 0 and drop
  // every elevated placement onto the floor.
  prepPlacedVisual(deps, root, id, label, catalogId, { skipAutoAlign: true });
  // Centre the adopted geometry in the placement frame. Safe on its own: it
  // only shifts CHILD positions and restores the root's own position/rotation
  // before returning (model-cache.ts).
  pivotToFloorCenter(root as Group);

  // ── 6. Belt and braces: re-assert the height even if a future change to
  // prepPlacedVisual / pivotToFloorCenter starts touching `position.y` again.
  root.position.y = keepY;

  // No longer a placeholder — its resources are gone, and the central dispose
  // gate in `removePlacedFromScene` must not try to free them a second time.
  delete root.userData._rvPendingPlaceholder;

  // ── 7. Full registration: naming scan, processExtras (signals / drives /
  // components), behaviors, LogicSteps, snap ports, raycast, grouped-BVH
  // rebuild, and the `layout-content-added` announcement.
  registerPlaced(deps, root, id, label, catalogId, 'full');

  return true;
}

/**
 * Clear the drag-preview flags so the node behaves as a fully placed object.
 * `processExtras` skips `_isGhost`/`_isSourcePreview`/`_isSourceGhost` nodes,
 * and `_ghostSnapCache` is the parsed-snap cache from the drag matcher — all
 * must be dropped before registration. Also restores the SSAO layer (a preview
 * is `markNoAO`'d, which drops layer 0). No-op for fresh combined-caller clones.
 */
function clearPreviewFlags(clone: Object3D): void {
  clone.traverse((n) => {
    delete n.userData._isGhost;
    delete n.userData._isSourcePreview;
    delete n.userData._isSourceGhost;
    delete n.userData._ghostSnapCache;
    n.layers.set(0);
  });
}

/**
 * Register a splat container (already added to scene by `loadSplat()`) as a
 * layout object. No `pivotToFloorCenter` / `alignToFloor` — splats have
 * their own coordinate system.
 */
export function addSplatPlacedToScene(
  deps: SceneMutationDeps,
  container: Object3D,
  id: string,
  label: string,
  catalogId: string,
  splatUrl: string,
): void {
  container.userData._layoutObject = true;
  container.userData._layoutId = id;
  container.userData._isSplat = true;
  container.userData._splatUrl = splatUrl;
  container.userData.realvirtual = { LayoutObject: { Label: label, CatalogId: catalogId, Locked: false } };
  container.name = label;

  deps.objectMap.set(id, container);
  deps.idByObject.set(container, id);

  // Register in NodeRegistry so it appears in the hierarchy
  const viewer = deps.getViewer();
  if (viewer?.registry) {
    const path = NodeRegistry.computeNodePath(container);
    viewer.registry.registerNode(path, container);
  }
}

/**
 * Snap-aligned placement primitive.
 *
 * Computes the world matrix that lands `ownSnap` exactly on `target`, applies
 * it to `clone`, runs the full `addPlacedToScene` pipeline, marks the target
 * occupied, and scans the newly-placed asset's hierarchy for new snap points
 * (enabling chained assembly).
 *
 * Returns `null` if validation fails (occupied / non-uniform scale / missing
 * snap inside the asset).
 */
export function placeAtSnapPoint(
  deps: SceneMutationDeps,
  clone: Object3D,
  id: string,
  label: string,
  catalogId: string,
  target: SnapPoint,
  ownSnapName: string,
  snapRegistry: SnapPointRegistry,
): ProcessExtrasResult | null {
  // Pre-flight: target not occupied
  if (target.occupied) return null;

  // Uniform-scale check (matches SnapPlacementService.canPlace).
  const s = clone.scale;
  const eps = 1e-4;
  if (
    Math.abs(s.x - s.y) > eps ||
    Math.abs(s.x - s.z) > eps ||
    Math.abs(s.y - s.z) > eps
  ) {
    return null;
  }

  // Find the named snap inside the asset
  let ownSnap: Object3D | null = null;
  clone.traverse((n) => {
    if (!ownSnap && n.name === ownSnapName) ownSnap = n;
  });
  if (!ownSnap) return null;

  // Normalize the clone to the floor-center pivot frame BEFORE computing the
  // snap matrix. The reload path (prepPlacedVisual → pivotToFloorCenter) always
  // re-centers geometry by the AABB centroid; if we snap-align in the raw
  // authored-origin frame, the saved transform ends up in a different frame
  // than reload reconstructs, so asymmetric assets (e.g. a chain transfer)
  // drift horizontally by the centroid offset on reload. Pivoting here keeps
  // the placement frame identical to the restore frame. (alignToFloor is not
  // needed — the snap matrix sets the root pose, and only the pivot child-shift
  // persists through the saved transform.)
  pivotToFloorCenter(clone as Group);

  // Compute alignment BEFORE adding to scene so existing world matrices are
  // taken from the clone's pre-place transform. Parse the own snap's name to
  // get its outward direction — the alignment math needs both to compute the
  // swing rotation that aligns outward axes anti-parallel (handles same-axis
  // chains AND cross-axis attachments).
  clone.updateMatrixWorld(true);
  const parsedOwn = parseSnapName((ownSnap as Object3D).name);
  const M = computeSnapAlignedWorldMatrix(
    target.object3D,
    clone,
    ownSnap,
    target.dir,
    parsedOwn?.dir,
  );
  // Apply
  clone.matrixAutoUpdate = false;
  clone.matrix.copy(M);
  M.decompose(clone.position, clone.quaternion, clone.scale);
  clone.matrixAutoUpdate = true;
  clone.updateMatrixWorld(true);

  // Mark layout metadata + shadows inline, then attach preserving the
  // snap-aligned world transform. addPlacedToScene's pivotToFloorCenter /
  // alignToFloor would override our matrix, so this is the visual-prep done
  // inline (NO pivot/align). registerPlacedAtSnap then does the registration.
  clone.userData._layoutObject = true;
  clone.userData._layoutId = id;
  if (clone.userData.realvirtual && typeof clone.userData.realvirtual === 'object') {
    (clone.userData.realvirtual as Record<string, unknown>).LayoutObject = {
      Label: label, CatalogId: catalogId, Locked: false,
    };
  } else {
    clone.userData.realvirtual = {
      LayoutObject: { Label: label, CatalogId: catalogId, Locked: false },
    };
  }
  clone.traverse((child) => { child.userData._layoutObject = true; });
  // Cast/receive shadows using the same policy as the static scene (see
  // addPlacedToScene).
  applyShadowFlags(clone);

  // Attach to layout/model root preserving world transform
  const modelRoot = deps.getModelRoot();
  const targetParent = modelRoot ?? deps.getLayoutRoot();
  targetParent.attach(clone);

  // Capture original GLB root name before rename (see addPlacedToScene).
  clone.userData._originalName = clone.name;

  return registerPlacedAtSnap(deps, clone, id, target, ownSnapName, snapRegistry, label);
}

/**
 * REGISTRATION half of {@link placeAtSnapPoint}. Like {@link registerPlaced}
 * but additionally marks `target` occupied, registers + pairs the asset's own
 * snap with it, and rebuilds the marker mesh (snap-chain bookkeeping). Runs the
 * same preview-flag / AO guards. Assumes the node is already visually prepped
 * AND at its final snap-aligned transform (no pivot/align, no matrix recompute),
 * so the layout planner can commit a dragged-and-snapped preview node directly.
 */
export function registerPlacedAtSnap(
  deps: SceneMutationDeps,
  clone: Object3D,
  id: string,
  target: SnapPoint,
  ownSnapName: string,
  snapRegistry: SnapPointRegistry,
  label?: string,
): ProcessExtrasResult | null {
  clearPreviewFlags(clone);

  resolveUniqueName(deps, clone, label);

  // Naming-convention scan (see _applyNamingConventionScan docstring).
  _applyNamingConventionScan(deps, clone);

  // Process rv-extras (signals, drives, components)
  const viewer = deps.getViewer();
  let result: ProcessExtrasResult | null = null;
  if (viewer?.registry && viewer.signalStore && viewer.transportManager) {
    result = processExtras(
      clone,
      viewer.registry,
      viewer.signalStore,
      viewer.transportManager,
      viewer.scene,
      viewer.gizmoManager,
      viewer,
      viewer.errorStore,
      viewer.instructionStore,
      { logicRunState: viewer.logicRunState },
      viewer.outlineManager,
      viewer.lampManager,
      viewer.energyChainManager,
    );
    if (result.deferredLogic) viewer.registerDeferredLogic(result.deferredLogic);
    if (result.drives.length > 0) {
      viewer.drives.push(...result.drives);
      viewer.rebuildGroupedBvh();
    }
    // Dispatch behaviors for this placement — mirrors registerPlaced. Without
    // this, an asset that snaps to a neighbour during drag never binds its
    // behaviors (only the floor-dropped first placement did), so a 2nd / 3rd
    // conveyor in a snapped line had no Conveyor.* signals and no belt control.
    viewer.behaviors?.dispatchPlaced(clone);

    // Instantiate the asset's LogicSteps (mirrors registerPlaced).
    mergePlacedLogic(viewer, clone);
  } else if (viewer?.registry) {
    const path = NodeRegistry.computeNodePath(clone);
    viewer.registry.registerNode(path, clone);
  }

  deps.objectMap.set(id, clone);
  deps.idByObject.set(clone, id);

  // Register clone meshes as aux raycast targets (so they're hittable for selection)
  if (viewer?.raycastManager) {
    const rm = viewer.raycastManager;
    clone.traverse((node) => {
      if (!(node as Mesh).isMesh) return;
      if (node.userData?._highlightOverlay || node.userData?._isGhostOverlay) return;
      // Runtime deformation-rig sidecars (EnergyChain, plan-362): the
      // SkinnedMesh would be CPU-skin-raycast on every pointer move and the
      // deactivated original still sits frozen in the rest pose. The invisible
      // picking proxy is deliberately NOT excluded - that hull is the target.
      if (isRigRaycastExcluded(node)) return;
      rm.addAuxRaycastTarget(node, clone);
    });
  }

  // Mark target occupied; scan new asset for snaps (Kettenbau).
  snapRegistry.markOccupied(target.id, id);
  const placedSnaps = scanAndRegisterSnaps(clone, snapRegistry, clone);
  // The own snap that was paired with `target` is now also occupied. Locate
  // it by name (the picker passed `ownSnapName`) and establish the
  // bidirectional pairing so chain-resolver walks across this edge.
  const ownSnapReg = placedSnaps.find((sp) => sp.object3D.name === ownSnapName);
  if (ownSnapReg) {
    snapRegistry.markOccupied(ownSnapReg.id, target.occupiedBy ?? id);
    snapRegistry.pair(target.id, ownSnapReg.id);
  }
  // Resize marker InstancedMesh so the newly registered snap points actually
  // get a marker slot allocated.
  if (viewer) {
    const snapPlugin = viewer.getPlugin<SnapPointPlugin>('snap-point');
    snapPlugin?.getMarkerRenderer?.()?.rebuild(snapRegistry.size);
  }

  // Dirty the shadow map so the snapped object's shadow appears immediately
  // (shadowMap.autoUpdate is off — see addPlacedToScene).
  viewer?.markShadowsDirty?.();

  // Re-apply render mode for any component sub-meshes created by processExtras.
  viewer?.applyRenderModeToSubtree?.(clone);

  // Announce new clippable geometry so overlay tools (Section/Clip) can bind
  // to it (mirrors registerPlaced).
  viewer?.emit?.('layout-content-added', { root: clone });

  return result;
}

/**
 * Commit-time snap occupancy + pairing WITHOUT re-registration. In the live-
 * draft model the dragged object is registered on drag-ENTER, so by drop time
 * its `Snap-*` ports are already in the registry (with `ownerRoot = node`).
 * This marks the mated pair occupied and pairs them — the occupancy/pairing
 * half of {@link registerPlacedAtSnap}, minus the processExtras/scan re-run.
 * The own snap is found by name via `getByOwnerRoot` (no re-scan).
 */
export function markSnapOccupied(
  deps: SceneMutationDeps,
  node: Object3D,
  id: string,
  target: SnapPoint,
  ownSnapName: string,
  snapRegistry: SnapPointRegistry,
): void {
  if (target.occupied) return;
  snapRegistry.markOccupied(target.id, id);
  const ownSnap = snapRegistry.getByOwnerRoot(node).find((sp) => sp.object3D.name === ownSnapName);
  if (ownSnap) {
    snapRegistry.markOccupied(ownSnap.id, target.occupiedBy ?? id);
    snapRegistry.pair(target.id, ownSnap.id);
  }
  // Resize marker InstancedMesh so the occupied-state colour refreshes.
  const viewer = deps.getViewer();
  if (viewer) {
    const snapPlugin = viewer.getPlugin<SnapPointPlugin>('snap-point');
    snapPlugin?.getMarkerRenderer?.()?.rebuild(snapRegistry.size);
  }
}

/** Remove a placed layout object from the scene with full system cleanup. */
export function removePlacedFromScene(deps: SceneMutationDeps, id: string): void {
  const obj = deps.objectMap.get(id);
  if (!obj) return;

  const gizmo = deps.getTransformControls();
  if (gizmo) gizmo.detach();

  const viewer = deps.getViewer();

  // Planner Signal Linking: dispose this element's relays + live-control state
  // (mirrors the transport/raycast cleanup below). No-op when feature is off.
  viewer?.signalBindingManager?.unbindAll(id);

  // Dispose any behavior bound to this placed object (mirrors dispatchPlaced).
  viewer?.behaviors?.disposeObject(obj);

  // Drop the object's LogicStep roots from the engine (mirrors mergePlacedLogic).
  viewer?.logicEngine?.removeSubtree(obj);

  // Unregister auxiliary raycast targets we added in addPlacedToScene.
  if (viewer?.raycastManager) {
    const rm = viewer.raycastManager;
    obj.traverse((node) => {
      if ((node as Mesh).isMesh) rm.removeAuxRaycastTarget(node);
    });
  }

  // Capture the root path BEFORE unregistration so the overlay purge below
  // can find sub-path overlay entries to clean up.
  const rootPathBeforeUnregister = viewer?.registry?.getPathForNode(obj) ?? null;

  // Unregister subtree from NodeRegistry and collect removed paths
  if (viewer?.registry) {
    const disposedComponents = disposeComponentsInSubtree(viewer.registry, obj);
    const removedPaths = viewer.registry.unregisterSubtree(obj);

    // Filter removed drives out of viewer.drives
    if (viewer.drives.length > 0 && removedPaths.size > 0) {
      const before = viewer.drives.length;
      viewer.drives = viewer.drives.filter(d => {
        const dPath = viewer.registry!.getPathForNode(d.node);
        // If path is null, the node was already unregistered → it's a removed drive
        return dPath !== null;
      });
      // Rebuild the grouped BVH so the removed drives no longer participate
      // (debounced to coalesce multiple synchronous removes).
      if (viewer.drives.length !== before) {
        viewer.rebuildGroupedBvh();
      }
    }

    // Filter removed components from transport manager
    if (viewer.transportManager && removedPaths.size > 0) {
      const tm = viewer.transportManager;
      const isRemoved = (component: { node: Object3D }) => {
        const p = NodeRegistry.computeNodePath(component.node);
        return removedPaths.has(p);
      };
      tm.sensors = tm.sensors.filter(s => !isRemoved(s));
      tm.surfaces = tm.surfaces.filter(s => !isRemoved(s));
      // Dispose removed sources so their ghost materials are freed.
      for (const s of tm.sources) {
        if (isRemoved(s) && !disposedComponents.has(s)) s.dispose?.();
      }
      tm.sources = tm.sources.filter(s => !isRemoved(s));
      tm.sinks = tm.sinks.filter(s => !isRemoved(s));
      tm.grips = tm.grips.filter(s => !isRemoved(s));
      tm.gripTargets = tm.gripTargets.filter(s => !isRemoved(s));
      // Surfaces changed — invalidate the spatial index + dead-end adjacency
      // cache (plan-240 F4). The array reassignment above is also caught by
      // the manager's per-tick reference guard; this makes it explicit.
      tm.notifyTopologyChanged?.();
    }
  }

  // Splat placements: dispose via the splat plugin (handles GPU cleanup)
  if (obj.userData._isSplat && viewer) {
    const splatPlugin = viewer.getPlugin?.('gaussian-splat') as
      GaussianSplatPluginApi | undefined;
    if (splatPlugin) {
      splatPlugin.disposeSplat(obj as Group);
    } else {
      // Fallback: remove from scene directly
      if (obj.parent) obj.parent.remove(obj);
    }
  } else {
    // Pending placeholder (plan-371): its wireframe geometry, line materials,
    // billboard material and thumbnail texture belong to the placement ALONE —
    // nothing shares them, and nothing else would ever free them.
    //
    // This gate lives here, centrally, rather than at the call sites: the two
    // most common delete paths (Delete key via `removeSelected`, hierarchy
    // context menu via `removeByPaths`) reach this function through
    // `_removeByPlacementIds` and bypass `removePlacementById` entirely.
    //
    // ⛔ `disposePlaceholderNode`, NOT `disposeSubtree` — the placeholder's
    // Sprite carries three.js' module-wide singleton geometry.
    if (obj.userData._rvPendingPlaceholder) {
      disposePlaceholderNode(obj as Group);
    }

    // Remove from scene — do NOT dispose geometry/materials here because
    // clones share BufferGeometry/Material references with the ModelCache
    // master. Disposing them would corrupt the cache and all other clones.
    // GPU cleanup happens in ModelCache.dispose() when the plugin unloads.
    if (obj.parent) obj.parent.remove(obj);
  }

  // Unregister snap-points carried by the removed subtree and free the
  // marker slot. Also clear `occupied` on the snap this object was attached
  // to (if any), so the spot can be reused by a fresh placement.
  if (viewer) {
    const snapPlugin = viewer.getPlugin<SnapPointPlugin>('snap-point');
    const snapRegistry = snapPlugin?.getRegistry();
    if (snapRegistry) {
      snapRegistry.unregisterUnder(obj);
      // Free any snap that this placement occupied (look up by placed id).
      for (const sp of snapRegistry.getAll()) {
        if (sp.occupiedBy === id) snapRegistry.markFree(sp.id);
      }
      snapPlugin?.getMarkerRenderer?.()?.rebuild(snapRegistry.size);
    }
  }

  // Op-log cleanup for sub-path overlays. Re-placing a catalog item with the
  // same root name must not inherit the previous instance's overlay state for
  // nested drives/sensors. Best-effort: silently no-op if the editor plugin
  // isn't installed.
  if (viewer && rootPathBeforeUnregister) {
    const editor = viewer.getPlugin?.('rv-extras-editor') as unknown as
      | { purgeOverlaysForSubtree?: (prefix: string) => number }
      | undefined;
    editor?.purgeOverlaysForSubtree?.(rootPathBeforeUnregister);
  }

  deps.objectMap.delete(id);
  deps.idByObject.delete(obj);
}

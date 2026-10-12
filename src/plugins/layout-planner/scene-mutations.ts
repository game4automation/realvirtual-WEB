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
import { isRigRaycastExcluded } from '../../core/engine/rv-traverse-utils';
import { applyShadowFlags } from '../../core/engine/rv-mesh-classifier';
import { isGltfWrapperName } from '../../core/engine/rv-gltf-unwrap';
import { siblingNames, uniqueName } from '../../core/engine/rv-node-naming';
import { reportPlacementNameCollision } from '../../core/hmi/problems-store';
import {
  applyNamingScanToPlaced,
  canIntegratePlacedContent,
  integratePlacedContent,
} from '../../core/engine/rv-placement-integrate';
import { stampPlacementMarkers, type PlacementInstancer } from '../../core/engine/rv-placement-instancer';
import { syncSignalSubtree } from '../../core/engine/rv-signal-editor-sync';
import { releasePlacedGroups } from '../../core/engine/rv-placement-integrate';
import { attachDriveDatasheets } from '../../behaviors/_shared/aas-link';
import { currentAasLoadGeneration, resolveAasSubtree } from '../aas-resolution';
import { getActiveAasSource } from '../../core/aas/rv-aas-source';
import type { SnapPoint, SnapPointRegistry } from '../../core/engine/rv-snap-point-registry';

import { alignToFloor, pivotToFloorCenter } from './model-cache';
import type { BakeRegistry, PlacementInstance } from '../../core/engine/rv-bake-registry';
import type { BakedAsset } from '../../core/engine/rv-bake-chunk';
import { disposePlaceholderNode } from './placeholder-node';
import type { FloorGizmo } from './floor-gizmo';
import type { GaussianSplatPluginApi } from './gaussian-splat-plugin-type';
import { computeSnapAlignedWorldMatrix } from '../snap-point/snap-alignment';
import { parseSnapName } from '../snap-point/snap-name-parser';
import { scanAndRegisterSnaps } from '../snap-point/snap-scanner';
import type { SnapPointPlugin } from '../snap-point';

// ─── Placement profiling (plan-745 Phase 2a, F14) ────────────────────────

/** One profiled placement mutation. Phases are ms, in `mark()` order. */
export interface PlacementTiming {
  op: 'registerPlaced' | 'registerPlacedAtSnap' | 'swapPlacedGeometry' | 'removePlacedFromScene' | 'placeComponent';
  id: string;
  /** Absolute performance.now() of op start / end — correlates with getLongTasks(). */
  t0?: number;
  t1?: number;
  /** Registration mode, where the op has one ('full' / 'light'). */
  mode?: PlacementRegistrationMode;
  phases: Array<{ phase: string; ms: number }>;
  /** Synchronous total of the op itself. */
  totalMs: number;
  /**
   * Time from the end of the synchronous op to the first rendered frame.
   *
   * The number that actually matters to a user dragging an asset in: the
   * synchronous total says how long the main thread was blocked, this says how
   * long until they saw the result — which is where the deferred BVH rebuild
   * and the shader compile land.
   */
  firstFrameMs?: number;
  /** `renderer.info.render.calls` on that first frame. */
  drawCallsAfter?: number;
  /** Whether the op asked for a (debounced, deferred) whole-scene BVH rebuild. */
  requestedBvhRebuild?: boolean;
}

/**
 * Ring of the most recent placement timings.
 *
 * Always on, capped, and cheap: two `performance.now()` calls per phase
 * boundary and one rAF per op — the same trade `rv-load-profiler` makes. A
 * measurement that has to be switched on is a measurement nobody takes when
 * the interesting drop happens.
 */
const PLACEMENT_TIMING_CAP = 256;
const _placementTimings: PlacementTiming[] = [];

/** Long tasks (> 50 ms main-thread blocks) observed since the ring started. */
export interface LongTaskRecord { start: number; ms: number; name: string }
const LONG_TASK_CAP = 512;
const _longTasks: LongTaskRecord[] = [];
let _longTaskObserver: PerformanceObserver | null = null;
export function getLongTasks(): readonly LongTaskRecord[] {
  if (!_longTaskObserver && typeof PerformanceObserver !== 'undefined') {
    try {
      _longTaskObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          _longTasks.push({ start: e.startTime, ms: e.duration, name: e.name });
          if (_longTasks.length > LONG_TASK_CAP) _longTasks.shift();
        }
      });
      _longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch { _longTaskObserver = null; }
  }
  return _longTasks;
}
export function clearLongTasks(): void { _longTasks.length = 0; }
// Start observing as early as the module loads so the ring is never empty
// on the first read.
getLongTasks();

/** The recorded placement timings, oldest first. Treat as read-only. */
export function getPlacementTimings(): readonly PlacementTiming[] {
  return _placementTimings;
}

/** Drop every recorded timing — a measurement run starts from a clean ring. */
export function clearPlacementTimings(): void {
  _placementTimings.length = 0;
}

interface PlacementProfiler {
  mark(phase: string): void;
  /** Close the record and schedule the first-frame sample. */
  end(extra?: { requestedBvhRebuild?: boolean }): void;
}

export function beginPlacementTiming(
  op: PlacementTiming['op'],
  id: string,
  viewer: RVViewer | null,
  mode?: PlacementRegistrationMode,
): PlacementProfiler {
  const t0 = performance.now();
  let last = t0;
  const record: PlacementTiming = { op, id, mode, phases: [], totalMs: 0, t0 };

  return {
    mark(phase: string): void {
      const now = performance.now();
      record.phases.push({ phase, ms: now - last });
      last = now;
    },
    end(extra): void {
      const done = performance.now();
      record.totalMs = done - t0;
      record.t1 = done;
      if (extra?.requestedBvhRebuild !== undefined) record.requestedBvhRebuild = extra.requestedBvhRebuild;
      _placementTimings.push(record);
      if (_placementTimings.length > PLACEMENT_TIMING_CAP) _placementTimings.shift();
      // First frame AFTER the op — one rAF, no polling, no retained closure
      // beyond the record itself.
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          record.firstFrameMs = performance.now() - done;
          record.drawCallsAfter = viewer?.getRendererInfo?.().drawCalls;
        });
      }
    },
  };
}

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
  /**
   * The bake registry GLB placements are instances of (plan-753 Phase 3).
   * Optional so older duck-typed deps keep compiling; without it every
   * placement takes the virtual/DES registration path (aux targets, no
   * chunks) — which is also what a non-instance node gets with it.
   */
  getBakeRegistry?(): BakeRegistry | null;
  /**
   * The placement instancer (viewer-owned, `core/engine/rv-placement-instancer`)
   * — the ONLY door to `BakeRegistry.instantiate`. Needed by
   * {@link swapPlacedGeometry}; optional for duck-typed deps that never swap.
   */
  getPlacements?(): PlacementInstancer | null;
}

/** Duck-type test: a `BakedAsset` (guards the pending swap against a stray decoded Group). */
export function isBakedAsset(value: unknown): value is BakedAsset {
  const v = value as Partial<BakedAsset> | null;
  return !!v && Array.isArray(v.chunks) && !!v.template && typeof v.acquire === 'function';
}

/** The bake instance a placement root is, or null (virtual / DES / splat / placeholder). */
export function placementInstanceOf(deps: SceneMutationDeps, root: Object3D): PlacementInstance | null {
  return deps.getBakeRegistry?.()?.instanceOf(root) ?? null;
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

/**
 * How the placement root gets its name during integration (plan-758).
 *
 * - `'assign'` (default): a FRESH creation — `resolveUniqueName` gives the root
 *   the first free sibling name (`Belt`, `Belt_1`, …).
 * - `'keep'`: a RECORD-driven creation (GLB reload, legacy autosave restore,
 *   undo/redo replay). The record is the truth: the root already carries the
 *   recorded name and is never renamed. A sibling collision is reported as a
 *   `placement-name-collision` problem, not resolved — resolving it would make
 *   the name depend on the order in which records are restored.
 */
export type PlacementNaming = 'assign' | 'keep';

/** Options for {@link addPlacedToScene}. */
export interface AddPlacedOptions {
  /** See {@link PlacementNaming}. Default `'assign'`. */
  naming?: PlacementNaming;
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

  // The ONE naming rule (plan-758): first free of `base`, `base_1`, `base_2` …
  // among the taken names, the clone itself excluded. Never strips — a fresh
  // placement of `Conveyor_2000` stays `Conveyor_2000`.
  clone.name = uniqueName(placementTakenNames(deps, clone), baseName);
}

/**
 * The names a new placement must not take (plan-758): the children of the
 * parent it lands under (the model root) PLUS every planner placement root,
 * wherever the document put it. A reloaded document keeps its placements one
 * level below the model root, a live drop lands directly under it — a scan of
 * the model root's children alone did not see the reloaded ones, so a copy of
 * a reloaded `Belt` came out as a second `Belt` (found 2026-09-30, multi-select
 * paste after reload). `exclude` is the node being named.
 */
export function placementTakenNames(deps: SceneMutationDeps, exclude?: Object3D): Set<string> {
  const taken = siblingNames(deps.getModelRoot(), exclude);
  for (const root of deps.objectMap.values()) {
    if (root !== exclude) taken.add(root.name);
  }
  return taken;
}

/**
 * The `'keep'` half of {@link PlacementNaming}: the root keeps the name its
 * record gave it. Only CHECKS for a sibling collision and reports it
 * (`placement-name-collision`); never renames, so the outcome cannot depend on
 * restore order. `taken` lets a batch caller pass one precomputed sibling set
 * instead of rescanning the model root per placement.
 */
export function assertPlacementNameKept(
  deps: SceneMutationDeps,
  clone: Object3D,
  id: string,
  taken?: ReadonlySet<string>,
): void {
  const modelRoot = deps.getModelRoot();
  if (!modelRoot) return;
  const collides = (taken ?? placementTakenNames(deps, clone)).has(clone.name);
  if (!collides) return;
  console.warn(`[LayoutPlanner] placement name collision "${clone.name}" (${id}) — kept, not renamed`);
  const path = deps.getViewer()?.registry?.getPathForNode(clone) ?? undefined;
  reportPlacementNameCollision({ placementId: id, name: clone.name, ...(path ? { nodePath: path } : {}) });
}

/**
 * The planner's `afterNamingScan` hook of the core registration
 * (`integratePlacedContent`): placed library items load outside the main scene
 * loader, so attach the SEW gearmotor AAS to their motor geometry (DriveMesh /
 * DriveRotate / DriveRolls) here, and classify the fresh links straight away —
 * AasLinkPlugin is a model plugin and is NOT loaded while the planner is open,
 * so the placed motors would otherwise stay 'pending' (plan-373 F2b).
 */
function _attachPlacedDatasheets(deps: SceneMutationDeps, clone: Object3D): void {
  attachDriveDatasheets(clone);
  // plan-596: the same active source as every other AAS surface (project aasx/
  // over the deploy-wide directory), not a base path of its own.
  void resolveAasSubtree(clone, getActiveAasSource(), currentAasLoadGeneration());
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
  return registerPlaced(deps, clone, id, label, catalogId, opts?.mode ?? 'full', { naming: opts?.naming });
}

/**
 * Adopt a node that is ALREADY in the scene as a layout placement.
 *
 * The GLB-scene counterpart of {@link addPlacedToScene}, and deliberately a
 * fraction of it. Since plan-397 phase 6 a saved scene is a GLB whose
 * placements are `AssetReference` nodes; by the time the planner sees them,
 * composition has grafted their subtrees in and `loadGLB` has run the full
 * loader over the result. So almost everything the placement path does has
 * already happened — and doing it again would be actively wrong:
 *
 *  - {@link prepPlacedVisual} would `pivotToFloorCenter` / `alignToFloor` the
 *    node, **moving** a placement that is already at its authored transform;
 *  - it would `modelRoot.add()` a node that is already parented, re-hanging a
 *    subtree of the loaded model under itself;
 *  - {@link registerPlaced} would re-run `processExtras`, creating a second
 *    set of drives, signals and components for geometry that already has them.
 *
 * What is genuinely missing is only the planner's own bookkeeping: the layout
 * markers that make selection, box-select and the hierarchy panel treat the
 * node as one unit, and the two id maps. Shadow flags are not applied either —
 * `processMeshes` already did, with the same policy.
 */
export function adoptPlacedNode(
  deps: SceneMutationDeps,
  node: Object3D,
  id: string,
  label: string,
  catalogId: string,
): void {
  stampPlacementMarkers(node, id, label, catalogId);
  node.traverse((child) => { child.userData._layoutObject = true; });
  // `_originalName` is what RVSource's self-template detection compares
  // against; the placement path captures it before its rename, and an adopted
  // node is never renamed, so its current name IS the original.
  node.userData._originalName ??= node.name;
  // Record-driven: the file's name is kept as is; a duplicate is only reported.
  assertPlacementNameKept(deps, node, id);

  deps.objectMap.set(id, node);
  deps.idByObject.set(node, id);

  // Snap points are part of the planner bookkeeping this method exists for —
  // loadGLB registers components, but only the placement path ever ran
  // `scanAndRegisterSnaps`. Without this an adopted layout has an EMPTY snap
  // registry: no pairings, so every behavior's `outputs()` is empty, the ZPA
  // interlock reads "downstream occupied", and the whole line stands still
  // (2026-09-01, DemoPlanner: pallet stops at the first sensor forever). The
  // caller's snap-pairing rebuild then reconnects neighbours by geometry.
  const viewer = deps.getViewer();
  if (viewer) {
    const snapPlugin = viewer.getPlugin<SnapPointPlugin>('snap-point');
    const snapRegistry = snapPlugin?.getRegistry();
    if (snapRegistry) {
      // The snap plugin's onModelLoaded already scanned the WHOLE loaded root
      // with ownerRoot = model root — so every baked placement's snaps carry
      // the SAME owner, and register() is idempotent on uuid, making the
      // per-node scan below a silent no-op. Same-owner snaps can never pair
      // (`b.owner === a.owner` in computeProximityPairings), which left a
      // re-opened saved layout with green, unconnected ports and no
      // successors. Drop the wrongly-owned entries first, then re-register
      // with the placement node as owner.
      snapRegistry.unregisterUnder(node);
      scanAndRegisterSnaps(node, snapRegistry, node);
      snapPlugin?.getMarkerRenderer?.()?.rebuild(snapRegistry.size);
    }
  }
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
  // A BAKED placement arrives MATERIALISED (`PlacementInstancer.materialize`:
  // markers, shadow flags, pivot, overrides, render mode — the one order every
  // entry shares). Only the planner's own half is left: floor align + parenting.
  // Virtual / DES nodes and the pending placeholder are not instances of an
  // asset and get their whole visual prep here.
  const materialized = !!placementInstanceOf(deps, clone);
  if (!materialized) {
    // Mark layout metadata — ADD alongside existing rv-extras, don't overwrite
    stampPlacementMarkers(clone, id, label, catalogId);
    clone.traverse((child) => { child.userData._layoutObject = true; });
    // Cast/receive shadows using the same opaque-vs-transparent policy as the
    // static GLB scene (processMeshes) so placed library objects match it.
    applyShadowFlags(clone);
  }

  // Center pivot to floor + align — skippable for multi-part CAD imports
  // that must keep their functional CAD origin (plan-238). The pivot of a
  // materialised root is the instancer's (`spec.pivot`).
  if (!opts?.skipAutoAlign) {
    if (!materialized) pivotToFloorCenter(clone as Group);
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
  if (materialized) return; // `_originalName` + render mode: set by materialize
  clone.userData._originalName = clone.name;

  // Match the subtree to the active render mode (toon material swap + shader
  // recompile) so the drag preview is render-mode faithful immediately. Mirrors
  // the `model-loaded` toon hook for full GLB loads. registerPlaced re-applies
  // it after component meshes are created.
  deps.getViewer()?.applyRenderModeToSubtree?.(clone);
}

/**
 * Snap bookkeeping a caller interleaves into {@link integrateSubtree}.
 *
 * The hook fires at ONE point — right after the placement's own pick bundle is
 * installed — and, when present, owns the subtree's snap scan. It exists
 * because the two registration paths differ in exactly this window and nowhere
 * else: a floor drop only publishes its own ports, while a snap drop has to
 * mark the mated target occupied BEFORE the scan and pair its own port with it
 * AFTER (plan-752 R5). Handing the scan itself to the hook is what keeps that
 * interleaving byte-for-byte what it was, instead of approximating it with two
 * separate callbacks whose relative order the next reader has to reconstruct.
 *
 * The marker rebuild deliberately stays with {@link integrateSubtree}: both
 * paths do it, both do it last, and a hook that forgot it would leave the new
 * ports without marker slots and therefore invisible.
 */
export interface SnapIntegrationContext {
  /** The subtree being integrated. */
  readonly clone: Object3D;
  /** Its placement id. */
  readonly id: string;
  /** The registry the integration is working against. */
  readonly registry: SnapPointRegistry;
  /**
   * Register the subtree's own `Snap-*` ports, exactly as the default path
   * does, and return them. Call this at the point the ordering requires — a
   * hook that never calls it publishes no ports at all.
   */
  scanOwnSnaps(): SnapPoint[];
}

/** Options for {@link integrateSubtree}. */
export interface IntegrateSubtreeOptions {
  /** Placement id — the key under which `objectMap` / `idByObject` hold it. */
  id: string;
  /** Catalog label. Used as the unique-name fallback when the GLB root name
   *  is missing or is a bare glTF scene wrapper. */
  label?: string;
  /** Catalog id (identity of the placed asset). When omitted it is read off
   *  the node's own `LayoutObject.CatalogId`, which is where a snap drop keeps it. */
  catalogId?: string;
  /** Registration depth. Default `'full'` — see
   *  {@link PlacementRegistrationMode}. */
  mode?: PlacementRegistrationMode;
  /** How the root is named — see {@link PlacementNaming}. Default `'assign'`. */
  naming?: PlacementNaming;
  /** For `naming: 'keep'` in a batch: the precomputed sibling-name set the
   *  collision check reads instead of rescanning the model root per placement. */
  takenNames?: ReadonlySet<string>;
  /** Which op the profiler records this as. Default `'registerPlaced'`. */
  op?: PlacementTiming['op'];
  /** Registry to publish the subtree's ports into. Defaults to the installed
   *  snap-point plugin's own registry; a caller that already resolved one
   *  (the snap-drop path) passes it so both halves of the pairing act on the
   *  same object. */
  snapRegistry?: SnapPointRegistry;
  /** See {@link SnapIntegrationContext}. `'full'` mode only. */
  onAfterPickInstall?: (ctx: SnapIntegrationContext) => void;
}

/**
 * Wire an already-prepped, already-positioned subtree into every runtime
 * system: signals, drives, components, behaviors, the node registry, raycast
 * aux targets (virtual / DES nodes) and snap ports.
 *
 * **The one registration path (plan-752 F5).** Both {@link registerPlaced} and
 * {@link registerPlacedAtSnap} are now thin wrappers over this function. They
 * were two 120-line near-copies that had already drifted: the snap path was
 * missing `notifyTopologyChanged()`, so a conveyor snapped onto a neighbour
 * never invalidated the transport manager's spatial index — exactly the class
 * of bug a second copy produces. Everything a placement needs now happens
 * here, once, in one order.
 *
 * The node must already be at its final transform; nothing here moves it.
 * Two mandatory guards run first:
 *   1. Clear `_isGhost` (and the source-preview flags + stale snap cache) on
 *      the whole subtree — `processExtras` SKIPS ghost-flagged nodes, so a
 *      preview node committed without this would get zero drives/signals.
 *   2. Reset the layer mask to layer 0 — the drag preview is `markNoAO`'d
 *      (which REPLACES the mask, dropping layer 0); a placed object must
 *      participate in SSAO. No-op for fresh combined-caller clones.
 *
 * `mode` (plan-371) selects the registration depth and **defaults to `'full'`**.
 * `'light'` is reserved for the planner's pending placeholder; see
 * {@link PlacementRegistrationMode} for the exact split. Steps that run in BOTH
 * modes: preview-flag guards, `resolveUniqueName`, object map, node registry,
 * raycast aux targets, `markShadowsDirty`.
 *
 * Deliberately NOT extracted from `loadGLB`: that function's phases are
 * scene-wide on purpose, and a drop must stay O(placement)
 * (`doc-layout-planner.md:288`).
 */
export function integrateSubtree(
  deps: SceneMutationDeps,
  clone: Object3D,
  opts: IntegrateSubtreeOptions,
): ProcessExtrasResult | null {
  const { id, label, onAfterPickInstall } = opts;
  const mode = opts.mode ?? 'full';
  const full = mode !== 'light';
  const prof = beginPlacementTiming(opts.op ?? 'registerPlaced', id, deps.getViewer(), mode);
  // Phase 2c: nothing in this function asks for a whole-scene rebuild any
  // more. The field stays in the record because that IS the measurement —
  // `getPlacementTimings().some(t => t.requestedBvhRebuild)` must be false.
  const requestedBvhRebuild = false;
  clearPreviewFlags(clone);
  // A baked placement (plan-753 Phase 3) picks through its chunk meshes and
  // renders them directly: no aux targets. Only virtual / DES nodes (no
  // `BakedAsset`) pick through aux targets.
  const instance = placementInstanceOf(deps, clone);

  // Resolve unique name (uses GLB root name, adds _1, _2 for dupes; falls back
  // to the catalog label when the GLB root is a bare glTF scene wrapper).
  //
  // Runs in LIGHT mode too (plan-371 H1): `NodeRegistry.registerNode` is a bare
  // `map.set(path, node)` with NO collision check, so two concurrent drags of
  // the same catalog entry would claim the same path and the second would
  // silently overwrite the first — leaving every path-based consumer
  // (SelectionManager, the layout-transform listener) pointing at the wrong
  // object.
  //
  // `naming: 'keep'` (plan-758): a record-driven root already carries its
  // recorded name — check for a collision, report it, rename nothing.
  if ((opts.naming ?? 'assign') === 'keep') assertPlacementNameKept(deps, clone, id, opts.takenNames);
  else resolveUniqueName(deps, clone, label);
  prof.mark('resolveName');

  // The planner-INDEPENDENT registration lives in the core
  // (`rv-placement-integrate.integratePlacedContent`) — the same function a
  // viewer without the planner runs for a materialised layout placement:
  // naming-convention scan, processExtras (signals / drives / components),
  // deferred logic, transport topology (reaches the SNAP path since plan-752
  // F5), the drive list — NO whole-scene BVH rebuild (plan-745 Phase 2c) —
  // placed behaviors and LogicSteps. Phase marks are unchanged.
  const viewer = deps.getViewer();
  let result: ProcessExtrasResult | null = null;
  if (full && viewer && canIntegratePlacedContent(viewer)) {
    result = integratePlacedContent(viewer, clone, {
      mark: (phase) => prof.mark(phase),
      afterNamingScan: (root) => _attachPlacedDatasheets(deps, root),
    });
  } else {
    // LIGHT mode (pending placeholder), or a viewer that isn't fully wired:
    // register the root node only, so the placement is addressable by path
    // (selection, hierarchy, the layout-transform listener) without any
    // signal/drive/component side effects.
    if (full) {
      applyNamingScanToPlaced(clone);
      _attachPlacedDatasheets(deps, clone);
    }
    prof.mark('namingScan');
    if (viewer?.registry) {
      const path = NodeRegistry.computeNodePath(clone);
      viewer.registry.registerNode(path, clone);
    }
  }

  deps.objectMap.set(id, clone);
  deps.idByObject.set(clone, id);

  // Register every Mesh of a NON-baked placed subtree (virtual / DES node) as
  // an auxiliary raycast target, resolving back to the layout root: such a
  // node has no chunk window, so without aux targets it would not be hittable
  // (no hover, no click selection). Aux targets bypass the backends and are
  // added directly to the raycast intersection list.
  if (viewer?.raycastManager && !instance) {
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
  prof.mark('auxRaycastTargets');

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
    const snapRegistry = opts.snapRegistry ?? snapPlugin?.getRegistry();
    if (snapRegistry) {
      const scanOwnSnaps = (): SnapPoint[] => scanAndRegisterSnaps(clone, snapRegistry, clone);
      // The hook OWNS the scan when present — see {@link SnapIntegrationContext}
      // for why the occupancy/pairing cannot be expressed around it.
      if (onAfterPickInstall) {
        onAfterPickInstall({ clone, id, registry: snapRegistry, scanOwnSnaps });
      } else {
        scanOwnSnaps();
      }
      snapPlugin?.getMarkerRenderer?.()?.rebuild(snapRegistry.size);
    }
  }
  prof.mark('snapPorts');

  // The shadow map runs with autoUpdate=false and only rebuilds when dirtied.
  // Dirty it once so the newly placed object's shadow appears immediately.
  viewer?.markShadowsDirty?.();

  if (full) {
    // Re-apply render mode now that processExtras may have created component
    // sub-meshes (e.g. a Source's preview MU) that weren't present during prep.
    // (In light mode `prepPlacedVisual` already did the single pass it needs.)
    viewer?.applyRenderModeToSubtree?.(clone);
    prof.mark('renderMode');

    // Announce the new clippable geometry so overlay tools (Section/Clip) can
    // bind to it — Planner/DES add content AFTER the initial model load.
    //
    // FULL only (plan-371 OF-3): the placeholder's wireframe is not clippable
    // content, and firing here as well would make every pending placement emit
    // twice. As it stands each placement announces itself exactly once — at
    // light-register time nothing is announced, at swap time the real geometry
    // is, which matches the single emit every other placement path produces.
    //
    // A baked instance additionally announces its chunk + keep meshes
    // (plan-753 §2.6, additive) so consumers bind to them without a walk.
    viewer?.emit?.('layout-content-added', instance
      ? { root: clone, chunks: instance.chunks, keep: instance.keep }
      : { root: clone });
  }
  prof.mark('announce');
  prof.end({ requestedBvhRebuild });

  return result;
}

/**
 * REGISTRATION half of {@link addPlacedToScene} — the floor-drop entry into
 * {@link integrateSubtree}, which is where the work and the documentation are.
 *
 * Kept as a named function because it is the name every caller, test and plan
 * since plan-177 refers to, and because it pins the default mode.
 */
export function registerPlaced(
  deps: SceneMutationDeps,
  clone: Object3D,
  id: string,
  label: string,
  catalogId: string,
  mode: PlacementRegistrationMode = 'full',
  opts?: { naming?: PlacementNaming; takenNames?: ReadonlySet<string> },
): ProcessExtrasResult | null {
  return integrateSubtree(deps, clone, {
    id, label, catalogId, mode,
    ...(opts?.naming ? { naming: opts.naming } : {}),
    ...(opts?.takenNames ? { takenNames: opts.takenNames } : {}),
  });
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
 * Swap the real, baked geometry in underneath an existing placement root
 * (plan-371). The ROOT OBJECT IS NEVER REPLACED — only its children are — so
 * every direct `Object3D` reference survives untouched: `objectMap`, the
 * FloorGizmo's `_target`, MultiSelectPivot members, the path-based selection,
 * and the armed bbox-snap state.
 *
 * Returns `false` when the placement no longer exists (deleted / undone while
 * the GLB was decoding); the caller must then discard `realSource`.
 *
 * `realSource` is a `BakedAsset` (plan-753 F8): it is INSTANTIATED under the
 * root — chunk meshes + logic nodes, no geometry transplant. Virtual / DES
 * entries never go through the pending swap (`buildVirtualNode` needs no
 * network).
 */
export function swapPlacedGeometry(
  deps: SceneMutationDeps,
  id: string,
  realSource: BakedAsset,
): boolean {
  const root = deps.objectMap.get(id);
  if (!root) return false;
  const prof = beginPlacementTiming('swapPlacedGeometry', id, deps.getViewer(), 'full');

  // ── 2. Preserve the pose. `dropToSurface` routinely parks a placement on an
  // elevated surface (conveyor, rack), and losing that height would be
  // invisible to the store and therefore not even undoable.
  const keepY = root.position.y;

  // ── 3. Un-wire the placeholder subtree BEFORE the real children are added,
  // so their registry paths cannot collide with the placeholder's.
  unregisterPlaceholderSubtree(deps, root);
  prof.mark('unregisterPlaceholder');

  // ── 4. Detach + free the placeholder's own resources. `disposePlaceholderNode`
  // is used because the placeholder owns a Sprite whose geometry is a three.js
  // module singleton (see placeholder-node.ts).
  for (const child of [...root.children]) root.remove(child);
  if (root.userData._rvPendingPlaceholder) {
    disposePlaceholderNode(root as Group);
  }

  // ── 5. Adopt the real geometry: the `BakedAsset` is INSTANTIATED under
  // the root — chunk meshes + logic nodes, no geometry transplant.
  if (!isBakedAsset(realSource)) throw new Error('[LayoutPlanner] swapPlacedGeometry: expected a BakedAsset');
  const placements = deps.getPlacements?.();
  if (!placements) throw new Error('[LayoutPlanner] swapPlacedGeometry: BakedAsset without a placement instancer');

  const layoutObject = (root.userData.realvirtual as
    { LayoutObject?: { Label?: string; CatalogId?: string } } | undefined)?.LayoutObject;
  const label = layoutObject?.Label ?? root.name;
  const catalogId = layoutObject?.CatalogId ?? '';

  // THE placement primitive — the same call, the same order as a live drop and
  // a reloaded occurrence: instantiate under the (already parented) root,
  // markers, shadow flags, floor-centre pivot, render mode. The pivot only
  // shifts CHILD positions; `alignToFloor` deliberately stays out — it would
  // rewrite `position.y` to 0 and drop every elevated placement onto the floor.
  placements.materialize(root, realSource, { id, label, catalogId });
  prof.mark('adoptGeometry');
  prof.mark('prepVisualAndPivot');

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
  // `registerPlaced` files its own, finer-grained record; this phase is the
  // whole of it, so the two reads answer different questions rather than
  // double-counting one.
  prof.mark('registerPlaced');
  prof.end();

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
  //
  // A baked placement arrives MATERIALISED (`PlacementInstancer.materialize`)
  // and is therefore pivoted already; only a non-instance node pivots here.
  const materialized = !!placementInstanceOf(deps, clone);
  if (!materialized) pivotToFloorCenter(clone as Group);

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
  if (!materialized) {
    stampPlacementMarkers(clone, id, label, catalogId);
    clone.traverse((child) => { child.userData._layoutObject = true; });
    // Cast/receive shadows using the same policy as the static scene (see
    // addPlacedToScene).
    applyShadowFlags(clone);
  }

  // Attach to layout/model root preserving world transform
  const modelRoot = deps.getModelRoot();
  const targetParent = modelRoot ?? deps.getLayoutRoot();
  targetParent.attach(clone);

  // Capture original GLB root name before rename (see addPlacedToScene).
  clone.userData._originalName ??= clone.name;

  return registerPlacedAtSnap(deps, clone, id, target, ownSnapName, snapRegistry, label);
}

/**
 * The snap-drop entry into {@link integrateSubtree}: like
 * {@link registerPlaced} but additionally marks `target` occupied, registers +
 * pairs the asset's own snap with it, and rebuilds the marker mesh (snap-chain
 * bookkeeping). Assumes the node is already visually prepped AND at its final
 * snap-aligned transform (no pivot/align, no matrix recompute), so the layout
 * planner can commit a dragged-and-snapped preview node directly.
 *
 * Since plan-752 the only thing this path still owns is the occupancy/pairing
 * interleave below; everything else is the one shared registration path.
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
  return integrateSubtree(deps, clone, {
    id,
    label,
    op: 'registerPlacedAtSnap',
    snapRegistry,
    // The arena-set key of a snapped placement rides on the node itself — the
    // snap picker never saw a catalog id. `integrateSubtree` reads it from
    // `LayoutObject.CatalogId` when none is passed, which is what this path
    // did inline before.
    onAfterPickInstall: ({ registry, scanOwnSnaps }) => {
      // Mark target occupied; scan new asset for snaps (Kettenbau). The scan
      // sits BETWEEN the two occupancy writes and cannot be hoisted out of
      // them — that interleave is the whole reason this hook exists.
      registry.markOccupied(target.id, id);
      const placedSnaps = scanOwnSnaps();
      // The own snap that was paired with `target` is now also occupied.
      // Locate it by name (the picker passed `ownSnapName`) and establish the
      // bidirectional pairing so chain-resolver walks across this edge.
      const ownSnapReg = placedSnaps.find((sp) => sp.object3D.name === ownSnapName);
      if (ownSnapReg) {
        registry.markOccupied(ownSnapReg.id, target.occupiedBy ?? id);
        registry.pair(target.id, ownSnapReg.id);
      }
    },
  });
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
  const prof = beginPlacementTiming('removePlacedFromScene', id, deps.getViewer());
  // See `registerPlaced`: always false since Phase 2c, kept as the assertion.
  const requestedBvhRebuild = false;

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

  // plan-757 Phase 1b: the placement's nodes leave the viewer-wide group
  // registry (`integratePlacedContent` merged them in — a group is a NAME,
  // global to the viewer; `syncSubtreeGroups` walks the WHOLE subtree, nested
  // content included), and every per-placement listener is told the content
  // is gone (WebComponent instances, clip tools).
  //
  // plan-757 Phase 2 (F4): a nested placement (a reference node inside the
  // placed asset that became an instance of its own) announced itself with its
  // OWN `layout-content-added`, so it leaves with its own
  // `layout-content-removed` — innermost first, the outer root last — and its
  // own behaviour binds are disposed like the outer root's. Listeners that
  // clean per subtree (the WebComponent plugin) see the nested roots first and
  // the outer root as a no-op.
  const nestedRoots = deps.getBakeRegistry?.()?.instanceRootsUnder(obj).filter((r) => r !== obj) ?? [];
  if (viewer) {
    releasePlacedGroups(viewer, obj);
    for (const nested of nestedRoots) {
      viewer.behaviors?.disposeObject(nested);
      viewer.emit?.('layout-content-removed', { root: nested, path: viewer.registry?.getPathForNode(nested) ?? null });
    }
    viewer.emit?.('layout-content-removed', { root: obj, path: rootPathBeforeUnregister });
  }

  // Unregister subtree from NodeRegistry and collect removed paths
  if (viewer?.registry) {
    const disposedComponents = disposeComponentsInSubtree(viewer.registry, obj);
    const removedPaths = viewer.registry.unregisterSubtree(obj);

    // plan-589: the placement's PLC signals leave the SignalStore. The sync
    // derives "not live" from the registry, so it has to run AFTER
    // `unregisterSubtree` — and it needs the node objects, which is why `obj`
    // is still in hand here. Before this, removing a placement left every one
    // of its signals registered on a dead path, and a later placement of the
    // same asset collided with the corpse.
    try {
      syncSignalSubtree(viewer, obj);
    } catch (e) {
      console.warn('[layout-planner] signal release failed for the removed placement:', e);
    }

    // Filter removed drives out of viewer.drives
    if (viewer.drives.length > 0 && removedPaths.size > 0) {
      viewer.drives = viewer.drives.filter(d => {
        const dPath = viewer.registry!.getPathForNode(d.node);
        // If path is null, the node was already unregistered → it's a removed drive
        return dPath !== null;
      });
      // The removed drives' chunk meshes leave with the placement root's
      // release (BakeRegistry) — nothing else to retire.
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
    // A baked instance (plan-753 F11): highlight proxies leave first (the
    // registry's release listeners), then the refcount drops — the asset
    // disposes its chunks only at 0 on a retired asset, never here. The ONE
    // release (plan-757 Phase 2, F4): the nested instances under the root go
    // with it, innermost first.
    deps.getBakeRegistry?.()?.releaseSubtree(obj);
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
  prof.mark('teardown');
  prof.end({ requestedBvhRebuild });
}

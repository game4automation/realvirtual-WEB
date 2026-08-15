// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LayoutPlannerPlugin — Factory layout planning tool for the realvirtual WebViewer.
 *
 * Users browse GLB component libraries (multi-tab catalog system), click or drag
 * components into the 3D scene, and reposition/rotate them using TransformControls.
 * Layouts persist as lightweight JSON files (auto-save to localStorage).
 *
 * This is a PRIVATE plugin — it self-registers its UI into the public HMI shell
 * via the UISlot system (toolbar-button + overlay slots).
 *
 * Module structure:
 *   - index.ts                — Plugin class (lifecycle, public API, event wiring, slot registration)
 *   - model-cache.ts          — GLB loading, caching, wrapper removal, pivot helpers
 *   - ghost-manager.ts        — Transparent 3D preview during placement
 *   - thumbnail-renderer.ts   — Offscreen thumbnail generation for library icons
 *   - rv-layout-store.ts      — Reactive state management
 *   - LayoutLibraryPanel.tsx   — React UI (library panel + toolbar button)
 */

import {
  Group,
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  DoubleSide,
  GridHelper,
  MathUtils,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three';
import type { Object3D, WebGLRenderer, PerspectiveCamera } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

import type { ComponentType } from 'react';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { ModeId } from '../../core/rv-mode-manager';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import type { ProcessExtrasResult } from '../../core/engine/rv-scene-loader';
import type { RVViewer } from '../../core/rv-viewer';
import type { UISlotEntry, UISlotProps } from '../../core/rv-ui-plugin';
import type { RvExtrasEditorPlugin } from '../../core/hmi/rv-extras-editor';
import type { SelectionSnapshot } from '../../core/engine/rv-selection-manager';
import {
  LayoutStore,
  serializeLayout,
  isGitHubCatalogUrl,
  type PlacedComponent,
  type LibraryCatalogEntry,
  type SignalMapping,
} from './rv-layout-store';
import { getLibraryStore } from '../../core/library/library-store-singleton';
// plan-410 F1: a tiny one-way registry module (same shape/direction as the
// `pending-open-store` import in LayoutLibraryPanel) — the planner ANSWERS the
// editor's question; it never imports the editor plugin itself.
import { registerSelectionAssetResolver } from '@rv-private/plugins/asset-editor/selection-asset-resolver';
import type { AssetBase } from '../../core/editor/rv-asset-document';
import { libraryDocumentBase } from '../../core/editor/active-asset-store';
import { getConnectSnapshot, subscribeConnectStore } from '../../core/hmi/connect-store';
import { mergeWithAutoBinds, type AutoBindSignal } from '../signal-bind/auto-bind';

// PlacementsSnapshot moved to core/rv-shared-types to eliminate the previous
// core → plugin layer violation. Re-exported here for backwards compatibility
// with existing external consumers.
export type { PlacementsSnapshot } from '../../core/rv-shared-types';
import type { PlacementsSnapshot } from '../../core/rv-shared-types';
import { ModelCache, dropToSurface, dropPivotToSurface, collectDropTargets } from './model-cache';
import { GhostManager, buildVirtualNode } from './ghost-manager';
import { FloorGizmo } from './floor-gizmo';
import { markNoAO } from '../../core/engine/rv-group-registry';
import {
  addPlacedToScene as smAddPlacedToScene,
  adoptPlacedNode as smAdoptPlacedNode,
  addSplatPlacedToScene as smAddSplatPlacedToScene,
  removePlacedFromScene as smRemovePlacedFromScene,
  resolveUniqueName as smResolveUniqueName,
  placeAtSnapPoint as smPlaceAtSnapPoint,
  markSnapOccupied as smMarkSnapOccupied,
  swapPlacedGeometry as smSwapPlacedGeometry,
  type SceneMutationDeps,
  type PlacementRegistrationMode,
} from './scene-mutations';
import {
  buildPlaceholderNode,
  disposePlaceholderNode,
  isPlaceholderNode,
  setPlaceholderError,
  resolvePlaceholderSizeMm,
  type PlaceholderNode,
} from './placeholder-node';
import { PendingGeometryRegistry } from './pending-geometry';
import { PendingPulseController } from './pending-pulse';
import type { MatchMediaFn } from '../signal-bind/conflict-blink';
import type { SnapPoint, PlacedComponentId } from '../../core/engine/rv-snap-point-registry';
import type { SnapPointPlugin } from '../snap-point';
import { findBestGhostSnap, applyGhostSnapAlignment, type GhostSnapMatch } from '../snap-point/ghost-snap-match';
import { DEFAULT_MAGNET_RADIUS_M } from '../snap-point/snap-magnetic-controller';
import { computeProximityPairings, type RebuildSnapInput } from '../snap-point/snap-pairing-rebuild';
import {
  findCatalogEntryById as plFindCatalogEntryById,
  resolvePlacementUrl as plResolvePlacementUrl,
  waitForCloudReady as plWaitForCloudReady,
  refreshCloudGlbUrl as plRefreshCloudGlbUrl,
} from './planner-persistence';

import { LAYOUT_PANEL_WIDTH } from '../../core/hmi/layout-constants';
import { isCompactWidth } from '../../hooks/use-mobile-layout';
import { disposeSubtree } from './three-utils';
import { setContext } from '../../core/hmi/ui-context-store';
import { CanvasInteractionManager, type CanvasInteractionDeps } from './canvas-interaction';
import { MuReconciler } from './mu-reconciler';
import { MultiSelectPivot, type MultiSelectPivotDeps } from './multi-select-pivot';
import { BoxSelectController } from './box-select-controller';

// UI components for slot registration
// The library panel is code-split (plan-344 Phase 4); the host is the tiny
// always-mounted gate that pulls its chunk on the first open.
import { LayoutLibraryPanelHost } from './LayoutLibraryPanelHost';
import { PendingLoadMessage } from './PendingLoadMessage';
import { PlannerGridButton, PlannerDropToSurfaceButton, PlannerDeleteButton, PlannerSnapButton, PlannerChainModeButton, PlannerVanishMUsButton, PlannerDocModeButton, PlannerUndoButton, PlannerRedoButton, PlannerLibraryButton } from './PlannerToolbarButtons';
import { SignalBadgeController } from '../signal-bind/SignalBadgeController';
import { BboxSnapController } from './bbox-snap';
import { showInfoOverlay, hideInfoOverlay } from '../../core/hmi/info-overlay-store';
import { freshOpId as opId } from '../../core/hmi/scene/rv-scene-edits';
import type { RvScenePrimitiveOp } from '../../core/ops/rv-unified-ops';
import { getSceneStore } from '../../core/hmi/scene/scene-store-singleton';

/**
 * Emit a planner-originated op into the SceneStore (for undo/redo). The
 * planner's existing direct mutations to scene + LayoutStore happen first;
 * the executor's forward is idempotent so this won't double-apply. When
 * SceneStore isn't available (boot/test), the op is dropped silently —
 * the visual state is still correct.
 */
function emitPlannerOp(viewer: RVViewer | null, op: RvScenePrimitiveOp): void {
  if (!viewer) return;
  const sceneStore = getSceneStore();
  if (!sceneStore) return;
  void sceneStore.applyOp(op);
}

// Register inspector/hierarchy capabilities for the two layout-planner
// marker components. Module-side-effect import — runs once when the planner
// plugin code is evaluated. LayoutObject keeps default capabilities; Splat
// gets its own badge color so users can spot splat placements in the
// hierarchy at a glance. Both `inspectorVisible` defaults to true, so the
// Inspector renders them as regular ComponentSections automatically.
import { registerCapabilities } from '../../core/engine/rv-component-registry';
import { LAYOUT_EDIT_PAUSE_REASON } from '../../core/engine/rv-constants';
import { componentActionRegistry, type ComponentActionContext } from '../../core/hmi/rv-component-action-registry';
import { SwapHoriz, SwapVert } from '@mui/icons-material';
registerCapabilities('Splat', { badgeColor: '#ab47bc' });

// Splat axis-inversion action buttons — three toggles, one per axis. Each
// click flips the corresponding boolean field on the Splat component via
// the standard rv-extras overlay (same persistence path as Drive.Speed,
// Sensor.Mode, …), so the value survives reload and goes through undo/redo.
// The visual effect is applied by `applySplatTransformFromUserData` —
// driven from the SceneStore op subscriber installed in onModelLoaded,
// plus once during placement/restore to honour saved overrides.
type SplatAxisField = 'InvertX' | 'InvertY' | 'InvertZ';

function readSplatInvert(node: Object3D, axisField: SplatAxisField): boolean {
  const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
  return !!rv?.Splat?.[axisField];
}

function toggleSplatInvert(ctx: ComponentActionContext, axisField: SplatAxisField): void {
  const next = !readSplatInvert(ctx.node, axisField);
  // Route through the extras-editor plugin so the change enters the
  // SceneStore op log → autosave → reload pipeline that every other
  // component edit already uses. Both the SceneStore op-executor and the
  // legacy fallback write userData synchronously, so we can apply the
  // visual effect right after.
  const editor = ctx.viewer.getPlugin('rv-extras-editor') as unknown as {
    updateOverlayField(nodePath: string, componentType: string, fieldName: string, value: unknown): boolean;
  } | undefined;
  editor?.updateOverlayField(ctx.nodePath, 'Splat', axisField, next);
  applySplatTransformFromUserData(ctx.node, ctx.viewer);
}

// Three.js axis colour convention — matches the AXIS_COLORS used by the
// Vector3Editor in TRANSFORM's Position / Rotation rows. Keeps the Splat
// invert buttons visually aligned with the same axes the user sees there.
//
// Three.js is right-handed: +X right, +Y up, +Z out-of-screen. The
// gaussian-splats-3d library renders into the same Three.js scene
// coordinate frame, so `splatMesh.scale.x = -1` mirrors along the same
// axis as Position X / Rotation X — no extra conversion involved.
const AXIS_COLOR_X = '#ef5350';  // red   — Position X / Rotation X
const AXIS_COLOR_Y = '#66bb6a';  // green — Position Y / Rotation Y (up)
const AXIS_COLOR_Z = '#4fc3f7';  // blue  — Position Z / Rotation Z

componentActionRegistry.register('Splat', [
  {
    id: 'invertX',
    label: 'X',
    icon: SwapHoriz,
    color: AXIS_COLOR_X,
    tooltip: 'Mirror along Three.js X axis (red — same axis as Position X / Rotation X).',
    isActive: (ctx) => readSplatInvert(ctx.node, 'InvertX'),
    onClick: (ctx) => toggleSplatInvert(ctx, 'InvertX'),
    order: 10,
  },
  {
    id: 'invertY',
    label: 'Y',
    icon: SwapVert,
    color: AXIS_COLOR_Y,
    tooltip: 'Mirror along Three.js Y axis (green — vertical / up axis).',
    isActive: (ctx) => readSplatInvert(ctx.node, 'InvertY'),
    onClick: (ctx) => toggleSplatInvert(ctx, 'InvertY'),
    order: 20,
  },
  {
    id: 'invertZ',
    label: 'Z',
    icon: SwapHoriz,
    color: AXIS_COLOR_Z,
    tooltip: 'Mirror along Three.js Z axis (blue — same axis as Position Z / Rotation Z).',
    isActive: (ctx) => readSplatInvert(ctx.node, 'InvertZ'),
    onClick: (ctx) => toggleSplatInvert(ctx, 'InvertZ'),
    order: 30,
  },
]);

/**
 * Read the Splat.Invert* booleans from a node's userData and push the
 * resulting per-axis scale into the gaussian-splat plugin. The library
 * renders splats through its own pipeline and ignores the parent Three.js
 * container's scale — `setSplatScale` mutates the library's `splatMesh`
 * directly. No-op when the node has no Splat component.
 */
function applySplatTransformFromUserData(node: Object3D, viewer: import('../../core/rv-viewer').RVViewer): void {
  if (!node.userData?._isSplat) return;
  const splatPlugin = viewer.getPlugin('gaussian-splat') as
    | import('./gaussian-splat-plugin-type').GaussianSplatPluginApi
    | undefined;
  if (!splatPlugin?.setSplatScale) return;
  const sx = readSplatInvert(node, 'InvertX') ? -1 : 1;
  const sy = readSplatInvert(node, 'InvertY') ? -1 : 1;
  const sz = readSplatInvert(node, 'InvertZ') ? -1 : 1;
  splatPlugin.setSplatScale(node as import('three').Group, [sx, sy, sz]);
  applySplatCropFromUserData(node, viewer);
}

/**
 * Read the Splat.Crop{Min,Max}{X,Y,Z} numbers from userData and push them as
 * an axis-aligned crop box into the gaussian-splat plugin. Each axis defaults
 * to ±NO_CROP (effectively "no clip"). Used to hide e.g. the ceiling of a
 * scanned room — Splats whose centre lies outside the box are culled in the
 * vertex shader. No-op when the node has no Splat component.
 */
const SPLAT_NO_CROP = 1e6;
function readSplatNumber(node: Object3D, field: string, fallback: number): number {
  const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
  const v = rv?.Splat?.[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function applySplatCropFromUserData(node: Object3D, viewer: import('../../core/rv-viewer').RVViewer): void {
  if (!node.userData?._isSplat) return;
  const splatPlugin = viewer.getPlugin('gaussian-splat') as
    | import('./gaussian-splat-plugin-type').GaussianSplatPluginApi
    | undefined;
  if (!splatPlugin?.setSplatCrop) return;
  splatPlugin.setSplatCrop(node as import('three').Group, {
    min: [
      readSplatNumber(node, 'CropMinX', -SPLAT_NO_CROP),
      readSplatNumber(node, 'CropMinY', -SPLAT_NO_CROP),
      readSplatNumber(node, 'CropMinZ', -SPLAT_NO_CROP),
    ],
    max: [
      readSplatNumber(node, 'CropMaxX', SPLAT_NO_CROP),
      readSplatNumber(node, 'CropMaxY', SPLAT_NO_CROP),
      readSplatNumber(node, 'CropMaxZ', SPLAT_NO_CROP),
    ],
  });
}

/**
 * Restore time helper: copy saved Splat.* overrides from `viewer.currentScene`
 * into a freshly-placed splat container's `userData.realvirtual.Splat`, then
 * push the resulting transform through the splat plugin. Necessary because
 * splat containers are created AFTER `loadGLB` applies the overlay — the
 * rv-extras-editor's overlay-apply pass therefore never touches them.
 *
 * Walks the op log (canonical source) and keeps the last `setField` per
 * `(nodePath, fieldName)` — same semantics as the regular overlay materialise.
 */
function applySplatOverridesFromScene(node: Object3D, viewer: import('../../core/rv-viewer').RVViewer): void {
  if (!node.userData?._isSplat) return;
  const scene = viewer.currentScene;
  const path = viewer.registry?.getPathForNode(node);
  if (scene && path) {
    const ops = scene.edits.ops as ReadonlyArray<{
      kind: string;
      nodePath?: string;
      componentType?: string;
      fieldName?: string;
      value?: unknown;
    }>;
    const rv = (node.userData.realvirtual ?? {}) as Record<string, Record<string, unknown>>;
    if (!rv.Splat) rv.Splat = {};
    for (const op of ops) {
      if (op.kind !== 'setField') continue;
      if (op.nodePath !== path) continue;
      if (op.componentType !== 'Splat') continue;
      if (typeof op.fieldName === 'string') {
        rv.Splat[op.fieldName] = op.value;
      }
    }
    node.userData.realvirtual = rv;
  }
  applySplatTransformFromUserData(node, viewer);
}

/**
 * Mirror the live Three.js node state into the two layout-planner marker
 * components so the Inspector renders the correct values right after a
 * restore. Without this, a splat that was saved with `scale.x = -1` shows
 * `Splat.InvertX = false` in the Inspector on the next reload because the
 * GLB-extras default (false) wins over the actual state on the node.
 *
 * Called from the placement and restore paths. Splat-component is only
 * touched when the node is actually a splat (others get LayoutObject only).
 */
function syncLayoutMarkerComponents(node: Object3D, visible: boolean): void {
  const rv = (node.userData.realvirtual ?? {}) as Record<string, Record<string, unknown>>;
  if (!rv.LayoutObject) rv.LayoutObject = {};
  rv.LayoutObject.Visible = visible;
  // Splat axis state is read live from node.scale by the registered
  // ComponentActions — nothing to mirror into userData for that one.
  if (node.userData._isSplat && !rv.Splat) rv.Splat = {};
  node.userData.realvirtual = rv;
}

/** Extensions the gaussian-splat plugin can resolve to a known format.
 *  Anything else returns `undefined` and the plugin falls back to URL-based
 *  guessing (which only works for HTTP URLs with a visible extension). */
const SPLAT_FILE_EXTENSIONS = new Set(['splat', 'ksplat', 'ply', 'pcd']);

/**
 * Derive the splat file extension from any of the available hints.
 *
 * Why this exists: local-folder splats are served as `blob:` URLs which
 * carry no path — the gaussian-splat plugin cannot infer the file format
 * from such a URL and the underlying library throws "File format not
 * supported". We pass the extension explicitly via `loadSplat(url, ext)`.
 *
 * Resolution order: caller-provided `localPath` first (always carries the
 * real on-disk extension), then the URL as a fallback for HTTP catalog
 * sources where the URL itself encodes the extension. Query strings and
 * fragments are stripped so signed S3-style URLs still resolve correctly.
 */
function extractSplatFileExt(opts: { localPath?: string | null; url?: string | null }): string | undefined {
  const candidates = [opts.localPath, opts.url].filter((s): s is string => !!s);
  for (const cand of candidates) {
    const clean = cand.split('?')[0].split('#')[0];
    const lastDot = clean.lastIndexOf('.');
    if (lastDot < 0) continue;
    const ext = clean.slice(lastDot + 1).toLowerCase();
    if (SPLAT_FILE_EXTENSIONS.has(ext)) return ext;
  }
  return undefined;
}

// ─── Cloud extension contract ───────────────────────────────────────────
//
// The public AGPL planner is cloud-agnostic. A private extension (Unity
// Asset Manager) plugs in via `setExtension()` and supplies a structural
// `cloudStore` plus an optional library-tab component. When the extension
// is absent (public-only build), all cloud UI is hidden and the restore
// path skips cloud-asset resolution.
//
// Definitions live in `./cloud-types`; re-exported here so existing
// external consumers (private Unity Asset Manager extension) keep working.
export type {
  LayoutPlannerCloudConnConfig,
  LayoutPlannerCloudConn,
  LayoutPlannerCloudConnState,
  LayoutPlannerCloudStore,
  LayoutPlannerCloudTabProps,
  LayoutPlannerExtension,
} from './cloud-types';
import type {
  LayoutPlannerCloudStore,
  LayoutPlannerExtension,
} from './cloud-types';

// Re-export everything that tests and UI components need
export { ModelCache, unwrapGltfRoot, pivotToFloorCenter, alignToFloor, dropToSurface, dropPivotToSurface } from './model-cache';
export { GhostManager } from './ghost-manager';
export { ThumbnailRenderer } from '../../core/thumbnails/thumbnail-renderer';
export {
  LayoutStore,
  snapToGrid,
  serializeLayout,
  deserializeLayout,
  resolveUrl,
  normalizeCatalogEntry,
  isGitHubCatalogUrl,
} from './rv-layout-store';
export type {
  PlacedComponent,
  LayoutFile,
  LibraryCatalog,
  LibraryCatalogEntry,
  LayoutSnapshot,
} from './rv-layout-store';

// Note: Pre-allocated vectors are now owned by CanvasInteractionManager
// and MultiSelectPivot respectively. No module-level vectors needed.

// ─── Layout-instance predicates (re-exported from leaf module) ────────
export { isLayoutInstance, isLockedLayoutInstance, findLayoutAncestor } from './layout-predicates';
import {
  isLayoutInstance, isLockedLayoutInstance,
  isMuSelectable, isPlannerSelectable, findPlannerSelectableAncestor,
} from './layout-predicates';
// Motor datasheet on hover (documentation mode). AasLinkPlugin is NOT loaded
// while the planner is open, so the planner runs the same shared augmenter.
import { showDocModeDatasheet, openDocModeDetailAtPoint } from '../aas-link-plugin';
import type { ObjectHoverState } from '../../hooks/use-hover';
import { tooltipStore } from '../../core/hmi/tooltip/tooltip-store';
import type { RVMovingUnit } from '../../core/engine/rv-mu';
import { referenceBoundsFromSubtree } from '../../core/engine/rv-missing-reference-placeholder';
import type { RvReferenceBounds } from '../../core/engine/rv-asset-reference';

// ─── Placement bounds (plan-703 §2.8) ───────────────────────────────────

/**
 * The `bounds` field of a fresh {@link PlacedComponent}, or `{}`.
 *
 * Spread rather than assigned so a node with no measurable geometry adds no
 * key at all — an explicit `bounds: undefined` would serialise into the layout
 * file as a null and read back as "measured, and the answer was nothing".
 *
 * Never throws: this runs on the drop path, and a placement must not fail
 * because a placeholder could not be pre-sized.
 */
function boundsOfPlacedNode(node: Object3D): { bounds?: RvReferenceBounds } {
  try {
    const bounds = referenceBoundsFromSubtree(node, node);
    return bounds ? { bounds } : {};
  } catch {
    return {};
  }
}

// ─── Planner-mode highlight styles ─────────────────────────────────────
// The planner's green hover/selection styles (overlay fallback + OutlinePass)
// now live in the 'planner' HighlightProfile (core/engine/rv-highlight-profiles.ts),
// applied by RVHighlightPolicy on mode-changed — the plugin installs nothing.

// ─── Plugin ─────────────────────────────────────────────────────────────

/** Extra default catalogs auto-loaded by `_loadCatalogs`. Kept EMPTY on
 *  purpose: no library is ever loaded implicitly — not a bundled one, not a
 *  remote one. Every catalog the planner shows was explicitly referenced by
 *  the user, by the project manifest (`libraries[]`), by the constructor
 *  `catalogUrls` option, or by a `?library=<url>` URL parameter. */
const DEFAULT_LIBRARY_URLS: string[] = [];

export interface LayoutPlannerOptions {
  catalogUrls?: string[];
  /** Injectable `window.matchMedia` for the pending-placeholder pulse's
   *  `prefers-reduced-motion` watch. Tests supply a fake; production leaves it
   *  undefined and the watcher reads the real preference. */
  matchMedia?: MatchMediaFn;
}

/** Max world-space distance (metres) at which two restored snaps count as
 *  mated. Mated snaps are placed exactly coincident in-session (the magnetic
 *  controller decomposes to an exact pose), but the live geometry can drift by
 *  up to ~1 cm by the time it is reconstructed on reload (drop-to-surface
 *  re-adjust, a snap riding a drive node, accumulated align recompute). The old
 *  5 mm tolerance silently dropped such connections even though they were
 *  clearly mated — far stricter than the tolerance at which the magnetic system
 *  forms (≈400 mm engage) and holds a chain. 30 mm comfortably absorbs the drift
 *  while staying well below the spacing between any two distinct, non-mated
 *  compatible ports (≥ a module length, typically ≥ 250 mm). The greedy
 *  nearest-match in `computeProximityPairings` still prefers the closest partner,
 *  so widening the window does not mis-pair when the true partner is nearer. */
const SNAP_PAIR_REBUILD_EPS_M = 0.03;

/** True when any node in `root`'s subtree carries the given realvirtual
 *  component in its rv_extras (`userData.realvirtual[type]`). Used to detect a
 *  Source on a freshly dragged draft without a registry path lookup. */
function subtreeHasComponent(root: Object3D, type: string): boolean {
  let found = false;
  root.traverse((n) => {
    if (found) return;
    const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv && rv[type] !== undefined) found = true;
  });
  return found;
}

export class LayoutPlannerPlugin implements RVViewerPlugin {
  readonly id = 'layout-planner';
  readonly order = 250;

  /** plan-198: the planner is a workspace mode. Entered via the TopBar mode
   *  dropdown (no standalone toolbar button). Its slot entries are auto-gated
   *  to the `mode:planner` context by the UI registry. */
  readonly modes: ModeId[] = ['planner'];

  /** Self-register the overlay library panel + planner edit buttons. The panel
   *  is opened/closed by onModeActivate/onModeDeactivate; the buttons are gated
   *  to planner mode (both the legacy 'planner' context — still set by
   *  setActive — and the new 'mode:planner' context injected by the registry). */
  readonly slots: UISlotEntry[] = [
    { slot: 'overlay', component: LayoutLibraryPanelHost as ComponentType<UISlotProps>, order: 100 },
    // Pending-load status line (plan-371). Planner-only: the UI registry merges
    // `shownOnlyInAny: ['mode:planner']` into every slot entry of this plugin,
    // and MessagePanel evaluates that rule — so outside planner mode this tile
    // does not even count towards the message column's content check.
    {
      slot: 'messages',
      component: PendingLoadMessage as ComponentType<UISlotProps>,
      order: 5,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    // Left-toolbar buttons — visible ONLY while the 'planner' UI context is
    // active. ButtonPanel filters entries by visibilityRule; non-planner
    // toolbar buttons (Drives, Sensors, …) are hidden in planner mode so the
    // user gets a focused layout-editing workspace.
    {
      slot: 'button-group',
      component: PlannerGridButton as ComponentType<UISlotProps>,
      order: 200,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    {
      slot: 'button-group',
      component: PlannerDropToSurfaceButton as ComponentType<UISlotProps>,
      order: 210,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    {
      slot: 'button-group',
      component: PlannerSnapButton as ComponentType<UISlotProps>,
      order: 230,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    {
      slot: 'button-group',
      component: PlannerChainModeButton as ComponentType<UISlotProps>,
      order: 240,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    {
      slot: 'button-group',
      component: PlannerVanishMUsButton as ComponentType<UISlotProps>,
      order: 245,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    // Edit-history + delete, grouped at the end of the toolbar.
    {
      slot: 'button-group',
      component: PlannerUndoButton as ComponentType<UISlotProps>,
      order: 250,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    {
      slot: 'button-group',
      component: PlannerRedoButton as ComponentType<UISlotProps>,
      order: 260,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    {
      slot: 'button-group',
      component: PlannerDeleteButton as ComponentType<UISlotProps>,
      order: 270,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    // Library toggle — makes the right-docked parts catalog optional in planner
    // mode (closing it stays in planner; see the lpm subscription below).
    {
      slot: 'button-group',
      component: PlannerLibraryButton as ComponentType<UISlotProps>,
      order: 280,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    // Documentation mode — pinned to the very bottom of the toolbar.
    {
      slot: 'button-group',
      component: PlannerDocModeButton as ComponentType<UISlotProps>,
      order: 300,
      visibilityRule: { shownOnlyIn: ['planner'] },
    },
    // Signal-linking mode (plan-226) — at the very bottom. Self-hides unless the
    // viewer's `plannerSignalLinking` flag created a binding manager.
  ];

  private _viewer: RVViewer | null = null;
  private _layoutRoot: Group;
  private _floorPlane: Mesh;
  /** Visible 30 m × 30 m authoring floor — shown only while a layout scene
   *  is active. Hidden when the user is on a baked GLB scene. */
  private _layoutFloor: Mesh;
  private _gridHelper: GridHelper | null = null;
  private _transformControls: FloorGizmo | null = null;
  private _modelCache: ModelCache;
  /** The decoded-GLB model cache — public read access for the asset editor's
   *  save-side invalidation (plan-301 §2.8 item 3: a re-saved library asset
   *  must not be served from its pre-save decoded tree). */
  get modelCache(): ModelCache { return this._modelCache; }
  private _ghost: GhostManager;
  private _dragEntry: LibraryCatalogEntry | null = null;
  /** The live draft: the dragged object is fully instantiated + registered +
   *  selected on drag-enter, but NOT yet committed to the store / undo log.
   *  Committed at drop, torn down on cancel. */
  private _draft: { id: string; node: Object3D; entry: LibraryCatalogEntry; positioned: boolean; isSource: boolean } | null = null;
  /** Cached drop-to-surface targets for the draft (parallels `_dragDropTargets`
   *  for re-drag). Built once at draft-start. */
  private _draftDropTargets: Mesh[] | null = null;
  /** The snap-point match in effect at the last move (consumed at commit for
   *  occupancy + pairing). */
  private _draftSnapMatch: GhostSnapMatch | null = null;
  /** Guards against concurrent `_startDraft` calls (build is async). */
  private _startingDraft = false;
  /**
   * In-flight placeholder → geometry swaps (plan-371). Pure runtime state:
   * the store entry of a pending placement is indistinguishable from a
   * finished one, so nothing here is ever serialized.
   */
  private _pending = new PendingGeometryRegistry({
    hasPlacement: (id) => this._objectMap.has(id),
    onRetry: (load) => { void this._runPendingLoad(load.id, load.entry, load.generation); },
    onChange: () => {
      this._syncPendingPlacements();
      this._viewer?.markRenderDirty();
    },
  });
  /** The 1.5 Hz "still loading" halo on every pending placeholder (plan-371 F6).
   *  Built in the constructor because it needs `_options.matchMedia`, which
   *  field initializers run too early to see. */
  private _pulse: PendingPulseController;
  /** Set synchronously in onDrop so the dragend-fired `setDragEntry(null)`
   *  knows the draft was committed (keep it) vs cancelled (remove it). */
  private _dropCommitted = false;
  // ── Preview generation ───────────────────────────────────────────────
  // The renderer, the cache and the queue moved to the viewer-owned
  // `ThumbnailService` (plan-372 §2.7). The planner no longer sweeps the whole
  // catalog on every store change — cards pull their own preview when they
  // become visible (§2.8), so a large library costs only what is looked at.
  private _objectMap = new Map<string, Object3D>();
  private _unsubs: (() => void)[] = [];
  private _options: LayoutPlannerOptions;
  private _active = false;
  private _ancestorOverrideFn: ((node: Object3D) => Object3D | null) | null = null;

  /** Allow filter installed when planner is active (so we can restore prior on deactivate). */
  private _priorAllowFilter: ((node: Object3D) => boolean) | null = null;
  /** Unsubscribe handle for the selection-changed listener (active only while planner is on). */
  private _selectionUnsub: (() => void) | null = null;
  /** Documentation-mode motor-datasheet hover subscriptions (planner only). */
  private _docHoverUnsub: (() => void) | null = null;
  private _docUnhoverUnsub: (() => void) | null = null;
  private _docClickUnsub: (() => void) | null = null;
  private readonly _docHoverTipId = 'tooltip-hover:aas-docmode-planner';
  private _transformUpdateUnsub: (() => void) | null = null;
  /** Unsubscribe handle for the store listener (drives Y-axis bar visibility). */
  private _storeUnsub: (() => void) | null = null;
  /** Reverse lookup: Object3D → layout id (avoids O(n) scan of _objectMap on every event). */
  private _idByObject = new WeakMap<Object3D, string>();
  /** Extracted canvas event handler (pointer, keyboard, D&D, blur). */
  private _canvasInteraction: CanvasInteractionManager | null = null;
  /** Keeps spawned clone-MU scene nodes registered as selectable (registry +
   *  aux raycast targets + `_muSelectable` marker) so they flow through the
   *  shared hover/click/box/multi/outline/delete pipeline. NOT persisted. */
  private _muReconciler: MuReconciler | null = null;
  /** Coalesces snap-pairing rebuilds across a burst of op-replay placements. */
  private _pairingRebuildTimer: ReturnType<typeof setTimeout> | null = null;
  /** Extracted multi-select pivot logic. */
  private _multiSelectPivot: MultiSelectPivot | null = null;
  /** Magnetic bbox snap controller — armed at drag-start, disarmed at end. */
  private _bboxSnap: BboxSnapController | null = null;
  /** Tracked ALT key state — read at drag-start to populate layout-drag-start.
   *  The snap-point plugin treats ALT-held drags as "drag solo + detach the
   *  moved asset's chain connections" (mouse-equivalent of an explicit
   *  Detach action; touch users reach the same outcome via the Chain mode
   *  toggle in the Magnetic snap settings panel). */
  private _altDown = false;
  /** Bound window key listeners — installed by the planner alongside the
   *  gizmo, removed on deactivation. */
  private _onWindowKeyDownBound: ((e: KeyboardEvent) => void) | null = null;
  private _onWindowKeyUpBound: ((e: KeyboardEvent) => void) | null = null;
  /** Marquee (rubber-band) selection controller. */
  private _boxSelect: BoxSelectController | null = null;
  /** Clipboard for Ctrl+C / Ctrl+V — deep clones of `PlacedComponent` records
   *  captured at copy time. Paste keeps the source records intact so repeat
   *  pastes always offset from the *original* copied positions. */
  private _clipboard: PlacedComponent[] = [];
  /** Cached drop-to-surface raycast candidates for the active drag. Built once
   *  at drag-start (via `collectDropTargets`) so live drop-during-drag doesn't
   *  re-traverse the entire scene per pointermove. For multi-select drags the
   *  selfObj is the centroid pivot (every selected member is a descendant and
   *  gets excluded automatically). Null when no drag is active or
   *  dropToSurface mode is off. */
  private _dragDropTargets: Mesh[] | null = null;
  /** Whether the single-select object being gizmo-dragged is a Source — cached
   *  at drag-start so the per-frame drop can laterally centre it on a belt
   *  without re-traversing its subtree every pointermove. */
  private _dragIsSource = false;
  /** Resolves once `_loadCatalogs` has finished its first pass. Awaited by
   *  `_restorePlacements` so we can re-resolve placement glbUrls (dead
   *  `blob:` URLs from a prior session) against the freshly-loaded
   *  catalogs by `catalogId`. */
  private _catalogsLoaded: Promise<void> = Promise.resolve();

  /** Guards the one-time `scene-loaded` subscription that auto-enters planner
   *  mode on reload AFTER the scene is fully restored (see `_attachToViewer`). */
  private _plannerActivateHooked = false;

  /** The layout store — public so tests and UI can access it. */
  readonly store: LayoutStore;
  /** Optional cloud extension (Unity Asset Manager). Set via `setExtension()`. */
  private _extension: LayoutPlannerExtension | null = null;

  /** Stable deps bundle for the scene-mutations module. Getters read live
   *  state so the helpers always see the freshest `_viewer` / gizmo /
   *  `_layoutRoot` (initialized in the constructor). */
  private readonly _sceneMutDeps: SceneMutationDeps = {
    getViewer: () => this._viewer,
    objectMap: this._objectMap,
    idByObject: this._idByObject,
    getLayoutRoot: () => this._layoutRoot,
    getTransformControls: () => this._transformControls,
    getModelRoot: () => this._getModelRoot(),
  };

  /**
   * Register a cloud extension (typically the private Unity Asset Manager
   * extension). Called once at startup before the planner activates.
   */
  setExtension(ext: LayoutPlannerExtension): void {
    this._extension = ext;
  }

  /** The active cloud extension, or null in public-only builds. */
  get extension(): LayoutPlannerExtension | null {
    return this._extension;
  }

  /** Convenience: cloud store from the extension, or null. */
  get cloudStore(): LayoutPlannerCloudStore | null {
    return this._extension?.cloudStore ?? null;
  }

  constructor(options?: LayoutPlannerOptions) {
    this._options = options ?? {};
    // Catalog state is process-wide (plan-372 §2.6.1): the Projects dashboard
    // in core/ and this plugin must show the same subscriptions. The planner
    // state around it stays per-plugin.
    this.store = new LayoutStore(getLibraryStore());
    this._pulse = new PendingPulseController({
      gizmoManager: () => this._viewer?.gizmoManager ?? null,
      matchMedia: this._options.matchMedia,
    });

    // Create layout root
    this._layoutRoot = new Group();
    this._layoutRoot.name = '_layoutRoot';
    this._layoutRoot.userData._isLayoutRoot = true;

    // Invisible floor plane for raycast (100x100 meters)
    const floorGeo = new PlaneGeometry(100, 100);
    const floorMat = new MeshBasicMaterial({ visible: false, side: DoubleSide });
    this._floorPlane = new Mesh(floorGeo, floorMat);
    this._floorPlane.rotation.x = -Math.PI / 2;
    this._floorPlane.userData._layoutFloor = true;
    this._layoutRoot.add(this._floorPlane);

    // Visible 30 m × 30 m authoring floor. Sits flush with the raycast
    // plane and just below it (y = -0.001) to avoid z-fighting. Hidden by
    // default — `setLayoutFloorVisible(true)` is called from the Scene
    // window's layout-load path.
    const layoutFloorGeo = new PlaneGeometry(30, 30);
    const layoutFloorMat = new MeshBasicMaterial({ color: 0x9aa0a6, side: DoubleSide });
    this._layoutFloor = new Mesh(layoutFloorGeo, layoutFloorMat);
    this._layoutFloor.rotation.x = -Math.PI / 2;
    this._layoutFloor.position.y = -0.001;
    this._layoutFloor.visible = false;
    this._layoutFloor.userData._layoutFloor = true;
    this._layoutFloor.receiveShadow = true;
    this._layoutRoot.add(this._layoutFloor);

    // Own GLTFLoader + DRACOLoader.
    // The decoder is served from our OWN bundle (`<base>draco/`, emitted by the
    // vite `rv-copy-draco` plugin and served from node_modules in dev), never
    // from the gstatic CDN: that CDN intermittently fails behind corporate
    // proxies and on mobile networks, and when it does, DRACO-compressed
    // library assets never decode at all. This mirrors the central loader in
    // `core/engine/rv-glb-parse.ts`; the planner had been the one holdout.
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    const gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(dracoLoader);

    this._modelCache = new ModelCache(gltfLoader);
    // Builder-only: produces the raw node for the dragged entry. The planner
    // adopts + fully registers it on drag-enter (see `_startDraft`), so the
    // dragged object is a real, selectable, gizmo-bearing placement.
    this._ghost = new GhostManager(this._modelCache);

    // Whenever the preview appears, moves into view, hides, or is adopted,
    // update the aux emphasis so the ghost renders with the selection visual
    // (green OutlinePass in planner mode) without touching the selection.
    this._ghost.onGhostStateChange = () => {
      const ghost = this._ghost.ghost;
      this._viewer?.highlighter.setAuxEmphasis(
        'planner-ghost',
        ghost && this._ghost.visible ? [ghost] : null,
      );
    };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this._attachToViewer(viewer);
    this._installLayoutTransformListener(viewer);
    this._installLayoutDeleteListener(viewer);
    this._installSplatSceneStoreListener(viewer);
    // SignalBindPlugin owns drag, badges, restore and teardown. Keeping those
    // controllers here as well would double-register listeners on every load.
    // Auto-preview generation is wired in _attachToViewer (so the empty-scene
    // path via ensureAttached gets it too).
    // Entering / being in planner mode no longer stops the simulation — it
    // keeps running (sources spawn) until the user actively edits. So we do NOT
    // pause or disable spawning here; the auto-stop happens on edit gestures
    // (placement / move / transform) via `_beginEditPause()`/`_endEditPause()`.
  }

  /**
   * Subscribe to the SceneStore so live Inspector edits to Splat fields
   * (Invert{X,Y,Z}, CropMin/Max{X,Y,Z}) re-apply on the running splatMesh
   * without needing a reload. The action-button path already calls
   * `applySplatTransformFromUserData` directly; this covers the case where
   * the user types a number into the property inspector instead.
   */
  private _splatSceneStoreUnsub: (() => void) | null = null;
  private _installSplatSceneStoreListener(viewer: RVViewer): void {
    this._splatSceneStoreUnsub?.();
    const sceneStore = getSceneStore();
    if (!sceneStore) return;
    this._splatSceneStoreUnsub = sceneStore.subscribe(() => {
      // Cheap and correct — typically a handful of splats per scene.
      for (const [, obj] of this._objectMap) {
        if (obj.userData?._isSplat) applySplatTransformFromUserData(obj, viewer);
      }
    });
  }

  // ── Auto-bind: exact 1:1 CONNECT↔model signal links (no user action) ──
  private _autoBindUnsubs: (() => void)[] = [];
  /** Per-element signature of the last applied (manual+derived) mapping list. */
  private _bindSigCache = new Map<string, string>();
  /** Signature of the available auto-bind signal NAME set at the last global
   *  re-bind. Auto-binding depends only on which signals exist, never on their
   *  live values, so the connect-store tick (which fires on every value update)
   *  skips the expensive fuzzy re-match unless this signature actually changes. */
  private _lastAutoBindSignalSig = '';

  /** All CONNECT interface signals available for auto-binding (dedup by name). */
  private _autoBindSignals(): AutoBindSignal[] {
    const seen = new Set<string>();
    const out: AutoBindSignal[] = [];
    for (const iface of getConnectSnapshot().interfaces) {
      const all = [...(iface.topics ?? []).flatMap(t => t.signals ?? []), ...(iface.signals ?? [])];
      for (const s of all) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        out.push({ name: s.name, direction: s.type.startsWith('PLCOutput') ? 'output' : 'input' });
      }
    }
    return out;
  }

  /** Cheap signature of the available auto-bind signal NAME set. Changes only when
   *  signals are discovered/removed, never on value ticks — so a live connect
   *  stream can skip the expensive per-slot fuzzy re-match. */
  private _autoBindSignalSignature(): string {
    let count = 0;
    const names: string[] = [];
    for (const iface of getConnectSnapshot().interfaces) {
      const all = [...(iface.topics ?? []).flatMap(t => t.signals ?? []), ...(iface.signals ?? [])];
      for (const s of all) { names.push(s.name); count++; }
    }
    return count + '\u0000' + names.join('\u0001');
  }

  /** Apply only persisted user-confirmed bindings for one placed element. */
  private _applyElementBindings(id: string, node: Object3D, manual: readonly SignalMapping[]): void {
    const mgr = this._viewer?.signalBindingManager;
    if (!mgr) return;
    if (mgr.getElementSlots(id, node).length === 0) return;
    const confirmed = manual.map((mapping) => ({ ...mapping }));
    this._bindSigCache.set(id, JSON.stringify(confirmed));
    mgr.applyMappings(id, node, confirmed);
  }

  /**
   * Re-derive auto-binds for EVERY placed element (global, no popover needed).
   * A CONNECT signal whose name equals the model-internal signal is "the same"
   * signal → linked automatically. Only re-applies where the merged mapping list
   * actually changed (signature cache) so it is cheap on frequent store ticks.
   */
  private _refreshAllBindings(): void {
    const mgr = this._viewer?.signalBindingManager;
    if (!mgr) return;
    const signals = this._autoBindSignals();
    const byId = new Map(this.store.getSnapshot().placed.map(p => [p.id, p] as const));
    const live = new Set<string>();
    for (const [id, node] of this._objectMap) {
      const rec = byId.get(id);
      if (!rec || rec.splatUrl) continue;
      const slots = mgr.getElementSlots(id, node);
      if (slots.length === 0) continue;
      live.add(id);
      const confirmed = (rec.signalMappings ?? []).map((mapping) => ({ ...mapping }));
      const sig = JSON.stringify(confirmed);
      if (this._bindSigCache.get(id) === sig) continue;
      this._bindSigCache.set(id, sig);
      mgr.applyMappings(id, node, confirmed);
    }
    for (const id of [...this._bindSigCache.keys()]) if (!live.has(id)) this._bindSigCache.delete(id);
  }

  /** Re-run the global auto-bind whenever CONNECT signals or placements change. */
  private _installAutoBindListeners(viewer: RVViewer): void {
    for (const u of this._autoBindUnsubs) u();
    this._autoBindUnsubs = [];
    if (!viewer.signalBindingManager) return;
    // The connect-store ticks on every signal VALUE update — under a live CONNECT
    // stream that is continuous. Auto-binding depends only on the set of signal
    // NAMES, so gate the (expensive, per-slot Fuse.js fuzzy) global re-bind on an
    // actual change to the signal-name signature; otherwise every value tick ran
    // the full matcher over every slot and stalled the main thread for ~1s+.
    this._autoBindUnsubs.push(subscribeConnectStore(() => {
      const sig = this._autoBindSignalSignature();
      if (sig === this._lastAutoBindSignalSig) return;
      this._lastAutoBindSignalSig = sig;
      this._refreshAllBindings();
    }));
    // Placement changes are rare — always re-bind (name set may be unchanged but
    // the placed elements/slots differ).
    this._autoBindUnsubs.push(this.store.subscribe(() => this._refreshAllBindings()));
    // Initial pass for whatever is already placed + connected.
    this._lastAutoBindSignalSig = this._autoBindSignalSignature();
    this._refreshAllBindings();
  }

  /** 3D status-badge controller for Planner Signal Linking (plan-226). */
  private _signalBadges: SignalBadgeController | null = null;
  /**
   * (Re)create the signal-badge controller for the current model. The viewer's
   * `signalBindingManager` is rebuilt on every model load (fresh signalStore +
   * registry), so the controller — which hooks `manager.onStateChanged` — must
   * be recreated against the fresh manager. No-op when the feature flag is off
   * (no manager → no controller). The controller self-syncs to the persisted
   * `signalLinkMode` and listens to the layout store for placement changes.
   */
  private _installSignalBadges(viewer: RVViewer): void {
    this._signalBadges?.dispose();
    this._signalBadges = null;
    if (!viewer.signalBindingManager) return;
    this._signalBadges = new SignalBadgeController(viewer, this);
  }

  /**
   * Listen for `layout-objects-deleted` (emitted by the hierarchy browser
   * context-menu's Delete action). The context-menu only knows node paths;
   * we resolve them to placement IDs and route through the planner's normal
   * removal pipeline so undo/redo + SceneStore ops stay consistent.
   */
  private _layoutDeleteUnsub: (() => void) | null = null;
  private _installLayoutDeleteListener(viewer: RVViewer): void {
    this._layoutDeleteUnsub?.();
    this._layoutDeleteUnsub = viewer.on('layout-objects-deleted', (data: unknown) => {
      const evt = data as { paths?: string[] };
      const paths = evt?.paths ?? [];
      if (paths.length === 0) return;
      void this.removeByPaths(paths);
    });
  }

  /**
   * Idempotent host-scene setup. Called from `onModelLoaded` (the normal
   * path: a GLB just loaded) and from `ensureAttached()` (the empty-scene
   * path: the Scene window created a new layout without a base GLB).
   */
  ensureAttached(viewer: RVViewer): void {
    this._attachToViewer(viewer);
  }

  /** Backward-compat alias for entering planner mode (plan-198). Prefer
   *  `viewer.modes.setMode('planner')`. Kept for the `?mode=planner` deep-link
   *  path and any external/bookmarked callers. */
  openPlanner(): void {
    this._viewer?.modes.setMode('planner');
  }

  /** plan-198: entering the planner workspace — open the library panel and
   *  activate the edit bindings. Called by the ModeManager AFTER the plugin has
   *  been (re-)enabled and any missed onModelLoaded replayed, so `_viewer` and
   *  the live model state are available. */
  onModeActivate(_mode: ModeId, viewer: RVViewer): void {
    // On the compact (phone-width) layout the library would open fullscreen and
    // hide the scene on entry, so we don't auto-open it there — the user reveals
    // it via the bottom library tab (see LayoutLibraryPanel mobile strip). On the
    // standard layout it docks to the right as before.
    if (!isCompactWidth(window.innerWidth)) {
      viewer.leftPanelManager.open('layout-planner', LAYOUT_PANEL_WIDTH, 'right');
    }
    this.setActive(true);
  }

  /** plan-198: leaving the planner workspace — deactivate the edit bindings and
   *  close the panel. Called BEFORE the plugin is disabled (scene/model refs
   *  still valid). setActive(false) tears down raycast filter, OutlinePass,
   *  selection subscription, gizmo, etc. (see setActive). */
  onModeDeactivate(_mode: ModeId | null, viewer: RVViewer): void {
    this.setActive(false);
    if (viewer.leftPanelManager.isOpen?.('layout-planner')) {
      viewer.leftPanelManager.close('layout-planner');
    }
  }

  /**
   * plan-435: the user switched the plugin off in the feature matrix. Without
   * this hook the fallback would run `onModelCleared` — which cancels pending
   * placeholder swaps and disposes the MU reconciler although the model is
   * unchanged — while a pause held mid-gesture would freeze the simulation
   * for good, because `LAYOUT_EDIT_PAUSE_REASON` is only ever released by a
   * balanced `_endEditPause()`.
   *
   * So: release the edit pause unconditionally, then do exactly what leaving
   * the planner mode does. Nothing model-owned is touched (invariant 3) —
   * `onModelCleared` keeps that job.
   */
  onDeactivate(viewer: RVViewer): void {
    // Force-release: an interrupted gesture can leave the refcount above 0,
    // and nothing else would ever bring it back down.
    if (this._editPauseDepth > 0) {
      this._editPauseDepth = 0;
      viewer.setSimulationPaused?.(LAYOUT_EDIT_PAUSE_REASON, false);
    }
    this.onModeDeactivate(null, viewer);
  }

  private _attachToViewer(viewer: RVViewer): void {
    this._viewer = viewer;

    // plan-410 F1: teach the asset editor how to read a planner selection.
    // Registered here (idempotent attach point) rather than in a mode hook,
    // because the resolver is asked on `mode-changing` — i.e. while the planner
    // is still the active mode but already on its way out.
    if (!this._unregisterAssetResolver) {
      this._unregisterAssetResolver = registerSelectionAssetResolver(
        (path) => this._resolveSelectionToAsset(path),
      );
    }

    // No preview sweep here any more (plan-372 §2.7). Previews used to be
    // enqueued from a store subscription that walked every catalog on every
    // mutation; cards now request their own when they scroll into view, so a
    // 500-asset library no longer decodes 500 GLBs the user never looks at.

    // Double-add guard: only add to scene once
    if (!this._layoutRoot.parent) {
      viewer.scene.add(this._layoutRoot);
      (viewer as unknown as { sceneFixtures: Set<Object3D> }).sceneFixtures.add(this._layoutRoot);
    }

    // Exclude only ghost, floor, and grid from standard raycasts (NOT placed objects)
    if (viewer.raycastManager) {
      viewer.raycastManager.addExcludeFilter(
        (node: Object3D) => !!node.userData._isGhost || !!node.userData._layoutFloor || !!node.userData._isLayoutRoot,
      );

      // Register ancestor override: when planner is active, hover/click resolves
      // to the full placed object instead of individual sub-components — for
      // BOTH layout instances and spawned MUs (sub-mesh hits resolve to the MU
      // root). The allow filter set in setActive() also gates non-selectable hits.
      if (!this._ancestorOverrideFn) {
        this._ancestorOverrideFn = (node: Object3D): Object3D | null => {
          if (!this._active) return null;
          const root = findPlannerSelectableAncestor(node);
          if (!root) return null;
          if (isLockedLayoutInstance(root)) return null;
          return root;
        };
        viewer.raycastManager.addAncestorOverride(this._ancestorOverrideFn);
      }
    }

    // Initialize the FloorGizmo (replaces Three.js TransformControls).
    // Disc on the floor for XZ translation, ring around it for Y rotation.
    if (!this._transformControls) {
      // Pass a live getter so the gizmo follows perspective ↔ orthographic
      // camera swaps (clicks/raycasts use the camera that's actually drawing).
      this._transformControls = new FloorGizmo(
        () => viewer.camera as PerspectiveCamera,
        viewer.renderer as unknown as WebGLRenderer,
        viewer.scene,
      );
      viewer.scene.add(this._transformControls.root);
      // Register as a sceneFixture so clearModel skips it on every model
      // switch — the gizmo persists across loads and must not look like a
      // GLB root candidate to the viewer's clear/load logic.
      (viewer as unknown as { sceneFixtures: Set<Object3D> })
        .sceneFixtures.add(this._transformControls.root);

      // Magnetic bbox snap — wired permanently into the gizmo via a callback;
      // the controller self-checks store.bboxSnapEnabled, so toggling the
      // toolbar button takes effect mid-drag without re-wiring.
      const sceneFixtures = (viewer as unknown as { sceneFixtures: Set<Object3D> }).sceneFixtures;
      this._bboxSnap = new BboxSnapController({
        scene: viewer.scene,
        store: this.store,
        getAllPlaced: () => this._objectMap.values(),
        markRenderDirty: () => this._viewer?.markRenderDirty(),
        markAsFixture: (node) => sceneFixtures.add(node),
        unmarkAsFixture: (node) => sceneFixtures.delete(node),
      });
      this._transformControls.setCustomSnap(
        (nx, nz, lock) => this._bboxSnap?.applySnap(nx, nz, lock) ?? null,
      );

      this._transformControls.onDraggingChanged = (dragging: boolean) => {
        const v = this._viewer;
        if (v) {
          v.controls.enabled = !dragging;
          // Suppress hover while dragging — clear any active hover overlay
          // and disable the raycast manager so new hover doesn't fire as
          // the cursor passes over other objects mid-drag. Restored on end.
          if (dragging) {
            v.highlighter.clear();
            v.raycastManager?.setEnabled?.(false);
          } else {
            v.raycastManager?.setEnabled?.(true);
          }
          // Auto-stop the simulation when the user starts moving a placed
          // object (or MU) via the gizmo, and auto-resume on drag-end if the
          // sim was running before the edit (refcounted; manual pause kept).
          if (dragging) this._beginEditPause();
          else this._endEditPause();
        }
        if (dragging) {
          // Arm magnetic bbox snap — captures the moving root's AABB and
          // freezes every other placed object's AABB. Cheap one-time cost
          // (~1 ms for typical layouts). Disarm fires below at drag-end.
          const movingRoot = this._transformControls?.target ?? null;
          if (movingRoot) this._bboxSnap?.armForDrag(movingRoot);

          // Broadcast drag-start so external plugins (snap-point magnetic
          // snap) can arm their own per-drag state. Pass the current ALT
          // modifier state so the snap plugin can treat ALT-held drags as
          // "solo + detach this asset's chain connections".
          if (movingRoot) this._viewer?.emit('layout-drag-start', {
            node: movingRoot,
            altKey: this._altDown,
          });

          // Cache drop-to-surface targets ONCE per drag. For single-select
          // the selfObj is the placed object; for multi-select it's the
          // centroid pivot Group — every member is a descendant and gets
          // excluded automatically. The live drop runs in onChange below
          // and uses the dispatch path for the active selection kind.
          const isMulti = !!this._multiSelectPivot?.isActive
            && this._multiSelectPivot.memberCount > 0;
          if (this.store.dropToSurface && v) {
            if (isMulti) {
              const pivot = this._transformControls?.target;
              if (pivot) this._dragDropTargets = this._collectDropTargetsWithTransport(pivot);
            } else {
              const selectedId = this.store.getSnapshot().selectedId;
              const obj = selectedId ? this._objectMap.get(selectedId) : null;
              if (obj) {
                this._dragDropTargets = this._collectDropTargetsWithTransport(obj);
                // Cache once: a Source re-dragged onto a belt centres laterally.
                this._dragIsSource = subtreeHasComponent(obj, 'Source');
              }
            }
          }
        } else {
          // Disarm bbox snap — drop frozen state, hide guide lines.
          // NOTE: don't reset `_dragIsSource` here — onDragEnd fires AFTER this
          // and still needs it for the final centering drop. It is recomputed at
          // the start of every single-select drag, so it never goes stale.
          this._bboxSnap?.disarm();
          this._dragDropTargets = null;

          // Broadcast drag-end so external plugins can finalise their per-
          // drag state (snap-point magnetic snap marks occupied here).
          const endRoot = this._transformControls?.target ?? null;
          if (endRoot) {
            this._viewer?.emit('layout-drag-end', { node: endRoot });
            // The magnetic snap (run synchronously inside the emit above) only
            // pairs the SINGLE engaged snap. A piece dropped so that MORE than
            // one of its ports lands on a neighbour (closing a loop, or a
            // multi-port turntable) needs every coincident end paired. Reuse the
            // reload reconstruction: it skips already-occupied snaps (the engaged
            // pair) and pairs the remaining coincident ends. No-op when nothing
            // else is coincident.
            this._scheduleSnapPairingRebuild();
          }
          // Multi-select: snapshot each member's transform back into
          // its original parent's local frame and write to the store.
          // CRITICAL: writeTransformsOnDragEnd() must run synchronously
          // before any tearDown() — see MultiSelectPivot JSDoc.
          if (this._multiSelectPivot?.isActive && this._multiSelectPivot.memberCount > 0) {
            this._multiSelectPivot.writeTransformsOnDragEnd();
          } else {
            // Single-select: flush final transform to store + autosave
            // only at drag-end (not every pointermove frame).
            const selectedId = this.store.getSnapshot().selectedId;
            if (selectedId) {
              const obj = this._objectMap.get(selectedId);
              if (obj) this._writeSingleTransform(selectedId, obj);
            }
          }
        }
      };

      this._transformControls.onChange = () => {
        const v = this._viewer;
        if (!v) return;
        // Live drop-to-surface during drag. Uses the cached candidate list
        // so the cost per pointermove is one raycast, not a full scene
        // traverse. Multi-select drags drop the entire centroid pivot: ray
        // casts from the gizmo's XZ, union AABB bottom snaps to surface,
        // members shift rigidly with the pivot.
        if (this._dragDropTargets) {
          const isMulti = !!this._multiSelectPivot?.isActive
            && this._multiSelectPivot.memberCount > 0;
          if (isMulti) {
            const pivot = this._transformControls?.target;
            if (pivot) dropPivotToSurface(pivot, v.scene, this._dragDropTargets);
          } else {
            const selectedId = this.store.getSnapshot().selectedId;
            const obj = selectedId ? this._objectMap.get(selectedId) : null;
            if (obj) dropToSurface(obj, v.scene, this._dragDropTargets, this._dragIsSource);
          }
        }
        // Broadcast per-frame drag tick so external plugins (snap-point
        // magnetic snap) can override the gizmo's position/rotation before
        // render. Listeners must NOT keep allocations alive across calls.
        const tickRoot = this._transformControls?.target ?? null;
        if (tickRoot) v.emit('layout-drag-tick', { node: tickRoot });
        // Auto-drop on snap-point engage: the moment the magnetic snap mates a
        // pair (set synchronously by the tick above), finish the drag so the
        // object stays in the connection — the user re-grabs it to move again.
        // (Only snap-point connections drop; bbox/grid alignment snaps don't.)
        const snapPlugin = v.getPlugin<SnapPointPlugin>('snap-point');
        if (snapPlugin?.getMagnetic?.()?.getLastPair?.()) {
          this._transformControls?.endDrag();
        }
        // markShadowsDirty (not just render) so the dragged asset's shadow
        // tracks it continuously, instead of staying frozen at the start pose.
        v.markShadowsDirty();
        // Store write + autoSave deferred to onDraggingChanged(false)
        // to avoid O(placed) allocations + JSON.stringify on every frame.
      };

      this._transformControls.onDragEnd = () => {
        // Final safety drop at drag-end. For single-select, _dragDropTargets
        // is null at this point (onDraggingChanged(false) cleared it just
        // before); we re-traverse once for the final commit. The live
        // dropping during onChange already left obj at the right Y; this
        // call just normalises against the freshly-stable scene state.
        if (!this._viewer || !this.store.dropToSurface) return;
        if (this._multiSelectPivot?.isActive) return;  // multi-select: skip (frame-mismatch)
        const selectedId = this.store.getSnapshot().selectedId;
        if (!selectedId) return;
        const obj = this._objectMap.get(selectedId);
        if (obj) {
          dropToSurface(obj, this._viewer.scene, this._collectDropTargetsWithTransport(obj), this._dragIsSource);
          this._writeSingleTransform(selectedId, obj);
          this._viewer.markShadowsDirty();
        }
      };

      // Y-axis bar is the manual lift handle — show it only when dropToSurface
      // is off (otherwise the dropToSurface logic snaps Y back on every release).
      this._transformControls.setYAxisEnabled(!this.store.dropToSurface);
    }

    // Wire canvas events via the extracted CanvasInteractionManager.
    // IDEMPOTENT: onModelLoaded fires on every scene switch under the
    // unified Scene model. Re-running wire() would register duplicate
    // document-level drop / pointer listeners — and each drag-drop would
    // then call placeComponent twice. Same for _loadCatalogs which would
    // re-run loadAutoSave and re-place every component.
    if (!this._canvasInteraction) {
      // Build the marquee controller first so we can hand its `start` API
      // to the CanvasInteractionManager via deps. Mounted div lifecycle is
      // owned by the controller (see attach()/dispose()).
      this._boxSelect = new BoxSelectController({
        viewer,
        canvas: viewer.renderer.domElement,
        objectMap: this._objectMap,
        // Read viewer.registry fresh on every commit — it's replaced on
        // each model load. Caching here used to silently break box-select
        // after the first model switch.
        getRegistry: () => viewer.registry,
        getActive: () => this._active,
        // Spawned MUs participate in the marquee too (read lazily — the
        // reconciler is built just below and its map mutates as MUs spawn).
        getMuMap: () => this._muReconciler?.objectMap.values() ?? null,
      });
      this._boxSelect.attach();

      // Reconciler that registers spawned clone-MU nodes as selectable scene
      // nodes (registry + aux raycast targets + `_muSelectable` marker), so MUs
      // flow through the SAME hover/click/box/multi/outline/delete pipeline as
      // layout objects — without `_layoutId`, `_objectMap`, or persistence.
      this._muReconciler = new MuReconciler({
        viewer,
        getMUs: () => viewer.transportManager?.mus ?? [],
        onSelectionDropped: () => this._viewer?.selectionManager.refreshHighlight(),
      });

      const canvasDeps: CanvasInteractionDeps = {
        viewer,
        store: this.store,
        canvas: viewer.renderer.domElement,
        objectMap: this._objectMap,
        idByObject: this._idByObject,
        floorPlane: this._floorPlane,
        transformControls: this._transformControls,
        modelRoot: this._getModelRoot(),
        getPlacementEntry: () => this._getPlacementEntry(),
        setDragEntry: (entry) => this.setDragEntry(entry),
        getDragEntry: () => this._dragEntry,
        startDraft: (entry) => { void this._startDraft(entry); },
        moveDraft: (rawX, rawZ) => this._moveDraft(rawX, rawZ),
        commitDraft: (entry, coords) => this._commitDraft(entry, coords),
        cancelDraft: () => this._cancelDraft(),
        hideDraft: () => this._hideDraft(),
        markDropCommitted: () => { this._dropCommitted = true; },
        removeSelected: () => this.removeSelected(),
        duplicateSelected: () => this.duplicateSelected(),
        copySelected: () => this.copySelected(),
        pasteClipboard: () => this.pasteClipboard(),
        selectObjectById: (id) => this._selectObject(id),
        isActive: () => this._active,
        boxSelect: this._boxSelect,
        // bboxSnap was constructed alongside the FloorGizmo a few lines above
        // — non-null by the time we reach this canvas-interaction init block.
        bboxSnap: this._bboxSnap!,
      };
      this._canvasInteraction = new CanvasInteractionManager(canvasDeps);
      this._canvasInteraction.wire();

      this._catalogsLoaded = this._loadCatalogs().catch((e) => {
        console.warn('[LayoutPlanner] _loadCatalogs failed:', e);
      });
    }

    // Selection is driven by the global SelectionManager pipeline
    // (canvas pointerup → raycast → allow-filter → SelectionManager.select).
    // The planner subscribes to 'selection-changed' inside setActive() to attach
    // TransformControls and manage the multi-pivot — see _onSelectionChanged.
    // No 'object-clicked' listener is needed.

    // Restore planner open state from localStorage. Planner docks to the
    // right slot — use isOpen() which is side-agnostic.
    viewer.leftPanelManager.restore?.({ 'layout-planner': LAYOUT_PANEL_WIDTH });
    // Enter planner mode only AFTER the scene is FULLY loaded — model, restored
    // placements, re-scanned snap points and rebuilt snap pairings (enchainment).
    // `_attachToViewer` runs during `onModelLoaded` (loadScene Phase 3), BEFORE
    // placements are restored (Phase 4); activating here left the snap points,
    // chaining and toolbar half-initialised on a page reload — hence the user
    // had to toggle the planner off/on to repair it. `scene-loaded` (emitted at
    // the very end of loadScene, after placements + drain) is the "everything
    // ready" signal. Subscribe once; the handler re-reads the persisted open
    // state on every scene load.
    if (!this._plannerActivateHooked) {
      this._plannerActivateHooked = true;
      const unsubActivate = viewer.on('scene-loaded', () => {
        if (!viewer.leftPanelManager.isOpen?.('layout-planner')) return;
        // Re-cycle if the planner was ALREADY active. Across a scene switch /
        // discard the plugin stayed `_active`, so its edit bindings (selection +
        // store subscriptions, TransformControls, raycast allow-filter, MU
        // reconciler, outline/highlight styles) and the 'planner' UI context were
        // still bound to the now-disposed scene and never rebuilt — leaving the
        // toolbar and planner half-loaded. Tear down then re-activate so every
        // binding re-attaches to the freshly-loaded scene. (First load: `_active`
        // is false, so this is just a plain activate.)
        if (this._active) this.setActive(false);
        this.setActive(true);
      });
      this._unsubs.push(unsubActivate);
    }

    // Defense-in-Depth: if another plugin replaces the panel by calling
    // `lpm.open('other', w, 'right')` (which displaces our 'layout-planner'
    // panel without ever calling our close path), auto-release the
    // 'layout-edit' pause reason. Without this, opening a competing right
    // panel while planner was active would leave the simulation frozen.
    const lpm = viewer.leftPanelManager;
    if (typeof lpm.subscribe === 'function' && typeof lpm.isOpen === 'function') {
      const lpmUnsub = lpm.subscribe(() => {
        if (this._active && !lpm.isOpen?.('layout-planner')) {
          // Panel closed or displaced by another plugin while planner was active.
          // The library is OPTIONAL in planner mode: if we're in planner MODE,
          // do NOTHING — stay in the mode with edit bindings active; the library
          // is simply hidden (toggle it back via the toolbar Library button).
          // Only in the pre-mode (standalone) path do we release the edit
          // bindings so the simulation isn't left frozen.
          if (viewer.modes?.activeMode !== 'planner') this.setActive(false);
        }
      });
      this._unsubs.push(lpmUnsub);
    }
  }

  onModelCleared(_viewer: RVViewer): void {
    // Abandon in-flight placeholder swaps (plan-371 H4). `prepPlacedVisual`
    // parents placements under `getModelRoot()` = `viewer.currentModel`, so a
    // model change would otherwise land the real geometry under a parent that
    // is being disposed in the same breath.
    this._pending.cancelAll();
    // Same reason for the halos: the GizmoOverlayManager is cleared on model
    // switch, so handles kept past this point would dispose entries that are
    // already gone.
    this._pulse.stopAll();
    // The previous scene's MUs are disposed on model clear — unregister all
    // MU selectable nodes so we don't hold dangling registry/aux entries.
    this._muReconciler?.disposeAll();
    if (this._pairingRebuildTimer !== null) {
      clearTimeout(this._pairingRebuildTimer);
      this._pairingRebuildTimer = null;
    }
    // Layout state survives model clear — _layoutRoot is in sceneFixtures
    // Drop the always-on persistence listener; onModelLoaded re-installs it
    // for the next scene.
    this._transformUpdateUnsub?.();
    this._transformUpdateUnsub = null;
    this._layoutDeleteUnsub?.();
    this._layoutDeleteUnsub = null;
    this._splatSceneStoreUnsub?.();
    this._splatSceneStoreUnsub = null;
    // Signal-badge controller is bound to the just-cleared binding manager;
    // drop it. onModelLoaded recreates it against the fresh manager.
    this._signalBadges?.dispose();
    this._signalBadges = null;
  }

  /**
   * Install the `layout-transform-update` persistence listener. Runs once
   * per model load (in `onModelLoaded`) so inspector/dialog edits persist
   * regardless of whether the planner is in active edit mode — locking,
   * visibility, axis inversion, and Set-Position all flow through this
   * single sink. Detached in `onModelCleared` / `dispose`.
   */
  private _installLayoutTransformListener(viewer: RVViewer): void {
    this._transformUpdateUnsub?.();
    this._transformUpdateUnsub = viewer.on('layout-transform-update', (data: unknown) => {
      const evt = data as {
        path: string;
        position: [number, number, number];
        rotation: [number, number, number];
        scale?: [number, number, number];
        visible?: boolean;
      };
      // Find the placed component by matching the node path
      for (const [id, obj] of this._objectMap) {
        const nodePath = viewer.registry?.getPathForNode(obj);
        if (nodePath !== evt.path) continue;
        const prevSnap = this.store.getSnapshot().placed.find(c => c.id === id);
        const prev = prevSnap
          ? { position: [...prevSnap.position] as [number, number, number],
              rotation: [...prevSnap.rotation] as [number, number, number],
              scale: [...prevSnap.scale] as [number, number, number] }
          : { position: [0, 0, 0] as [number, number, number],
              rotation: [0, 0, 0] as [number, number, number],
              scale: [1, 1, 1] as [number, number, number] };
        this.store.updateTransform(id, evt.position, evt.rotation);
        // Optional fields: scale (axis inversion) + visible (hide/show) ride
        // on the same event so a single inspector edit produces one
        // coalesced store change and one op-log entry.
        const nextScale = evt.scale ?? prev.scale;
        if (evt.scale) this.store.updateScale(id, evt.scale);
        if (evt.visible !== undefined) this.store.updateVisibility(id, evt.visible);
        this.store.autoSave();
        emitPlannerOp(viewer, {
          id: opId(), ts: Date.now(), schemaV: 1,
          kind: 'transformPlacement', placementId: id,
          position: evt.position, rotation: evt.rotation, scale: nextScale,
          prev,
        });
        break;
      }
    });
  }

  /** Per-frame hook: keep the FloorGizmo positioned and scale-invariant. */
  onRender(_frameDt: number): void {
    // Keep spawned-MU selectable registration in sync with the sim (register
    // new clone MUs, unregister consumed ones + drop their selection).
    if (this._active) this._muReconciler?.reconcile();
    this._transformControls?.update();
  }

  dispose(): void {
    // Selection→asset resolver first: it closes over `this`, so it must not
    // outlive the plugin (plan-410 F1).
    this._unregisterAssetResolver?.();
    this._unregisterAssetResolver = null;

    // Box-select first — removes any active window/document listeners before
    // the canvas interaction manager tears down its own listeners.
    this._boxSelect?.dispose();
    this._boxSelect = null;

    // Canvas interaction next — removes all event listeners before teardown
    this._canvasInteraction?.dispose();
    this._canvasInteraction = null;

    // MU reconciler — unregister all MU selectable nodes (registry + aux).
    this._muReconciler?.disposeAll();
    this._muReconciler = null;
    if (this._viewer?.transportManager) this._viewer.transportManager.preferCloneMU = false;

    // SignalBindPlugin owns badge teardown; RVViewer owns the binding manager.
    this._signalBadges?.dispose();
    this._signalBadges = null;

    if (this._pairingRebuildTimer !== null) {
      clearTimeout(this._pairingRebuildTimer);
      this._pairingRebuildTimer = null;
    }

    // Multi-select pivot next — restores parenting before gizmo detach
    this._multiSelectPivot?.tearDown();
    this._multiSelectPivot = null;

    if (this._transformControls) {
      this._transformControls.setCustomSnap(null);
      this._transformControls.detach();
      // Deregister from sceneFixtures before disposing so the set doesn't
      // hold a stale reference (matches the add in _attachToViewer).
      if (this._viewer) {
        (this._viewer as unknown as { sceneFixtures: Set<Object3D> })
          .sceneFixtures.delete(this._transformControls.root);
      }
      this._transformControls.dispose();
      this._transformControls = null;
    }
    this._bboxSnap?.dispose();
    this._bboxSnap = null;
    if (this._layoutRoot.parent) {
      this._layoutRoot.parent.remove(this._layoutRoot);
    }
    if (this._viewer) {
      (this._viewer as unknown as { sceneFixtures: Set<Object3D> }).sceneFixtures.delete(this._layoutRoot);
    }

    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];

    for (const u of this._autoBindUnsubs) u();
    this._autoBindUnsubs = [];
    this._bindSigCache.clear();

    // Remove ancestor override from raycast manager
    if (this._ancestorOverrideFn && this._viewer?.raycastManager) {
      this._viewer.raycastManager.removeAncestorOverride(this._ancestorOverrideFn);
      this._ancestorOverrideFn = null;
    }

    this._modelCache.dispose();
    this._ghost.dispose();

    // The thumbnail renderer, cache and queue belong to the viewer now
    // (plan-372 §2.7) and outlive this plugin — nothing to tear down here.
    if (this._gridHelper) {
      disposeSubtree(this._gridHelper);
      this._gridHelper = null;
    }
    // Abandon every in-flight placeholder → geometry swap before the object map
    // is emptied, so no late arrival can re-enter a half-torn-down plugin.
    this._pending.cancelAll();
    // Releases the pulse gizmos AND the prefers-reduced-motion listener; the
    // controller is not rebuilt per model, so this is the only place the
    // watcher can be detached.
    this._pulse.dispose();
    for (const [, obj] of this._objectMap) {
      // ⛔ A pending placeholder must NOT go through `disposeSubtree`: that
      // helper duck-types on `.geometry` without an `isMesh` check, and the
      // placeholder's billboard is a `Sprite` whose geometry is a three.js
      // MODULE SINGLETON. Disposing it here would silently destroy every
      // sprite in the app — snap markers, source markers, avatars,
      // annotations, measurements, gizmo overlays.
      if (isPlaceholderNode(obj)) disposePlaceholderNode(obj as PlaceholderNode);
      else disposeSubtree(obj);
    }
    this._objectMap.clear();
    this._selectionUnsub?.();
    this._selectionUnsub = null;
    this._docHoverUnsub?.();
    this._docHoverUnsub = null;
    this._docUnhoverUnsub?.();
    this._docUnhoverUnsub = null;
    this._docClickUnsub?.();
    this._docClickUnsub = null;
    this._transformUpdateUnsub?.();
    this._transformUpdateUnsub = null;
    // Safety net: release any granular pause reasons we may still hold.
    // setActive(false) above is the primary release path; this handles edge
    // cases where dispose() is called while still active (plugin teardown,
    // viewer shutdown, model swap without explicit close). Also releases the
    // legacy 'layout-edit' reason in case any external code still sets it.
    this._viewer?.setSimulationPaused?.('layout-drag', false);
    this._viewer?.setSimulationPaused?.('layout-placement', false);
    this._viewer?.setSimulationPaused?.('layout-edit', false);
    // Reset edit-pause bookkeeping so a fresh attach starts clean.
    this._editPauseDepth = 0;
    this._dragEntryEditActive = false;
    this._viewer = null;
    // Detach the library notification bridge (§2.6.2 point 3). The library
    // store is process-wide and outlives the plugin — without this, every
    // torn-down planner would leave a listener writing into a dead snapshot.
    this.store.dispose();
  }

  // ─── Public API ───────────────────────────────────────────────────

  get active(): boolean { return this._active; }

  /** Refcount of in-flight 3D edit gestures (drag / transform / placement). */
  private _editPauseDepth = 0;

  /**
   * Begin an edit-gesture pause: dragging in an asset, moving a placed object,
   * or transforming one via the gizmo. Uses a DEDICATED pause reason (distinct
   * from the user's manual pause) and refcounts overlapping gestures. The
   * "was running" state is captured on the first (0→1) acquisition so the
   * matching `_endEditPause()` can auto-resume — but only when no other reason
   * (e.g. a manual user pause engaged mid-edit) still holds the sim.
   */
  private _beginEditPause(): void {
    const v = this._viewer;
    if (!v) return;
    if (this._editPauseDepth === 0) {
      v.setSimulationPaused?.(LAYOUT_EDIT_PAUSE_REASON, true);
    }
    this._editPauseDepth++;
  }

  /**
   * End an edit-gesture pause. When the last overlapping gesture finishes, ALWAYS
   * release the planner's own edit reason. `setSimulationPaused` keys are
   * independent and refcounted per reason, so dropping `LAYOUT_EDIT_PAUSE_REASON`
   * resumes the sim ONLY when no other reason (e.g. a manual `USER_PAUSE_REASON`)
   * still holds it — which is exactly "resume iff it was running before the
   * edit". Previously this was gated on a captured `_editWasRunning`, which
   * LEAKED the edit pause whenever a gesture began while the sim was already
   * paused: the reason was set in `_beginEditPause` but never released, so a
   * later Play (which only toggles the user reason) could not start the sim in
   * planner mode.
   */
  private _endEditPause(): void {
    if (this._editPauseDepth === 0) return;
    this._editPauseDepth--;
    if (this._editPauseDepth === 0) {
      this._viewer?.setSimulationPaused?.(LAYOUT_EDIT_PAUSE_REASON, false);
    }
  }

  setActive(active: boolean): void {
    if (this._active === active) return;
    this._active = active;
    setContext('planner', active);

    const viewer = this._viewer;
    if (!viewer) {
      if (this._gridHelper) this._gridHelper.visible = active && this.store.gridActive;
      return;
    }

    // Planner mode no longer stops the simulation on enter — it keeps running
    // so the user sees live behaviour while laying out. The sim is auto-stopped
    // only when the user actively edits (place / move / transform), via
    // `_beginEditPause()`, and auto-resumes on gesture end if it was running.

    if (!active) {
      // Drop modifier listeners installed when entering planner mode.
      if (this._onWindowKeyDownBound) window.removeEventListener('keydown', this._onWindowKeyDownBound);
      if (this._onWindowKeyUpBound) window.removeEventListener('keyup', this._onWindowKeyUpBound);
      this._onWindowKeyDownBound = null;
      this._onWindowKeyUpBound = null;
      this._altDown = false;
    }

    if (active) {
      // Track the ALT modifier on the window so drag-start can capture it.
      // Using window listeners (rather than reading from the most recent
      // pointer event) handles the case where the user presses ALT AFTER
      // mousedown but BEFORE the first pointermove that promotes to a drag.
      this._onWindowKeyDownBound = (e: KeyboardEvent) => { if (e.key === 'Alt') this._altDown = true; };
      this._onWindowKeyUpBound = (e: KeyboardEvent) => { if (e.key === 'Alt') this._altDown = false; };
      window.addEventListener('keydown', this._onWindowKeyDownBound);
      window.addEventListener('keyup', this._onWindowKeyUpBound);

      // Entering planner mode — clear any pre-existing (non-layout) selection
      // so we start clean. The new allow filter would otherwise leave a
      // now-unreachable selection in place visually until the next click.
      viewer.selectionManager.clear();

      // 1. Restrict raycast hits to planner-selectable nodes (layout instances
      //    AND spawned MUs). Save prior filter for coexistence with other plugins.
      this._priorAllowFilter = viewer.raycastManager?.getAllowFilter?.() ?? null;
      viewer.raycastManager?.setAllowFilter((node) =>
        isPlannerSelectable(node) && !isLockedLayoutInstance(node));

      // Spawn MUs as clones (real Object3Ds) while planner is active so they can
      // be registered as selectable scene nodes (instanced MUs have no per-
      // instance node). Reset on exit.
      if (viewer.transportManager) viewer.transportManager.preferCloneMU = true;

      // 2.+3. Highlight styles: the green planner profile (overlay fallback +
      //    OutlinePass hover/selection) is installed by RVHighlightPolicy on
      //    mode-changed — nothing to do here.

      // 4. Subscribe to selection changes — drives TransformControls + multi-pivot.
      //    The selection visual itself flows through SelectionManager →
      //    highlightSelection (green OutlinePass under the planner profile).
      this._selectionUnsub = viewer.on('selection-changed',
        this._onSelectionChanged as (data: unknown) => void);

      // 4b. Documentation-mode motor datasheet: in the planner, hover resolves to
      //     the whole placement, so the shared augmenter finds the gated drive by
      //     world bounding box under the hit point (gated to documentation mode).
      this._docHoverUnsub = viewer.on('object-hover',
        (h: ObjectHoverState | null) => showDocModeDatasheet(viewer, h, this._docHoverTipId));
      this._docUnhoverUnsub = viewer.on('object-unhover', () => tooltipStore.hide(this._docHoverTipId));
      // Tap/click on a motor opens the full AAS detail panel (nameplate + PDFs) —
      // the hover augmenter is hover-only, and on touch there is no hover at all.
      this._docClickUnsub = viewer.on('object-clicked',
        (d: { hitPoint?: [number, number, number] }) => openDocModeDetailAtPoint(viewer, d?.hitPoint));

      // 5. Track dropToSurface toggle → show/hide the gizmo's Y-axis lift handle.
      //    The Y bar lets users place objects above the floor; when dropToSurface
      //    is on it would just be re-snapped, so we hide it.
      //    Also track placementMode → pause the simulation while a library
      //    entry is being placed (ghost preview is following the cursor), so
      //    sources don't spawn before the user drops the object.
      let lastDts = this.store.dropToSurface;
      let lastPlacing = this.store.getSnapshot().placementMode !== null;
      this._storeUnsub = this.store.subscribe(() => {
        const dts = this.store.dropToSurface;
        if (dts !== lastDts) {
          lastDts = dts;
          this._transformControls?.setYAxisEnabled(!dts);
          this._viewer?.markRenderDirty();
        }
        const placing = this.store.getSnapshot().placementMode !== null;
        if (placing !== lastPlacing) {
          lastPlacing = placing;
          // Auto-stop while a click-to-place gesture is active (the ghost
          // follows the cursor), auto-resume when it ends if the sim was
          // running before — balanced begin/end via the edit-pause refcount.
          if (placing) this._beginEditPause();
          else this._endEditPause();
        }
      });

      // Persistence listener used to be wired here, but inspector edits
      // (Visible toggle, Splat Invert, Set-Position dialog, …) fire even
      // when the planner is NOT in edit mode — the user just wants to
      // tweak a value via the property panel. We now install/teardown the
      // listener in onModelLoaded/onModelCleared instead, so persistence
      // works regardless of planner-mode state.
    } else {
      // Leaving planner mode — clear selection FIRST so the existing
      // overlay meshes / outline are removed (styles restore via the
      // RVHighlightPolicy profile swap on mode-changed).
      viewer.selectionManager.clear();
      // Remove the placement-preview ghost emphasis (aux channel).
      viewer.highlighter.setAuxEmphasis('planner-ghost', null);
      // Unregister MU selectable nodes + stop forcing clone-mode spawning.
      this._muReconciler?.disposeAll();
      if (viewer.transportManager) viewer.transportManager.preferCloneMU = false;

      this._multiSelectPivot?.tearDown();
      this._transformControls?.detach();

      this._selectionUnsub?.();
      this._selectionUnsub = null;
      this._docHoverUnsub?.();
      this._docHoverUnsub = null;
      this._docUnhoverUnsub?.();
      this._docUnhoverUnsub = null;
      this._docClickUnsub?.();
      this._docClickUnsub = null;
      tooltipStore.hide(this._docHoverTipId);
      // _transformUpdateUnsub is now owned by onModelLoaded/onModelCleared
      // (always-on) — do NOT tear it down on planner deactivation.
      this._storeUnsub?.();
      this._storeUnsub = null;

      viewer.raycastManager?.setAllowFilter(this._priorAllowFilter);
      this._priorAllowFilter = null;
    }

    if (this._gridHelper) this._gridHelper.visible = active && this.store.gridEnabled;
    viewer.markRenderDirty();
  }

  /**
   * React to global selection changes. While planner is active, selection is
   * always restricted to layout instances by the allow filter, so any path in
   * the snapshot resolves to either a layout instance or nothing.
   */
  private _onSelectionChanged = (snap: SelectionSnapshot): void => {
    if (!this._active || !this._viewer) return;
    // MUs and layout objects share ONE selection (SelectionManager paths). The
    // gizmo + store sync below filter to `isLayoutInstance`, so MUs are
    // naturally excluded from the gizmo and persistence; the green outline for
    // both flows through SelectionManager → highlightSelection (planner profile).
    this._syncTransformControlsToSelection(snap);
    this._syncLayoutStoreToSelection(snap);
  };

  /** Write a single member's local transform (position + Euler) to the store.
   *  Per-frame coalescing on the SceneStore side merges drag updates into
   *  a single transformPlacement op (one undo step per drag). */
  private _writeSingleTransform(id: string, obj: Object3D): void {
    const prevSnap = this.store.getSnapshot().placed.find(c => c.id === id);
    const prev = prevSnap
      ? { position: [...prevSnap.position] as [number, number, number],
          rotation: [...prevSnap.rotation] as [number, number, number],
          scale: [...prevSnap.scale] as [number, number, number] }
      : { position: [0, 0, 0] as [number, number, number],
          rotation: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number] };

    const newPos: [number, number, number] = [obj.position.x, obj.position.y, obj.position.z];
    const newRot: [number, number, number] = [
      MathUtils.radToDeg(obj.rotation.x),
      MathUtils.radToDeg(obj.rotation.y),
      MathUtils.radToDeg(obj.rotation.z),
    ];

    this.store.updateTransform(id, newPos, newRot);
    this.store.autoSave();

    emitPlannerOp(this._viewer, {
      id: opId(), ts: Date.now(), schemaV: 1,
      kind: 'transformPlacement', placementId: id,
      position: newPos, rotation: newRot, scale: [...prev.scale],
      prev,
    });

    // Broadcast the new transform so listeners that don't own the
    // layout-store path can react too — primarily the gaussian-splat
    // plugin, whose splatMesh lives outside the host scene graph and
    // needs an explicit sync on every Gizmo-drag tick. Cheap; subscribers
    // typically O(1).
    if (this._viewer) {
      const path = this._viewer.registry?.getPathForNode(obj);
      if (path) {
        this._viewer.emit('layout-transform-update', {
          path,
          position: newPos,
          rotation: newRot,
        });
      }
    }
  }

  /**
   * Build the drop-to-surface raycast candidates for `selfObj`: the usual
   * scene meshes (via `collectDropTargets`) PLUS a transient top-plane for each
   * transport surface in the scene. The transport planes let objects be placed
   * on a conveyor top even when the surface has no solid top geometry (e.g. an
   * AABB-only / virtual conveyor). The dragged object's own surface(s) are
   * skipped so it never drops onto itself.
   */
  private _collectDropTargetsWithTransport(selfObj: Object3D): Mesh[] {
    const v = this._viewer;
    if (!v) return [];
    const targets = collectDropTargets(v.scene, selfObj);
    const surfaces = v.transportManager?.surfaces ?? [];
    if (surfaces.length === 0) return targets;
    const selfNodes = new Set<Object3D>();
    selfObj.traverse((c) => selfNodes.add(c));
    for (const s of surfaces) {
      if (selfNodes.has(s.node)) continue; // don't target the dragged object's own surface
      const plane = s.createDropPlane();
      if (plane) targets.push(plane);
    }
    return targets;
  }

  /**
   * Attach TransformControls to the current selection, delegating multi-select
   * pivot management to MultiSelectPivot.
   */
  private _syncTransformControlsToSelection(snap: SelectionSnapshot): void {
    const tc = this._transformControls;
    const viewer = this._viewer;
    if (!tc || !viewer) return;

    const objs: Object3D[] = [];
    for (const path of snap.selectedPaths) {
      const node = viewer.registry?.getNode(path);
      if (node && isLayoutInstance(node)) objs.push(node);
    }

    // Ensure MultiSelectPivot exists (lazy-init on first selection)
    if (!this._multiSelectPivot) {
      this._multiSelectPivot = new MultiSelectPivot({
        scene: viewer.scene,
        store: this.store,
        transformControls: tc,
        viewer,
        idByObject: this._idByObject,
      });
    }

    this._multiSelectPivot.syncToSelection(
      objs,
      this.store.gridEnabled,
      this.store.gridSizeMm,
      this.store.rotationSnapDeg,
    );
  }

  /**
   * Mirror the SelectionManager primary selection into LayoutStore.selectedId
   * so the panel UI stays in sync. One-way (SelectionManager → store).
   */
  private _syncLayoutStoreToSelection(snap: SelectionSnapshot): void {
    const viewer = this._viewer;
    if (!viewer) return;
    let id: string | null = null;
    if (snap.primaryPath) {
      const node = viewer.registry?.getNode(snap.primaryPath);
      if (node) id = this._idByObject.get(node) ?? null;
    }
    if (this.store.selectedId !== id) this.store.selectComponent(id);
  }

  /** Whether a library drag-in gesture currently holds an edit-pause. */
  private _dragEntryEditActive = false;

  /** Set the entry being dragged from the library panel. Instantiates + fully
   *  registers the live draft (the real placed object) and pauses the simulation
   *  for the duration of the drag; on dragend, keeps-or-tears-down the draft. */
  setDragEntry(entry: LibraryCatalogEntry | null): void {
    this._dragEntry = entry;
    if (entry) {
      // Dragging an asset in from the library is an edit gesture — auto-stop
      // the simulation; auto-resume on drop/cancel if it was running before.
      // Guarded so begin/end balance exactly once per drag-in gesture.
      if (!this._dragEntryEditActive) {
        this._dragEntryEditActive = true;
        this._beginEditPause();
      }
      void this._startDraft(entry);
    } else {
      // Drag gesture ended (fires AFTER onDrop). If the drop committed the draft,
      // keep it — just reset the flag. Otherwise it's a true cancel (dropped
      // outside, Esc, released off-canvas): tear down the uncommitted draft.
      // Either way, balance the edit-pause.
      if (this._dropCommitted) {
        this._dropCommitted = false;
      } else {
        this._cancelDraft();
      }
      if (this._dragEntryEditActive) {
        this._dragEntryEditActive = false;
        this._endEditPause();
      }
    }
  }

  /**
   * Instantiate + FULLY register the dragged entry as a live draft (real placed
   * object: processExtras, drives, TransportSurface component, snap registration,
   * raycast), select it (so the FloorGizmo + TransportSurface gizmo appear), and
   * cache its drop-to-surface targets. NOT committed to the store / undo log —
   * `_commitDraft` does that at drop, `_cancelDraft` tears it down on cancel.
   * Idempotent + guarded against concurrent async builds.
   */
  private async _startDraft(entry: LibraryCatalogEntry): Promise<void> {
    if (this._draft?.entry.id === entry.id) return; // already drafting this entry
    // Splats aren't dragged as live drafts (place-at-origin via placeComponent).
    if (entry.splatUrl) return;

    // ── Entry-kind routing (plan-371 §2.9). Only ONE of the three kinds has a
    // latency problem worth a placeholder.
    //
    // Virtual / DES entries are detected by the `virtual` FLAG, never by
    // `glbUrl` truthiness: `normalizeCatalogEntry` gives them `glbUrl: ''`,
    // not `undefined`, so a truthiness test would route them into the GLB
    // path and hand `getOrLoad('')` an empty URL.
    if (entry.virtual !== true) {
      // GLB asset — synchronous placeholder now, real geometry later.
      this._startGlbDraft(entry);
      return;
    }

    // Virtual / DES: `buildVirtualNode` needs no network, so the existing
    // ghost path already produces its node effectively immediately. Unchanged.
    if (this._startingDraft) return;                // a build is already in flight

    this._startingDraft = true;
    try {
      await this._ghost.ensureForEntry(entry);
      if (!this._viewer) return;
      // Entry switched / build failed while we awaited.
      if (this._ghost.entryId !== entry.id || !this._ghost.ghost) return;
      // Re-check after the await — a draft may have appeared / changed.
      if (this._draft?.entry.id === entry.id) return;
      if (this._draft) this._cancelDraft(); // a different entry was lingering

      const node = this._ghost.adopt()!;
      node.visible = false; // revealed on first move (avoids origin flash)
      const id = crypto.randomUUID();
      // FULL prep + registration (markers/shadows/pivot/align/render-mode +
      // processExtras/drives/snaps/raycast). Makes it a real layout instance.
      this._addPlacedToScene(node, id, entry.name, entry.id);

      this._draft = { id, node, entry, positioned: false, isSource: subtreeHasComponent(node, 'Source') };
      this._draftSnapMatch = null;
      this._draftDropTargets = this.store.dropToSurface
        ? this._collectDropTargetsWithTransport(node)
        : null;
    } finally {
      this._startingDraft = false;
    }
  }

  /**
   * Start a GLB draft SYNCHRONOUSLY (plan-371 F1).
   *
   * Instead of awaiting a decode that can take ten seconds, this registers a
   * catalog-sized wireframe placeholder in `light` mode right away, so
   * `_moveDraft` works from the very first pointer frame and the drop can
   * commit without blocking. The decoded geometry swaps in underneath the SAME
   * root later — see `_runPendingLoad` / `swapPlacedGeometry`.
   */
  private _startGlbDraft(entry: LibraryCatalogEntry): void {
    if (!this._viewer) return;
    if (this._draft) this._cancelDraft(); // a different entry was lingering

    const node = buildPlaceholderNode(entry);
    node.visible = false; // revealed on first move (avoids origin flash)
    const id = crypto.randomUUID();

    // LIGHT registration only: the placeholder has no `userData.realvirtual`,
    // and running processExtras on it would create signal/drive registrations
    // that the swap would then have to duplicate or orphan.
    this._addPlacedToScene(node, id, entry.name, entry.id, { mode: 'light' });

    this._draft = { id, node, entry, positioned: false, isSource: false };
    this._draftSnapMatch = null;
    this._draftDropTargets = this.store.dropToSurface
      ? this._collectDropTargetsWithTransport(node)
      : null;

    // Kick the real load. Fire-and-forget by design — the drag gesture, the
    // drop and the store commit must not wait for it.
    const gen = this._pending.begin(id, entry);
    this._pulse.start(id, node, resolvePlaceholderSizeMm(entry));
    void this._runPendingLoad(id, entry, gen);
  }

  /**
   * Await the decoded GLB for a pending placement and swap it in.
   *
   * Every result is validated against the generation token AND the placement's
   * continued existence before it touches the scene: deleting, undoing,
   * cancelling the drag, reloading the scene, switching models or tearing the
   * plugin down must never be resurrected by a late arrival (plan-371 R1/F10).
   */
  private async _runPendingLoad(
    id: string,
    entry: LibraryCatalogEntry,
    generation: number,
  ): Promise<void> {
    const url = entry.glbUrl;
    if (!url) {
      this._pending.fail(id, 'Catalog entry has no glbUrl');
      this._markPendingFailed(id);
      return;
    }

    try {
      const real = await this._modelCache.getOrLoad(url, { signal: this._pending.signalFor(id) });
      if (!this._pending.isCurrent(id, generation)) return;

      // The pulse gizmo is parented UNDER the placeholder root, and the swap
      // strips every child. Tear it down first or its LineSegments is orphaned
      // while the manager still holds (and blinks) its material.
      this._pulse.stop(id);
      if (smSwapPlacedGeometry(this._sceneMutDeps, id, real)) {
        this._pending.cancel(id);
        this._onGeometrySwapped(id);
      }
    } catch (err) {
      if (!this._pending.isCurrent(id, generation)) return;
      console.warn(`[LayoutPlanner] Failed to load "${entry.name}":`, err);
      this._pending.fail(id, String(err));
      this._markPendingFailed(id);
    }
  }

  /** Paint the failed-load state onto a placeholder that is still in the scene. */
  private _markPendingFailed(id: string): void {
    // Nothing is loading any more, so the motion cue stops; the failure is
    // carried by red + dashed outline + warning badge + the HMI status line.
    this._pulse.stop(id);
    const node = this._objectMap.get(id);
    if (node && isPlaceholderNode(node)) setPlaceholderError(node as PlaceholderNode, true);
    this._viewer?.markRenderDirty();
  }

  /**
   * Retry a failed placeholder load (plan-371 F7). Deliberately NOT a new undo
   * entry: the placement itself was committed and never rolled back — only its
   * geometry is missing — so the retry bumps the generation and nothing else.
   */
  retryPendingPlacement(id: string): void {
    const load = this._pending.get(id);
    if (!load || load.status !== 'error') return;

    const node = this._objectMap.get(id);
    if (node && isPlaceholderNode(node)) {
      setPlaceholderError(node as PlaceholderNode, false);
      this._pulse.start(id, node, resolvePlaceholderSizeMm(load.entry));
    }
    // Bumps the generation and re-enters `_runPendingLoad` via `onRetry`, so a
    // late result of the FAILED attempt is discarded when it finally lands.
    this._pending.retry(id);
    this._viewer?.markRenderDirty();
  }

  /** Mirror the registry into the store so the HMI status line can render it. */
  private _syncPendingPlacements(): void {
    this.store.setPendingPlacements(
      this._pending.list().map((load) => ({
        id: load.id,
        name: load.entry.name,
        status: load.status,
        error: load.error,
      })),
    );
  }

  /** Post-swap housekeeping for a placement whose real geometry just landed. */
  private _onGeometrySwapped(id: string): void {
    const draft = this._draft;
    if (draft && draft.id === id) {
      // The cached drop-to-surface candidate list excluded the PLACEHOLDER's
      // meshes; the real ones aren't in it and the object would drop onto
      // itself. Rebuild it against the geometry that is actually there now.
      draft.isSource = subtreeHasComponent(draft.node, 'Source');
      this._draftDropTargets = this.store.dropToSurface
        ? this._collectDropTargetsWithTransport(draft.node)
        : null;
      // The armed bbox-snap state was measured on the placeholder box.
      if (this._bboxSnap?.isArmed) this._bboxSnap.armForDrag(draft.node);
    }
    this._refreshHierarchy();
    this._viewer?.markShadowsDirty();
    this._viewer?.markRenderDirty();
  }

  /**
   * Move the live draft to a raw floor XZ, applying the full re-drag pipeline:
   * bbox + grid snap → snap-point port mating (self-excluded) → drop-to-surface
   * (when not mating a port). Selects the draft on its first positioning so the
   * gizmos attach at the cursor (not at the origin). Returns false (no-op) until
   * the async build has produced the draft.
   */
  private _moveDraft(rawX: number, rawZ: number): boolean {
    const draft = this._draft;
    const viewer = this._viewer;
    if (!draft || !viewer) return false;
    const node = draft.node;

    // Lazily arm magnetic bbox snap for this draft (idempotent; armForDrag
    // excludes the moving root + its descendants → no self-snap).
    if (this._bboxSnap && !this._bboxSnap.isArmed) this._bboxSnap.armForDrag(node);

    // bbox + grid snap on XZ (mirrors the FloorGizmo re-drag).
    let nx = rawX;
    let nz = rawZ;
    const custom = this._bboxSnap?.applySnap(nx, nz, 'free') ?? null;
    if (custom?.snappedX) nx = custom.x;
    if (custom?.snappedZ) nz = custom.z;
    if (this.store.gridEnabled) {
      const step = this.store.gridSizeMm / 1000;
      if (step > 0) {
        if (!custom?.snappedX) nx = Math.round(nx / step) * step;
        if (!custom?.snappedZ) nz = Math.round(nz / step) * step;
      }
    }

    // Baseline pose before the snap-point probe (Y=0, no rotation).
    node.position.set(nx, 0, nz);
    node.rotation.set(0, 0, 0);
    node.visible = true;
    node.updateMatrixWorld(true);

    // Snap-point port mating — self-excluded so the draft's OWN ports (now in
    // the registry) don't match themselves. Overrides XZ + rotation + Y.
    //
    // Skipped entirely while the root still carries placeholder geometry
    // (plan-371 §2.7): the placeholder box has no real ports, so any match
    // would be against the wrong shape. Grid- and bbox-snapping above, and
    // drop-to-surface below, work purely on the AABB and stay active. Real
    // ports become available for the NEXT drag, once the swap has landed —
    // an object that re-snaps itself after being dropped was rejected.
    const registry = viewer.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
    let match: GhostSnapMatch | null = null;
    if (!isPlaceholderNode(node) && registry && registry.size > 0) {
      match = findBestGhostSnap(node, registry, DEFAULT_MAGNET_RADIUS_M, node);
      if (match) applyGhostSnapAlignment(node, match);
    }
    this._draftSnapMatch = match;

    // Drop-to-surface when not mating a port (snap defines the full pose).
    // Sources additionally snap to the belt's lateral centre line when they
    // land on a transport surface, so spawned MUs start centred.
    if (!match && this.store.dropToSurface && this._draftDropTargets) {
      dropToSurface(node, viewer.scene, this._draftDropTargets, draft.isSource);
    }

    // Select once positioned so the gizmos appear at the cursor, not the origin.
    if (!draft.positioned) {
      draft.positioned = true;
      this._selectObject(draft.id);
    }

    // markShadowsDirty so the draft's shadow tracks it as it's positioned.
    viewer.markShadowsDirty();
    return true;
  }

  /**
   * Commit the live draft (drop / click): the object is already registered +
   * positioned, so this only records the store + undo op and (for a snap match)
   * marks occupancy/pairing. Ensures the draft exists first (a drop can beat the
   * async build) and re-positions to the final `coords`. Falls back to a fresh
   * `placeComponent` re-clone only if the build failed entirely.
   */
  private async _commitDraft(
    entry: LibraryCatalogEntry,
    coords: [number, number] | null,
  ): Promise<string | null> {
    if (!this._viewer) return null;

    // Drop may arrive before the async build/register settled — ensure the draft.
    if (!this._draft || this._draft.entry.id !== entry.id) {
      await this._startDraft(entry);
    }
    if (!this._draft) {
      // Build failed → legacy re-clone fallback at the drop position.
      try {
        const pos: [number, number, number] = coords ? [coords[0], 0, coords[1]] : [0, 0, 0];
        return await this.placeComponent(entry, pos);
      } catch (err) {
        console.error('[LayoutPlanner] Draft commit fallback failed:', err);
        return null;
      }
    }

    // Position at the final drop location (sets `_draftSnapMatch`).
    if (coords) this._moveDraft(coords[0], coords[1]);

    const { id, node } = this._draft;

    // Snap occupancy + pairing — the draft's snaps are already registered, so we
    // only mark occupancy (no re-register).
    const match = this._draftSnapMatch;
    if (match && !match.targetSnap.occupied) {
      const registry = this._viewer.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
      if (registry) {
        smMarkSnapOccupied(this._sceneMutDeps, node, id, match.targetSnap, match.ghostSnap.name, registry);
        this._scheduleSnapPairingRebuild();
      }
    }

    node.visible = true;
    // Mirror live node state into the marker components (Inspector Splat/Drive).
    syncLayoutMarkerComponents(node, true);

    // Broadcast placement so transform-coupled subscribers sync up.
    const placedPath = this._viewer.registry?.getPathForNode(node);
    if (placedPath) {
      this._viewer.emit('layout-transform-update', {
        path: placedPath,
        position: [node.position.x, node.position.y, node.position.z],
        rotation: [
          MathUtils.radToDeg(node.rotation.x),
          MathUtils.radToDeg(node.rotation.y),
          MathUtils.radToDeg(node.rotation.z),
        ],
      });
    }

    const comp: PlacedComponent = {
      id,
      catalogId: entry.id,
      glbUrl: entry.glbUrl ?? '',
      label: entry.name,
      position: [node.position.x, node.position.y, node.position.z],
      rotation: [
        MathUtils.radToDeg(node.rotation.x),
        MathUtils.radToDeg(node.rotation.y),
        MathUtils.radToDeg(node.rotation.z),
      ],
      scale: [node.scale.x, node.scale.y, node.scale.z],
      // Measured once, here, while the geometry is provably in hand (plan-703
      // §2.8). It becomes `AssetReference.bounds` and sizes the placeholder if
      // the asset can no longer be resolved — at which point nothing else can
      // answer how big the hole should be.
      ...boundsOfPlacedNode(node),
    };
    this.store.addComponent(comp);
    this.store.autoSave();
    this._refreshHierarchy();

    // Record the placement in the SceneStore op log for undo/redo.
    emitPlannerOp(this._viewer, {
      id: opId(), ts: Date.now(), schemaV: 1,
      kind: 'addPlacement', placement: { ...comp },
    });

    // Place-one-at-a-time UX: exit placement mode + clear draft/drag state.
    this.store.setPlacementMode(null);
    this._dragEntry = null;
    this._bboxSnap?.disarm();
    this._draft = null;
    this._draftDropTargets = null;
    this._draftSnapMatch = null;

    // The draft was already selected during the drag — keep the selection.
    this._viewer.markShadowsDirty();
    return id;
  }

  /** Hide the draft node without tearing it down (drag left the window — re-
   *  entry reuses it). */
  private _hideDraft(): void {
    if (this._draft) this._draft.node.visible = false;
    this._viewer?.markRenderDirty();
  }

  /** Fully tear down the uncommitted live draft (cancelled drag / Esc / mode off). */
  private _cancelDraft(): void {
    const draft = this._draft;
    if (!draft) return;
    this._removePlacedFromScene(draft.id); // full teardown (no undo op)
    this._selectObject(null);
    this._bboxSnap?.disarm();
    this._draft = null;
    this._draftDropTargets = null;
    this._draftSnapMatch = null;
    this._viewer?.markRenderDirty();
  }

  /** Place a component in the scene from a catalog entry.
   *
   *  `opts.skipAutoAlign` (plan-238) skips the AABB floor-center pivot +
   *  floor align for multi-part CAD imports with a functional origin. */
  async placeComponent(
    entry: LibraryCatalogEntry,
    position: [number, number, number],
    opts?: { skipAutoAlign?: boolean },
  ): Promise<string> {
    if (!this._viewer) throw new Error('Viewer not initialized');

    let node!: Object3D;

    let isSplat = false;

    if (entry.splatUrl) {
      // Gaussian Splat — load via the splat plugin's multi-instance API.
      // Local-folder splats use blob: URLs that hide the file extension,
      // so we pass it explicitly from entry.localPath.
      const splatPlugin = await this._viewer.resolvePlugin('gaussian-splat');
      if (!splatPlugin) throw new Error('gaussian-splat plugin not available');
      const fileExt = extractSplatFileExt({ localPath: entry.localPath, url: entry.splatUrl });
      node = await (splatPlugin as unknown as import('./gaussian-splat-plugin-type').GaussianSplatPluginApi).loadSplat(entry.splatUrl, fileExt);
      isSplat = true;
    } else if (entry.virtual && entry.desType) {
      // Virtual DES component — same builder the drag preview uses (component
      // createGizmo() with a wireframe fallback + name/realvirtual stamping).
      node = await buildVirtualNode(entry);
    } else {
      // Standard GLB-based component
      node = await this._modelCache.getOrLoad(entry.glbUrl ?? '');
    }

    const id = crypto.randomUUID();

    if (isSplat) {
      // Splats are already added to the scene by loadSplat() —
      // just mark layout metadata (no pivotToFloorCenter, no alignToFloor)
      this._addSplatPlacedToScene(node, id, entry.name, entry.id, entry.splatUrl!);
    } else {
      this._addPlacedToScene(node, id, entry.name, entry.id, opts);
    }
    node.position.x = position[0];
    node.position.z = position[2];
    // Mirror the live node state into the marker components so the Inspector
    // renders the Splat section (Invert X/Y/Z buttons) immediately on first
    // placement — without this, `rv.Splat` only appears after a reload via the
    // restore path, so the axis-invert controls are missing for fresh splats.
    syncLayoutMarkerComponents(node, true);

    // Broadcast initial placement so transform-coupled subscribers
    // (notably the gaussian-splat plugin, whose splatMesh sits outside
    // the host scene graph) can sync up. Without this, fresh splats
    // would render at world origin until the user nudges them.
    if (this._viewer) {
      const placedPath = this._viewer.registry?.getPathForNode(node);
      if (placedPath) {
        this._viewer.emit('layout-transform-update', {
          path: placedPath,
          position: [node.position.x, node.position.y, node.position.z],
          rotation: [
            MathUtils.radToDeg(node.rotation.x),
            MathUtils.radToDeg(node.rotation.y),
            MathUtils.radToDeg(node.rotation.z),
          ],
        });
      }
    }

    const comp: PlacedComponent = {
      id,
      catalogId: entry.id,
      glbUrl: entry.glbUrl ?? '',
      label: entry.name,
      position: [node.position.x, node.position.y, node.position.z],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      ...(isSplat ? { splatUrl: entry.splatUrl } : {}),
      // A splat gets no `AssetReference` at all, so there is nothing to size.
      ...(isSplat ? {} : boundsOfPlacedNode(node)),
    };
    this.store.addComponent(comp);
    this.store.autoSave();
    this._refreshHierarchy();

    // Record the placement in the SceneStore op log for undo/redo.
    // The executor's forward is idempotent (won't double-add), so this
    // doesn't fight the direct mutation above.
    emitPlannerOp(this._viewer, {
      id: opId(), ts: Date.now(), schemaV: 1,
      kind: 'addPlacement', placement: { ...comp },
    });

    // Place-one-at-a-time UX: exit placement mode and hide the ghost so the
    // user can immediately work with the just-placed object instead of
    // accidentally placing duplicates on the next click/move.
    this.store.setPlacementMode(null);
    this._dragEntry = null;
    this._ghost.hide();

    // Auto-select the newly placed object so the user can immediately move/rotate it.
    // Routes through SelectionManager → 'selection-changed' → TransformControls attach.
    this._selectObject(id);

    this._viewer.markRenderDirty();
    this._viewer.emit('layout:component-placed' as any, { id, entry });
    return id;
  }

  /**
   * Remove ALL currently selected layout instances. Multi-select aware —
   * pulls paths from the global SelectionManager so a marquee selection of
   * N items is deleted with one click (or one Delete-key press).
   *
   * All removals are wrapped in a single SceneStore transaction, so undo
   * brings every deleted item back as one step, in their original positions.
   */
  async removeSelected(): Promise<void> {
    const viewer = this._viewer;
    if (!viewer) return;

    const selectionPaths = viewer.selectionManager.getSnapshot().selectedPaths;

    // Spawned MUs are sim-owned (not layout placements) — delete them via the
    // transport manager (works while paused). One Delete press removes a mixed
    // layout + MU selection: MUs here, layout placements below.
    const muPaths: string[] = [];
    for (const path of selectionPaths) {
      const node = viewer.registry?.getNode(path);
      const mu = node && isMuSelectable(node)
        ? (node.userData._muRef as RVMovingUnit | undefined)
        : undefined;
      if (mu) { viewer.transportManager?.removeMU(mu); muPaths.push(path); }
    }
    if (muPaths.length > 0) {
      const remaining = selectionPaths.filter(p => !muPaths.includes(p));
      // selectPaths re-applies the selection highlight itself.
      viewer.selectionManager.selectPaths(remaining);
    }

    // Resolve the set of placement IDs to remove. Prefer SelectionManager
    // (multi-aware); fall back to LayoutStore.selectedId for any code path
    // that still drives single-select without going through SelectionManager.
    const ids = this._pathsToPlacementIds(selectionPaths);
    if (ids.length === 0 && muPaths.length === 0 && this.store.selectedId) {
      ids.push(this.store.selectedId);
    }
    if (ids.length > 0) await this._removeByPlacementIds(ids);
  }

  /**
   * Remove layout instances by node path. Used by the hierarchy browser's
   * context-menu Delete action — the menu only knows paths.
   */
  async removeByPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const ids = this._pathsToPlacementIds(paths);
    await this._removeByPlacementIds(ids);
  }

  /** Map node paths to unique placement IDs (preserving order, dedup'd). */
  private _pathsToPlacementIds(paths: readonly string[]): string[] {
    const viewer = this._viewer;
    if (!viewer) return [];
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      const node = viewer.registry?.getNode(path);
      if (!node) continue;
      const id = this._idByObject.get(node);
      if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return ids;
  }

  /** Core removal pipeline shared by `removeSelected` and `removeByPaths`. */
  private async _removeByPlacementIds(ids: string[]): Promise<void> {
    const viewer = this._viewer;
    if (!viewer || ids.length === 0) return;

    // Snapshot all placements BEFORE mutation so each removePlacement op
    // carries the full record for undo.
    const placedNow = this.store.getSnapshot().placed;
    const snapsById = new Map<string, PlacedComponent>();
    for (const id of ids) {
      const snap = placedNow.find(c => c.id === id);
      if (snap) snapsById.set(id, { ...snap });
    }

    // Clear the selection up-front so the gizmo / outline detach before the
    // underlying objects disappear (avoids brief flash of dangling outlines).
    viewer.selectionManager.clear();

    const sceneStore = getSceneStore();
    const removeOne = (id: string): void => {
      this._removePlacedFromScene(id);
      this.store.removeComponent(id);
    };

    if (sceneStore) {
      // Single composite op → single undo restores all deleted items.
      await sceneStore.withTransaction(
        ids.length > 1 ? `Delete ${ids.length} items` : 'Delete item',
        async () => {
          for (const id of ids) {
            const snap = snapsById.get(id);
            removeOne(id);
            if (snap) {
              await sceneStore.applyOp({
                id: opId(), ts: Date.now(), schemaV: 1,
                kind: 'removePlacement', placementId: id, placement: snap,
              });
            }
          }
        },
      );
    } else {
      // SceneStore not available (boot/test) — still perform the removal.
      for (const id of ids) removeOne(id);
    }

    this.store.autoSave();
    this._refreshHierarchy();
    // markShadowsDirty so the deleted assets' shadows clear from the map.
    viewer.markShadowsDirty();
  }

  /**
   * Clone one placement: new id, same content, small offset — THE single
   * routine behind `duplicateSelected` and `pasteClipboard` (plan-376 F6).
   *
   * Covers the fresh UUID, the `' (copy)'` label, splat / virtual-DES / GLB
   * routing, the +0.5 m X-Z offset, the re-drop when drop-to-surface is on,
   * the new `PlacedComponent` literal (including `signalMappings`, F10), the
   * store write, the binding re-apply and the op-log entry.
   *
   * Leaves autosave, selection and hierarchy refresh to the caller: paste does
   * them ONCE for the whole clipboard, duplicate does them for its single item.
   *
   * @returns The new placement id, or `null` when nothing could be built
   *          (missing splat plugin, or a GLB record with neither url nor a
   *          virtual catalog entry). Callers MUST null-check: `autoSave` and
   *          `_selectObject` would otherwise run on a failed clone and clear
   *          the current selection.
   */
  private async _clonePlacement(comp: PlacedComponent): Promise<string | null> {
    const newId = crypto.randomUUID();
    const label = comp.label + ' (copy)';
    const isSplat = !!comp.splatUrl;
    // The catalog entry is the source of truth for HOW a component is built
    // (splat / virtual DES / GLB). Falls back to the record when it is gone.
    const entry = this._findCatalogEntryById(comp.catalogId);
    let node: Object3D;

    if (isSplat) {
      // Splat duplicate — create a new viewer instance. Resolve the file
      // extension via the source catalog entry so blob:-URL splats still
      // load correctly.
      const splatPlugin = await this._viewer!.resolvePlugin('gaussian-splat');
      if (!splatPlugin) return null;
      const fileExt = extractSplatFileExt({ localPath: entry?.localPath, url: comp.splatUrl });
      node = await (splatPlugin as unknown as import('./gaussian-splat-plugin-type').GaussianSplatPluginApi).loadSplat(comp.splatUrl!, fileExt);
      this._addSplatPlacedToScene(node, newId, label, comp.catalogId, comp.splatUrl!);
    } else {
      if (entry?.virtual && entry.desType) {
        // Virtual DES component — rebuild the gizmo. Without this branch the
        // copy would call `_modelCache.getOrLoad('')`, because virtual entries
        // carry no glbUrl (plan-376 F7).
        node = await this._buildVirtualDesNode(entry);
      } else if (!comp.glbUrl) {
        console.warn(`[LayoutPlanner] Cannot copy "${comp.label}" — no glbUrl and no virtual catalog entry.`);
        return null;
      } else {
        node = await this._modelCache.getOrLoad(comp.glbUrl);
      }
      this._addPlacedToScene(node, newId, label, comp.catalogId);
    }

    node.position.set(comp.position[0] + 0.5, node.position.y, comp.position[2] + 0.5);
    node.rotation.set(
      MathUtils.degToRad(comp.rotation[0]),
      MathUtils.degToRad(comp.rotation[1]),
      MathUtils.degToRad(comp.rotation[2]),
    );
    // Re-drop after position override (addPlacedToScene dropped at the original spot)
    if (!isSplat && this.store.dropToSurface && this._viewer) {
      dropToSurface(node, this._viewer.scene);
    }

    const newComp: PlacedComponent = {
      id: newId,
      catalogId: comp.catalogId,
      glbUrl: comp.glbUrl,
      label,
      position: [node.position.x, node.position.y, node.position.z],
      rotation: [...comp.rotation],
      scale: [...comp.scale],
      ...(isSplat ? { splatUrl: comp.splatUrl } : {}),
      // plan-376 F10: a manually bound signal link used to vanish on copy —
      // neither creation path carried the field, and nothing re-derived it.
      ...(comp.signalMappings ? { signalMappings: comp.signalMappings.map(m => ({ ...m })) } : {}),
      // A copy inherits the original's measurement rather than re-measuring:
      // both placements point at the same asset, so a second answer could only
      // be noise from a subtree that is mid-load.
      ...(comp.bounds ? { bounds: { min: [...comp.bounds.min], max: [...comp.bounds.max] } } : {}),
    };
    this.store.addComponent(newComp);
    // Bind the copy's slots to the inherited mappings (component instances were
    // just built by _addPlacedToScene). Splats have no bindable slots.
    if (!isSplat && this._viewer) {
      this._applyElementBindings(newId, node, newComp.signalMappings ?? []);
    }

    emitPlannerOp(this._viewer, {
      id: opId(), ts: Date.now(), schemaV: 1,
      kind: 'addPlacement', placement: { ...newComp },
    });

    return newId;
  }

  /** Duplicate the currently selected component. */
  async duplicateSelected(): Promise<string | null> {
    const snapshot = this.store.getSnapshot();
    const id = snapshot.selectedId;
    if (!id) return null;

    const comp = snapshot.placed.find(c => c.id === id);
    if (!comp) return null;

    const newId = await this._clonePlacement(comp);
    // Null-check is load-bearing: on a failed clone the selection must stay
    // where it is and nothing may be persisted.
    if (!newId) return null;

    this.store.autoSave();
    this._selectObject(newId);
    this._refreshHierarchy();

    if (this._viewer) this._viewer.markRenderDirty();

    return newId;
  }

  /**
   * Capture the current selection into the planner's internal clipboard.
   * Multi-aware (uses SelectionManager) with fallback to `store.selectedId`.
   * Returns the number of placements captured. Source records remain in
   * place; only deep clones are stored so the originals can't drift.
   */
  copySelected(): number {
    const viewer = this._viewer;
    const placedNow = this.store.getSnapshot().placed;
    const ids: string[] = [];
    const seen = new Set<string>();

    if (viewer) {
      const selectionPaths = viewer.selectionManager.getSnapshot().selectedPaths;
      for (const path of selectionPaths) {
        const node = viewer.registry?.getNode(path);
        if (!node) continue;
        const id = this._idByObject.get(node);
        if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
      }
    }
    if (ids.length === 0 && this.store.selectedId) {
      ids.push(this.store.selectedId);
    }
    if (ids.length === 0) {
      this._clipboard = [];
      return 0;
    }

    this._clipboard = ids
      .map(id => placedNow.find(c => c.id === id))
      .filter((c): c is PlacedComponent => !!c)
      .map(c => ({
        ...c,
        position: [...c.position] as [number, number, number],
        rotation: [...c.rotation] as [number, number, number],
        scale: [...c.scale] as [number, number, number],
      }));
    return this._clipboard.length;
  }

  /**
   * Paste the planner clipboard. Each entry becomes a new placement with a
   * fresh UUID, offset by +0.5 m on X/Z (matches `duplicateSelected`). All
   * newly pasted items become the new selection. Returns the list of new
   * placement IDs (empty when the clipboard is empty).
   */
  async pasteClipboard(): Promise<string[]> {
    if (this._clipboard.length === 0) return [];

    const newIds: string[] = [];

    for (const comp of this._clipboard) {
      const newId = await this._clonePlacement(comp);
      // A clone that could not be built (missing splat plugin, no url and no
      // virtual entry) is skipped — the rest of the clipboard still pastes.
      if (newId) newIds.push(newId);
    }

    if (newIds.length === 0) return [];

    this.store.autoSave();
    this._refreshHierarchy();

    // Select all freshly pasted items via SelectionManager.selectPaths so
    // multi-paste lands on a multi-selection (single-paste falls through to
    // the same code path with a one-element array).
    const viewer = this._viewer;
    if (viewer) {
      const paths: string[] = [];
      for (const id of newIds) {
        const obj = this._objectMap.get(id);
        if (!obj) continue;
        const path = viewer.registry?.getPathForNode(obj);
        if (path) paths.push(path);
      }
      if (paths.length > 0) viewer.selectionManager.selectPaths(paths);
      viewer.markRenderDirty();
    }

    return newIds;
  }

  /** Capture the current placed state as a LayoutFile. Used by the
   *  Scene window to persist named layouts in the layout-registry.
   *
   *  @deprecated Prefer `snapshotPlacements()` and the unified Scene model.
   *  Kept as an alias while the legacy layout-registry path is being phased out.
   */
  snapshotAsLayoutFile(name: string): import('./rv-layout-store').LayoutFile {
    const s = this.snapshotPlacements();
    return serializeLayout(name, s.placements, s.catalogUrls, s.gridSizeMm);
  }

  /** Restore a layout from an in-memory LayoutFile. Re-places all components.
   *
   *  @deprecated Prefer `applyPlacements({ placements, catalogUrls, gridSizeMm })`.
   *  Kept as an alias while the legacy layout-registry path is being phased out.
   */
  async applyLayoutFile(layout: import('./rv-layout-store').LayoutFile): Promise<void> {
    return this.applyPlacements({
      placements: layout.components,
      catalogUrls: layout.catalogUrls,
      gridSizeMm: layout.gridSizeMm,
    });
  }

  /**
   * Capture the planner's current state as a placements snapshot — the
   * lean, layout-file-free form consumed by the unified Scene model.
   */
  snapshotPlacements(): PlacementsSnapshot {
    const snap = this.store.getSnapshot();
    return {
      placements: snap.placed,
      // §2.6.3 — the scene-bound library list is READ-ONLY compatibility now.
      // `applyPlacements` still honours it on a legacy scene; the write side
      // belongs to `project.json.libraries[]` and the global user list, so
      // nothing is stamped back into the scene here.
      catalogUrls: [],
      gridSizeMm: snap.gridSizeMm,
    };
  }

  /**
   * Re-place all components from a placements snapshot. Used by the unified
   * Scene model to restore a saved scene's planner contents.
   */
  async applyPlacements(snap: PlacementsSnapshot): Promise<void> {
    const hasContent = snap.placements.length > 0 || snap.catalogUrls.length > 0;
    this.setLayoutFloorVisible(hasContent);
    return this._restorePlacements(snap);
  }

  /**
   * Take ownership of placements that are already in the loaded tree.
   *
   * The GLB-scene counterpart of {@link applyPlacements}. A scene saved since
   * plan-397 phase 6 carries its placements as `AssetReference` nodes in its
   * own file, so by the time this runs the geometry is loaded, composed and
   * fully registered — there is nothing to build and nothing to fetch. See
   * `adoptPlacedNode` for why re-running the placement path would be wrong
   * rather than merely wasteful.
   *
   * Synchronous on purpose: the async half of restoring a layout is resolving
   * and downloading each asset, and that has already happened.
   *
   * @returns the number of placements adopted.
   */
  adoptPlacements(entries: readonly { node: Object3D; placement: PlacedComponent }[]): number {
    if (!this._viewer) return 0;
    this.ensureAttached(this._viewer);

    const placements: PlacedComponent[] = [];
    for (const { node, placement } of entries) {
      // A placement id that is already mapped means this tree was adopted
      // before (a second call for the same load). Re-stamping is harmless, but
      // pushing the record twice would show the user a duplicate row.
      smAdoptPlacedNode(this._sceneMutDeps, node, placement.id, placement.label, placement.catalogId);
      // Plan-921: behaviors bind on 'model-loaded' — which fired BEFORE this
      // adoption stamped the LayoutObject marker, so the placed subtrees were
      // invisible to that dispatch. Re-dispatch now (idempotent per placement
      // id via the manager's dedupe), exactly like a live placement does.
      this._viewer.behaviors.dispatchPlaced(node);
      placements.push(placement);
    }

    this.store.setComponents(placements);
    // The floor tracks intent, not count — `loadScene` overrules it right
    // after this anyway, and leaving it to the snapshot rule would flash the
    // authoring floor on every GLB scene that happens to carry placements.
    this.setLayoutFloorVisible(false);
    this._scheduleSnapPairingRebuild();
    this._refreshHierarchy();
    this._viewer.markRenderDirty();
    return placements.length;
  }

  // ───────────────────────────────────────────────────────────────────
  // Op executor primitives — single placement add / remove / transform.
  // Called by `rv-scene-executors.ts` when applying scene-lineage ops to the
  // live scene. Each one is idempotent: re-running the same forward op is
  // safe (no duplicate adds, no errors on missing ids).
  // ───────────────────────────────────────────────────────────────────

  /**
   * Build the node for a virtual / DES catalog entry — the component class's
   * own `createGizmo()` when its factory is registered, else a generic
   * wireframe placeholder — and stamp name + `realvirtual` config on it.
   *
   * Lifted out of `pasteClipboard` (plan-376) so the restore helper and the
   * clone helper share ONE virtual-DES branch instead of two copies. Virtual
   * entries carry `glbUrl: ''`, so without this branch they end up in
   * `_modelCache.getOrLoad('')`, which is never a usable placement.
   */
  private async _buildVirtualDesNode(entry: LibraryCatalogEntry): Promise<Object3D> {
    const gizmoSize = entry.gizmoSize ?? [500, 500, 500] as [number, number, number];
    let node: Object3D | null = null;
    try {
      const { getRegisteredFactories } = await import('../../core/engine/rv-component-registry');
      const factories = getRegisteredFactories();
      const factory = factories.get(entry.desType!);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (factory && typeof (factory as any).ctor?.createGizmo === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        node = (factory as any).ctor.createGizmo(gizmoSize) as Object3D;
      }
    } catch { /* fall through to placeholder */ }
    if (!node) {
      const { createVirtualPlaceholder } = await import('./ghost-manager');
      node = createVirtualPlaceholder(gizmoSize, entry.desType);
    }
    node.name = entry.name;
    node.userData.realvirtual = { [entry.desType!]: entry.desConfig ?? {} };
    return node;
  }

  /**
   * Turn a `PlacedComponent` record into a living scene object — THE single
   * routine every restore path uses for the per-item body (plan-376 F1).
   *
   * Covers splat-vs-virtual-DES-vs-GLB resolution, loading, scene insertion,
   * transform, `visible`, the Inspector marker sync, splat overlay overrides
   * plus their `layout-transform-update` broadcast, and the signal bindings.
   *
   * Deliberately does NOT touch the store, the snap-pairing schedule or any
   * dedup guard: each caller keeps its own batching policy (one bulk
   * `setComponents` vs. a per-op `addComponent`), its own snap-rebuild timing
   * and its own `_objectMap.has` guard. Folding those in here would turn the
   * bulk restore's single `_notify()` into N+1 — the failure mode plan-359
   * already paid for (`tests/rv-asset-document-bulk-notify.test.ts`).
   *
   * @param url Pre-resolved source url from the caller (bulk restore rebases /
   *            re-downloads before calling). Falls back to the record's own
   *            url. `||` rather than `??` on purpose: the legacy autosave loop
   *            hands us the record's EMPTY `glbUrl` for a splat placement.
   * @returns The scene node, or `null` when the placement was skipped (today:
   *          only the "gaussian-splat plugin not loaded" case).
   */
  private async _buildPlacementFromRecord(
    p: PlacedComponent,
    url?: string,
  ): Promise<Object3D | null> {
    const entry = this._findCatalogEntryById(p.catalogId);
    let node: Object3D;

    if (p.splatUrl) {
      // Splat placement — load via the splat plugin
      const splatPlugin = await this._viewer!.resolvePlugin('gaussian-splat');
      if (!splatPlugin) {
        console.warn(`[LayoutPlanner] gaussian-splat plugin not available — skipping "${p.label}"`);
        return null;
      }
      const splatSrc = url || p.splatUrl;
      const fileExt = extractSplatFileExt({ localPath: entry?.localPath, url: splatSrc });
      node = await (splatPlugin as unknown as import('./gaussian-splat-plugin-type').GaussianSplatPluginApi).loadSplat(splatSrc, fileExt);
      this._addSplatPlacedToScene(node, p.id, p.label, p.catalogId, splatSrc);
    } else {
      node = entry?.virtual && entry.desType
        ? await this._buildVirtualDesNode(entry)
        : await this._modelCache.getOrLoad(url || p.glbUrl);
      this._addPlacedToScene(node, p.id, p.label, p.catalogId);
    }

    node.position.set(p.position[0], p.position[1], p.position[2]);
    node.rotation.set(
      MathUtils.degToRad(p.rotation[0]),
      MathUtils.degToRad(p.rotation[1]),
      MathUtils.degToRad(p.rotation[2]),
    );
    // `|| 1` guards pre-scale autosaves, which have no `scale` array at all —
    // `set(undefined, …)` would make the whole node NaN-sized and invisible.
    node.scale.set(p.scale?.[0] || 1, p.scale?.[1] || 1, p.scale?.[2] || 1);
    // Restore visibility flag (defaults to true / visible on legacy entries)
    if (p.visible === false) node.visible = false;
    // Mirror the live Three.js state back into the marker components so the
    // Inspector renders the correct values right after restore.
    syncLayoutMarkerComponents(node, p.visible !== false);

    if (p.splatUrl) {
      // Splat overlay overrides aren't applied by loadGLB (splats are created
      // after that pass) — copy them out of the op log and push the resulting
      // scale into the splat library so InvertX/Y/Z visibly stick on reload.
      applySplatOverridesFromScene(node, this._viewer!);
      // Broadcast restored transform so loosely-coupled subscribers (splat
      // plugin, …) can sync to the just-loaded position/rotation.
      const restoredPath = this._viewer?.registry?.getPathForNode(node);
      if (this._viewer && restoredPath) {
        this._viewer.emit('layout-transform-update', {
          path: restoredPath,
          position: p.position,
          rotation: p.rotation,
        });
      }
    } else if (this._viewer) {
      // Planner Signal Linking: apply persisted + auto-derived (exact-name)
      // bindings for this placement (component instances are now built).
      // No-op when off.
      this._applyElementBindings(p.id, node, p.signalMappings ?? []);
    }

    return node;
  }

  /**
   * Add a single placement clone from a `PlacedComponent` record (op
   * forward executor). Idempotent: returns silently if a placement with
   * the same id already exists.
   */
  async placeFromRecord(p: PlacedComponent): Promise<void> {
    // Serialize with the boot-time legacy autosave restore (_loadCatalogs),
    // exactly as _restorePlacements does: the `_objectMap.has` guard below is
    // not atomic across the build's awaits, so an op replay racing the boot
    // loop can pass both guards and orphan a duplicate clone in the scene
    // tree. Resolved long before the first user-driven op — this only ever
    // costs a microtask outside the boot window.
    await this._catalogsLoaded;
    if (this._objectMap.has(p.id)) return;

    const node = await this._buildPlacementFromRecord(p);
    if (!node) return;

    // Mirror placement record into the layout store so existing UI
    // (selection, hierarchy) sees the new entry without going through
    // the legacy add path. We've already verified above that no entry
    // with this id exists, so addComponent is safe here.
    this.store.addComponent({ ...p });
    // Op-replay (redo / multiuser / scene load) adds placements one at a time
    // and does not pair snaps. Coalesce a rebuild so a chained assembly's
    // connections are reconstructed once the whole burst has landed.
    this._scheduleSnapPairingRebuild();
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /**
   * Remove a single placement by id (op forward / undo of add).
   * Idempotent: silent no-op if id not found.
   */
  removePlacementById(id: string): void {
    if (!this._objectMap.has(id)) return;
    this._removePlacedFromScene(id);
    this.store.removeComponent(id);
    // markShadowsDirty so the removed asset's shadow clears from the map.
    if (this._viewer) this._viewer.markShadowsDirty();
  }

  /**
   * Apply a transform (position / rotation / scale, all in mm + degrees as
   * stored on `PlacedComponent`) to an existing placement.
   * Idempotent: silent no-op if id not found.
   */
  applyTransformById(
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
    scale: [number, number, number],
  ): void {
    const obj = this._objectMap.get(id);
    if (!obj) return;

    // The placement record's position/rotation are in the obj's normal
    // (layout-root or model-root) frame. While a multi-select pivot is
    // active, `obj.parent` is the pivot Group — its frame is the centroid,
    // NOT the layout root. Setting `obj.position.set(...)` in that state
    // would land the layout-root values into the pivot frame and shift the
    // world position by the centroid (the "jump on release" bug).
    //
    // Detour: re-park under originalParent (Object3D.attach preserves world
    // transform), set the placement-record local values, then re-attach to
    // the pivot. Forward apply during drag-end becomes a no-op; undo applies
    // the prev pose correctly.
    const pivotOriginalParent =
      this._multiSelectPivot?.getOriginalParent(obj) ?? null;
    const heldByPivot = pivotOriginalParent !== null && obj.parent !== pivotOriginalParent;

    if (heldByPivot && pivotOriginalParent) {
      const pivotParent = obj.parent;
      pivotOriginalParent.attach(obj);
      obj.position.set(position[0], position[1], position[2]);
      obj.rotation.set(
        MathUtils.degToRad(rotation[0]),
        MathUtils.degToRad(rotation[1]),
        MathUtils.degToRad(rotation[2]),
      );
      obj.scale.set(scale[0], scale[1], scale[2]);
      pivotParent?.attach(obj);
    } else {
      obj.position.set(position[0], position[1], position[2]);
      obj.rotation.set(
        MathUtils.degToRad(rotation[0]),
        MathUtils.degToRad(rotation[1]),
        MathUtils.degToRad(rotation[2]),
      );
      obj.scale.set(scale[0], scale[1], scale[2]);
    }

    // updateTransform stores position + rotation; scale changes stay on the
    // Three.js node only (the materialised view from ops carries the canonical
    // scale and is re-applied on scene reload).
    this.store.updateTransform(id, position, rotation);
    // markShadowsDirty so the moved asset's shadow follows the new transform.
    if (this._viewer) this._viewer.markShadowsDirty();
  }

  /**
   * Defensive: traverse the live scene and remove any node carrying a
   * `_layoutId` userData marker. Used by `clearLayout` (and by viewer
   * scene-switch flow) to catch placements that escaped the `_objectMap`
   * tracking — shouldn't happen, but guarantees clean visual state.
   */
  sweepOrphanLayoutObjects(): void {
    if (!this._viewer) return;
    const orphans: Object3D[] = [];
    this._viewer.scene.traverse((node) => {
      // Skip spawned MUs — they carry `_muSelectable` (never `_layoutId`) and
      // are sim-owned; the sweep must never remove them as layout orphans.
      if (node.userData?._muSelectable) return;
      if (node.userData?._layoutId) orphans.push(node);
    });
    for (const o of orphans) o.parent?.remove(o);
  }

  /** Toggle the visible 30 m authoring floor. Called by the Scene window
   *  when entering/leaving a layout scene so baked GLBs aren't covered by
   *  the planner's own floor. */
  setLayoutFloorVisible(visible: boolean): void {
    this._layoutFloor.visible = visible;
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /** Internal: shared restore path for placements (called by both the
   *  legacy applyLayoutFile and the new applyPlacements entry points).
   *
   *  Resolution order per placement:
   *   1. saved glbUrl, IF it's still a stable URL (not blob:)
   *   2. current catalog entry's glbUrl (looked up by catalogId), IF non-blob
   *   3. for `unity-cloud:` assets — re-download fresh via cloud extension
   *   4. anything else (the saved URL even if blob:) — almost certainly fails
   *      and we log a clear warning.
   */
  private async _restorePlacements(snap: PlacementsSnapshot): Promise<void> {
    this._clearPlaced();

    // Add referenced catalogs to the planner — addCatalog is idempotent on
    // the same URL so this is safe even if some are already loaded. GitHub
    // catalogs are opt-in only: a restored scene must NOT auto-scan GitHub
    // (placements that referenced it stay unresolved until the user re-adds
    // the GitHub library manually via the GitHub tab).
    for (const url of snap.catalogUrls) {
      if (isGitHubCatalogUrl(url)) continue;
      if (!this.store.getSnapshot().catalogUrls.includes(url)) {
        // Read-compat only (§2.6.3): a legacy scene's list is applied
        // additively with a non-persisting origin and never written back.
        this.store.addCatalog(url, 'config').catch(() => {});
      }
    }

    // Wait for the boot-time catalog load to finish (or fail). After this,
    // per-placement re-resolution has the freshest in-memory catalog state.
    await this._catalogsLoaded;

    // Wait for any in-flight Asset Manager connections too if our placements
    // include cloud assets. The cloud connection populates `assets[]` async
    // after auth + listing complete; without this wait the cloud-download
    // fallback in `_resolvePlacementUrl` returns null on first call.
    const cloud = this._extension?.cloudStore ?? null;
    const hasCloudAssets = snap.placements.some(c => c.catalogId.startsWith('unity-cloud:'));
    if (cloud && hasCloudAssets) {
      await plWaitForCloudReady(cloud);
    }

    // Resolve each placement to its best-available URL. Cloud download
    // is async so this is a sequenced loop, not a map.
    const resolved: { comp: PlacedComponent; url: string | null; isSplat: boolean }[] = [];
    for (const comp of snap.placements) {
      const url = await this._resolvePlacementUrl(comp);
      resolved.push({ comp, url, isSplat: !!comp.splatUrl });
    }

    // Pre-fetch distinct GLBs in parallel (skip splats), then place sequentially
    const distinctGlbUrls = [...new Set(
      resolved
        .filter(r => !r.isSplat && r.url != null)
        .map(r => r.url as string),
    )];
    await Promise.all(distinctGlbUrls.map(url =>
      this._modelCache.getOrLoad(url).catch(() => null),
    ));
    // Per-item `try/catch` is FAILURE ISOLATION, not placement code: without
    // it a single rejected promise aborts the whole restore loop and every
    // later placement silently disappears. It stays here even though the
    // placement body itself moved into `_buildPlacementFromRecord`.
    for (const { comp, url, isSplat } of resolved) {
      try {
        // Dedup: SceneStore op replay (loadScene Phase 4) and the planner's
        // own legacy autosave restore (_loadCatalogs) can both run on a
        // single boot. _addPlacedToScene overwrites _objectMap but leaves
        // the prior clone in the scene tree — without this guard the same
        // component would render twice.
        if (this._objectMap.has(comp.id)) continue;
        // Virtual DES placements have no source url and never will:
        // `resolvePlacementUrl` has no virtual branch, so it returns null for
        // them. Let those through to the helper (which builds the gizmo from
        // the catalog entry); everything else keeps the warn-and-skip.
        // Without this, a duplicated virtual component vanished on the next
        // reload — see plan-376 F7c.
        const isVirtual = this._findCatalogEntryById(comp.catalogId)?.virtual === true;
        if (!url && !isVirtual) {
          console.warn(
            `[LayoutPlanner] Cannot restore "${comp.label}" (${comp.catalogId}): ` +
            'no source URL could be resolved. ' +
            'Re-add the source catalog (or sign in to Asset Manager) to recover.',
          );
          continue;
        }

        const node = await this._buildPlacementFromRecord(comp, url ?? undefined);
        if (!node) continue;

        // Mirror a rebased / re-downloaded url back onto the record. Only for
        // GLB placements, exactly as before — the splat branch never did this.
        // (Its effect is overwritten by the `setComponents` below; kept as a
        // deliberate non-change rather than a silent omission.)
        if (!isSplat && url && url !== comp.glbUrl) {
          this.store.updateGlbUrl(comp.id, url);
        }
      } catch (e) {
        console.warn(`[LayoutPlanner] Failed to restore ${comp.label}: ${e}`);
      }
    }

    this.store.setComponents(snap.placements);
    if (snap.gridSizeMm > 0) this.store.setGridSize(snap.gridSizeMm);

    // All placements are now in the scene with their saved transforms and their
    // snap points re-scanned — reconstruct the snap-point connection graph from
    // geometry so chained assemblies survive reload.
    this._rebuildSnapPairings();

    this.store.autoSave();
    // Hierarchy browser caches the editable-node list; bulk restore mutates
    // the scene without going through any of the per-placement code paths
    // that emit the refresh, so we have to do it ourselves here. Without
    // this, the planner objects render in the 3D view but stay invisible
    // in the hierarchy until any other action triggers a refresh.
    this._refreshHierarchy();
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /** Toggle grid overlay visibility. */
  /** True while the planner workspace is active (its raycast/selection overrides
   *  are installed, so hover/selection resolve to whole placed components). */
  get isActive(): boolean { return this._active; }

  /** True when library-attached drive datasheets should be hidden: the planner
   *  is active AND documentation mode is off. The AAS tooltip resolver reads this
   *  to gate `gated` AAS links — outside the planner they are always shown. */
  get hideDriveDocs(): boolean { return this._active && !this.store.docMode; }

  toggleGrid(): void {
    const next = !this.store.gridEnabled;
    this.store.setGridEnabled(next);
    // Grid is drawn only when enabled AND a non-zero step is set (gridActive).
    if (!this._gridHelper && next && this.store.gridSizeMm > 0 && this._viewer) {
      this._createGridHelper();
    }
    if (this._gridHelper) {
      this._gridHelper.visible = next && this._active && this.store.gridSizeMm > 0;
    }
    // Update FloorGizmo snap settings immediately so the currently
    // selected object respects the new grid state without re-selecting.
    if (this._transformControls) {
      if (next) {
        // 0 mm step → translation snapping off (null), rotation snap still on.
        this._transformControls.setTranslationSnap(this.store.gridActive ? this.store.gridSizeMm / 1000 : null);
        this._transformControls.setRotationSnap(MathUtils.degToRad(this.store.rotationSnapDeg));
      } else {
        this._transformControls.setTranslationSnap(null);
        this._transformControls.setRotationSnap(null);
      }
    }
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /** Update grid size — rebuilds the grid overlay and updates snap settings. */
  setGridSize(mm: number): void {
    this.store.setGridSize(mm);
    const step = this.store.gridSizeMm; // clamped to >= 0 by the store
    // Rebuild grid overlay with new spacing
    if (this._gridHelper) {
      disposeSubtree(this._gridHelper);
      this._gridHelper.removeFromParent();
      this._gridHelper = null;
    }
    // 0 mm → no grid drawn (also avoids a divide-by-zero in _createGridHelper).
    if (this.store.gridActive && this._viewer) {
      this._createGridHelper();
    }
    // Update snap settings for the FloorGizmo: 0 mm turns translation snap off.
    if (this._transformControls && this.store.gridEnabled) {
      this._transformControls.setTranslationSnap(step > 0 ? step / 1000 : null);
    }
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /** Update rotation snap step (degrees) and push it to the live gizmo. */
  setRotationSnapDeg(deg: number): void {
    this.store.setRotationSnapDeg(deg);
    if (this._transformControls && this.store.gridEnabled) {
      this._transformControls.setRotationSnap(MathUtils.degToRad(deg));
    }
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /** Remove all placed components and clear the autosave. */
  clearLayout(): void {
    this._clearPlaced();
    this.store.setComponents([]);
    this.store.autoSave();
    this._refreshHierarchy();
    // Hide the authoring floor when leaving a layout scene (e.g. switching
    // back to a baked GLB). The Scene window calls clearLayout() in that path.
    this.setLayoutFloorVisible(false);
    if (this._viewer) this._viewer.markRenderDirty();
  }

  /**
   * Generate a thumbnail PNG data URL for a catalog entry.
   * Uses the viewer's WebGL renderer with an offscreen target.
   * Returns `null` under a WebGPURenderer (plan-271) — thumbnails need the
   * classic WebGLRenderer; the skip is warned once by ThumbnailRenderer.
   */
  async generateThumbnail(glbUrl: string, size = 512): Promise<string | null> {
    const viewer = this._viewer;
    if (!viewer) return null;
    // Manual (button-triggered) generation deliberately bypasses the service
    // queue and the persistent cache: the user pressed "regenerate" precisely
    // because they do not want the cached picture. It still goes through the
    // service so both paths share one renderer instance, and `render()` is
    // synchronous, so it cannot interleave with a queued job mid-render.
    const model = await this._modelCache.getOrLoad(glbUrl);
    return viewer.thumbnails.renderNow(model, size);
  }

  /**
   * Generate and save a thumbnail.
   *
   * Posts to the Vite dev-server middleware (`POST /api/library-thumbnail`),
   * which writes into `public/`. The other branch — a PNG written into a
   * working folder's `library/.thumbnails/` over the File System Access API —
   * went with the working folder itself (plan-709 §2.6); project-library
   * thumbnails are written by the save path, not here.
   *
   * Returns the persisted URL on success, or `null` if only the
   * in-memory data URL could be set.
   */
  async saveThumbnail(entryId: string, glbUrl: string): Promise<string | null> {
    const dataUrl = await this.generateThumbnail(glbUrl);
    // null = generation skipped (WebGPURenderer, plan-271) — nothing to persist.
    if (!dataUrl) return null;
    // Immediately show the generated thumbnail as data URL — the user
    // gets feedback even if the persistence step fails or is skipped.
    this.store.setEntryThumbnail(entryId, dataUrl);

    // ── Dev-server fallback (catalog/URL libraries) ────────────────
    try {
      const resp = await fetch('/api/library-thumbnail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogId: entryId, dataUrl }),
      });
      if (resp.ok) {
        const result = await resp.json();
        const savedUrl = result.url ?? null;
        // Update to file URL so it persists after rebuild
        if (savedUrl) this.store.setEntryThumbnail(entryId, savedUrl);
        return savedUrl;
      }
    } catch { /* dev server not available — data URL still shows */ }
    return null;
  }

  /** Resolve an entry's glbUrl by id across all catalogs (queue items are ids). */
  private _findEntryGlbUrl(entryId: string): string | undefined {
    for (const catalog of this.store.getSnapshot().catalogs.values()) {
      const found = catalog.entries.find(e => e.id === entryId);
      if (found) return found.glbUrl;
    }
    return undefined;
  }

  // ─── Internal: Selection & Grid ─────────────────────────────────

  /**
   * Select a placed object by its layout id.
   * Routes through the global SelectionManager — the 'selection-changed'
   * subscription (see _onSelectionChanged) handles TransformControls and
   * the LayoutStore.selectedId mirror automatically.
   */
  private _selectObject(id: string | null): void {
    const viewer = this._viewer;
    if (!viewer) return;
    if (!id) {
      viewer.selectionManager.clear();
      return;
    }
    const obj = this._objectMap.get(id);
    if (!obj) return;
    const path = viewer.registry?.getPathForNode(obj);
    if (path) viewer.selectionManager.select(path);
  }

  private _clearPlaced(): void {
    if (this._transformControls) this._transformControls.detach();
    for (const [id] of this._objectMap) {
      this._removePlacedFromScene(id);
    }
    this._objectMap.clear();
    this._refreshHierarchy();
  }

  private _createGridHelper(): void {
    // 0 mm step means translation snapping is off — no grid is drawn (guards
    // against divide-by-zero / infinite divisions below).
    if (this.store.gridSizeMm <= 0) return;
    const gridStepM = this.store.gridSizeMm / 1000; // e.g. 0.5 for 500mm
    // Size must be an exact multiple of the grid step so lines land on
    // multiples of gridStepM from the center — matching the checkerboard
    // floor whose tiles are 0.5 m aligned to the floor center.
    const rawSize = 50;
    const size = Math.floor(rawSize / gridStepM) * gridStepM;
    const divisions = Math.round(size / gridStepM);
    // Grey grid: brighter center line, mid-grey grid lines (was too dark at
    // 0x444444 / 0x333333 against the floor).
    this._gridHelper = new GridHelper(size, divisions, 0x999999, 0x808080);
    this._gridHelper.position.y = 0.001;
    // Align grid center with the checkerboard floor center (model bbox center)
    const groundMesh = this._viewer?.groundMesh;
    if (groundMesh) {
      // Snap the ground center to the nearest grid step so lines stay on
      // exact multiples of gridStepM — guaranteeing alignment with the
      // checker tiles (which repeat from the floor center outward).
      this._gridHelper.position.x = Math.round(groundMesh.position.x / gridStepM) * gridStepM;
      this._gridHelper.position.z = Math.round(groundMesh.position.z / gridStepM) * gridStepM;
    }
    this._gridHelper.userData._layoutObject = true;
    // Keep the grid out of SSAO (its lines sit just above the floor and would
    // otherwise cast faint AO halos along every line) while still rendering
    // normally and depth-occluded by placed objects.
    markNoAO(this._gridHelper);
    this._layoutRoot.add(this._gridHelper);
  }

  /** Get the model root (GLB root node) to parent layout objects under. */
  private _getModelRoot(): Object3D | null {
    if (!this._viewer) return null;
    return (this._viewer as unknown as { currentModel: Object3D | null }).currentModel;
  }

  /**
   * Resolve a unique name for a placed object by checking the model root.
   * Delegates to `./scene-mutations.resolveUniqueName`.
   */
  private _resolveUniqueName(clone: Object3D): void {
    smResolveUniqueName(this._sceneMutDeps, clone);
  }

  /**
   * Add a placed layout object to the scene under the model root with full
   * rv-extras processing (signals, drives, components — same pipeline as loadGLB).
   * Delegates to `./scene-mutations.addPlacedToScene`.
   *
   * ⚠ `opts.mode` defaults to `'full'` and MUST stay that way. This method is
   * the shared facade for eight callers — `placeComponent` (which also serves
   * the MCP `web_layout_place` tool), Duplicate, both Paste branches,
   * `placeFromRecord` (undo/redo replay) and both boot-restore paths. A `light`
   * default would leave every one of them registered without signals, drives,
   * snap ports or raycast targets: no crash, just a dead layout. Exactly ONE
   * caller passes `'light'` — the pending placeholder in `_startGlbDraft`.
   */
  private _addPlacedToScene(
    clone: Object3D,
    id: string,
    label: string,
    catalogId: string,
    opts?: { skipAutoAlign?: boolean; mode?: PlacementRegistrationMode },
  ): ProcessExtrasResult | null {
    return smAddPlacedToScene(this._sceneMutDeps, clone, id, label, catalogId, opts);
  }

  /**
   * Snap-aligned placement entry point — used by the SnapPointPickerPopup.
   *
   * Loads the asset via the model cache, then delegates to
   * `./scene-mutations.placeAtSnapPoint` for snap-aligned matrix math + scene
   * insertion. Returns the new placement id, or `null` if placement was
   * rejected (occupied / non-uniform scale / missing snap).
   */
  async placeAtSnap(
    entry: LibraryCatalogEntry,
    target: SnapPoint,
    ownSnapName: string,
  ): Promise<string | null> {
    if (!this._viewer) return null;
    if (!entry.glbUrl) return null;

    const snapPlugin = this._viewer.getPlugin<SnapPointPlugin>('snap-point');
    const snapRegistry = snapPlugin?.getRegistry();
    if (!snapRegistry) return null;
    if (target.occupied) return null;

    const node = await this._modelCache.getOrLoad(entry.glbUrl);
    const id = crypto.randomUUID();

    const result = smPlaceAtSnapPoint(
      this._sceneMutDeps,
      node,
      id,
      entry.name,
      entry.id,
      target,
      ownSnapName,
      snapRegistry,
    );
    if (result === null) return null;

    const comp: PlacedComponent = {
      id,
      catalogId: entry.id,
      glbUrl: entry.glbUrl,
      label: entry.name,
      position: [node.position.x, node.position.y, node.position.z],
      rotation: [
        MathUtils.radToDeg(node.rotation.x),
        MathUtils.radToDeg(node.rotation.y),
        MathUtils.radToDeg(node.rotation.z),
      ],
      scale: [node.scale.x, node.scale.y, node.scale.z],
      ...boundsOfPlacedNode(node),
    };
    this.store.addComponent(comp);
    this.store.autoSave();
    this._refreshHierarchy();

    // Record the placement in the Scene op log so it persists across save /
    // load / scene-switch cycles — the same way `placeComponent` does for
    // the regular drag-from-library path. Without this, snap-picker
    // placements only survive the in-memory store + localStorage autosave
    // and are dropped by the persistent Scene model.
    emitPlannerOp(this._viewer, {
      id: opId(), ts: Date.now(), schemaV: 1,
      kind: 'addPlacement', placement: { ...comp },
    });

    // `smPlaceAtSnapPoint` pairs only the single target↔ownSnap pair. If the
    // placed piece has OTHER ports coincident with neighbours (loop closure,
    // multi-port turntable), pair them too via the reload reconstruction — it
    // skips the already-occupied engaged pair and adds the remaining coincident
    // ends. No-op when nothing else is coincident.
    this._scheduleSnapPairingRebuild();

    this._viewer.markRenderDirty();
    return id;
  }

  /**
   * Register a splat container (already added to scene by loadSplat()) as a
   * layout object. Delegates to `./scene-mutations.addSplatPlacedToScene`.
   */
  private _addSplatPlacedToScene(container: Object3D, id: string, label: string, catalogId: string, splatUrl: string): void {
    smAddSplatPlacedToScene(this._sceneMutDeps, container, id, label, catalogId, splatUrl);
  }

  /** O(1) lookup: returns the placed-id whose root === `root`, or null. */
  findPlacedIdByRoot(root: Object3D): string | null {
    return this._idByObject.get(root) ?? null;
  }

  /** O(1) lookup: returns the placed root Object3D for a placement id, or null.
   *  Used by MCP snap/bounds tools to resolve a placement id to its live node. */
  getPlacedRootById(id: string): Object3D | null {
    return this._objectMap.get(id) ?? null;
  }

  /** Walk up from `node` to the nearest placed root and return its id +
   *  root, or null if `node` does not live under any placed asset. */
  findPlacedAncestor(node: Object3D): { id: string; root: Object3D } | null {
    let cur: Object3D | null = node;
    while (cur) {
      const id = this._idByObject.get(cur);
      if (id) return { id, root: cur };
      cur = cur.parent;
    }
    return null;
  }

  /**
   * Reconstruct snap-point connections from geometry after a restore.
   *
   * Restore replays each placement's saved transform but does NOT recreate the
   * runtime snap-registry state (`pairedSnapId` / `occupied`) — so chained
   * assemblies lose their connections on reload (no chain-mode drag, no
   * occupancy, no reverse-direction). Because mated snaps are placed exactly
   * coincident in world space, we pair any two compatible, currently-unoccupied
   * snaps from different owners whose world positions coincide.
   *
   * Safe to call repeatedly: it only adds pairings for unoccupied coincident
   * snaps and never disturbs connections already established live.
   */
  private _rebuildSnapPairings(): void {
    const v = this._viewer;
    if (!v) return;
    const snapPlugin = v.getPlugin<SnapPointPlugin>('snap-point');
    const reg = snapPlugin?.getRegistry();
    if (!reg) return;

    // Some snaps ride on a drive-controlled node (e.g. a turntable's rotating
    // platform `Drive-Rot-Y` owns its connection ports). Two snaps were mated
    // at the drive's HOME pose, so we must sample at that pose — otherwise a
    // rotated/translated drive moves the port far from its (static) partner and
    // the coincidence test fails. Snapshot each drive node, move it to home,
    // sample all snap world positions, then restore.
    const drives = v.drives ?? [];
    const restore: { node: Object3D; pos: Vector3; quat: Quaternion }[] = [];
    for (const d of drives) {
      restore.push({ node: d.node, pos: d.node.position.clone(), quat: d.node.quaternion.clone() });
      d.getHomeLocalPosition(d.node.position);
      d.getHomeLocalQuaternion(d.node.quaternion);
    }
    v.scene.updateMatrixWorld(true);

    const wp = new Vector3();
    const inputs: RebuildSnapInput[] = [];
    for (const sp of reg.getAll()) {
      if (sp.occupied) continue; // keep any pairing already established live
      sp.object3D.getWorldPosition(wp);
      inputs.push({
        id: sp.id, typeId: sp.typeId, flow: sp.flow,
        owner: sp.ownerRoot, x: wp.x, y: wp.y, z: wp.z,
      });
    }

    // Restore the live drive poses before we apply pairings / return.
    for (const r of restore) {
      r.node.position.copy(r.pos);
      r.node.quaternion.copy(r.quat);
    }
    if (restore.length > 0) v.scene.updateMatrixWorld(true);

    if (inputs.length < 2) return;

    const pairs = computeProximityPairings(inputs, SNAP_PAIR_REBUILD_EPS_M);
    for (const { aId, bId } of pairs) {
      const a = reg.getById(aId);
      const b = reg.getById(bId);
      if (!a || !b) continue;
      // Each snap is occupied BY the asset on the OPPOSITE side — mirrors the
      // convention used by placeAtSnapPoint and the magnetic drag controller.
      const aPlaced = (this.findPlacedIdByRoot(a.ownerRoot) ?? `snap:${a.id}`) as PlacedComponentId;
      const bPlaced = (this.findPlacedIdByRoot(b.ownerRoot) ?? `snap:${b.id}`) as PlacedComponentId;
      reg.markOccupied(a.id, bPlaced);
      reg.markOccupied(b.id, aPlaced);
      reg.pair(a.id, b.id);
    }
    if (pairs.length > 0) v.markRenderDirty();
  }

  /**
   * Coalesce snap-pairing rebuilds. Op-replay (redo / multiuser / scene load)
   * adds placements one at a time via `placeFromRecord`; a trailing-edge timer
   * runs a single rebuild once the burst settles and both ends of each
   * connection are present.
   */
  private _scheduleSnapPairingRebuild(): void {
    if (this._pairingRebuildTimer !== null) return;
    this._pairingRebuildTimer = setTimeout(() => {
      this._pairingRebuildTimer = null;
      this._rebuildSnapPairings();
    }, 0);
  }

  /**
   * Reverse a connected placement's direction.
   *
   * Rotates the placed asset 180° around the outward axis of its current
   * snap-point connection. The pivot is the snap world position, so the
   * connection point stays exactly where it is — only the asset's
   * orientation around the connecting axis is flipped (e.g. a conveyor's
   * motor / sensor ends swap sides, but the connector stays mated).
   *
   * No-ops if the asset has no paired snap (= not part of a chain).
   *
   * Used by the Inspector "Reverse direction" button. Chain-mode-aware:
   * a placed asset is its own pivot, downstream chain members do NOT
   * follow (they're independent placements with their own orientations).
   */
  reversePlacement(placedId: string): boolean {
    const v = this._viewer;
    if (!v) return false;
    const obj = this._objectMap.get(placedId);
    if (!obj) return false;
    const snapPlugin = v.getPlugin<SnapPointPlugin>('snap-point');
    const reg = snapPlugin?.getRegistry();
    if (!reg) return false;

    // Find any paired snap owned by this placement — that's the connection
    // axis we rotate around. If multiple pairings exist (e.g. middle module
    // of a 3-member chain), pick the first; the user can chain-reverse the
    // rest individually if needed.
    let pivot: Vector3 | null = null;
    let axis: Vector3 | null = null;
    for (const sp of reg.getAll()) {
      if (sp.ownerRoot !== obj) continue;
      if (!sp.pairedSnapId) continue;
      sp.object3D.updateWorldMatrix(true, false);
      pivot = new Vector3().setFromMatrixPosition(sp.object3D.matrixWorld);
      // Outward axis derived from the snap's local position relative to its
      // asset root — same convention as the alignment math. We need a unit
      // vector along which to perform the 180° spin.
      const tmp = new Vector3().setFromMatrixPosition(sp.object3D.matrixWorld);
      const rootW = new Vector3().setFromMatrixPosition(obj.matrixWorld);
      tmp.sub(rootW);
      // Dominant-axis pick in the asset's own local frame, then transform back to world.
      const rootInvQ = new Quaternion().setFromRotationMatrix(obj.matrixWorld).invert();
      tmp.applyQuaternion(rootInvQ);
      const ax = Math.abs(tmp.x);
      const ay = Math.abs(tmp.y);
      const az = Math.abs(tmp.z);
      const mx = Math.max(ax, ay, az);
      const localOut = new Vector3();
      if (mx < 1e-4) {
        // Fall back to the snap's named axis if position is ambiguous.
        const a = sp.dir.axis;
        localOut.set(a === 'X' ? 1 : 0, a === 'Y' ? 1 : 0, a === 'Z' ? 1 : 0);
      } else if (ax === mx) localOut.set(tmp.x > 0 ? 1 : -1, 0, 0);
      else if (ay === mx) localOut.set(0, tmp.y > 0 ? 1 : -1, 0);
      else localOut.set(0, 0, tmp.z > 0 ? 1 : -1);
      const rootQ = new Quaternion().setFromRotationMatrix(obj.matrixWorld);
      localOut.applyQuaternion(rootQ).normalize();
      axis = localOut;
      break;
    }

    if (!pivot || !axis) return false;

    // Build the rotation: 180° around `axis`, pivoted at `pivot`.
    // result = T2 * spinMat * T1 * M  (apply M, shift pivot to origin, spin, shift back)
    obj.updateMatrixWorld(true);
    const spinQ = new Quaternion().setFromAxisAngle(axis, Math.PI);
    const step = new Matrix4().makeRotationFromQuaternion(spinQ);
    const T1 = new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
    const T2 = new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
    // Build right-to-left, never mutating an existing operand in place.
    const result = new Matrix4()
      .multiplyMatrices(T1, obj.matrixWorld)
      .premultiply(step)
      .premultiply(T2);
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(result);
    result.decompose(obj.position, obj.quaternion, obj.scale);
    obj.matrixAutoUpdate = true;
    obj.updateMatrixWorld(true);

    // Persist the new transform via the same path the gizmo uses on
    // drag-end, so undo / autosave / multi-user sync all stay coherent.
    this._writeSingleTransform(placedId, obj);
    // markShadowsDirty so the flipped asset's shadow matches its new pose.
    v.markShadowsDirty();
    return true;
  }

  /**
   * Remove a placed layout object from the scene with full system cleanup.
   * Delegates to `./scene-mutations.removePlacedFromScene`.
   */
  private _removePlacedFromScene(id: string): void {
    // Single choke point for ALL eight removal paths (plan-371 §2.6): delete,
    // undo, drag cancel, scene reload, Delete key, hierarchy context menu,
    // plugin teardown and model change every funnel through here. Cancelling
    // the pending load centrally is what stops a late swap from resurrecting
    // the node; the matching RESOURCE dispose sits one level further down, in
    // `scene-mutations.removePlacedFromScene`.
    this._pending.cancel(id);
    // The pulse gizmo hangs under the placement root; `removePlacedFromScene`
    // takes the root out of the scene but knows nothing about the gizmo
    // manager, so its entry would survive (and keep blinking a material) unless
    // it is released here, at the same choke point.
    this._pulse.stop(id);
    smRemovePlacedFromScene(this._sceneMutDeps, id);
  }

  /** Find a catalog entry by its stable id across all loaded catalogs.
   *  Thin wrapper over `./planner-persistence.findCatalogEntryById`. */
  private _findCatalogEntryById(catalogId: string): LibraryCatalogEntry | null {
    return plFindCatalogEntryById(this.store, catalogId);
  }

  /** Unregisters the selection→asset resolver (plan-410 F1). */
  private _unregisterAssetResolver: (() => void) | null = null;

  /**
   * Resolve a selected scene path to the library asset its placement was made
   * from (plan-410 F1) — the answer the asset editor asks for on
   * `mode-changing`.
   *
   * Walks UP from the selected node: the user may have clicked a sub-mesh, but
   * only the placement root carries the layout id. From there the placement's
   * `catalogId` finds the catalog entry, and `localPath` is the same
   * work-folder-relative path the library card's "Edit asset" action uses — so
   * both entry points open byte-identical documents.
   *
   * Returns null (→ the editor falls back to its last-edited memory) for
   * anything the editor cannot author: splats, virtual DES gizmos, and any
   * asset without a local library path (cloud/provider assets keep their
   * provenance outside `PlacedComponent` — deliberately out of scope, plan-410
   * §7 alternative 3).
   */
  private _resolveSelectionToAsset(primaryPath: string): AssetBase | null {
    const viewer = this._viewer;
    const node = viewer?.registry?.getNode(primaryPath);
    if (!node) return null;

    let placementId: string | null = null;
    for (let n: Object3D | null = node; n; n = n.parent) {
      const id = this._idByObject.get(n);
      if (id) { placementId = id; break; }
    }
    if (!placementId) return null;

    const placed = this.store.placed.find((c) => c.id === placementId);
    if (!placed || placed.splatUrl) return null;

    const entry = this._findCatalogEntryById(placed.catalogId);
    const localPath = entry?.localPath;
    if (!entry || !localPath || !entry.glbUrl || entry.splatUrl) return null;
    if (entry.virtual || localPath.startsWith('splats/')) return null;

    return libraryDocumentBase(localPath);
  }

  /**
   * Pick the freshest valid glbUrl for a placement during scene restore.
   * Thin wrapper over `./planner-persistence.resolvePlacementUrl`.
   */
  private async _resolvePlacementUrl(comp: PlacedComponent): Promise<string | null> {
    return plResolvePlacementUrl(this.store, this._extension?.cloudStore ?? null, comp);
  }

  /** Notify the extras editor plugin to refresh its hierarchy after layout changes. */
  private _refreshHierarchy(): void {
    if (!this._viewer) return;
    const editor = this._viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
    editor?.refreshEditableNodes();
  }

  /** Find the catalog entry for current placementMode. */
  private _getPlacementEntry(): LibraryCatalogEntry | null {
    const snapshot = this.store.getSnapshot();
    if (!snapshot.placementMode) return null;
    for (const [, catalog] of snapshot.catalogs) {
      const entry = catalog.entries.find(e => e.id === snapshot.placementMode);
      if (entry) return entry;
    }
    return null;
  }

  // ─── Internal: Catalog Loading ──────────────────────────────────

  private async _loadCatalogs(): Promise<void> {
    const constructorUrls = this._options.catalogUrls ?? [];
    const params = new URLSearchParams(window.location.search);
    const paramUrls = params.getAll('library');

    // Origins drive the persistence policy (§2.6.3): neither a build default,
    // a constructor option nor a `?library=` deep link is a user subscription,
    // so none of them is written into the global localStorage list. A URL the
    // user later adds by hand is promoted to `'user'` and then persists.
    for (const url of [...new Set([...DEFAULT_LIBRARY_URLS, ...constructorUrls])]) {
      await this.store.addCatalog(url, 'config').catch(() => {});
    }
    for (const url of new Set(paramUrls)) {
      await this.store.addCatalog(url, 'urlParam').catch(() => {});
    }

    await this.store.restoreFromStorage();
    this.store.loadAutoSave();

    // Re-place auto-saved components under model root
    const saved = this.store.getSnapshot().placed;
    if (saved.length > 0 && this._viewer) {
      // Wait for AM connections to finish connecting AND loading assets.
      // Only meaningful when a cloud extension is available; public-only
      // builds with cloud-derived layout entries skip those entries below.
      const cloud = this._extension?.cloudStore ?? null;
      const hasAmAssets = saved.some(c => c.catalogId.startsWith('unity-cloud:') && c.glbUrl.startsWith('blob:'));
      if (hasAmAssets && cloud) {
        showInfoOverlay('Waiting for Asset Manager…');
        await plWaitForCloudReady(cloud);
      }

      showInfoOverlay(`Restoring layout (0/${saved.length})…`);
      let restored = 0;

      // Per-item `try/catch` is FAILURE ISOLATION — see the matching note in
      // `_restorePlacements`. It survives the move of the placement body into
      // `_buildPlacementFromRecord`.
      for (const comp of saved) {
        try {
          // Dedup: if SceneStore op replay (loadScene Phase 4) already
          // placed this component, skip the legacy restore for it. Both
          // paths run on boot — without this the same component renders
          // twice (see applyPlacements for matching guard).
          if (this._objectMap.has(comp.id)) {
            restored++;
            continue;
          }

          // Asset Manager assets have blob: URLs that die on reload.
          // Re-download via the cloud store if the extension is wired.
          const glbUrl = await plRefreshCloudGlbUrl(this.store, cloud, comp, (label) => {
            showInfoOverlay(`${label} (${restored + 1}/${saved.length})`);
          });
          if (glbUrl == null) continue;

          showInfoOverlay(`Restoring ${comp.label}… (${restored + 1}/${saved.length})`);
          // Since plan-376 this path shares the placement body with the other
          // two restore paths, so it also honours `visible`, runs the Inspector
          // marker sync and can restore splats — none of which it used to do.
          const node = await this._buildPlacementFromRecord(comp, glbUrl);
          // Count only what actually landed: a skipped placement (missing splat
          // plugin) must not inflate the "Restoring (n/m)" overlay.
          if (node !== null) restored++;
        } catch (e) {
          console.warn(`[LayoutPlanner] Failed to restore component ${comp.label}:`, e);
        }
      }
      // Reconstruct the snap-point connection graph (enchainment) from geometry
      // so chained assemblies restored from the legacy autosave survive a page
      // reload. The scene-ops restore path (_restorePlacements) already rebuilds
      // pairings; this autosave path did not, which left chains unpaired until
      // the planner was toggled off/on.
      this._rebuildSnapPairings();
      this.store.autoSave(); // persist any updated blob URLs
      this._refreshHierarchy();
      this._viewer.markRenderDirty();
      hideInfoOverlay();
    }
  }
}

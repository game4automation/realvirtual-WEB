// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVHighlightManager — Central highlight system for the WebViewer.
 *
 * Channels:
 *   - **Hover**: temporary highlight under the cursor (RaycastManager).
 *   - **Selection**: persistent highlight for selected objects (SelectionManager).
 *   - **Aux emphasis**: named auxiliary sets unioned into the selection visual
 *     (e.g. the planner's placement-preview ghost) — {@link setAuxEmphasis}.
 *   - **Flash**: short alarm pulse combining fill + edges + OutlinePass outline
 *     in one color, independent of hover/selection — {@link flash}.
 *
 * WHAT a highlight looks like is decided by the active {@link HighlightProfile}
 * (mode-driven, installed via {@link setProfile} by RVHighlightPolicy):
 *   - visual 'overlay' → fill + edges overlay pairs (HMI/DES; batched and
 *     unbatched content look identical — the OutlinePass is never used).
 *   - visual 'outline' → OutlinePass silhouette (planner/editor), with a
 *     per-root capability fallback to the overlay look (WebGPU without TSL,
 *     fully batched root).
 * The pure {@link resolveStrategy} function encodes that fallback matrix.
 *
 * Per-call `visual` overrides the profile's desired visual (e.g. the editor's
 * kinematic-group preview forces 'overlay' so every member mesh reads clearly).
 */

import {
  Mesh,
  Color,
  MeshBasicMaterial,
  LineBasicMaterial,
  EdgesGeometry,
  LineSegments,
  Object3D,

  Matrix4,
  Box3,
  Box3Helper,
  BufferGeometry,
} from 'three';
import type { Scene } from 'three';
import type { InstancedMovingUnit } from './rv-mu';
import { HIGHLIGHT_OVERLAY_LAYER } from './rv-group-registry';
import type { RVOutlineManager } from './rv-outline-manager';
import { DEFAULT_OUTLINE_STYLE, DEFAULT_HOVER_OUTLINE_STYLE, ATTENTION_OUTLINE_GEOMETRY } from './rv-outline-manager';
import type { GizmoHandle, GizmoOverlayManager } from './rv-gizmo-manager';
import type { PickMetrics, HighlightStrategy } from './rv-pick-metrics';
import type { HighlightProfile, HighlightVisual } from './rv-highlight-profiles';
import { resolveOutlineTargets } from './rv-status-outline';
import { subscribeOverlayVisibility, isOverlayVisible } from '../overlay-visibility-store';

// ─── Highlight Style ──────────────────────────────────────────────────

/**
 * Per-channel highlight appearance for the overlay path (fill + edges).
 * Bundled per mode inside a {@link HighlightProfile}.
 */
export interface HighlightStyle {
  /** Overlay fill color (hex). */
  overlayColor: number;
  /** Overlay opacity in [0..1]. */
  overlayOpacity: number;
  /** When true, render the overlay as a triangle wireframe (every edge). */
  overlayWireframe: boolean;
  /** Edge outline color (hex). */
  edgeColor: number;
  /** Edge outline opacity in [0..1]. */
  edgeOpacity: number;
  /** Edge line width (mostly ignored on WebGL — kept for completeness). */
  edgeLinewidth?: number;
  /** When false, the overlay fill mesh is not created. */
  showOverlay: boolean;
  /** When false, the silhouette edge LineSegments are not created. */
  showEdges: boolean;
}

/** True when a mesh is actually rendered by the main camera: `.visible` AND
 *  not layer-masked out. Batched render sources (BatchedMesh instances) keep
 *  `visible = true` but carry `layers.mask = 0` — OutlinePass would silhouette
 *  nothing for them, so they must take the geometry-overlay highlight path. */
function isRenderedMesh(m: Mesh): boolean {
  return m.visible && m.layers.mask !== 0;
}

/** Default hover style — the BLUE family used by HMI and DES modes (the modes
 *  that keep the app-wide defaults). A lighter, less intense blue than the
 *  selection style below, so hovering reads as a hint while a selected object
 *  clearly dominates. Planner (green) and editor (yellow) install their own
 *  profiles, so the highlight color alone tells the user which mode is active. */
export const DEFAULT_HOVER_STYLE: HighlightStyle = Object.freeze({
  overlayColor: 0x4aa3ff,
  overlayOpacity: 0.10,
  overlayWireframe: false,
  edgeColor: 0x4aa3ff,
  edgeOpacity: 0.4,
  edgeLinewidth: 1,
  showOverlay: true,
  showEdges: true,
});

/** Default selection style — the deeper, more intense BLUE used by HMI and DES
 *  modes. Brighter and more opaque than DEFAULT_HOVER_STYLE so the selected
 *  object dominates the hovered one. */
export const DEFAULT_SELECTION_STYLE: HighlightStyle = Object.freeze({
  overlayColor: 0x1e88ff,
  overlayOpacity: 0.20,
  overlayWireframe: false,
  edgeColor: 0x1e88ff,
  edgeOpacity: 0.65,
  edgeLinewidth: 1,
  showOverlay: true,
  showEdges: true,
});

/** Built-in profile active before RVHighlightPolicy installs a mode profile —
 *  identical to the HMI profile (overlay visual, blue styles). Defined here
 *  (not imported from rv-highlight-profiles) to avoid a module cycle. */
const BUILTIN_PROFILE: HighlightProfile = Object.freeze({
  visual: 'overlay' as const,
  hoverStyle: DEFAULT_HOVER_STYLE,
  selectionStyle: DEFAULT_SELECTION_STYLE,
  hoverOutline: DEFAULT_HOVER_OUTLINE_STYLE,
  selectionOutline: DEFAULT_OUTLINE_STYLE,
});

// ─── Strategy resolver (pure — the single decision point) ─────────────

/** Rendering strategy resolved for one highlight root. */
export type ResolvedStrategy = 'outline' | 'overlay' | 'fill-proxy' | 'bbox' | 'mu-overlay';

/** Options for {@link RVHighlightManager.highlightSelection}. */
export interface SelectionHighlightOptions {
  includeSensorViz?: boolean;
  includeChildDrives?: boolean;
  /** Per-call desired visual (overrides the mode profile). */
  visual?: HighlightVisual;
  /** Per-call color/opacity override for this selection only. The mode
   *  profile is left untouched — the next highlight without a style reverts
   *  to the profile look. */
  style?: HighlightStyle;
}

/** Capability context for {@link resolveStrategy} (all per-root). */
export interface StrategyContext {
  /** The profile's (or per-call override's) desired visual. */
  desired: HighlightVisual;
  /** OutlinePass usable (wired + renderer supports it). */
  outlineAvailable: boolean;
  /** Root subtree has ≥1 camera-rendered mesh (OutlinePass precondition). */
  hasRenderedMesh: boolean;
  /** A proxy provider covers this root AND its edge arena is ready. */
  proxyAvailable: boolean;
  /** Collected mesh count of the root subtree. */
  meshCount: number;
  /** Overlay mesh budget — above it, bounding-box wireframe. */
  maxMeshes: number;
}

/**
 * The explicit fallback matrix (replaces the old implicit ladder):
 *
 * | desired  | condition                                   | resolved     |
 * |----------|---------------------------------------------|--------------|
 * | outline  | outline available AND ≥1 rendered mesh      | outline      |
 * | outline  | outline unavailable OR root fully batched   | overlay*     |
 * | overlay  | proxy windows + edge arena ready            | fill-proxy   |
 * | overlay  | otherwise, meshCount ≤ maxMeshes            | overlay      |
 * | overlay* | meshCount > maxMeshes                       | bbox         |
 *
 * `fallback` is true when the resolved strategy is not the desired visual
 * (outline→overlay downgrade, or the bbox budget cap).
 * In 'overlay' mode the outline branch is NEVER taken — batched and unbatched
 * content look identical in HMI/DES.
 */
export function resolveStrategy(ctx: StrategyContext): { strategy: ResolvedStrategy; fallback: boolean } {
  if (ctx.desired === 'outline') {
    if (ctx.outlineAvailable && ctx.hasRenderedMesh) return { strategy: 'outline', fallback: false };
    return resolveOverlayFamily(ctx, true);
  }
  return resolveOverlayFamily(ctx, false);
}

function resolveOverlayFamily(ctx: StrategyContext, fallback: boolean): { strategy: ResolvedStrategy; fallback: boolean } {
  if (ctx.proxyAvailable) return { strategy: 'fill-proxy', fallback };
  if (ctx.meshCount <= ctx.maxMeshes) return { strategy: 'overlay', fallback };
  return { strategy: 'bbox', fallback: true };
}

/** Map a resolved strategy onto the PickMetrics vocabulary. */
function toMetricsStrategy(s: ResolvedStrategy): HighlightStrategy {
  return s === 'overlay' ? 'overlay-legacy' : s;
}

// ─── Overlay provider seam (§4.2 drawRange proxies plug in here) ──────

/** Channel a provider overlay belongs to (release grouping + style source). */
export type OverlayChannel = 'hover' | 'selection' | 'aux' | 'flash';

/** Handle to one provider-acquired overlay; release() returns it to the pool. */
export interface OverlayHandle {
  release(): void;
}

/**
 * Pluggable overlay source. The proxy provider (rv-highlight-proxy.ts)
 * serves zero-copy drawRange proxies over the merged pick geometry;
 * when it can't handle a target the manager builds legacy per-mesh pairs.
 */
export interface HighlightOverlayProvider {
  /** True when this provider can fully visualize `target` right now. */
  canHandle(target: Object3D): boolean;
  /** Create (or reuse from pool) the overlay visuals for `target`. */
  acquire(target: Object3D, channel: OverlayChannel, style: HighlightStyle): OverlayHandle;
}

// ─── Constants ────────────────────────────────────────────────────────

/** Duration of the ping attention pulse in ms. */
const PING_DURATION_MS = 900;
/** Number of opacity pulses within one ping. */
const PING_PULSES = 3;

/** Silhouette-edge crease threshold. NOTE: three's EdgesGeometry takes the
 *  threshold in DEGREES — the pre-refactor code passed radians (~0.52°), which
 *  drew practically every tessellation edge on curved parts (full wireframe).
 *  30° matches the gizmo mesh-edges look and the proxy edge arena. */
const EDGE_THRESHOLD_DEG = 30;

/** Default max meshes for hover highlight — above this, show bounding-box wireframe instead. */
const DEFAULT_MAX_HOVER_MESHES = 200;

/** OutlinePass flash-channel pulse period (s). Only the OUTLINE pulses —
 *  the fill/edges overlays render steady at the opacities below (matching
 *  the selection overlay look). */
const FLASH_PULSE_PERIOD_S = 0.6;
/** Default flash duration (ms). */
const FLASH_DURATION_MS = 3500;
const FLASH_FILL_OPACITY = 0.2;
const FLASH_EDGE_OPACITY = 0.65;

/** WeakMap cache for EdgesGeometry — avoids recomputing edges for the same BufferGeometry */
const edgeGeometryCache = new WeakMap<BufferGeometry, EdgesGeometry>();

/** Drop the cached EdgesGeometry for a source geometry after an in-place
 *  mutation (the cache would otherwise serve stale silhouettes). */
export function invalidateEdgeCache(geometry: BufferGeometry): void {
  const cached = edgeGeometryCache.get(geometry);
  if (cached) {
    cached.dispose();
    edgeGeometryCache.delete(geometry);
  }
}

// ─── Overlay Pair (fill + edge linked to source mesh) ────────────────

interface OverlayPair {
  source: Mesh;
  /** Null when the active style has `showOverlay: false`. */
  fill: Mesh | null;
  /** Null when the active style has `showEdges: false`. */
  edge: LineSegments | null;
  /** True when fill/edge are pooled wrappers owned by the OverlayBuilder. */
  pooled?: boolean;
}

/** Shared placeholder geometry parked on pooled wrappers while free — keeps
 *  the pool from pinning the last-highlighted geometry in memory. */
const EMPTY_GEOMETRY = new BufferGeometry();

/**
 * OverlayBuilder — internal builder/pool for the legacy per-mesh overlay pairs
 * (fill Mesh + cached-EdgesGeometry LineSegments). Wrappers are pooled: on
 * release they leave the scene and park on a free list; the next acquire
 * reassigns geometry/material/matrix instead of allocating and re-adding new
 * objects per hover move.
 */
class OverlayBuilder {
  private readonly _freeFills: Mesh[] = [];
  private readonly _freeEdges: LineSegments[] = [];

  constructor(private readonly scene: Scene) {}

  acquirePair(
    geometry: BufferGeometry,
    matrix: Matrix4,
    sourceMesh: Mesh,
    namePrefix: string,
    thresholdDeg: number,
    fillMat: MeshBasicMaterial,
    edgeMaterial: LineBasicMaterial,
    renderOrderBase: number,
    showOverlay: boolean,
    showEdges: boolean,
  ): OverlayPair {
    let overlay: Mesh | null = null;
    if (showOverlay) {
      overlay = this._freeFills.pop() ?? this._newFill();
      overlay.geometry = geometry;
      overlay.material = fillMat;
      overlay.name = `${namePrefix}_hlOverlay`;
      overlay.renderOrder = renderOrderBase;
      overlay.matrix.copy(matrix);
      overlay.matrixWorld.copy(matrix);
      this.scene.add(overlay);
    }

    let edgeLines: LineSegments | null = null;
    if (showEdges) {
      let edgeGeo = edgeGeometryCache.get(geometry);
      if (!edgeGeo) {
        edgeGeo = new EdgesGeometry(geometry, thresholdDeg);
        edgeGeometryCache.set(geometry, edgeGeo);
      }
      edgeLines = this._freeEdges.pop() ?? this._newEdge();
      edgeLines.geometry = edgeGeo;
      edgeLines.material = edgeMaterial;
      edgeLines.name = `${namePrefix}_hlEdge`;
      edgeLines.renderOrder = renderOrderBase + 1;
      edgeLines.matrix.copy(matrix);
      edgeLines.matrixWorld.copy(matrix);
      this.scene.add(edgeLines);
    }

    return { source: sourceMesh, fill: overlay, edge: edgeLines, pooled: true };
  }

  /** Remove pairs from the scene; pooled wrappers return to the free lists. */
  releasePairs(pairs: OverlayPair[]): void {
    for (const pair of pairs) {
      const { fill, edge, pooled } = pair;
      if (fill) {
        this.scene.remove(fill);
        if (pooled) {
          fill.geometry = EMPTY_GEOMETRY;
          this._freeFills.push(fill);
        }
      }
      if (edge && edge !== (fill as unknown as LineSegments)) {
        this.scene.remove(edge);
        if (pooled) {
          edge.geometry = EMPTY_GEOMETRY;
          this._freeEdges.push(edge);
        }
      }
    }
    pairs.length = 0;
  }

  /** Overlay object contract: on-top overlay layer, never picked, never in AO. */
  private _newFill(): Mesh {
    const m = new Mesh(EMPTY_GEOMETRY);
    m.userData._highlightOverlay = true;
    m.raycast = () => {};
    m.matrixAutoUpdate = false;
    m.matrixWorldAutoUpdate = false;
    m.layers.set(HIGHLIGHT_OVERLAY_LAYER);
    return m;
  }

  private _newEdge(): LineSegments {
    const l = new LineSegments(EMPTY_GEOMETRY as EdgesGeometry);
    l.userData._highlightOverlay = true;
    l.raycast = () => {};
    l.matrixAutoUpdate = false;
    l.matrixWorldAutoUpdate = false;
    l.layers.set(HIGHLIGHT_OVERLAY_LAYER);
    return l;
  }
}

// ─── RVHighlightManager ──────────────────────────────────────────────

export class RVHighlightManager {
  /** Hover overlay pairs. */
  private hoverPairs: OverlayPair[] = [];
  /** Selection overlay pairs (persistent). */
  private selectionPairs: OverlayPair[] = [];
  /** Aux-emphasis overlay pairs (overlay-mode rendering of aux sets). */
  private auxPairs: OverlayPair[] = [];
  /** Flash overlay pairs (pulsing fill+edges). */
  private flashPairs: OverlayPair[] = [];
  /** When true, update() re-syncs hover overlay matrices from source meshes. */
  private hoverTracked = false;
  /** When true, update() re-syncs selection overlay matrices. */
  private selectionTracked = false;

  /** Max meshes before falling back to bounding-box wireframe. */
  maxHoverMeshes = DEFAULT_MAX_HOVER_MESHES;

  /** The active mode profile (what a highlight looks like). */
  private _profile: HighlightProfile = BUILTIN_PROFILE;

  /** Active hover style (from the profile). */
  private _hoverStyle: HighlightStyle = { ...DEFAULT_HOVER_STYLE };
  /** Active selection style (from the profile). */
  private _selectionStyle: HighlightStyle = { ...DEFAULT_SELECTION_STYLE };

  /** Materials built from the current styles. Recreated on profile change. */
  private _hoverOverlayMat: MeshBasicMaterial;
  private _hoverEdgeMat: LineBasicMaterial;
  private _selectionOverlayMat: MeshBasicMaterial;
  private _selectionEdgeMat: LineBasicMaterial;

  /** Cached materials for the last per-call selection style override
   *  (`highlightSelection({ style })`) — one slot, rebuilt when the style
   *  changes. The profile styles above are never touched by an override. */
  private _overrideKey = '';
  private _overrideOverlayMat: MeshBasicMaterial | null = null;
  private _overrideEdgeMat: LineBasicMaterial | null = null;

  /** Optional outline-pass manager (OutlinePass silhouettes for the
   *  'outline' visual + the flash outline channel). */
  private _outlineManager: RVOutlineManager | null = null;

  /** Optional §4.2 proxy overlay provider (zero-copy drawRange proxies). */
  private _proxyProvider: HighlightOverlayProvider | null = null;

  /** Provider handles per channel (released together with the channel). */
  private _hoverProxyHandles: OverlayHandle[] = [];
  private _selectionProxyHandles: OverlayHandle[] = [];
  private _auxProxyHandles: OverlayHandle[] = [];

  /** Roots currently on the selection outline channel (unioned with aux). */
  private _selectionOutlineRoots: Object3D[] = [];
  /** Aux roots currently rendered through the outline channel. */
  private _auxOutlineRoots: Object3D[] = [];
  /** Named aux emphasis sets (e.g. 'planner-ghost'). */
  private readonly _auxSets = new Map<string, Object3D[]>();

  /** Active flash state, or null. */
  private _flashState: {
    until: number;
    fillMat: MeshBasicMaterial;
    edgeMat: LineBasicMaterial;
    disposeProxies: (() => void) | null;
    proxyHandles: OverlayHandle[];
  } | null = null;

  /** Overlay builder + pool (legacy per-mesh pairs). */
  private readonly _builder: OverlayBuilder;

  /** True while the user has hidden the 'highlights' overlay category (plan-250).
   *  Cached from the store; when set, hover/selection highlights are suppressed. */
  private _catHidden = !isOverlayVisible('highlights');
  private _offOverlay: () => void;

  /** Optional highlight-apply timing sink (DevTools "Picking & Highlight"). */
  private _metrics: PickMetrics | null = null;
  /** Strategy taken by the currently-running highlight apply (set at branch points). */
  private _lastStrategy: HighlightStrategy = 'none';
  /** Whether the last apply downgraded from the desired visual. */
  private _lastFallback = false;

  constructor(private readonly scene: Scene) {
    this._builder = new OverlayBuilder(scene);
    this._hoverOverlayMat = this._buildOverlayMat(this._hoverStyle, '_hoverOverlay');
    this._hoverEdgeMat = this._buildEdgeMat(this._hoverStyle);
    this._selectionOverlayMat = this._buildOverlayMat(this._selectionStyle, '_selectionOverlay');
    this._selectionEdgeMat = this._buildEdgeMat(this._selectionStyle);
    // Overlay-visibility gate (plan-250): when 'highlights' is switched off,
    // suppress new highlights and clear any that are currently shown. A render
    // is triggered centrally by the Display panel toggle (markRenderDirty).
    this._offOverlay = subscribeOverlayVisibility(() => {
      this._catHidden = !isOverlayVisible('highlights');
      if (this._catHidden) this.clearAll();
    });
  }

  /**
   * Wire up the outline-pass manager. Called once during viewer
   * construction. Pushes the current profile's outline styles.
   */
  setOutlineManager(om: RVOutlineManager | null): void {
    this._outlineManager = om;
    if (om) {
      om.setStyle({ ...this._profile.selectionOutline });
      om.setHoverStyle({ ...this._profile.hoverOutline });
    }
  }

  /** True when the outline pass is wired up and the renderer supports it (WebGL). */
  private _useOutline(): boolean {
    return !!this._outlineManager && this._outlineManager.available;
  }

  /** Install the §4.2 proxy overlay provider (null to remove). */
  setProxyProvider(provider: HighlightOverlayProvider | null): void {
    this._proxyProvider = provider;
  }

  /** Install the highlight-apply timing sink (null to disable). */
  setMetrics(metrics: PickMetrics | null): void {
    this._metrics = metrics;
  }

  /** Live overlay objects across all channels (bbox pairs alias fill === edge). */
  private _overlayObjectCount(): number {
    let n = 0;
    for (const list of [this.hoverPairs, this.selectionPairs, this.auxPairs, this.flashPairs]) {
      for (const p of list) {
        if (p.fill) n++;
        if (p.edge && p.edge !== (p.fill as unknown as LineSegments)) n++;
      }
    }
    return n;
  }

  /** Report one highlight apply to the metrics sink (start time from performance.now()). */
  private _recordHighlight(startMs: number): void {
    if (!this._metrics) return;
    this._metrics.recordHighlight(
      performance.now() - startMs,
      this._lastStrategy,
      this._overlayObjectCount(),
      this._lastFallback,
    );
  }

  // ─── Profile API ─────────────────────────────────────────────────────

  /**
   * Install a mode highlight profile: atomically swaps the desired visual,
   * both overlay-channel styles AND both OutlinePass channel styles.
   * Callers should clear()/refresh the selection afterwards — existing
   * overlays keep referencing the old materials until re-applied
   * (RVHighlightPolicy does exactly that on mode-changed).
   */
  setProfile(profile: HighlightProfile): void {
    this._profile = profile;
    this._setHoverStyle(profile.hoverStyle);
    this._setSelectionStyle(profile.selectionStyle);
    this._outlineManager?.setStyle({ ...profile.selectionOutline });
    this._outlineManager?.setHoverStyle({ ...profile.hoverOutline });
    this.maxHoverMeshes = profile.maxHoverMeshes ?? DEFAULT_MAX_HOVER_MESHES;
  }

  /** The active mode profile. */
  getProfile(): HighlightProfile {
    return this._profile;
  }

  /** Read the current active selection style. */
  getSelectionStyle(): Readonly<HighlightStyle> {
    return this._selectionStyle;
  }

  /** Read the current active hover style. */
  getHoverStyle(): Readonly<HighlightStyle> {
    return this._hoverStyle;
  }

  private _setSelectionStyle(style: HighlightStyle): void {
    this._selectionOverlayMat.dispose();
    this._selectionEdgeMat.dispose();
    this._selectionStyle = { ...style };
    this._selectionOverlayMat = this._buildOverlayMat(this._selectionStyle, '_selectionOverlay');
    this._selectionEdgeMat = this._buildEdgeMat(this._selectionStyle);
  }

  private _setHoverStyle(style: HighlightStyle): void {
    this._hoverOverlayMat.dispose();
    this._hoverEdgeMat.dispose();
    this._hoverStyle = { ...style };
    this._hoverOverlayMat = this._buildOverlayMat(this._hoverStyle, '_hoverOverlay');
    this._hoverEdgeMat = this._buildEdgeMat(this._hoverStyle);
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  private _buildOverlayMat(style: HighlightStyle, name: string): MeshBasicMaterial {
    const mat = new MeshBasicMaterial({
      color: style.overlayColor,
      transparent: style.overlayOpacity < 1.0,
      opacity: style.overlayOpacity,
      wireframe: style.overlayWireframe,
      depthTest: false,
      depthWrite: false,
    });
    mat.name = name;
    return mat;
  }

  private _buildEdgeMat(style: HighlightStyle): LineBasicMaterial {
    return new LineBasicMaterial({
      color: style.edgeColor,
      transparent: style.edgeOpacity < 1.0,
      opacity: style.edgeOpacity,
      linewidth: style.edgeLinewidth ?? 1,
      depthTest: false,
      depthWrite: false,
    });
  }

  /** Resolve the strategy for one root (shared by all channels). */
  private _resolve(root: Object3D, meshes: Mesh[], desired: HighlightVisual): { strategy: ResolvedStrategy; fallback: boolean } {
    return resolveStrategy({
      desired,
      outlineAvailable: this._useOutline(),
      hasRenderedMesh: meshes.some(isRenderedMesh),
      proxyAvailable: this._proxyProvider?.canHandle(root) ?? false,
      meshCount: meshes.length,
      maxMeshes: this.maxHoverMeshes,
    });
  }

  /** Sync tracked overlay positions. */
  private _syncPairs(pairs: OverlayPair[]): void {
    for (const { source, fill, edge } of pairs) {
      source.updateWorldMatrix(true, false);
      if (fill) {
        fill.matrix.copy(source.matrixWorld);
        fill.matrixWorld.copy(source.matrixWorld);
      }
      if (edge) {
        edge.matrix.copy(source.matrixWorld);
        edge.matrixWorld.copy(source.matrixWorld);
      }
    }
  }

  /** Build overlay pairs for a set of meshes into a channel pair list. */
  private _buildPairs(
    meshes: Mesh[],
    into: OverlayPair[],
    fillMat: MeshBasicMaterial,
    edgeMat: LineBasicMaterial,
    style: HighlightStyle,
    renderOrderBase: number,
    nameSuffix = '',
  ): void {
    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      into.push(this._builder.acquirePair(
        mesh.geometry, mesh.matrixWorld, mesh, mesh.name + nameSuffix, EDGE_THRESHOLD_DEG,
        fillMat, edgeMat, renderOrderBase,
        style.showOverlay, style.showEdges,
      ));
    }
  }

  // ─── Hover API (temporary highlights) ──────────────────────────────

  /**
   * Highlight a subtree in the mode's hover visual.
   * Replaces any previous hover highlight. Does NOT affect selection.
   */
  highlight(root: Object3D, track = false, options?: { includeSensorViz?: boolean; includeChildDrives?: boolean; visual?: HighlightVisual }): void {
    const t0 = performance.now();
    this._lastStrategy = 'none';
    this._lastFallback = false;
    this._highlightImpl(root, track, options);
    this._recordHighlight(t0);
  }

  private _highlightImpl(root: Object3D, track: boolean, options?: { includeSensorViz?: boolean; includeChildDrives?: boolean; visual?: HighlightVisual }): void {
    this.clear();
    if (this._catHidden) return; // 'highlights' overlay category switched off
    const includeSensorViz = options?.includeSensorViz ?? false;
    const includeChildDrives = options?.includeChildDrives ?? false;
    const meshes = this.collectMeshes(root, includeSensorViz, includeChildDrives);
    const desired = options?.visual ?? this._profile.visual;
    const { strategy, fallback } = this._resolve(root, meshes, desired);
    this._lastStrategy = toMetricsStrategy(strategy);
    this._lastFallback = fallback;

    switch (strategy) {
      case 'outline':
        // OutlinePass renders the silhouette of the live scene mesh, so
        // tracking is implicit (no per-frame matrix sync needed) and dense
        // subtrees don't need the bounding-box fallback.
        this._outlineManager!.setHoverOutlined([root]);
        return;
      case 'fill-proxy':
        this._hoverProxyHandles.push(this._proxyProvider!.acquire(root, 'hover', this._hoverStyle));
        return;
      case 'bbox':
        this.hoverTracked = track;
        this._highlightBoundingBox(root);
        return;
      default:
        this.hoverTracked = track;
        this._buildPairs(meshes, this.hoverPairs, this._hoverOverlayMat, this._hoverEdgeMat, this._hoverStyle, 1000);
    }
  }

  /**
   * Highlight an instanced MU by creating temporary hover overlay meshes.
   */
  highlightInstancedMU(mu: InstancedMovingUnit): void {
    const t0 = performance.now();
    this._lastStrategy = 'none';
    this._lastFallback = false;
    this._highlightInstancedMUImpl(mu);
    this._recordHighlight(t0);
  }

  private _highlightInstancedMUImpl(mu: InstancedMovingUnit): void {
    this.clear();
    if (this._catHidden) return; // 'highlights' overlay category switched off
    this.hoverTracked = false;

    const pool = mu.node.userData?._muPool;
    if (!pool || mu.slotIndex < 0) return;

    const geometry = mu.node.geometry;
    if (!geometry) return;

    const mat = new Matrix4();
    mu.node.getMatrixAt(mu.slotIndex, mat);

    this._lastStrategy = 'mu-overlay';
    const pair = this._builder.acquirePair(
      geometry, mat, null as unknown as Mesh, '__imu', EDGE_THRESHOLD_DEG,
      this._hoverOverlayMat, this._hoverEdgeMat, 1000,
      this._hoverStyle.showOverlay, this._hoverStyle.showEdges,
    );
    if (pair.fill) pair.source = pair.fill;
    this.hoverPairs.push(pair);
  }

  /**
   * Highlight multiple subtrees at once on the hover channel.
   * Replaces any previous hover highlight. `options.visual` overrides the
   * profile's desired visual per call (e.g. 'overlay' for the editor's group
   * preview so each grouped mesh reads clearly, not just the outer silhouette).
   */
  highlightMultiple(roots: Object3D[], options?: { includeSensorViz?: boolean; visual?: HighlightVisual }): void {
    const t0 = performance.now();
    this._lastStrategy = 'none';
    this._lastFallback = false;
    this._highlightMultipleImpl(roots, options);
    this._recordHighlight(t0);
  }

  private _highlightMultipleImpl(roots: Object3D[], options?: { includeSensorViz?: boolean; visual?: HighlightVisual }): void {
    this.clear();
    if (this._catHidden) return; // 'highlights' overlay category switched off
    const includeSensorViz = options?.includeSensorViz ?? false;
    const desired = options?.visual ?? this._profile.visual;

    const outlineRoots: Object3D[] = [];
    const overlayEntries: { root: Object3D; meshes: Mesh[] }[] = [];
    let anyOverlay = false;
    let anyProxy = false;
    let anyBbox = false;
    for (const root of roots) {
      const meshes = this.collectMeshes(root, includeSensorViz);
      const { strategy, fallback } = this._resolve(root, meshes, desired);
      if (fallback) this._lastFallback = true;
      switch (strategy) {
        case 'outline': outlineRoots.push(root); break;
        case 'fill-proxy':
          anyProxy = true;
          this._hoverProxyHandles.push(this._proxyProvider!.acquire(root, 'hover', this._hoverStyle));
          break;
        default: overlayEntries.push({ root, meshes }); anyOverlay = true;
      }
    }

    if (outlineRoots.length > 0) {
      this._lastStrategy = 'outline';
      this._outlineManager!.setHoverOutlined(outlineRoots);
    } else if (anyProxy) {
      this._lastStrategy = 'fill-proxy';
    }
    if (overlayEntries.length === 0) return;

    this.hoverTracked = true;
    const totalMeshes = overlayEntries.reduce((n, e) => n + e.meshes.length, 0);
    if (totalMeshes > this.maxHoverMeshes) {
      anyBbox = true;
      this._lastFallback = true;
      for (const { root } of overlayEntries) this._highlightBoundingBox(root);
    } else {
      for (const { meshes } of overlayEntries) {
        this._buildPairs(meshes, this.hoverPairs, this._hoverOverlayMat, this._hoverEdgeMat, this._hoverStyle, 1000);
      }
    }
    if (anyOverlay) this._lastStrategy = anyBbox ? 'bbox' : 'overlay-legacy';
  }

  // ─── Ping API (short attention pulse) ───────────────────────────────

  /** Gizmo manager used for the ping glow hull (same visual as the
   *  CustomRuntimeInstruction highlight). Wired by the viewer after construction. */
  private _gizmoManager: GizmoOverlayManager | null = null;

  /** Active ping pulse, or null. Only one ping at a time — a new ping replaces it. */
  private _pingState: { gizmo: GizmoHandle; start: number } | null = null;

  /** Wire up the gizmo overlay manager used for ping pulses. */
  setGizmoManager(gm: GizmoOverlayManager | null): void {
    this._gizmoManager = gm;
  }

  /**
   * Fire a short attention pulse on a node: a blinking mesh-glow hull (the
   * same visual the CustomRuntimeInstruction highlight uses), auto-removed
   * after ~1s. Used by the hierarchy browser so hovered/clicked rows are easy
   * to spot in the 3D view even when the object is small or occluded.
   * Independent of the hover and selection channels.
   */
  ping(root: Object3D): void {
    this.clearPing();
    if (this._catHidden) return; // 'highlights' overlay category switched off
    if (!this._gizmoManager) return;
    const gizmo = this._gizmoManager.create(root, {
      shape: 'mesh-glow-hull',
      color: this._hoverStyle.edgeColor,
      opacity: 0.95,
      blinkHz: PING_PULSES / (PING_DURATION_MS / 1000),
      outlineScale: 1.06,
      visible: true,
      category: 'status',
    });
    this._pingState = { gizmo, start: performance.now() };
  }

  /** Remove an active ping pulse immediately. */
  clearPing(): void {
    if (!this._pingState) return;
    this._pingState.gizmo.dispose();
    this._pingState = null;
  }

  /** Whether a ping pulse is currently animating (needs per-frame renders). */
  get isPingActive(): boolean {
    return this._pingState !== null;
  }

  /** Remove hover highlight overlays only. Selection persists. */
  clear(): void {
    this._builder.releasePairs(this.hoverPairs);
    for (const h of this._hoverProxyHandles) h.release();
    this._hoverProxyHandles = [];
    this.hoverTracked = false;
    this._outlineManager?.clearHover();
  }

  /** Whether any hover highlight is currently active. */
  get isActive(): boolean {
    return this.hoverPairs.length > 0
      || this._hoverProxyHandles.length > 0
      || (this._outlineManager?.hoverPass?.selectedObjects?.length ?? 0) > 0;
  }

  // ─── Selection API (persistent highlights) ─────────────────────────

  /**
   * Highlight multiple subtrees on the selection channel in the mode's
   * selection visual. Replaces any previous selection highlight. Does NOT
   * affect hover. Overlay-path selection is always tracked (follows moving
   * meshes). `options.visual` overrides the profile per call; `options.style`
   * additionally overrides the selection COLOR/opacity for this call only
   * (used by the editor's kinematic group preview) without disturbing the
   * mode profile — the profile still owns every other selection.
   */
  highlightSelection(roots: Object3D[], options?: SelectionHighlightOptions): void {
    const t0 = performance.now();
    this._lastStrategy = 'none';
    this._lastFallback = false;
    this._highlightSelectionImpl(roots, options);
    this._recordHighlight(t0);
  }

  /** Materials for a per-call style override, cached in a single slot so a
   *  repeated highlight with the same style does not rebuild them. */
  private _overrideMats(style: HighlightStyle): { overlay: MeshBasicMaterial; edge: LineBasicMaterial } {
    const key = `${style.overlayColor}_${style.overlayOpacity}_${style.overlayWireframe ? 1 : 0}`
      + `_${style.edgeColor}_${style.edgeOpacity}_${style.edgeLinewidth}`;
    if (key !== this._overrideKey || !this._overrideOverlayMat || !this._overrideEdgeMat) {
      this._overrideOverlayMat?.dispose();
      this._overrideEdgeMat?.dispose();
      this._overrideOverlayMat = this._buildOverlayMat(style, '_selectionOverrideOverlay');
      this._overrideEdgeMat = this._buildEdgeMat(style);
      this._overrideKey = key;
    }
    return { overlay: this._overrideOverlayMat, edge: this._overrideEdgeMat };
  }

  private _highlightSelectionImpl(roots: Object3D[], options?: SelectionHighlightOptions): void {
    this.clearSelection();
    if (this._catHidden) return; // 'highlights' overlay category switched off
    if (roots.length === 0) return;
    const includeSensorViz = options?.includeSensorViz ?? false;
    const includeChildDrives = options?.includeChildDrives ?? false;
    const desired = options?.visual ?? this._profile.visual;
    // Per-call color override (kinematic group preview) — falls back to the
    // profile's selection style and materials when absent.
    const style = options?.style ?? this._selectionStyle;
    const mats = options?.style
      ? this._overrideMats(options.style)
      : { overlay: this._selectionOverlayMat, edge: this._selectionEdgeMat };

    const outlineRoots: Object3D[] = [];
    const overlayEntries: { root: Object3D; meshes: Mesh[] }[] = [];
    let anyProxy = false;
    for (const root of roots) {
      const meshes = this.collectMeshes(root, includeSensorViz, includeChildDrives);
      const { strategy, fallback } = this._resolve(root, meshes, desired);
      if (fallback) this._lastFallback = true;
      switch (strategy) {
        case 'outline': outlineRoots.push(root); break;
        case 'fill-proxy':
          anyProxy = true;
          this._selectionProxyHandles.push(this._proxyProvider!.acquire(root, 'selection', style));
          break;
        default: overlayEntries.push({ root, meshes });
      }
    }

    if (outlineRoots.length > 0) {
      this._lastStrategy = 'outline';
      this._selectionOutlineRoots = outlineRoots;
      this._pushSelectionOutline();
    } else if (anyProxy) {
      this._lastStrategy = 'fill-proxy';
    }
    if (overlayEntries.length === 0) return;
    this._lastStrategy = 'overlay-legacy';
    this.selectionTracked = true;

    for (const { meshes } of overlayEntries) {
      this._buildPairs(meshes, this.selectionPairs, mats.overlay, mats.edge, style, 900, '_sel');
    }
  }

  /** Remove selection highlight overlays only. Hover and aux persist. */
  clearSelection(): void {
    this._builder.releasePairs(this.selectionPairs);
    for (const h of this._selectionProxyHandles) h.release();
    this._selectionProxyHandles = [];
    this.selectionTracked = false;
    this._selectionOutlineRoots = [];
    this._pushSelectionOutline();
  }

  /** Whether any selection highlight is currently active. */
  get isSelectionActive(): boolean {
    return this.selectionPairs.length > 0
      || this._selectionProxyHandles.length > 0
      || this._selectionOutlineRoots.length > 0;
  }

  // ─── Aux emphasis (named sets unioned into the selection visual) ────

  /**
   * Show/replace/remove a named auxiliary emphasis set — objects rendered
   * with the SELECTION visual on top of (independent of) the actual
   * selection. Used by the planner's placement-preview ghost. Pass null (or
   * an empty array) to remove the set.
   *
   * In outline modes the aux roots join the selection OutlinePass channel;
   * in overlay modes they get selection-style fill+edges pairs.
   */
  setAuxEmphasis(id: string, roots: readonly Object3D[] | null): void {
    if (!roots || roots.length === 0) this._auxSets.delete(id);
    else this._auxSets.set(id, [...roots]);
    this._applyAux();
  }

  private _applyAux(): void {
    // Release previous aux visuals.
    this._builder.releasePairs(this.auxPairs);
    for (const h of this._auxProxyHandles) h.release();
    this._auxProxyHandles = [];
    this._auxOutlineRoots = [];

    if (this._catHidden || this._auxSets.size === 0) {
      this._pushSelectionOutline();
      return;
    }

    const desired = this._profile.visual;
    for (const roots of this._auxSets.values()) {
      for (const root of roots) {
        const meshes = this.collectMeshes(root, false);
        const { strategy } = this._resolve(root, meshes, desired);
        switch (strategy) {
          case 'outline':
            this._auxOutlineRoots.push(root);
            break;
          case 'fill-proxy':
            this._auxProxyHandles.push(this._proxyProvider!.acquire(root, 'aux', this._selectionStyle));
            break;
          case 'bbox':
            this._highlightBoundingBox(root, this.auxPairs);
            break;
          default:
            this._buildPairs(meshes, this.auxPairs, this._selectionOverlayMat, this._selectionEdgeMat, this._selectionStyle, 900, '_aux');
        }
      }
    }
    this._pushSelectionOutline();
  }

  /** Push the union of selection + aux roots to the selection outline channel. */
  private _pushSelectionOutline(): void {
    if (!this._outlineManager) return;
    const union = [...this._selectionOutlineRoots];
    for (const r of this._auxOutlineRoots) if (!union.includes(r)) union.push(r);
    this._outlineManager.setOutlined(union);
  }

  /** Whether any aux emphasis is currently shown (tracked pairs need syncing). */
  get isAuxActive(): boolean {
    return this.auxPairs.length > 0
      || this._auxProxyHandles.length > 0
      || this._auxOutlineRoots.length > 0;
  }

  // ─── Flash API (alarm pulse: fill + edges + outline, all modes) ─────

  /**
   * Flash an alarm on `roots`: STATIC fill + edges (the exact hover/selection
   * overlay look) plus the PULSING OutlinePass flash channel, all in
   * `opts.color`, for `durationMs` (default 3500 ms), then auto-cleared.
   * Only the outline pulses — fill and edges stay steady. Independent of the
   * hover/selection/aux channels — an alarm never clobbers the user's
   * selection outline. A new flash replaces the previous one. Batched roots
   * get invisible outline proxies so the silhouette works everywhere.
   */
  flash(roots: readonly Object3D[], opts: { color: number; durationMs?: number }): void {
    this.clearFlash();
    if (this._catHidden || roots.length === 0) return;

    const flashStyle: HighlightStyle = {
      overlayColor: opts.color, overlayOpacity: FLASH_FILL_OPACITY, overlayWireframe: false,
      edgeColor: opts.color, edgeOpacity: FLASH_EDGE_OPACITY, showOverlay: true, showEdges: true,
    };
    const fillMat = this._buildOverlayMat(flashStyle, '_flashOverlay');
    const edgeMat = this._buildEdgeMat(flashStyle);

    // Fill + edges on every root — the SAME rendering paths as hover: the
    // drawRange proxy when it covers the root (correct 30° crease edges),
    // legacy pooled pairs otherwise (budget-capped so a mis-targeted flash on
    // a huge assembly can't build thousands of pairs).
    const proxyHandles: OverlayHandle[] = [];
    let budget = this.maxHoverMeshes;
    for (const root of roots) {
      if (this._proxyProvider?.canHandle(root)) {
        proxyHandles.push(this._proxyProvider.acquire(root, 'flash', flashStyle));
        continue;
      }
      if (budget <= 0) continue;
      const meshes = this.collectMeshes(root, false).slice(0, budget);
      budget -= meshes.length;
      for (const mesh of meshes) {
        mesh.updateWorldMatrix(true, false);
        this.flashPairs.push(this._builder.acquirePair(
          mesh.geometry, mesh.matrixWorld, mesh, mesh.name + '_flash', EDGE_THRESHOLD_DEG,
          fillMat, edgeMat, 1100, true, true,
        ));
      }
    }

    // Outline on the flash channel — batched roots via invisible proxies.
    let disposeProxies: (() => void) | null = null;
    const om = this._outlineManager;
    if (om && om.available) {
      const dark = (c: number) => {
        const f = 0.35;
        const r = Math.round(((c >> 16) & 0xff) * f);
        const g = Math.round(((c >> 8) & 0xff) * f);
        const b = Math.round((c & 0xff) * f);
        return (r << 16) | (g << 8) | b;
      };
      const resolved = resolveOutlineTargets(this.scene, roots as Object3D[]);
      disposeProxies = resolved.dispose;
      om.setFlashStyle({
        visibleEdgeColor: opts.color,
        hiddenEdgeColor: dark(opts.color),
        ...ATTENTION_OUTLINE_GEOMETRY,
        pulsePeriod: FLASH_PULSE_PERIOD_S,
      });
      om.setFlashOutlined(resolved.targets);
    }

    this._flashState = {
      until: performance.now() + (opts.durationMs ?? FLASH_DURATION_MS),
      fillMat,
      edgeMat,
      disposeProxies,
      proxyHandles,
    };
  }

  /** Remove an active flash immediately. */
  clearFlash(): void {
    if (!this._flashState) return;
    this._builder.releasePairs(this.flashPairs);
    for (const h of this._flashState.proxyHandles) h.release();
    this._outlineManager?.clearFlash();
    this._flashState.disposeProxies?.();
    this._flashState.fillMat.dispose();
    this._flashState.edgeMat.dispose();
    this._flashState = null;
  }

  /** Whether a flash pulse is currently animating (needs per-frame renders). */
  get isFlashActive(): boolean {
    return this._flashState !== null;
  }

  // ─── Common API ────────────────────────────────────────────────────

  /**
   * Per-frame maintenance: re-sync tracked overlay positions, animate the
   * flash opacity pulse, expire ping + flash. Call once per render frame.
   */
  update(): void {
    if (this.hoverTracked && this.hoverPairs.length > 0) {
      this._syncPairs(this.hoverPairs);
    }
    if (this.selectionTracked && this.selectionPairs.length > 0) {
      this._syncPairs(this.selectionPairs);
    }
    if (this.auxPairs.length > 0) {
      this._syncPairs(this.auxPairs);
    }
    if (this._pingState && performance.now() - this._pingState.start >= PING_DURATION_MS) {
      this.clearPing();
    }
    const flash = this._flashState;
    if (flash) {
      if (performance.now() >= flash.until) {
        this.clearFlash();
      } else if (this.flashPairs.length > 0) {
        // Fill/edges stay at constant opacity — only the OutlinePass flash
        // channel pulses (pulsePeriod). Just track moving alarm roots.
        this._syncPairs(this.flashPairs);
      }
    }
  }

  /** Remove all overlays (hover, selection, aux, ping, flash). */
  clearAll(): void {
    this.clear();
    this.clearSelection();
    this._auxSets.clear();
    this._applyAux();
    this.clearPing();
    this.clearFlash();
  }

  dispose(): void {
    this._offOverlay();
    this.clearAll();
    this._hoverOverlayMat.dispose();
    this._hoverEdgeMat.dispose();
    this._selectionOverlayMat.dispose();
    this._selectionEdgeMat.dispose();
    this._overrideOverlayMat?.dispose();
    this._overrideEdgeMat?.dispose();
  }

  /** Cheap bounding-box wireframe highlight for components with too many meshes. */
  private _highlightBoundingBox(root: Object3D, into: OverlayPair[] = this.hoverPairs): void {
    const box = new Box3().setFromObject(root);
    if (box.isEmpty()) return;
    const helper = new Box3Helper(box, new Color(this._hoverStyle.edgeColor));
    helper.userData._highlightOverlay = true;
    helper.renderOrder = 1000;
    helper.raycast = () => {};
    helper.layers.set(HIGHLIGHT_OVERLAY_LAYER);
    // Box3Helper instantiates its own LineBasicMaterial which DEFAULTS to
    // depthWrite:true, depthTest:true — that contaminates the depth buffer
    // before GTAO/N8AO run in the next composer pass and produces dark
    // halos along the wire. Force the same depth contract used by the
    // other highlight materials in this manager (depthTest:false +
    // depthWrite:false → renders on top, never affects AO).
    const helperMat = helper.material as LineBasicMaterial;
    helperMat.depthTest = false;
    helperMat.depthWrite = false;
    helperMat.transparent = true;
    helperMat.opacity = this._hoverStyle.edgeOpacity;
    this.scene.add(helper);
    into.push({ source: root as unknown as Mesh, fill: helper as unknown as Mesh, edge: helper as unknown as LineSegments });
  }

  /**
   * Collect all Meshes under root, optionally stopping at child drive boundaries.
   * Skips existing overlay meshes.
   */
  private collectMeshes(root: Object3D, includeSensorViz: boolean, includeChildDrives = false): Mesh[] {
    const meshes: Mesh[] = [];
    const visit = (node: Object3D, isRoot: boolean) => {
      if (!isRoot && !includeChildDrives) {
        const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
        if (rv?.['Drive']) return; // child drive boundary — don't highlight nested drives
      }
      if (
        (node as Mesh).isMesh &&
        !node.userData?._highlightOverlay &&
        !node.userData?._driveHoverOverlay
      ) {
        const isSensorViz = node.name.endsWith('_sensorViz');
        if (!isSensorViz || includeSensorViz) {
          meshes.push(node as Mesh);
        }
      }
      for (const child of node.children) visit(child, false);
    };
    visit(root, true);
    return meshes;
  }
}

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
  Sphere,
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
import { makeRangeProxyGeometry } from './rv-bake-chunk';
import { NO_AO_LAYER } from './rv-constants';
import { RV_BAKE_CHUNK_KEY, type ChunkHighlightSource, type ChunkHighlightTarget, type PlacementInstance } from './rv-bake-registry';

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
export type ResolvedStrategy = 'outline' | 'chunk-outline' | 'chunk-overlay' | 'overlay' | 'bbox' | 'mu-overlay';

/** Options for {@link RVHighlightManager.setAuxEmphasis}. */
export interface AuxEmphasisOptions {
  /** Draw this set in its own color (fill + edges, selection opacities)
   *  instead of the mode's selection style. The OutlinePass side stays the
   *  shared selection channel. */
  color?: number;
}

/** One registered aux-emphasis set (see {@link RVHighlightManager.setAuxEmphasis}). */
interface AuxEmphasisSet {
  roots: Object3D[];
  /** Own overlay style when the set was registered with a color. */
  style?: HighlightStyle;
}

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
 * | outline  | outline unavailable OR root fully baked     | overlay*     |
 * | overlay  | meshCount ≤ maxMeshes                       | overlay      |
 * | overlay* | meshCount > maxMeshes                       | bbox         |
 *
 * Roots that resolve to chunk targets (baked placements, the baked in-place
 * model) never reach this table — `_resolve` routes them to `chunk-outline`
 * / `chunk-overlay` first. `fallback` is true when the resolved strategy is
 * not the desired visual (outline→overlay downgrade, or the bbox budget cap).
 * In 'overlay' mode the outline branch is NEVER taken — baked and unbaked
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
  if (ctx.meshCount <= ctx.maxMeshes) return { strategy: 'overlay', fallback };
  return { strategy: 'bbox', fallback: true };
}

/** Map a resolved strategy onto the PickMetrics vocabulary. */
function toMetricsStrategy(s: ResolvedStrategy): HighlightStrategy {
  if (s === 'chunk-outline') return 'outline';
  return s;
}

/** One fully invisible material shared by every chunk window proxy: draws no
 *  color, writes no depth — it exists for the OutlinePass mask pass only
 *  (same contract as the status-outline proxies). */
const CHUNK_PROXY_MATERIAL = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });

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

/** Wireframe mode: line opacity = the style's edge opacity × this (capped at 1). */
const WIREFRAME_HIGHLIGHT_OPACITY_GAIN = 1.5;

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

/**
 * The crease-edge geometry for a mesh geometry, from the SAME cache the hover
 * and selection overlays use — so an agent x-ray render (rv-eye-channels) and
 * the interactive highlight share one EdgesGeometry per source geometry and
 * draw identical lines. Threshold in degrees; the default is the highlight's.
 */
export function cachedEdgesGeometry(
  geometry: BufferGeometry, thresholdDeg: number = EDGE_THRESHOLD_DEG,
): EdgesGeometry {
  let edgeGeo = edgeGeometryCache.get(geometry);
  if (!edgeGeo) {
    edgeGeo = new EdgesGeometry(geometry, thresholdDeg);
    edgeGeometryCache.set(geometry, edgeGeo);
  }
  return edgeGeo;
}

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
      const edgeGeo = cachedEdgesGeometry(geometry, thresholdDeg);
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

  /**
   * Chunk highlight source (plan-753 Phase 3, strategy `chunk-outline`): a
   * baked placement's root or logic node is outlined through its chunk meshes
   * — whole chunks directly, node windows via pooled WRAPPER proxies with
   * their own `drawRange` (never the chunk geometry's, S1). No `EdgesGeometry`
   * is ever built for a placement.
   */
  private _chunkSource: ChunkHighlightSource | null = null;
  private _offChunkRelease: (() => void) | null = null;
  /** Free window proxies (attributes detached). */
  private readonly _chunkProxyPool: Mesh[] = [];
  /** Live window proxies per channel. */
  private _hoverChunkProxies: Mesh[] = [];
  private _selectionChunkProxies: Mesh[] = [];
  private _auxChunkProxies: Mesh[] = [];
  private _flashChunkProxies: Mesh[] = [];
  /** proxy → the chunk mesh whose matrixWorld it mirrors (per-frame sync). */
  private readonly _chunkProxySource = new WeakMap<Mesh, Mesh>();

  /** Roots currently on the selection outline channel (unioned with aux). */
  private _selectionOutlineRoots: Object3D[] = [];
  /** Aux roots currently rendered through the outline channel. */
  private _auxOutlineRoots: Object3D[] = [];
  /** Named aux emphasis sets (e.g. 'planner-ghost'). */
  private readonly _auxSets = new Map<string, AuxEmphasisSet>();
  /** Per-set fill/edge materials of the CURRENT aux application (sets with an
   *  own style only) — rebuilt by `_applyAux`, disposed before the next one. */
  private _auxSetMats: Array<{ fill: MeshBasicMaterial; edge: LineBasicMaterial }> = [];

  /** Active flash state, or null. */
  private _flashState: {
    until: number;
    fillMat: MeshBasicMaterial;
    edgeMat: LineBasicMaterial;
    disposeProxies: (() => void) | null;
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

  /**
   * Install the chunk highlight source (the viewer's `BakeRegistry`), or null
   * to remove it. Subscribes to instance release so every proxy over a
   * released placement leaves the scene BEFORE the asset may dispose its
   * geometry (provider before geometry, §4.2).
   */
  setChunkSource(source: ChunkHighlightSource | null): void {
    this._offChunkRelease?.();
    this._offChunkRelease = null;
    this._chunkSource = source;
    if (source) this._offChunkRelease = source.onRelease((inst) => this._onInstanceReleased(inst));
  }

  /** Free window proxies (test/diagnostic view). */
  get chunkProxyPoolSize(): number {
    return this._chunkProxyPool.length;
  }

  /** Live window proxies across all channels (test/diagnostic view). */
  get activeChunkProxies(): readonly Mesh[] {
    return [...this._hoverChunkProxies, ...this._selectionChunkProxies, ...this._auxChunkProxies, ...this._flashChunkProxies];
  }

  /** Objects for the OutlinePass channel: whole chunk meshes directly, node
   *  windows through pooled wrapper proxies (recorded in `into` for release). */
  private _chunkOutlineObjects(root: Object3D, into: Mesh[]): Object3D[] {
    const targets = this._chunkSource?.chunkTargetsOf(root);
    const out: Object3D[] = [];
    if (!targets) return out;
    for (const t of targets) {
      if (!t.range) { out.push(t.mesh); continue; }
      const proxy = this._acquireChunkProxy(t);
      into.push(proxy);
      out.push(proxy);
    }
    return out;
  }

  private _acquireChunkProxy(target: ChunkHighlightTarget): Mesh {
    let proxy = this._chunkProxyPool.pop();
    if (!proxy) {
      proxy = new Mesh(new BufferGeometry(), CHUNK_PROXY_MATERIAL);
      proxy.name = '__hlChunkProxy';
      proxy.matrixAutoUpdate = false;
      proxy.frustumCulled = false;
      proxy.castShadow = false;
      proxy.receiveShadow = false;
      proxy.raycast = () => {};
      proxy.userData._highlightOverlay = true;
      proxy.layers.set(NO_AO_LAYER);
    }
    // Wrapper geometry: shares the chunk's position + index, own drawRange.
    if (target.range) {
      makeRangeProxyGeometry(target.mesh.geometry, target.range, proxy.geometry);
    } else {
      // Whole chunk: full range, the chunk's own sphere.
      const src = target.mesh.geometry;
      const g = proxy.geometry;
      const pos = src.getAttribute('position');
      if (g.getAttribute('position') !== pos) g.setAttribute('position', pos);
      if (g.getIndex() !== src.index) g.setIndex(src.index);
      g.setDrawRange(0, Infinity);
      if (!src.boundingSphere) src.computeBoundingSphere();
      g.boundingSphere = (g.boundingSphere ?? new Sphere()).copy(src.boundingSphere!);
    }
    target.mesh.updateWorldMatrix(true, false);
    proxy.matrix.copy(target.mesh.matrixWorld);
    proxy.matrixWorld.copy(target.mesh.matrixWorld);
    this._chunkProxySource.set(proxy, target.mesh);
    this.scene.add(proxy);
    return proxy;
  }

  /**
   * Fill proxies for the overlay family (`chunk-overlay`, plan-753 Phase 4a):
   * one pooled wrapper per chunk target — a node window through
   * `makeRangeProxyGeometry`, a whole chunk through a full-range wrapper with
   * the chunk's own bounding sphere (no per-vertex sweep over a 7M-triangle
   * static chunk). The wrapper draws with the channel's overlay FILL material
   * on the highlight overlay layer, exactly where a legacy fill pair draws;
   * edges are not built (no `EdgesGeometry` outside the editor).
   */
  private _chunkOverlayObjects(root: Object3D, into: Mesh[], fillMat: MeshBasicMaterial, renderOrder: number): void {
    const targets = this._chunkSource?.chunkTargetsOf(root);
    if (!targets) return;
    for (const t of targets) {
      const proxy = this._acquireChunkProxy(t);
      proxy.material = fillMat;
      proxy.renderOrder = renderOrder;
      proxy.layers.set(HIGHLIGHT_OVERLAY_LAYER);
      proxy.userData._chunkFill = true;
      into.push(proxy);
    }
  }

  /** Undo the `chunk-overlay` styling so a pooled proxy is an invisible
   *  outline stand-in again. */
  private _resetChunkProxy(p: Mesh): void {
    if (!p.userData._chunkFill) return;
    delete p.userData._chunkFill;
    p.material = CHUNK_PROXY_MATERIAL;
    p.renderOrder = 0;
    p.layers.set(NO_AO_LAYER);
  }

  /** Return proxies to the pool (no dispose — the attributes are the chunk's). */
  private _releaseChunkProxies(list: Mesh[]): void {
    for (const p of list) {
      p.parent?.remove(p);
      this._resetChunkProxy(p);
      this._chunkProxyPool.push(p);
    }
    list.length = 0;
  }

  /** Detach a pooled/active proxy from chunk attributes it must not outlive. */
  private _detachChunkProxy(p: Mesh): void {
    p.geometry.deleteAttribute('position');
    p.geometry.setIndex(null);
    p.geometry.boundingSphere = null;
    this._chunkProxySource.delete(p);
  }

  /** Instance released: its proxies leave the scene now; when this was the
   *  asset's last instance, every wrapper over its chunks is detached too. */
  private _onInstanceReleased(inst: PlacementInstance): void {
    const chunkMeshes = new Set<Mesh>(inst.chunks);
    const chunkGeometries = new Set<BufferGeometry>();
    const lastInstance = inst.baked.instances <= 1;
    if (lastInstance) for (const c of inst.baked.chunks) chunkGeometries.add(c.geometry);
    const gone = new Set<Object3D>(inst.chunks);
    const scrub = (list: Mesh[]): void => {
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        const src = this._chunkProxySource.get(p);
        if (src && chunkMeshes.has(src)) {
          p.parent?.remove(p);
          if (lastInstance) this._detachChunkProxy(p);
          this._resetChunkProxy(p);
          this._chunkProxyPool.push(p);
          list.splice(i, 1);
          gone.add(p);
        }
      }
    };
    scrub(this._hoverChunkProxies);
    scrub(this._selectionChunkProxies);
    scrub(this._auxChunkProxies);
    scrub(this._flashChunkProxies);
    if (lastInstance) {
      for (const p of this._chunkProxyPool) {
        const pos = p.geometry.getAttribute('position');
        if (!pos) continue;
        for (const g of chunkGeometries) {
          if (g.getAttribute('position') === pos) { this._detachChunkProxy(p); break; }
        }
      }
    }
    // Drop released chunk meshes AND their window proxies from the outline channels.
    const prune = (arr: Object3D[]): Object3D[] => arr.filter((o) => !gone.has(o));
    this._selectionOutlineRoots = prune(this._selectionOutlineRoots);
    this._auxOutlineRoots = prune(this._auxOutlineRoots);
    this._pushSelectionOutline();
  }

  /** Per-frame: window proxies follow their (possibly moving) chunk mesh. */
  private _syncChunkProxies(list: Mesh[]): void {
    for (const p of list) {
      const src = this._chunkProxySource.get(p);
      if (!src) continue;
      p.matrix.copy(src.matrixWorld);
      p.matrixWorld.copy(src.matrixWorld);
    }
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

  /**
   * Wireframe view (asset editor, Shift+Z): hover and selection light up the
   * part's own wire lines instead of drawing a fill plus crease edges — the
   * overlay becomes a triangle wireframe in the style's EDGE colour and the
   * EdgesGeometry line mesh is skipped. Applies to every overlay style (mode
   * profile, per-call override, aux, flash). The caller re-applies the
   * selection afterwards; hover is dropped here.
   */
  setWireframeMode(on: boolean): void {
    if (this._wireframeMode === on) return;
    this._wireframeMode = on;
    this.clear();
    this._setHoverStyle(this._hoverStyle);
    this._setSelectionStyle(this._selectionStyle);
    this._overrideKey = '';
  }

  get wireframeMode(): boolean { return this._wireframeMode; }

  private _wireframeMode = false;

  private _buildOverlayMat(style: HighlightStyle, name: string): MeshBasicMaterial {
    if (this._wireframeMode) {
      // The fill opacity is tuned for a surface tint (0.1–0.2) and far too
      // faint for 1 px lines over the document's own wires — use the edge look.
      const opacity = Math.min(1, style.edgeOpacity * WIREFRAME_HIGHLIGHT_OPACITY_GAIN);
      const wire = new MeshBasicMaterial({
        color: style.edgeColor,
        transparent: opacity < 1.0,
        opacity,
        wireframe: true,
        depthTest: false,
        depthWrite: false,
      });
      wire.name = name;
      return wire;
    }
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
    // Baked placement root / logic node (plan-753): chunk outline when the
    // OutlinePass is available, bounding box otherwise — never per-mesh pairs.
    // Phase 4a: the HMI/DES profile (desired 'overlay') keeps its fill look
    // through window proxies over the chunk (`chunk-overlay`, no
    // EdgesGeometry); the planner's outline profile goes to the OutlinePass.
    if (this._chunkSource) {
      const targets = this._chunkSource.chunkTargetsOf(root);
      if (targets && targets.length > 0) {
        if (desired === 'outline' && this._useOutline()) return { strategy: 'chunk-outline', fallback: false };
        return { strategy: 'chunk-overlay', fallback: desired === 'outline' };
      }
    }
    return resolveStrategy({
      desired,
      outlineAvailable: this._useOutline(),
      hasRenderedMesh: meshes.some(isRenderedMesh),
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
        // Wireframe mode: the (wire) overlay IS the highlight — no edge mesh,
        // so no EdgesGeometry is built for it either.
        style.showOverlay || this._wireframeMode, style.showEdges && !this._wireframeMode,
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
      case 'chunk-outline':
        this._outlineManager!.setHoverOutlined(this._chunkOutlineObjects(root, this._hoverChunkProxies));
        return;
      case 'chunk-overlay':
        this._chunkOverlayObjects(root, this._hoverChunkProxies, this._hoverOverlayMat, 1000);
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
        case 'chunk-outline': outlineRoots.push(...this._chunkOutlineObjects(root, this._hoverChunkProxies)); break;
        case 'chunk-overlay':
          anyProxy = true;
          this._chunkOverlayObjects(root, this._hoverChunkProxies, this._hoverOverlayMat, 1000);
          break;
        default: overlayEntries.push({ root, meshes }); anyOverlay = true;
      }
    }

    if (outlineRoots.length > 0) {
      this._lastStrategy = 'outline';
      this._outlineManager!.setHoverOutlined(outlineRoots);
    } else if (anyProxy) {
      this._lastStrategy = 'chunk-overlay';
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
    if (anyOverlay) this._lastStrategy = anyBbox ? 'bbox' : 'overlay';
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
    this._releaseChunkProxies(this._hoverChunkProxies);
    this.hoverTracked = false;
    this._outlineManager?.clearHover();
  }

  /** Whether any hover highlight is currently active. */
  get isActive(): boolean {
    return this.hoverPairs.length > 0
      || this._hoverChunkProxies.length > 0
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
    performance.measure('rv:highlightSelection[' + this._lastStrategy + (this._lastFallback ? '+fallback' : '') + ']', { start: t0 });
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
    let anyBbox = false;
    for (const root of roots) {
      const meshes = this.collectMeshes(root, includeSensorViz, includeChildDrives);
      const { strategy, fallback } = this._resolve(root, meshes, desired);
      if (fallback) this._lastFallback = true;
      switch (strategy) {
        case 'outline': outlineRoots.push(root); break;
        case 'chunk-outline': outlineRoots.push(...this._chunkOutlineObjects(root, this._selectionChunkProxies)); break;
        case 'chunk-overlay':
          anyProxy = true;
          this._chunkOverlayObjects(root, this._selectionChunkProxies, mats.overlay, 900);
          break;
        case 'bbox':
          anyBbox = true;
          this._highlightBoundingBox(root, this.selectionPairs);
          break;
        default: overlayEntries.push({ root, meshes });
      }
    }

    if (outlineRoots.length > 0) {
      this._lastStrategy = 'outline';
      this._selectionOutlineRoots = outlineRoots;
      this._pushSelectionOutline();
    } else if (anyProxy) {
      this._lastStrategy = 'chunk-overlay';
    } else if (anyBbox) {
      this._lastStrategy = 'bbox';
      this.selectionTracked = true;
    }
    if (overlayEntries.length === 0) return;
    this._lastStrategy = 'overlay';
    this.selectionTracked = true;

    for (const { meshes } of overlayEntries) {
      this._buildPairs(meshes, this.selectionPairs, mats.overlay, mats.edge, style, 900, '_sel');
    }
  }

  /** Remove selection highlight overlays only. Hover and aux persist. */
  clearSelection(): void {
    this._builder.releasePairs(this.selectionPairs);
    this._releaseChunkProxies(this._selectionChunkProxies);
    this.selectionTracked = false;
    this._selectionOutlineRoots = [];
    this._pushSelectionOutline();
  }

  /** Whether any selection highlight is currently active. */
  get isSelectionActive(): boolean {
    return this.selectionPairs.length > 0
      || this._selectionChunkProxies.length > 0
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
  setAuxEmphasis(id: string, roots: readonly Object3D[] | null, opts?: AuxEmphasisOptions): void {
    if (!roots || roots.length === 0) {
      if (!this._auxSets.delete(id)) return; // nothing was shown — no rebuild
    } else {
      const style = opts?.color === undefined
        ? undefined
        : { ...this._selectionStyle, overlayColor: opts.color, edgeColor: opts.color };
      this._auxSets.set(id, { roots: [...roots], style });
    }
    this._applyAux();
  }

  private _applyAux(): void {
    // Release previous aux visuals (and the per-set materials that drew them).
    this._builder.releasePairs(this.auxPairs);
    this._releaseChunkProxies(this._auxChunkProxies);
    this._auxOutlineRoots = [];
    for (const m of this._auxSetMats) { m.fill.dispose(); m.edge.dispose(); }
    this._auxSetMats = [];

    if (this._catHidden || this._auxSets.size === 0) {
      this._pushSelectionOutline();
      return;
    }

    const desired = this._profile.visual;
    for (const [id, set] of this._auxSets) {
      // A set with an own color draws with its own fill/edge materials (the
      // selection look in that color — WebError's red X-ray overlay); the
      // outline channel stays the shared selection channel in every mode.
      let fillMat = this._selectionOverlayMat;
      let edgeMat = this._selectionEdgeMat;
      let style = this._selectionStyle;
      // The color IS the point of a colored set, and only the overlay family
      // carries one (the OutlinePass channel has the shared selection color):
      // a colored set draws fill + edges / chunk-overlay in EVERY profile,
      // outline profiles (planner, editor) included.
      let desiredForSet = desired;
      if (set.style) {
        style = set.style;
        fillMat = this._buildOverlayMat(style, `_auxOverlay:${id}`);
        edgeMat = this._buildEdgeMat(style);
        this._auxSetMats.push({ fill: fillMat, edge: edgeMat });
        desiredForSet = 'overlay';
      }
      for (const root of set.roots) {
        const meshes = this.collectMeshes(root, false);
        const { strategy } = this._resolve(root, meshes, desiredForSet);
        switch (strategy) {
          case 'outline':
            this._auxOutlineRoots.push(root);
            break;
          case 'chunk-outline':
            this._auxOutlineRoots.push(...this._chunkOutlineObjects(root, this._auxChunkProxies));
            break;
          case 'chunk-overlay':
            this._chunkOverlayObjects(root, this._auxChunkProxies, fillMat, 900);
            break;
          case 'bbox':
            this._highlightBoundingBox(root, this.auxPairs);
            break;
          default:
            this._buildPairs(meshes, this.auxPairs, fillMat, edgeMat, style, 900, '_aux');
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
      || this._auxChunkProxies.length > 0
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

    // Fill + edges on every root — the SAME rendering paths as hover: pooled
    // pairs on the source meshes (budget-capped so a mis-targeted flash on a
    // huge assembly can't build thousands of pairs).
    let budget = this.maxHoverMeshes;
    // Baked placements (plan-753): outline channel only, via chunk objects.
    const chunkOutlineObjects: Object3D[] = [];
    const plainRoots: Object3D[] = [];
    for (const root of roots) {
      const targets = this._chunkSource?.chunkTargetsOf(root);
      if (targets && targets.length > 0) {
        chunkOutlineObjects.push(...this._chunkOutlineObjects(root, this._flashChunkProxies));
        continue;
      }
      plainRoots.push(root);
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
      const resolved = resolveOutlineTargets(this.scene, plainRoots);
      disposeProxies = resolved.dispose;
      resolved.targets.push(...chunkOutlineObjects);
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
    };
  }

  /** Remove an active flash immediately. */
  clearFlash(): void {
    if (!this._flashState) return;
    this._builder.releasePairs(this.flashPairs);
    this._releaseChunkProxies(this._flashChunkProxies);
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
    // Chunk window proxies mirror their chunk mesh (mover chunks move).
    if (this._hoverChunkProxies.length > 0) this._syncChunkProxies(this._hoverChunkProxies);
    if (this._selectionChunkProxies.length > 0) this._syncChunkProxies(this._selectionChunkProxies);
    if (this._auxChunkProxies.length > 0) this._syncChunkProxies(this._auxChunkProxies);
    if (this._flashChunkProxies.length > 0) this._syncChunkProxies(this._flashChunkProxies);
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
    this._offChunkRelease?.();
    this._offChunkRelease = null;
    for (const p of this._chunkProxyPool) this._detachChunkProxy(p);
    this._chunkProxyPool.length = 0;
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
        !node.userData?._driveHoverOverlay &&
        !node.userData?._rvRaycastBVH &&
        // Chunk meshes of a baked placement are never overlay sources (plan-753:
        // `collectMeshes` covers keep meshes only there).
        !node.userData?.[RV_BAKE_CHUNK_KEY]
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

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GizmoOverlayManager — generic 3D overlay/gizmo system for the WebViewer.
 *
 * Provides standardized Shape-based overlays (box/transparent-shell/mesh-overlay/
 * sphere/sprite/text) that components can attach to any Object3D node. Used by
 * WebSensor and future components for per-state visualizations.
 *
 * Key characteristics:
 * - Shared material pool keyed by color+opacity+depthTest+blinkHz (text bypasses cache).
 * - Central tick() loop modulates blink on a per-material basis using a global phase.
 * - Subtree-aware AABB for all bounding shapes (box, transparent-shell, sphere).
 * - Multi-mesh overlay covers every isMesh descendant (non-Mesh filtered).
 * - Early-return in tick() when no entries exist (zero cost when unused).
 */

import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  EdgesGeometry,
  Group,
  Line,
  LineSegments,
  LineBasicMaterial,
  BackSide,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Material,
  type Texture,
} from 'three';
import { GizmoMaterialCache } from './rv-gizmo-material-cache';
import { computeSubtreeAABB, traverseMeshesWithDepth } from './rv-traverse-utils';
import { ISOLATE_FOCUS_LAYER, HIGHLIGHT_OVERLAY_LAYER } from './rv-group-registry';
import { NO_AO_LAYER } from './rv-constants';
import {
  subscribeOverlayVisibility, getHiddenOverlays,
  registerOverlayProducer, unregisterOverlayProducer,
  type OverlayCategory,
} from '../overlay-visibility-store';

// ─── Public Types ─────────────────────────────────────────────────────

/** Shapes supported by the gizmo system. */
export type GizmoShape =
  | 'box'
  | 'transparent-shell'
  | 'mesh-overlay'
  /** Wireframe outline of every Mesh descendant (EdgesGeometry → LineSegments).
   *  Same coverage as 'mesh-overlay' but as crisp edges instead of fill —
   *  useful when you want to highlight the real geometry of a small object
   *  (e.g. a CAD-imported sensor body). Cheap. */
  | 'mesh-edges'
  /** Inverted-hull outline of every Mesh descendant: each mesh gets a scaled-up
   *  back-side-only duplicate in the entry color. The original mesh renders
   *  normally on top, hiding the duplicate everywhere except at the silhouette
   *  → solid colored outline around the real geometry. Width is `outlineScale`
   *  (default 1.4 = 40 % thicker). Best for highlighting small objects from far. */
  | 'mesh-glow-hull'
  | 'sphere'
  /** Sphere outline only (EdgesGeometry → LineSegments). Crisp, cheap, no fill. */
  | 'sphere-edges'
  /** Sphere with outer "inverted hull" glow shell (back-faces only, slightly larger,
   *  semi-transparent). Classic cartoon-style outline glow. Renders 2 meshes. */
  | 'sphere-glow-hull'
  | 'sprite'
  | 'text'
  | 'floor-disk'
  /** Connection "cable" between two nodes (plan-259): a dedicated 2-point
   *  BufferGeometry Line. Endpoints are updated PER FRAME by the owner via
   *  {@link GizmoOverlayManager.updateLinkLine} — position writes + one
   *  needsUpdate flag, never a rebuild/dispose per frame (no GC). */
  | 'link-line';

/** Options for creating or updating a gizmo. */
export interface GizmoOptions {
  shape: GizmoShape;
  /** 0xRRGGBB color. For 'text' shape this is the text color. */
  color: number;
  /** 0..1 */
  opacity: number;
  /** 0 = no blink; >0 = Hz */
  blinkHz?: number;
  /** Default 1.0. For 'text': world-unit scale multiplier. */
  size?: number;
  /** Default true */
  visible?: boolean;
  /** Default 10 (text defaults to 11, always on top) */
  renderOrder?: number;
  /** Default true (text defaults to false → always readable) */
  depthTest?: boolean;
  /** Required when shape='text' */
  text?: string;
  /** World-units above subtree-top. Default 0.15 × subtree height (min 0.1). */
  textOffsetY?: number;
  /** For shape='text' only — anchor point for textOffsetY.
   *  'top' (default) → position = bbox.max.y + textOffsetY (label sits above the object)
   *  'bottom'        → position = bbox.min.y + textOffsetY (label sits at/near the floor) */
  textAnchor?: 'top' | 'bottom';
  /** For shape='floor-disk' only — radius in world meters. Default = half of subtree XZ diagonal. */
  radius?: number;
  /** For shape='mesh-edges' only — EdgesGeometry threshold angle in degrees: an
   *  edge is drawn only where adjacent face normals diverge by more than this.
   *  Default 30 (matches the hover/selection highlight silhouette — crisp
   *  feature edges instead of a dense facet wireframe on curved parts).
   *  Create-time only; not updatable via handle.update(). */
  edgeThresholdDeg?: number;
  /** Optional emissive intensity for shape='sphere'. When > 0, the sphere uses a
   *  MeshStandardMaterial with `emissive: color, emissiveIntensity` so it glows
   *  through the existing UnrealBloomPass (when bloom is enabled). 0 / undefined
   *  → MeshBasicMaterial (flat color, no glow). Cache key includes this value. */
  emissiveIntensity?: number;
  /** For shape='sphere-glow-hull' only — multiplier for the outer hull radius
   *  relative to the inner sphere. 1.2 = subtle glow, 2.0 = thick halo. Default 1.4. */
  outlineScale?: number;
  /** For shape='sprite' only — custom texture (e.g. a CanvasTexture with an
   *  icon). Overrides the default white-circle bitmap. The texture is NOT
   *  disposed by GizmoOverlayManager (it may be shared) — owner manages
   *  its lifetime. */
  spriteTexture?: Texture;
  /** Fixed world-meter size that overrides AABB-relative sizing. Required for
   *  sprite gizmos attached to dimensionless Empty/anchor nodes (whose
   *  `cachedSize` is 0). Applied as `sprite.scale.setScalar(worldSize)`. */
  worldSize?: number;
  /** When true, the gizmo root is parented under `node` instead of the scene
   *  root. The gizmo then inherits the node's world transform, so moving the
   *  owner moves the gizmo. Default false (legacy: gizmo is positioned once
   *  at the node's world center and stays there). */
  attachToNode?: boolean;
  /** When true, the gizmo is NOT registered as an auxiliary raycast target.
   *  Default false — gizmos auto-register so that hover/click on the gizmo
   *  resolves to the owner node. Use this for markers that must not steal
   *  hover from the underlying scene (e.g. snap-point indicators). */
  excludeFromRaycast?: boolean;
  /** When set, the gizmo's root mesh gets `userData[userDataMarker] = true`
   *  after construction. Lets click/raycast listeners identify gizmos they
   *  own without keeping a separate id map. The marker is also set on every
   *  overlay mesh for shapes with per-descendant overlays. */
  userDataMarker?: string;
  /** Override the auxiliary raycast owner. By default the owner is `node`
   *  (the gizmo's attachment node), so a hit on the gizmo resolves to it.
   *  Some scenarios need a DIFFERENT owner — e.g. a sprite anchored to a
   *  snap-point empty inside a placed component, where the planner's
   *  allow-filter rejects the snap-empty (no `_layoutId`) but accepts the
   *  placed root. Pass the placed root here so the hit resolution passes
   *  the filter and the click event reports the right node. */
  auxOwner?: Object3D;
  /** Keep this gizmo INSIDE the EffectComposer's main pass instead of moving it
   *  to the on-top overlay layer.
   *
   *  By default a gizmo is tagged onto HIGHLIGHT_OVERLAY_LAYER so it is excluded
   *  from the GTAO/N8AO depth pass (no SSAO halos) and re-rendered on top after
   *  the composer. Set this true when the gizmo must stay in the composer —
   *  e.g. it needs UnrealBloom glow (auto-true when `emissiveIntensity > 0`) or
   *  it must be occluded by closer scene geometry. Such gizmos render with the
   *  scene and therefore still contribute to SSAO. */
  keepInComposer?: boolean;
  /** Overlay-visibility category (plan-250). When set, this gizmo registers as
   *  a producer of the category and is hidden whenever the user switches the
   *  category off in the Display panel — on top of its own `visible` flag. */
  category?: OverlayCategory;
  /** For shape='link-line' only — the second endpoint node. The FIRST endpoint
   *  is the gizmo's own `node`. Required for link-line. */
  linkTo?: Object3D;
}

/** Handle returned when a gizmo is created. */
export interface GizmoHandle {
  readonly id: string;
  /** The top-level gizmo Object3D (Sprite / Mesh / Group) added to the scene
   *  graph. Exposed so callers can apply per-frame transforms (e.g. constant
   *  screen-space sprite scaling), read-only by convention. */
  readonly root: Object3D;
  update(opts: Partial<GizmoOptions>): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

// ─── Internal types ───────────────────────────────────────────────────

interface GizmoEntry {
  id: string;
  node: Object3D;
  /** Top-level root object added to scene/parent (LineSegments | Mesh | Sprite | Group). */
  root: Object3D;
  /** For 'mesh-overlay': per-descendant overlay meshes (shared geometry + material). */
  overlayMeshes: Mesh[];
  shape: GizmoShape;
  /** Base color (for update preservation). */
  color: number;
  /** Base opacity (for blink modulation restore). */
  baseOpacity: number;
  blinkHz: number;
  depthTest: boolean;
  /** Shared or dedicated material handle (text is dedicated). */
  material: Material | LineBasicMaterial | MeshBasicMaterial | SpriteMaterial;
  visible: boolean;
  /** If gizmo is a 'text' shape, keep texture for dispose and swap on text-change. */
  texture?: Texture;
  text?: string;
  size: number;
  renderOrder: number;
  /** Text offset relative to subtree AABB (world-Y). */
  textOffsetY?: number;
  /** Text anchor (top/bottom). Default 'top'. */
  textAnchor?: 'top' | 'bottom';
  /** Floor-disk radius in world meters. */
  radius?: number;
  /** 'mesh-edges' only: EdgesGeometry threshold angle in degrees. */
  edgeThresholdDeg: number;
  /** Emissive intensity for sphere shape (>0 → MeshStandardMaterial; 0 → MeshBasic). */
  emissiveIntensity: number;
  /** Hull-scale multiplier for 'sphere-glow-hull' shape. */
  outlineScale: number;
  /** Cached subtree AABB (computed once at create). */
  cachedAABB: Box3;
  cachedSize: Vector3;
  cachedCenter: Vector3;
  /** Optional caller-supplied sprite texture (kept for dispose semantics: NOT
   *  owned by the manager). */
  spriteTextureExternal?: Texture;
  /** Fixed world-meter size override (sprites attached to Empty nodes). */
  worldSize?: number;
  /** Whether the root was parented under `node` instead of the scene root. */
  attachToNode: boolean;
  /** Whether auto-raycast registration was skipped. */
  excludeFromRaycast: boolean;
  /** Optional `userData` flag name set on the gizmo's mesh(es) after build. */
  userDataMarker?: string;
  /** Optional override for the auxiliary raycast owner. Defaults to `node`. */
  auxOwner?: Object3D;
  /** When true the gizmo stays in the composer (bloom / depth-occlusion) and is
   *  NOT moved to the overlay layer. Auto-true for emissive (bloom) gizmos. */
  keepInComposer: boolean;
  /** Overlay-visibility category (plan-250) or undefined if uncategorized. */
  category?: OverlayCategory;
  /** link-line only: the second endpoint node (first = entry.node). */
  linkTo?: Object3D;
  /** link-line only: the dedicated 2-point geometry (disposed with the entry). */
  linkGeometry?: BufferGeometry;
}

// ─── Shared geometry cache ─────────────────────────────────────────────

let _sharedBoxGeometry: BoxGeometry | null = null;
let _sharedSphereGeometry: SphereGeometry | null = null;
let _sharedEdgesGeometry: EdgesGeometry | null = null;
let _sharedSphereEdgesGeometry: EdgesGeometry | null = null;
let _sharedDiskGeometry: CylinderGeometry | null = null;

function getBoxGeometry(): BoxGeometry {
  if (!_sharedBoxGeometry) _sharedBoxGeometry = new BoxGeometry(1, 1, 1);
  return _sharedBoxGeometry;
}

function getSphereGeometry(): SphereGeometry {
  if (!_sharedSphereGeometry) _sharedSphereGeometry = new SphereGeometry(0.5, 16, 12);
  return _sharedSphereGeometry;
}

function getEdgesGeometry(): EdgesGeometry {
  if (!_sharedEdgesGeometry) _sharedEdgesGeometry = new EdgesGeometry(getBoxGeometry());
  return _sharedEdgesGeometry;
}

/** Unit-radius flat disk (radius=1, height=0.001m). Scaled per instance. */
function getDiskGeometry(): CylinderGeometry {
  if (!_sharedDiskGeometry) _sharedDiskGeometry = new CylinderGeometry(1, 1, 0.001, 32);
  return _sharedDiskGeometry;
}

// ─── Constants ─────────────────────────────────────────────────────────

const BLINK_LOW_MULT = 0.3;
const MAX_OVERLAY_DEPTH = 5;

/** Default 'mesh-edges' threshold (degrees) — same angle the hover/selection
 *  highlight uses, so both render the same crisp silhouette edges. */
const DEFAULT_MESH_EDGES_THRESHOLD_DEG = 30;

/** EdgesGeometry cache for 'mesh-edges', keyed by source geometry → threshold.
 *  Mirrors the RVHighlightManager edge cache: repeated highlights of the same
 *  target reuse the once-computed edges instead of building (and leaking) a new
 *  EdgesGeometry per create — entries free themselves when the source geometry
 *  is garbage-collected. */
const _meshEdgesCache = new WeakMap<BufferGeometry, Map<number, EdgesGeometry>>();

function getCachedMeshEdges(geometry: BufferGeometry, thresholdDeg: number): EdgesGeometry {
  let perThreshold = _meshEdgesCache.get(geometry);
  if (!perThreshold) {
    perThreshold = new Map();
    _meshEdgesCache.set(geometry, perThreshold);
  }
  let edges = perThreshold.get(thresholdDeg);
  if (!edges) {
    edges = new EdgesGeometry(geometry, thresholdDeg);
    perThreshold.set(thresholdDeg, edges);
  }
  return edges;
}

// ─── Helpers ───────────────────────────────────────────────────────────

/** Create/render a text sprite with a stroked text glyph (no background panel). */
function makeTextCanvas(text: string, color: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const padding = 8;
  const fontSize = 28;
  const strokeWidth = 4;
  const font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const textWidth = Math.ceil(metrics.width);
  const textHeight = fontSize;
  canvas.width = textWidth + padding * 2;
  canvas.height = textHeight + padding * 2;

  const ctx2 = canvas.getContext('2d')!;
  ctx2.font = font;
  ctx2.textBaseline = 'middle';
  ctx2.textAlign = 'left';

  // Dark stroke around each glyph for readability against any background —
  // replaces the older rounded-rect panel that showed up as a shadow halo.
  ctx2.lineWidth = strokeWidth;
  ctx2.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx2.lineJoin = 'round';
  ctx2.miterLimit = 2;
  ctx2.strokeText(text, padding, canvas.height / 2 + 1);

  // Text fill color on top of the stroke
  const hex = color.toString(16).padStart(6, '0');
  ctx2.fillStyle = `#${hex}`;
  ctx2.fillText(text, padding, canvas.height / 2 + 1);

  return canvas;
}

// ─── GizmoOverlayManager ───────────────────────────────────────────────

export class GizmoOverlayManager {
  private _entries = new Map<string, GizmoEntry>();
  /** Shared material cache (refcounted) + blink-tracking entries.
   *  Tests reach into this field via `(mgr as any)._cache.size` — keep the
   *  public surface (`size`, `values()`) stable. */
  private _cache = new GizmoMaterialCache();
  private _nodeToIds = new Map<Object3D, Set<string>>();
  private _idCounter = 0;
  private _globalVisible = true;
  private _shapeOverride: GizmoShape | null = null;
  private _tagFilter: string | null = null;
  /** User-hidden overlay categories (plan-250). Kept in sync via the store
   *  subscription; consulted in `_shouldBeVisible`. */
  private _hiddenCategories: ReadonlySet<OverlayCategory> = getHiddenOverlays();
  /** Unsubscribe from the overlay-visibility store. Set up ONCE in the ctor and
   *  torn down ONLY in `destroy()` (final viewer teardown) — NOT in `dispose()`,
   *  which runs on every model switch. */
  private _unsubscribeOverlay: () => void;

  // Preallocated temps (no GC)
  private _tmpV = new Vector3();

  /**
   * @param scene  Three.js Scene that gizmos are added to.
   * @param raycastManagerGetter  Optional lazy getter for the raycast manager.
   *   When the getter returns a manager, every gizmo created is automatically
   *   registered as an auxiliary raycast target whose hit resolves to the owning
   *   node — i.e. hovering/clicking the visible gizmo behaves exactly like
   *   hovering/clicking the underlying node, even if the underlying mesh is
   *   small or absent. Cleanup is automatic on gizmo dispose / clearNode.
   *   Lazy form is used because RaycastManager is created later than
   *   GizmoOverlayManager during RVViewer setup.
   */
  constructor(
    private readonly scene: Object3D,
    private readonly raycastManagerGetter?: () => {
      addAuxRaycastTarget(mesh: Object3D, owner: Object3D): void;
      removeAuxRaycastTarget(mesh: Object3D): void;
    } | null,
  ) {
    // Overlay-category subscription lives for the manager's whole life (the
    // manager is a per-viewer singleton). On any category toggle, re-apply
    // visibility to every current entry. NOT unsubscribed in dispose().
    this._unsubscribeOverlay = subscribeOverlayVisibility(() => {
      this._hiddenCategories = getHiddenOverlays();
      for (const entry of this._entries.values()) {
        entry.root.visible = this._shouldBeVisible(entry);
      }
    });
  }

  private get raycastManager(): {
    addAuxRaycastTarget(mesh: Object3D, owner: Object3D): void;
    removeAuxRaycastTarget(mesh: Object3D): void;
  } | null {
    return this.raycastManagerGetter?.() ?? null;
  }

  /** Re-register ALL existing gizmos as auxiliary raycast targets. Call this
   *  after the raycast manager is created (e.g. RaycastManager is created
   *  later in RVViewer's lifecycle than this manager — gizmos created before
   *  that point are not yet hoverable). Idempotent. */
  refreshAuxRaycastTargets(): void {
    const rm = this.raycastManager;
    if (!rm) return;
    for (const entry of this._entries.values()) {
      if (entry.shape === 'box') continue;
      if (entry.excludeFromRaycast) continue;
      if (entry.overlayMeshes.length > 0) {
        for (const m of entry.overlayMeshes) rm.addAuxRaycastTarget(m, entry.node);
      } else {
        rm.addAuxRaycastTarget(entry.root, entry.node);
      }
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────

  create(node: Object3D, opts: GizmoOptions): GizmoHandle {
    const id = `gz_${++this._idCounter}`;
    const effectiveShape = this._shapeOverride ?? opts.shape;
    const blinkHz = opts.blinkHz ?? 0;
    const depthTest = opts.depthTest ?? (effectiveShape === 'text' ? false : true);
    const renderOrder = opts.renderOrder ?? (effectiveShape === 'text' ? 11 : 10);
    const size = opts.size ?? 1.0;
    const baseOpacity = Math.max(0, Math.min(1, opts.opacity));

    const { box, size: subSize, center } = computeSubtreeAABB(node);

    const entry: GizmoEntry = {
      id,
      node,
      // Will be filled per shape factory
      root: new Group(),
      overlayMeshes: [],
      shape: effectiveShape,
      color: opts.color,
      baseOpacity,
      blinkHz,
      depthTest,
      material: null as unknown as Material,
      visible: opts.visible !== false,
      text: opts.text,
      size,
      renderOrder,
      textOffsetY: opts.textOffsetY,
      textAnchor: opts.textAnchor,
      radius: opts.radius,
      edgeThresholdDeg: opts.edgeThresholdDeg ?? DEFAULT_MESH_EDGES_THRESHOLD_DEG,
      emissiveIntensity: Math.max(0, opts.emissiveIntensity ?? 0),
      // Bloom gizmos need UnrealBloom (inside the composer) to glow → they can't
      // be moved to the post-composer overlay layer without losing the look.
      // Detected from: explicit opt, a non-zero initial emissive, OR a glow-hull
      // shape (these toggle emissive on/off over their lifetime — e.g. WebSensor
      // states — so they must stay composer-resident even while emissive is 0).
      keepInComposer:
        opts.keepInComposer === true ||
        (opts.emissiveIntensity ?? 0) > 0 ||
        effectiveShape === 'mesh-glow-hull' ||
        effectiveShape === 'sphere-glow-hull',
      outlineScale: Math.max(1.01, opts.outlineScale ?? 1.4),
      cachedAABB: box,
      cachedSize: subSize,
      cachedCenter: center,
      spriteTextureExternal: opts.spriteTexture,
      worldSize: opts.worldSize,
      attachToNode: opts.attachToNode === true,
      excludeFromRaycast: opts.excludeFromRaycast === true,
      userDataMarker: opts.userDataMarker,
      auxOwner: opts.auxOwner,
      category: opts.category,
      linkTo: opts.linkTo,
    };

    this._buildShape(entry);

    // Apply initial visibility (also considering global filters)
    entry.root.visible = this._shouldBeVisible(entry);

    // Overlay-visibility presence (plan-250): count this gizmo as a live
    // producer of its category (drives the Display panel's category list).
    if (entry.category) registerOverlayProducer(entry.category);

    this._entries.set(id, entry);
    let ids = this._nodeToIds.get(node);
    if (!ids) {
      ids = new Set();
      this._nodeToIds.set(node, ids);
    }
    ids.add(id);

    const handle: GizmoHandle = {
      id,
      root: entry.root,
      update: (partial) => this._updateEntry(entry, partial),
      setVisible: (v) => this._setEntryVisible(entry, v),
      dispose: () => this._disposeEntry(entry),
    };
    return handle;
  }

  clearNode(node: Object3D): void {
    const ids = this._nodeToIds.get(node);
    if (!ids) return;
    for (const id of Array.from(ids)) {
      const e = this._entries.get(id);
      if (e) this._disposeEntry(e);
    }
  }

  setGlobalVisibility(visible: boolean): void {
    this._globalVisible = visible;
    for (const entry of this._entries.values()) {
      entry.root.visible = this._shouldBeVisible(entry);
    }
  }

  setGlobalShapeOverride(shape: GizmoShape | null): void {
    if (this._shapeOverride === shape) return;
    this._shapeOverride = shape;
    // For each entry: if its current shape != override, rebuild
    for (const entry of this._entries.values()) {
      const target = shape ?? entry.shape;
      if (entry.shape === target) continue;
      // Preserve visual parameters
      const color = entry.color;
      const baseOpacity = entry.baseOpacity;
      const blinkHz = entry.blinkHz;
      const depthTest = entry.depthTest;
      const size = entry.size;
      const renderOrder = entry.renderOrder;
      const text = entry.text;
      const textOffsetY = entry.textOffsetY;

      this._disposeEntryVisuals(entry);
      entry.shape = target;
      // Text is special: re-derive depthTest/renderOrder defaults
      entry.color = color;
      entry.baseOpacity = baseOpacity;
      entry.blinkHz = blinkHz;
      entry.depthTest = depthTest;
      entry.size = size;
      entry.renderOrder = renderOrder;
      entry.text = text;
      entry.textOffsetY = textOffsetY;
      this._buildShape(entry);
      entry.root.visible = this._shouldBeVisible(entry);
    }
  }

  setTagFilter(tag: string | null): void {
    this._tagFilter = tag;
    for (const entry of this._entries.values()) {
      entry.root.visible = this._shouldBeVisible(entry);
    }
  }

  /** Per-frame blink tick — called directly from RVViewer.fixedUpdate.
   *  Returns true when at least one material opacity was written this tick,
   *  so the caller can mark the render dirty (a blink phase flip must produce
   *  a redraw even under the on-demand render loop). */
  tick(_elapsedMs: number): boolean {
    if (this._entries.size === 0) return false;
    const t = performance.now();
    let changed = false;
    for (const meta of this._cache.values()) {
      if (meta.blinkHz <= 0) continue;
      const phase = Math.sin(2 * Math.PI * meta.blinkHz * t / 1000) > 0 ? 'on' : 'off';
      if (phase === meta.lastPhase) continue;
      meta.lastPhase = phase;
      const mat = meta.material as MeshBasicMaterial | LineBasicMaterial;
      const baseOp = meta.baseOpacity;
      (mat as { opacity: number }).opacity =
        phase === 'on' ? baseOp : baseOp * BLINK_LOW_MULT;
      changed = true;
    }
    return changed;
  }

  dispose(): void {
    for (const entry of Array.from(this._entries.values())) {
      this._disposeEntry(entry);
    }
    this._entries.clear();
    this._nodeToIds.clear();
    this._cache.clear();
  }

  /** Final teardown (plan-250): dispose entries AND unsubscribe from the
   *  overlay-visibility store. Call this ONLY at true viewer teardown — the
   *  per-model `dispose()` must NOT drop the subscription (it runs on every
   *  model switch, which would leave later models unresponsive to toggles). */
  destroy(): void {
    this.dispose();
    this._unsubscribeOverlay();
  }

  // ─── Shape factories ────────────────────────────────────────────────

  private _buildShape(entry: GizmoEntry): void {
    switch (entry.shape) {
      case 'box':
        this._buildBox(entry);
        break;
      case 'transparent-shell':
        this._buildTransparentShell(entry);
        break;
      case 'mesh-overlay':
        this._buildMeshOverlay(entry);
        break;
      case 'sphere':
        this._buildSphere(entry);
        break;
      case 'sphere-edges':
        this._buildSphereEdges(entry);
        break;
      case 'sphere-glow-hull':
        this._buildSphereGlowHull(entry);
        break;
      case 'mesh-edges':
        this._buildMeshEdges(entry);
        break;
      case 'mesh-glow-hull':
        this._buildMeshGlowHull(entry);
        break;
      case 'sprite':
        this._buildSprite(entry);
        break;
      case 'text':
        this._buildText(entry);
        break;
      case 'floor-disk':
        this._buildFloorDisk(entry);
        break;
      case 'link-line':
        this._buildLinkLine(entry);
        break;
    }

    entry.root.userData._rvGizmo = true;
    entry.root.userData._rvGizmoId = entry.id;
    entry.root.renderOrder = entry.renderOrder;
    // Optional caller-supplied identification marker. Set on the gizmo root
    // and every per-descendant overlay so click/raycast listeners can match
    // their own gizmos via `node.userData[marker]`.
    if (entry.userDataMarker) {
      entry.root.userData[entry.userDataMarker] = true;
      for (const ov of entry.overlayMeshes) ov.userData[entry.userDataMarker] = true;
    }
    // Layer assignment controls how the gizmo interacts with SSAO. GTAOPass
    // builds its own depth+normal gbuffer with an override material, so a
    // gizmo's `depthWrite:false` does NOT keep it out of SSAO — only the
    // camera layer mask does (see OVERLAY_LAYERS in rv-group-registry).
    if (entry.keepInComposer) {
      // Bloom / depth-occlusion gizmos stay in the composer's main RenderPass so
      // they keep UnrealBloom and depth-occlusion. Put them on NO_AO_LAYER (the
      // real camera renders that layer; the AO clone camera excludes it) so they
      // no longer cast SSAO halos — fixes WebSensor glow + snap-chain preview.
      // Also enable ISOLATE_FOCUS_LAYER so they render crisp in isolate pass 3.
      entry.root.traverse((o) => {
        o.layers.set(NO_AO_LAYER);
        o.layers.enable(ISOLATE_FOCUS_LAYER);
      });
    } else {
      // Default: move the gizmo onto the on-top overlay layer so it is pulled
      // OUT of the GTAO/N8AO pass (no SSAO halos) and re-rendered above the
      // composer output (rv-viewer `_renderOverlayLayers` / isolate pass 4).
      // `set` removes layer 0 — the gizmo renders ONLY in the overlay pass,
      // which is exactly how highlights and the planner FloorGizmo behave.
      entry.root.traverse((o) => o.layers.set(HIGHLIGHT_OVERLAY_LAYER));
    }

    // Auto-register as auxiliary raycast targets so hover/click on the gizmo
    // resolves to the underlying owner node — works for sphere, transparent-shell,
    // sprite, text, floor-disk, mesh-overlay (per-mesh). Skipped for box
    // (wireframe is hard to hit anyway) and for entries opting out via
    // `excludeFromRaycast` (e.g. snap-point markers that must not steal hover).
    if (this.raycastManager && entry.shape !== 'box' && !entry.excludeFromRaycast) {
      const owner = entry.auxOwner ?? entry.node;
      if (entry.overlayMeshes.length > 0) {
        for (const m of entry.overlayMeshes) this.raycastManager.addAuxRaycastTarget(m, owner);
      } else {
        this.raycastManager.addAuxRaycastTarget(entry.root, owner);
      }
    }
  }

  private _buildBox(entry: GizmoEntry): void {
    const mat = this._getOrCreateLineMaterial(entry);
    const lines = new LineSegments(getEdgesGeometry(), mat);
    lines.renderOrder = entry.renderOrder;

    if (entry.attachToNode) {
      // Parent under the node so the box follows the asset's transform (e.g.
      // a conveyor moved/rotated in the planner). cachedCenter/cachedSize are
      // in WORLD space — convert into the node's local frame: position via
      // worldToLocal, size divided by the node's world scale.
      entry.node.updateWorldMatrix(true, false);
      const localCenter = entry.node.worldToLocal(entry.cachedCenter.clone());
      const ws = entry.node.getWorldScale(this._tmpV);
      lines.position.copy(localCenter);
      lines.scale.set(
        (entry.cachedSize.x / (ws.x || 1)) * entry.size,
        (entry.cachedSize.y / (ws.y || 1)) * entry.size,
        (entry.cachedSize.z / (ws.z || 1)) * entry.size,
      );
      entry.node.add(lines);
    } else {
      lines.position.copy(entry.cachedCenter);
      lines.scale.copy(entry.cachedSize).multiplyScalar(entry.size);
      this.scene.add(lines);
    }

    entry.root = lines;
    entry.material = mat;
  }

  private _buildTransparentShell(entry: GizmoEntry): void {
    const mat = this._getOrCreateMeshMaterial(entry);
    const mesh = new Mesh(getBoxGeometry(), mat);
    mesh.position.copy(entry.cachedCenter);
    mesh.scale.copy(entry.cachedSize).multiplyScalar(entry.size);
    mesh.renderOrder = entry.renderOrder;
    entry.root = mesh;
    entry.material = mat;
    this.scene.add(mesh);
  }

  private _buildMeshOverlay(entry: GizmoEntry): void {
    const group = new Group();
    const mat = this._getOrCreateMeshMaterial(entry);
    traverseMeshesWithDepth(
      entry.node,
      MAX_OVERLAY_DEPTH,
      (asMesh) => {
        if ((asMesh as { userData?: Record<string, unknown> }).userData?._rvGizmo) return;
        const overlay = new Mesh(asMesh.geometry, mat);
        overlay.userData._rvGizmoOverlay = true;
        // Match world-transform of the source mesh
        asMesh.updateWorldMatrix(true, false);
        overlay.position.setFromMatrixPosition(asMesh.matrixWorld);
        overlay.quaternion.setFromRotationMatrix(asMesh.matrixWorld);
        const scl = new Vector3();
        asMesh.matrixWorld.decompose(new Vector3(), overlay.quaternion, scl);
        overlay.scale.copy(scl);
        overlay.renderOrder = entry.renderOrder;
        group.add(overlay);
        entry.overlayMeshes.push(overlay);
      },
      '[GizmoOverlayManager] mesh-overlay',
    );
    entry.root = group;
    entry.material = mat;
    this.scene.add(group);
  }

  /** Wireframe edges of every Mesh descendant — same coverage as mesh-overlay
   *  but rendered as LineSegments(EdgesGeometry). Cheap, crisp outline. */
  private _buildMeshEdges(entry: GizmoEntry): void {
    const group = new Group();
    const lineMat = this._getOrCreateLineMaterial(entry);
    traverseMeshesWithDepth(
      entry.node,
      MAX_OVERLAY_DEPTH,
      (m) => {
        if (m.userData?._rvGizmo) return;
        const edges = getCachedMeshEdges(m.geometry, entry.edgeThresholdDeg);
        const lines = new LineSegments(edges, lineMat);
        m.updateWorldMatrix(true, false);
        lines.position.setFromMatrixPosition(m.matrixWorld);
        lines.quaternion.setFromRotationMatrix(m.matrixWorld);
        const scl = new Vector3();
        m.matrixWorld.decompose(new Vector3(), lines.quaternion, scl);
        lines.scale.copy(scl);
        lines.renderOrder = entry.renderOrder;
        group.add(lines);
        // Cached EdgesGeometry is shared across entries — never disposed here.
        entry.overlayMeshes.push(lines as unknown as Mesh);
      },
      '[GizmoOverlayManager] mesh-edges',
    );
    entry.root = group;
    entry.material = lineMat;
    this.scene.add(group);
  }

  /** Inverted-hull outline of every Mesh descendant — solid colored "shell"
   *  scaled by `outlineScale`. Rendered with positive polygonOffset so it
   *  appears BEHIND the original mesh in the depth buffer; only the silhouette
   *  ring (where the hull extends beyond the original mesh) is visible.
   *
   *  Material is opaque (not transparent) so it renders BEFORE transparent
   *  geometry and BEFORE-or-WITH opaque sensor meshes — front-to-back order
   *  by depth. The polygonOffset pushes its depth backwards so the original
   *  mesh wins the depth test where they overlap. */
  private _buildMeshGlowHull(entry: GizmoEntry): void {
    const group = new Group();
    const hullMat = new MeshBasicMaterial({
      color: entry.color,
      // TRANSPARENT (even at high opacity) so it lives in the transparent pass
      // — required for blink-by-opacity to work, and forces the hull to render
      // AFTER opaque sensor meshes which already wrote their depth.
      transparent: true,
      opacity: entry.baseOpacity,
      depthWrite: false,
      depthTest: entry.depthTest,
      // Positive polygonOffset → hull's depth value is pushed AWAY from camera,
      // so where hull and sensor overlap, the sensor's depth (already in buffer
      // from opaque pass) wins → hull is culled inside the sensor silhouette.
      // The ring around the sensor (where there is no sensor depth) renders.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 4,
    });
    traverseMeshesWithDepth(
      entry.node,
      MAX_OVERLAY_DEPTH,
      (m) => {
        if (m.userData?._rvGizmo) return;
        const hull = new Mesh(m.geometry, hullMat);
        hull.userData._rvGizmoOverlay = true;
        m.updateWorldMatrix(true, false);
        hull.position.setFromMatrixPosition(m.matrixWorld);
        hull.quaternion.setFromRotationMatrix(m.matrixWorld);
        const scl = new Vector3();
        m.matrixWorld.decompose(new Vector3(), hull.quaternion, scl);
        scl.multiplyScalar(entry.outlineScale);
        hull.scale.copy(scl);
        // Force render BEFORE every other opaque mesh so it always paints first
        // (the original sensor mesh draws on top in its normal order).
        hull.renderOrder = -1;
        group.add(hull);
        entry.overlayMeshes.push(hull);
      },
      '[GizmoOverlayManager] mesh-glow-hull',
    );
    entry.root = group;
    entry.material = hullMat;
    // Register the dedicated hull material in the cache with a unique key so
    // the central blink tick() picks it up and modulates opacity.
    if (entry.blinkHz > 0) this._registerDedicatedBlinker(entry, hullMat);
    this.scene.add(group);
  }

  /** Add a dedicated (non-shared) material to the blink-tracking map so that
   *  the central tick() loop modulates its opacity. Used by hull/sprite/etc.
   *  materials that aren't in the shared material cache. */
  private _registerDedicatedBlinker(entry: GizmoEntry, mat: MeshBasicMaterial | SpriteMaterial): void {
    this._cache.registerDedicated(`dedicated_${entry.id}`, mat, entry.baseOpacity, entry.blinkHz);
  }

  private _buildSphere(entry: GizmoEntry): void {
    const mat = entry.emissiveIntensity > 0
      ? this._getOrCreateEmissiveMaterial(entry)
      : this._getOrCreateMeshMaterial(entry);
    const mesh = new Mesh(getSphereGeometry(), mat);
    mesh.position.copy(entry.cachedCenter);
    // Radius = half-diagonal of subtree AABB
    const half = entry.cachedSize.length() * 0.5;
    const r = half * entry.size;
    mesh.scale.set(r * 2, r * 2, r * 2);
    mesh.renderOrder = entry.renderOrder;
    entry.root = mesh;
    entry.material = mat;
    this.scene.add(mesh);
  }

  /** Sphere outline only — wireframe edges of the sphere. Cheap, crisp.
   *  Note: WebGL spec caps line width to 1px in most browsers. For thicker
   *  outlines use 'sphere-glow-hull' instead. */
  private _buildSphereEdges(entry: GizmoEntry): void {
    const lineMat = this._getOrCreateLineMaterial(entry);
    // Cache an EdgesGeometry of the sphere (not the box)
    const geo = _sharedSphereEdgesGeometry ??= new EdgesGeometry(getSphereGeometry());
    const lines = new LineSegments(geo, lineMat);
    lines.position.copy(entry.cachedCenter);
    const half = entry.cachedSize.length() * 0.5;
    const r = half * entry.size;
    lines.scale.set(r * 2, r * 2, r * 2);
    lines.renderOrder = entry.renderOrder;
    entry.root = lines;
    entry.material = lineMat;
    this.scene.add(lines);
  }

  /** Sphere with an outer "inverted hull" glow shell — back-faces only,
   *  scaled larger than the inner sphere, semi-transparent. Classic cartoon
   *  outline look. Two meshes: inner solid sphere + outer hull. */
  private _buildSphereGlowHull(entry: GizmoEntry): void {
    const innerMat = entry.emissiveIntensity > 0
      ? this._getOrCreateEmissiveMaterial(entry)
      : this._getOrCreateMeshMaterial(entry);
    const inner = new Mesh(getSphereGeometry(), innerMat);
    inner.position.copy(entry.cachedCenter);
    const half = entry.cachedSize.length() * 0.5;
    const r = half * entry.size;
    inner.scale.set(r * 2, r * 2, r * 2);
    inner.renderOrder = entry.renderOrder;

    // Outer hull — back-side only, larger, semi-transparent (NOT cached because side+blend differs)
    const hullMat = new MeshBasicMaterial({
      color: entry.color,
      transparent: true,
      opacity: Math.min(0.6, entry.baseOpacity * 1.5),
      side: BackSide,
      depthWrite: false,
      depthTest: entry.depthTest,
    });
    const hull = new Mesh(getSphereGeometry(), hullMat);
    hull.position.copy(entry.cachedCenter);
    const hr = r * entry.outlineScale;
    hull.scale.set(hr * 2, hr * 2, hr * 2);
    hull.renderOrder = entry.renderOrder - 1; // behind the inner sphere

    // Group both as the entry root so they move/dispose together
    const group = new Group();
    group.add(hull);
    group.add(inner);
    entry.root = group;
    entry.material = innerMat;
    // Track hull as overlay so it gets cleaned up
    entry.overlayMeshes.push(hull);
    this.scene.add(group);
  }

  private _buildSprite(entry: GizmoEntry): void {
    // Texture: caller-supplied (shared, NOT owned) or freshly built default.
    let tex: Texture;
    let ownTexture = false;
    if (entry.spriteTextureExternal) {
      tex = entry.spriteTextureExternal;
    } else {
      // Default: white-filled disc
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.beginPath();
      ctx.arc(32, 32, 28, 0, 2 * Math.PI);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      tex = new CanvasTexture(canvas);
      ownTexture = true;
    }

    const hex = entry.color.toString(16).padStart(6, '0');
    const mat = new SpriteMaterial({
      map: tex,
      color: parseInt(hex, 16),
      transparent: true,
      opacity: entry.baseOpacity,
      depthTest: entry.depthTest,
      depthWrite: false,
    });
    const sprite = new Sprite(mat);

    // Sizing: caller-supplied worldSize wins (needed for Empty/anchor nodes
    // with zero AABB); otherwise fall back to the AABB-relative default.
    let s: number;
    if (entry.worldSize !== undefined && entry.worldSize > 0) {
      s = entry.worldSize * entry.size;
    } else {
      s = Math.max(entry.cachedSize.x, entry.cachedSize.y, entry.cachedSize.z) * 0.3 * entry.size;
      if (!Number.isFinite(s) || s <= 0) s = 0.05 * entry.size; // safety fallback for zero AABB
    }
    sprite.scale.set(s, s, 1);
    sprite.renderOrder = entry.renderOrder;

    // Parenting: scene-attached gizmos stay where they spawned; node-attached
    // gizmos follow their owner. Snap-point markers always want the latter.
    if (entry.attachToNode) {
      // Local (0,0,0) relative to node → world position = node world position
      sprite.position.set(0, 0, 0);
      entry.node.add(sprite);
    } else {
      sprite.position.copy(entry.cachedCenter);
      this.scene.add(sprite);
    }

    entry.root = sprite;
    entry.material = mat;
    // Only retain the texture on the entry when WE own it (so dispose can
    // free it). Externally-supplied textures must NOT be disposed here.
    entry.texture = ownTexture ? tex : undefined;
  }

  private _buildFloorDisk(entry: GizmoEntry): void {
    const mat = this._getOrCreateMeshMaterial(entry);
    const mesh = new Mesh(getDiskGeometry(), mat);
    // Default radius = half of XZ diagonal of subtree (≈ "footprint" radius)
    const xzDiag = Math.hypot(entry.cachedSize.x, entry.cachedSize.z);
    const r = (entry.radius ?? xzDiag * 0.5) * entry.size;
    mesh.scale.set(r, 1, r);
    // Sit flat on the bbox bottom, centered on the bbox XZ center
    mesh.position.set(entry.cachedCenter.x, entry.cachedAABB.min.y, entry.cachedCenter.z);
    mesh.renderOrder = entry.renderOrder;
    entry.root = mesh;
    entry.material = mat;
    this.scene.add(mesh);
  }

  /** Connection cable (plan-259): dedicated 2-point BufferGeometry Line from
   *  `entry.node` to `entry.linkTo`, world-space, updated per frame via
   *  {@link updateLinkLine} (setXYZ + needsUpdate — never rebuilt). */
  private _buildLinkLine(entry: GizmoEntry): void {
    const mat = this._getOrCreateLineMaterial(entry);
    const geometry = new BufferGeometry();
    const positions = new Float32Array(6);
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    const line = new Line(geometry, mat);
    line.frustumCulled = false; // endpoints move every frame — skip stale-bounds culling
    line.renderOrder = entry.renderOrder;
    entry.root = line;
    entry.material = mat;
    entry.linkGeometry = geometry;
    this.scene.add(line);
    this._syncLinkLine(entry); // initial endpoint write
  }

  /** Write the CURRENT world positions of both endpoint nodes into the
   *  link-line geometry (no allocation, no rebuild). */
  private _syncLinkLine(entry: GizmoEntry): void {
    const geo = entry.linkGeometry;
    if (!geo || !entry.linkTo) return;
    const attr = geo.getAttribute('position') as BufferAttribute;
    entry.node.getWorldPosition(this._tmpV);
    attr.setXYZ(0, this._tmpV.x, this._tmpV.y, this._tmpV.z);
    entry.linkTo.getWorldPosition(this._tmpV);
    attr.setXYZ(1, this._tmpV.x, this._tmpV.y, this._tmpV.z);
    attr.needsUpdate = true;
  }

  /** Per-frame endpoint sync for one link-line handle (owner calls this from
   *  its onRender hook). No-op for non-link-line handles. */
  updateLinkLine(handleId: string): void {
    const entry = this._entries.get(handleId);
    if (entry?.shape === 'link-line') this._syncLinkLine(entry);
  }

  private _buildText(entry: GizmoEntry): void {
    const label = entry.text ?? '';
    const canvas = makeTextCanvas(label, entry.color);
    const tex = new CanvasTexture(canvas);

    const mat = new SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: entry.baseOpacity,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new Sprite(mat);

    // Position: anchored to bbox top (default) or bottom, plus offset
    const offsetY = entry.textOffsetY ?? Math.max(0.1, entry.cachedSize.y * 0.15);
    const anchorY = entry.textAnchor === 'bottom'
      ? entry.cachedAABB.min.y
      : entry.cachedAABB.max.y;
    this._tmpV.copy(entry.cachedCenter);
    this._tmpV.y = anchorY + offsetY;
    sprite.position.copy(this._tmpV);

    // Scale sprite to canvas aspect
    const pxToWorld = 0.004 * entry.size;
    sprite.scale.set(canvas.width * pxToWorld, canvas.height * pxToWorld, 1);
    sprite.renderOrder = entry.renderOrder;
    entry.root = sprite;
    entry.material = mat;
    entry.texture = tex;
    this.scene.add(sprite);
  }

  // ─── Material Cache (thin delegating wrappers over GizmoMaterialCache) ────

  /** Build cache inputs from a gizmo entry (matches the original key composition). */
  private _cacheInputs(entry: GizmoEntry): {
    color: number; baseOpacity: number; depthTest: boolean; blinkHz: number; emissiveIntensity: number;
  } {
    return {
      color: entry.color,
      baseOpacity: entry.baseOpacity,
      depthTest: entry.depthTest,
      blinkHz: entry.blinkHz,
      emissiveIntensity: entry.emissiveIntensity,
    };
  }

  private _getOrCreateMeshMaterial(entry: GizmoEntry): MeshBasicMaterial {
    return this._cache.getOrCreateMesh(this._cacheInputs(entry));
  }

  /** Build a MeshStandardMaterial that glows via emissive + UnrealBloomPass (when bloom is enabled).
   *  Color set to black; emissive carries the visible color so the sphere is independent
   *  of scene lighting (renders correctly in unlit areas). */
  private _getOrCreateEmissiveMaterial(entry: GizmoEntry): MeshStandardMaterial {
    return this._cache.getOrCreateEmissive(this._cacheInputs(entry));
  }

  private _getOrCreateLineMaterial(entry: GizmoEntry): LineBasicMaterial {
    return this._cache.getOrCreateLine(this._cacheInputs(entry));
  }

  private _releaseMaterial(entry: GizmoEntry): void {
    // text and sprite use dedicated materials — no cache to update
    if (entry.shape === 'text' || entry.shape === 'sprite') return;
    // Preserved 1:1 from original — box → line_ prefix, everything else → no
    // prefix (note: emissive spheres are released under the no-prefix path,
    // matching the original behavior; the `em_` cache entry remains until
    // manager dispose).
    const kind: 'mesh' | 'line' = (entry.shape === 'box' || entry.shape === 'link-line') ? 'line' : 'mesh';
    this._cache.release(this._cacheInputs(entry), kind);
  }

  // ─── Update & Dispose ───────────────────────────────────────────────

  private _updateEntry(entry: GizmoEntry, partial: Partial<GizmoOptions>): void {
    // Determine if any material-affecting change occurred
    let needRebuildMaterial = false;
    if (partial.color !== undefined && partial.color !== entry.color) needRebuildMaterial = true;
    if (partial.opacity !== undefined && partial.opacity !== entry.baseOpacity) needRebuildMaterial = true;
    if (partial.blinkHz !== undefined && partial.blinkHz !== entry.blinkHz) needRebuildMaterial = true;
    if (partial.depthTest !== undefined && partial.depthTest !== entry.depthTest) needRebuildMaterial = true;
    if (partial.emissiveIntensity !== undefined && partial.emissiveIntensity !== entry.emissiveIntensity) {
      needRebuildMaterial = true;
    }

    const sizeChanged = partial.size !== undefined && partial.size !== entry.size;
    const textChanged = partial.text !== undefined && partial.text !== entry.text;
    const offsetChanged = partial.textOffsetY !== undefined && partial.textOffsetY !== entry.textOffsetY;

    // Save updated values
    if (partial.color !== undefined) entry.color = partial.color;
    if (partial.opacity !== undefined) entry.baseOpacity = Math.max(0, Math.min(1, partial.opacity));
    if (partial.blinkHz !== undefined) entry.blinkHz = partial.blinkHz;
    if (partial.depthTest !== undefined) entry.depthTest = partial.depthTest;
    if (partial.size !== undefined) entry.size = partial.size;
    if (partial.text !== undefined) entry.text = partial.text;
    if (partial.textOffsetY !== undefined) entry.textOffsetY = partial.textOffsetY;
    if (partial.emissiveIntensity !== undefined) {
      entry.emissiveIntensity = Math.max(0, partial.emissiveIntensity);
    }
    if (partial.renderOrder !== undefined) {
      entry.renderOrder = partial.renderOrder;
      entry.root.renderOrder = partial.renderOrder;
      for (const ov of entry.overlayMeshes) ov.renderOrder = partial.renderOrder;
    }

    // Text shape: always rebuild on text/color/opacity change (own texture)
    if (entry.shape === 'text' && (textChanged || needRebuildMaterial)) {
      const oldTex = entry.texture;
      const canvas = makeTextCanvas(entry.text ?? '', entry.color);
      const newTex = new CanvasTexture(canvas);
      const spriteMat = entry.material as SpriteMaterial;
      spriteMat.map = newTex;
      spriteMat.opacity = entry.baseOpacity;
      spriteMat.needsUpdate = true;
      // Recalc sprite scale
      const sprite = entry.root as Sprite;
      const pxToWorld = 0.004 * entry.size;
      sprite.scale.set(canvas.width * pxToWorld, canvas.height * pxToWorld, 1);
      entry.texture = newTex;
      if (oldTex && oldTex !== newTex) oldTex.dispose();
      needRebuildMaterial = false;
    } else if (entry.shape === 'sprite' && needRebuildMaterial) {
      const mat = entry.material as SpriteMaterial;
      const hex = entry.color.toString(16).padStart(6, '0');
      mat.color.set(parseInt(hex, 16));
      mat.opacity = entry.baseOpacity;
      mat.depthTest = entry.depthTest;
      mat.needsUpdate = true;
      needRebuildMaterial = false;
    } else if ((entry.shape === 'mesh-glow-hull' || entry.shape === 'sphere-glow-hull') && needRebuildMaterial) {
      // Hull materials are dedicated (not in shared cache) and always transparent
      // (so the central blink loop can modulate opacity). Mutate in place.
      const mat = entry.material as MeshBasicMaterial;
      mat.color.set(entry.color);
      mat.opacity = entry.baseOpacity;
      mat.transparent = true;
      mat.depthTest = entry.depthTest;
      mat.needsUpdate = true;
      // Sync the dedicated blinker entry (or add/remove it as blinkHz changed).
      const key = `dedicated_${entry.id}`;
      if (entry.blinkHz > 0) {
        if (!this._cache.updateDedicated(key, entry.baseOpacity, entry.blinkHz)) {
          this._registerDedicatedBlinker(entry, mat);
        }
      } else if (this._cache.unregisterDedicated(key)) {
        // Blinking turned off → drop blinker AND restore full opacity (in case
        // tick had it in low phase when the state changed).
        mat.opacity = entry.baseOpacity;
      }
      needRebuildMaterial = false;
    } else if (needRebuildMaterial) {
      // Swap underlying material via cache (rebuild path, cheaper than full shape rebuild)
      this._releaseMaterial(entry);
      const newMat = entry.shape === 'box'
        ? this._getOrCreateLineMaterial(entry)
        : (entry.shape === 'sphere' && entry.emissiveIntensity > 0)
          ? this._getOrCreateEmissiveMaterial(entry)
          : this._getOrCreateMeshMaterial(entry);
      entry.material = newMat;
      if (entry.shape === 'mesh-overlay') {
        for (const ov of entry.overlayMeshes) ov.material = newMat as MeshBasicMaterial;
      } else if (entry.root instanceof Mesh) {
        (entry.root as Mesh).material = newMat as MeshBasicMaterial;
      } else if (entry.root instanceof LineSegments) {
        (entry.root as LineSegments).material = newMat as LineBasicMaterial;
      }
    }

    // Size change
    if (sizeChanged) {
      if (entry.shape === 'box' || entry.shape === 'transparent-shell') {
        entry.root.scale.copy(entry.cachedSize).multiplyScalar(entry.size);
      } else if (entry.shape === 'sphere') {
        const half = entry.cachedSize.length() * 0.5;
        const r = half * entry.size;
        entry.root.scale.set(r * 2, r * 2, r * 2);
      } else if (entry.shape === 'sprite') {
        const s = Math.max(entry.cachedSize.x, entry.cachedSize.y, entry.cachedSize.z) * 0.3 * entry.size;
        (entry.root as Sprite).scale.set(s, s, 1);
      } else if (entry.shape === 'text' && entry.texture) {
        const canvas = (entry.texture as CanvasTexture).image as HTMLCanvasElement;
        const pxToWorld = 0.004 * entry.size;
        (entry.root as Sprite).scale.set(canvas.width * pxToWorld, canvas.height * pxToWorld, 1);
      }
    }

    // Text offset change (text only)
    if (offsetChanged && entry.shape === 'text') {
      const offsetY = entry.textOffsetY ?? Math.max(0.1, entry.cachedSize.y * 0.15);
      this._tmpV.copy(entry.cachedCenter);
      this._tmpV.y = entry.cachedAABB.max.y + offsetY;
      entry.root.position.copy(this._tmpV);
    }

    if (partial.visible !== undefined) {
      entry.visible = partial.visible;
      entry.root.visible = this._shouldBeVisible(entry);
    }
  }

  private _setEntryVisible(entry: GizmoEntry, v: boolean): void {
    entry.visible = v;
    entry.root.visible = this._shouldBeVisible(entry);
  }

  private _shouldBeVisible(entry: GizmoEntry): boolean {
    if (!this._globalVisible) return false;
    if (!entry.visible) return false;
    // Overlay-visibility category gate (plan-250).
    if (entry.category && this._hiddenCategories.has(entry.category)) return false;
    if (this._tagFilter !== null) {
      const tag = entry.node.userData?._rvTag;
      if (tag !== this._tagFilter) return false;
    }
    return true;
  }

  private _disposeEntry(entry: GizmoEntry): void {
    // Idempotency guard (plan-250): `handle.dispose()` may run after `clearNode`
    // or twice. Without this, `unregisterOverlayProducer` would fire more than
    // once and corrupt the shared category refcount.
    if (!this._entries.has(entry.id)) return;
    this._disposeEntryVisuals(entry);
    this._entries.delete(entry.id);
    if (entry.category) unregisterOverlayProducer(entry.category);
    const ids = this._nodeToIds.get(entry.node);
    if (ids) {
      ids.delete(entry.id);
      if (ids.size === 0) this._nodeToIds.delete(entry.node);
    }
  }

  private _disposeEntryVisuals(entry: GizmoEntry): void {
    // Unregister auxiliary raycast targets (no-op if never registered)
    if (this.raycastManager) {
      if (entry.overlayMeshes.length > 0) {
        for (const m of entry.overlayMeshes) this.raycastManager.removeAuxRaycastTarget(m);
      } else {
        this.raycastManager.removeAuxRaycastTarget(entry.root);
      }
    }
    // Drop the dedicated blinker entry (no-op if never registered).
    this._cache.unregisterDedicated(`dedicated_${entry.id}`);
    // Remove from scene
    if (entry.root.parent) entry.root.parent.remove(entry.root);
    // Dispose dedicated resources
    if (entry.shape === 'text' || entry.shape === 'sprite') {
      if (entry.texture) {
        entry.texture.dispose();
        entry.texture = undefined;
      }
      (entry.material as Material).dispose();
    } else if (entry.shape === 'mesh-glow-hull' || entry.shape === 'sphere-glow-hull') {
      // Hull material is dedicated (BackSide / opaque variant not in shared cache).
      (entry.material as Material).dispose();
    } else {
      // Shared materials: refcount
      this._releaseMaterial(entry);
    }
    // link-line: the 2-point geometry is dedicated (per entry) — free it.
    if (entry.linkGeometry) {
      entry.linkGeometry.dispose();
      entry.linkGeometry = undefined;
    }
    entry.overlayMeshes.length = 0;
  }
}

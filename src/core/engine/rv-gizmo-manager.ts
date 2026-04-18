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
  CanvasTexture,
  CylinderGeometry,
  EdgesGeometry,
  Group,
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
  | 'floor-disk';

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
  /** Optional emissive intensity for shape='sphere'. When > 0, the sphere uses a
   *  MeshStandardMaterial with `emissive: color, emissiveIntensity` so it glows
   *  through the existing UnrealBloomPass (when bloom is enabled). 0 / undefined
   *  → MeshBasicMaterial (flat color, no glow). Cache key includes this value. */
  emissiveIntensity?: number;
  /** For shape='sphere-glow-hull' only — multiplier for the outer hull radius
   *  relative to the inner sphere. 1.2 = subtle glow, 2.0 = thick halo. Default 1.4. */
  outlineScale?: number;
}

/** Handle returned when a gizmo is created. */
export interface GizmoHandle {
  readonly id: string;
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
  /** Emissive intensity for sphere shape (>0 → MeshStandardMaterial; 0 → MeshBasic). */
  emissiveIntensity: number;
  /** Hull-scale multiplier for 'sphere-glow-hull' shape. */
  outlineScale: number;
  /** Cached subtree AABB (computed once at create). */
  cachedAABB: Box3;
  cachedSize: Vector3;
  cachedCenter: Vector3;
}

interface MaterialMeta {
  material: Material;
  /** Cache-key so we can find it. */
  key: string;
  /** Base opacity shared by all entries that use this material. */
  baseOpacity: number;
  /** Blink frequency (Hz). 0 = no blink. */
  blinkHz: number;
  /** Last phase written ('on' | 'off' | 'static'). */
  lastPhase: 'on' | 'off' | 'static';
  /** Reference count — material evicted from cache when refCount → 0. */
  refCount: number;
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

// ─── Helpers ───────────────────────────────────────────────────────────

/** Compute AABB from all isMesh descendants (filters out Lights, Cameras, Groups). */
function computeSubtreeAABB(node: Object3D): { box: Box3; size: Vector3; center: Vector3 } {
  const box = new Box3();
  let hasAny = false;
  node.traverse((child) => {
    const asMesh = child as Mesh;
    if (asMesh.isMesh && asMesh.geometry) {
      box.expandByObject(asMesh);
      hasAny = true;
    }
  });
  if (!hasAny) {
    // Fallback: use node world position as center with minimal size
    const pos = new Vector3();
    node.getWorldPosition(pos);
    box.setFromCenterAndSize(pos, new Vector3(0.1, 0.1, 0.1));
  }
  const size = new Vector3();
  box.getSize(size);
  if (size.x < 0.001) size.x = 0.001;
  if (size.y < 0.001) size.y = 0.001;
  if (size.z < 0.001) size.z = 0.001;
  const center = new Vector3();
  box.getCenter(center);
  return { box, size, center };
}

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
  private _materialCache = new Map<string, MaterialMeta>();
  private _nodeToIds = new Map<Object3D, Set<string>>();
  private _idCounter = 0;
  private _globalVisible = true;
  private _shapeOverride: GizmoShape | null = null;
  private _tagFilter: string | null = null;

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
  ) {}

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
      emissiveIntensity: Math.max(0, opts.emissiveIntensity ?? 0),
      outlineScale: Math.max(1.01, opts.outlineScale ?? 1.4),
      cachedAABB: box,
      cachedSize: subSize,
      cachedCenter: center,
    };

    this._buildShape(entry);

    // Apply initial visibility (also considering global filters)
    entry.root.visible = this._shouldBeVisible(entry);

    this._entries.set(id, entry);
    let ids = this._nodeToIds.get(node);
    if (!ids) {
      ids = new Set();
      this._nodeToIds.set(node, ids);
    }
    ids.add(id);

    const handle: GizmoHandle = {
      id,
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

  /** Per-frame blink tick — called directly from RVViewer.fixedUpdate. */
  tick(_elapsedMs: number): void {
    if (this._entries.size === 0) return;
    const t = performance.now();
    for (const meta of this._materialCache.values()) {
      if (meta.blinkHz <= 0) continue;
      const phase = Math.sin(2 * Math.PI * meta.blinkHz * t / 1000) > 0 ? 'on' : 'off';
      if (phase === meta.lastPhase) continue;
      meta.lastPhase = phase;
      const mat = meta.material as MeshBasicMaterial | LineBasicMaterial;
      const baseOp = meta.baseOpacity;
      (mat as { opacity: number }).opacity =
        phase === 'on' ? baseOp : baseOp * BLINK_LOW_MULT;
    }
  }

  dispose(): void {
    for (const entry of Array.from(this._entries.values())) {
      this._disposeEntry(entry);
    }
    this._entries.clear();
    this._nodeToIds.clear();
    this._materialCache.clear();
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
    }

    entry.root.userData._rvGizmo = true;
    entry.root.userData._rvGizmoId = entry.id;
    entry.root.renderOrder = entry.renderOrder;
    // Always render crisp during isolate mode: enable ISOLATE_FOCUS_LAYER so the
    // gizmo participates in pass 3 (focus pass) and overdraws the dimmed copy
    // from pass 1. No effect in normal mode (still on layer 0).
    entry.root.traverse((o) => o.layers.enable(2 /* ISOLATE_FOCUS_LAYER */));

    // Auto-register as auxiliary raycast targets so hover/click on the gizmo
    // resolves to the underlying owner node — works for sphere, transparent-shell,
    // sprite, text, floor-disk, mesh-overlay (per-mesh). Skipped for box
    // (wireframe is hard to hit anyway).
    if (this.raycastManager && entry.shape !== 'box') {
      if (entry.overlayMeshes.length > 0) {
        for (const m of entry.overlayMeshes) this.raycastManager.addAuxRaycastTarget(m, entry.node);
      } else {
        this.raycastManager.addAuxRaycastTarget(entry.root, entry.node);
      }
    }
  }

  private _buildBox(entry: GizmoEntry): void {
    const mat = this._getOrCreateLineMaterial(entry);
    const lines = new LineSegments(getEdgesGeometry(), mat);
    lines.position.copy(entry.cachedCenter);
    lines.scale.copy(entry.cachedSize).multiplyScalar(entry.size);
    lines.renderOrder = entry.renderOrder;
    entry.root = lines;
    entry.material = mat;
    this.scene.add(lines);
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
    let depth = 0;
    let overDepthWarned = false;
    entry.node.traverse((child) => {
      // Cheap depth gate (approximate)
      depth = 0;
      let cur: Object3D | null = child;
      while (cur && cur !== entry.node) {
        depth++;
        cur = cur.parent;
      }
      if (depth > MAX_OVERLAY_DEPTH) {
        if (!overDepthWarned) {
          console.warn(`[GizmoOverlayManager] mesh-overlay exceeded depth ${MAX_OVERLAY_DEPTH}; skipping deeper meshes`);
          overDepthWarned = true;
        }
        return;
      }
      const asMesh = child as Mesh;
      if (!asMesh.isMesh || !asMesh.geometry) return;
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
    });
    entry.root = group;
    entry.material = mat;
    this.scene.add(group);
  }

  /** Wireframe edges of every Mesh descendant — same coverage as mesh-overlay
   *  but rendered as LineSegments(EdgesGeometry). Cheap, crisp outline. */
  private _buildMeshEdges(entry: GizmoEntry): void {
    const group = new Group();
    const lineMat = this._getOrCreateLineMaterial(entry);
    let depth = 0;
    let overDepthWarned = false;
    entry.node.traverse((child) => {
      depth = 0;
      let cur: Object3D | null = child;
      while (cur && cur !== entry.node) { depth++; cur = cur.parent; }
      if (depth > MAX_OVERLAY_DEPTH) {
        if (!overDepthWarned) {
          console.warn(`[GizmoOverlayManager] mesh-edges exceeded depth ${MAX_OVERLAY_DEPTH}; skipping deeper meshes`);
          overDepthWarned = true;
        }
        return;
      }
      const m = child as Mesh;
      if (!m.isMesh || !m.geometry) return;
      if (m.userData?._rvGizmo) return;
      const edges = new EdgesGeometry(m.geometry);
      const lines = new LineSegments(edges, lineMat);
      m.updateWorldMatrix(true, false);
      lines.position.setFromMatrixPosition(m.matrixWorld);
      lines.quaternion.setFromRotationMatrix(m.matrixWorld);
      const scl = new Vector3();
      m.matrixWorld.decompose(new Vector3(), lines.quaternion, scl);
      lines.scale.copy(scl);
      lines.renderOrder = entry.renderOrder;
      group.add(lines);
      // Track for dispose; per-mesh EdgesGeometry NOT shared (geometry-specific)
      entry.overlayMeshes.push(lines as unknown as Mesh);
    });
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
    let depth = 0;
    let overDepthWarned = false;
    entry.node.traverse((child) => {
      depth = 0;
      let cur: Object3D | null = child;
      while (cur && cur !== entry.node) { depth++; cur = cur.parent; }
      if (depth > MAX_OVERLAY_DEPTH) {
        if (!overDepthWarned) {
          console.warn(`[GizmoOverlayManager] mesh-glow-hull exceeded depth ${MAX_OVERLAY_DEPTH}; skipping deeper meshes`);
          overDepthWarned = true;
        }
        return;
      }
      const m = child as Mesh;
      if (!m.isMesh || !m.geometry) return;
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
    });
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
    const key = `dedicated_${entry.id}`;
    this._materialCache.set(key, {
      material: mat as unknown as MeshBasicMaterial,
      key,
      baseOpacity: entry.baseOpacity,
      blinkHz: entry.blinkHz,
      lastPhase: 'on',
      refCount: 1,
    });
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
    // Use a simple white-circle canvas as the default sprite icon
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    ctx.beginPath();
    ctx.arc(32, 32, 28, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    const tex = new CanvasTexture(canvas);

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
    sprite.position.copy(entry.cachedCenter);
    const s = Math.max(entry.cachedSize.x, entry.cachedSize.y, entry.cachedSize.z) * 0.3 * entry.size;
    sprite.scale.set(s, s, 1);
    sprite.renderOrder = entry.renderOrder;
    entry.root = sprite;
    entry.material = mat;
    entry.texture = tex;
    this.scene.add(sprite);
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

  // ─── Material Cache ────────────────────────────────────────────────

  private _makeCacheKey(color: number, baseOpacity: number, depthTest: boolean, blinkHz: number, emissiveIntensity = 0): string {
    return `${color}_${baseOpacity}_${depthTest}_${blinkHz}_e${emissiveIntensity}`;
  }

  private _getOrCreateMeshMaterial(entry: GizmoEntry): MeshBasicMaterial {
    const key = this._makeCacheKey(entry.color, entry.baseOpacity, entry.depthTest, entry.blinkHz);
    const existing = this._materialCache.get(key);
    if (existing) {
      existing.refCount++;
      return existing.material as MeshBasicMaterial;
    }
    const mat = new MeshBasicMaterial({
      color: entry.color,
      transparent: true,
      opacity: entry.baseOpacity,
      depthTest: entry.depthTest,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    const meta: MaterialMeta = {
      material: mat,
      key,
      baseOpacity: entry.baseOpacity,
      blinkHz: entry.blinkHz,
      lastPhase: entry.blinkHz > 0 ? 'on' : 'static',
      refCount: 1,
    };
    this._materialCache.set(key, meta);
    return mat;
  }

  /** Build a MeshStandardMaterial that glows via emissive + UnrealBloomPass (when bloom is enabled).
   *  Color set to black; emissive carries the visible color so the sphere is independent
   *  of scene lighting (renders correctly in unlit areas). */
  private _getOrCreateEmissiveMaterial(entry: GizmoEntry): MeshStandardMaterial {
    const key = `em_${this._makeCacheKey(entry.color, entry.baseOpacity, entry.depthTest, entry.blinkHz, entry.emissiveIntensity)}`;
    const existing = this._materialCache.get(key);
    if (existing) {
      existing.refCount++;
      return existing.material as MeshStandardMaterial;
    }
    const mat = new MeshStandardMaterial({
      color: 0x000000,
      emissive: entry.color,
      emissiveIntensity: entry.emissiveIntensity,
      transparent: entry.baseOpacity < 1,
      opacity: entry.baseOpacity,
      depthTest: entry.depthTest,
      depthWrite: false,
      // Bloom requires the renderer's tone-mapped output. emissive needs to map > 0.85 (default
      // bloom threshold) AFTER tone mapping. emissiveIntensity ≥ 1.5 typically suffices.
      toneMapped: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    const meta: MaterialMeta = {
      material: mat,
      key,
      baseOpacity: entry.baseOpacity,
      blinkHz: entry.blinkHz,
      lastPhase: entry.blinkHz > 0 ? 'on' : 'static',
      refCount: 1,
    };
    this._materialCache.set(key, meta);
    return mat;
  }

  private _getOrCreateLineMaterial(entry: GizmoEntry): LineBasicMaterial {
    const key = `line_${this._makeCacheKey(entry.color, entry.baseOpacity, entry.depthTest, entry.blinkHz)}`;
    const existing = this._materialCache.get(key);
    if (existing) {
      existing.refCount++;
      return existing.material as LineBasicMaterial;
    }
    const mat = new LineBasicMaterial({
      color: entry.color,
      transparent: true,
      opacity: entry.baseOpacity,
      depthTest: entry.depthTest,
      depthWrite: false,
    });
    const meta: MaterialMeta = {
      material: mat,
      key,
      baseOpacity: entry.baseOpacity,
      blinkHz: entry.blinkHz,
      lastPhase: entry.blinkHz > 0 ? 'on' : 'static',
      refCount: 1,
    };
    this._materialCache.set(key, meta);
    return mat;
  }

  private _releaseMaterial(entry: GizmoEntry): void {
    // text and sprite use dedicated materials — no cache to update
    if (entry.shape === 'text' || entry.shape === 'sprite') return;
    const isLine = entry.shape === 'box';
    const prefix = isLine ? 'line_' : '';
    const key = `${prefix}${this._makeCacheKey(entry.color, entry.baseOpacity, entry.depthTest, entry.blinkHz)}`;
    const meta = this._materialCache.get(key);
    if (!meta) return;
    meta.refCount--;
    if (meta.refCount <= 0) {
      this._materialCache.delete(key);
      (meta.material as Material).dispose();
    }
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
      const meta = this._materialCache.get(key);
      if (entry.blinkHz > 0) {
        if (meta) {
          meta.baseOpacity = entry.baseOpacity;
          meta.blinkHz = entry.blinkHz;
        } else {
          this._registerDedicatedBlinker(entry, mat);
        }
      } else if (meta) {
        // Blinking turned off → drop blinker AND restore full opacity (in case
        // tick had it in low phase when the state changed).
        this._materialCache.delete(key);
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
    if (this._tagFilter !== null) {
      const tag = entry.node.userData?._rvTag;
      if (tag !== this._tagFilter) return false;
    }
    return true;
  }

  private _disposeEntry(entry: GizmoEntry): void {
    this._disposeEntryVisuals(entry);
    this._entries.delete(entry.id);
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
    this._materialCache.delete(`dedicated_${entry.id}`);
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
    entry.overlayMeshes.length = 0;
  }
}

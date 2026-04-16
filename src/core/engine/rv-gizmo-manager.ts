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
  Mesh,
  MeshBasicMaterial,
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
  | 'sphere'
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

/** Create/render a text sprite with label on a dark rounded bg. */
function makeTextCanvas(text: string, color: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const padding = 8;
  const fontSize = 28;
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

  // Rounded bg
  const r = 6;
  const w = canvas.width;
  const h = canvas.height;
  ctx2.fillStyle = 'rgba(20, 24, 32, 0.72)';
  ctx2.beginPath();
  ctx2.moveTo(r, 0);
  ctx2.lineTo(w - r, 0);
  ctx2.quadraticCurveTo(w, 0, w, r);
  ctx2.lineTo(w, h - r);
  ctx2.quadraticCurveTo(w, h, w - r, h);
  ctx2.lineTo(r, h);
  ctx2.quadraticCurveTo(0, h, 0, h - r);
  ctx2.lineTo(0, r);
  ctx2.quadraticCurveTo(0, 0, r, 0);
  ctx2.closePath();
  ctx2.fill();

  // Text color
  const hex = color.toString(16).padStart(6, '0');
  ctx2.fillStyle = `#${hex}`;
  ctx2.textBaseline = 'middle';
  ctx2.textAlign = 'left';
  ctx2.fillText(text, padding, h / 2 + 1);

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

  constructor(private readonly scene: Object3D) {}

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
      case 'sprite':
        this._buildSprite(entry);
        break;
      case 'text':
        this._buildText(entry);
        break;
    }

    entry.root.userData._rvGizmo = true;
    entry.root.userData._rvGizmoId = entry.id;
    entry.root.renderOrder = entry.renderOrder;
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

  private _buildSphere(entry: GizmoEntry): void {
    const mat = this._getOrCreateMeshMaterial(entry);
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

    // Position: subtree top + offset
    const offsetY = entry.textOffsetY ?? Math.max(0.1, entry.cachedSize.y * 0.15);
    this._tmpV.copy(entry.cachedCenter);
    this._tmpV.y = entry.cachedAABB.max.y + offsetY;
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

  private _makeCacheKey(color: number, baseOpacity: number, depthTest: boolean, blinkHz: number): string {
    return `${color}_${baseOpacity}_${depthTest}_${blinkHz}`;
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
    } else if (needRebuildMaterial) {
      // Swap underlying material via cache (rebuild path, cheaper than full shape rebuild)
      this._releaseMaterial(entry);
      const newMat = entry.shape === 'box'
        ? this._getOrCreateLineMaterial(entry)
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
    // Remove from scene
    if (entry.root.parent) entry.root.parent.remove(entry.root);
    // Dispose dedicated resources
    if (entry.shape === 'text' || entry.shape === 'sprite') {
      if (entry.texture) {
        entry.texture.dispose();
        entry.texture = undefined;
      }
      (entry.material as Material).dispose();
    } else {
      // Shared materials: refcount
      this._releaseMaterial(entry);
    }
    entry.overlayMeshes.length = 0;
  }
}

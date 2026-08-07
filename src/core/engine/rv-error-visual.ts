// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-error-visual.ts — shared error-visualization helpers.
 *
 * The red flashing highlight (mesh-glow-hull or floor-disk ring), the backed
 * error-text badge sprite, and the Auto small-part heuristic are used by BOTH
 * `RVWebError` (a pure semantic error marker) and `RVWebVisibility` (a
 * show/hide component that ALSO carries an error state). Extracted here so the
 * two components share one implementation instead of duplicating the badge
 * canvas + gizmo wiring.
 *
 * Only visualization primitives live here — no signal subscription, no
 * ErrorStore wiring, no lifecycle. The owning component drives those.
 */

import { CanvasTexture, type Object3D, type Texture } from 'three';
import type { GizmoHandle, GizmoOverlayManager } from './rv-gizmo-manager';
import { computeSubtreeAABB } from './rv-traverse-utils';

// ─── Constants (inline, glanceable) ─────────────────────────────────────

/** ISA-101 alarm red used for the 3D highlight + badge border. */
export const ERROR_COLOR = 0xff2020;
/** 2 Hz flash for the active highlight (matches WebSensor 'error' state). */
export const ERROR_BLINK_HZ = 2;
/** Wider outline so small parts are visible from far (matches WebSensor). */
export const HIGHLIGHT_OUTLINE_SCALE = 2.0;
/** Bounding-box diagonal below this (in meters) → small part → floor-disk ring.
 *  ~150 mm threshold (Auto heuristic — calibratable). */
export const SMALL_PART_DIAGONAL_M = 0.15;

/** 3D highlight style — accepts the C# enum as string or int index. */
export type HighlightStyle = 'Auto' | 'FlashObject' | 'Circle';

/** Enum-tolerant schema descriptor for a `HighlightStyle` rv_extras field.
 *  Accepts the C# enum serialized as a string ('Auto') OR an int index ('0').
 *  Shared so both components declare identical mapping. */
export const HIGHLIGHT_STYLE_FIELD = {
  type: 'enum' as const,
  enumMap: {
    Auto: 'Auto', FlashObject: 'FlashObject', Circle: 'Circle',
    '0': 'Auto', '1': 'FlashObject', '2': 'Circle',
  },
  default: 'Auto' as const,
};

/** Normalize a string/int HighlightStyle to a named value (defensive). */
export function normalizeHighlightStyle(raw: unknown): HighlightStyle {
  if (raw === 'FlashObject' || raw === 1 || raw === '1') return 'FlashObject';
  if (raw === 'Circle' || raw === 2 || raw === '2') return 'Circle';
  return 'Auto';
}

// ─── Color parsing (Unity Color → 0xRRGGBB hex) ──────────────────────────

/** Parse a Unity `Color` from rv_extras (usually `{r,g,b,a}` floats 0..1) to a
 *  0xRRGGBB number. Defensive: falls back to {@link ERROR_COLOR} for anything
 *  unparseable (missing field, wrong shape, NaN). Alpha is ignored — the gizmo
 *  opacity is fixed per shape. */
export function parseColorToHex(raw: unknown, fallback = ERROR_COLOR): number {
  if (raw == null || typeof raw !== 'object') return fallback;
  const c = raw as { r?: unknown; g?: unknown; b?: unknown };
  const r = Number(c.r);
  const g = Number(c.g);
  const b = Number(c.b);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return fallback;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
}

// ─── Backed error-text badge sprite (dark panel + red border + white text) ──

/** Build a CanvasTexture badge: dark rounded panel, colored border, white text.
 *  Pattern mirrors MeasurementRenderer._createLabelSprite. Returns the texture
 *  plus its canvas aspect (w/h) so the caller can scale the sprite correctly. */
export function buildBadgeTexture(
  text: string,
  borderColor = ERROR_COLOR,
): { texture: CanvasTexture; aspect: number } {
  const label = text && text.trim() ? text : 'Error';
  const fontSize = 32;
  const border = 3;
  const radius = 8;
  const pad = 16;

  const measureCanvas = document.createElement('canvas');
  const mctx = measureCanvas.getContext('2d')!;
  mctx.font = `bold ${fontSize}px sans-serif`;
  const textWidth = Math.ceil(mctx.measureText(label).width);

  const w = textWidth + pad * 2 + border * 2;
  const h = fontSize + pad;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  const drawRoundedRect = (x: number, y: number, rw: number, rh: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + rw - r, y);
    ctx.quadraticCurveTo(x + rw, y, x + rw, y + r);
    ctx.lineTo(x + rw, y + rh - r);
    ctx.quadraticCurveTo(x + rw, y + rh, x + rw - r, y + rh);
    ctx.lineTo(x + r, y + rh);
    ctx.quadraticCurveTo(x, y + rh, x, y + rh - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  // Colored border (full rect) → dark panel inset
  const hex = borderColor.toString(16).padStart(6, '0');
  ctx.fillStyle = `#${hex}`;
  drawRoundedRect(0, 0, w, h, radius);
  ctx.fill();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  drawRoundedRect(border, border, w - border * 2, h - border * 2, Math.max(0, radius - border));
  ctx.fill();

  // White text
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, w / 2, h / 2 + 1);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  return { texture, aspect: w / h };
}

// ─── Highlight gizmo (mesh-glow-hull flash or floor-disk ring) ───────────

/** Decide whether to use a floor-disk ring (true) or a mesh flash (false).
 *  Circle → always ring, FlashObject → always mesh, Auto → ring for small parts
 *  (short subtree diagonal). */
export function resolveUseRing(node: Object3D, style: HighlightStyle): boolean {
  if (style === 'Circle') return true;
  if (style === 'FlashObject') return false;
  const { size } = computeSubtreeAABB(node);
  return size.length() < SMALL_PART_DIAGONAL_M;
}

/** Create the red flashing highlight gizmo (initially hidden). Mirrors the
 *  RVWebError onSceneReady highlight setup so both components look identical. */
export function createErrorHighlightGizmo(
  gizmoManager: GizmoOverlayManager,
  node: Object3D,
  style: HighlightStyle,
  color = ERROR_COLOR,
  blinkHz = ERROR_BLINK_HZ,
): GizmoHandle {
  if (resolveUseRing(node, style)) {
    return gizmoManager.create(node, {
      shape: 'floor-disk',
      color,
      opacity: 0.45,
      blinkHz,
      visible: false,
      category: 'status',
    });
  }
  return gizmoManager.create(node, {
    shape: 'mesh-glow-hull',
    color,
    opacity: 0.95,
    blinkHz,
    outlineScale: HIGHLIGHT_OUTLINE_SCALE,
    visible: false,
    category: 'status',
  });
}

// ─── Unified status highlight (fill overlay + silhouette edges) ──────────

/** Fill/edge opacities of the unified status highlight — the same intensities
 *  the selection (metadata object) highlight uses (rv-highlight-manager.ts
 *  DEFAULT_SELECTION_STYLE), so both read as the same visual language. */
export const STATUS_FILL_OPACITY = 0.2;
export const STATUS_EDGE_OPACITY = 0.65;

/** Options for {@link createStatusHighlightGizmos}. */
export interface StatusHighlightOptions {
  /** Default {@link STATUS_FILL_OPACITY}. */
  fillOpacity?: number;
  /** Default {@link STATUS_EDGE_OPACITY}. */
  edgeOpacity?: number;
}

/**
 * Unified status highlight for one node: type-colored translucent fill on
 * every mesh + crisp 30°-threshold silhouette edges, both static and drawn
 * on top (depthTest false). Shared by the runtime-instruction step highlight
 * and any model-specific status marking.
 *
 * The accompanying BLINKING OUTLINE is NOT a gizmo — it is the OutlinePass
 * status channel (rv-status-outline.ts), driven separately by the caller.
 *
 * Returns both gizmo handles (fill, edges) — dispose each to clear.
 */
export function createStatusHighlightGizmos(
  gm: GizmoOverlayManager,
  node: Object3D,
  color: number,
  opts: StatusHighlightOptions = {},
): GizmoHandle[] {
  const common = {
    color,
    blinkHz: 0,
    visible: true,
    depthTest: false,
    // Highlights must never steal hover/click from the scene (the highlight
    // manager's overlays disable raycasting the same way).
    excludeFromRaycast: true,
    category: 'status',
  } as const;
  return [
    gm.create(node, { shape: 'mesh-overlay', opacity: opts.fillOpacity ?? STATUS_FILL_OPACITY, ...common }),
    gm.create(node, { shape: 'mesh-edges', opacity: opts.edgeOpacity ?? STATUS_EDGE_OPACITY, ...common }),
  ];
}

/** Create the backed error-text badge sprite above the part (initially hidden).
 *  Returns the gizmo handle plus the owned texture (caller disposes it). */
export function createErrorBadgeGizmo(
  gizmoManager: GizmoOverlayManager,
  node: Object3D,
  text: string,
  borderColor = ERROR_COLOR,
): { gizmo: GizmoHandle; texture: Texture } {
  const { texture, aspect } = buildBadgeTexture(text, borderColor);
  const { size } = computeSubtreeAABB(node);
  // World height of the badge ≈ a fraction of the part height (min 0.08 m).
  const badgeHeight = Math.max(0.08, size.y * 0.4);
  const gizmo = gizmoManager.create(node, {
    shape: 'sprite',
    color: 0xffffff,
    opacity: 1.0,
    spriteTexture: texture,
    worldSize: badgeHeight,
    depthTest: false,
    renderOrder: 12,
    excludeFromRaycast: true,
    visible: false,
    category: 'status',
  });
  // Sprite worldSize is the badge HEIGHT; width = height × aspect.
  gizmo.root.scale.set(badgeHeight * aspect, badgeHeight, 1);
  // Lift the badge above the part (sprite default sits at the AABB center).
  gizmo.root.position.y += size.y * 0.5 + badgeHeight;
  return { gizmo, texture };
}

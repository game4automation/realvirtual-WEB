// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-label-sprite.ts — THE one way to put canvas-drawn text into the 3D scene.
 *
 * Every text label in the viewer (source marker, measurement distance,
 * annotation, gizmo text, DES badge, avatar card, …) is a `Sprite` whose
 * `SpriteMaterial.map` is a `CanvasTexture`. Five settings decide whether such
 * a sprite survives the post-processing chain (GTAO / N8AO / UnrealBloom /
 * OutputPass tone mapping) legibly, and every author used to re-decide them by
 * hand — which is why "the label is smeared / dimmed / washed out" kept coming
 * back during development. This module fixes the contract in one place:
 *
 *   1. **Overlay layer, never layer 0.** A sprite on layer 0 goes THROUGH the
 *      composer: GTAO dims it over cavity edges, bloom smears the white glyphs,
 *      the half-res AO/bloom buffers blur it. Labels live on an overlay layer
 *      (`HIGHLIGHT_OVERLAY_LAYER` by default, or `MEASUREMENT_LAYER` /
 *      `ANNOTATION_LAYER` for those subsystems) and are re-rendered crisp AFTER
 *      the composer (`RVViewer._renderOverlayLayers`, isolate pass 4).
 *   2. **`toneMapped: false`.** The canvas colors render exactly as drawn.
 *   3. **`depthTest: false`, `depthWrite: false`.** Always readable, and never a
 *      depth contribution to the AO gbuffer.
 *   4. **sRGB color space + anisotropy.** Correct colors and crisp glyphs at
 *      grazing camera angles.
 *   5. **Supersampled canvas.** Drawn at `LABEL_SUPERSAMPLE`× the logical size
 *      with a pre-scaled 2D context, so minification does not turn glyphs into
 *      doubled ghosts.
 *
 * `labelContractViolations(scene)` walks a scene and reports every canvas-
 * textured sprite that breaks rule 1, 2 or 3 — the vitest contract test and
 * the `web_status.render.labels` diagnostic both use it, so a new label that
 * bypasses this factory is caught before anyone notices it visually.
 */

import {
  CanvasTexture,
  LinearFilter,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Object3D,
} from 'three';
import { HIGHLIGHT_OVERLAY_LAYER } from './rv-group-registry';

// ─── Constants ─────────────────────────────────────────────────────

/** Canvas supersample factor: the texture is drawn at this multiple of the
 *  logical size, the 2D context is pre-scaled so draw code stays logical. */
export const LABEL_SUPERSAMPLE = 2;
/** Anisotropic filtering level for label textures (clamped to the GPU max). */
export const LABEL_ANISOTROPY = 8;

// ─── Canvas ────────────────────────────────────────────────────────

/**
 * Create a supersampled canvas of logical size `w × h` and run `draw` on a 2D
 * context that is pre-scaled by `supersample`, so `draw` works in logical
 * pixels. Returns the canvas (physical size `w·s × h·s`).
 *
 * In a context without 2D canvas support (never in the browser, only exotic
 * test doubles) the canvas is returned blank rather than throwing.
 */
export function makeLabelCanvas(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  supersample: number = LABEL_SUPERSAMPLE,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * supersample));
  canvas.height = Math.max(1, Math.round(h * supersample));
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(supersample, supersample);
  draw(ctx, w, h);
  return canvas;
}

/**
 * Draw a rounded rectangle path (no fill/stroke) — the pill shape every boxed
 * label shares.
 */
export function labelRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Draw the standard boxed label: colored rounded border, dark interior, white
 * centered text. `w × h` are logical pixels (the context is pre-scaled by
 * {@link makeLabelCanvas}).
 */
export function drawBoxedLabel(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  text: string,
  borderColor: string,
  opts: { font?: string; border?: number; radius?: number; interior?: string; maxChars?: number } = {},
): void {
  const border = opts.border ?? 3;
  const radius = opts.radius ?? 8;
  ctx.fillStyle = borderColor;
  labelRoundedRect(ctx, 0, 0, w, h, radius);
  ctx.fill();
  ctx.fillStyle = opts.interior ?? 'rgba(0, 0, 0, 0.8)';
  labelRoundedRect(ctx, border, border, w - 2 * border, h - 2 * border, Math.max(0, radius - border));
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = opts.font ?? 'bold 24px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const max = opts.maxChars ?? 22;
  const shown = text.length > max ? text.substring(0, max - 3) + '...' : text;
  ctx.fillText(shown, w / 2, h / 2);
}

// ─── Texture / material / sprite ───────────────────────────────────

export type LabelFiltering = 'mipmap' | 'linear';

export interface LabelSpriteOptions {
  /** Layer the sprite renders on. MUST be an overlay layer (never 0).
   *  Default {@link HIGHLIGHT_OVERLAY_LAYER}. */
  layer?: number;
  /** `Object3D.renderOrder`. Default 999. */
  renderOrder?: number;
  /** Material opacity. Default 1. */
  opacity?: number;
  /** Texture minification: 'mipmap' (default — trilinear + anisotropy, no
   *  aliasing when small) or 'linear' (no mipmaps — for labels that are
   *  always kept at screen size by an LOD scaler). */
  filtering?: LabelFiltering;
  /** `Object3D.name`. */
  name?: string;
}

/** Wrap a label canvas in a CanvasTexture with the contract's sampling. */
export function createLabelTexture(canvas: HTMLCanvasElement, filtering: LabelFiltering = 'mipmap'): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = LABEL_ANISOTROPY;
  if (filtering === 'linear') {
    tex.generateMipmaps = false;
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
  }
  tex.needsUpdate = true;
  return tex;
}

/** Build the contract material for a label texture. */
export function createLabelMaterial(texture: CanvasTexture, opacity = 1): SpriteMaterial {
  return new SpriteMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

/** Apply the contract's object settings to an existing sprite. Idempotent. */
export function applyLabelSpriteContract(sprite: Sprite, opts: LabelSpriteOptions = {}): void {
  sprite.layers.set(opts.layer ?? HIGHLIGHT_OVERLAY_LAYER);
  sprite.renderOrder = opts.renderOrder ?? 999;
  sprite.frustumCulled = false;
  sprite.userData._rvLabelSprite = true;
  const mat = sprite.material as SpriteMaterial;
  mat.depthTest = false;
  mat.depthWrite = false;
  mat.toneMapped = false;
  mat.transparent = true;
}

export interface LabelSpriteHandles {
  sprite: Sprite;
  texture: CanvasTexture;
  material: SpriteMaterial;
  /** Logical aspect ratio (canvas width / height) for `sprite.scale`. */
  aspect: number;
}

/**
 * Create a label sprite from a canvas. The caller positions and scales the
 * sprite (`scale.set(h * aspect, h, 1)`), and owns disposal of
 * `texture` + `material`.
 */
export function createLabelSprite(canvas: HTMLCanvasElement, opts: LabelSpriteOptions = {}): LabelSpriteHandles {
  const texture = createLabelTexture(canvas, opts.filtering);
  const material = createLabelMaterial(texture, opts.opacity ?? 1);
  const sprite = new Sprite(material);
  if (opts.name) sprite.name = opts.name;
  applyLabelSpriteContract(sprite, opts);
  return { sprite, texture, material, aspect: canvas.width / Math.max(1, canvas.height) };
}

/**
 * Swap a label's texture after a redraw (text/color change). Disposes the old
 * texture and keeps the material's contract settings.
 */
export function replaceLabelTexture(sprite: Sprite, canvas: HTMLCanvasElement, filtering: LabelFiltering = 'mipmap'): CanvasTexture {
  const mat = sprite.material as SpriteMaterial;
  const old = mat.map;
  const tex = createLabelTexture(canvas, filtering);
  mat.map = tex;
  mat.needsUpdate = true;
  if (old && old !== tex) old.dispose();
  return tex;
}

// ─── Contract check ─────────────────────────────────────────────────

/** True for a sprite whose material map is backed by an HTML canvas. */
export function isCanvasLabelSprite(o: Object3D): o is Sprite {
  const s = o as Sprite & { isSprite?: boolean };
  if (!s.isSprite) return false;
  const map = (s.material as SpriteMaterial | undefined)?.map as { image?: unknown; isCanvasTexture?: boolean } | null | undefined;
  if (!map) return false;
  if (map.isCanvasTexture) return true;
  const img = map.image as { tagName?: string } | undefined;
  return typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement;
}

export interface LabelContractViolation {
  name: string;
  /** Hierarchy path of the sprite (names joined by '/'). */
  path: string;
  reasons: string[];
}

/**
 * Walk `root` and report every canvas-textured sprite that breaks the label
 * contract: on layer 0 (goes through the composer), tone-mapped, or writing /
 * testing depth. An empty array means every text label in the scene is safe
 * under any post-processing setting.
 */
export function labelContractViolations(root: Object3D): LabelContractViolation[] {
  const out: LabelContractViolation[] = [];
  root.traverse((o) => {
    if (!isCanvasLabelSprite(o)) return;
    const reasons: string[] = [];
    if ((o.layers.mask & 1) !== 0) reasons.push('layer-0');
    const mat = o.material as SpriteMaterial;
    if (mat.toneMapped !== false) reasons.push('toneMapped');
    if (mat.depthWrite !== false) reasons.push('depthWrite');
    if (mat.depthTest !== false) reasons.push('depthTest');
    if (reasons.length === 0) return;
    const parts: string[] = [];
    for (let p: Object3D | null = o; p; p = p.parent) parts.unshift(p.name || '(unnamed)');
    out.push({ name: o.name || '(unnamed)', path: parts.join('/'), reasons });
  });
  return out;
}

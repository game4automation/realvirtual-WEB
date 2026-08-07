// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { CanvasTexture } from 'three';

/**
 * `alert` is the STATIC conflict marker (plan-341 Phase 5). Under
 * `prefers-reduced-motion` a conflict badge must not blink at all, so the
 * warning has to be carried by shape instead of by motion: a heavier ring and
 * an exclamation glyph in place of the plug. It is tinted at runtime exactly
 * like `idle`.
 */
export type PortMarkerVariant = 'idle' | 'active' | 'alert';

const INSTRUMENT_BLUE = '#4fc3f7';
const INK = '#102530';
const _cache: Record<PortMarkerVariant, CanvasTexture | null> = {
  idle: null, active: null, alert: null,
};

const SIZE = 256;
const CENTER = SIZE / 2;
const DISC_RADIUS: Record<PortMarkerVariant, number> = { idle: 104, active: 112, alert: 100 };
const RING_WIDTH = 10;
/** The static conflict ring is deliberately heavier than the idle one. */
const ALERT_RING_WIDTH = 22;
/** Glyph is authored on a 24x24 grid (top-left origin) and scaled from its centre. */
const GLYPH_SCALE = 7.4;

/**
 * Two-pin connector: straight pins, a solid body with a rounded underside and a
 * short cable. Drawn solid rather than outlined so it survives the sprite's
 * screen-space downscale — an outlined glyph collapses into mush below ~24 px.
 */
function drawPlugGlyph(ctx: CanvasRenderingContext2D, color: string): void {
  ctx.save();
  ctx.translate(CENTER, CENTER);
  ctx.scale(GLYPH_SCALE, GLYPH_SCALE);
  ctx.translate(-12, -12);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.2;

  ctx.beginPath();
  ctx.moveTo(9, 2.6);
  ctx.lineTo(9, 8);
  ctx.moveTo(15, 2.6);
  ctx.lineTo(15, 8);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(6, 8);
  ctx.lineTo(18, 8);
  ctx.lineTo(18, 12.8);
  ctx.arcTo(18, 17, 13.8, 17, 4.2);
  ctx.lineTo(10.2, 17);
  ctx.arcTo(6, 17, 6, 12.8, 4.2);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(12, 17);
  ctx.lineTo(12, 21.6);
  ctx.stroke();

  ctx.restore();
}

/**
 * Exclamation mark on the same 24x24 grid as the plug: a solid bar plus a
 * separate dot, both drawn filled for the same reason the plug is — an
 * outlined glyph disintegrates once the sprite is scaled down to ~24 px.
 */
function drawAlertGlyph(ctx: CanvasRenderingContext2D, color: string): void {
  ctx.save();
  ctx.translate(CENTER, CENTER);
  ctx.scale(GLYPH_SCALE, GLYPH_SCALE);
  ctx.translate(-12, -12);
  ctx.fillStyle = color;
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(10.4, 4.4);
  ctx.lineTo(13.6, 4.4);
  ctx.lineTo(13.1, 14.6);
  ctx.lineTo(10.9, 14.6);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.arc(12, 18.4, 1.7, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/**
 * Lazily create the shared connector-port texture used by signal drop markers
 * and link-mode badges.
 *
 * The sprite material multiplies this texture by its own colour, so the two
 * variants are authored differently: `idle` is tinted at runtime (white disc →
 * takes the tint, dark glyph → stays legible under any tint), while `active`
 * is drawn with a white tint and therefore carries its own colours.
 */
export function makePortMarkerTexture(variant: PortMarkerVariant): CanvasTexture {
  const cached = _cache[variant];
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const active = variant === 'active';

  const alert = variant === 'alert';

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.beginPath();
  ctx.arc(CENTER, CENTER, DISC_RADIUS[variant], 0, Math.PI * 2);
  ctx.fillStyle = active ? INSTRUMENT_BLUE : '#ffffff';
  ctx.globalAlpha = active ? 1 : 0.95;
  ctx.fill();
  ctx.globalAlpha = active ? 1 : (alert ? 0.9 : 0.55);
  ctx.lineWidth = alert ? ALERT_RING_WIDTH : RING_WIDTH;
  ctx.strokeStyle = active ? '#ffffff' : INK;
  ctx.stroke();
  ctx.globalAlpha = 1;

  if (alert) drawAlertGlyph(ctx, INK);
  else drawPlugGlyph(ctx, active ? '#ffffff' : INK);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.anisotropy = 4;
  _cache[variant] = texture;
  return texture;
}

/** Test-only helper for deterministic texture lifecycle assertions. */
export function _disposePortMarkerTextures(): void {
  for (const variant of Object.keys(_cache) as PortMarkerVariant[]) {
    _cache[variant]?.dispose();
    _cache[variant] = null;
  }
}

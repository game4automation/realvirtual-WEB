// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-annotate — label overlays for MCP screenshots (`web_screenshot_annotated`).
 *
 * `projectLabelAnchors` is pure math (camera projection + crop/scale mapping)
 * so it is unit-testable without a renderer; `drawAnnotations` draws leader
 * dots + label pills in the burst-montage styling onto a 2D context.
 */

import { Vector3 } from 'three';
import type { Camera } from 'three';

export interface LabelTarget {
  /** World-space anchor point (usually the node's bounds center). */
  point: Vector3;
  label: string;
}

export interface LabelAnchor {
  /** Output-canvas pixel position (post-crop, post-downscale). */
  x: number;
  y: number;
  label: string;
  /** True when the point is behind the camera — skip drawing. */
  behind: boolean;
  /** True when the anchor was clamped to the crop edge (off-crop target). */
  clamped: boolean;
}

export interface CropRect { left: number; top: number; width: number; height: number }

/**
 * Project world points into output-canvas pixels through the capture's crop
 * rect and downscale factor (same math as the capture helper's crop path).
 *
 * `bufferW/H` = renderer drawing-buffer size; `outW/H` = final canvas size.
 */
export function projectLabelAnchors(
  camera: Camera,
  bufferW: number,
  bufferH: number,
  crop: CropRect,
  outW: number,
  outH: number,
  targets: readonly LabelTarget[],
): LabelAnchor[] {
  const kx = outW / crop.width;
  const ky = outH / crop.height;
  const v = new Vector3();
  return targets.map((t) => {
    v.copy(t.point).project(camera); // world -> NDC
    const behind = v.z > 1 || v.z < -1;
    const px = (v.x * 0.5 + 0.5) * bufferW;
    const py = (1 - (v.y * 0.5 + 0.5)) * bufferH;
    let x = (px - crop.left) * kx;
    let y = (py - crop.top) * ky;
    const clamped = x < 0 || y < 0 || x > outW || y > outH;
    x = Math.min(Math.max(x, 8), outW - 8);
    y = Math.min(Math.max(y, 8), outH - 8);
    return { x, y, label: t.label, behind, clamped };
  });
}

/** Draw leader dots + rounded label pills (montage styling) onto `ctx`. */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  anchors: readonly LabelAnchor[],
): void {
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const a of anchors) {
    if (a.behind) continue;
    // Leader dot (accent ring + white core) at the anchor point.
    ctx.beginPath();
    ctx.arc(a.x, a.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#4fc3f7';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(a.x, a.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    // Pill to the upper-right of the dot (flips left when near the right edge).
    const tw = ctx.measureText(a.label).width;
    const pw = tw + 14, ph = 22;
    const canvasW = ctx.canvas.width;
    let bx = a.x + 9;
    if (bx + pw > canvasW - 4) bx = a.x - 9 - pw;
    const by = Math.max(4, a.y - ph - 4);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    roundRect(ctx, bx, by, pw, ph, 6);
    ctx.fill();
    ctx.fillStyle = a.clamped ? '#ffd54f' : '#ffffff';
    ctx.fillText(a.label, bx + 7, by + ph / 2 + 1);
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

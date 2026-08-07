// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-frame-capture — shared one-frame capture for the MCP screenshot tools.
 *
 * Extracted from McpBridgePlugin._captureFrameCanvas so the delegate tool
 * classes (view tools, editor verify tool) reuse the exact same render + crop
 * + downscale path. Renders one frame via the viewer's full frame path
 * (isolate composition, post-processing, overlays — see
 * RVViewer.renderFrameForCapture) and reads the drawing buffer synchronously
 * in the same tick (the renderer has no preserveDrawingBuffer).
 *
 * Crop resolution priority: manual fractional rect → explicit world Box3 →
 * node path (on-screen AABB of the node) → full frame.
 */

import { Box3, MathUtils, Vector3 } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { encodeRvImageWithinBudget } from './rv-image-budget';

export interface FrameCaptureOptions {
  /** Node path — crop to its on-screen bounding box (+8% padding). */
  path?: string;
  /** Manual crop rect as fractions 0..1 of the canvas (all four required). */
  x?: number; y?: number; w?: number; h?: number;
  /** Explicit world-space box to crop to (verify tool: kinematic sweep bounds). */
  worldBox?: Box3;
  /** Long-edge bound of the output canvas (default 1400). */
  maxDim?: number;
}

export interface FrameCaptureResult {
  canvas: HTMLCanvasElement;
  crop: { left: number; top: number; width: number; height: number };
}

/** Project a world-space Box3 to a padded drawing-buffer pixel rect. */
function projectBoxToBufferRect(
  box: Box3, camera: import('three').Camera, BW: number, BH: number,
): { left: number; top: number; width: number; height: number } | null {
  if (box.isEmpty()) return null;
  const { min, max } = box;
  const corners = [
    new Vector3(min.x, min.y, min.z), new Vector3(min.x, min.y, max.z),
    new Vector3(min.x, max.y, min.z), new Vector3(min.x, max.y, max.z),
    new Vector3(max.x, min.y, min.z), new Vector3(max.x, min.y, max.z),
    new Vector3(max.x, max.y, min.z), new Vector3(max.x, max.y, max.z),
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of corners) {
    c.project(camera); // world -> NDC (-1..1)
    const px = (c.x * 0.5 + 0.5) * BW;
    const py = (1 - (c.y * 0.5 + 0.5)) * BH;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  const pad = 0.08 * Math.max(maxX - minX, maxY - minY); // breathing room
  const left = Math.max(0, Math.round(minX - pad));
  const top = Math.max(0, Math.round(minY - pad));
  const right = Math.min(BW, Math.round(maxX + pad));
  const bottom = Math.min(BH, Math.round(maxY + pad));
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Render the scene once and return the cropped + downscaled frame as a canvas.
 * Returns `{ error }` when the renderer is not ready or a path cannot resolve.
 */
export function captureFrameCanvas(
  viewer: RVViewer | undefined,
  opts: FrameCaptureOptions = {},
): FrameCaptureResult | { error: string } {
  const renderer = viewer?.renderer, scene = viewer?.scene, camera = viewer?.camera;
  if (!viewer || !renderer || !scene || !camera) return { error: 'Renderer not ready' };
  // Full frame path (isolate 3-pass composite, composer post, overlays) — a raw
  // renderer.render() would miss the isolate dimming and post-processing, so
  // screenshots would not match the viewport.
  viewer.renderFrameForCapture();
  const src = renderer.domElement;
  const BW = src.width, BH = src.height; // drawing-buffer pixels

  // Resolve the crop rectangle (in drawing-buffer pixels).
  let crop = { left: 0, top: 0, width: BW, height: BH };
  const { x, y, w, h } = opts;
  const hasManual = [x, y, w, h].every(n => typeof n === 'number' && !Number.isNaN(n));
  const clamp01 = (n: number): number => MathUtils.clamp(n, 0, 1);
  if (hasManual) {
    crop = {
      left: Math.round(clamp01(x!) * BW),
      top: Math.round(clamp01(y!) * BH),
      width: Math.round(clamp01(w!) * BW),
      height: Math.round(clamp01(h!) * BH),
    };
  } else if (opts.worldBox) {
    const rect = projectBoxToBufferRect(opts.worldBox, camera, BW, BH);
    if (rect) crop = rect;
  } else if (opts.path) {
    const node = viewer.registry?.getNode(opts.path);
    if (!node) return { error: `Node not found: "${opts.path}"` };
    const box = new Box3().setFromObject(node);
    if (box.isEmpty()) return { error: `Node "${opts.path}" has no renderable bounds` };
    const rect = projectBoxToBufferRect(box, camera, BW, BH);
    if (rect) crop = rect;
  }
  // Degenerate crop (off-screen / behind camera) → fall back to the full frame.
  if (crop.width < 1 || crop.height < 1) crop = { left: 0, top: 0, width: BW, height: BH };

  const maxDim = opts.maxDim ?? 1400;
  const k = Math.min(1, maxDim / Math.max(crop.width, crop.height));
  const outW = Math.max(1, Math.round(crop.width * k));
  const outH = Math.max(1, Math.round(crop.height * k));
  const off = document.createElement('canvas');
  off.width = outW; off.height = outH;
  const ctx = off.getContext('2d');
  if (!ctx) return { error: 'No 2D context' };
  ctx.drawImage(src, crop.left, crop.top, crop.width, crop.height, 0, 0, outW, outH);
  return { canvas: off, crop };
}

/**
 * JSON-encode a canvas as the bridge's `__rvImage` payload (JPEG).
 *
 * Goes through the byte budget in rv-image-budget.ts: the bridge peer answers an
 * oversized WS frame by closing the socket, so the size has to be settled here, on
 * the producing side. Normal frames encode exactly once at the historical quality
 * 0.72 and are returned unchanged; only an over-budget frame walks the reduction
 * ladder, and only an unreducible one yields the small error payload.
 */
export function canvasToRvImage(
  canvas: HTMLCanvasElement,
  extra?: Record<string, unknown>,
): string {
  return encodeRvImageWithinBudget(canvas, extra);
}

/**
 * Persist a captured canvas as PNG at a work-folder-relative path.
 *
 * An MCP image result reaches the agent as an encoded payload it cannot turn back into bytes, so
 * durable screenshots have to be written on this side. Returns a fragment to merge into the image
 * result's `extra`, reporting either where the file landed or why it did not — never silently
 * dropping the request, because the agent will otherwise write a reference to a file that is not
 * there.
 */
export async function saveCanvasToWorkfolder(
  canvas: HTMLCanvasElement,
  relPath: string,
): Promise<Record<string, unknown>> {
  const withPng = /\.png$/i.test(relPath.trim()) ? relPath.trim() : `${relPath.trim()}.png`;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return { saveError: 'Could not encode the frame as PNG' };
  const fs = await import('../../core/engine/rv-local-filesystem');
  const result = await fs.writeWorkfolderBlob(withPng, blob);
  return 'error' in result ? { saveError: result.error } : { savedPath: result.savedPath };
}

/** Composite frames into a labelled grid montage (burst-style styling). */
export function compositeMontage(
  frames: HTMLCanvasElement[],
  labels: string[],
): HTMLCanvasElement | { error: string } {
  if (frames.length === 0) return { error: 'No frames' };
  const n = frames.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const aspect = frames[0].height / frames[0].width || 0.5625;
  const cellW = Math.floor(Math.min(640, 1600 / cols));
  const cellH = Math.round(cellW * aspect);
  const mont = document.createElement('canvas');
  mont.width = cols * cellW; mont.height = rows * cellH;
  const ctx = mont.getContext('2d');
  if (!ctx) return { error: 'No 2D context' };
  ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, mont.width, mont.height);
  for (let i = 0; i < frames.length; i++) {
    const cx = (i % cols) * cellW, cy = Math.floor(i / cols) * cellH;
    ctx.drawImage(frames[i], cx, cy, cellW, cellH);
    const label = labels[i] ?? `#${i}`;
    ctx.font = '600 16px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(cx + 4, cy + 4, tw + 10, 22);
    ctx.fillStyle = '#fff'; ctx.fillText(label, cx + 9, cy + 20);
  }
  return mont;
}

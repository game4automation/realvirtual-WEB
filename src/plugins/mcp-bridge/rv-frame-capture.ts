// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-frame-capture — the HUMAN's frame, plus the shared image encoders.
 *
 * {@link captureFrameCanvas} reads the VISIBLE drawing buffer, so what it
 * returns is the user's canvas at the user's size with the user's UI state.
 * Since plan-740 Phase 3 that has exactly ONE consumer left: `web_screenshot`,
 * which is deliberately defined as "what the human sees" (D-U9). Every other
 * perception tool — eye, render, sweep, burst, annotated, analyze, verify_drive
 * — renders offscreen through the agent camera (`EyeChannels.renderChannels`).
 * If you are about to add a second consumer here, you almost certainly want
 * `renderAgentChannels` in `rv-mcp-observe-tools.ts` instead.
 *
 * It renders one frame via the viewer's full frame path (isolate composition,
 * post-processing, overlays — see RVViewer.renderFrameForCapture) and reads the
 * drawing buffer synchronously in the same tick (the renderer has no
 * preserveDrawingBuffer).
 *
 * Crop resolution priority: manual fractional rect → explicit world Box3 →
 * node path (on-screen AABB of the node) → full frame.
 *
 * The encoders below (`canvasToRvImage`, `canvasesToRvImages`,
 * `saveCanvasToProject`, `compositeMontage`) stay shared by both paths — they
 * are about bytes, not about whose camera produced them.
 */

import { Box3, MathUtils, Vector3 } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { encodeRvImageWithinBudget, encodeRvImagesWithinBudget } from './rv-image-budget';
import { recordAgentEyeEnvelope } from '../../core/hmi/agent-eye-monitor-store';

/**
 * Hand the FINISHED envelope to the Agent Eye Monitor (plan-481).
 *
 * Deliberately the last thing both encoders do, and deliberately swallowing:
 * the return value is already decided, the monitor is a viewing aid, and a tool
 * call must never fail because a filmstrip cell could not be built. The store
 * itself only enqueues here — all real work runs in a macrotask, i.e. after the
 * MCP answer has been sent (D-A3).
 */
function tapAgentEyeMonitor(envelopeJson: string, source?: string): void {
  try {
    recordAgentEyeEnvelope(envelopeJson, source);
  } catch {
    /* never let the monitor touch a tool result */
  }
}

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
 *
 * `source` is the calling tool's own name (plan-481 D-A8). It is a SEPARATE
 * third parameter and never part of `extra` — `extra` is spread into
 * `__rvImage` and would therefore travel to the agent. The returned string is
 * byte for byte what the budget encoder produced.
 */
export function canvasToRvImage(
  canvas: HTMLCanvasElement,
  extra?: Record<string, unknown>,
  source?: string,
): string {
  const envelope = encodeRvImageWithinBudget(canvas, extra);
  tapAgentEyeMonitor(envelope, source);
  return envelope;
}

/**
 * JSON-encode SEVERAL aligned canvases as one multi-channel envelope
 * (plan-740 D-A1) — the `web_eye` counterpart of {@link canvasToRvImage}.
 *
 * Channel order is the caller's order and is what the sidecar's `channels[]`
 * declares, so the agent can match the Nth image block to the Nth name.
 */
export function canvasesToRvImages(
  channels: readonly RvImageChannel[],
  extra?: Record<string, unknown>,
  source?: string,
): string {
  const envelope = encodeRvImagesWithinBudget(channels, extra);
  tapAgentEyeMonitor(envelope, source);
  return envelope;
}

/** One image on its way into a multi-channel envelope. */
export interface RvImageChannel {
  canvas: HTMLCanvasElement;
  mime: 'image/png' | 'image/jpeg';
  channel: string;
}

/** Where an unqualified `savePath` lands inside the project (plan-709 §2.6.2). */
export const CAPTURES_FOLDER = 'captures';

/**
 * Persist a captured canvas as PNG inside the OPEN PROJECT (plan-709 §2.6.2).
 *
 * An MCP image result reaches the agent as an encoded payload it cannot turn back into bytes, so
 * durable screenshots have to be written on this side. Returns a fragment to merge into the image
 * result's `extra`, reporting either where the file landed or why it did not — never silently
 * dropping the request, because the agent will otherwise write a reference to a file that is not
 * there. In particular: with no writable project open this REFUSES rather than writing somewhere
 * else, because "somewhere else" is exactly the second store this plan removed.
 *
 * The path is project-relative. A bare name (`overview.png`) is placed under `captures/`; a path
 * that already names its folder (`knowledge/Belt/views/x.png`) is taken as given, so an agent can
 * keep a structure it chose.
 */
export async function saveCanvasToProject(
  canvas: HTMLCanvasElement,
  relPath: string,
): Promise<Record<string, unknown>> {
  const trimmed = relPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!trimmed) return { saveError: 'savePath is empty' };
  if (trimmed.split('/').includes('..')) return { saveError: 'savePath must not contain ".."' };
  const withPng = /\.png$/i.test(trimmed) ? trimmed : `${trimmed}.png`;
  const target = withPng.includes('/') ? withPng : `${CAPTURES_FOLDER}/${withPng}`;

  const { getProjectStore } = await import('../../core/project/project-store');
  const backend = getProjectStore().getBackend();
  if (!backend?.writable) {
    return { saveError: 'No writable project is open — open or create one in Projects to save captures.' };
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return { saveError: 'Could not encode the frame as PNG' };
  try {
    // Overwrite-by-design: a capture replaces the previous capture at the same
    // path, and there is no earlier revision this frame was derived from.
    await backend.writeDocument(
      target,
      new Uint8Array(await blob.arrayBuffer()),
      { expectedRevision: 'any' },
    );
    return { savedPath: target };
  } catch (e) {
    return { saveError: `Could not write "${target}": ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Composite frames into a labelled grid montage (burst-style styling).
 *
 * `cellPx` overrides the burst-tuned default cell width. The default keeps the
 * whole sheet inside 1600px, which is right for a burst of viewport screenshots
 * but silently discards resolution for a caller that rendered its cells at a
 * size the USER asked for — `web_view_ortho` rendered 1024px cells and got them
 * scaled to 533, so its `size` parameter had no observable effect at all.
 * Callers that own their cell resolution pass it through here instead.
 */
export function compositeMontage(
  frames: HTMLCanvasElement[],
  labels: string[],
  cellPx?: number,
): HTMLCanvasElement | { error: string } {
  if (frames.length === 0) return { error: 'No frames' };
  const n = frames.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const aspect = frames[0].height / frames[0].width || 0.5625;
  const cellW = Number.isFinite(cellPx) && (cellPx as number) > 0
    ? Math.round(cellPx as number)
    : Math.floor(Math.min(640, 1600 / cols));
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
    // Scale with the cell so a larger sheet does not get relatively smaller
    // labels. 0.03 reproduces the historical 16px exactly at the 533px default.
    const fontPx = Math.max(12, Math.round(cellW * 0.03));
    ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
    const tw = ctx.measureText(label).width;
    const pad = Math.round(fontPx * 0.25);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(cx + pad, cy + pad, tw + pad * 2.5, fontPx + pad * 1.5);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, cx + pad * 2.25, cy + fontPx + pad);
  }
  return mont;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-image-budget — producer-side byte budget for the MCP bridge.
 *
 * WHY THIS EXISTS (plan-327 AP4). The bridge peer enforces a hard 2 MiB limit on
 * a single incoming WebSocket message (`WebViewerBridge.MaxMessageBytes`), and it
 * enforces it by CLOSING the socket with `MessageTooBig`. Discovering the limit on
 * the receiving side is therefore too late: an oversized screenshot does not fail
 * the tool call, it drops the whole bridge connection and every pending call with
 * it. The producer is the only place that can see the size before it is on the
 * wire, so the budget lives here.
 *
 * The three rules, in order:
 *
 *   1. BUDGET BEFORE SEND — every candidate encoding is measured as final UTF-8
 *      bytes. A `data.length` budget is not enough: `web_screenshot_analyze`
 *      carries a variable-length `paths`/`unresolved` list next to the pixels.
 *   2. DETERMINISTIC REDUCTION — a fixed quality ladder, then a fixed scale
 *      ladder. Same canvas in, same bytes out; no adaptive search, no randomness.
 *   3. SMALL CORRELATED ERROR — when even the smallest rung misses the budget,
 *      the tool returns a short error object naming the measured size, the budget
 *      and the attempts. A defined error, never a dropped connection.
 *
 * Chunking is deliberately NOT implemented (AP0 result): no quality criterion was
 * found that downscaling cannot meet, and chunking would be a protocol extension
 * on both sides for a case that does not occur.
 *
 * BYTE ACCOUNTING. `MaxMessageBytes` is 2 097 152. The operative budget for the
 * complete outer frame is {@link WS_ENVELOPE_BUDGET_BYTES} = 2 000 000, leaving
 * 97 152 bytes of headroom for protocol changes. The image payload gets that minus
 * {@link ENVELOPE_RESERVE_BYTES}, which covers the `{"type":"result","id":N,
 * "result":"…"}` wrapper plus the JSON string escaping the wrapper applies to the
 * payload (every `"` in the inner JSON becomes `\"`). Base64 itself contains no
 * escapable characters, so the escaping cost scales with the metadata, not with
 * the pixels. {@link enforceEnvelopeBudget} re-measures the real frame afterwards
 * and is the backstop for anything this reserve underestimates.
 *
 * MEMORY BUDGET (DoS). The ladder holds at most ONE candidate string and ONE
 * scaled canvas at a time — each rung drops the previous one before encoding the
 * next, so peak extra memory is ~1 payload (≤ ~2.7 MB for a maximal base64 string)
 * and not attempts × payload. {@link utf8ByteLength} refuses to allocate an
 * encoding buffer for a string whose char count alone already exceeds the budget,
 * so an oversized result cannot be turned into a second oversized allocation.
 */

/** Hard ceiling for one outgoing WS frame, below the peer's 2 MiB `MaxMessageBytes`. */
export const WS_ENVELOPE_BUDGET_BYTES = 2_000_000;

/** Reserved for the `result` wrapper and its JSON string escaping of the payload. */
export const ENVELOPE_RESERVE_BYTES = 8_192;

/** Budget for one serialized `__rvImage` payload, before it is wrapped in a frame. */
export const IMAGE_PAYLOAD_BUDGET_BYTES = WS_ENVELOPE_BUDGET_BYTES - ENVELOPE_RESERVE_BYTES;

/**
 * Long-edge guard. Above every dimension the capture paths legitimately produce
 * (screenshot 1400, burst montage width 1600, analyze mosaic 2048×2096), so it does
 * not alter normal output — it exists for the unbounded cases, e.g. a burst montage
 * of portrait crops whose HEIGHT the montage formula does not cap.
 */
export const MAX_LONG_EDGE_PX = 2_400;

/** Total-pixel guard for the same reason (a 4×4 montage of tall crops). */
export const MAX_TOTAL_PIXELS = 6_000_000;

/** JPEG quality rungs. The first is the historical default — normal images encode once. */
const QUALITY_LADDER = [0.72, 0.55, 0.4] as const;

/** Linear scale rungs applied after the quality ladder is exhausted at a given size. */
const SCALE_LADDER = [1, 0.7, 0.5, 0.35, 0.25] as const;

const UTF8 = new TextEncoder();

/** Minimal structural view of a canvas — lets the ladder be tested without a real 2D context. */
export interface BudgetImageSource {
  readonly width: number;
  readonly height: number;
  toDataURL(type: string, quality: number): string;
}

export interface ImageBudgetOptions {
  /** Byte budget for the serialized payload (default {@link IMAGE_PAYLOAD_BUDGET_BYTES}). */
  budgetBytes?: number;
  maxLongEdgePx?: number;
  maxTotalPixels?: number;
  /** Scaled-copy factory. Default builds an offscreen 2D canvas; tests inject a stub. */
  resize?: (source: BudgetImageSource, width: number, height: number) => BudgetImageSource | null;
}

/**
 * UTF-8 byte length of `text`.
 *
 * `TextEncoder` is exact but allocates the full buffer, so callers that only need a
 * budget verdict should use {@link exceedsUtf8Budget}, which short-circuits.
 */
export function utf8ByteLength(text: string): number {
  return UTF8.encode(text).length;
}

/**
 * Measured UTF-8 size when `text` is over `budgetBytes`, otherwise `null`.
 *
 * UTF-8 never encodes a string in fewer bytes than it has UTF-16 code units (ASCII
 * is 1:1, everything else costs more, and a surrogate pair costs 4 bytes for 2
 * units). A char count above the budget is therefore already a verdict, and the
 * encoding buffer — which for an oversized payload is exactly the allocation we are
 * trying to avoid — is never created.
 */
export function exceedsUtf8Budget(text: string, budgetBytes: number): number | null {
  if (text.length > budgetBytes) return text.length; // lower bound; already over
  const bytes = utf8ByteLength(text);
  return bytes > budgetBytes ? bytes : null;
}

/** Default scaled-copy factory: offscreen 2D canvas, nearest available browser resampling. */
function resizeOnCanvas(
  source: BudgetImageSource, width: number, height: number,
): BudgetImageSource | null {
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  const ctx = off.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(source as unknown as CanvasImageSource, 0, 0, width, height);
  return off;
}

/** Scale factor that brings a frame under both the long-edge and the total-pixel guard. */
function guardScale(width: number, height: number, maxLongEdge: number, maxPixels: number): number {
  const longEdge = Math.max(width, height);
  const byEdge = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  const pixels = width * height;
  const byArea = pixels > maxPixels ? Math.sqrt(maxPixels / pixels) : 1;
  return Math.min(byEdge, byArea);
}

/** Serialize one `__rvImage` payload at a given quality — the shape the bridge peer parses. */
function encodePayload(
  source: BudgetImageSource, quality: number, extra?: Record<string, unknown>,
): string {
  const data = source.toDataURL('image/jpeg', quality).split(',')[1] ?? '';
  return JSON.stringify({
    __rvImage: {
      data, mimeType: 'image/jpeg', width: source.width, height: source.height, ...extra,
    },
  });
}

/**
 * Encode a canvas as an `__rvImage` payload that provably fits the byte budget.
 *
 * Returns the payload JSON, or — when the smallest rung still misses — a short error
 * object (`{ error, imageBudgetExceeded: {…} }`). The error is intentionally the same
 * shape the capture tools already use for "renderer not ready", so callers need no
 * special handling and the MCP client sees a normal tool error instead of losing the
 * bridge connection.
 */
export function encodeRvImageWithinBudget(
  canvas: BudgetImageSource,
  extra?: Record<string, unknown>,
  options: ImageBudgetOptions = {},
): string {
  const budget = options.budgetBytes ?? IMAGE_PAYLOAD_BUDGET_BYTES;
  const resize = options.resize ?? resizeOnCanvas;
  const maxLongEdge = options.maxLongEdgePx ?? MAX_LONG_EDGE_PX;
  const maxPixels = options.maxTotalPixels ?? MAX_TOTAL_PIXELS;

  // Dimension guard first: a frame that is already too large in pixels never gets
  // encoded at full size, so the guard costs nothing on the common path.
  let base = canvas;
  const guard = guardScale(canvas.width, canvas.height, maxLongEdge, maxPixels);
  if (guard < 1) {
    const scaled = resize(canvas,
      Math.max(1, Math.round(canvas.width * guard)),
      Math.max(1, Math.round(canvas.height * guard)));
    if (scaled) base = scaled;
  }

  let attempts = 0;
  let lastBytes = 0;
  let lastWidth = base.width;
  let lastHeight = base.height;

  for (const scale of SCALE_LADDER) {
    let rung: BudgetImageSource | null = base;
    if (scale !== 1) {
      rung = resize(base,
        Math.max(1, Math.round(base.width * scale)),
        Math.max(1, Math.round(base.height * scale)));
    }
    if (!rung) break;
    for (const quality of QUALITY_LADDER) {
      attempts++;
      const payload = encodePayload(rung, quality, extra);
      const over = exceedsUtf8Budget(payload, budget);
      if (over === null) return payload;
      lastBytes = over;
      lastWidth = rung.width;
      lastHeight = rung.height;
    }
  }

  return JSON.stringify({
    error:
      `Image result does not fit the ${budget} byte bridge budget ` +
      `(smallest attempt: ${lastWidth}x${lastHeight} at quality ${QUALITY_LADDER[QUALITY_LADDER.length - 1]} ` +
      `= at least ${lastBytes} bytes, ${attempts} attempts). Retry with a tighter crop or a smaller tileSize.`,
    imageBudgetExceeded: {
      budgetBytes: budget,
      // Lower bound, not necessarily exact: a payload whose character count alone blows the
      // budget is rejected without being encoded (see exceedsUtf8Budget).
      bytesAtLeast: lastBytes,
      width: lastWidth,
      height: lastHeight,
      attempts,
    },
  });
}

/**
 * Final guard on the serialized outer frame, applied by the bridge plugin right
 * before `ws.send`.
 *
 * The image ladder budgets the payload; this budgets what actually goes on the wire,
 * including the wrapper, the escaping and every NON-image result (a huge
 * `web_node_tree`, a long error string). Returns the frame unchanged when it fits,
 * or a replacement frame carrying the same call id and a defined error — so an
 * oversized result costs one failed tool call instead of the connection.
 */
export function enforceEnvelopeBudget(
  frame: string,
  id: number,
  budgetBytes: number = WS_ENVELOPE_BUDGET_BYTES,
): string {
  const over = exceedsUtf8Budget(frame, budgetBytes);
  if (over === null) return frame;
  return JSON.stringify({
    type: 'result',
    id,
    error:
      `Result is ${over} bytes and exceeds the ${budgetBytes} byte bridge frame budget. ` +
      'It was dropped instead of sent, because the bridge peer answers an oversized frame ' +
      'by closing the connection. Request less data (narrower filter, fewer paths, tighter crop).',
  });
}

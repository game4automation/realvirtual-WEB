// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * agent-eye-monitor-store — the ring buffer behind the Agent Eye Monitor
 * filmstrip (plan-481).
 *
 * ## What it holds, and where it comes from
 *
 * Every image the bridge produces FOR THE AGENT leaves through one of exactly
 * two encoders — `canvasToRvImage` and `canvasesToRvImages`
 * (`plugins/mcp-bridge/rv-frame-capture.ts`). Both return ONE finished JSON
 * envelope, and that string — not the source canvas — is the only place where
 * the actually budgeted bytes, dimensions and MIME types live: the reduction
 * ladder in `rv-image-budget.ts` may have re-encoded at a lower quality, scaled
 * the frame down, or replaced it with an error object. So this store takes the
 * envelope, parses it ONCE, and never re-encodes anything (D-A1).
 *
 * ## What it deliberately does NOT claim
 *
 * The monitor shows what was PRODUCED for the agent, not what the agent
 * received. After the encode the bridge can still skip the send (closed socket)
 * or an outer envelope-budget failure can replace the frame. The UI is worded
 * accordingly; a real delivery receipt would need a coupling to `_sendResult`
 * and is explicitly out of scope for plan-481.
 *
 * ## Timing contract (D-A3) — why `setTimeout`, never `queueMicrotask`
 *
 * The tap sits in the hot path of every image tool. `recordAgentEyeEnvelope`
 * therefore does ONE thing synchronously: push the string onto a bounded queue.
 * All real work (parse, base64 → Blob, commit, notify React) runs in a
 * MACROTASK. A microtask would not do: the bridge awaits `method.apply(...)`,
 * so a microtask enqueued inside the tool runs BEFORE that continuation and
 * therefore before `_sendResult` — it would sit squarely in the response
 * latency it is supposed to stay out of. `setTimeout(..., 0)` runs after all
 * pending microtasks, i.e. after the answer is on the wire.
 *
 * ## Lifetime (D-A9 / D-A10)
 *
 * The store lives as long as the tab and survives panel unmounts and model
 * switches. A `generation` counter makes "clear" and "dispose" authoritative:
 * a macrotask from an older generation throws its result away instead of
 * resurrecting deleted images (which would also re-open the panel).
 * `disposeAgentEyeMonitor()` is called from `RVViewer.dispose()`.
 *
 * The store is LOCAL to this tab — in a multiuser session nobody sees anybody
 * else's captures.
 */

import { useSyncExternalStore } from 'react';

// ─── Model ──────────────────────────────────────────────────────────────

/** One channel inside a capture — 'beauty', 'idmask', 'depth', … */
export interface AgentEyeChannelImage {
  /** From the envelope's channel information, `'image'` when it carries none. */
  readonly channel: string;
  /** Object URL onto the decoded Blob — never a base64 `data:` string (D-A2). */
  readonly url: string;
  readonly mime: 'image/png' | 'image/jpeg';
  /** DECODED blob size in bytes — the unit the byte cap counts in (D-A4). */
  readonly bytes: number;
  /** From the envelope, not from the source canvas (D-A1). */
  readonly width: number;
  readonly height: number;
}

/** One tool call = one capture = one cell in the filmstrip. */
export interface AgentEyeFrame {
  /** Monotonic, never reused — this is what drives auto-open (D-A7). */
  readonly seq: number;
  /** `${seq}` — the React key. Never the array index. */
  readonly id: string;
  /** `Date.now()` at the moment the encoder handed the envelope over. */
  readonly at: number;
  /** The ACTUAL tool name, e.g. `web_view_sweep` rather than `web_eye` (D-A8). */
  readonly source: string;
  /** At least one. */
  readonly images: readonly AgentEyeChannelImage[];
  readonly totalBytes: number;
}

// ─── Limits ─────────────────────────────────────────────────────────────

/** Cell count cap. One capture = one cell, however many channels it carries. */
export const AGENT_EYE_MAX_FRAMES = 12;

/**
 * Byte cap, in DECODED blob bytes (D-A4).
 *
 * `IMAGE_PAYLOAD_BUDGET_BYTES` caps the SERIALIZED envelope at ~1.99 MB; the
 * decoded image data is roughly three quarters of that, so twelve maximal
 * captures land near 18 MB. A cap expressed in envelope bytes would therefore
 * never bite. 12 MB decoded does: large captures are evicted by size before
 * they are evicted by count.
 */
export const AGENT_EYE_BYTE_CAP = 12 * 1024 * 1024;

/**
 * How many UNPROCESSED envelopes may wait for their macrotask.
 *
 * A tool storm must not turn into unbounded retained memory; the oldest
 * unprocessed entry is dropped, and dropping it costs nothing because no Blob
 * has been created for it yet.
 */
export const AGENT_EYE_PENDING_LIMIT = 8;

/** Label for a capture whose call site forgot to pass its tool name (R1). */
const UNKNOWN_SOURCE = 'unknown';

let _byteCap = AGENT_EYE_BYTE_CAP;

/** Test seam for {@link AGENT_EYE_BYTE_CAP}. Pass nothing to restore the production value. */
export function setAgentEyeByteCapForTest(bytes?: number): void {
  _byteCap = typeof bytes === 'number' && bytes > 0 ? bytes : AGENT_EYE_BYTE_CAP;
}

// ─── State ──────────────────────────────────────────────────────────────

const EMPTY_FRAMES: readonly AgentEyeFrame[] = [];

/** Reference-stable snapshot — reassigned only on a real mutation (D-A6). */
let _frames: readonly AgentEyeFrame[] = EMPTY_FRAMES;
let _seq = 0;
let _unseen = 0;
let _generation = 0;
let _open = false;

interface PendingCapture {
  readonly json: string;
  readonly source: string;
  readonly at: number;
}

const _pending: PendingCapture[] = [];
let _timer: ReturnType<typeof setTimeout> | null = null;

const _listeners = new Set<() => void>();
const _openListeners = new Set<() => void>();

function emit(): void {
  for (const l of _listeners) l();
}

function emitOpen(): void {
  for (const l of _openListeners) l();
}

// ─── Intake (synchronous — enqueue ONLY, see D-A3) ──────────────────────

/**
 * Take one finished encoder envelope.
 *
 * Synchronously this does nothing but append to a bounded queue and arm a
 * macrotask; parsing and Blob conversion happen after the MCP answer is sent.
 * Never throws for a malformed envelope — a broken picture must not break a
 * tool call.
 */
export function recordAgentEyeEnvelope(envelopeJson: string, source?: string): void {
  if (typeof envelopeJson !== 'string' || envelopeJson.length === 0) return;
  _pending.push({
    json: envelopeJson,
    source: source && source.trim() ? source.trim() : UNKNOWN_SOURCE,
    at: Date.now(),
  });
  // Drop the OLDEST unprocessed capture, not the newest: the newest is the one
  // the human is waiting to see.
  while (_pending.length > AGENT_EYE_PENDING_LIMIT) _pending.shift();
  if (_timer === null) _timer = setTimeout(flushPending, 0);
}

// ─── Processing (macrotask — after the answer is on the wire) ───────────

function flushPending(): void {
  _timer = null;
  const generation = _generation;
  const batch = _pending.splice(0, _pending.length);
  for (const capture of batch) {
    // Per capture, so one malformed envelope does not swallow the rest (D-A9).
    try {
      commitCapture(capture, generation);
    } catch {
      /* a capture that cannot be shown is dropped, never rethrown */
    }
  }
}

function base64ToBlob(data: string, mime: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asMime(value: unknown): 'image/png' | 'image/jpeg' {
  return value === 'image/png' ? 'image/png' : 'image/jpeg';
}

/**
 * The exact field contract of the envelope (D-A1), verified against
 * `rv-image-budget.ts` `encodePayload` / `encodeMultiPayload`:
 *
 * ```
 * { __rvImage:  { data, mimeType, width, height, ...extra },
 *   __rvImages: [ { data, mimeType, width, height, channel }, … ] }   // optional
 * ```
 *
 * There is NO `extra` object in the JSON — `extra` is spread INTO `__rvImage`.
 * And only the FOLLOW-UP blocks carry `channel`; the first one never does, so
 * its name has to come from the `channels[]` sidecar that `web_eye` /
 * `web_view_ortho` spread in. Hence the index shift below.
 *
 * A top-level `error` is the budget encoder's "could not be reduced" payload and
 * must NOT produce a cell (F11). A `saveError`, by contrast, only says a project
 * write failed — the image itself is perfectly valid and must still be shown.
 */
function commitCapture(capture: PendingCapture, generation: number): void {
  if (generation !== _generation) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(capture.json) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  if (parsed['error'] !== undefined) return; // F11 — never a cell

  const first = parsed['__rvImage'] as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') return;
  const rest = Array.isArray(parsed['__rvImages'])
    ? (parsed['__rvImages'] as Record<string, unknown>[])
    : [];
  const sidecar = Array.isArray(first['channels']) ? (first['channels'] as unknown[]) : null;
  const blocks = [first, ...rest];

  // Transactional: convert EVERY channel first, commit only if all succeeded.
  const images: AgentEyeChannelImage[] = [];
  try {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const data = block['data'];
      if (typeof data !== 'string' || data.length === 0) throw new Error('empty image block');
      const mime = asMime(block['mimeType']);
      const blob = base64ToBlob(data, mime);
      const named = typeof block['channel'] === 'string' ? (block['channel'] as string) : null;
      const fromSidecar = typeof sidecar?.[i] === 'string' ? (sidecar[i] as string) : null;
      images.push({
        channel: named ?? fromSidecar ?? 'image',
        url: URL.createObjectURL(blob),
        mime,
        bytes: blob.size,
        width: asNumber(block['width']),
        height: asNumber(block['height']),
      });
    }
  } catch {
    // Partial failure: give back everything this capture already claimed (D-A9).
    for (const image of images) URL.revokeObjectURL(image.url);
    return;
  }

  // The conversion above is synchronous, but a listener could have cleared in
  // between on a future refactor — re-check before taking ownership.
  if (generation !== _generation) {
    for (const image of images) URL.revokeObjectURL(image.url);
    return;
  }

  _seq += 1;
  const frame: AgentEyeFrame = {
    seq: _seq,
    id: String(_seq),
    at: capture.at,
    source: capture.source,
    images,
    totalBytes: images.reduce((sum, image) => sum + image.bytes, 0),
  };

  const next = [frame, ..._frames];
  while (next.length > AGENT_EYE_MAX_FRAMES) revokeFrame(next.pop()!);
  let total = next.reduce((sum, f) => sum + f.totalBytes, 0);
  // Never evict down to nothing: a single capture larger than the whole cap is
  // still the one thing the human asked to see.
  while (next.length > 1 && total > _byteCap) {
    const dropped = next.pop()!;
    total -= dropped.totalBytes;
    revokeFrame(dropped);
  }

  _frames = next;
  _unseen += 1;
  emit();
}

function revokeFrame(frame: AgentEyeFrame): void {
  for (const image of frame.images) URL.revokeObjectURL(image.url);
}

// ─── Reads ──────────────────────────────────────────────────────────────

/** useSyncExternalStore subscription for the filmstrip. */
export function subscribeAgentEye(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Newest-first captures. Reference-stable between mutations (D-A6). */
export function getAgentEyeFrames(): readonly AgentEyeFrame[] {
  return _frames;
}

/**
 * The highest capture number ever committed in this session.
 *
 * Auto-open hangs off THIS, not off `frames.length`: with a full buffer the
 * length stays at 12 forever and a length-driven effect stops firing (D-A7).
 */
export function getAgentEyeLatestSeq(): number {
  return _seq;
}

/** Captures committed since the badge was last acknowledged. */
export function getAgentEyeUnseenCount(): number {
  return _unseen;
}

/** Reset the badge counter (the user has looked). */
export function markAgentEyeSeen(): void {
  if (_unseen === 0) return;
  _unseen = 0;
  emit();
}

// ─── Clear / dispose ────────────────────────────────────────────────────

/**
 * Drop the whole history — including captures that have not been processed yet.
 *
 * Bumping the generation is the point: without it a macrotask already in flight
 * would commit a capture the user just deleted, and the auto-open effect would
 * pop the panel open again right after they cleared it (D-A9).
 */
export function clearAgentEyeFrames(): void {
  _generation += 1;
  _pending.length = 0;
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
  const had = _frames.length > 0 || _unseen > 0;
  for (const frame of _frames) revokeFrame(frame);
  _frames = EMPTY_FRAMES;
  _unseen = 0;
  if (had) emit();
}

/**
 * Viewer teardown (D-A10) — called from `RVViewer.dispose()`, never from the
 * panel (which unmounts far earlier and would take the history with it).
 *
 * Does three things: kill the pending timer, invalidate everything still queued
 * through the same generation `clearAgentEyeFrames()` uses, and revoke every
 * live object URL. After this a stray macrotask can create neither an object URL
 * nor a store commit.
 */
export function disposeAgentEyeMonitor(): void {
  clearAgentEyeFrames();
  _seq = 0;
  if (_open) { _open = false; emitOpen(); }
}

/** Full reset for tests — history, sequence, open state and byte cap. */
export function resetAgentEyeMonitorForTest(): void {
  disposeAgentEyeMonitor();
  setAgentEyeByteCapForTest();
}

// ─── Panel open state (shared by badge and auto-open, SOL round-1 finding 4) ──

export function subscribeAgentEyeOpen(listener: () => void): () => void {
  _openListeners.add(listener);
  return () => { _openListeners.delete(listener); };
}

export function isAgentEyeMonitorOpen(): boolean {
  return _open;
}

/** Open request — used by the badge AND by the auto-open effect. */
export function openAgentEyeMonitor(): void {
  if (_open) return;
  _open = true;
  emitOpen();
}

export function closeAgentEyeMonitor(): void {
  if (!_open) return;
  _open = false;
  emitOpen();
}

export function toggleAgentEyeMonitor(): void {
  _open = !_open;
  emitOpen();
}

// ─── Hooks ──────────────────────────────────────────────────────────────

export function useAgentEyeFrames(): readonly AgentEyeFrame[] {
  return useSyncExternalStore(subscribeAgentEye, getAgentEyeFrames, getAgentEyeFrames);
}

export function useAgentEyeLatestSeq(): number {
  return useSyncExternalStore(subscribeAgentEye, getAgentEyeLatestSeq, getAgentEyeLatestSeq);
}

export function useAgentEyeUnseenCount(): number {
  return useSyncExternalStore(subscribeAgentEye, getAgentEyeUnseenCount, getAgentEyeUnseenCount);
}

export function useAgentEyeMonitorOpen(): boolean {
  return useSyncExternalStore(subscribeAgentEyeOpen, isAgentEyeMonitorOpen, isAgentEyeMonitorOpen);
}

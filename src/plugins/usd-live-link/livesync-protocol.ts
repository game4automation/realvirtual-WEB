// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * livesync-protocol — wire format v1 of the USD live link (plan-637 §2.3).
 *
 * realvirtual WEB → Kit extension `realvirtual.livesync`, one direction:
 *
 * - `hello` and every answer of the extension (`ack`) are TEXT frames (JSON).
 * - Everything else is a BINARY frame, little endian, byte 0 = message type,
 *   then `u32 session` (the mount generation). The extension drops binary
 *   frames of an older session.
 *
 * | Type | Layout after the type byte |
 * |------|----------------------------|
 * | 0x01 mountBegin | u32 session, u32 compressedBytes, u32 rawBytes, u32 chunkCount, UTF-8 JSON {@link MountMeta} |
 * | 0x02 mountChunk | u32 session, u32 index, bytes |
 * | 0x03 frame      | u32 session, u32 seq, u32 n, n × (u32 nodeIndex, f32[16] local), u32 m, m × (u32 muId, f32[16] world) |
 * | 0x04 muSpawn    | u32 session, u32 muId, u32 templateIndex, f32[16] world |
 * | 0x05 muDelete   | u32 session, u32 muId |
 * | 0x06 reset      | u32 session |
 *
 * Matrices are three.js `Matrix4.elements` (column-major) — the same 16
 * numbers as a USD `matrix4d` written row by row (row-vector convention), so
 * neither side transposes anything.
 *
 * The Python twin is `integrations/omniverse-kit/exts/realvirtual.livesync/
 * realvirtual/livesync/protocol.py`; both are pinned to the same golden bytes
 * (`integrations/omniverse-kit/tests/golden_v1.json`).
 */

/** Protocol version carried in `hello.v`. */
export const LIVESYNC_PROTOCOL_VERSION = 1;

/** Binary message types (byte 0). */
export const LIVESYNC_MSG = {
  MOUNT_BEGIN: 0x01,
  MOUNT_CHUNK: 0x02,
  FRAME: 0x03,
  MU_SPAWN: 0x04,
  MU_DELETE: 0x05,
  RESET: 0x06,
} as const;

/** Limits the extension enforces (F8). The client stays below them. */
export const LIVESYNC_LIMITS = {
  /** Largest accepted mount chunk payload. */
  maxChunkBytes: 512 * 1024,
  /** Largest accepted compressed (wire) mount size. */
  maxCompressedBytes: 256 * 1024 * 1024,
  /** Largest accepted unpacked mount size. */
  maxRawBytes: 1024 * 1024 * 1024,
  /** Frames the extension buffers between two app updates. */
  maxQueuedFrames: 256,
} as const;

/** Chunk size the client uploads with (half the extension's limit). */
export const MOUNT_CHUNK_BYTES = 256 * 1024;

/** Floats per matrix. */
export const MATRIX_FLOATS = 16;

/** Bytes of one (u32 index, f32[16]) entry in a frame. */
export const FRAME_ENTRY_BYTES = 4 + MATRIX_FLOATS * 4;

/** JSON part of `mountBegin`. */
export interface MountMeta {
  /** How the chunk bytes are encoded on the wire. */
  encoding: 'gzip' | 'identity';
  /** Prim path (inside the uploaded file, `/Root/...`) of every node index. */
  nodes: string[];
  /** Prim path of every MU template; `muSpawn.templateIndex` indexes this list. */
  templates: string[];
  /** MUs that are part of the snapshot: moved as existing prims, never spawned. */
  preplaced: Array<{ muId: number; nodeIndex: number }>;
}

/** `hello` — the first frame after the socket opened. */
export interface HelloMessage {
  v: number;
  token: string;
  client: 'realvirtual-web';
  rateHz: number;
}

/** Text answer of the extension. */
export interface LiveSyncAck {
  type: 'ready' | 'mounted' | 'error';
  session?: number;
  message?: string;
  appliedHz?: number;
  /** `ready` only (extension >= 0.2.0): version of the extension, `extension.toml`. */
  extVersion?: string;
  /** `ready` only (extension >= 0.2.0): protocol the extension speaks; missing = 1. */
  protocol?: number;
}

// ─── Text frames ─────────────────────────────────────────────────────────

/** Encode the `hello` text frame. */
export function encodeHello(token: string, rateHz: number): string {
  const msg: HelloMessage = { v: LIVESYNC_PROTOCOL_VERSION, token, client: 'realvirtual-web', rateHz };
  return JSON.stringify(msg);
}

/** Parse an extension answer; null for anything that is not a known ack. */
export function parseAck(text: string): LiveSyncAck | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.type !== 'ready' && o.type !== 'mounted' && o.type !== 'error') return null;
  const ack: LiveSyncAck = { type: o.type };
  if (typeof o.session === 'number') ack.session = o.session;
  if (typeof o.message === 'string') ack.message = o.message;
  if (typeof o.appliedHz === 'number') ack.appliedHz = o.appliedHz;
  if (typeof o.extVersion === 'string') ack.extVersion = o.extVersion;
  if (typeof o.protocol === 'number') ack.protocol = o.protocol;
  return ack;
}

// ─── Binary frames ───────────────────────────────────────────────────────

const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();

function header(type: number, session: number, extraBytes: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(5 + extraBytes);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, type);
  view.setUint32(1, session >>> 0, true);
  return { bytes, view };
}

function writeMatrix(view: DataView, offset: number, m: ArrayLike<number>): void {
  for (let i = 0; i < MATRIX_FLOATS; i++) view.setFloat32(offset + i * 4, m[i], true);
}

/** Encode `mountBegin`. */
export function encodeMountBegin(
  session: number,
  compressedBytes: number,
  rawBytes: number,
  chunkCount: number,
  meta: MountMeta,
): Uint8Array {
  const json = _textEncoder.encode(JSON.stringify(meta));
  const { bytes, view } = header(LIVESYNC_MSG.MOUNT_BEGIN, session, 12 + json.byteLength);
  view.setUint32(5, compressedBytes >>> 0, true);
  view.setUint32(9, rawBytes >>> 0, true);
  view.setUint32(13, chunkCount >>> 0, true);
  bytes.set(json, 17);
  return bytes;
}

/** Encode one `mountChunk`. */
export function encodeMountChunk(session: number, index: number, payload: Uint8Array): Uint8Array {
  const { bytes, view } = header(LIVESYNC_MSG.MOUNT_CHUNK, session, 4 + payload.byteLength);
  view.setUint32(5, index >>> 0, true);
  bytes.set(payload, 9);
  return bytes;
}

/** Encode `muSpawn`. */
export function encodeMuSpawn(session: number, muId: number, templateIndex: number, world: ArrayLike<number>): Uint8Array {
  const { bytes, view } = header(LIVESYNC_MSG.MU_SPAWN, session, 8 + MATRIX_FLOATS * 4);
  view.setUint32(5, muId >>> 0, true);
  view.setUint32(9, templateIndex >>> 0, true);
  writeMatrix(view, 13, world);
  return bytes;
}

/** Encode `muDelete`. */
export function encodeMuDelete(session: number, muId: number): Uint8Array {
  const { bytes, view } = header(LIVESYNC_MSG.MU_DELETE, session, 4);
  view.setUint32(5, muId >>> 0, true);
  return bytes;
}

/** Encode `reset`. */
export function encodeReset(session: number): Uint8Array {
  return header(LIVESYNC_MSG.RESET, session, 0).bytes;
}

/**
 * Reusable writer for `frame` messages — no allocation per frame once the
 * capacity is reached. Nodes are written first, then MUs:
 * `begin → writeNode* → writeMu* → finish`.
 */
export class FrameWriter {
  private _buf: Uint8Array;
  private _view: DataView;
  private _offset = 0;
  private _n = 0;
  private _m = 0;
  private _muCountOffset = -1;

  constructor(initialEntries = 64) {
    this._buf = new Uint8Array(17 + Math.max(1, initialEntries) * FRAME_ENTRY_BYTES);
    this._view = new DataView(this._buf.buffer);
  }

  /** Nodes written since {@link begin}. */
  get nodeCount(): number { return this._n; }
  /** MUs written since {@link begin}. */
  get muCount(): number { return this._m; }
  /** The backing buffer (exposed for the allocation test). */
  get buffer(): ArrayBuffer { return this._buf.buffer as ArrayBuffer; }

  begin(session: number, seq: number): void {
    this._view.setUint8(0, LIVESYNC_MSG.FRAME);
    this._view.setUint32(1, session >>> 0, true);
    this._view.setUint32(5, seq >>> 0, true);
    this._offset = 13; // n is written at 9 by finish / the first MU
    this._n = 0;
    this._m = 0;
    this._muCountOffset = -1;
  }

  writeNode(index: number, m: ArrayLike<number>): void {
    if (this._muCountOffset >= 0) throw new Error('FrameWriter: nodes must be written before MUs');
    this.ensure(FRAME_ENTRY_BYTES + 4);
    this._view.setUint32(this._offset, index >>> 0, true);
    writeMatrix(this._view, this._offset + 4, m);
    this._offset += FRAME_ENTRY_BYTES;
    this._n++;
  }

  writeMu(muId: number, m: ArrayLike<number>): void {
    this.openMuSection();
    this.ensure(FRAME_ENTRY_BYTES);
    this._view.setUint32(this._offset, muId >>> 0, true);
    writeMatrix(this._view, this._offset + 4, m);
    this._offset += FRAME_ENTRY_BYTES;
    this._m++;
  }

  /** The finished frame — a VIEW on the reused buffer, valid until the next `begin`. */
  finish(): Uint8Array {
    this.openMuSection();
    this._view.setUint32(this._muCountOffset, this._m, true);
    return this._buf.subarray(0, this._offset);
  }

  private openMuSection(): void {
    if (this._muCountOffset >= 0) return;
    this.ensure(4);
    this._view.setUint32(9, this._n, true);
    this._muCountOffset = this._offset;
    this._offset += 4;
  }

  private ensure(extra: number): void {
    if (this._offset + extra <= this._buf.byteLength) return;
    const next = new Uint8Array(Math.max(this._buf.byteLength * 2, this._offset + extra));
    next.set(this._buf.subarray(0, this._offset));
    this._buf = next;
    this._view = new DataView(next.buffer);
  }
}

// ─── Decoding (tests, diagnostics) ───────────────────────────────────────

/** A decoded binary message. */
export type DecodedMessage =
  | { type: 'mountBegin'; session: number; compressedBytes: number; rawBytes: number; chunkCount: number; meta: MountMeta }
  | { type: 'mountChunk'; session: number; index: number; payload: Uint8Array }
  | { type: 'frame'; session: number; seq: number;
    nodes: Array<{ index: number; m: number[] }>; mus: Array<{ muId: number; m: number[] }> }
  | { type: 'muSpawn'; session: number; muId: number; templateIndex: number; m: number[] }
  | { type: 'muDelete'; session: number; muId: number }
  | { type: 'reset'; session: number };

function readMatrix(view: DataView, offset: number): number[] {
  const out = new Array<number>(MATRIX_FLOATS);
  for (let i = 0; i < MATRIX_FLOATS; i++) out[i] = view.getFloat32(offset + i * 4, true);
  return out;
}

/** Decode one binary message (throws on a malformed one). */
export function decodeMessage(data: Uint8Array): DecodedMessage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 5) throw new Error('message too short');
  const type = view.getUint8(0);
  const session = view.getUint32(1, true);
  switch (type) {
    case LIVESYNC_MSG.MOUNT_BEGIN: {
      const meta = JSON.parse(_textDecoder.decode(data.subarray(17))) as MountMeta;
      return {
        type: 'mountBegin', session,
        compressedBytes: view.getUint32(5, true), rawBytes: view.getUint32(9, true),
        chunkCount: view.getUint32(13, true), meta,
      };
    }
    case LIVESYNC_MSG.MOUNT_CHUNK:
      return { type: 'mountChunk', session, index: view.getUint32(5, true), payload: data.subarray(9) };
    case LIVESYNC_MSG.FRAME: {
      const seq = view.getUint32(5, true);
      const n = view.getUint32(9, true);
      let o = 13;
      const nodes: Array<{ index: number; m: number[] }> = [];
      for (let i = 0; i < n; i++, o += FRAME_ENTRY_BYTES) nodes.push({ index: view.getUint32(o, true), m: readMatrix(view, o + 4) });
      const m = view.getUint32(o, true);
      o += 4;
      const mus: Array<{ muId: number; m: number[] }> = [];
      for (let i = 0; i < m; i++, o += FRAME_ENTRY_BYTES) mus.push({ muId: view.getUint32(o, true), m: readMatrix(view, o + 4) });
      if (o !== data.byteLength) throw new Error('frame length mismatch');
      return { type: 'frame', session, seq, nodes, mus };
    }
    case LIVESYNC_MSG.MU_SPAWN:
      return {
        type: 'muSpawn', session, muId: view.getUint32(5, true),
        templateIndex: view.getUint32(9, true), m: readMatrix(view, 13),
      };
    case LIVESYNC_MSG.MU_DELETE:
      return { type: 'muDelete', session, muId: view.getUint32(5, true) };
    case LIVESYNC_MSG.RESET:
      return { type: 'reset', session };
    default:
      throw new Error(`unknown message type ${type}`);
  }
}

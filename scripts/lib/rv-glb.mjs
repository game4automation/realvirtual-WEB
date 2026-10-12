// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb.mjs — the ONE GLB container reader/writer for the Node tooling
 * (plan-587 Phase 1).
 *
 * Before this file the tooling opened the GLB container at seven places by
 * hand, with three different answers to the padding question and one fassung
 * that checked neither magic nor chunk type (so a non-GLB file failed with a
 * JSON parse error instead of saying what was wrong). Everything about the
 * container lives here now.
 *
 * Two deliberate properties, both from the plan-587 spike (§4b M1):
 *
 * 1. `rest` is the byte range from `restOffset` to the end of the file,
 *    VERBATIM — the BIN chunk AND anything behind it. `rv-sign-glb.mjs` has
 *    always treated that range as one opaque block, and an API that handed
 *    back a parsed BIN view only would be a silent data loss for every file
 *    that carries trailing chunks.
 * 2. `writeGlb` promises CHUNK STRUCTURE AND PADDING, not bytes. It
 *    re-serialises the JSON compactly (`JSON.stringify`), so byte identity
 *    only holds for input whose JSON chunk was already compact — which is
 *    exactly the round-trip the signer relies on.
 *
 * Padding: the writers in this repo pad the JSON chunk with `0x20`
 * (`rv-sign-glb.mjs`), others in the wild pad with `0x00`. The read side
 * therefore strips BOTH as padding, so a space-padded and a NUL-padded file
 * give the same `jsonText` and the same `json` — one answer instead of three.
 *
 * Zero dependencies: Node built-ins only.
 */

//! GLB container magic, 'glTF' as a little-endian uint32.
export const GLB_MAGIC = 0x46546c67;

//! The only container version this reader accepts.
export const GLB_VERSION = 2;

//! Chunk type of the structural JSON chunk, 'JSON' as a little-endian uint32.
export const CHUNK_JSON = 0x4e4f534a;

//! Chunk type of the binary buffer chunk, 'BIN\0' as a little-endian uint32.
export const CHUNK_BIN = 0x004e4942;

const GLB_HEADER_LENGTH = 12;
const CHUNK_HEADER_LENGTH = 8;
const JSON_CHUNK_OFFSET = GLB_HEADER_LENGTH + CHUNK_HEADER_LENGTH; // 20

//! Trailing padding of a JSON chunk: spaces (this repo) or NULs (other writers).
const JSON_PADDING = /[\u0020\u0000]+$/u;

function asBuffer(input, label) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError(`${label} must be a Buffer, Uint8Array or ArrayBuffer`);
}

function hex32(value) {
  return `0x${value.toString(16).padStart(8, '0')}`;
}

//! Walks the chunk sequence from `offset` and refuses a chunk whose declared
//! length reaches past the end of the file. A tail shorter than a chunk header
//! is tolerated (it cannot be a chunk and stays part of `rest` verbatim).
function verifyChunkLengths(bytes, offset) {
  let at = offset;
  while (bytes.length - at >= CHUNK_HEADER_LENGTH) {
    const length = bytes.readUInt32LE(at);
    const type = bytes.readUInt32LE(at + 4);
    const end = at + CHUNK_HEADER_LENGTH + length;
    if (end > bytes.length) {
      throw new Error(
        `truncated GLB: chunk ${hex32(type)} at offset ${at} declares ${length} bytes `
        + `but only ${bytes.length - at - CHUNK_HEADER_LENGTH} remain`,
      );
    }
    at = end;
  }
}

//! Reads a GLB container and returns its JSON chunk plus everything behind it.
//!
//! Checks magic, version, the first chunk's type and ALL declared lengths
//! before touching any content, so a non-GLB file reports "not a GLB" instead
//! of a JSON parse error and a truncated file is refused instead of read into
//! the void.
//!
//! Returns `{ json, jsonText, rest, restOffset }`:
//! - `json` — the parsed JSON chunk
//! - `jsonText` — the decoded JSON chunk with its trailing padding removed
//! - `rest` — a Buffer with the VERBATIM bytes from `restOffset` to the end of
//!   the file (the BIN chunk and any trailing chunk), ready to be handed back
//!   to `writeGlb` unchanged
//! - `restOffset` — byte offset at which `rest` starts
export function readGlb(buffer) {
  const bytes = asBuffer(buffer, 'readGlb(buffer)');

  if (bytes.length < JSON_CHUNK_OFFSET) {
    throw new Error(
      `not a GLB: ${bytes.length} bytes are too few for a GLB header `
      + `(${JSON_CHUNK_OFFSET} required)`,
    );
  }

  const magic = bytes.readUInt32LE(0);
  if (magic !== GLB_MAGIC) {
    throw new Error(`not a GLB: magic is ${hex32(magic)}, expected ${hex32(GLB_MAGIC)}`);
  }

  const version = bytes.readUInt32LE(4);
  if (version !== GLB_VERSION) {
    throw new Error(`unsupported GLB version ${version}, expected ${GLB_VERSION}`);
  }

  const declaredLength = bytes.readUInt32LE(8);
  if (declaredLength > bytes.length) {
    throw new Error(
      `truncated GLB: header declares ${declaredLength} bytes, file has ${bytes.length}`,
    );
  }
  if (declaredLength < bytes.length) {
    throw new Error(
      `malformed GLB: header declares ${declaredLength} bytes, file has ${bytes.length}`,
    );
  }

  const jsonLength = bytes.readUInt32LE(12);
  const jsonType = bytes.readUInt32LE(16);
  if (jsonType !== CHUNK_JSON) {
    throw new Error(
      `malformed GLB: first chunk is ${hex32(jsonType)}, expected JSON ${hex32(CHUNK_JSON)}`,
    );
  }
  if (jsonLength === 0) {
    throw new Error('malformed GLB: JSON chunk is empty');
  }
  const restOffset = JSON_CHUNK_OFFSET + jsonLength;
  if (restOffset > bytes.length) {
    throw new Error(
      `truncated GLB: JSON chunk declares ${jsonLength} bytes `
      + `but only ${bytes.length - JSON_CHUNK_OFFSET} remain`,
    );
  }

  verifyChunkLengths(bytes, restOffset);

  const jsonText = bytes
    .subarray(JSON_CHUNK_OFFSET, restOffset)
    .toString('utf8')
    .replace(JSON_PADDING, '');

  let json;
  try {
    json = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`malformed GLB: JSON chunk is not valid JSON (${error.message})`);
  }

  return { json, jsonText, rest: bytes.subarray(restOffset), restOffset };
}

//! Writes a GLB container from a JSON chunk value and the verbatim rest.
//!
//! `json` is serialised compactly and the JSON chunk is padded to a multiple
//! of four bytes with `0x20`; `rest` (the BIN chunk and anything behind it, as
//! handed out by `readGlb`) is appended UNCHANGED and the total length is
//! written into the header.
//!
//! The promise is chunk structure and padding, NOT byte identity: a file whose
//! JSON chunk was not already compact comes back shorter or longer. Byte
//! identity holds for `writeGlb(readGlb(x).json, readGlb(x).rest)` exactly
//! when `x`'s JSON chunk was `JSON.stringify` output padded with `0x20`.
export function writeGlb(json, rest = new Uint8Array(0)) {
  const compact = Buffer.from(JSON.stringify(json), 'utf8');
  if (compact.length === 0) {
    throw new Error('writeGlb(json): json must serialise to a non-empty JSON document');
  }
  const paddedLength = (compact.length + 3) & ~3;
  const jsonChunk = Buffer.alloc(paddedLength, 0x20);
  compact.copy(jsonChunk);

  const restBytes = asBuffer(rest, 'writeGlb(json, rest)');
  const out = Buffer.alloc(JSON_CHUNK_OFFSET + paddedLength + restBytes.length);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(GLB_VERSION, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(paddedLength, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  jsonChunk.copy(out, JSON_CHUNK_OFFSET);
  restBytes.copy(out, JSON_CHUNK_OFFSET + paddedLength);
  return out;
}

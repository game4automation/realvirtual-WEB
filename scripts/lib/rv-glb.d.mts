// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for rv-glb.mjs (plan-587). */

/** GLB container magic, 'glTF' as a little-endian uint32. */
export const GLB_MAGIC: number;

/** The only container version the reader accepts. */
export const GLB_VERSION: number;

/** Chunk type of the structural JSON chunk, 'JSON' as a little-endian uint32. */
export const CHUNK_JSON: number;

/** Chunk type of the binary buffer chunk, 'BIN\0' as a little-endian uint32. */
export const CHUNK_BIN: number;

export interface ReadGlbResult {
  /** The parsed JSON chunk. */
  json: any;
  /** The decoded JSON chunk with its trailing padding (0x20 / 0x00) removed. */
  jsonText: string;
  /**
   * The VERBATIM bytes from `restOffset` to the end of the file — the BIN
   * chunk AND anything behind it. Hand it back to `writeGlb` unchanged.
   */
  rest: Buffer;
  /** Byte offset at which `rest` starts (20 + declared JSON chunk length). */
  restOffset: number;
}

/**
 * Reads a GLB container. Checks magic, version, the first chunk's type and all
 * declared lengths, so a non-GLB file throws an error containing "not a GLB"
 * instead of a JSON parse error, and a truncated file is refused.
 */
export function readGlb(buffer: Buffer | Uint8Array | ArrayBuffer): ReadGlbResult;

/**
 * Writes a GLB container: `json` serialised compactly, the JSON chunk padded
 * to 4 bytes with 0x20, `rest` appended verbatim, total length in the header.
 *
 * Promises chunk structure and padding, NOT byte identity — byte identity
 * holds only for input whose JSON chunk already was compact `JSON.stringify`
 * output padded with 0x20.
 */
export function writeGlb(json: unknown, rest?: Buffer | Uint8Array | ArrayBuffer): Buffer;

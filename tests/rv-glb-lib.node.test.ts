// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The ONE GLB container reader (`scripts/lib/rv-glb.mjs`, plan-587 Phase 1).
 *
 * Before it, seven hand-written readers answered the padding question three
 * different ways and one of them checked neither magic nor chunk type — a
 * non-GLB file failed with a JSON parse error instead of saying "not a GLB"
 * (`build-welding-plc-glb.mjs:38`). These tests nail down the four things the
 * plan asks for: the normal case, the named refusals, one answer for both
 * padding variants, and the round-trip.
 *
 * All fixtures are built programmatically — no binary fixture is checked in.
 */

import { describe, it, expect } from 'vitest';
import {
  readGlb,
  writeGlb,
  GLB_MAGIC,
  GLB_VERSION,
  CHUNK_JSON,
  CHUNK_BIN,
} from '../scripts/lib/rv-glb.mjs';

const HEADER = 12;
const CHUNK_HEADER = 8;
const JSON_OFFSET = HEADER + CHUNK_HEADER; // 20

/** A chunk header + payload, padded to 4 bytes with `padByte`. */
function chunk(type: number, payload: Buffer, padByte: number): Buffer {
  const paddedLength = (payload.length + 3) & ~3;
  const body = Buffer.alloc(paddedLength, padByte);
  payload.copy(body);
  const head = Buffer.alloc(CHUNK_HEADER);
  head.writeUInt32LE(paddedLength, 0);
  head.writeUInt32LE(type, 4);
  return Buffer.concat([head, body]);
}

/**
 * Assembles a GLB from a JSON text and an optional BIN payload.
 *
 * `jsonPadByte` picks the padding variant (0x20 = this repo's writers,
 * 0x00 = other writers in the wild).
 */
function buildGlb(
  jsonText: string,
  options: { bin?: Buffer; jsonPadByte?: number } = {},
): Buffer {
  const jsonChunk = chunk(CHUNK_JSON, Buffer.from(jsonText, 'utf8'), options.jsonPadByte ?? 0x20);
  const binChunk = options.bin ? chunk(CHUNK_BIN, options.bin, 0x00) : Buffer.alloc(0);
  const header = Buffer.alloc(HEADER);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(GLB_VERSION, 4);
  header.writeUInt32LE(HEADER + jsonChunk.length + binChunk.length, 8);
  return Buffer.concat([header, jsonChunk, binChunk]);
}

/** The compact form the writers produce — three characters, so it needs padding. */
const SCENE = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0], extras: { rv: 1 } }] };
const COMPACT = JSON.stringify(SCENE);

describe('rv-glb.mjs — readGlb', () => {
  it('Test_ReadGlb_ValidFile_ReturnsJsonAndBin', () => {
    const bin = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const glb = buildGlb(COMPACT, { bin });

    const read = readGlb(glb);

    expect(read.json).toEqual(SCENE);
    expect(read.jsonText).toBe(COMPACT);
    // restOffset is behind the padded JSON chunk; `rest` is the verbatim tail,
    // BIN chunk header included (plan-587 §4b M1 — the signer treats it as one
    // opaque block, so the API must hand it back unparsed).
    const paddedJsonLength = (COMPACT.length + 3) & ~3;
    expect(read.restOffset).toBe(JSON_OFFSET + paddedJsonLength);
    expect(Buffer.from(read.rest)).toEqual(glb.subarray(read.restOffset));
    expect(read.rest.length).toBe(CHUNK_HEADER + bin.length);
    expect(Buffer.from(read.rest).readUInt32LE(4)).toBe(CHUNK_BIN);
    expect(Buffer.from(read.rest).subarray(CHUNK_HEADER)).toEqual(bin);
  });

  it('keeps trailing bytes behind the BIN chunk in `rest`', () => {
    const bin = Buffer.from([9, 9, 9, 9]);
    const trailing = chunk(0x4f4f462a, Buffer.from('tail'), 0x00);
    const base = buildGlb(COMPACT, { bin });
    const glb = Buffer.concat([base, trailing]);
    glb.writeUInt32LE(glb.length, 8);

    const read = readGlb(glb);

    expect(Buffer.from(read.rest)).toEqual(glb.subarray(read.restOffset));
    expect(read.rest.length).toBe(CHUNK_HEADER + bin.length + trailing.length);
  });

  it('accepts a JSON-only GLB (no BIN chunk)', () => {
    const read = readGlb(buildGlb(COMPACT));
    expect(read.json).toEqual(SCENE);
    expect(read.rest.length).toBe(0);
  });

  it('Test_ReadGlb_NotAGlb_FailsWithNamedError', () => {
    // A plain JSON file is the realistic confusion: the lax reader sliced it
    // and handed the garbage to JSON.parse.
    const plainJson = Buffer.from(`${COMPACT}                                   `, 'utf8');
    expect(() => readGlb(plainJson)).toThrow(/not a GLB/);
    // And it must NOT be a JSON parse failure.
    let message = '';
    try {
      readGlb(plainJson);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('not a GLB');
    expect(message).not.toMatch(/JSON/i);

    // Too short to even hold a header.
    expect(() => readGlb(Buffer.from('glTF', 'utf8'))).toThrow(/not a GLB/);

    // Right length, wrong magic.
    const wrongMagic = buildGlb(COMPACT);
    wrongMagic.writeUInt32LE(0x12345678, 0);
    expect(() => readGlb(wrongMagic)).toThrow(/not a GLB/);
  });

  it('refuses an unsupported container version with a named error', () => {
    const glb = buildGlb(COMPACT);
    glb.writeUInt32LE(3, 4);
    expect(() => readGlb(glb)).toThrow(/unsupported GLB version 3/);
  });

  it('refuses a first chunk that is not JSON with a named error', () => {
    const glb = buildGlb(COMPACT);
    glb.writeUInt32LE(CHUNK_BIN, 16);
    expect(() => readGlb(glb)).toThrow(/first chunk is 0x004e4942, expected JSON/);
  });

  it('Test_ReadGlb_TruncatedChunk_Refuses', () => {
    // JSON chunk declares more than the file holds. The header total length is
    // kept consistent with the real file size so the JSON-chunk guard is what
    // fires — without it, `subarray` would silently read into the void.
    const truncatedJson = buildGlb(COMPACT, { bin: Buffer.from([1, 2, 3, 4]) });
    truncatedJson.writeUInt32LE(truncatedJson.length, 8);
    truncatedJson.writeUInt32LE(truncatedJson.length, 12);
    expect(() => readGlb(truncatedJson)).toThrow(/truncated GLB: JSON chunk declares/);

    // BIN chunk declares more than remains.
    const truncatedBin = buildGlb(COMPACT, { bin: Buffer.from([1, 2, 3, 4]) });
    const restOffset = readGlb(buildGlb(COMPACT, { bin: Buffer.from([1, 2, 3, 4]) })).restOffset;
    truncatedBin.writeUInt32LE(4096, restOffset);
    expect(() => readGlb(truncatedBin)).toThrow(/truncated GLB: chunk 0x004e4942/);

    // Header total length larger than the file: the file was cut short.
    const cut = buildGlb(COMPACT, { bin: Buffer.from([1, 2, 3, 4]) }).subarray(0, JSON_OFFSET + 4);
    expect(() => readGlb(cut)).toThrow(/truncated GLB: header declares/);

    // An empty JSON chunk is refused instead of producing a JSON parse error.
    const empty = buildGlb(COMPACT);
    empty.writeUInt32LE(0, 12);
    expect(() => readGlb(empty)).toThrow(/JSON chunk is empty/);
  });

  it('Test_ReadGlb_PaddingVariants_OneAnswer', () => {
    // `{"a":1}` is 7 bytes, so every variant really is padded by one byte.
    const text = JSON.stringify({ a: 1 });
    expect(text.length % 4).not.toBe(0);

    const spacePadded = readGlb(buildGlb(text, { jsonPadByte: 0x20 }));
    const nulPadded = readGlb(buildGlb(text, { jsonPadByte: 0x00 }));

    // ONE answer for both — this is the rule the three hand-written readers
    // disagreed about (`/ +$/` vs `/\0+$/u`+trimEnd vs nothing at all).
    expect(spacePadded.jsonText).toBe(text);
    expect(nulPadded.jsonText).toBe(text);
    expect(nulPadded.json).toEqual(spacePadded.json);
    expect(nulPadded.restOffset).toBe(spacePadded.restOffset);

    // Mixed padding and an already-aligned chunk behave the same way.
    const mixed = readGlb(buildGlb(`${text} \u0000\u0000`.slice(0, 11), { jsonPadByte: 0x20 }));
    expect(mixed.json).toEqual({ a: 1 });
    const aligned = readGlb(buildGlb(JSON.stringify({ ab: 1 })));
    expect(aligned.jsonText).toBe('{"ab":1}');
  });
});

describe('rv-glb.mjs — writeGlb', () => {
  it('Test_WriteGlb_RoundTrip_ByteIdentical', () => {
    // Byte identity is promised ONLY for the path without JSON
    // re-serialisation: a file whose JSON chunk already is `JSON.stringify`
    // output padded with 0x20. That is exactly what `rv-sign-glb.mjs`
    // produces, so this is the round-trip that matters.
    const glb = buildGlb(COMPACT, { bin: Buffer.from([7, 7, 7, 7, 7, 7, 7, 7]) });
    const read = readGlb(glb);

    expect(Buffer.from(writeGlb(read.json, read.rest))).toEqual(glb);

    // Including a trailing chunk behind BIN — `rest` carries it verbatim.
    const withTail = Buffer.concat([glb, chunk(0x4f4f462a, Buffer.from('tail'), 0x00)]);
    withTail.writeUInt32LE(withTail.length, 8);
    const readTail = readGlb(withTail);
    expect(Buffer.from(writeGlb(readTail.json, readTail.rest))).toEqual(withTail);
  });

  it('promises chunk structure and padding, not bytes, once the JSON is re-serialised', () => {
    // A pretty-printed JSON chunk cannot come back byte-identical — writeGlb
    // serialises compactly. What IS promised: a valid container, the same JSON
    // value, the same verbatim rest, a 4-byte-aligned JSON chunk padded with
    // 0x20, and a header length that matches the file.
    const pretty = buildGlb(JSON.stringify(SCENE, null, 2), { bin: Buffer.from([4, 4, 4, 4]) });
    const read = readGlb(pretty);

    const out = Buffer.from(writeGlb(read.json, read.rest));
    expect(out.length).not.toBe(pretty.length);

    const reread = readGlb(out);
    expect(reread.json).toEqual(SCENE);
    expect(Buffer.from(reread.rest)).toEqual(Buffer.from(read.rest));

    expect(out.readUInt32LE(0)).toBe(GLB_MAGIC);
    expect(out.readUInt32LE(4)).toBe(GLB_VERSION);
    expect(out.readUInt32LE(8)).toBe(out.length);
    expect(out.readUInt32LE(16)).toBe(CHUNK_JSON);
    const jsonLength = out.readUInt32LE(12);
    expect(jsonLength % 4).toBe(0);
    expect(jsonLength).toBe((COMPACT.length + 3) & ~3);
    // The padding bytes are spaces, the rule the reader trims.
    for (let at = JSON_OFFSET + COMPACT.length; at < JSON_OFFSET + jsonLength; at += 1) {
      expect(out[at]).toBe(0x20);
    }
  });

  it('writes a JSON-only GLB when no rest is given', () => {
    const out = Buffer.from(writeGlb(SCENE));
    const read = readGlb(out);
    expect(read.json).toEqual(SCENE);
    expect(read.rest.length).toBe(0);
  });

  it('accepts a plain Uint8Array as rest', () => {
    const rest = new Uint8Array(chunk(CHUNK_BIN, Buffer.from([1, 2, 3, 4]), 0x00));
    const out = Buffer.from(writeGlb(SCENE, rest));
    expect(Buffer.from(readGlb(out).rest)).toEqual(Buffer.from(rest));
  });
});

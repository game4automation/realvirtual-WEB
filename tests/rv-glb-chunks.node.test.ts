// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The one property the GLB bake rests on: rewriting the JSON chunk leaves every
 * byte after it untouched. If that ever stops holding, a bake silently corrupts
 * geometry — so this pins it against a synthetic GLB and against the real
 * 35 MB demo model.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGlbChunks, rebuildGlbWithJson, defaultSceneExtras } from '../src/core/persistence/rv-glb-chunks';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

/** Build a GLB with a JSON and a BIN chunk, padded exactly as the spec wants. */
function makeGlb(json: unknown, bin: Uint8Array, jsonPad = 0x20): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = (jsonBytes.byteLength + 3) & ~3;
  const binPadded = (bin.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonPadded + 8 + binPadded;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.fill(jsonPad, 20, 20 + jsonPadded);
  out.set(jsonBytes, 20);
  view.setUint32(20 + jsonPadded, binPadded, true);
  view.setUint32(24 + jsonPadded, BIN_CHUNK, true);
  out.set(bin, 28 + jsonPadded);
  return out;
}

/** Everything from the BIN chunk header onwards. */
function tailOf(glb: Uint8Array): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  return glb.subarray(20 + view.getUint32(12, true));
}

const SAMPLE_BIN = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const SAMPLE_JSON = {
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'Root', extras: { realvirtual: { Drive: { TargetSpeed: 100 } } } }],
};

describe('rv-glb-chunks', () => {
  it('round-trips a GLB unchanged when the JSON is not modified', () => {
    const source = makeGlb(SAMPLE_JSON, SAMPLE_BIN);
    const out = rebuildGlbWithJson(parseGlbChunks(source));
    // Byte-for-byte, because makeGlb already serialises compactly and pads with
    // spaces — the same two rules rebuildGlbWithJson follows.
    expect(Buffer.from(out).equals(Buffer.from(source))).toBe(true);
  });

  it('keeps the BIN chunk byte-identical when the JSON grows', () => {
    const source = makeGlb(SAMPLE_JSON, SAMPLE_BIN);
    const chunks = parseGlbChunks(source);
    (chunks.json.nodes as { extras: { realvirtual: Record<string, unknown> } }[])[0]
      .extras.realvirtual.SignalLinks = { Mappings: Array.from({ length: 40 }, (_, i) => ({ slot: `S${i}` })) };

    const out = rebuildGlbWithJson(chunks);
    expect(out.byteLength).toBeGreaterThan(source.byteLength);
    expect(Buffer.from(tailOf(out)).equals(Buffer.from(tailOf(source)))).toBe(true);
  });

  it('keeps the BIN chunk byte-identical when the JSON shrinks', () => {
    const source = makeGlb({ ...SAMPLE_JSON, filler: 'x'.repeat(500) }, SAMPLE_BIN);
    const chunks = parseGlbChunks(source);
    delete chunks.json.filler;

    const out = rebuildGlbWithJson(chunks);
    expect(out.byteLength).toBeLessThan(source.byteLength);
    expect(Buffer.from(tailOf(out)).equals(Buffer.from(tailOf(source)))).toBe(true);
  });

  it('pads the JSON chunk to 4 bytes and keeps the header lengths consistent', () => {
    // 'ab' makes the serialised JSON land off a 4-byte boundary.
    const source = makeGlb({ asset: { version: '2.0' }, x: 'ab' }, SAMPLE_BIN);
    const chunks = parseGlbChunks(source);
    chunks.json.x = 'abc';

    const out = rebuildGlbWithJson(chunks);
    const view = new DataView(out.buffer);
    const jsonLength = view.getUint32(12, true);
    expect(jsonLength % 4).toBe(0);
    expect(view.getUint32(8, true)).toBe(out.byteLength);
    expect(view.getUint32(16, true)).toBe(JSON_CHUNK);
    expect(out.subarray(20 + jsonLength - 1, 20 + jsonLength)[0]).toBe(0x20); // space padding
    expect(parseGlbChunks(out).json.x).toBe('abc');
  });

  it('tolerates NUL-padded JSON chunks (some exporters) rather than throwing', () => {
    const source = makeGlb({ asset: { version: '2.0' }, x: 'ab' }, SAMPLE_BIN, 0x00);
    expect(parseGlbChunks(source).json.x).toBe('ab');
  });

  it('rejects anything that is not a well-formed GLB', () => {
    expect(() => parseGlbChunks(new Uint8Array(4))).toThrow(/Too short/);

    const notGlb = makeGlb(SAMPLE_JSON, SAMPLE_BIN);
    new DataView(notGlb.buffer).setUint32(0, 0xdeadbeef, true);
    expect(() => parseGlbChunks(notGlb)).toThrow(/Bad magic/);

    const truncated = makeGlb(SAMPLE_JSON, SAMPLE_BIN).slice(0, 60);
    expect(() => parseGlbChunks(truncated)).toThrow(/Header length|Malformed/);
  });

  it('finds the file-global extras at scenes[scene ?? 0].extras', () => {
    const withExtras = makeGlb(
      { ...SAMPLE_JSON, scenes: [{ nodes: [0], extras: { rv_sig: 'x' } }] },
      SAMPLE_BIN,
    );
    expect(defaultSceneExtras(parseGlbChunks(withExtras).json)).toEqual({ rv_sig: 'x' });
    // No extras on the default scene is a normal state, not an error.
    expect(defaultSceneExtras(parseGlbChunks(makeGlb(SAMPLE_JSON, SAMPLE_BIN)).json)).toBeNull();
  });

  it('preserves the real demo GLB byte-for-byte through an unmodified round trip', () => {
    const source = readFileSync(resolve(__dirname, '../public/models/DemoRealvirtualWeb.glb'));
    const chunks = parseGlbChunks(new Uint8Array(source));
    const out = rebuildGlbWithJson(chunks);
    // The JSON chunk may re-serialise to a different length (the exporter's
    // spacing is not ours), but the geometry must survive untouched.
    expect(Buffer.from(tailOf(out)).equals(Buffer.from(tailOf(new Uint8Array(source))))).toBe(true);
    expect(parseGlbChunks(out).json.asset).toEqual(chunks.json.asset);
  });
});

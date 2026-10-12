// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The import weld's one promise: the welded GLB draws the same triangles, in the
 * same order, with the same attribute values at every corner — only with fewer
 * vertices. Every case below decodes source and result to that corner list and
 * compares them, so a rewrite bug cannot hide behind a plausible vertex count.
 */

import { describe, expect, it } from 'vitest';
import { weldGlbVertices, weldImportedGlb } from '../src/core/import/rv-glb-weld';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';

// ─── GLB fixtures ───────────────────────────────────────────────────────

const FLOAT = 5126;
const U8 = 5121;
const U16 = 5123;
const U32 = 5125;

type Json = Record<string, any>;

function makeGlb(json: Json, bin: Uint8Array): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = (jsonBytes.byteLength + 3) & ~3;
  const binPadded = (bin.byteLength + 3) & ~3;
  const out = new Uint8Array(28 + jsonPadded + binPadded);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonPadded);
  out.set(jsonBytes, 20);
  view.setUint32(20 + jsonPadded, binPadded, true);
  view.setUint32(24 + jsonPadded, 0x004e4942, true);
  out.set(bin, 28 + jsonPadded);
  return out.buffer;
}

/** Collects buffer views into one BIN, 4-byte aligned. */
class Bin {
  private parts: Uint8Array[] = [];
  private length = 0;
  readonly views: Json[] = [];

  add(data: ArrayBufferView, extra: Json = {}): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const padded = new Uint8Array((bytes.byteLength + 3) & ~3);
    padded.set(bytes);
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength, ...extra });
    this.parts.push(padded);
    this.length += padded.byteLength;
    return this.views.length - 1;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) { out.set(part, at); at += part.byteLength; }
    return out;
  }
}

/** Two triangles forming a flat quad, written as triangle soup (6 vertices, 4 distinct). */
const QUAD_POSITIONS = new Float32Array([
  0, 0, 0,  1, 0, 0,  1, 1, 0,
  0, 0, 0,  1, 1, 0,  0, 1, 0,
]);
const QUAD_NORMALS = new Float32Array([
  0, 0, 1,  0, 0, 1,  0, 0, 1,
  0, 0, 1,  0, 0, 1,  0, 0, 1,
]);

function quadGlb(opts: { indexType?: number; indexed?: boolean } = {}): ArrayBuffer {
  const bin = new Bin();
  const accessors: Json[] = [
    { bufferView: bin.add(QUAD_POSITIONS, { target: 34962 }), componentType: FLOAT, count: 6, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
    { bufferView: bin.add(QUAD_NORMALS, { target: 34962 }), componentType: FLOAT, count: 6, type: 'VEC3' },
  ];
  const primitive: Json = { attributes: { POSITION: 0, NORMAL: 1 } };
  if (opts.indexed !== false) {
    const type = opts.indexType ?? U16;
    const Ctor = type === U8 ? Uint8Array : type === U16 ? Uint16Array : Uint32Array;
    accessors.push({ bufferView: bin.add(new Ctor([0, 1, 2, 3, 4, 5]), { target: 34963 }), componentType: type, count: 6, type: 'SCALAR', min: [0], max: [5] });
    primitive.indices = 2;
  }
  const data = bin.bytes();
  return makeGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Quad', mesh: 0 }],
    meshes: [{ primitives: [primitive] }],
    accessors,
    bufferViews: bin.views,
    buffers: [{ byteLength: data.byteLength }],
  }, data);
}

// ─── Decoding ───────────────────────────────────────────────────────────

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function binOf(glb: ArrayBuffer): { json: Json; bin: Uint8Array } {
  const chunks = parseGlbChunks(glb);
  return { json: chunks.json as Json, bin: chunks.bytes.subarray(chunks.restOffset + 8) };
}

function elementBytes(json: Json, bin: Uint8Array, accessorIndex: number, element: number): string {
  const accessor = json.accessors[accessorIndex];
  const view = json.bufferViews[accessor.bufferView];
  const size = COMPONENT_BYTES[accessor.componentType] * TYPE_COMPONENTS[accessor.type];
  const stride = view.byteStride ?? size;
  const at = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + element * stride;
  return [...bin.subarray(at, at + size)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function indexAt(json: Json, bin: Uint8Array, accessorIndex: number, i: number): number {
  const accessor = json.accessors[accessorIndex];
  const view = json.bufferViews[accessor.bufferView];
  const data = new DataView(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0));
  if (accessor.componentType === U8) return data.getUint8(i);
  if (accessor.componentType === U16) return data.getUint16(i * 2, true);
  return data.getUint32(i * 4, true);
}

/** Every drawn corner of every primitive, as the raw bytes of all its attributes. */
function corners(glb: ArrayBuffer): string[][] {
  const { json, bin } = binOf(glb);
  const out: string[][] = [];
  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      const names = Object.keys(primitive.attributes).sort();
      const vertexCount = json.accessors[primitive.attributes[names[0]]].count;
      const drawn = primitive.indices === undefined ? vertexCount : json.accessors[primitive.indices].count;
      const list: string[] = [];
      for (let i = 0; i < drawn; i++) {
        const vertex = primitive.indices === undefined ? i : indexAt(json, bin, primitive.indices, i);
        expect(vertex).toBeLessThan(vertexCount);
        list.push(names.map((name) => `${name}=${elementBytes(json, bin, primitive.attributes[name], vertex)}`).join(' '));
      }
      out.push(list);
    }
  }
  return out;
}

function vertexCounts(glb: ArrayBuffer): number[] {
  const { json } = binOf(glb);
  return json.meshes.flatMap((mesh: Json) =>
    mesh.primitives.map((primitive: Json) => json.accessors[primitive.attributes.POSITION].count));
}

/** Structural sanity: every buffer view lies inside the declared buffer. */
function expectWellFormed(glb: ArrayBuffer): void {
  const { json, bin } = binOf(glb);
  expect(bin.byteLength).toBeGreaterThanOrEqual(json.buffers[0].byteLength);
  for (const view of json.bufferViews) {
    expect((view.byteOffset ?? 0) % 4).toBe(0);
    expect((view.byteOffset ?? 0) + view.byteLength).toBeLessThanOrEqual(json.buffers[0].byteLength);
  }
  for (const accessor of json.accessors) {
    expect(accessor.bufferView).toBeLessThan(json.bufferViews.length);
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('rv-glb-weld', () => {
  it('welds triangle soup and keeps every drawn corner identical', () => {
    const source = quadGlb();
    const result = weldGlbVertices(source);

    expect(result.changed).toBe(true);
    expect(vertexCounts(result.glb)).toEqual([4]);
    expect(corners(result.glb)).toEqual(corners(source));
    expect(result.stats).toMatchObject({ streams: 1, weldedStreams: 1, verticesBefore: 6, verticesAfter: 4 });
    expect(result.stats.bytesAfter).toBe(result.glb.byteLength);
    expectWellFormed(result.glb);

    // POSITION bounds are a property of the value set, which did not change.
    const { json } = binOf(result.glb);
    expect(json.accessors[0].min).toEqual([0, 0, 0]);
    expect(json.accessors[0].max).toEqual([1, 1, 0]);
    // Index bounds would be stale, so they are dropped rather than kept wrong.
    expect(json.accessors[2].min).toBeUndefined();
  });

  it('does not touch the input buffer', () => {
    const source = quadGlb();
    const before = new Uint8Array(source).slice();
    weldGlbVertices(source);
    expect(new Uint8Array(source)).toEqual(before);
  });

  it('keeps vertices apart whose normals differ — hard edges survive', () => {
    const bin = new Bin();
    // The same two positions, each carrying two different normals.
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0]);
    const accessors = [
      { bufferView: bin.add(positions), componentType: FLOAT, count: 6, type: 'VEC3' },
      { bufferView: bin.add(normals), componentType: FLOAT, count: 6, type: 'VEC3' },
      { bufferView: bin.add(new Uint16Array([0, 1, 4, 2, 3, 5])), componentType: U16, count: 6, type: 'SCALAR' },
    ];
    const data = bin.bytes();
    const source = makeGlb({
      asset: { version: '2.0' },
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
      accessors, bufferViews: bin.views, buffers: [{ byteLength: data.byteLength }],
    }, data);

    const result = weldGlbVertices(source);
    expect(result.changed).toBe(false);
    expect(result.glb).toBe(source);
  });

  it('returns the very same buffer when there is nothing to weld', () => {
    const welded = weldGlbVertices(quadGlb()).glb;
    const again = weldGlbVertices(welded);
    expect(again.changed).toBe(false);
    expect(again.glb).toBe(welded);
  });

  it('gives a non-indexed primitive an index list', () => {
    const source = quadGlb({ indexed: false });
    const result = weldGlbVertices(source);

    expect(result.changed).toBe(true);
    expect(vertexCounts(result.glb)).toEqual([4]);
    expect(binOf(result.glb).json.meshes[0].primitives[0].indices).toBeDefined();
    expect(corners(result.glb)).toEqual(corners(source));
    expectWellFormed(result.glb);
  });

  it('narrows a 32-bit index list once the vertices fit 16 bits, and keeps 8-bit ones', () => {
    const narrowed = binOf(weldGlbVertices(quadGlb({ indexType: U32 })).glb).json;
    expect(narrowed.accessors[2].componentType).toBe(U16);

    const source = quadGlb({ indexType: U8 });
    const result = weldGlbVertices(source);
    expect(binOf(result.glb).json.accessors[2].componentType).toBe(U8);
    expect(corners(result.glb)).toEqual(corners(source));
  });

  it('welds an interleaved vertex buffer and renumbers the views that remain', () => {
    const bin = new Bin();
    const imageView = bin.add(new Uint8Array([9, 8, 7, 6, 5]));
    const interleaved = new Float32Array(6 * 6);
    for (let i = 0; i < 6; i++) {
      interleaved.set(QUAD_POSITIONS.subarray(i * 3, i * 3 + 3), i * 6);
      interleaved.set(QUAD_NORMALS.subarray(i * 3, i * 3 + 3), i * 6 + 3);
    }
    const vertexView = bin.add(interleaved, { byteStride: 24, target: 34962 });
    const indexView = bin.add(new Uint16Array([0, 1, 2, 3, 4, 5]));
    const tailView = bin.add(new Uint8Array([1, 2, 3]));
    const data = bin.bytes();
    const source = makeGlb({
      asset: { version: '2.0' },
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
      accessors: [
        { bufferView: vertexView, byteOffset: 0, componentType: FLOAT, count: 6, type: 'VEC3' },
        { bufferView: vertexView, byteOffset: 12, componentType: FLOAT, count: 6, type: 'VEC3' },
        { bufferView: indexView, componentType: U16, count: 6, type: 'SCALAR' },
      ],
      images: [{ bufferView: imageView, mimeType: 'image/png' }, { bufferView: tailView, mimeType: 'image/png' }],
      bufferViews: bin.views,
      buffers: [{ byteLength: data.byteLength }],
    }, data);

    const result = weldGlbVertices(source);
    expect(result.changed).toBe(true);
    expect(corners(result.glb)).toEqual(corners(source));
    expectWellFormed(result.glb);

    // The interleaved view and the old index view are gone; both images still
    // point at their own bytes.
    const { json, bin: outBin } = binOf(result.glb);
    expect(json.bufferViews).toHaveLength(5);
    const imageBytes = (i: number): number[] => {
      const view = json.bufferViews[json.images[i].bufferView];
      return [...outBin.subarray(view.byteOffset, view.byteOffset + view.byteLength)];
    };
    expect(imageBytes(0)).toEqual([9, 8, 7, 6, 5]);
    expect(imageBytes(1)).toEqual([1, 2, 3]);
  });

  it('welds a vertex pool shared by two primitives once, for both', () => {
    const bin = new Bin();
    const accessors = [
      { bufferView: bin.add(QUAD_POSITIONS), componentType: FLOAT, count: 6, type: 'VEC3' },
      { bufferView: bin.add(QUAD_NORMALS), componentType: FLOAT, count: 6, type: 'VEC3' },
      { bufferView: bin.add(new Uint16Array([0, 1, 2])), componentType: U16, count: 3, type: 'SCALAR' },
      { bufferView: bin.add(new Uint16Array([3, 4, 5])), componentType: U16, count: 3, type: 'SCALAR' },
    ];
    const data = bin.bytes();
    const source = makeGlb({
      asset: { version: '2.0' },
      meshes: [{ primitives: [
        { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 },
        { attributes: { POSITION: 0, NORMAL: 1 }, indices: 3, material: 1 },
      ] }],
      accessors, bufferViews: bin.views, buffers: [{ byteLength: data.byteLength }],
    }, data);

    const result = weldGlbVertices(source);
    expect(result.stats).toMatchObject({ streams: 1, verticesBefore: 6, verticesAfter: 4 });
    expect(corners(result.glb)).toEqual(corners(source));
  });

  describe('leaves alone what it cannot rewrite with certainty', () => {
    const patched = (patch: (json: Json) => void): ArrayBuffer => {
      const source = quadGlb();
      const { json, bin } = binOf(source);
      patch(json);
      return makeGlb(json, bin.slice());
    };
    const expectUntouched = (glb: ArrayBuffer): void => {
      const result = weldGlbVertices(glb);
      expect(result.changed).toBe(false);
      expect(result.glb).toBe(glb);
    };

    it('a primitive with an extension (Draco)', () => {
      expectUntouched(patched((json) => {
        json.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: {} } };
      }));
    });

    it('a primitive with morph targets', () => {
      expectUntouched(patched((json) => { json.meshes[0].primitives[0].targets = [{ POSITION: 1 }]; }));
    });

    it('a non-triangle mode', () => {
      expectUntouched(patched((json) => { json.meshes[0].primitives[0].mode = 1; }));
    });

    it('a sparse accessor', () => {
      expectUntouched(patched((json) => { json.accessors[0].sparse = { count: 1 }; }));
    });

    it('a compressed buffer view', () => {
      expectUntouched(patched((json) => { json.bufferViews[0].extensions = { EXT_meshopt_compression: {} }; }));
    });

    it('an accessor that a second vertex stream also uses', () => {
      expectUntouched(patched((json) => {
        json.meshes.push({ primitives: [{ attributes: { POSITION: 0 }, indices: 2 }] });
      }));
    });

    it('an accessor that an animation also uses', () => {
      expectUntouched(patched((json) => { json.animations = [{ samplers: [{ input: 0, output: 1 }] }]; }));
    });

    it('an index list that points past the vertex count', () => {
      const source = quadGlb();
      const { json, bin } = binOf(source);
      const copy = bin.slice();
      const view = json.bufferViews[json.accessors[2].bufferView];
      new DataView(copy.buffer, copy.byteOffset).setUint16(view.byteOffset, 99, true);
      expectUntouched(makeGlb(json, copy));
    });

    it('an external buffer', () => {
      expectUntouched(patched((json) => { json.buffers[0].uri = 'geometry.bin'; }));
    });

    it('bytes that are not a GLB at all', () => {
      expectUntouched(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer);
      expectUntouched(new ArrayBuffer(0));
    });
  });

  it('weldImportedGlb is idempotent and free on a buffer it already returned', () => {
    const first = weldImportedGlb(quadGlb(), 'quad');
    expect(vertexCounts(first)).toEqual([4]);
    expect(weldImportedGlb(first, 'quad')).toBe(first);
  });
});

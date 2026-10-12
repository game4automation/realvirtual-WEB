// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-weld — lossless vertex weld on GLB BYTES, applied to every import.
 *
 * Tessellated CAD routinely arrives as triangle soup: OCCT emits a private vertex
 * block per B-Rep face, and a tessellated STEP (AP242 `TRIANGULATED_FACE`, e.g.
 * HOOPS Exchange) stores every triangle corner as its own vertex. A real machine
 * measured 13.7M vertices for 5.3M triangles, of which 9.4M were bit-identical
 * copies of another vertex.
 *
 * Every import route — STEP via occt or CONNECT, JT, FBX, USD, AML, a plain
 * `.glb`, a catalog download — resolves to GLB bytes before it reaches a sink
 * (`rv-import-provider`). So the weld works on those bytes, at the sinks, and no
 * provider needs to know about it. Welding the bytes rather than the parsed tree
 * also means the content-addressed cache and the persisted file hold the small
 * form, and a draft replay parses it without welding again.
 *
 * ## What "lossless" means here
 *
 * Two vertices are merged only when the raw bytes of ALL their attributes are
 * identical — position, normal, colour, UVs, whatever the primitive carries. No
 * tolerance, no recomputed normals: hard edges keep their split vertices because
 * their normals differ. The decoded mesh draws exactly the same triangles in
 * exactly the same order; `rv-mesh-separator`'s position-only weld is a different
 * tool for a different job and stays untouched.
 *
 * Vertices keep their first-occurrence order and triangles keep their order, so
 * the result is deterministic and ops that address triangles by position
 * (`separateMesh`) see the same partition as before.
 *
 * ## What is left alone
 *
 * Anything this module cannot rewrite with certainty is copied through verbatim:
 * primitives with extensions (Draco) or morph targets, non-triangle modes, sparse
 * accessors, compressed buffer views (meshopt), external buffers, matrix-typed
 * attributes, and vertex streams whose accessors are also used somewhere else
 * (another stream, an animation, a skin, GPU instancing). A file that is not a
 * well-formed GLB is returned as it came — the weld never turns an importable
 * file into a failed import.
 *
 * No three.js, no DOM: plain typed arrays, so it runs in Node tests and could
 * move into a worker unchanged.
 */

import { parseGlbChunks } from '../persistence/rv-glb-chunks';

// ─── Constants ──────────────────────────────────────────────────────────

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const GLB_CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ELEMENT_ARRAY_BUFFER = 34963;
const MODE_TRIANGLES = 4;

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
};

/** Vertex-attribute element types. Matrix types are excluded (column padding). */
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Above this the hash table is released after use instead of kept as scratch. */
const SCRATCH_KEEP_ENTRIES = 1 << 22;

// ─── Types ──────────────────────────────────────────────────────────────

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  sparse?: unknown;
  min?: unknown;
  max?: unknown;
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
  extensions?: unknown;
}

interface GltfPrimitive {
  attributes?: Record<string, number>;
  indices?: number;
  mode?: number;
  targets?: Record<string, number>[];
  extensions?: Record<string, unknown>;
}

/** Where an accessor's elements live inside the GLB bytes. */
interface Span {
  /** Byte offset of element 0, relative to the start of the GLB. */
  offset: number;
  /** Bytes from one element to the next. */
  stride: number;
  /** Bytes of one element. */
  size: number;
}

/** All primitives that draw from the same set of attribute accessors. */
interface VertexStream {
  key: string;
  attributeAccessors: number[];
  indexAccessors: Set<number>;
  /** Primitives of this stream that have no index accessor yet. */
  nonIndexed: GltfPrimitive[];
  blocked: boolean;
}

/** A buffer view created by the weld, with the routine that fills it. */
interface NewView {
  byteLength: number;
  target?: number;
  write(out: Uint8Array, at: number): void;
}

/** What a weld pass did. All zero when the file was returned unchanged. */
export interface GlbWeldStats {
  /** Vertex streams that were examined. */
  streams: number;
  /** Vertex streams that had duplicates and were rewritten. */
  weldedStreams: number;
  /** Vertices of the examined streams before the weld. */
  verticesBefore: number;
  /** Vertices of the examined streams after the weld. */
  verticesAfter: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface GlbWeldResult {
  /** The welded GLB, or the INPUT buffer itself when nothing changed. */
  glb: ArrayBuffer;
  changed: boolean;
  stats: GlbWeldStats;
}

// ─── Accessor resolution ────────────────────────────────────────────────

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Locate an accessor's elements, or null when it is not plain, bounds-checked
 * data in the embedded BIN chunk.
 */
function resolveSpan(
  accessor: GltfAccessor | undefined,
  views: GltfBufferView[],
  binStart: number,
  binLength: number,
): Span | null {
  if (!accessor || accessor.sparse !== undefined) return null;
  if (!isIndex(accessor.bufferView) || !isIndex(accessor.count) || accessor.count === 0) return null;
  const view = views[accessor.bufferView];
  if (!view || view.buffer !== 0 || view.extensions !== undefined) return null;

  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  const components = TYPE_COMPONENTS[accessor.type];
  if (!componentBytes || !components) return null;

  const size = componentBytes * components;
  const stride = view.byteStride ?? size;
  const viewOffset = view.byteOffset ?? 0;
  const accessorOffset = accessor.byteOffset ?? 0;
  if (!isIndex(viewOffset) || !isIndex(accessorOffset) || !isIndex(view.byteLength)) return null;
  if (!isIndex(stride) || stride < size) return null;

  const extent = (accessor.count - 1) * stride + size;
  if (accessorOffset + extent > view.byteLength) return null;
  if (viewOffset + view.byteLength > binLength) return null;

  return { offset: binStart + viewOffset + accessorOffset, stride, size };
}

/** Index values as a typed array — a view when aligned, a copy otherwise. */
function readIndices(
  bytes: Uint8Array,
  span: Span,
  componentType: number,
  count: number,
): Uint8Array | Uint16Array | Uint32Array {
  const start = bytes.byteOffset + span.offset;
  if (componentType === UNSIGNED_BYTE) return bytes.subarray(span.offset, span.offset + count);
  const width = componentType === UNSIGNED_SHORT ? 2 : 4;
  const Ctor = componentType === UNSIGNED_SHORT ? Uint16Array : Uint32Array;
  const aligned = start % width === 0
    ? bytes
    : bytes.slice(span.offset, span.offset + count * width);
  const offset = aligned === bytes ? start : 0;
  return componentType === UNSIGNED_SHORT
    ? new Uint16Array(aligned.buffer, offset, count)
    : new Uint32Array(aligned.buffer, offset, count);
}

// ─── The weld ───────────────────────────────────────────────────────────

let _table = new Uint32Array(0);

/** A zeroed open-addressing table with at least `2 * count` slots. */
function acquireTable(count: number): Uint32Array {
  let capacity = 16;
  while (capacity < count * 2) capacity *= 2;
  if (_table.length < capacity) _table = new Uint32Array(capacity);
  else _table.fill(0, 0, capacity);
  return _table.subarray(0, capacity);
}

/**
 * Map every vertex of a stream to its welded index.
 *
 * Vertices are compared by the raw bytes of all attributes. New indices are
 * handed out in first-occurrence order, which is what lets the writers below
 * recognise a kept vertex by `remap[i] === written`.
 *
 * Returns null when the stream has no duplicates.
 */
function weldStream(
  bytes: Uint8Array,
  spans: Span[],
  count: number,
): { remap: Uint32Array; newCount: number } | null {
  // 4-byte-aligned attributes (every float attribute of a spec-conforming file)
  // are hashed and compared a word at a time; the rest falls back to bytes.
  const words: { data: Uint32Array; step: number; length: number }[] = [];
  const loose: { offset: number; step: number; length: number }[] = [];
  for (const span of spans) {
    const start = bytes.byteOffset + span.offset;
    if (start % 4 === 0 && span.stride % 4 === 0 && span.size % 4 === 0) {
      const extent = (count - 1) * span.stride + span.size;
      words.push({
        data: new Uint32Array(bytes.buffer, start, extent / 4),
        step: span.stride / 4,
        length: span.size / 4,
      });
    } else {
      loose.push({ offset: span.offset, step: span.stride, length: span.size });
    }
  }

  const table = acquireTable(count);
  const mask = table.length - 1;
  const remap = new Uint32Array(count);
  let newCount = 0;

  for (let i = 0; i < count; i++) {
    let h = 0x811c9dc5;
    for (let c = 0; c < words.length; c++) {
      const col = words[c];
      const data = col.data;
      const base = i * col.step;
      for (let k = 0; k < col.length; k++) {
        h = Math.imul(h ^ data[base + k], 0x9e3779b1);
        h = (h << 13) | (h >>> 19);
      }
    }
    for (let c = 0; c < loose.length; c++) {
      const col = loose[c];
      const base = col.offset + i * col.step;
      for (let k = 0; k < col.length; k++) h = Math.imul(h ^ bytes[base + k], 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;

    let slot = h & mask;
    for (;;) {
      const stored = table[slot];
      if (stored === 0) {
        table[slot] = i + 1;
        remap[i] = newCount++;
        break;
      }
      const j = stored - 1;
      let equal = true;
      for (let c = 0; equal && c < words.length; c++) {
        const col = words[c];
        const data = col.data;
        const a = i * col.step;
        const b = j * col.step;
        for (let k = 0; k < col.length; k++) {
          if (data[a + k] !== data[b + k]) { equal = false; break; }
        }
      }
      for (let c = 0; equal && c < loose.length; c++) {
        const col = loose[c];
        const a = col.offset + i * col.step;
        const b = col.offset + j * col.step;
        for (let k = 0; k < col.length; k++) {
          if (bytes[a + k] !== bytes[b + k]) { equal = false; break; }
        }
      }
      if (equal) {
        remap[i] = remap[j];
        break;
      }
      slot = (slot + 1) & mask;
    }
  }

  if (_table.length > SCRATCH_KEEP_ENTRIES) _table = new Uint32Array(0);
  return newCount === count ? null : { remap, newCount };
}

/** Writer for one attribute's kept vertices, tightly packed. */
function attributeWriter(bytes: Uint8Array, span: Span, remap: Uint32Array): NewView['write'] {
  return (out, at) => {
    const count = remap.length;
    const size = span.size;
    let written = 0;
    for (let i = 0; i < count; i++) {
      if (remap[i] !== written) continue; // a duplicate of an earlier vertex
      const src = span.offset + i * span.stride;
      const dst = at + written * size;
      // `set` on a subarray is the same byte copy the hand-rolled loop did, but it
      // goes through the engine's bulk memmove instead of one indexed write per byte —
      // the 13.7 M-vertex case in the header is hundreds of millions of writes.
      out.set(bytes.subarray(src, src + size), dst);
      written++;
    }
  };
}

function indexComponentType(vertexCount: number, previous?: number): number {
  // 65535 is the primitive-restart value, so the largest usable 16-bit index is 65534.
  if (vertexCount > 65535) return UNSIGNED_INT;
  return previous === UNSIGNED_BYTE ? UNSIGNED_BYTE : UNSIGNED_SHORT;
}

/** Writer for an index list passed through `remap`. `source` null = 0..n-1. */
function indexWriter(
  source: Uint8Array | Uint16Array | Uint32Array | null,
  remap: Uint32Array,
  count: number,
  componentType: number,
): NewView['write'] {
  return (out, at) => {
    const start = out.byteOffset + at;
    const target =
      componentType === UNSIGNED_BYTE ? out.subarray(at, at + count)
      : componentType === UNSIGNED_SHORT ? new Uint16Array(out.buffer, start, count)
      : new Uint32Array(out.buffer, start, count);
    if (source) for (let i = 0; i < count; i++) target[i] = remap[source[i]];
    else for (let i = 0; i < count; i++) target[i] = remap[i];
  };
}

// ─── JSON walk ──────────────────────────────────────────────────────────

/**
 * Visit every `bufferView: <number>` in the glTF JSON, known extension or not —
 * the key name is the convention all of them follow. `extras` is user data and
 * is never entered.
 */
function walkBufferViewRefs(node: unknown, visit: (owner: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walkBufferViewRefs(item, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (typeof record.bufferView === 'number') visit(record);
  for (const key of Object.keys(record)) {
    if (key === 'extras') continue;
    const value = record[key];
    if (value && typeof value === 'object') walkBufferViewRefs(value, visit);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────

const align4 = (n: number): number => (n + 3) & ~3;

/**
 * Merge bit-identical vertices in every eligible primitive of a GLB.
 *
 * Pure and synchronous. Returns the INPUT buffer (`changed: false`) when there is
 * nothing to weld or the file cannot be rewritten safely; never throws.
 */
export function weldGlbVertices(glb: ArrayBuffer): GlbWeldResult {
  const stats: GlbWeldStats = {
    streams: 0, weldedStreams: 0, verticesBefore: 0, verticesAfter: 0,
    bytesBefore: glb.byteLength, bytesAfter: glb.byteLength,
  };
  const unchanged: GlbWeldResult = { glb, changed: false, stats };

  let chunks: ReturnType<typeof parseGlbChunks>;
  try {
    chunks = parseGlbChunks(glb);
  } catch {
    return unchanged;
  }
  const bytes = chunks.bytes;
  const json = chunks.json;
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // ── Locate the BIN chunk ──────────────────────────────────────────────
  const binHeader = chunks.restOffset;
  if (binHeader + 8 > bytes.byteLength) return unchanged;
  const binLength = header.getUint32(binHeader, true);
  if (header.getUint32(binHeader + 4, true) !== GLB_CHUNK_TYPE_BIN) return unchanged;
  const binStart = binHeader + 8;
  if (binStart + binLength > bytes.byteLength) return unchanged;
  const trailing = bytes.subarray(binStart + binLength); // further chunks, kept verbatim

  const accessors = json.accessors as GltfAccessor[] | undefined;
  const views = json.bufferViews as GltfBufferView[] | undefined;
  const buffers = json.buffers as { uri?: string; byteLength: number }[] | undefined;
  const meshes = json.meshes as { primitives?: GltfPrimitive[] }[] | undefined;
  if (!Array.isArray(accessors) || !Array.isArray(views) || !Array.isArray(buffers) || !Array.isArray(meshes)) {
    return unchanged;
  }
  if (!buffers[0] || buffers[0].uri !== undefined) return unchanged;

  // A dangling buffer-view reference would alias one of the views appended below.
  let danglingView = false;
  walkBufferViewRefs(json, (owner) => {
    if (!isIndex(owner.bufferView) || owner.bufferView >= views.length) danglingView = true;
  });
  if (danglingView) return unchanged;

  // ── Group primitives into vertex streams; find accessors with two roles ─
  const roleOf = new Map<number, string>();
  const contested = new Set<string>();
  const claim = (accessor: unknown, role: string): void => {
    if (!isIndex(accessor)) return;
    const previous = roleOf.get(accessor);
    if (previous === undefined) roleOf.set(accessor, role);
    else if (previous !== role) { contested.add(previous); contested.add(role); }
  };

  const streams = new Map<string, VertexStream>();
  for (const mesh of meshes) {
    for (const primitive of mesh?.primitives ?? []) {
      const attributes = primitive.attributes ?? {};
      const names = Object.keys(attributes).sort();
      if (names.length === 0) continue;
      const key = names.map((name) => `${name}:${attributes[name]}`).join(',');

      let stream = streams.get(key);
      if (!stream) {
        stream = {
          key,
          attributeAccessors: [...new Set(names.map((name) => attributes[name]))],
          indexAccessors: new Set(),
          nonIndexed: [],
          blocked: false,
        };
        streams.set(key, stream);
      }
      for (const name of names) claim(attributes[name], `v|${key}`);

      if (primitive.indices === undefined) stream.nonIndexed.push(primitive);
      else {
        stream.indexAccessors.add(primitive.indices);
        claim(primitive.indices, `i|${key}`);
      }

      const plain =
        (primitive.mode === undefined || primitive.mode === MODE_TRIANGLES) &&
        primitive.extensions === undefined &&
        primitive.targets === undefined;
      if (!plain) stream.blocked = true;
      for (const target of primitive.targets ?? []) {
        for (const accessor of Object.values(target ?? {})) claim(accessor, 'other');
      }
    }
  }

  // Accessors referenced from outside the mesh primitives.
  for (const animation of (json.animations as { samplers?: { input?: number; output?: number }[] }[] | undefined) ?? []) {
    for (const sampler of animation?.samplers ?? []) {
      claim(sampler?.input, 'other');
      claim(sampler?.output, 'other');
    }
  }
  for (const skin of (json.skins as { inverseBindMatrices?: number }[] | undefined) ?? []) {
    claim(skin?.inverseBindMatrices, 'other');
  }
  for (const node of (json.nodes as { extensions?: Record<string, { attributes?: Record<string, number> }> }[] | undefined) ?? []) {
    const instancing = node?.extensions?.EXT_mesh_gpu_instancing?.attributes;
    for (const accessor of Object.values(instancing ?? {})) claim(accessor, 'other');
  }

  // ── Weld every stream that can be rewritten safely ────────────────────
  const oldViewCount = views.length;
  const newViews: NewView[] = [];
  const addView = (view: NewView): number => {
    newViews.push(view);
    return oldViewCount + newViews.length - 1;
  };

  for (const stream of streams.values()) {
    if (stream.blocked || contested.has(`v|${stream.key}`) || contested.has(`i|${stream.key}`)) continue;

    const count = accessors[stream.attributeAccessors[0]]?.count;
    if (!isIndex(count)) continue;
    const spans: Span[] = [];
    for (const index of stream.attributeAccessors) {
      const span = accessors[index]?.count === count
        ? resolveSpan(accessors[index], views, binStart, binLength)
        : null;
      if (!span) break;
      spans.push(span);
    }
    if (spans.length !== stream.attributeAccessors.length) continue;

    // Index lists must be plain and in range — a corrupt one is not ours to fix.
    const indexLists = new Map<number, Uint8Array | Uint16Array | Uint32Array>();
    let indicesValid = true;
    for (const index of stream.indexAccessors) {
      const accessor = accessors[index];
      const span = resolveSpan(accessor, views, binStart, binLength);
      const unsigned =
        accessor?.componentType === UNSIGNED_BYTE ||
        accessor?.componentType === UNSIGNED_SHORT ||
        accessor?.componentType === UNSIGNED_INT;
      if (!accessor || !span || !unsigned || accessor.type !== 'SCALAR' || span.stride !== span.size) {
        indicesValid = false;
        break;
      }
      const list = readIndices(bytes, span, accessor.componentType, accessor.count);
      for (let i = 0; i < list.length; i++) {
        if (list[i] >= count) { indicesValid = false; break; }
      }
      if (!indicesValid) break;
      indexLists.set(index, list);
    }
    if (!indicesValid) continue;

    stats.streams++;
    stats.verticesBefore += count;
    const welded = weldStream(bytes, spans, count);
    if (!welded) {
      stats.verticesAfter += count;
      continue;
    }
    const { remap, newCount } = welded;
    stats.weldedStreams++;
    stats.verticesAfter += newCount;

    stream.attributeAccessors.forEach((index, i) => {
      const accessor = accessors[index];
      const target = views[accessor.bufferView as number].target;
      accessor.bufferView = addView({
        byteLength: newCount * spans[i].size,
        ...(typeof target === 'number' ? { target } : {}),
        write: attributeWriter(bytes, spans[i], remap),
      });
      delete accessor.byteOffset;
      accessor.count = newCount;
    });

    for (const [index, list] of indexLists) {
      const accessor = accessors[index];
      const componentType = indexComponentType(newCount, accessor.componentType);
      accessor.bufferView = addView({
        byteLength: list.length * COMPONENT_BYTES[componentType],
        target: ELEMENT_ARRAY_BUFFER,
        write: indexWriter(list, remap, list.length, componentType),
      });
      accessor.componentType = componentType;
      delete accessor.byteOffset;
      delete accessor.min;
      delete accessor.max;
    }

    if (stream.nonIndexed.length > 0) {
      // A non-indexed primitive draws vertices 0..n-1 in order; the remap IS its index list.
      const componentType = indexComponentType(newCount);
      accessors.push({
        bufferView: addView({
          byteLength: count * COMPONENT_BYTES[componentType],
          target: ELEMENT_ARRAY_BUFFER,
          write: indexWriter(null, remap, count, componentType),
        }),
        componentType,
        count,
        type: 'SCALAR',
      });
      for (const primitive of stream.nonIndexed) primitive.indices = accessors.length - 1;
    }
  }

  if (newViews.length === 0) return unchanged;

  // ── Lay out the new BIN chunk ─────────────────────────────────────────
  // Buffer views nothing references any more (their accessors moved to welded
  // views) are dropped; every remaining reference is renumbered.
  const referenced = new Set<number>();
  walkBufferViewRefs(json, (owner) => referenced.add(owner.bufferView as number));

  const viewIndex = new Map<number, number>();
  const outViews: GltfBufferView[] = [];
  const copies: { from: number; to: number; length: number }[] = [];
  let cursor = 0;
  for (let i = 0; i < oldViewCount; i++) {
    if (!referenced.has(i)) continue;
    const view = views[i];
    if (view.buffer === 0) {
      const from = view.byteOffset ?? 0;
      if (!isIndex(from) || !isIndex(view.byteLength) || from + view.byteLength > binLength) return unchanged;
      copies.push({ from: binStart + from, to: cursor, length: view.byteLength });
      view.byteOffset = cursor;
      cursor = align4(cursor + view.byteLength);
    }
    viewIndex.set(i, outViews.length);
    outViews.push(view);
  }
  const writes: { at: number; view: NewView }[] = [];
  newViews.forEach((view, i) => {
    writes.push({ at: cursor, view });
    viewIndex.set(oldViewCount + i, outViews.length);
    outViews.push({
      buffer: 0,
      byteOffset: cursor,
      byteLength: view.byteLength,
      ...(view.target !== undefined ? { target: view.target } : {}),
    });
    cursor = align4(cursor + view.byteLength);
  });

  walkBufferViewRefs(json, (owner) => {
    owner.bufferView = viewIndex.get(owner.bufferView as number);
  });
  json.bufferViews = outViews;
  buffers[0].byteLength = cursor;

  // ── Assemble ──────────────────────────────────────────────────────────
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = align4(jsonBytes.byteLength);
  const outBinStart = 12 + 8 + jsonPadded + 8;
  const out = new Uint8Array(outBinStart + cursor + trailing.byteLength);
  const outHeader = new DataView(out.buffer);
  outHeader.setUint32(0, GLB_MAGIC, true);
  outHeader.setUint32(4, 2, true);
  outHeader.setUint32(8, out.byteLength, true);
  outHeader.setUint32(12, jsonPadded, true);
  outHeader.setUint32(16, GLB_CHUNK_TYPE_JSON, true);
  out.fill(0x20, 20, 20 + jsonPadded);
  out.set(jsonBytes, 20);
  outHeader.setUint32(20 + jsonPadded, cursor, true);
  outHeader.setUint32(24 + jsonPadded, GLB_CHUNK_TYPE_BIN, true);

  for (const copy of copies) {
    out.set(bytes.subarray(copy.from, copy.from + copy.length), outBinStart + copy.to);
  }
  for (const { at, view } of writes) view.write(out, outBinStart + at);
  out.set(trailing, outBinStart + cursor);

  stats.bytesAfter = out.byteLength;
  return { glb: out.buffer, changed: true, stats };
}

/** Buffers that already went through {@link weldImportedGlb} — a second pass is free. */
const _welded = new WeakSet<ArrayBuffer>();

/**
 * The import-sink entry point: weld, remember the result, and say what happened.
 *
 * Call it on the GLB bytes of every import BEFORE they are cached, persisted or
 * parsed, so all three see the same bytes. Idempotent, and cheap to call again on
 * a buffer it returned.
 */
export function weldImportedGlb(glb: ArrayBuffer, label = 'import'): ArrayBuffer {
  // Not bytes at all (a test double, a failed download): nothing to weld, and the
  // sink behind this call reports the real problem far better than we could.
  if (!glb || typeof glb !== 'object') return glb;
  if (_welded.has(glb)) return glb;
  const { glb: result, changed, stats } = weldGlbVertices(glb);
  _welded.add(result);
  if (changed) {
    const megabytes = (n: number): string => (n / (1024 * 1024)).toFixed(1);
    console.info(
      `[import] "${label}": welded ${stats.verticesBefore.toLocaleString()} → ` +
      `${stats.verticesAfter.toLocaleString()} vertices ` +
      `(${megabytes(stats.bytesBefore)} → ${megabytes(stats.bytesAfter)} MB).`,
    );
  }
  return result;
}

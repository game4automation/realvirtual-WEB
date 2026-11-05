// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * usd-export-geometry-split — keeps every string three's `USDZExporter` builds
 * below the V8 string limit (plan-2246).
 *
 * The runtime stage exports the BAKED tree, so one export mesh can carry a
 * whole chunk geometry (millions of vertices). `USDZExporter.buildNode` writes
 * a single-material geometry as ONE string (`geometries/Geometry_<id>.usda`),
 * which throws `RangeError: Invalid string length` above ~2^29 characters.
 *
 * {@link withSplitOversizedMeshes} wraps exactly the `parseAsync` call:
 * - every single-material mesh whose serialized geometry text would exceed
 *   `maxChars` is swapped, at the same place in its parent's child array, for
 *   an `Object3D` that keeps name (`_rvN<i>`), uuid (animation tracks bind by
 *   uuid), matrix, TRS, pivot and children; the geometry goes into part meshes
 *   `_rvP<i>_<k>` appended as extra children (compact copies, triangles in read
 *   order, one set of parts per source geometry);
 * - the swap is undone in `finally`, after success, error or abort, and the
 *   part copies are released; the source (chunk) geometry is only read
 *   (contract-bake-picking 10 / 11);
 * - part names are allocated AFTER the runtime tables, against the final
 *   names of the real siblings (`allocatePartNames`); the post-pass renames
 *   `_rvP<i>_<k>` through `StagePostOptions.partNames`; parts get no customData
 *   and no identity (node-identity 6);
 * - multi-material meshes are never split: their geometry is inline in
 *   `model.usda`, which an aggregate bound ({@link modelLayerLengthBound})
 *   checks before the export.
 *
 * Every refusal is a {@link UsdExportTooLargeError} with a named code and the
 * prim path, never `Invalid string length` (contract-commands-mcp 2).
 *
 * The length counters mirror `USDZExporter.buildMeshNode` / `USDNode.toString`
 * of three 0.185.1 character for character; the guard test compares them with
 * the real exporter output.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Float16BufferAttribute,
  Matrix4,
  Mesh,
  Object3D,
  PropertyBinding,
  type AnimationClip,
  type InterleavedBufferAttribute,
  type KeyframeTrack,
  type Material,
} from 'three';
import { PART_PLACEHOLDER_PREFIX, PLACEHOLDER_PREFIX, allocatePartNames } from './usd-prim-names';

/** Longest string V8 allows (2^29 - 24 characters, 64-bit builds). */
export const V8_MAX_STRING_LENGTH = 536_870_888;
/** Target per geometry file: a quarter of the V8 limit (plan-2246 §2.1). */
export const MAX_SERIALIZED_CHARS_PER_PART = 128 * 1024 * 1024;
/**
 * Bound for `model.usda`: the exporter builds it as one string and the
 * post-pass adds metadata (customData, primvar readers) — 32 MiB headroom.
 */
export const MAX_MODEL_LAYER_CHARS = V8_MAX_STRING_LENGTH - 32 * 1024 * 1024;

export type UsdExportLimitCode = 'usd-geometry-too-large' | 'usd-model-layer-too-large' | 'usd-package-too-large';

/** A named export refusal: a string or the complete package exceeds its limit. */
export class UsdExportTooLargeError extends Error {
  readonly estimatedBytes?: number;
  readonly limitBytes?: number;
  constructor(
    readonly code: UsdExportLimitCode,
    /** Prim path of the offending mesh (`usd-geometry-too-large`) or the layer (`model.usda`). */
    readonly primPath: string,
    /** Serialized characters needed, or estimated package bytes for usd-package-too-large. */
    readonly serializedChars: number,
    readonly maxChars: number,
  ) {
    super(code === 'usd-package-too-large'
      ? `USD export refused (usd-package-too-large): the package needs about ${serializedChars} bytes, `
        + `more than the limit of ${maxChars} bytes. Reduce the model, textures, MUs or recording length.`
      : code === 'usd-geometry-too-large'
      ? `USD export refused (usd-geometry-too-large): the geometry of ${primPath} cannot be split into USD files `
        + `of at most ${maxChars} characters (needs ${serializedChars}).`
      : `USD export refused (usd-model-layer-too-large): model.usda would need about ${serializedChars} characters, `
        + `more than the limit of ${maxChars}. Reduce multi-material meshes, MUs or the recording length.`);
    this.name = 'UsdExportTooLargeError';
    if (code === 'usd-package-too-large') {
      this.estimatedBytes = serializedChars;
      this.limitBytes = maxChars;
    }
  }

  /** Fields for a command failure's `details`. */
  toDetails(): { code: Exclude<UsdExportLimitCode, 'usd-package-too-large'>; primPath: string; serializedChars: number; maxChars: number }
    | { code: 'usd-package-too-large'; estimatedBytes: number; limitBytes: number } {
    if (this.code === 'usd-package-too-large') {
      return { code: this.code, estimatedBytes: this.estimatedBytes!, limitBytes: this.limitBytes! };
    }
    return { code: this.code, primPath: this.primPath, serializedChars: this.serializedChars, maxChars: this.maxChars };
  }
}

/** Duck-typed check (callers that must not import this module eagerly use the same shape). */
export function isUsdExportTooLargeError(e: unknown): e is UsdExportTooLargeError {
  const c = (e as { code?: unknown } | null)?.code;
  return e instanceof Error && (c === 'usd-geometry-too-large' || c === 'usd-model-layer-too-large' || c === 'usd-package-too-large');
}

// ── Limits (injectable for tests) ──

interface UsdExportLimits { maxPartChars: number; maxModelLayerChars: number }
const limits: UsdExportLimits = { maxPartChars: MAX_SERIALIZED_CHARS_PER_PART, maxModelLayerChars: MAX_MODEL_LAYER_CHARS };

/**
 * Tests only: lower the default limits for every export path that does not
 * pass its own. Returns the restore function.
 */
export function setUsdExportLimitsForTests(next: Partial<UsdExportLimits>): () => void {
  const before = { ...limits };
  Object.assign(limits, next);
  return () => { Object.assign(limits, before); };
}

// ── Serialized length of one geometry file (USDZExporter.buildMeshObject) ──

const PRECISION = 7;
type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;
/** Attribute slots `buildMeshNode` writes besides `position` / `normal`. */
const UV_SLOTS = ['uv', 'uv1', 'uv2', 'uv3'] as const;

const HEADER_TEXT = '#usda 1.0\n(\n\tcustomLayerData = {\n\t\tstring creator = "Three.js USDZExporter"\n\t}\n'
  + '\tdefaultPrim = "Root"\n\tmetersPerUnit = 1\n\tupAxis = "Y"\n)\n';
const VERTEX_META = ' (\n\t\t\tinterpolation = "vertex"\n\t\t)';

/** Characters of a geometry file whose arrays are all empty (header, prim structure, property names). */
function fixedFileChars(geometry: BufferGeometry): number {
  const a = geometry.attributes;
  const props: string[] = [
    'int[] faceVertexCounts = []',
    'int[] faceVertexIndices = []',
    'normal3f[] normals = []' + VERTEX_META,
    'point3f[] points = []',
  ];
  UV_SLOTS.forEach((slot, i) => {
    if (a[slot] !== undefined) props.push(`texCoord2f[] primvars:st${i > 0 ? i : ''} = []` + VERTEX_META);
  });
  if (a.color !== undefined) props.push('color3f[] primvars:displayColor = []' + VERTEX_META);
  props.push('uniform token subdivisionScheme = "none"');
  const mesh = `\tdef Mesh "Geometry"\n\t{\n${props.map((p) => '\t\t' + p).join('\n')}\n\t}`;
  return HEADER_TEXT.length + 1 + `def "Geometry"\n{\n${mesh}\n}`.length;
}

const sep = (n: number): number => (n > 0 ? 2 * (n - 1) : 0);
const digits = (n: number): number => (n < 10 ? 1 : n < 100 ? 2 : n < 1e3 ? 3 : n < 1e4 ? 4 : n < 1e5 ? 5
  : n < 1e6 ? 6 : n < 1e7 ? 7 : n < 1e8 ? 8 : n < 1e9 ? 9 : String(n).length);

function vertexListLength(geometry: BufferGeometry): number {
  return geometry.index ? geometry.index.count : geometry.attributes.position.count;
}

function exactVec3(attr: AnyAttribute | undefined, count: number): number {
  if (attr === undefined) return 9 * count + sep(count); // '(0, 0, 0)' per vertex
  let s = 0;
  for (let i = 0; i < attr.count; i++) {
    s += 6 + attr.getX(i).toPrecision(PRECISION).length + attr.getY(i).toPrecision(PRECISION).length
      + attr.getZ(i).toPrecision(PRECISION).length;
  }
  return s + sep(attr.count);
}

function exactVec2(attr: AnyAttribute): number {
  let s = 0;
  for (let i = 0; i < attr.count; i++) {
    // Exporter quirk kept: `1 - y.toPrecision(7)` is a number minus a string.
    s += 4 + attr.getX(i).toPrecision(PRECISION).length
      + String(1 - (attr.getY(i).toPrecision(PRECISION) as unknown as number)).length;
  }
  return s + sep(attr.count);
}

/**
 * Exact length of the `geometries/Geometry_<id>.usda` text `USDZExporter`
 * writes for `geometry` (header, every vertex of every attribute — used or
 * not — generated zero normals, the UV quirk, separators). O(vertices).
 */
export function serializedGeometryLength(geometry: BufferGeometry): number {
  const a = geometry.attributes;
  const count = a.position.count;
  const n = vertexListLength(geometry);
  let s = fixedFileChars(geometry) + n / 3 + sep(n / 3);
  const index = geometry.index;
  if (index) { for (let i = 0; i < n; i++) s += digits(index.getX(i)); } else { for (let i = 0; i < n; i++) s += digits(i); }
  s += sep(n);
  s += exactVec3(a.normal as AnyAttribute | undefined, count) + exactVec3(a.position as AnyAttribute, count);
  for (const slot of UV_SLOTS) if (a[slot] !== undefined) s += exactVec2(a[slot] as AnyAttribute);
  if (a.color !== undefined) s += exactVec3(a.color as AnyAttribute, count);
  return s;
}

/*
 * Longest text of one number, proven per value range (plan-2246 post-review R1).
 *
 * `x.toPrecision(7)` with decimal exponent e (x = d.dddddd × 10^e):
 * - exponential when e < -6 or e >= 7: sign + 'd.dddddd' + 'e' + sign + exponent
 *   digits = 1 + 8 + 1 + 1 + (2 for float32 |e| <= 45, 3 for float64) = 13 / 14;
 * - fixed when -6 <= e < 0: sign + '0.' + (-e - 1) zeros + 7 digits — the
 *   longest at e = -6: '-0.000001234567' = 15;
 * - fixed when 0 <= e < 7: sign + 7 digits + '.' = 9 at most;
 * - 0 and -0 give '0.000000' (8), NaN 3, -Infinity 9.
 * So 15 holds for EVERY number; a type whose values cannot reach e = -6 is tighter:
 * - normalized Uint8 (0 or >= 1/255, e >= -3, <= 1): '0.003921569' = 11;
 * - normalized Int8 (|x| 0 or >= 1/127, e >= -3, >= -1): '-0.007874016' = 12;
 * - normalized Uint16 (0 or >= 1/65535, e >= -5): '0.00001525902' = 13;
 * - normalized Int16 (|x| 0 or >= 1/32767, e >= -5): '-0.00003051851' = 14;
 * - integers, not normalized (|x| 0 or >= 1, |x| < 2^32): fixed '-1234567' + '.'
 *   = 9 or exponential '-4.294967e+9' = 12 -> 12.
 * Float32 / Float64 / Float16 and normalized 32-bit integers can reach e = -6: 15.
 */
const MAX_ANY_NUMBER_CHARS = 15;

/** Longest `toPrecision(7)` text of one value of `attr` as `getX` returns it (see the table above). */
export function maxNumberChars(attr: AnyAttribute): number {
  const array = (attr as InterleavedBufferAttribute).isInterleavedBufferAttribute
    ? (attr as InterleavedBufferAttribute).data.array : (attr as BufferAttribute).array;
  if ((attr as BufferAttribute & { isFloat16BufferAttribute?: boolean }).isFloat16BufferAttribute) return MAX_ANY_NUMBER_CHARS;
  const integer = array instanceof Uint8Array || array instanceof Uint8ClampedArray || array instanceof Int8Array
    || array instanceof Uint16Array || array instanceof Int16Array || array instanceof Uint32Array || array instanceof Int32Array;
  if (!integer) return MAX_ANY_NUMBER_CHARS;
  if (!attr.normalized) return 12;
  if (array instanceof Uint8Array || array instanceof Uint8ClampedArray) return 11;
  if (array instanceof Int8Array) return 12;
  if (array instanceof Uint16Array) return 13;
  if (array instanceof Int16Array) return 14;
  return MAX_ANY_NUMBER_CHARS;
}

/**
 * Longest `String(1 - "<toPrecision(7) text>")` (the exporter's UV quirk): the
 * result is a double printed with at most 17 significant digits. Fixed notation
 * for 10^-6 <= |r| < 10^21: below 1 the longest is sign + '0.' + 5 zeros + 17
 * digits = 25; at or above 1 it is sign + at most 21 integer digits (17
 * significant, zero padded) + '.' + the rest = 22 at most. Exponential otherwise:
 * sign + 'd.' + 16 digits + 'e-' + 3 digits = 24. So 25.
 */
export const MAX_UV_Y_CHARS = 25;

/** Characters one vertex costs at most in every exported attribute array, separators included. */
function vertexCharsBound(geometry: BufferGeometry): number {
  const a = geometry.attributes;
  const vec3 = (attr: AnyAttribute | undefined): number => (attr === undefined ? 9 : 6 + 3 * maxNumberChars(attr)) + 2;
  let s = vec3(a.position as AnyAttribute) + vec3(a.normal as AnyAttribute | undefined);
  for (const slot of UV_SLOTS) if (a[slot] !== undefined) s += 4 + maxNumberChars(a[slot] as AnyAttribute) + MAX_UV_Y_CHARS + 2;
  if (a.color !== undefined) s += vec3(a.color as AnyAttribute);
  return s;
}

/**
 * Cheap upper bound of {@link serializedGeometryLength}: every number at its
 * longest, every index at the digits of the largest vertex index. O(1).
 */
export function serializedLengthBound(geometry: BufferGeometry): number {
  const count = geometry.attributes.position.count;
  const n = vertexListLength(geometry);
  return fixedFileChars(geometry) + Math.ceil(n / 3) * 3 + n * (digits(Math.max(0, count - 1)) + 2)
    + count * vertexCharsBound(geometry);
}

// ── Splitting ──

/** One part: triangles `[triStart, triEnd)` of the source in read order. */
interface PartRange { triStart: number; triEnd: number; vertices: number }

/** Thrown inside the splitter; the caller adds the prim path. */
class NotSplittable extends Error {
  constructor(readonly needed: number) { super('not splittable'); }
}

function isTriangleList(geometry: BufferGeometry): boolean {
  return !!geometry.attributes.position && vertexListLength(geometry) % 3 === 0;
}

/** Exported attributes (position, normal, uv…uv3, color) — the exporter writes nothing else. */
function exportedAttributeNames(geometry: BufferGeometry): string[] {
  return ['position', 'normal', ...UV_SLOTS, 'color'].filter((name) => geometry.attributes[name] !== undefined);
}

/**
 * Partition `geometry` into parts of at most `maxChars` serialized characters
 * (each part's {@link serializedLengthBound}-style bound with compact vertices
 * and the exact digits of its local indices). Throws {@link NotSplittable}
 * when one triangle alone is too large or the geometry is not a triangle list.
 */
function planParts(geometry: BufferGeometry, maxChars: number): PartRange[] {
  if (!isTriangleList(geometry)) throw new NotSplittable(serializedLengthBound(geometry));
  const index = geometry.index;
  const n = vertexListLength(geometry), tris = n / 3;
  const fixed = fixedFileChars(geometry), perVertex = vertexCharsBound(geometry);
  const sourceCount = geometry.attributes.position.count;
  // stamp[v] = part number that last used source vertex v; local[v] its index there.
  const stamp = index ? new Int32Array(sourceCount).fill(-1) : null;
  const local = index ? new Int32Array(sourceCount) : null;
  const parts: PartRange[] = [];
  let part = 0, triStart = 0, vertices = 0, chars = fixed;
  const corner = [0, 0, 0], fresh = [false, false, false], localOf = [0, 0, 0];

  const cost = (t: number): number => {
    let added = 0, next = vertices, add = 3; // faceVertexCounts: '3' + ', '
    for (let j = 0; j < 3; j++) {
      const v = index ? index.getX(3 * t + j) : 3 * t + j;
      corner[j] = v;
      let li: number;
      if (stamp && stamp[v] === part) { li = local![v]; fresh[j] = false; } else {
        let dup = -1;
        for (let q = 0; q < j; q++) if (fresh[q] && corner[q] === v) dup = q;
        if (dup >= 0) { li = localOf[dup]; fresh[j] = false; } else { li = next++; fresh[j] = true; added++; }
      }
      localOf[j] = li;
      add += digits(li) + 2;
    }
    return add + added * perVertex;
  };

  for (let t = 0; t < tris; t++) {
    let add = cost(t);
    if (chars + add > maxChars && t > triStart) {
      parts.push({ triStart, triEnd: t, vertices });
      part++; triStart = t; vertices = 0; chars = fixed;
      add = cost(t);
    }
    if (chars + add > maxChars) throw new NotSplittable(chars + add);
    for (let j = 0; j < 3; j++) {
      if (!fresh[j]) continue;
      if (stamp) { stamp[corner[j]] = part; local![corner[j]] = localOf[j]; }
      vertices++;
    }
    chars += add;
  }
  if (tris > triStart) parts.push({ triStart, triEnd: tris, vertices });
  return parts;
}

function rawArrayOf(attr: AnyAttribute): ArrayLike<number> & { constructor: new (n: number) => ArrayLike<number> } {
  const array = (attr as InterleavedBufferAttribute).isInterleavedBufferAttribute
    ? (attr as InterleavedBufferAttribute).data.array : (attr as BufferAttribute).array;
  return array as unknown as ArrayLike<number> & { constructor: new (n: number) => ArrayLike<number> };
}

/** Raw component `c` of vertex `v` (no normalization — the copy keeps the source's encoding). */
function rawReader(attr: AnyAttribute): (v: number, c: number) => number {
  if ((attr as InterleavedBufferAttribute).isInterleavedBufferAttribute) {
    const ia = attr as InterleavedBufferAttribute, data = ia.data.array as ArrayLike<number>, stride = ia.data.stride, offset = ia.offset;
    return (v, c) => data[v * stride + offset + c];
  }
  const array = (attr as BufferAttribute).array as ArrayLike<number>, size = attr.itemSize;
  return (v, c) => array[v * size + c];
}

/**
 * Copy the triangles of one part into a fresh geometry: compact vertex subset
 * in first-use order, same attribute encodings (array type, item size,
 * normalized flag), only the attributes the exporter writes. The source is
 * only read (contract-bake-picking 10).
 */
function buildPart(geometry: BufferGeometry, range: PartRange): BufferGeometry {
  const index = geometry.index;
  const out = new BufferGeometry();
  const corners = (range.triEnd - range.triStart) * 3;
  // Part vertex k <- source vertex sourceOf[k].
  const sourceOf = new Int32Array(range.vertices);
  let partIndex: Uint16Array | Uint32Array | null = null;
  if (index) {
    partIndex = range.vertices > 65535 ? new Uint32Array(corners) : new Uint16Array(corners);
    const seen = new Map<number, number>();
    let next = 0;
    for (let i = 0; i < corners; i++) {
      const v = index.getX(range.triStart * 3 + i);
      let li = seen.get(v);
      if (li === undefined) { li = next++; seen.set(v, li); sourceOf[li] = v; }
      partIndex[i] = li;
    }
    if (next !== range.vertices) throw new Error('Split plan mismatch');
  } else {
    for (let i = 0; i < corners; i++) sourceOf[i] = range.triStart * 3 + i;
  }
  for (const name of exportedAttributeNames(geometry)) {
    const src = geometry.attributes[name] as AnyAttribute;
    const size = src.itemSize, read = rawReader(src);
    const Ctor = rawArrayOf(src).constructor;
    const array = new Ctor(range.vertices * size) as unknown as Float32Array;
    for (let k = 0; k < range.vertices; k++) {
      const v = sourceOf[k];
      for (let c = 0; c < size; c++) array[k * size + c] = read(v, c);
    }
    const attr = (src as BufferAttribute & { isFloat16BufferAttribute?: boolean }).isFloat16BufferAttribute
      ? new Float16BufferAttribute(array, size, src.normalized)
      : new BufferAttribute(array, size, src.normalized);
    out.setAttribute(name, attr);
  }
  if (partIndex) out.setIndex(new BufferAttribute(partIndex, 1));
  return out;
}

/**
 * Split `geometry` into single-material part geometries whose serialized text
 * stays at or below `maxChars` each. The input is only read. Throws
 * {@link UsdExportTooLargeError} (`usd-geometry-too-large`, `primPath`) when a
 * single triangle is already too large or the geometry is not a triangle list.
 */
export function splitGeometryForExport(geometry: BufferGeometry, maxChars: number, primPath = ''): BufferGeometry[] {
  let ranges: PartRange[];
  try {
    ranges = planParts(geometry, maxChars);
  } catch (e) {
    if (e instanceof NotSplittable) throw new UsdExportTooLargeError('usd-geometry-too-large', primPath, e.needed, maxChars);
    throw e;
  }
  return ranges.map((r) => buildPart(geometry, r));
}

/** True when the exporter would write `geometry` as a file of more than `maxChars` characters. */
export function exceedsSerializedLimit(geometry: BufferGeometry, maxChars: number): boolean {
  if (serializedLengthBound(geometry) <= maxChars) return false; // cheap: nearly every geometry
  return serializedGeometryLength(geometry) > maxChars;
}

// ── Aggregate bound for model.usda ──

/** Per prim: `def` line, metadata (references, apiSchemas, binding), transform, xformOpOrder, braces. */
const PRIM_FIXED_CHARS = 1024;
/** Lines of one prim block that carry indentation. */
const PRIM_LINES = 16;
/** Per material (preview surface plus up to nine texture readers). */
const MATERIAL_CHARS = 16384;
/** Root / Scenes / Scene / Materials skeleton and the layer header with time metadata. */
const LAYER_FIXED_CHARS = 2048;
/** `float3 xformOp:translate.timeSamples = {` and the like, with the closing `,
}`. */
const TRACK_FIXED_CHARS = 64;

/**
 * Exact characters of the samples three writes for one TRS track
 * (`buildVector3TimeSamples` / `buildQuaternionTimeSamples`: frame and values
 * with `toPrecision(7)`, `',
	'` between samples), plus its line count for
 * the indentation the node layout adds. Other properties are not exported.
 */
function trackText(track: KeyframeTrack, property: string, fps: number): { chars: number; lines: number } {
  if (property !== 'position' && property !== 'quaternion' && property !== 'scale') return { chars: 0, lines: 0 };
  const times = track.times, values = track.values, n = times.length;
  if (!n) return { chars: TRACK_FIXED_CHARS, lines: 2 };
  const width = property === 'quaternion' ? 4 : 3;
  let chars = TRACK_FIXED_CHARS + 3 * (n - 1);
  for (let i = 0; i < n; i++) {
    chars += (times[i] * fps).toPrecision(PRECISION).length + 3 + 1 + 2 * (width - 1);
    for (let j = 0; j < width; j++) chars += (values[i * width + j] ?? 0).toPrecision(PRECISION).length;
  }
  return { chars, lines: n + 1 };
}

/** Bound of a multi-material mesh's inline `def Mesh "Geometry"` with its subsets, at tab depth `depth`. */
function inlineMeshBound(geometry: BufferGeometry, depth: number): number {
  let s = serializedLengthBound(geometry) + PRIM_LINES * (depth + 2) * 16;
  const faces = Math.ceil(vertexListLength(geometry) / 3);
  for (const g of geometry.groups) {
    const n = Math.max(0, Math.min(Math.floor(g.count / 3), faces));
    s += 512 + PRIM_LINES * (depth + 3) + n * (digits(faces) + 2);
  }
  return s;
}

export interface ModelLayerBoundOptions {
  /** The clips handed to `parseAsync` (their samples are written into model.usda). */
  animations?: readonly AnimationClip[];
  /** `animationFrameRate` handed to `parseAsync` (exporter default 60). */
  animationFrameRate?: number;
}

/**
 * Safe upper bound of the `model.usda` text `USDZExporter.parseAsync` builds
 * for `scene` (visible nodes only, as with `onlyVisible: true`): every prim,
 * every inline multi-material geometry, every animation sample, every
 * material. Repeated MU subtrees are counted once per copy.
 */
export function modelLayerLengthBound(scene: Object3D, options: ModelLayerBoundOptions = {}): number {
  const fps = options.animationFrameRate ?? 60;
  const tracksByNode = new Map<string, { chars: number; lines: number }>();
  for (const clip of options.animations ?? []) {
    for (const track of clip.tracks as KeyframeTrack[]) {
      const binding = PropertyBinding.parseTrackName(track.name);
      const text = trackText(track, binding.propertyName, fps);
      const sum = tracksByNode.get(binding.nodeName) ?? { chars: 0, lines: 0 };
      sum.chars += text.chars; sum.lines += text.lines;
      tracksByNode.set(binding.nodeName, sum);
    }
  }
  const materials = new Set<string>();
  let total = LAYER_FIXED_CHARS;
  const visit = (node: Object3D, depth: number): void => {
    if (!node.visible) return;
    total += PRIM_FIXED_CHARS + node.name.length + PRIM_LINES * depth;
    for (const key of node.name && node.name !== node.uuid ? [node.uuid, node.name] : [node.uuid]) {
      const text = tracksByNode.get(key);
      if (text) total += text.chars + text.lines * (depth + 2);
    }
    const mesh = node as Mesh;
    if (mesh.isMesh) {
      const list: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of list) if (m) materials.add(m.uuid);
      if (Array.isArray(mesh.material)) total += inlineMeshBound(mesh.geometry, depth + 1);
    }
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const child of scene.children) visit(child, 3);
  return total + materials.size * MATERIAL_CHARS;
}

// ── The swap around parseAsync ──

export interface SplitExportOptions {
  /** Final prim names, index = placeholder index (`_rvN<i>`). */
  finalNames: readonly string[];
  /** Final prim paths, index = placeholder index (named in a refusal). */
  primPaths: readonly string[];
  /** Per geometry file; default {@link MAX_SERIALIZED_CHARS_PER_PART}. */
  maxChars?: number;
  /** Aggregate bound for model.usda; default {@link MAX_MODEL_LAYER_CHARS}. */
  maxModelLayerChars?: number;
  /** Clips passed to `parseAsync`, for the model.usda bound. */
  animations?: readonly AnimationClip[];
  /** `animationFrameRate` passed to `parseAsync`. */
  animationFrameRate?: number;
}

export interface SplitExportInfo {
  /** `_rvP<i>_<k>` -> final part name; empty when nothing was split. */
  partNames: ReadonlyMap<string, string>;
  /** Meshes swapped for an Xform with parts. */
  splitMeshes: number;
  /** Part geometries created (one set per source geometry). */
  partGeometries: number;
}

interface Swap { parent: Object3D; at: number; mesh: Mesh; stand: Object3D }

const IDENTITY = new Matrix4();

function placeholderIndex(name: string): number {
  return name.startsWith(PLACEHOLDER_PREFIX) ? Number(name.slice(PLACEHOLDER_PREFIX.length)) : NaN;
}

/** Exporter-visible single-material meshes in traversal order (parents before children). */
function collectMeshes(scene: Object3D): Mesh[] {
  const out: Mesh[] = [];
  const visit = (node: Object3D): void => {
    for (const child of node.children) {
      if (!child.visible) continue;
      const mesh = child as Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material) && mesh.geometry?.attributes?.position) out.push(mesh);
      visit(child);
    }
  };
  visit(scene);
  return out;
}

/** Drop the CPU arrays of a part copy (dispose() alone keeps them reachable). */
function releasePart(geometry: BufferGeometry): void {
  geometry.dispose();
  for (const name of Object.keys(geometry.attributes)) geometry.deleteAttribute(name);
  geometry.setIndex(null);
}

/**
 * Run `run` (the `parseAsync` call) with every oversized single-material mesh
 * of `scene` temporarily replaced by an Xform plus part meshes; check the
 * model.usda bound first. The scene is restored in `finally`.
 */
export async function withSplitOversizedMeshes<T>(
  scene: Object3D,
  options: SplitExportOptions,
  run: (info: SplitExportInfo) => Promise<T>,
): Promise<T> {
  const maxChars = options.maxChars ?? limits.maxPartChars;
  const maxModel = options.maxModelLayerChars ?? limits.maxModelLayerChars;
  const cache = new Map<BufferGeometry, BufferGeometry[] | null>();
  const swaps: Swap[] = [];
  const partNames = new Map<string, string>();
  const pathOf = (mesh: Object3D): string => {
    const i = placeholderIndex(mesh.name);
    return options.primPaths[i] ?? mesh.name;
  };
  try {
    for (const mesh of collectMeshes(scene)) {
      let parts = cache.get(mesh.geometry);
      if (parts === undefined) {
        parts = exceedsSerializedLimit(mesh.geometry, maxChars) ? splitGeometryForExport(mesh.geometry, maxChars, pathOf(mesh)) : null;
        cache.set(mesh.geometry, parts);
      }
      if (!parts) continue;
      const i = placeholderIndex(mesh.name);
      if (!Number.isInteger(i)) throw new Error(`Cannot split ${mesh.name}: not a runtime stage node`);
      const siblings = mesh.children.map((c) => options.finalNames[placeholderIndex(c.name)] ?? c.name);
      const names = allocatePartNames(siblings, parts.length);
      const stand = new Object3D();
      stand.name = mesh.name;
      stand.uuid = mesh.uuid; // animation tracks are bound by uuid (anim-clips)
      stand.visible = mesh.visible;
      stand.matrixAutoUpdate = mesh.matrixAutoUpdate;
      stand.matrix.copy(mesh.matrix);
      stand.position.copy(mesh.position);
      stand.quaternion.copy(mesh.quaternion);
      stand.scale.copy(mesh.scale);
      stand.pivot = mesh.pivot;
      const partMeshes = parts.map((geometry, k) => {
        const part = new Mesh(geometry, mesh.material);
        part.name = `${PART_PLACEHOLDER_PREFIX}${i}_${k}`;
        part.matrixAutoUpdate = false;
        part.matrix.copy(IDENTITY);
        part.parent = stand;
        partNames.set(part.name, names[k]);
        return part;
      });
      // Same children (order kept), parts appended. Never `add()`: that would detach them from the mesh.
      stand.children = [...mesh.children, ...partMeshes];
      for (const child of mesh.children) child.parent = stand;
      // The CURRENT parent: a split mesh's stand when the parent mesh was swapped before.
      const parent = mesh.parent;
      const at = parent ? parent.children.indexOf(mesh) : -1;
      if (!parent || at < 0) throw new Error(`Cannot split ${mesh.name}: detached from the export tree`);
      parent.children[at] = stand;
      stand.parent = parent;
      swaps.push({ parent, at, mesh, stand });
    }
    const layer = modelLayerLengthBound(scene, { animations: options.animations, animationFrameRate: options.animationFrameRate });
    if (layer > maxModel) throw new UsdExportTooLargeError('usd-model-layer-too-large', 'model.usda', layer, maxModel);
    let partGeometries = 0;
    for (const parts of cache.values()) partGeometries += parts?.length ?? 0;
    return await run({ partNames, splitMeshes: swaps.length, partGeometries });
  } finally {
    for (let s = swaps.length - 1; s >= 0; s--) {
      const { parent, at, mesh, stand } = swaps[s];
      const where = parent.children[at] === stand ? at : parent.children.indexOf(stand);
      if (where >= 0) parent.children[where] = mesh;
      for (const child of mesh.children) child.parent = mesh;
      stand.children = [];
      stand.parent = null;
    }
    for (const parts of cache.values()) for (const geometry of parts ?? []) releasePart(geometry);
    cache.clear();
  }
}

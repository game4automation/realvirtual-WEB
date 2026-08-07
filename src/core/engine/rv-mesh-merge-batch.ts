// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mesh-merge batch staging (plan-274 Phase 1, B2).
 *
 * Converts merge candidates into slice-wise {@link MergeBatch} payloads for a
 * {@link MeshMergePort} — ONE bulk copy pass instead of the legacy per-mesh
 * `geometry.clone()` + `toNonIndexed()` + `applyMatrix4()` churn.
 *
 * Canonicalization (§5.3 exotic-geometry contract):
 *   - positions/normals → tightly packed f32×3, de-interleaved
 *     (InterleavedBufferAttribute) and dequantized (KHR_mesh_quantization
 *     `normalized:true` Int16/Int8 — read through `getX/getY/getZ`, which
 *     denormalizes exactly like the legacy `.applyMatrix4()` path did)
 *   - color → u8×3 normalized, rmPacked → u8×2 normalized; float sources are
 *     quantized to u8; meshes missing the attribute inside a mixed slice are
 *     pre-filled (color: 255/white, rmPacked: [255, 0] = rough, non-metal —
 *     the legacy path silently dropped the whole chunk in that case, B4)
 *   - index → u32, mesh-local values (the port rebases per chunk); when the
 *     pass is non-indexed, indexed sources are expanded during staging
 *     (`toNonIndexed()` parity)
 *   - missing normals are computed here in source-local space
 *     (`computeVertexNormals()` parity — flat normals for expanded
 *     geometry, smooth for indexed)
 *
 * Source geometries are NEVER mutated or detached — staging is copy-only.
 *
 * Slice rules (B2): slices hold 2-4M vertices and are cut ONLY at chunk
 * boundaries (computed with the same greedy packing the port uses, so the
 * per-slice chunk structure equals the legacy full-pass structure), and
 * chunks never span groups — so a slice never splits a Drive group either.
 * Batches below {@link SMALL_MODEL_VERTEX_THRESHOLD} stay in a single slice
 * (no slice overhead for small models).
 */

import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
} from 'three';
import {
  computeChunkRanges,
  SMALL_MODEL_VERTEX_THRESHOLD,
  type MergeBatch,
  type MeshDescriptor,
} from './rv-mesh-merge-port';

// ─── Types ──────────────────────────────────────────────────────────

/** A merge candidate: a mesh plus the group (bake target) it belongs to.
 *  Candidates must arrive grouped (all meshes of a group contiguous) and in
 *  final merge order. */
export interface MeshMergeCandidate {
  mesh: Mesh;
  /** Index into the `groupInverses` array passed to {@link buildMergeBatches}. */
  groupId: number;
}

export interface BuildMergeBatchesOptions {
  /** True when EVERY candidate geometry is indexed (all-or-none, decided by
   *  the caller exactly like the legacy pass). */
  keepIndexed: boolean;
  /** Output chunk vertex budget (forwarded into every batch). */
  chunkVertexBudget: number;
  /** Max staged vertices per slice (B2: 2-4M). Default 3M. */
  sliceVertexBudget?: number;
}

/** Default slice budget — middle of the 2-4M contract (B2). */
export const SLICE_VERTEX_BUDGET = 3_000_000;

// ─── Attribute staging helpers ──────────────────────────────────────

type AnyAttr = BufferAttribute | InterleavedBufferAttribute;

function isPlainFastAttr(attr: AnyAttr, arrayCtor: new (...a: never[]) => unknown, itemSize: number): attr is BufferAttribute {
  return (
    (attr as InterleavedBufferAttribute).isInterleavedBufferAttribute !== true &&
    attr.itemSize === itemSize &&
    !attr.normalized &&
    (attr as BufferAttribute).array instanceof arrayCtor
  );
}

/** Stage a 3-component float attribute (position/normal) into `out` at
 *  `dstVert*3`, optionally expanded through `index` (non-indexed staging). */
function stageFloat3(
  attr: AnyAttr,
  out: Float32Array,
  dstVert: number,
  count: number,
  index: BufferAttribute | null,
): void {
  let t = dstVert * 3;
  if (!index && isPlainFastAttr(attr, Float32Array, 3)) {
    const src = attr.array as Float32Array;
    out.set(src.subarray(0, count * 3), t);
    return;
  }
  for (let i = 0; i < count; i++, t += 3) {
    const v = index ? index.getX(i) : i;
    out[t] = attr.getX(v);
    out[t + 1] = attr.getY(v);
    out[t + 2] = attr.getZ(v);
  }
}

/** Stage a normalized-u8 attribute (color×3 / rmPacked×2) into `out`.
 *  Float or non-u8 sources are quantized (`round(clamp01(v)*255)`). */
function stageU8(
  attr: AnyAttr,
  out: Uint8Array,
  dstVert: number,
  count: number,
  itemSize: 2 | 3,
  index: BufferAttribute | null,
): void {
  let t = dstVert * itemSize;
  const isU8 =
    (attr as InterleavedBufferAttribute).isInterleavedBufferAttribute !== true &&
    attr.itemSize === itemSize &&
    attr.normalized &&
    (attr as BufferAttribute).array instanceof Uint8Array;
  if (!index && isU8) {
    const src = (attr as BufferAttribute).array as Uint8Array;
    out.set(src.subarray(0, count * itemSize), t);
    return;
  }
  const q = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let i = 0; i < count; i++, t += itemSize) {
    const v = index ? index.getX(i) : i;
    out[t] = q(attr.getX(v));
    if (itemSize >= 2) out[t + 1] = q(attr.getY(v));
    if (itemSize >= 3) out[t + 2] = q(attr.getZ(v));
  }
}

/**
 * Compute normals for a source geometry WITHOUT mutating it — legacy
 * `computeVertexNormals()` parity on the staged (source-local) positions.
 * The temp geometry wraps views over the already-staged position slice plus
 * (for indexed batches) the source index — `computeVertexNormals()` only
 * writes a NEW normal attribute onto the temp object.
 */
function computeMissingNormals(
  stagedPos: Float32Array,
  dstVert: number,
  count: number,
  index: BufferAttribute | null,
  out: Float32Array,
): void {
  const temp = new BufferGeometry();
  const posView = stagedPos.subarray(dstVert * 3, (dstVert + count) * 3);
  temp.setAttribute('position', new BufferAttribute(posView, 3));
  if (index) {
    temp.setIndex(new BufferAttribute(index.array as Uint16Array | Uint32Array, 1));
  }
  temp.computeVertexNormals();
  const normal = temp.getAttribute('normal') as BufferAttribute;
  out.set(normal.array as Float32Array, dstVert * 3);
}

// ─── Arena canonicalization (BatchedMesh path) ──────────────────────

/** One attribute slot of a BatchedMesh arena layout. `color` and `rmPacked`
 *  are always staged as Uint8 normalized; every other attribute as Float32. */
export interface ArenaAttrSpec {
  name: string;
  itemSize: number;
}

/** Fixed arena layout for the static uber batch: exactly the attributes the
 *  RVUberMaterial consumes. Extra source attributes (uv, tangent, …) are
 *  stripped — the uber material never reads them and BatchedMesh demands a
 *  uniform attribute set per arena. */
export const UBER_ARENA_LAYOUT: readonly ArenaAttrSpec[] = [
  { name: 'position', itemSize: 3 },
  { name: 'normal', itemSize: 3 },
  { name: 'color', itemSize: 3 },
  { name: 'rmPacked', itemSize: 2 },
];

/** Attribute-layout signature used to group textured geometries into
 *  same-arena batches (names + item sizes; indexed-ness is normalized away
 *  by {@link canonicalizeForArena}, which always emits indexed output). */
export function arenaSignatureOf(geom: BufferGeometry): string {
  const names = Object.keys(geom.attributes).sort();
  return names.map((n) => `${n}:${geom.getAttribute(n).itemSize}`).join('|');
}

/** Arena layout derived from a geometry's own attributes (textured batches):
 *  every source attribute is kept, staged f32 except color (u8n). */
export function arenaLayoutOf(geom: BufferGeometry): ArenaAttrSpec[] {
  return Object.keys(geom.attributes)
    .sort()
    .map((name) => ({ name, itemSize: geom.getAttribute(name).itemSize }));
}

/** Stage an N-component float attribute (uv, tangent, …) into `out` —
 *  de-interleaves and dequantizes exactly like {@link stageFloat3}. */
function stageFloatN(attr: AnyAttr, out: Float32Array, itemSize: number): void {
  const count = attr.count;
  if (itemSize === 3 && isPlainFastAttr(attr, Float32Array, 3)) {
    out.set((attr.array as Float32Array).subarray(0, count * 3));
    return;
  }
  let t = 0;
  for (let i = 0; i < count; i++, t += itemSize) {
    out[t] = attr.getX(i);
    if (itemSize >= 2) out[t + 1] = attr.getY(i);
    if (itemSize >= 3) out[t + 2] = attr.getZ(i);
    if (itemSize >= 4) out[t + 3] = attr.getW(i);
  }
}

/** True when `geom` already matches `spec` exactly (plain, tightly-packed
 *  attributes of the canonical array type) AND is indexed — i.e. it can be
 *  handed to `BatchedMesh.addGeometry` as-is, no staging copy needed. */
function isArenaCanonical(geom: BufferGeometry, spec: readonly ArenaAttrSpec[]): boolean {
  if (!geom.index) return false;
  const names = Object.keys(geom.attributes);
  if (names.length !== spec.length) return false;
  for (const s of spec) {
    const attr = geom.getAttribute(s.name) as AnyAttr | undefined;
    if (!attr) return false;
    const wantU8 = s.name === 'color' || s.name === 'rmPacked';
    if (wantU8) {
      const ok =
        (attr as InterleavedBufferAttribute).isInterleavedBufferAttribute !== true &&
        attr.itemSize === s.itemSize &&
        attr.normalized &&
        (attr as BufferAttribute).array instanceof Uint8Array;
      if (!ok) return false;
    } else if (!isPlainFastAttr(attr, Float32Array, s.itemSize)) {
      return false;
    }
  }
  return true;
}

/**
 * Canonicalize a geometry for a BatchedMesh arena with the given layout:
 *   - every non-color attribute → tightly-packed Float32 (de-interleaved,
 *     dequantized via getX/getY/getZ/getW)
 *   - `color` → u8n×3 (default white when the source lacks it)
 *   - `rmPacked` → u8n×2 (default [255, 0] = rough, non-metal)
 *   - missing `normal` → computed (computeVertexNormals parity)
 *   - always indexed (trivial 0..n-1 ramp for non-indexed sources) — the
 *     arena is uniformly indexed and `_validateGeometry` demands all-or-none
 *   - attributes NOT in `spec` are stripped
 *
 * Source geometry is never mutated. When the source already matches the
 * layout it is returned as-is (addGeometry copies out of it; no mutation).
 * Canonical copies carry no GPU resources — they exist only as the staging
 * source for `addGeometry` and can simply be dropped afterwards.
 */
export function canonicalizeForArena(
  geom: BufferGeometry,
  spec: readonly ArenaAttrSpec[],
): BufferGeometry {
  if (isArenaCanonical(geom, spec)) return geom;

  const pos = geom.getAttribute('position');
  if (!pos) throw new Error('[canonicalizeForArena] geometry has no position attribute');
  const vCount = pos.count;
  const out = new BufferGeometry();

  for (const s of spec) {
    const attr = geom.getAttribute(s.name) as AnyAttr | undefined;
    if (s.name === 'color' || s.name === 'rmPacked') {
      const arr = new Uint8Array(vCount * s.itemSize);
      if (attr) {
        stageU8(attr, arr, 0, vCount, s.itemSize as 2 | 3, null);
      } else if (s.name === 'color') {
        arr.fill(255);
      } else {
        for (let i = 0; i < vCount; i++) {
          arr[i * 2] = 255;
          arr[i * 2 + 1] = 0;
        }
      }
      out.setAttribute(s.name, new BufferAttribute(arr, s.itemSize, true));
      continue;
    }
    const arr = new Float32Array(vCount * s.itemSize);
    if (attr) {
      stageFloatN(attr, arr, s.itemSize);
    } else if (s.name === 'normal') {
      // Deferred: computed below once position (and index) are in place.
    }
    out.setAttribute(s.name, new BufferAttribute(arr, s.itemSize));
  }

  // Index: copy as u32, or synthesize a trivial ramp for non-indexed sources.
  const srcIndex = geom.index;
  let indexArr: Uint32Array;
  if (srcIndex) {
    indexArr = new Uint32Array(srcIndex.count);
    for (let i = 0; i < srcIndex.count; i++) indexArr[i] = srcIndex.getX(i);
  } else {
    indexArr = new Uint32Array(vCount);
    for (let i = 0; i < vCount; i++) indexArr[i] = i;
  }
  out.setIndex(new BufferAttribute(indexArr, 1));

  // Missing normals: compute on the canonical copy (indexed → smooth).
  if (spec.some((s) => s.name === 'normal') && !geom.getAttribute('normal')) {
    out.computeVertexNormals();
  }

  out.userData._rvArenaCanonical = true;
  return out;
}

/**
 * Return a copy of `geom` with the triangle winding reversed (i0,i2,i1 per
 * face). Attribute buffers are SHARED with the input — only the index is new
 * (`addGeometry` copies out of it, and canonical copies are dropped after
 * staging, so sharing is safe and the source is never mutated).
 *
 * Needed for negative-determinant (mirrored) instances in a BatchedMesh
 * arena: the GL front-face is per draw call, not per instance, so a mirrored
 * instance rendered with the shared index shows its BACK faces — wrong
 * culling in every pass and inward-facing normals in the GTAO/toon gbuffers.
 * Pre-flipping the winding compensates; the batching shader's normal
 * transform is then correct on its own (for a rotation+mirror matrix the
 * inverse-transpose equals the matrix itself).
 */
export function flipWinding(geom: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry();
  for (const name of Object.keys(geom.attributes)) {
    out.setAttribute(name, geom.attributes[name]);
  }
  const src = geom.index;
  const count = src ? src.count : geom.getAttribute('position').count;
  const arr = new Uint32Array(count);
  if (src) {
    for (let i = 0; i < count; i++) arr[i] = src.getX(i);
  } else {
    for (let i = 0; i < count; i++) arr[i] = i;
  }
  for (let i = 0; i + 2 < count; i += 3) {
    const t = arr[i + 1];
    arr[i + 1] = arr[i + 2];
    arr[i + 2] = t;
  }
  out.setIndex(new BufferAttribute(arr, 1));
  out.userData._rvArenaCanonical = true;
  return out;
}

// ─── Staged size computation ────────────────────────────────────────

interface StagedCounts {
  vertexCount: number;
  indexCount: number;
}

function stagedCountsOf(mesh: Mesh, keepIndexed: boolean): StagedCounts {
  const geom = mesh.geometry;
  const pos = geom.getAttribute('position');
  const index = geom.index;
  if (keepIndexed) {
    return { vertexCount: pos.count, indexCount: index ? index.count : 0 };
  }
  return { vertexCount: index ? index.count : pos.count, indexCount: 0 };
}

// ─── Main entry ─────────────────────────────────────────────────────

/**
 * Stage merge candidates into one or more {@link MergeBatch} slices.
 *
 * @param candidates      Candidates in final merge order, groups contiguous.
 * @param groupInverses   Bake-target inverse per groupId (B1) — static pass:
 *                        `[rootInverse]`; kinematic pass: one per Drive group.
 * @param opts            keepIndexed / chunk budget / slice budget.
 */
export function buildMergeBatches(
  candidates: readonly MeshMergeCandidate[],
  groupInverses: readonly Matrix4[],
  opts: BuildMergeBatchesOptions,
): MergeBatch[] {
  if (candidates.length === 0) return [];
  const keepIndexed = opts.keepIndexed;
  const sliceBudget = opts.sliceVertexBudget ?? SLICE_VERTEX_BUDGET;

  // Pass 1: staged sizes + chunk ranges (aligning slice cuts to chunk
  // boundaries keeps the per-slice greedy packing identical to a legacy
  // full-pass run).
  const counts = candidates.map((c) => {
    const staged = stagedCountsOf(c.mesh, keepIndexed);
    return { vertexCount: staged.vertexCount, indexCount: staged.indexCount, groupId: c.groupId };
  });
  const chunkRanges = computeChunkRanges(counts, opts.chunkVertexBudget);
  const totalVerts = counts.reduce((s, c) => s + c.vertexCount, 0);

  // Pass 2: pack whole chunks into slices. Small models skip the slice
  // machinery entirely (one staging pass, one merge call) — unless the
  // caller pinned an explicit slice budget (tests, benchmarks).
  const slices: { start: number; end: number }[] = [];
  if (opts.sliceVertexBudget === undefined && totalVerts < SMALL_MODEL_VERTEX_THRESHOLD) {
    slices.push({ start: 0, end: candidates.length });
  } else {
    let sliceStart = 0;
    let sliceVerts = 0;
    for (const range of chunkRanges) {
      if (sliceVerts > 0 && sliceVerts + range.vertexCount > sliceBudget) {
        slices.push({ start: sliceStart, end: range.start });
        sliceStart = range.start;
        sliceVerts = 0;
      }
      sliceVerts += range.vertexCount;
    }
    if (sliceStart < candidates.length) {
      slices.push({ start: sliceStart, end: candidates.length });
    }
  }

  // Pass 3: stage each slice.
  const batches: MergeBatch[] = [];
  for (const slice of slices) {
    batches.push(stageSlice(candidates, counts, groupInverses, slice.start, slice.end, opts));
  }
  return batches;
}

function stageSlice(
  candidates: readonly MeshMergeCandidate[],
  counts: readonly { vertexCount: number; indexCount: number }[],
  groupInverses: readonly Matrix4[],
  start: number,
  end: number,
  opts: BuildMergeBatchesOptions,
): MergeBatch {
  const keepIndexed = opts.keepIndexed;

  // Slice totals + slice-local group table (preserve first-seen order).
  let sliceVerts = 0;
  let sliceIndices = 0;
  let anyColor = false;
  let anyRm = false;
  const localGroupIds = new Map<number, number>();
  for (let i = start; i < end; i++) {
    sliceVerts += counts[i].vertexCount;
    sliceIndices += counts[i].indexCount;
    const geom = candidates[i].mesh.geometry;
    if (geom.getAttribute('color')) anyColor = true;
    if (geom.getAttribute('rmPacked')) anyRm = true;
    if (!localGroupIds.has(candidates[i].groupId)) {
      localGroupIds.set(candidates[i].groupId, localGroupIds.size);
    }
  }

  const groupTable = new Float32Array(localGroupIds.size * 16);
  for (const [globalId, localId] of localGroupIds) {
    groupInverses[globalId].toArray(groupTable, localId * 16);
  }

  const position = new Float32Array(sliceVerts * 3);
  const normal = new Float32Array(sliceVerts * 3);
  const color = anyColor ? new Uint8Array(sliceVerts * 3) : null;
  const rmPacked = anyRm ? new Uint8Array(sliceVerts * 2) : null;
  const index = keepIndexed && sliceIndices > 0 ? new Uint32Array(sliceIndices) : null;

  const descriptors: MeshDescriptor[] = [];
  let dstVert = 0;
  let dstIdx = 0;

  for (let i = start; i < end; i++) {
    const mesh = candidates[i].mesh;
    const geom = mesh.geometry;
    const n = counts[i].vertexCount;
    const srcIndex = geom.index;
    // Expansion index: only used when the pass is non-indexed AND this
    // source is indexed (toNonIndexed parity).
    const expand = !keepIndexed && srcIndex ? srcIndex : null;

    const posAttr = geom.getAttribute('position') as AnyAttr;
    stageFloat3(posAttr, position, dstVert, n, expand);

    const normalAttr = geom.getAttribute('normal') as AnyAttr | undefined;
    const hasNormal = !!normalAttr;
    if (normalAttr) {
      stageFloat3(normalAttr, normal, dstVert, n, expand);
    } else {
      computeMissingNormals(position, dstVert, n, keepIndexed ? srcIndex : null, normal);
    }

    const colorAttr = geom.getAttribute('color') as AnyAttr | undefined;
    const hasColor = !!colorAttr;
    if (color) {
      if (colorAttr) stageU8(colorAttr, color, dstVert, n, 3, expand);
      else color.fill(255, dstVert * 3, (dstVert + n) * 3);
    }

    const rmAttr = geom.getAttribute('rmPacked') as AnyAttr | undefined;
    const hasRm = !!rmAttr;
    if (rmPacked) {
      if (rmAttr) {
        stageU8(rmAttr, rmPacked, dstVert, n, 2, expand);
      } else {
        // Default: roughness 1.0, metalness 0.
        for (let v = 0; v < n; v++) {
          rmPacked[(dstVert + v) * 2] = 255;
          rmPacked[(dstVert + v) * 2 + 1] = 0;
        }
      }
    }

    if (index && srcIndex) {
      for (let k = 0; k < counts[i].indexCount; k++) {
        index[dstIdx + k] = srcIndex.getX(k);
      }
      dstIdx += counts[i].indexCount;
    }

    descriptors.push({
      vertexCount: n,
      indexCount: counts[i].indexCount,
      hasNormal,
      hasColor,
      hasRm,
      groupId: localGroupIds.get(candidates[i].groupId)!,
      worldMatrix: Float32Array.from(mesh.matrixWorld.elements),
    });

    dstVert += n;
  }

  return {
    keepIndexed,
    chunkVertexBudget: opts.chunkVertexBudget,
    groupCount: localGroupIds.size,
    groupInverses: groupTable,
    descriptors,
    position,
    normal,
    color,
    rmPacked,
    index,
  };
}

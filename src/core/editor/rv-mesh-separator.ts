// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-separator — pure geometry core of the mesh separator (plan-331, Phase 1).
 *
 * Port of Unity's `MeshSeparator.cs`
 * (`Packages/io.realvirtual.professional/Editor/MeshSeparator.cs`). No scene graph, no
 * registry, no viewer: every function here takes a `BufferGeometry` (or a `Mesh` for the
 * guards) and returns plain data, which is what makes it unit-testable **and** runnable
 * inside a Web Worker without dragging the engine along.
 *
 * ## The one rule that must never be broken
 *
 * **Weld and output are separate roles.**
 *
 * The weld (`weldVertexIds`) quantizes **only the position** and exists **only** to build
 * the connectivity graph. The output geometry (`extractSubGeometry`) is rebuilt from the
 * **original** vertex indices, so normals, UVs and hard edges survive untouched.
 *
 * Mixing the two roles — e.g. by reaching for `BufferGeometryUtils.mergeVertices()` — is
 * silently wrong: `mergeVertices` hashes **all** attributes, so a hard-edged CAD cube
 * (which has its own normal per face at every shared corner) welds nothing and the
 * union-find reports **6 islands for a single cube**. Unity's `HashVertex`
 * (`MeshSeparator.cs:314-321`) hashes the position and nothing else, for exactly this
 * reason. `tests/rv-mesh-separator.test.ts` guards it (test 9.2).
 *
 * ## `weldThreshold` is a quantization resolution, not a distance tolerance
 *
 * `Math.round(coord / resolution)` is a grid snap without a neighbour-cell probe: two
 * points closer than `resolution` can still fall into adjacent cells and stay separate.
 * That is Unity-identical behaviour and is documented as the contract rather than
 * papered over with a distance guarantee the algorithm does not keep.
 */

import { BufferAttribute, BufferGeometry } from 'three';
import type { Mesh } from 'three';
import { unsupportedGeometryShapeReason, unsupportedMeshShapeReason } from '../engine/rv-mesh-guards';

// ─── Constants ──────────────────────────────────────────────────────────

/** Unity parity: `MeshSeparator.SeparateFromContextMenu()` passes `0.0001f`. */
export const DEFAULT_WELD_THRESHOLD = 0.0001;

/** Reported when the island analysis finds a single connected component (F7). */
export const REASON_SINGLE_PART = 'Mesh is a single connected part';

/** Reported when the island mode is asked to handle a multi-material mesh. */
export const REASON_MULTI_MATERIAL = 'Multi-material mesh — use *By material group* instead';

/** Reported when the group mode finds fewer than two material groups. */
export const REASON_NO_GROUPS = 'Mesh has no separable material groups';

/** Reported when the group table is inconsistent with the triangle count. */
export const REASON_MALFORMED_GROUPS = 'Geometry groups are malformed';

/** Reported when a group points at a material slot that does not exist. */
export const REASON_MISSING_MATERIAL = 'Geometry group references a missing material';

/**
 * Largest absolute grid coordinate accepted by the weld.
 *
 * Grid coordinates are kept in `Int32Array`s. Beyond this magnitude a coordinate would
 * wrap silently and weld unrelated vertices together — the same failure class as
 * three.js #31550 (`mergeVertices` with tolerance 0 overflowing without a warning).
 */
const MAX_GRID_COORD = 1 << 30;

/**
 * Smallest resolution the weld may use for a geometry, given its coordinate range.
 *
 * A CAD import in millimetres is routinely placed thousands of units from the origin;
 * at the fixed {@link DEFAULT_WELD_THRESHOLD} such a coordinate quantizes past
 * {@link MAX_GRID_COORD} and `weldVertexIds` throws. The whole separate then aborted
 * with nothing but a console message — the user saw the dialog vanish and no parts.
 *
 * So the requested resolution is a **wish**, not a promise: it is raised (never lowered)
 * to whatever keeps the grid inside its safe range. Half the range is the budget, so the
 * rounding of the extreme coordinate cannot land on the boundary.
 *
 * Derived purely from the geometry, so the live run and a later replay — which resolves
 * it again from the same geometry — always agree on the grid.
 */
export function resolveWeldResolution(
  geom: BufferGeometry,
  requested: number = DEFAULT_WELD_THRESHOLD,
): number {
  const pos = geom.getAttribute('position');
  if (!pos || !Number.isFinite(requested) || requested <= 0) return requested;

  let maxAbs = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = Math.abs(pos.getX(i));
    const y = Math.abs(pos.getY(i));
    const z = Math.abs(pos.getZ(i));
    if (x > maxAbs) maxAbs = x;
    if (y > maxAbs) maxAbs = y;
    if (z > maxAbs) maxAbs = z;
  }
  if (!Number.isFinite(maxAbs) || maxAbs === 0) return requested;

  const minimum = maxAbs / (MAX_GRID_COORD / 2);
  return requested >= minimum ? requested : minimum;
}

// ─── Types ──────────────────────────────────────────────────────────────

/** The typed arrays a `BufferAttribute` can be backed by. */
export type AttributeArray =
  | Float32Array | Float64Array
  | Int8Array | Int16Array | Int32Array
  | Uint8Array | Uint8ClampedArray | Uint16Array | Uint32Array;

/** A `BufferAttribute` reduced to what has to cross a worker boundary. */
export interface SerializedAttribute {
  array: AttributeArray;
  itemSize: number;
  normalized: boolean;
}

/** How a mesh is cut into parts. */
export type SeparateMode = 'islands' | 'groups';

/** A `geometry.groups` entry, structurally cloneable. */
export interface GeometryGroupSpec {
  start: number;
  count: number;
  materialIndex: number;
}

/**
 * Worker request. Carries an `id` that increases monotonically — the client drops any
 * response whose `id` is no longer the latest one.
 *
 * The arrays in a request are **copied**, never transferred. Transferring would detach
 * the `ArrayBuffer` of the **live** source geometry and take rendering and raycasting
 * down with it. Only responses are transferred, because those buffers are freshly built
 * inside the worker and belong to nobody else.
 */
export type SeparateRequest =
  | {
      id: number;
      phase: 'analyze';
      mode: SeparateMode;
      position: Float32Array;
      index: Uint32Array | null;
      resolution: number;
      groups?: GeometryGroupSpec[];
    }
  | {
      id: number;
      phase: 'extract';
      attributes: Record<string, SerializedAttribute>;
      index: Uint32Array | null;
      partitions: number[][];
    };

/** Worker response. */
export type SeparateResponse =
  | { id: number; ok: true; phase: 'analyze'; partitions: number[][] }
  | {
      id: number;
      ok: true;
      phase: 'extract';
      parts: { attributes: Record<string, SerializedAttribute>; index: Uint32Array }[];
    }
  | { id: number; ok: false; error: string };

// ─── Guards ─────────────────────────────────────────────────────────────

/**
 * Returns why a mesh cannot be separated into connected islands, or `null` when it can.
 *
 * The multi-material case is deliberately routed to the group mode instead of remapping
 * `geometry.groups` per island — that keeps both modes simple and is consistent with the
 * WebViewer invariant "one mesh = one material".
 *
 * @param mesh       The candidate mesh.
 * @param resolution Quantization resolution for the island analysis. Defaults to
 *                   {@link DEFAULT_WELD_THRESHOLD}, so the documented one-argument
 *                   signature stays valid.
 *
 * Callers that already hold a partition list (the worker path computes it off-thread)
 * should skip the analysis here and compare against {@link REASON_SINGLE_PART} themselves
 * rather than paying for a second union-find.
 */
export function islandModeIneligibility(
  mesh: Mesh,
  resolution: number = DEFAULT_WELD_THRESHOLD,
): string | null {
  const shape = unsupportedMeshShapeReason(mesh);
  if (shape) return shape;

  if (Array.isArray(mesh.material)) return REASON_MULTI_MATERIAL;

  const partitions = computeMeshIslands(mesh.geometry as BufferGeometry, resolution);
  if (partitions.length <= 1) return REASON_SINGLE_PART;

  return null;
}

/**
 * Returns why a mesh cannot be separated by `geometry.groups`, or `null` when it can.
 *
 * Unlike the island mode this **accepts** a material array — that is the normal case
 * here — and validates the group table instead.
 */
export function groupModeIneligibility(mesh: Mesh): string | null {
  const shape = unsupportedMeshShapeReason(mesh);
  if (shape) return shape;

  const geom = mesh.geometry as BufferGeometry;
  const groups = geom.groups ?? [];
  if (groups.length < 2) return REASON_NO_GROUPS;

  const totalTris = triangleCount(geom);
  const materials = mesh.material;
  const slotCount = Array.isArray(materials) ? materials.length : 1;

  // Overlap detection over triangle ranges, order-independent.
  const sorted = groups
    .map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex ?? 0 }))
    .sort((a, b) => a.start - b.start);

  let previousEnd = -1;
  for (const group of sorted) {
    if (!Number.isInteger(group.start) || !Number.isInteger(group.count)) return REASON_MALFORMED_GROUPS;
    if (group.start < 0 || group.count <= 0) return REASON_MALFORMED_GROUPS;
    if (group.start % 3 !== 0 || group.count % 3 !== 0) return REASON_MALFORMED_GROUPS;
    if (group.start + group.count > totalTris * 3) return REASON_MALFORMED_GROUPS;
    if (group.start < previousEnd) return REASON_MALFORMED_GROUPS;
    previousEnd = group.start + group.count;

    if (!Number.isInteger(group.materialIndex) || group.materialIndex < 0) return REASON_MISSING_MATERIAL;
    if (group.materialIndex >= slotCount) return REASON_MISSING_MATERIAL;
  }

  return null;
}

// ─── Weld ───────────────────────────────────────────────────────────────

/**
 * Position-only quantization: the canonical vertex index for every vertex.
 *
 * Two vertices share a canonical index exactly when their positions round into the same
 * grid cell of edge length `resolution`. Nothing but the position is looked at — see the
 * module header for why that is load-bearing.
 *
 * Implemented with a `Math.imul` hash over open-addressed, collision-checked buckets
 * rather than a string-key map: measured ~2x faster across the plan-331 spike with
 * identical island counts in all 13 comparison pairs.
 *
 * @throws RangeError if `resolution` is not finite and > 0, if the geometry has no
 *         position attribute, or if a coordinate exceeds the safe grid range.
 */
export function weldVertexIds(geom: BufferGeometry, resolution: number): Uint32Array {
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new RangeError(
      `weldVertexIds: resolution must be a finite number > 0, got ${String(resolution)}`,
    );
  }

  const pos = geom.getAttribute('position');
  if (!pos) throw new RangeError('weldVertexIds: geometry has no position attribute');

  const count = pos.count;
  const canon = new Uint32Array(count);
  if (count === 0) return canon;

  const inv = 1 / resolution;

  // Grid coordinates are precomputed once so bucket comparisons are plain array reads.
  const gx = new Int32Array(count);
  const gy = new Int32Array(count);
  const gz = new Int32Array(count);

  // Fast path: a plain, non-normalized Float32 position attribute is the overwhelming
  // majority and lets us skip three accessor calls per vertex.
  const raw = pos.array as AttributeArray;
  const plain =
    (pos as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute !== true &&
    pos.normalized !== true &&
    pos.itemSize === 3 &&
    raw instanceof Float32Array;

  for (let i = 0; i < count; i++) {
    let x: number;
    let y: number;
    let z: number;
    if (plain) {
      const o = i * 3;
      x = raw[o];
      y = raw[o + 1];
      z = raw[o + 2];
    } else {
      x = pos.getX(i);
      y = pos.getY(i);
      z = pos.getZ(i);
    }

    const qx = Math.round(x * inv);
    const qy = Math.round(y * inv);
    const qz = Math.round(z * inv);
    if (
      !(qx >= -MAX_GRID_COORD && qx <= MAX_GRID_COORD) ||
      !(qy >= -MAX_GRID_COORD && qy <= MAX_GRID_COORD) ||
      !(qz >= -MAX_GRID_COORD && qz <= MAX_GRID_COORD)
    ) {
      throw new RangeError(
        `weldVertexIds: vertex ${i} quantizes outside the safe grid range at resolution ` +
        `${resolution} — the coordinate is not finite or the resolution is far too small`,
      );
    }
    gx[i] = qx;
    gy[i] = qy;
    gz[i] = qz;
  }

  // Open-addressed table, power-of-two capacity, load factor <= 0.5.
  let capacity = 16;
  while (capacity < count * 2) capacity *= 2;
  const mask = capacity - 1;
  // 0 = empty, otherwise the canonical vertex index + 1.
  const buckets = new Uint32Array(capacity);

  for (let i = 0; i < count; i++) {
    const x = gx[i];
    const y = gy[i];
    const z = gz[i];

    let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349669) ^ Math.imul(z, 83492791);
    // Finalizer — the three multiplied coordinates alone cluster badly on axis-aligned grids.
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;

    let slot = h & mask;
    for (;;) {
      const stored = buckets[slot];
      if (stored === 0) {
        buckets[slot] = i + 1;
        canon[i] = i;
        break;
      }
      const candidate = stored - 1;
      if (gx[candidate] === x && gy[candidate] === y && gz[candidate] === z) {
        canon[i] = candidate;
        break;
      }
      slot = (slot + 1) & mask;
    }
  }

  return canon;
}

// ─── Union-Find ─────────────────────────────────────────────────────────
//
// Iterative with path halving and union by rank. Explicitly **not** recursive:
// Blender T70864 documents "Separate by Loose Parts" escalating to a force-quit on
// complex meshes for exactly that reason.

function ufFind(parent: Uint32Array, start: number): number {
  let i = start;
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

function ufUnion(parent: Uint32Array, rank: Uint8Array, a: number, b: number): void {
  const ra = ufFind(parent, a);
  const rb = ufFind(parent, b);
  if (ra === rb) return;
  if (rank[ra] < rank[rb]) parent[ra] = rb;
  else if (rank[ra] > rank[rb]) parent[rb] = ra;
  else {
    parent[rb] = ra;
    rank[ra]++;
  }
}

// ─── Partitioning ───────────────────────────────────────────────────────

/** Number of triangles in a geometry, indexed or not. */
export function triangleCount(geom: BufferGeometry): number {
  const index = geom.index;
  if (index) return Math.floor(index.count / 3);
  const pos = geom.getAttribute('position');
  return pos ? Math.floor(pos.count / 3) : 0;
}

/**
 * Connected components of a geometry, as lists of triangle indices.
 *
 * Returns an **empty** array when the geometry forms a single island (Unity parity,
 * `MeshSeparator.cs:90`) — "nothing to separate" is expressed by the empty result, not by
 * a one-element list.
 *
 * Partitions are ordered by the first triangle that reaches them, which makes the result
 * deterministic — the generated child names depend on it.
 *
 * Fully degenerate triangles (all three vertices welding into the same cell) contribute
 * no EDGES to the union-find, so they cannot change the island count — but they are still
 * output, attached to the island their welded vertex belongs to. Only a degenerate island
 * of its own is dropped. Every triangle of the source therefore reaches exactly one part:
 * the parts reassemble the original mesh, which is what keeps sub-resolution CAD detail
 * from disappearing.
 *
 * `resolution` is the REQUESTED grid; the effective one comes from
 * {@link resolveWeldResolution}, which raises it when the coordinate range would overflow
 * the integer grid.
 */
export function computeMeshIslands(
  geom: BufferGeometry,
  resolution: number = DEFAULT_WELD_THRESHOLD,
): number[][] {
  const pos = geom.getAttribute('position');
  if (!pos) return [];

  const triCount = triangleCount(geom);
  if (triCount === 0) return [];

  const grid = resolveWeldResolution(geom, resolution);
  const canon = weldVertexIds(geom, grid);
  const vertexCount = pos.count;
  const indexArray = geom.index ? (geom.index.array as AttributeArray) : null;

  const parent = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const rank = new Uint8Array(vertexCount);

  // Pass 1 — build the connectivity graph.
  for (let t = 0; t < triCount; t++) {
    const o = t * 3;
    const ia = indexArray ? indexArray[o] : o;
    const ib = indexArray ? indexArray[o + 1] : o + 1;
    const ic = indexArray ? indexArray[o + 2] : o + 2;
    if (ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) continue;

    const ca = canon[ia];
    const cb = canon[ib];
    const cc = canon[ic];
    if (ca === cb && cb === cc) continue; // degenerate — no edges, no surface

    ufUnion(parent, rank, ca, cb);
    ufUnion(parent, rank, ca, cc);
  }

  // Pass 2 — bucket the triangles by their island root.
  //
  // Degenerate triangles carried no edges into the graph, but they are still part of the
  // SOURCE surface: dropping them here silently deleted geometry, which is what made
  // sub-resolution CAD detail (fillet strips, small chamfers) vanish from the parts. So
  // they are bucketed too — after the real triangles, and only into a partition a real
  // triangle already opened. That keeps the island count and the partition order exactly
  // as before, while the sum of the partitions is again the whole mesh.
  const rootToPartition = new Map<number, number>();
  const partitions: number[][] = [];
  const degenerate: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const o = t * 3;
    const ia = indexArray ? indexArray[o] : o;
    const ib = indexArray ? indexArray[o + 1] : o + 1;
    const ic = indexArray ? indexArray[o + 2] : o + 2;
    if (ia >= vertexCount || ib >= vertexCount || ic >= vertexCount) continue;

    const ca = canon[ia];
    if (ca === canon[ib] && canon[ib] === canon[ic]) {
      degenerate.push(t);
      continue;
    }

    const root = ufFind(parent, ca);
    let slot = rootToPartition.get(root);
    if (slot === undefined) {
      slot = partitions.length;
      rootToPartition.set(root, slot);
      partitions.push([]);
    }
    partitions[slot].push(t);
  }

  // A degenerate triangle whose welded vertex no real triangle ever touched carries no
  // surface at all and would only open a zero-area part — that one stays dropped.
  for (const t of degenerate) {
    const o = t * 3;
    const ia = indexArray ? indexArray[o] : o;
    const slot = rootToPartition.get(ufFind(parent, canon[ia]));
    if (slot !== undefined) partitions[slot].push(t);
  }
  for (const partition of partitions) partition.sort((a, b) => a - b);

  return partitions.length <= 1 ? [] : partitions;
}

/**
 * Triangle index ranges per `geometry.group`, in group order.
 *
 * Returns an empty array when the geometry carries fewer than two groups — same "nothing
 * to separate" convention as {@link computeMeshIslands}.
 */
export function computeGroupPartitions(geom: BufferGeometry): number[][] {
  const groups = geom.groups ?? [];
  if (groups.length < 2) return [];

  const totalTris = triangleCount(geom);
  const partitions: number[][] = [];

  for (const group of groups) {
    const firstTri = Math.floor(group.start / 3);
    const triCount = Math.floor(group.count / 3);
    const triangles: number[] = [];
    for (let t = firstTri; t < firstTri + triCount && t < totalTris; t++) triangles.push(t);
    partitions.push(triangles);
  }

  return partitions;
}

// ─── Sub-geometry extraction ────────────────────────────────────────────
//
// Scratch buffers for the old -> new vertex remap. Reused across calls because a split
// into 1000 islands would otherwise allocate 1000 arrays the size of the source mesh.
// The generation stamp avoids re-filling the remap with -1 on every call.
// Safe to share: `extractSubGeometry` is synchronous and never re-entrant, and the
// worker gets its own module instance.

let _remapScratch = new Int32Array(0);
let _stampScratch = new Uint32Array(0);
let _stampGeneration = 0;

function ensureScratch(size: number): void {
  if (_remapScratch.length < size) {
    _remapScratch = new Int32Array(size);
    _stampScratch = new Uint32Array(size);
    _stampGeneration = 0;
  }
  _stampGeneration++;
  if (_stampGeneration === 0xffffffff) {
    _stampScratch.fill(0);
    _stampGeneration = 1;
  }
}

/**
 * Builds a compact geometry from a subset of triangles.
 *
 * **All** attributes are remapped generically via `Object.keys(geom.attributes)` with
 * `getComponent` / `setComponent`, carrying over `itemSize`, `normalized` and the array
 * constructor. That is functionally required rather than cosmetic: the STEP import bakes
 * per-face colours into a `color` attribute, and `getComponent` / `setComponent` are the
 * layer that decodes and re-encodes normalized integer attributes correctly.
 *
 * Interleaved attributes are excluded by the guards and are therefore not handled here.
 *
 * Vertices are emitted in ascending original index order (Unity parity,
 * `MeshSeparator.cs:136`), which also keeps the output cache-friendly.
 */
export function extractSubGeometry(geom: BufferGeometry, triangleIndices: number[]): BufferGeometry {
  const pos = geom.getAttribute('position');
  if (!pos) throw new RangeError('extractSubGeometry: geometry has no position attribute');

  const vertexCount = pos.count;
  const indexArray = geom.index ? (geom.index.array as AttributeArray) : null;

  ensureScratch(vertexCount);
  const remap = _remapScratch;
  const stamp = _stampScratch;
  const generation = _stampGeneration;

  // Gather the used original vertex indices, unique, then sort ascending.
  const used: number[] = [];
  for (const t of triangleIndices) {
    const o = t * 3;
    for (let k = 0; k < 3; k++) {
      const vi = indexArray ? indexArray[o + k] : o + k;
      if (vi >= vertexCount) continue;
      if (stamp[vi] !== generation) {
        stamp[vi] = generation;
        used.push(vi);
      }
    }
  }
  used.sort((a, b) => a - b);

  const newCount = used.length;
  for (let i = 0; i < newCount; i++) remap[used[i]] = i;

  const out = new BufferGeometry();

  for (const name of Object.keys(geom.attributes)) {
    const src = geom.attributes[name] as BufferAttribute;
    const itemSize = src.itemSize;
    const normalized = src.normalized === true;
    const Ctor = (src.array as AttributeArray).constructor as new (length: number) => AttributeArray;
    const dstArray = new Ctor(newCount * itemSize);
    const dst = new BufferAttribute(dstArray as unknown as Float32Array, itemSize, normalized);

    for (let i = 0; i < newCount; i++) {
      const oi = used[i];
      for (let c = 0; c < itemSize; c++) dst.setComponent(i, c, src.getComponent(oi, c));
    }

    out.setAttribute(name, dst);
  }

  // Index format follows the actual vertex count: an island can fit in Uint16 even when
  // the source needed Uint32.
  const outIndexLength = triangleIndices.length * 3;
  const IndexCtor = newCount > 65535 ? Uint32Array : Uint16Array;
  const outIndex = new IndexCtor(outIndexLength);
  let w = 0;
  for (const t of triangleIndices) {
    const o = t * 3;
    for (let k = 0; k < 3; k++) {
      const vi = indexArray ? indexArray[o + k] : o + k;
      outIndex[w++] = vi < vertexCount ? remap[vi] : 0;
    }
  }
  out.setIndex(new BufferAttribute(outIndex, 1));

  out.computeBoundingSphere();
  out.computeBoundingBox();

  return out;
}

// ─── Worker payload serialization ───────────────────────────────────────
//
// Shared by the worker entry point and its client wrapper so the two cannot drift.

/**
 * Copies the position attribute into a tight, denormalized `Float32Array`.
 *
 * Tight on purpose: a structured clone of the raw attribute array would clone its whole
 * backing `ArrayBuffer`, which in a GLB is typically shared by every attribute of every
 * mesh in the file.
 */
export function serializePositions(geom: BufferGeometry): Float32Array {
  const pos = geom.getAttribute('position');
  if (!pos) throw new RangeError('serializePositions: geometry has no position attribute');
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const o = i * 3;
    out[o] = pos.getX(i);
    out[o + 1] = pos.getY(i);
    out[o + 2] = pos.getZ(i);
  }
  return out;
}

/** Copies the index into a tight `Uint32Array`, or `null` for non-indexed geometry. */
export function serializeIndex(geom: BufferGeometry): Uint32Array | null {
  const index = geom.index;
  if (!index) return null;
  const src = index.array as AttributeArray;
  const out = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) out[i] = src[i];
  return out;
}

/** Copies every attribute into tight arrays, preserving `itemSize` and `normalized`. */
export function serializeAttributes(geom: BufferGeometry): Record<string, SerializedAttribute> {
  const out: Record<string, SerializedAttribute> = {};
  for (const name of Object.keys(geom.attributes)) {
    const attr = geom.attributes[name] as BufferAttribute;
    out[name] = {
      array: (attr.array as AttributeArray).slice() as AttributeArray,
      itemSize: attr.itemSize,
      normalized: attr.normalized === true,
    };
  }
  return out;
}

/** Rebuilds a `BufferGeometry` from serialized attributes and index. */
export function deserializeGeometry(
  attributes: Record<string, SerializedAttribute>,
  index: AttributeArray | null,
  groups?: GeometryGroupSpec[],
): BufferGeometry {
  const geom = new BufferGeometry();
  for (const name of Object.keys(attributes)) {
    const spec = attributes[name];
    geom.setAttribute(
      name,
      new BufferAttribute(spec.array as unknown as Float32Array, spec.itemSize, spec.normalized),
    );
  }
  if (index) geom.setIndex(new BufferAttribute(index as unknown as Uint32Array, 1));
  if (groups) for (const g of groups) geom.addGroup(g.start, g.count, g.materialIndex);
  return geom;
}

/** Reduces a geometry to the serialized form used in worker responses. */
export function serializeGeometryParts(geom: BufferGeometry): {
  attributes: Record<string, SerializedAttribute>;
  index: Uint32Array;
} {
  const attributes: Record<string, SerializedAttribute> = {};
  for (const name of Object.keys(geom.attributes)) {
    const attr = geom.attributes[name] as BufferAttribute;
    attributes[name] = {
      array: attr.array as AttributeArray,
      itemSize: attr.itemSize,
      normalized: attr.normalized === true,
    };
  }
  const index = geom.index;
  const indexArray = index
    ? (index.array instanceof Uint32Array ? index.array : Uint32Array.from(index.array as ArrayLike<number>))
    : new Uint32Array(0);
  return { attributes, index: indexArray };
}

/** Re-export so callers need only one import for the guard reasons. */
export { unsupportedGeometryShapeReason, unsupportedMeshShapeReason };

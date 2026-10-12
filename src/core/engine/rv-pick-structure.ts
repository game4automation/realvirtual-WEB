// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pick-structure.ts — the data model and the RAY TRAVERSAL of realvirtual's
 * own CPU pick structure (plan-756, step 1a).
 *
 * The structure is deliberately flat and two-level, nothing like a triangle
 * BVH:
 *
 *   SEGMENT   a contiguous run of the chunk's index buffer whose nearest
 *             surviving ancestor-or-self is ONE node (plan-756 P1). Segments
 *             are ordered by that node's pre-order ordinal, so the subtree of
 *             every surviving node is one contiguous run of segments per
 *             chunk. Sorting happens strictly INSIDE a segment — segment
 *             boundaries are load-bearing and never move.
 *   CLUSTER   `CLUSTER_TRIS` consecutive triangles of ONE segment after that
 *             segment's Morton sort, with one AABB. The last cluster of a
 *             segment may be shorter. A cluster never straddles segments, so
 *             cluster → segment → owner is O(1).
 *   TREE      a binned-SAH binary tree over the CLUSTER boxes (plan-756
 *             §2.4a.1), leaf = up to `LEAF_CLUSTERS` clusters. Because SAH
 *             reorders clusters, leaves address `clusterOrder` POSITIONS, not
 *             cluster indices.
 *
 * The query cost is therefore bounded brute force inside the clusters a ray
 * actually enters — that is what makes cluster-box tightness the quality lever
 * (plan risk R3) and the reason Morton codes are quantised per segment box.
 *
 * Deliberate properties of the traversal below (all of them are the reason the
 * hard cut of three-mesh-bvh is defensible at all):
 *
 *   - **No allocation per ray.** Ray setup writes module-scope scalars, the
 *     traversal stack is a pre-allocated typed array that only ever grows (and
 *     only outside the ray loop), and the hit is one reused record. Callers
 *     that keep a hit must copy it.
 *   - **NaN-safe slab test without `Math.min`/`Math.max`.** JS `Math.min/max`
 *     PROPAGATE NaN, unlike the SSE `minps/maxps` the published branchless
 *     form assumes, so an axis-parallel ray (`0 · ∞` → NaN) would poison the
 *     interval. The sign-indexed comparison form below drops a NaN instead,
 *     because every comparison against NaN is false.
 *   - **Watertight ray/triangle** (Woop/Benthin/Wald 2013) instead of a
 *     fixed-epsilon Möller–Trumbore: CAD sliver triangles and shared edges
 *     otherwise leak.
 *   - **One code path, two modes.** `pick` and `surface` differ only in how
 *     the hit is INTERPRETED (`blocked`), never in how the tree is walked.
 */

import type { Object3D } from 'three';

// ─── Layout constants (shared by the builder and the traversal) ─────

/** Triangles per cluster. One exported constant; tuned in plan-756 step 1e. */
export const CLUSTER_TRIS = 128;

/** Maximum clusters referenced by one tree leaf (plan-756 §2.4a.1). */
export const LEAF_CLUSTERS = 4;

/**
 * High bit of `treeLink[2 * node]` marks a LEAF. Set ⇒ the remaining 31 bits
 * are the first `clusterOrder` POSITION and `treeLink[2 * node + 1]` is the
 * cluster count. Clear ⇒ both entries are child node indices.
 */
export const PICK_LEAF_FLAG = 0x80000000;

// ─── Data model (plan-756 §2.3, amended by §2.4a) ───────────────────

/**
 * Per chunk: every typed array of the pick structure, shared by every instance
 * of the baked asset. Positions and the (permuted) index stay on the chunk's
 * `BufferAttribute`s and are passed into the traversal — nothing here
 * duplicates geometry.
 */
export interface ChunkPickData {
  /** Triangles per cluster this structure was built with. */
  clusterTris: number;
  /** Triangles covered (`index.length / 3`). */
  triangleCount: number;
  segmentCount: number;
  clusterCount: number;

  // segments — sorted by indexStart == sorted by pre-order ordinal of `node`
  /** Node ordinal (index into `NodeTable`) owning the segment's geometry. */
  segNode: Uint32Array;
  /** Pick-owner ordinal, -1 = none (blocks in an opaque chunk). */
  segOwner: Int32Array;
  segIndexStart: Uint32Array;
  segIndexCount: Uint32Array;
  /** 6 floats per segment (minX,minY,minZ,maxX,maxY,maxZ), chunk-local. */
  segBox: Float32Array;
  /** `segmentCount + 1` entries: clusters of segment s are `[s]`..`[s+1]-1`. */
  segFirstCluster: Uint32Array;

  // clusters — `clusterTris` triangles each (the last one of a segment is shorter)
  /** 6 floats per cluster. */
  clusterBox: Float32Array;
  /** Back-pointer cluster → segment (O(1) hit → segment → owner). */
  clusterSeg: Uint32Array;
  /**
   * Tree-leaf position → cluster index. Addition to plan §2.3: the binned-SAH
   * tree of §2.4a.1 partitions clusters, so leaves cannot address clusters
   * directly. Clusters themselves stay grouped per segment (that is what makes
   * `segFirstCluster` meaningful), so the permutation lives here.
   */
  clusterOrder: Uint32Array;

  // flat tree over cluster boxes
  /** 6 floats per tree node. */
  treeBox: Float32Array;
  /** 2 entries per tree node — see `PICK_LEAF_FLAG`. */
  treeLink: Uint32Array;
  treeRoot: number;
  treeNodeCount: number;
  /** Deepest path; sizes the traversal stack. */
  treeMaxDepth: number;

  /** Chunk material is opaque ⇒ an unowned segment OCCLUDES (plan Q5). */
  blocks: boolean;
  /** Chunk material `side` is not `FrontSide` ⇒ back faces count too. */
  doubleSided: boolean;
}

/**
 * Per baked asset. Ordinal = pre-order index among SURVIVING nodes.
 *
 * Generic in the chunk type on purpose: step 1a must not import the bake
 * modules (`BakedChunk` arrives when the bake is rewritten in step 1c), and
 * the traversal never touches this table at all — it is the highlight /
 * resolve side of the structure.
 */
export interface NodeTable<TChunk = unknown> {
  /** Ordinal → template node. */
  nodes: Object3D[];
  ordinalOf: WeakMap<Object3D, number>;
  /** Ordinal → last ordinal of its subtree (inclusive). */
  subtreeEnd: Uint32Array;
  /** Chunk ordinal → chunk. */
  chunks: TChunk[];
  // SPARSE (CSR): rows of node n are rowStart[n] .. rowStart[n + 1] - 1
  /** `nodes.length + 1` entries. */
  rowStart: Uint32Array;
  rowChunk: Uint32Array;
  /** First segment of n's SUBTREE in that chunk. */
  rowFirstSeg: Uint32Array;
  /** Last segment of n's SUBTREE in that chunk. */
  rowLastSeg: Uint32Array;
}

// ─── Query surface ──────────────────────────────────────────────────

/** Traversal work counters — tests and DevTools only, never required. */
export interface PickCounters {
  rays: number;
  boxesTested: number;
  trianglesTested: number;
}

export function createPickCounters(): PickCounters {
  return { rays: 0, boxesTested: 0, trianglesTested: 0 };
}

export function resetPickCounters(counters: PickCounters): void {
  counters.rays = 0;
  counters.boxesTested = 0;
  counters.trianglesTested = 0;
}

export interface PickQueryOptions {
  /** Ignore hits closer than this (three.js `Raycaster.near`). Default 0. */
  near?: number;
  /** Ignore hits farther than this (three.js `Raycaster.far`). Default ∞. */
  far?: number;
  /**
   * Segments to skip entirely — effectively hidden nodes (plan F2). Called at
   * most once per segment per ray (the result is cached for the segment the
   * traversal is currently inside).
   */
  skipSegment?: ((segment: number) => boolean) | null;
  /** Convenience form of `skipSegment` for a pre-computed hidden set. */
  hiddenSegments?: ReadonlySet<number> | null;
  /**
   * The instance transform has a NEGATIVE determinant (mirrored mover): the
   * triangle winding seen in chunk space is inverted, so front-face culling
   * must accept the opposite determinant sign. Ignored when the chunk material
   * is double-sided.
   */
  flipWinding?: boolean;
  counters?: PickCounters | null;
  /**
   * Structure-free mode (plan-757 Phase 3 commit B): ignore the cluster tree
   * and scan the SEGMENT table linearly — one box test per segment, the same
   * watertight triangle test inside every segment the ray enters. Segments,
   * owners, `blocked` and `skipSegment` behave exactly as in the tree walk;
   * only the acceleration is gone, so the cost is linear in the chunk. This is
   * the rollback of the pick structure (`rv-webviewer-pick-structure` = `0`)
   * and IMPLIED for a chunk that carries no tree at all
   * (`treeNodeCount === 0` — a chunk whose worker build failed and which the
   * bake published segment-only, see `buildSegmentOnlyStructure`).
   */
  linear?: boolean;
}

/**
 * A traversal hit. REUSED between calls — copy what you keep.
 *
 * `triangle` is the index of the triangle in the PERMUTED index buffer, i.e.
 * exactly three.js' `faceIndex` for the chunk geometry as it exists after the
 * bake (plan-756 §2.4a.11).
 */
export interface PickHit {
  distance: number;
  triangle: number;
  segment: number;
  /** `segNode[segment]`. */
  node: number;
  /** `segOwner[segment]`, -1 when the segment has no pick owner. */
  owner: number;
  /**
   * `pick` mode only: the nearest triangle belongs to an unowned segment of an
   * OPAQUE chunk. The hit is real geometry and must occlude farther hits, but
   * it resolves to no node (plan Q5, manager state "blocked" ≠ "pass").
   */
  blocked: boolean;
}

// ─── Ray state (module scope — no allocation per ray) ───────────────

const hitOut: PickHit = { distance: 0, triangle: 0, segment: 0, node: 0, owner: -1, blocked: false };

/** Traversal stack; grows only when a deeper structure shows up (never per ray). */
let stackNode = new Uint32Array(64);
let stackDist = new Float64Array(64);

function ensureStack(depth: number): void {
  // A binary tree of depth d needs at most d entries with the front-to-back
  // push order below (one sibling per level), plus slack for the root.
  const need = depth + 2;
  if (stackNode.length >= need) return;
  let size = stackNode.length;
  while (size < need) size *= 2;
  stackNode = new Uint32Array(size);
  stackDist = new Float64Array(size);
}

let rayOx = 0;
let rayOy = 0;
let rayOz = 0;
let rayInvX = 0;
let rayInvY = 0;
let rayInvZ = 0;
// Sign-indexed slab plane offsets inside a 6-float box: the NEAR plane of an
// axis is `min` for a positive inverse direction and `max` for a negative one.
// Indexing by the sign of the INVERSE makes -0 select the max plane, which is
// what keeps a NaN out of the wrong slot on axis-parallel rays.
let slabNearX = 0;
let slabNearY = 1;
let slabNearZ = 2;
let slabFarX = 3;
let slabFarY = 4;
let slabFarZ = 5;
// Woop et al. 2013 watertight setup: kz = dominant direction axis.
let triKx = 0;
let triKy = 1;
let triKz = 2;
let triOkx = 0;
let triOky = 0;
let triOkz = 0;
let triSx = 0;
let triSy = 0;
let triSz = 0;

function setupRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
  rayOx = ox;
  rayOy = oy;
  rayOz = oz;
  rayInvX = 1 / dx;
  rayInvY = 1 / dy;
  rayInvZ = 1 / dz;
  if (rayInvX < 0) { slabNearX = 3; slabFarX = 0; } else { slabNearX = 0; slabFarX = 3; }
  if (rayInvY < 0) { slabNearY = 4; slabFarY = 1; } else { slabNearY = 1; slabFarY = 4; }
  if (rayInvZ < 0) { slabNearZ = 5; slabFarZ = 2; } else { slabNearZ = 2; slabFarZ = 5; }

  const ax = dx < 0 ? -dx : dx;
  const ay = dy < 0 ? -dy : dy;
  const az = dz < 0 ? -dz : dz;
  let kz: number;
  if (ax > ay) kz = ax > az ? 0 : 2;
  else kz = ay > az ? 1 : 2;
  let kx = kz === 2 ? 0 : kz + 1;
  let ky = kx === 2 ? 0 : kx + 1;
  const dk = kz === 0 ? dx : kz === 1 ? dy : dz;
  // Swap the two minor axes for a negative dominant component so the winding
  // (and therefore the determinant sign) survives the projection.
  if (dk < 0) { const t = kx; kx = ky; ky = t; }
  const dkx = kx === 0 ? dx : kx === 1 ? dy : dz;
  const dky = ky === 0 ? dx : ky === 1 ? dy : dz;
  triKx = kx;
  triKy = ky;
  triKz = kz;
  triSx = dkx / dk;
  triSy = dky / dk;
  triSz = 1 / dk;
  triOkx = kx === 0 ? ox : kx === 1 ? oy : oz;
  triOky = ky === 0 ? ox : ky === 1 ? oy : oz;
  triOkz = kz === 0 ? ox : kz === 1 ? oy : oz;
}

/**
 * Ize 2013, "Robust BVH Ray Traversal": the slab arithmetic and the triangle
 * test round differently, so a ray hitting a box EXACTLY on a face or corner
 * can compute `tmin > tmax` by one ulp and lose the triangle sharing that
 * corner. Widening the exit distance by 2 × 2^-23 (the float32 ulp bound of the
 * box coordinates) makes the box test conservative — measured: it removed the
 * last 4 of 1 000 vertex-exact rays where the traversal disagreed with brute
 * force on the thin sheet. It can only ADD clusters to test, never remove one.
 */
const SLAB_EXIT_SLACK = 1 + 2 * 1.1920928955078125e-7;

/**
 * Ray/box entry distance, or `Infinity` on a miss. NaN-safe by construction:
 * `0 · ∞` produces NaN, every comparison against NaN is false, so the NaN is
 * simply never written into `tmin`/`tmax` — the axis degenerates into "no
 * constraint", which is the geometrically correct answer for a ray parallel to
 * that pair of planes and inside the slab.
 */
function slabEntry(box: Float32Array, o: number, near: number, best: number): number {
  let tmin = near;
  let tmax = best;
  let tn = (box[o + slabNearX] - rayOx) * rayInvX;
  let tf = (box[o + slabFarX] - rayOx) * rayInvX;
  if (tn > tmin) tmin = tn;
  if (tf < tmax) tmax = tf;
  tn = (box[o + slabNearY] - rayOy) * rayInvY;
  tf = (box[o + slabFarY] - rayOy) * rayInvY;
  if (tn > tmin) tmin = tn;
  if (tf < tmax) tmax = tf;
  tn = (box[o + slabNearZ] - rayOz) * rayInvZ;
  tf = (box[o + slabFarZ] - rayOz) * rayInvZ;
  if (tn > tmin) tmin = tn;
  if (tf < tmax) tmax = tf;
  return tmin <= tmax * SLAB_EXIT_SLACK ? tmin : Infinity;
}

/**
 * Watertight ray/triangle distance (Woop, Benthin, Wald 2013), or `Infinity`.
 *
 * `frontSign` is 0 for a double-sided test and ±1 to accept only triangles
 * whose determinant has that sign (front-face culling; the sign is inverted by
 * a mirrored instance transform). All arithmetic is float64 anyway, so no
 * separate high-precision fallback is needed.
 */
function triangleDistance(
  position: Float32Array | Float64Array,
  a: number,
  b: number,
  c: number,
  frontSign: number,
): number {
  const az = position[a + triKz] - triOkz;
  const bz = position[b + triKz] - triOkz;
  const cz = position[c + triKz] - triOkz;
  const ax = position[a + triKx] - triOkx - triSx * az;
  const ay = position[a + triKy] - triOky - triSy * az;
  const bx = position[b + triKx] - triOkx - triSx * bz;
  const by = position[b + triKy] - triOky - triSy * bz;
  const cx = position[c + triKx] - triOkx - triSx * cz;
  const cy = position[c + triKy] - triOky - triSy * cz;
  const u = cx * by - cy * bx;
  const v = ax * cy - ay * cx;
  const w = bx * ay - by * ax;
  // Outside the triangle ⇔ the three edge functions do not share a sign.
  // NaN coordinates fail both halves of the conjunction's second clause and
  // are caught by the `det === 0` / `t > 0` tests below.
  if ((u < 0 || v < 0 || w < 0) && (u > 0 || v > 0 || w > 0)) return Infinity;
  const det = u + v + w;
  if (det === 0) return Infinity;
  if (frontSign > 0) { if (!(det > 0)) return Infinity; }
  else if (frontSign < 0) { if (!(det < 0)) return Infinity; }
  const t = ((u * az + v * bz + w * cz) * triSz) / det;
  return t > 0 ? t : Infinity;
}

// ─── Traversal ──────────────────────────────────────────────────────

const EMPTY_OPTIONS: PickQueryOptions = {};

/**
 * Nearest triangle along the ray, front-to-back with best-distance pruning.
 * The single traversal both modes share — `blocked` is decided by the caller.
 */
function traverseNearest(
  data: ChunkPickData,
  position: Float32Array | Float64Array,
  index: Uint32Array,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  query: PickQueryOptions,
): PickHit | null {
  if (data.clusterCount === 0 || data.treeNodeCount === 0) return null;

  const near = query.near ?? 0;
  const far = query.far ?? Infinity;
  const counters = query.counters ?? null;
  const hidden = query.hiddenSegments ?? null;
  const skip = query.skipSegment ?? null;
  const frontSign = data.doubleSided ? 0 : query.flipWinding === true ? -1 : 1;

  ensureStack(data.treeMaxDepth);
  setupRay(ox, oy, oz, dx, dy, dz);

  const treeBox = data.treeBox;
  const treeLink = data.treeLink;
  const clusterBox = data.clusterBox;
  const clusterSeg = data.clusterSeg;
  const clusterOrder = data.clusterOrder;
  const segFirstCluster = data.segFirstCluster;
  const segIndexStart = data.segIndexStart;
  const segIndexCount = data.segIndexCount;
  const clusterTris = data.clusterTris;

  let best = far;
  // Pruning limit: the same ulp argument as `SLAB_EXIT_SLACK`, applied to the
  // other side of the comparison. A triangle's computed distance can come out
  // one ulp BELOW the computed entry distance of the box containing it, so
  // pruning strictly at `best` can discard a box that holds a nearer triangle.
  // Measured on vertex-exact rays against the thin sheet; a few extra clusters
  // near the hit are the entire cost.
  let bestLimit = far;
  let bestTriangle = -1;
  let bestSegment = -1;
  let boxes = 0;
  let triangles = 0;
  // Per-segment skip decision cache: clusters of one segment are consecutive
  // in `clusterOrder` only by accident, so cache by segment id instead.
  let cachedSegment = -1;
  let cachedSkip = false;

  const rootDist = slabEntry(treeBox, data.treeRoot * 6, near, bestLimit);
  boxes++;
  let sp = 0;
  if (rootDist < bestLimit) {
    stackNode[0] = data.treeRoot;
    stackDist[0] = rootDist;
    sp = 1;
  }

  while (sp > 0) {
    sp--;
    if (stackDist[sp] >= bestLimit) continue;
    const node = stackNode[sp];
    const link0 = treeLink[2 * node];
    if (link0 >= PICK_LEAF_FLAG) {
      const first = link0 & 0x7fffffff;
      const count = treeLink[2 * node + 1];
      for (let p = first; p < first + count; p++) {
        const cluster = clusterOrder[p];
        // One box per cluster only pays off when the leaf holds several.
        if (count > 1) {
          boxes++;
          if (!(slabEntry(clusterBox, cluster * 6, near, bestLimit) < bestLimit)) continue;
        }
        const segment = clusterSeg[cluster];
        if (segment !== cachedSegment) {
          cachedSegment = segment;
          cachedSkip = (hidden !== null && hidden.has(segment)) || (skip !== null && skip(segment));
        }
        if (cachedSkip) continue;
        const segStart = segIndexStart[segment];
        const i0 = segStart + (cluster - segFirstCluster[segment]) * clusterTris * 3;
        const segEnd = segStart + segIndexCount[segment];
        const span = i0 + clusterTris * 3;
        const i1 = span < segEnd ? span : segEnd;
        triangles += (i1 - i0) / 3;
        for (let i = i0; i < i1; i += 3) {
          const t = triangleDistance(position, index[i] * 3, index[i + 1] * 3, index[i + 2] * 3, frontSign);
          if (t < best && t >= near) {
            best = t;
            bestLimit = t * SLAB_EXIT_SLACK;
            bestTriangle = i / 3;
            bestSegment = segment;
          }
        }
      }
    } else {
      const right = treeLink[2 * node + 1];
      const dLeft = slabEntry(treeBox, link0 * 6, near, bestLimit);
      const dRight = slabEntry(treeBox, right * 6, near, bestLimit);
      boxes += 2;
      // Push the farther child first so the nearer one is popped next.
      if (dLeft < dRight) {
        if (dRight < bestLimit) { stackNode[sp] = right; stackDist[sp++] = dRight; }
        if (dLeft < bestLimit) { stackNode[sp] = link0; stackDist[sp++] = dLeft; }
      } else {
        if (dLeft < bestLimit) { stackNode[sp] = link0; stackDist[sp++] = dLeft; }
        if (dRight < bestLimit) { stackNode[sp] = right; stackDist[sp++] = dRight; }
      }
    }
  }

  if (counters !== null) {
    counters.rays++;
    counters.boxesTested += boxes;
    counters.trianglesTested += triangles;
  }
  if (bestTriangle < 0) return null;

  hitOut.distance = best;
  hitOut.triangle = bestTriangle;
  hitOut.segment = bestSegment;
  hitOut.node = data.segNode[bestSegment];
  hitOut.owner = data.segOwner[bestSegment];
  hitOut.blocked = false;
  return hitOut;
}

/**
 * The structure-free walk (plan-757 Phase 3 commit B): every segment in table
 * order, its box first, then brute force inside. Same ray setup, same triangle
 * test, same best-distance pruning and the same `bestLimit` slack as the tree
 * walk — the two differ only in what is skipped, never in what is hit, which
 * is what `tests/pick-structure-free-mode.test.ts` proves per ray.
 *
 * Segment boxes are the one part of the structure it reads. They are built by
 * `buildPickStructure` AND by `buildSegmentOnlyStructure`, so a chunk without
 * clusters and tree still gets its per-segment pre-test. `skipSegment` is asked
 * only for a segment whose box the ray enters, once per segment per ray.
 */
function traverseNearestLinear(
  data: ChunkPickData,
  position: Float32Array | Float64Array,
  index: Uint32Array,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  query: PickQueryOptions,
): PickHit | null {
  if (data.segmentCount === 0) return null;

  const near = query.near ?? 0;
  const far = query.far ?? Infinity;
  const counters = query.counters ?? null;
  const hidden = query.hiddenSegments ?? null;
  const skip = query.skipSegment ?? null;
  const frontSign = data.doubleSided ? 0 : query.flipWinding === true ? -1 : 1;

  setupRay(ox, oy, oz, dx, dy, dz);

  const segBox = data.segBox;
  const segIndexStart = data.segIndexStart;
  const segIndexCount = data.segIndexCount;

  let best = far;
  let bestLimit = far;
  let bestTriangle = -1;
  let bestSegment = -1;
  let boxes = 0;
  let triangles = 0;

  for (let s = 0; s < data.segmentCount; s++) {
    boxes++;
    if (!(slabEntry(segBox, s * 6, near, bestLimit) < bestLimit)) continue;
    if ((hidden !== null && hidden.has(s)) || (skip !== null && skip(s))) continue;
    const i0 = segIndexStart[s];
    const i1 = i0 + segIndexCount[s];
    triangles += (i1 - i0) / 3;
    for (let i = i0; i < i1; i += 3) {
      const t = triangleDistance(position, index[i] * 3, index[i + 1] * 3, index[i + 2] * 3, frontSign);
      if (t < best && t >= near) {
        best = t;
        bestLimit = t * SLAB_EXIT_SLACK;
        bestTriangle = i / 3;
        bestSegment = s;
      }
    }
  }

  if (counters !== null) {
    counters.rays++;
    counters.boxesTested += boxes;
    counters.trianglesTested += triangles;
  }
  if (bestTriangle < 0) return null;

  hitOut.distance = best;
  hitOut.triangle = bestTriangle;
  hitOut.segment = bestSegment;
  hitOut.node = data.segNode[bestSegment];
  hitOut.owner = data.segOwner[bestSegment];
  hitOut.blocked = false;
  return hitOut;
}

/** Tree walk when the chunk has one and the caller wants it; the linear walk otherwise. */
function traverse(
  data: ChunkPickData,
  position: Float32Array | Float64Array,
  index: Uint32Array,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  query: PickQueryOptions,
): PickHit | null {
  return query.linear === true || data.treeNodeCount === 0
    ? traverseNearestLinear(data, position, index, ox, oy, oz, dx, dy, dz, query)
    : traverseNearest(data, position, index, ox, oy, oz, dx, dy, dz, query);
}

/** True when `data` carries no cluster tree (segment-only, see `buildSegmentOnlyStructure`). */
export function isSegmentOnly(data: ChunkPickData): boolean {
  return data.treeNodeCount === 0 && data.segmentCount > 0;
}

/**
 * NODE pick: nearest triangle whose segment is not skipped. An unowned segment
 * of an opaque chunk yields a `blocked` hit — real geometry that occludes, but
 * resolves to no node.
 *
 * Returns a REUSED record; copy what you keep.
 */
export function raycastPickNearest(
  data: ChunkPickData,
  position: Float32Array | Float64Array,
  index: Uint32Array,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  query: PickQueryOptions = EMPTY_OPTIONS,
): PickHit | null {
  const hit = traverse(data, position, index, ox, oy, oz, dx, dy, dz, query);
  if (hit === null) return null;
  hit.blocked = hit.owner < 0 && data.blocks;
  return hit;
}

/**
 * SURFACE query (measure, annotate, MCP, stray `THREE.Raycaster`): the true
 * nearest triangle. Ownership is irrelevant — `blocked` is always false.
 *
 * Returns a REUSED record; copy what you keep.
 */
export function raycastSurfaceNearest(
  data: ChunkPickData,
  position: Float32Array | Float64Array,
  index: Uint32Array,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  query: PickQueryOptions = EMPTY_OPTIONS,
): PickHit | null {
  return traverse(data, position, index, ox, oy, oz, dx, dy, dz, query);
}

/**
 * Brute force over an index range with the SAME watertight triangle test —
 * the traversal's own oracle (tests) and the fallback for `dynamic` keep
 * geometry that has no structure (plan F9).
 */
export function raycastRangeBruteForce(
  position: Float32Array | Float64Array,
  index: Uint32Array,
  indexStart: number,
  indexCount: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  query: PickQueryOptions = EMPTY_OPTIONS,
): { distance: number; triangle: number } | null {
  return raycastRangeBruteForceSided(
    position,
    index,
    indexStart,
    indexCount,
    ox,
    oy,
    oz,
    dx,
    dy,
    dz,
    query.flipWinding === true ? -1 : 0,
    query.near ?? 0,
    query.far ?? Infinity,
  );
}

/**
 * Brute force with an explicit front/back rule — used by the parity suite to
 * prove the TRAVERSAL (not the triangle test) correct for single-sided runs.
 */
export function raycastRangeBruteForceSided(
  position: Float32Array | Float64Array,
  index: Uint32Array,
  indexStart: number,
  indexCount: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  frontSign: number,
  near = 0,
  far = Infinity,
): { distance: number; triangle: number } | null {
  setupRay(ox, oy, oz, dx, dy, dz);
  let best = far;
  let triangle = -1;
  const end = indexStart + indexCount;
  for (let i = indexStart; i < end; i += 3) {
    const t = triangleDistance(position, index[i] * 3, index[i + 1] * 3, index[i + 2] * 3, frontSign);
    if (t < best && t >= near) {
      best = t;
      triangle = i / 3;
    }
  }
  return triangle < 0 ? null : { distance: best, triangle };
}

// ─── Segment intervals (highlight / bounds side) ────────────────────

/**
 * A contiguous index range of a chunk plus its bounding sphere — what a
 * highlight proxy draws (plan F5).
 *
 * The sphere comes from the SEGMENT BOXES of the interval, which is what
 * replaced the per-vertex bounding-sphere sweep `makeRangeProxyGeometry` used to
 * run on every range (plan-756 step 1d): the boxes already exist, so a range of
 * two million triangles costs six float reads per segment instead of two passes
 * over its vertices. It is conservative (box → circumscribed sphere), and a
 * frustum-culling renderer only ever needs a sphere that CONTAINS the range.
 */
export interface ChunkRange {
  indexStart: number;
  indexCount: number;
  centerX: number;
  centerY: number;
  centerZ: number;
  radius: number;
}

/**
 * The {@link ChunkRange} of segments `first`..`last` (inclusive) of one chunk.
 *
 * Segments tile the chunk's index in order, so an interval of segments is one
 * contiguous index range — that IS the P1 guarantee the whole highlight path
 * rests on. Returns `null` for an empty or malformed interval.
 */
export function segmentRange(data: ChunkPickData, first: number, last: number): ChunkRange | null {
  if (first < 0 || last < first || last >= data.segmentCount) return null;
  const indexStart = data.segIndexStart[first];
  const indexEnd = data.segIndexStart[last] + data.segIndexCount[last];
  if (indexEnd <= indexStart) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const box = data.segBox;
  for (let s = first; s <= last; s++) {
    const o = s * 6;
    if (box[o] < x0) x0 = box[o];
    if (box[o + 1] < y0) y0 = box[o + 1];
    if (box[o + 2] < z0) z0 = box[o + 2];
    if (box[o + 3] > x1) x1 = box[o + 3];
    if (box[o + 4] > y1) y1 = box[o + 4];
    if (box[o + 5] > z1) z1 = box[o + 5];
  }
  if (!(x1 >= x0 && y1 >= y0 && z1 >= z0)) {
    return { indexStart, indexCount: indexEnd - indexStart, centerX: 0, centerY: 0, centerZ: 0, radius: 0 };
  }
  const dx = (x1 - x0) * 0.5;
  const dy = (y1 - y0) * 0.5;
  const dz = (z1 - z0) * 0.5;
  return {
    indexStart,
    indexCount: indexEnd - indexStart,
    centerX: x0 + dx,
    centerY: y0 + dy,
    centerZ: z0 + dz,
    radius: Math.sqrt(dx * dx + dy * dy + dz * dz),
  };
}

/**
 * Union of the boxes of segments `first`..`last` (inclusive) into `out`
 * (`[minX, minY, minZ, maxX, maxY, maxZ]`, CHUNK-LOCAL space) — `true` when the
 * interval contributed a non-degenerate box.
 *
 * This is the box half of {@link segmentRange}, which needs the same union to
 * derive its bounding sphere. It exists on its own because a BOUNDS consumer
 * (plan-756 F6: `computeSubtreeAABB` of a node whose triangles were merged into
 * an ancestor's chunk) must not be handed a sphere — the sphere's radius is the
 * box's half-diagonal, which would frame a camera ~73 % too wide. Segment boxes
 * are conservative (one box per segment, not per triangle), so the result is a
 * superset of the subtree's triangles and never a subset.
 */
export function segmentBoxUnion(
  data: ChunkPickData,
  first: number,
  last: number,
  out: number[] | Float32Array | Float64Array,
): boolean {
  if (first < 0 || last < first || last >= data.segmentCount) return false;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const box = data.segBox;
  for (let s = first; s <= last; s++) {
    const o = s * 6;
    if (box[o] < x0) x0 = box[o];
    if (box[o + 1] < y0) y0 = box[o + 1];
    if (box[o + 2] < z0) z0 = box[o + 2];
    if (box[o + 3] > x1) x1 = box[o + 3];
    if (box[o + 4] > y1) y1 = box[o + 4];
    if (box[o + 5] > z1) z1 = box[o + 5];
  }
  if (!(x1 >= x0 && y1 >= y0 && z1 >= z0)) return false;
  out[0] = x0; out[1] = y0; out[2] = z0;
  out[3] = x1; out[4] = y1; out[5] = z1;
  return true;
}

/**
 * Bytes owned by one asset's node table (memory gate input, plan §2.3: the CSR
 * table counts toward the 5 % budget and is reported next to the structure
 * bytes). `nodes` / `ordinalOf` are references, not payload.
 */
export function nodeTableBytes(table: NodeTable<unknown>): number {
  return (
    table.subtreeEnd.byteLength +
    table.rowStart.byteLength +
    table.rowChunk.byteLength +
    table.rowFirstSeg.byteLength +
    table.rowLastSeg.byteLength
  );
}

/** Bytes owned by one chunk's pick structure (memory gate input). */
export function pickStructureBytes(data: ChunkPickData): number {
  return (
    data.segNode.byteLength +
    data.segOwner.byteLength +
    data.segIndexStart.byteLength +
    data.segIndexCount.byteLength +
    data.segBox.byteLength +
    data.segFirstCluster.byteLength +
    data.clusterBox.byteLength +
    data.clusterSeg.byteLength +
    data.clusterOrder.byteLength +
    data.treeBox.byteLength +
    data.treeLink.byteLength
  );
}

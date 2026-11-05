// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-collision-narrowphase.ts — exact part-against-part test of the collision
 * manager, walked over the plan-756 PICK STRUCTURE (plan-781 F2/F15/F19).
 *
 * The collision manager owns no acceleration structure (contract rule 15, as
 * ruled by Vincent on 2026-11-05): it READS the `ChunkPickData` the bake
 * already built for every chunk, and the `KeepPick` the pick path builds
 * lazily for a keep mesh. Nothing here writes to a structure, to an index or
 * to a geometry — a chunk's index order is data (rule 10).
 *
 * One test, four shapes of input, decided per part:
 *
 *   tree × tree   dual traversal over the two binned-SAH cluster trees
 *                 (`treeBox` / `treeLink`), descending the larger node first;
 *   tree × flat   the flat side's elements one by one against the other tree;
 *   flat × flat   element against element.
 *
 * A FLAT part is a segment-only chunk (its pick build failed, F15 — the segment
 * boxes still exist, so every segment is one element) or a part without any
 * structure (`pick === null`: a keep mesh at or below `KEEP_BRUTE_TRIS`,
 * non-indexed or interleaved geometry, F19 — one element per triangle
 * interval, boxed by the part's `localBox`).
 *
 * Both parts are handled in A's LOCAL frame: B's boxes and triangles go through
 * the relative matrix `M = inverse(A.world) · B.world`, held in twelve module
 * scalars. Affine, so non-uniform scale and mirroring are exact; the triangle
 * test is winding-independent, so a mirrored `M` needs no re-ordering.
 *
 * **The interval filter.** A body rarely owns a whole chunk: a static role
 * node's geometry is a few segment runs inside the asset's root chunk. Every
 * part therefore carries the inclusive SEGMENT intervals it owns, and a cluster
 * takes part only when its segment (`clusterSeg`) lies inside them (binary
 * search). Tree nodes are additionally pruned against the part's own
 * `localBox`, so a small role inside a large chunk never walks the subtrees
 * that lie elsewhere (plan §2.8 step 2).
 *
 * No allocation per call: module scratch for the matrix, typed-array stacks
 * and triangle buffers that only ever grow.
 */

import { PICK_LEAF_FLAG, type ChunkPickData } from './rv-pick-structure';
import { trianglesPenetrate } from './rv-collision-tri-tri';

// ─── Input shape ─────────────────────────────────────────────────────

/** The slow-path position reader (interleaved or non-Float32 attributes, F19). */
export interface PositionReader {
  getX(index: number): number;
  getY(index: number): number;
  getZ(index: number): number;
  readonly count: number;
}

/** What the narrowphase reads of one body part. Built at body (re)build. */
export interface NarrowPart {
  /** The chunk's or keep mesh's pick structure; `null` = no structure (flat). */
  pick: ChunkPickData | null;
  /** `pick` carries segments but no cluster tree (F15) — walked segment by segment. */
  segmentOnly: boolean;
  /** Fast path: a plain, non-interleaved `Float32Array` with 3 floats per vertex. */
  position: Float32Array | null;
  /** Slow path, used when `position` is null. */
  positionReader: PositionReader | null;
  /** Triangle index; `null` = non-indexed (triangle `t` = vertices `3t..3t+2`). */
  index: Uint32Array | Uint16Array | null;
  /**
   * Allowed pieces as inclusive `[first, last]` pairs, sorted and disjoint:
   * SEGMENT ids when `pick !== null`, TRIANGLE ids when `pick === null`.
   */
  intervals: Uint32Array;
  intervalCount: number;
  /** Union of the allowed pieces' boxes, part-local (6 floats). */
  localBox: Float64Array;
  /** Current world matrix, column-major (three.js `elements` order). */
  world: Float64Array;
}

/** Work counters in the style of `PickCounters` — tests and DevTools only. */
export interface NarrowCounters {
  /** `partsOverlap` calls that got past the matrix setup. */
  partPairs: number;
  boxesTested: number;
  /** Triangle-run pairs that reached the triangle stage (leaf × leaf work units). */
  runPairs: number;
  /** Cluster / element pairs rejected by the flat-face rule without loading a triangle. */
  flatRejected: number;
  /** Part pairs whose boxes only ABUT (touching, separating axis within the tolerance). */
  abutRejected: number;
  trianglesTested: number;
}

export function createNarrowCounters(): NarrowCounters {
  return { partPairs: 0, boxesTested: 0, runPairs: 0, flatRejected: 0, abutRejected: 0, trianglesTested: 0 };
}

export function resetNarrowCounters(c: NarrowCounters): void {
  c.partPairs = 0;
  c.boxesTested = 0;
  c.runPairs = 0;
  c.flatRejected = 0;
  c.abutRejected = 0;
  c.trianglesTested = 0;
}

/**
 * The last hitting pair of triangle runs (index positions, `[start, end)`),
 * kept PER PAIR by the manager and tested first on the next evaluation
 * (temporal coherence, plan §2.8). `valid = false` until the first hit.
 */
export interface NarrowWitness {
  valid: boolean;
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

export function createNarrowWitness(): NarrowWitness {
  return { valid: false, aStart: 0, aEnd: 0, bStart: 0, bEnd: 0 };
}

// ─── Module scratch ──────────────────────────────────────────────────

// M = inverse(A.world) · B.world — B-local → A-local, rows r, columns c.
let m00 = 1, m01 = 0, m02 = 0, m03 = 0;
let m10 = 0, m11 = 1, m12 = 0, m13 = 0;
let m20 = 0, m21 = 0, m22 = 1, m23 = 0;
// |M| for box transforms.
let a00 = 1, a01 = 0, a02 = 0;
let a10 = 0, a11 = 1, a12 = 0;
let a20 = 0, a21 = 0, a22 = 1;
/** inverse(M) — A-local → B-local, rows r, columns c (flat-face rule). */
let n00 = 1, n01 = 0, n02 = 0, n03 = 0;
let n10 = 0, n11 = 1, n12 = 0, n13 = 0;
let n20 = 0, n21 = 0, n22 = 1, n23 = 0;
/** Box inflation and triangle tolerance, both in A-local units. */
let tolLocal = 0;
let epsLocal = 0;
/** The counters of the running call (never null inside a call). */
let cnt: NarrowCounters = createNarrowCounters();
/** The witness of the running call, or null. */
let wit: NarrowWitness | null = null;

// The transformed box of the last `xformBox` call (A-local).
let tx0 = 0, ty0 = 0, tz0 = 0, tx1 = 0, ty1 = 0, tz1 = 0;
// The A-local filter box of the running triangle-run test.
let fx0 = 0, fy0 = 0, fz0 = 0, fx1 = 0, fy1 = 0, fz1 = 0;
// The fixed element box of a tree-vs-element walk (A-local).
let ex0 = 0, ey0 = 0, ez0 = 0, ex1 = 0, ey1 = 0, ez1 = 0;

/** Pair stack of the dual walk, single stack of the tree-vs-element walk. */
let pairStack = new Uint32Array(128);
let nodeStack = new Uint32Array(64);

function ensurePairStack(entries: number): void {
  if (pairStack.length >= entries * 2) return;
  let size = pairStack.length;
  while (size < entries * 2) size *= 2;
  pairStack = new Uint32Array(size);
}

function ensureNodeStack(entries: number): void {
  if (nodeStack.length >= entries) return;
  let size = nodeStack.length;
  while (size < entries) size *= 2;
  nodeStack = new Uint32Array(size);
}

/**
 * B triangles in A-local space (9 floats), their boxes (6) and unit planes
 * (4: nx, ny, nz, d); A triangles of the run (9) and their boxes (6).
 */
let bTri = new Float64Array(9 * 256);
let bBox = new Float64Array(6 * 256);
let bPlane = new Float64Array(4 * 256);
let aBuf = new Float64Array(9 * 256);
let aBox = new Float64Array(6 * 256);

function ensureTriScratch(bTris: number, aTris: number): void {
  if (bBox.length < bTris * 6) {
    let size = bBox.length / 6;
    while (size < bTris) size *= 2;
    bTri = new Float64Array(size * 9);
    bBox = new Float64Array(size * 6);
    bPlane = new Float64Array(size * 4);
  }
  if (aBox.length < aTris * 6) {
    let size = aBox.length / 6;
    while (size < aTris) size *= 2;
    aBuf = new Float64Array(size * 9);
    aBox = new Float64Array(size * 6);
  }
}

/** A triangles per block of the plane prefilter (see {@link testRuns}). */
const BLOCK_TRIS = 16;

/** Leaf cluster scratch of the dual walk (≤ LEAF_CLUSTERS per side, grown on demand). */
let leafClusters = new Uint32Array(8);
let leafBoxes = new Float64Array(8 * 6);

function ensureLeafScratch(n: number): void {
  if (leafClusters.length >= n) return;
  let size = leafClusters.length;
  while (size < n) size *= 2;
  leafClusters = new Uint32Array(size);
  leafBoxes = new Float64Array(size * 6);
}

// ─── Matrix setup ────────────────────────────────────────────────────

/**
 * Fill `M = inverse(A) · B` and the tolerances. False when A is singular or the
 * input is not finite (rule 14: never throw, never report).
 */
function setupRelative(aw: Float64Array, bw: Float64Array, tolWorld: number, epsWorld: number): boolean {
  // A's 3×3 (row r, column c = aw[c*4 + r]) and translation.
  const r00 = aw[0], r10 = aw[1], r20 = aw[2];
  const r01 = aw[4], r11 = aw[5], r21 = aw[6];
  const r02 = aw[8], r12 = aw[9], r22 = aw[10];
  const atx = aw[12], aty = aw[13], atz = aw[14];
  const c00 = r11 * r22 - r12 * r21;
  const c01 = r02 * r21 - r01 * r22;
  const c02 = r01 * r12 - r02 * r11;
  const det = r00 * c00 + r10 * c01 + r20 * c02;
  if (!(det !== 0) || det - det !== 0) return false;
  const inv = 1 / det;
  // inverse(R) rows.
  const i00 = c00 * inv, i01 = c01 * inv, i02 = c02 * inv;
  const i10 = (r12 * r20 - r10 * r22) * inv;
  const i11 = (r00 * r22 - r02 * r20) * inv;
  const i12 = (r02 * r10 - r00 * r12) * inv;
  const i20 = (r10 * r21 - r11 * r20) * inv;
  const i21 = (r01 * r20 - r00 * r21) * inv;
  const i22 = (r00 * r11 - r01 * r10) * inv;

  const b00 = bw[0], b10 = bw[1], b20 = bw[2];
  const b01 = bw[4], b11 = bw[5], b21 = bw[6];
  const b02 = bw[8], b12 = bw[9], b22 = bw[10];
  const dx = bw[12] - atx, dy = bw[13] - aty, dz = bw[14] - atz;

  m00 = i00 * b00 + i01 * b10 + i02 * b20;
  m01 = i00 * b01 + i01 * b11 + i02 * b21;
  m02 = i00 * b02 + i01 * b12 + i02 * b22;
  m03 = i00 * dx + i01 * dy + i02 * dz;
  m10 = i10 * b00 + i11 * b10 + i12 * b20;
  m11 = i10 * b01 + i11 * b11 + i12 * b21;
  m12 = i10 * b02 + i11 * b12 + i12 * b22;
  m13 = i10 * dx + i11 * dy + i12 * dz;
  m20 = i20 * b00 + i21 * b10 + i22 * b20;
  m21 = i20 * b01 + i21 * b11 + i22 * b21;
  m22 = i20 * b02 + i21 * b12 + i22 * b22;
  m23 = i20 * dx + i21 * dy + i22 * dz;
  const s = m00 + m01 + m02 + m03 + m10 + m11 + m12 + m13 + m20 + m21 + m22 + m23;
  if (s - s !== 0) return false;
  a00 = m00 < 0 ? -m00 : m00; a01 = m01 < 0 ? -m01 : m01; a02 = m02 < 0 ? -m02 : m02;
  a10 = m10 < 0 ? -m10 : m10; a11 = m11 < 0 ? -m11 : m11; a12 = m12 < 0 ? -m12 : m12;
  a20 = m20 < 0 ? -m20 : m20; a21 = m21 < 0 ? -m21 : m21; a22 = m22 < 0 ? -m22 : m22;

  // World → A-local tolerance: the SMALLEST axis scale of A, so the local
  // tolerance is never tighter than the world one on any axis.
  const sx = Math.sqrt(r00 * r00 + r10 * r10 + r20 * r20);
  const sy = Math.sqrt(r01 * r01 + r11 * r11 + r21 * r21);
  const sz = Math.sqrt(r02 * r02 + r12 * r12 + r22 * r22);
  let minScale = sx < sy ? sx : sy;
  if (sz < minScale) minScale = sz;
  if (!(minScale > 0)) return false;
  tolLocal = tolWorld / minScale;
  epsLocal = epsWorld / minScale;

  // inverse(M) for the flat-face rule of a B cluster.
  const k00 = m11 * m22 - m12 * m21;
  const k01 = m02 * m21 - m01 * m22;
  const k02 = m01 * m12 - m02 * m11;
  const mdet = m00 * k00 + m10 * k01 + m20 * k02;
  if (!(mdet !== 0) || mdet - mdet !== 0) return false;
  const mi = 1 / mdet;
  n00 = k00 * mi; n01 = k01 * mi; n02 = k02 * mi;
  n10 = (m12 * m20 - m10 * m22) * mi;
  n11 = (m00 * m22 - m02 * m20) * mi;
  n12 = (m02 * m10 - m00 * m12) * mi;
  n20 = (m10 * m21 - m11 * m20) * mi;
  n21 = (m01 * m20 - m00 * m21) * mi;
  n22 = (m00 * m11 - m01 * m10) * mi;
  n03 = -(n00 * m03 + n01 * m13 + n02 * m23);
  n13 = -(n10 * m03 + n11 * m13 + n12 * m23);
  n23 = -(n20 * m03 + n21 * m13 + n22 * m23);
  return true;
}

/**
 * The FLAT-FACE rule: true when no triangle of A's box `aArr[ao..]` (A-local)
 * can penetrate a triangle of B's box `bArr[bo..]` (B-local) because one of
 * the two is exactly flat along one of its local axes.
 *
 * A cluster of an axis-aligned CAD face has a box of thickness 0: every
 * triangle in it lies in the plane `x_k = c`. A triangle penetrates another
 * only if each one reaches STRICTLY across the other's plane, beyond the
 * tolerance (the first condition of `trianglesPenetrate`). So every penetrating
 * partner must come from a box that straddles `x_k = c` by more than the
 * tolerance — a box that does not cannot hold one, and the whole cluster pair
 * is skipped without loading a single triangle. This is what makes a box
 * resting FLUSH on a belt cheap: every face pair of the contact is either
 * coplanar or meets the other face's plane only at an edge.
 *
 * Only an EXACT zero thickness counts (an axis-aligned face in Float32 is
 * exact); a nearly flat box may hold tilted triangles and is left alone. The
 * transformed boxes are conservative supersets, so the rule never skips a pair
 * that could hit.
 */
function flatSeparated(aArr: ArrayLike<number>, ao: number, bArr: ArrayLike<number>, bo: number): boolean {
  const eps = epsLocal;
  const ax0 = aArr[ao], ay0 = aArr[ao + 1], az0 = aArr[ao + 2];
  const ax1 = aArr[ao + 3], ay1 = aArr[ao + 4], az1 = aArr[ao + 5];
  const bx0 = bArr[bo], by0 = bArr[bo + 1], bz0 = bArr[bo + 2];
  const bx1 = bArr[bo + 3], by1 = bArr[bo + 4], bz1 = bArr[bo + 5];
  const aFlat = ax1 === ax0 || ay1 === ay0 || az1 === az0;
  const bFlat = bx1 === bx0 || by1 === by0 || bz1 === bz0;
  if (!aFlat && !bFlat) return false;
  if (aFlat) {
    // B's box in A-local, per axis (center / extent through M).
    const cx = (bx0 + bx1) * 0.5, cy = (by0 + by1) * 0.5, cz = (bz0 + bz1) * 0.5;
    const hx = (bx1 - bx0) * 0.5, hy = (by1 - by0) * 0.5, hz = (bz1 - bz0) * 0.5;
    if (ax1 === ax0) {
      const c = m00 * cx + m01 * cy + m02 * cz + m03 - ax0;
      const r = a00 * hx + a01 * hy + a02 * hz;
      if (!(c + r > eps && c - r < -eps)) return true;
    }
    if (ay1 === ay0) {
      const c = m10 * cx + m11 * cy + m12 * cz + m13 - ay0;
      const r = a10 * hx + a11 * hy + a12 * hz;
      if (!(c + r > eps && c - r < -eps)) return true;
    }
    if (az1 === az0) {
      const c = m20 * cx + m21 * cy + m22 * cz + m23 - az0;
      const r = a20 * hx + a21 * hy + a22 * hz;
      if (!(c + r > eps && c - r < -eps)) return true;
    }
  }
  if (bFlat) {
    // B's plane x_k = c seen from A: (row k of inverse(M)) · x_A + t_k = c;
    // metric distance in A-local = that value / |row k|.
    const cx = (ax0 + ax1) * 0.5, cy = (ay0 + ay1) * 0.5, cz = (az0 + az1) * 0.5;
    const hx = (ax1 - ax0) * 0.5, hy = (ay1 - ay0) * 0.5, hz = (az1 - az0) * 0.5;
    if (bx1 === bx0 && planeSeparates(n00, n01, n02, n03 - bx0, cx, cy, cz, hx, hy, hz, eps)) return true;
    if (by1 === by0 && planeSeparates(n10, n11, n12, n13 - by0, cx, cy, cz, hx, hy, hz, eps)) return true;
    if (bz1 === bz0 && planeSeparates(n20, n21, n22, n23 - bz0, cx, cy, cz, hx, hy, hz, eps)) return true;
  }
  return false;
}

/**
 * The TOUCH rule at part level (F3, separating axis with the contact
 * tolerance): true when A's `localBox` and B's box seen in A-local
 * (`tx0..tz1`, set by the caller) overlap by at most `epsLocal` along an
 * axis at their ENDS — one part ends where the other begins. The plane between
 * them then separates both parts up to the tolerance, so their volumes overlap
 * at most that deep: a box resting on a belt, two parts set flush side by side.
 * By the decided semantics that is touching, never a collision. The same is
 * checked in B-local, so a part turned against the other's axes is covered by
 * whichever frame it is aligned with. Boxes are conservative, so the rule only
 * ever applies to geometry that really abuts.
 *
 * Only an overlap at the ENDS counts: a thin part INSIDE another's range (a
 * floor plate the robot reaches through) is not abutting and takes the normal
 * walk.
 */
function partsAbut(a: NarrowPart, b: NarrowPart): boolean {
  const e = epsLocal;
  const la = a.localBox;
  if (la[3] - tx0 <= e || tx1 - la[0] <= e) return true;
  if (la[4] - ty0 <= e || ty1 - la[1] <= e) return true;
  if (la[5] - tz0 <= e || tz1 - la[2] <= e) return true;
  // B-local: A's box through inverse(M), against B's own box. The tolerance is
  // measured in A-local units, so it is converted with the row norms of inverse(M).
  const cx = (la[0] + la[3]) * 0.5, cy = (la[1] + la[4]) * 0.5, cz = (la[2] + la[5]) * 0.5;
  const hx = (la[3] - la[0]) * 0.5, hy = (la[4] - la[1]) * 0.5, hz = (la[5] - la[2]) * 0.5;
  const lb = b.localBox;
  return abutAxis(n00, n01, n02, n03, cx, cy, cz, hx, hy, hz, lb[0], lb[3], e)
    || abutAxis(n10, n11, n12, n13, cx, cy, cz, hx, hy, hz, lb[1], lb[4], e)
    || abutAxis(n20, n21, n22, n23, cx, cy, cz, hx, hy, hz, lb[2], lb[5], e);
}

/** One B-local axis of {@link partsAbut}: A's interval along row `r` of inverse(M) against `[b0, b1]`. */
function abutAxis(
  r0: number, r1: number, r2: number, t: number,
  cx: number, cy: number, cz: number, hx: number, hy: number, hz: number,
  b0: number, b1: number, eps: number,
): boolean {
  const len = Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2);
  if (!(len > 0)) return false;
  const c = r0 * cx + r1 * cy + r2 * cz + t;
  const rad = (r0 < 0 ? -r0 : r0) * hx + (r1 < 0 ? -r1 : r1) * hy + (r2 < 0 ? -r2 : r2) * hz;
  // A-local tolerance → B-local along this row (|row| = B units per A unit).
  const e = eps * len;
  return (c + rad) - b0 <= e || b1 - (c - rad) <= e;
}

/** Does the box (center c, half h) NOT reach strictly across plane r·x + t = 0 by `eps` (metric)? */
function planeSeparates(
  r0: number, r1: number, r2: number, t: number,
  cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, eps: number,
): boolean {
  const len = Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2);
  if (!(len > 0)) return false;
  const d = r0 * cx + r1 * cy + r2 * cz + t;
  const rad = (r0 < 0 ? -r0 : r0) * hx + (r1 < 0 ? -r1 : r1) * hy + (r2 < 0 ? -r2 : r2) * hz;
  const e = eps * len;
  return !(d + rad > e && d - rad < -e);
}

/** AABB of B-local box `box[o..o+5]` after `M`, into `tx0..tz1`. */
function xformBox(box: ArrayLike<number>, o: number): void {
  const cx = (box[o] + box[o + 3]) * 0.5;
  const cy = (box[o + 1] + box[o + 4]) * 0.5;
  const cz = (box[o + 2] + box[o + 5]) * 0.5;
  const hx = (box[o + 3] - box[o]) * 0.5;
  const hy = (box[o + 4] - box[o + 1]) * 0.5;
  const hz = (box[o + 5] - box[o + 2]) * 0.5;
  const ncx = m00 * cx + m01 * cy + m02 * cz + m03;
  const ncy = m10 * cx + m11 * cy + m12 * cz + m13;
  const ncz = m20 * cx + m21 * cy + m22 * cz + m23;
  const nhx = a00 * hx + a01 * hy + a02 * hz;
  const nhy = a10 * hx + a11 * hy + a12 * hz;
  const nhz = a20 * hx + a21 * hy + a22 * hz;
  tx0 = ncx - nhx; ty0 = ncy - nhy; tz0 = ncz - nhz;
  tx1 = ncx + nhx; ty1 = ncy + nhy; tz1 = ncz + nhz;
}

/** Does A-local `box[o..]` overlap the transformed box `tx0..tz1` (inflated)? */
function overlapsT(box: ArrayLike<number>, o: number): boolean {
  const t = tolLocal;
  return box[o] - t <= tx1 && box[o + 3] + t >= tx0
    && box[o + 1] - t <= ty1 && box[o + 4] + t >= ty0
    && box[o + 2] - t <= tz1 && box[o + 5] + t >= tz0;
}

/** Does `box[o..]` overlap `box2[o2..]` (same frame, inflated)? */
function overlaps(box: ArrayLike<number>, o: number, box2: ArrayLike<number>, o2: number, t: number): boolean {
  return box[o] - t <= box2[o2 + 3] && box[o + 3] + t >= box2[o2]
    && box[o + 1] - t <= box2[o2 + 4] && box[o + 4] + t >= box2[o2 + 1]
    && box[o + 2] - t <= box2[o2 + 5] && box[o + 5] + t >= box2[o2 + 2];
}

/** Does `box[o..]` overlap the element box `ex0..ez1` (A-local, inflated)? */
function overlapsE(box: ArrayLike<number>, o: number): boolean {
  const t = tolLocal;
  return box[o] - t <= ex1 && box[o + 3] + t >= ex0
    && box[o + 1] - t <= ey1 && box[o + 4] + t >= ey0
    && box[o + 2] - t <= ez1 && box[o + 5] + t >= ez0;
}

/** Does the transformed box `tx0..tz1` overlap the element box `ex0..ez1`? */
function tOverlapsE(): boolean {
  const t = tolLocal;
  return tx0 - t <= ex1 && tx1 + t >= ex0 && ty0 - t <= ey1 && ty1 + t >= ey0 && tz0 - t <= ez1 && tz1 + t >= ez0;
}

function setFilter(box: ArrayLike<number>, o: number): void {
  fx0 = box[o]; fy0 = box[o + 1]; fz0 = box[o + 2];
  fx1 = box[o + 3]; fy1 = box[o + 4]; fz1 = box[o + 5];
}

function setFilterFromT(): void {
  fx0 = tx0; fy0 = ty0; fz0 = tz0; fx1 = tx1; fy1 = ty1; fz1 = tz1;
}

function setFilterFromE(): void {
  fx0 = ex0; fy0 = ey0; fz0 = ez0; fx1 = ex1; fy1 = ey1; fz1 = ez1;
}

function setElemFromT(): void {
  ex0 = tx0; ey0 = ty0; ez0 = tz0; ex1 = tx1; ey1 = ty1; ez1 = tz1;
}

function setElem(box: ArrayLike<number>, o: number): void {
  ex0 = box[o]; ey0 = box[o + 1]; ez0 = box[o + 2];
  ex1 = box[o + 3]; ey1 = box[o + 4]; ez1 = box[o + 5];
}

// ─── Intervals ───────────────────────────────────────────────────────

/** Is piece `id` inside one of `part`'s inclusive intervals? Binary search. */
export function inIntervals(part: NarrowPart, id: number): boolean {
  const iv = part.intervals;
  let lo = 0;
  let hi = part.intervalCount - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (id < iv[mid * 2]) hi = mid - 1;
    else if (id > iv[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

// ─── Triangle runs ───────────────────────────────────────────────────

/** Index-position range of `cluster` (`[start, end)`), into `runStart`/`runEnd`. */
let runStart = 0;
let runEnd = 0;

function clusterRun(data: ChunkPickData, cluster: number): void {
  const s = data.clusterSeg[cluster];
  const segStart = data.segIndexStart[s];
  const segEnd = segStart + data.segIndexCount[s];
  const i0 = segStart + (cluster - data.segFirstCluster[s]) * data.clusterTris * 3;
  const span = i0 + data.clusterTris * 3;
  runStart = i0;
  runEnd = span < segEnd ? span : segEnd;
}

function vertexOf(part: NarrowPart, i: number): number {
  const idx = part.index;
  return idx !== null ? idx[i] : i;
}

let vx = 0, vy = 0, vz = 0;

function readVertex(part: NarrowPart, v: number): void {
  const pos = part.position;
  if (pos !== null) {
    const k = v * 3;
    vx = pos[k]; vy = pos[k + 1]; vz = pos[k + 2];
    return;
  }
  const r = part.positionReader;
  if (r === null || v >= r.count) { vx = NaN; vy = NaN; vz = NaN; return; }
  vx = r.getX(v); vy = r.getY(v); vz = r.getZ(v);
}

/**
 * Triangles of A's run `[as, ae)` against B's run `[bs, be)` (index positions),
 * B transformed into A-local. Records the witness on a hit.
 *
 * Three filters run before the exact test, cheapest first:
 *   1. a B triangle outside the filter box `fx0..fz1` (the A cluster) is dropped;
 *   2. A triangles are taken in blocks of {@link BLOCK_TRIS}: a block whose box
 *      does not overlap a B triangle's box, or does not reach STRICTLY across
 *      that triangle's plane (beyond the tolerance), cannot hold a triangle that
 *      penetrates it — the same necessary condition the exact test checks
 *      first. This is what keeps a FLUSH contact cheap: a box resting on a belt
 *      has every triangle box overlapping, but no block of the belt's top face
 *      reaches across the plane of the box's bottom face;
 *   3. per A triangle the box and the same plane condition again.
 */
function testRuns(a: NarrowPart, as: number, ae: number, b: NarrowPart, bs: number, be: number): boolean {
  const bTris = (be - bs) / 3;
  const aTris = (ae - as) / 3;
  if (bTris <= 0 || aTris <= 0) return false;
  cnt.runPairs++;
  ensureTriScratch(bTris, aTris);
  const t = tolLocal;
  const eps = epsLocal;
  // Module state copied into locals once per run: the loops below are the hot path.
  const M00 = m00, M01 = m01, M02 = m02, M03 = m03;
  const M10 = m10, M11 = m11, M12 = m12, M13 = m13;
  const M20 = m20, M21 = m21, M22 = m22, M23 = m23;
  const FX0 = fx0, FY0 = fy0, FZ0 = fz0, FX1 = fx1, FY1 = fy1, FZ1 = fz1;
  const BT = bTri, BB = bBox, BP = bPlane, AB = aBuf, AX = aBox;

  // Locals, not the module-level vertex reader: this loop is the hot path.
  const bPos = b.position;
  const bIdx = b.index;
  const aPos = a.position;
  const aIdx = a.index;

  // ── B: transform, box, plane, filter ──
  let kept = 0;
  let ux0 = Infinity, uy0 = Infinity, uz0 = Infinity, ux1 = -Infinity, uy1 = -Infinity, uz1 = -Infinity;
  for (let i = bs; i < be; i += 3) {
    const o = kept * 9;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = bIdx !== null ? bIdx[i + k] : i + k;
      let px: number, py: number, pz: number;
      if (bPos !== null) { const q = v * 3; px = bPos[q]; py = bPos[q + 1]; pz = bPos[q + 2]; }
      else { readVertex(b, v); px = vx; py = vy; pz = vz; }
      const X = M00 * px + M01 * py + M02 * pz + M03;
      const Y = M10 * px + M11 * py + M12 * pz + M13;
      const Z = M20 * px + M21 * py + M22 * pz + M23;
      BT[o + k * 3] = X; BT[o + k * 3 + 1] = Y; BT[o + k * 3 + 2] = Z;
      if (X < x0) x0 = X; if (X > x1) x1 = X;
      if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
    }
    // A NaN vertex fails every comparison, so its box stays inverted and the
    // triangle is dropped right here (rule 14).
    if (!(x0 - t <= FX1 && x1 + t >= FX0 && y0 - t <= FY1 && y1 + t >= FY0 && z0 - t <= FZ1 && z1 + t >= FZ0)) continue;
    const ex = BT[o + 3] - BT[o], ey = BT[o + 4] - BT[o + 1], ez = BT[o + 5] - BT[o + 2];
    const fx = BT[o + 6] - BT[o], fy = BT[o + 7] - BT[o + 1], fz = BT[o + 8] - BT[o + 2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(len > 0)) continue;                      // degenerate: can never penetrate
    nx /= len; ny /= len; nz /= len;
    const po = kept * 4;
    BP[po] = nx; BP[po + 1] = ny; BP[po + 2] = nz;
    BP[po + 3] = nx * BT[o] + ny * BT[o + 1] + nz * BT[o + 2];
    const bo = kept * 6;
    BB[bo] = x0; BB[bo + 1] = y0; BB[bo + 2] = z0;
    BB[bo + 3] = x1; BB[bo + 4] = y1; BB[bo + 5] = z1;
    if (x0 < ux0) ux0 = x0; if (y0 < uy0) uy0 = y0; if (z0 < uz0) uz0 = z0;
    if (x1 > ux1) ux1 = x1; if (y1 > uy1) uy1 = y1; if (z1 > uz1) uz1 = z1;
    kept++;
  }
  if (kept === 0) return false;

  // ── A: load the run ──
  let nA = 0;
  for (let i = as; i < ae; i += 3) {
    const o = nA * 9;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = aIdx !== null ? aIdx[i + k] : i + k;
      let px: number, py: number, pz: number;
      if (aPos !== null) { const q = v * 3; px = aPos[q]; py = aPos[q + 1]; pz = aPos[q + 2]; }
      else { readVertex(a, v); px = vx; py = vy; pz = vz; }
      AB[o + k * 3] = px; AB[o + k * 3 + 1] = py; AB[o + k * 3 + 2] = pz;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
    }
    const ao = nA * 6;
    AX[ao] = x0; AX[ao + 1] = y0; AX[ao + 2] = z0;
    AX[ao + 3] = x1; AX[ao + 4] = y1; AX[ao + 5] = z1;
    nA++;
  }

  // ── blocks of A × kept B ──
  for (let blk = 0; blk < nA; blk += BLOCK_TRIS) {
    const end = blk + BLOCK_TRIS < nA ? blk + BLOCK_TRIS : nA;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = blk; k < end; k++) {
      const ao = k * 6;
      if (AX[ao] < x0) x0 = AX[ao];
      if (AX[ao + 1] < y0) y0 = AX[ao + 1];
      if (AX[ao + 2] < z0) z0 = AX[ao + 2];
      if (AX[ao + 3] > x1) x1 = AX[ao + 3];
      if (AX[ao + 4] > y1) y1 = AX[ao + 4];
      if (AX[ao + 5] > z1) z1 = AX[ao + 5];
    }
    if (!(x0 - t <= ux1 && x1 + t >= ux0 && y0 - t <= uy1 && y1 + t >= uy0 && z0 - t <= uz1 && z1 + t >= uz0)) continue;
    const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
    const hx = (x1 - x0) * 0.5, hy = (y1 - y0) * 0.5, hz = (z1 - z0) * 0.5;
    for (let j = 0; j < kept; j++) {
      const bo = j * 6;
      if (!(x0 - t <= BB[bo + 3] && x1 + t >= BB[bo] && y0 - t <= BB[bo + 4]
        && y1 + t >= BB[bo + 1] && z0 - t <= BB[bo + 5] && z1 + t >= BB[bo + 2])) continue;
      // Does the block reach strictly across B's plane? (box support distance)
      const po = j * 4;
      const nx = BP[po], ny = BP[po + 1], nz = BP[po + 2], pd = BP[po + 3];
      const dist = nx * cx + ny * cy + nz * cz - pd;
      const r = (nx < 0 ? -nx : nx) * hx + (ny < 0 ? -ny : ny) * hy + (nz < 0 ? -nz : nz) * hz;
      if (!(dist + r > eps && dist - r < -eps)) continue;
      for (let k = blk; k < end; k++) {
        const ao = k * 6;
        if (!(AX[ao] - t <= BB[bo + 3] && AX[ao + 3] + t >= BB[bo] && AX[ao + 1] - t <= BB[bo + 4]
          && AX[ao + 4] + t >= BB[bo + 1] && AX[ao + 2] - t <= BB[bo + 5] && AX[ao + 5] + t >= BB[bo + 2])) continue;
        const o = k * 9;
        const d0 = nx * AB[o] + ny * AB[o + 1] + nz * AB[o + 2] - pd;
        const d1 = nx * AB[o + 3] + ny * AB[o + 4] + nz * AB[o + 5] - pd;
        const d2 = nx * AB[o + 6] + ny * AB[o + 7] + nz * AB[o + 8] - pd;
        if (!((d0 > eps || d1 > eps || d2 > eps) && (d0 < -eps || d1 < -eps || d2 < -eps))) continue;
        cnt.trianglesTested++;
        if (trianglesPenetrate(AB, o, BT, j * 9, eps)) {
          if (wit !== null) {
            wit.valid = true;
            wit.aStart = as; wit.aEnd = ae;
            wit.bStart = bs; wit.bEnd = be;
          }
          return true;
        }
      }
    }
  }
  return false;
}

// ─── Flat elements ───────────────────────────────────────────────────
//
// A flat part is walked element by element. `elemCount` / `elemAt` fill the
// element's run (`runStart`/`runEnd`) and box pointer (`elemBoxArr`/`elemBoxOff`).

let elemBoxArr: ArrayLike<number> = new Float64Array(6);
let elemBoxOff = 0;
let elemOk = false;

/** Number of flat elements of `part` (segments or triangle intervals). */
function elemCount(part: NarrowPart): number {
  if (part.pick !== null) {
    let n = 0;
    for (let k = 0; k < part.intervalCount; k++) n += part.intervals[k * 2 + 1] - part.intervals[k * 2] + 1;
    return n;
  }
  return part.intervalCount;
}

/** Cursor over a flat part's elements (allocation-free): interval k, offset. */
let curK = 0;
let curS = 0;

function elemBegin(part: NarrowPart): void {
  curK = 0;
  curS = part.intervalCount > 0 ? part.intervals[0] : 0;
}

/** Advance to the next element; false when exhausted. Fills run + box. */
function elemNext(part: NarrowPart): boolean {
  if (curK >= part.intervalCount) return false;
  const iv = part.intervals;
  const pick = part.pick;
  if (pick !== null) {
    const s = curS;
    runStart = pick.segIndexStart[s];
    runEnd = runStart + pick.segIndexCount[s];
    elemBoxArr = pick.segBox;
    elemBoxOff = s * 6;
    elemOk = true;
    if (s >= iv[curK * 2 + 1]) {
      curK++;
      if (curK < part.intervalCount) curS = iv[curK * 2];
    } else {
      curS = s + 1;
    }
    return true;
  }
  runStart = iv[curK * 2] * 3;
  runEnd = (iv[curK * 2 + 1] + 1) * 3;
  elemBoxArr = part.localBox;
  elemBoxOff = 0;
  elemOk = true;
  curK++;
  return true;
}

// ─── Walks ───────────────────────────────────────────────────────────

function isLeaf(data: ChunkPickData, node: number): boolean {
  return data.treeLink[2 * node] >= PICK_LEAF_FLAG;
}

function surface(box: Float32Array, o: number): number {
  const dx = box[o + 3] - box[o];
  const dy = box[o + 4] - box[o + 1];
  const dz = box[o + 5] - box[o + 2];
  return dx * dy + dy * dz + dz * dx;
}

/** Leaf × leaf of the dual walk: cluster pairs inside both interval sets. */
function leafPair(a: NarrowPart, na: number, b: NarrowPart, nb: number): boolean {
  const da = a.pick!;
  const db = b.pick!;
  const bFirst = db.treeLink[2 * nb] & 0x7fffffff;
  const bCount = db.treeLink[2 * nb + 1];
  ensureLeafScratch(bCount);
  // B's clusters of this leaf, filtered and transformed once.
  let nB = 0;
  for (let p = bFirst; p < bFirst + bCount; p++) {
    const cluster = db.clusterOrder[p];
    if (!inIntervals(b, db.clusterSeg[cluster])) continue;
    xformBox(db.clusterBox, cluster * 6);
    const o = nB * 6;
    leafBoxes[o] = tx0; leafBoxes[o + 1] = ty0; leafBoxes[o + 2] = tz0;
    leafBoxes[o + 3] = tx1; leafBoxes[o + 4] = ty1; leafBoxes[o + 5] = tz1;
    leafClusters[nB++] = cluster;
  }
  if (nB === 0) return false;
  const aFirst = da.treeLink[2 * na] & 0x7fffffff;
  const aCount = da.treeLink[2 * na + 1];
  for (let p = aFirst; p < aFirst + aCount; p++) {
    const ca = da.clusterOrder[p];
    if (!inIntervals(a, da.clusterSeg[ca])) continue;
    const ao = ca * 6;
    for (let k = 0; k < nB; k++) {
      cnt.boxesTested++;
      if (!overlaps(da.clusterBox, ao, leafBoxes, k * 6, tolLocal)) continue;
      if (flatSeparated(da.clusterBox, ao, db.clusterBox, leafClusters[k] * 6)) { cnt.flatRejected++; continue; }
      clusterRun(da, ca);
      const as = runStart, ae = runEnd;
      clusterRun(db, leafClusters[k]);
      setFilter(da.clusterBox, ao);
      if (testRuns(a, as, ae, b, runStart, runEnd)) return true;
    }
  }
  return false;
}

/** tree × tree. */
function walkTrees(a: NarrowPart, b: NarrowPart): boolean {
  const da = a.pick!;
  const db = b.pick!;
  if (da.treeNodeCount === 0 || db.treeNodeCount === 0) return false;
  ensurePairStack(da.treeMaxDepth + db.treeMaxDepth + 4);
  const ta = da.treeBox;
  const tb = db.treeBox;
  const la = a.localBox;
  const lb = b.localBox;
  let sp = 0;
  pairStack[0] = da.treeRoot;
  pairStack[1] = db.treeRoot;
  sp = 1;
  while (sp > 0) {
    sp--;
    const na = pairStack[sp * 2];
    const nb = pairStack[sp * 2 + 1];
    cnt.boxesTested++;
    // Prune against each part's own region first (a small role in a large chunk).
    if (!overlaps(ta, na * 6, la, 0, tolLocal)) continue;
    if (!overlaps(tb, nb * 6, lb, 0, 0)) continue;
    xformBox(tb, nb * 6);
    if (!overlapsT(ta, na * 6)) continue;
    const leafA = isLeaf(da, na);
    const leafB = isLeaf(db, nb);
    if (leafA && leafB) {
      if (leafPair(a, na, b, nb)) return true;
      continue;
    }
    // Descend the larger node first; a leaf is never descended.
    const splitA = leafB || (!leafA && surface(ta, na * 6) >= surface(tb, nb * 6));
    if (splitA) {
      const l = da.treeLink[2 * na];
      const r = da.treeLink[2 * na + 1];
      pairStack[sp * 2] = r; pairStack[sp * 2 + 1] = nb; sp++;
      pairStack[sp * 2] = l; pairStack[sp * 2 + 1] = nb; sp++;
    } else {
      const l = db.treeLink[2 * nb];
      const r = db.treeLink[2 * nb + 1];
      pairStack[sp * 2] = na; pairStack[sp * 2 + 1] = r; sp++;
      pairStack[sp * 2] = na; pairStack[sp * 2 + 1] = l; sp++;
    }
  }
  return false;
}

/**
 * A's tree against ONE fixed element of B, whose A-local box is `ex0..ez1` and
 * whose run is `[bs, be)`.
 */
function walkTreeA(
  a: NarrowPart, b: NarrowPart, bs: number, be: number, bArr: ArrayLike<number>, bo: number,
): boolean {
  const da = a.pick!;
  if (da.treeNodeCount === 0) return false;
  ensureNodeStack(da.treeMaxDepth + 4);
  const ta = da.treeBox;
  const la = a.localBox;
  let sp = 0;
  nodeStack[sp++] = da.treeRoot;
  while (sp > 0) {
    const n = nodeStack[--sp];
    cnt.boxesTested++;
    if (!overlaps(ta, n * 6, la, 0, tolLocal)) continue;
    if (!overlapsE(ta, n * 6)) continue;
    if (isLeaf(da, n)) {
      const first = da.treeLink[2 * n] & 0x7fffffff;
      const count = da.treeLink[2 * n + 1];
      for (let p = first; p < first + count; p++) {
        const ca = da.clusterOrder[p];
        if (!inIntervals(a, da.clusterSeg[ca])) continue;
        cnt.boxesTested++;
        if (!overlapsE(da.clusterBox, ca * 6)) continue;
        if (flatSeparated(da.clusterBox, ca * 6, bArr, bo)) { cnt.flatRejected++; continue; }
        clusterRun(da, ca);
        setFilter(da.clusterBox, ca * 6);
        if (testRuns(a, runStart, runEnd, b, bs, be)) return true;
      }
      continue;
    }
    nodeStack[sp++] = da.treeLink[2 * n + 1];
    nodeStack[sp++] = da.treeLink[2 * n];
  }
  return false;
}

/**
 * B's tree against ONE fixed element of A, whose A-local box is `ex0..ez1` and
 * whose run is `[as, ae)`.
 */
function walkTreeB(
  a: NarrowPart, as: number, ae: number, b: NarrowPart, aArr: ArrayLike<number>, ao: number,
): boolean {
  const db = b.pick!;
  if (db.treeNodeCount === 0) return false;
  ensureNodeStack(db.treeMaxDepth + 4);
  const tb = db.treeBox;
  const lb = b.localBox;
  let sp = 0;
  nodeStack[sp++] = db.treeRoot;
  while (sp > 0) {
    const n = nodeStack[--sp];
    cnt.boxesTested++;
    if (!overlaps(tb, n * 6, lb, 0, 0)) continue;
    xformBox(tb, n * 6);
    if (!tOverlapsE()) continue;
    if (isLeaf(db, n)) {
      const first = db.treeLink[2 * n] & 0x7fffffff;
      const count = db.treeLink[2 * n + 1];
      for (let p = first; p < first + count; p++) {
        const cb = db.clusterOrder[p];
        if (!inIntervals(b, db.clusterSeg[cb])) continue;
        cnt.boxesTested++;
        xformBox(db.clusterBox, cb * 6);
        if (!tOverlapsE()) continue;
        if (flatSeparated(aArr, ao, db.clusterBox, cb * 6)) { cnt.flatRejected++; continue; }
        clusterRun(db, cb);
        setFilterFromE();
        if (testRuns(a, as, ae, b, runStart, runEnd)) return true;
      }
      continue;
    }
    nodeStack[sp++] = db.treeLink[2 * n + 1];
    nodeStack[sp++] = db.treeLink[2 * n];
  }
  return false;
}

function hasTree(part: NarrowPart): boolean {
  return part.pick !== null && !part.segmentOnly && part.pick.treeNodeCount > 0;
}

// ─── Public entry ────────────────────────────────────────────────────

/**
 * Do parts `a` and `b` PENETRATE each other in their current world poses?
 *
 * `marginWorld` inflates the box pruning (0 today — near-miss is a later plan;
 * the triangle test itself is penetration-only), `epsWorld` is the contact
 * tolerance in metres (`touchEpsFor`, F20). `witness` (optional, per pair) is
 * tested first and refreshed on a hit. Early exit on the first hit.
 */
export function partsOverlap(
  a: NarrowPart,
  b: NarrowPart,
  marginWorld: number,
  epsWorld: number,
  counters: NarrowCounters,
  witness: NarrowWitness | null = null,
): boolean {
  if (a.intervalCount === 0 || b.intervalCount === 0) return false;
  if (!setupRelative(a.world, b.world, marginWorld + epsWorld, epsWorld)) return false;
  cnt = counters;
  wit = witness;
  counters.partPairs++;

  // The whole of B against the whole of A, as boxes first.
  xformBox(b.localBox, 0);
  cnt.boxesTested++;
  if (!overlapsT(a.localBox, 0)) { wit = null; return false; }
  // Parts that only abut are touching (F3) — no triangle needs to be looked at.
  if (partsAbut(a, b)) { cnt.abutRejected++; wit = null; return false; }

  if (witness !== null && witness.valid) {
    setFilter(a.localBox, 0);
    if (testRuns(a, witness.aStart, witness.aEnd, b, witness.bStart, witness.bEnd)) { wit = null; return true; }
  }

  let hit = false;
  const treeA = hasTree(a);
  const treeB = hasTree(b);
  if (treeA && treeB) {
    hit = walkTrees(a, b);
  } else if (treeA) {
    elemBegin(b);
    while (!hit && elemNext(b)) {
      if (!elemOk) continue;
      const bs = runStart, be = runEnd;
      cnt.boxesTested++;
      xformBox(elemBoxArr, elemBoxOff);
      if (!overlapsT(a.localBox, 0)) continue;
      setElemFromT();
      hit = walkTreeA(a, b, bs, be, elemBoxArr, elemBoxOff);
    }
  } else if (treeB) {
    elemBegin(a);
    while (!hit && elemNext(a)) {
      if (!elemOk) continue;
      const as = runStart, ae = runEnd;
      cnt.boxesTested++;
      if (!overlaps(elemBoxArr, elemBoxOff, a.localBox, 0, tolLocal)) continue;
      setElem(elemBoxArr, elemBoxOff);
      hit = walkTreeB(a, as, ae, b, elemBoxArr, elemBoxOff);
    }
  } else {
    hit = walkFlat(a, b);
  }
  wit = null;
  return hit;
}

/** flat × flat: every element of A against every element of B. */
function walkFlat(a: NarrowPart, b: NarrowPart): boolean {
  // Elements of B are re-enumerated per A element; both cursors are module
  // state, so A's position is saved and restored around the inner loop.
  elemBegin(a);
  while (elemNext(a)) {
    const as = runStart, ae = runEnd;
    const aArr = elemBoxArr, aOff = elemBoxOff;
    const saveK = curK, saveS = curS;
    elemBegin(b);
    while (elemNext(b)) {
      cnt.boxesTested++;
      xformBox(elemBoxArr, elemBoxOff);
      if (!overlapsT(aArr, aOff)) continue;
      if (flatSeparated(aArr, aOff, elemBoxArr, elemBoxOff)) { cnt.flatRejected++; continue; }
      const bs = runStart, be = runEnd;
      setFilter(aArr, aOff);
      if (testRuns(a, as, ae, b, bs, be)) return true;
    }
    curK = saveK; curS = saveS;
  }
  return false;
}

/**
 * The O(n·m) oracle: every allowed triangle of A against every allowed triangle
 * of B with the SAME exact test, no structure at all. Used by the parity tests
 * to prove the walks above correct; never called by the manager.
 */
export function partsOverlapBruteForce(a: NarrowPart, b: NarrowPart, epsWorld: number): boolean {
  if (!setupRelative(a.world, b.world, epsWorld, epsWorld)) return false;
  cnt = createNarrowCounters();
  wit = null;
  fx0 = -Infinity; fy0 = -Infinity; fz0 = -Infinity;
  fx1 = Infinity; fy1 = Infinity; fz1 = Infinity;
  for (let ka = 0; ka < a.intervalCount; ka++) {
    const [as, ae] = runOfInterval(a, ka);
    for (let kb = 0; kb < b.intervalCount; kb++) {
      const [bs, be] = runOfInterval(b, kb);
      // One B triangle at a time keeps the scratch small for big parts.
      for (let i = bs; i < be; i += 3) {
        if (testRuns(a, as, ae, b, i, i + 3)) return true;
      }
    }
  }
  return false;
}

/** Index-position run `[start, end)` of interval `k` (segments are contiguous, P1). */
function runOfInterval(part: NarrowPart, k: number): [number, number] {
  const first = part.intervals[k * 2];
  const last = part.intervals[k * 2 + 1];
  const pick = part.pick;
  if (pick !== null) return [pick.segIndexStart[first], pick.segIndexStart[last] + pick.segIndexCount[last]];
  return [first * 3, (last + 1) * 3];
}

/** Elements a flat walk visits (tests / DevTools). */
export function flatElementCount(part: NarrowPart): number {
  return elemCount(part);
}

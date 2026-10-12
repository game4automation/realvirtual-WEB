// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-pick-build.ts — construction of the flat pick structure (plan-756, step 1a).
 *
 * PURE: plain typed arrays in, plain typed arrays out. No three.js object, no
 * DOM, no viewer state — which is exactly what lets the module worker and the
 * inline fallback of step 1b call the SAME function (the "one function, two
 * callers" pattern of `rv-mesh-merge-client.ts`): they cannot diverge, and a
 * worker/inline byte-identity test is meaningful.
 *
 * Per segment (a contiguous index run, see `rv-pick-structure.ts`):
 *
 *   1. AABB of the segment.
 *   2. Morton code of each triangle CENTROID, quantised against that segment's
 *      own box — never a whole-model grid, which would merge sub-millimetre
 *      features on a metre-sized CAD part (plan P4).
 *   3. LSD radix sort of (code, triangle) in parallel typed arrays. Never
 *      `Array.prototype.sort`: it boxes, allocates and is not stable across
 *      engines. Counting sort IS stable, and the ids start in ascending
 *      triangle order, so equal codes keep ascending triangle order — the
 *      build is deterministic and ties break on the triangle index
 *      (plan §2.4a.7, the precondition for worker == inline).
 *   4. The index triples are permuted IN PLACE inside the segment. Segment
 *      boundaries never move.
 *   5. Clusters of `clusterTris` triangles with one AABB each.
 *
 * Then ONE binned-SAH tree over all cluster boxes (plan §2.4a.1 — the plan's
 * original bottom-up tree over cluster order tested ~9× more boxes per ray in
 * the spike). Leaf = up to `LEAF_CLUSTERS` clusters.
 *
 * Two size-dependent paths, both measured in the plan's spike:
 *
 *   - Segment ≤ `clusterTris` triangles: ONE cluster anyway, so Morton and
 *     sort are skipped entirely (−15 % build time on CAD with many tiny
 *     meshes). The original triangle order survives.
 *   - Segment > `LARGE_SEGMENT_CLUSTERS × clusterTris` triangles (the root
 *     catch-all): the 30-bit grid is too coarse, so codes are quantised
 *     against the CENTROID box and widened to 60 bits in two Uint32 keys,
 *     radix-sorted over both (plan §2.4a.3).
 *
 * The build is written as a GENERATOR of progress checkpoints. `yield` points
 * sit between segments and, for a huge segment, inside every phase of it, so
 * step 1b's inline fallback can time-slice without a second implementation:
 * `buildPickStructure` drains it with a synchronous hook,
 * `buildPickStructureAsync` awaits an asynchronous one. Both walk identical
 * code, so their output is identical by construction.
 */

import {
  CLUSTER_TRIS,
  LEAF_CLUSTERS,
  PICK_LEAF_FLAG,
  type ChunkPickData,
} from './rv-pick-structure';

export { CLUSTER_TRIS, LEAF_CLUSTERS } from './rv-pick-structure';

/**
 * A segment longer than this many clusters uses the wide (60-bit, centroid-box)
 * Morton path.
 */
export const LARGE_SEGMENT_CLUSTERS = 64;

/** Default triangles of work between two yield checkpoints inside a segment. */
export const DEFAULT_SLICE_TRIS = 131072;

/** SAH bins per axis. */
const SAH_BINS = 16;

/** Clusters partitioned between two yield checkpoints of the tree phase. */
const TREE_SLICE_CLUSTERS = 65536;

// ─── Inputs ─────────────────────────────────────────────────────────

/**
 * One segment of the chunk index. `node` / `owner` are the ordinals the bake
 * assigns in step 1c; they are copied through verbatim and default to the
 * segment position / "no owner".
 */
export interface PickSegmentInput {
  indexStart: number;
  indexCount: number;
  /** Node ordinal owning the geometry. Default: the segment's own position. */
  node?: number;
  /** Pick-owner ordinal, -1 = none. Default -1. */
  owner?: number;
}

export type PickBuildPhase = 'box' | 'code' | 'sort' | 'permute' | 'cluster' | 'tree';

/** A yield checkpoint. `segment` is -1 for the tree phase. */
export interface PickBuildProgress {
  segment: number;
  segmentCount: number;
  phase: PickBuildPhase;
  /** Triangles (tree phase: clusters) finished within this phase. */
  done: number;
  /** Triangles (tree phase: clusters) this phase has to do in total. */
  total: number;
}

export interface PickBuildOptions {
  clusterTris?: number;
  leafClusters?: number;
  /** Triangles of work between yield checkpoints. Default `DEFAULT_SLICE_TRIS`. */
  sliceTris?: number;
  /** Chunk material is opaque (plan Q5). Default true. */
  blocks?: boolean;
  /** Chunk material renders back faces too. Default false (`FrontSide`). */
  doubleSided?: boolean;
  /**
   * Morton code width. `'auto'` (default) widens to 60 bits for segments above
   * `LARGE_SEGMENT_CLUSTERS × clusterTris`; the explicit values exist so the
   * tuning run of plan step 1e (and the suite) can compare both grids on the
   * same geometry.
   */
  wideCodes?: 'auto' | 'always' | 'never';
  /** Synchronous checkpoint hook. Use `buildPickStructureAsync` to await one. */
  onYield?: (progress: PickBuildProgress) => void;
}

/** Same options, but the hook may return a promise. */
export interface PickBuildOptionsAsync extends Omit<PickBuildOptions, 'onYield'> {
  onYield?: (progress: PickBuildProgress) => void | Promise<void>;
}

export interface PickBuildStats {
  buildMs: number;
  segments: number;
  clusters: number;
  treeNodes: number;
  treeMaxDepth: number;
  /** Segments that were actually Morton-sorted (i.e. larger than one cluster). */
  sortedSegments: number;
  /** Segments that took the wide 60-bit code path. */
  wideSegments: number;
  /** Largest segment in triangles. */
  maxSegmentTriangles: number;
  /** Transient (scratch) bytes the build allocated on top of the structure. */
  transientBytes: number;
  checkpoints: number;
}

export interface PickBuildResult {
  data: ChunkPickData;
  /** The SAME array that was passed in — permuted in place. */
  index: Uint32Array;
  stats: PickBuildStats;
}

// ─── Small helpers ──────────────────────────────────────────────────

/** Spread the low 10 bits of `v` to every third bit. */
function expand10(v: number): number {
  v = (v | (v << 16)) & 0x030000ff;
  v = (v | (v << 8)) & 0x0300f00f;
  v = (v | (v << 4)) & 0x030c30c3;
  v = (v | (v << 2)) & 0x09249249;
  return v;
}

function emptyBox(dst: Float32Array, o: number): void {
  dst[o] = Infinity;
  dst[o + 1] = Infinity;
  dst[o + 2] = Infinity;
  dst[o + 3] = -Infinity;
  dst[o + 4] = -Infinity;
  dst[o + 5] = -Infinity;
}

function unionBox(dst: Float32Array, d: number, src: Float32Array, s: number): void {
  if (src[s] < dst[d]) dst[d] = src[s];
  if (src[s + 1] < dst[d + 1]) dst[d + 1] = src[s + 1];
  if (src[s + 2] < dst[d + 2]) dst[d + 2] = src[s + 2];
  if (src[s + 3] > dst[d + 3]) dst[d + 3] = src[s + 3];
  if (src[s + 4] > dst[d + 4]) dst[d + 4] = src[s + 4];
  if (src[s + 5] > dst[d + 5]) dst[d + 5] = src[s + 5];
}

function halfSurfaceArea(box: Float32Array, o: number): number {
  const x = box[o + 3] - box[o];
  const y = box[o + 4] - box[o + 1];
  const z = box[o + 5] - box[o + 2];
  // Negative extent ⇒ the box is empty (never populated): zero cost.
  return x < 0 || y < 0 || z < 0 ? 0 : x * y + y * z + z * x;
}

// ─── The build ──────────────────────────────────────────────────────

/**
 * Checkpointed build. Prefer `buildPickStructure` /
 * `buildPickStructureAsync`; this is exported so a caller with its own
 * scheduler (step 1b) can drive the machine directly.
 */
export function* buildPickStructureSteps(
  position: Float32Array,
  index: Uint32Array,
  segments: readonly PickSegmentInput[],
  options: PickBuildOptions = {},
): Generator<PickBuildProgress, PickBuildResult, void> {
  const t0 = performance.now();
  const clusterTris = Math.max(1, options.clusterTris ?? CLUSTER_TRIS);
  const leafClusters = Math.max(1, options.leafClusters ?? LEAF_CLUSTERS);
  const sliceTris = Math.max(1024, options.sliceTris ?? DEFAULT_SLICE_TRIS);
  const wideMode = options.wideCodes ?? 'auto';
  const wideThreshold =
    wideMode === 'always' ? clusterTris : wideMode === 'never' ? Infinity : LARGE_SEGMENT_CLUSTERS * clusterTris;

  const segmentCount = segments.length;
  const segNode = new Uint32Array(segmentCount);
  const segOwner = new Int32Array(segmentCount);
  const segIndexStart = new Uint32Array(segmentCount);
  const segIndexCount = new Uint32Array(segmentCount);
  const segBox = new Float32Array(segmentCount * 6);
  const segFirstCluster = new Uint32Array(segmentCount + 1);

  let clusterCount = 0;
  let maxSortTris = 0;
  let maxSegmentTriangles = 0;
  let sortedSegments = 0;
  let wideSegments = 0;
  for (let s = 0; s < segmentCount; s++) {
    const seg = segments[s];
    // Only whole triangles are addressable; a malformed count is truncated
    // rather than trusted, so no phase can read past the segment.
    const count = seg.indexCount - (seg.indexCount % 3);
    segIndexStart[s] = seg.indexStart;
    segIndexCount[s] = count;
    segNode[s] = seg.node ?? s;
    segOwner[s] = seg.owner ?? -1;
    const tris = count / 3;
    segFirstCluster[s] = clusterCount;
    clusterCount += Math.ceil(tris / clusterTris);
    if (tris > maxSegmentTriangles) maxSegmentTriangles = tris;
    if (tris > clusterTris) {
      sortedSegments++;
      if (tris > maxSortTris) maxSortTris = tris;
      if (tris > wideThreshold) wideSegments++;
    }
  }
  segFirstCluster[segmentCount] = clusterCount;

  const clusterBox = new Float32Array(clusterCount * 6);
  const clusterSeg = new Uint32Array(clusterCount);

  // Scratch, sized for the LARGEST segment and reused by every segment.
  const codeLo = new Uint32Array(maxSortTris);
  const codeHi = new Uint32Array(wideSegments > 0 ? maxSortTris : 0);
  const codeLoB = new Uint32Array(maxSortTris);
  const codeHiB = new Uint32Array(wideSegments > 0 ? maxSortTris : 0);
  const idsA = new Uint32Array(maxSortTris);
  const idsB = new Uint32Array(maxSortTris);
  const triScratch = new Uint32Array(maxSortTris * 3);
  const hist = new Uint32Array(1024);
  const transientBytes =
    codeLo.byteLength + codeHi.byteLength + codeLoB.byteLength + codeHiB.byteLength +
    idsA.byteLength + idsB.byteLength + triScratch.byteLength + hist.byteLength;

  let checkpoints = 0;

  for (let s = 0; s < segmentCount; s++) {
    const start = segIndexStart[s];
    const count = segIndexCount[s];
    const tris = count / 3;
    const end = start + count;
    const boxOffset = s * 6;

    // ── 1. segment box ────────────────────────────────────────────
    emptyBox(segBox, boxOffset);
    {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity;
      let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      let work = 0;
      for (let i = start; i < end; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = index[i + k] * 3;
          const x = position[v], y = position[v + 1], z = position[v + 2];
          // NaN fails every comparison and therefore never enters the box.
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (z < z0) z0 = z;
          if (z > z1) z1 = z;
        }
        if (++work >= sliceTris) {
          work = 0;
          checkpoints++;
          yield { segment: s, segmentCount, phase: 'box', done: (i - start) / 3, total: tris };
        }
      }
      segBox[boxOffset] = x0;
      segBox[boxOffset + 1] = y0;
      segBox[boxOffset + 2] = z0;
      segBox[boxOffset + 3] = x1;
      segBox[boxOffset + 4] = y1;
      segBox[boxOffset + 5] = z1;
    }

    const wide = tris > wideThreshold;
    if (tris > clusterTris) {
      // ── 2. Morton codes ─────────────────────────────────────────
      // Quantisation box: the segment box for the narrow path, the tighter
      // CENTROID box for the wide path (plan §2.4a.3). Everything is kept in
      // "3 × centroid" units so no division per triangle is needed.
      let qx0 = segBox[boxOffset] * 3;
      let qy0 = segBox[boxOffset + 1] * 3;
      let qz0 = segBox[boxOffset + 2] * 3;
      let qx1 = segBox[boxOffset + 3] * 3;
      let qy1 = segBox[boxOffset + 4] * 3;
      let qz1 = segBox[boxOffset + 5] * 3;
      if (wide) {
        qx0 = Infinity; qy0 = Infinity; qz0 = Infinity;
        qx1 = -Infinity; qy1 = -Infinity; qz1 = -Infinity;
        let work = 0;
        for (let t = 0; t < tris; t++) {
          const i = start + 3 * t;
          const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
          const cx = position[a] + position[b] + position[c];
          const cy = position[a + 1] + position[b + 1] + position[c + 1];
          const cz = position[a + 2] + position[b + 2] + position[c + 2];
          if (cx < qx0) qx0 = cx;
          if (cx > qx1) qx1 = cx;
          if (cy < qy0) qy0 = cy;
          if (cy > qy1) qy1 = cy;
          if (cz < qz0) qz0 = cz;
          if (cz > qz1) qz1 = cz;
          if (++work >= sliceTris) {
            work = 0;
            checkpoints++;
            yield { segment: s, segmentCount, phase: 'code', done: t, total: 2 * tris };
          }
        }
      }
      // A flat or degenerate axis (extent 0, or -Infinity for an all-NaN
      // segment) gets scale 0: every code bit of that axis is 0 and the stable
      // sort keeps the original order. No division by zero anywhere.
      const levels = wide ? 1048576 : 1024;
      const maxQ = levels - 1;
      const ex = qx1 - qx0, ey = qy1 - qy0, ez = qz1 - qz0;
      const sx = ex > 0 ? levels / ex : 0;
      const sy = ey > 0 ? levels / ey : 0;
      const sz = ez > 0 ? levels / ez : 0;
      {
        let work = 0;
        for (let t = 0; t < tris; t++) {
          const i = start + 3 * t;
          const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
          let bx = ((position[a] + position[b] + position[c] - qx0) * sx) | 0;
          let by = ((position[a + 1] + position[b + 1] + position[c + 1] - qy0) * sy) | 0;
          let bz = ((position[a + 2] + position[b + 2] + position[c + 2] - qz0) * sz) | 0;
          // `| 0` already turned NaN into 0; clamp the open upper end.
          if (bx > maxQ) bx = maxQ; else if (bx < 0) bx = 0;
          if (by > maxQ) by = maxQ; else if (by < 0) by = 0;
          if (bz > maxQ) bz = maxQ; else if (bz < 0) bz = 0;
          if (wide) {
            // 60-bit code as two 30-bit halves: the high halves of the three
            // coordinates interleave into the more significant key.
            codeLo[t] = expand10(bx & 1023) | (expand10(by & 1023) << 1) | (expand10(bz & 1023) << 2);
            codeHi[t] = expand10(bx >>> 10) | (expand10(by >>> 10) << 1) | (expand10(bz >>> 10) << 2);
          } else {
            codeLo[t] = expand10(bx) | (expand10(by) << 1) | (expand10(bz) << 2);
          }
          idsA[t] = t;
          if (++work >= sliceTris) {
            work = 0;
            checkpoints++;
            yield { segment: s, segmentCount, phase: 'code', done: (wide ? tris : 0) + t, total: wide ? 2 * tris : tris };
          }
        }
      }

      // ── 3. LSD radix sort (stable ⇒ tie-break on triangle index) ─
      // 10 bits per pass; the low key first, then the high key, so the final
      // order is by (hi, lo). Both key halves are 30 bits ⇒ 3 passes each.
      let srcLo = codeLo, srcHi = codeHi, srcIds = idsA;
      let dstLo = codeLoB, dstHi = codeHiB, dstIds = idsB;
      const keyCount = wide ? 2 : 1;
      for (let key = 0; key < keyCount; key++) {
        for (let pass = 0; pass < 3; pass++) {
          const shift = pass * 10;
          const keySrc = key === 0 ? srcLo : srcHi;
          hist.fill(0);
          let work = 0;
          for (let t = 0; t < tris; t++) {
            hist[(keySrc[t] >>> shift) & 1023]++;
            if (++work >= sliceTris) {
              work = 0;
              checkpoints++;
              yield { segment: s, segmentCount, phase: 'sort', done: t, total: tris };
            }
          }
          let sum = 0;
          for (let b = 0; b < 1024; b++) {
            const c = hist[b];
            hist[b] = sum;
            sum += c;
          }
          work = 0;
          for (let t = 0; t < tris; t++) {
            const d = hist[(keySrc[t] >>> shift) & 1023]++;
            dstLo[d] = srcLo[t];
            if (wide) dstHi[d] = srcHi[t];
            dstIds[d] = srcIds[t];
            if (++work >= sliceTris) {
              work = 0;
              checkpoints++;
              yield { segment: s, segmentCount, phase: 'sort', done: t, total: tris };
            }
          }
          let swap = srcLo; srcLo = dstLo; dstLo = swap;
          swap = srcHi; srcHi = dstHi; dstHi = swap;
          swap = srcIds; srcIds = dstIds; dstIds = swap;
        }
      }

      // ── 4. permute the index triples in place, inside the segment ─
      {
        // The permutation sources are scattered over the whole segment, so the
        // original triples have to be copied out first — sliced as well, so a
        // multi-megabyte memcpy is not one unbreakable block.
        let work = 0;
        for (let t = 0; t < tris; t++) {
          const src = start + 3 * t;
          const dst = 3 * t;
          triScratch[dst] = index[src];
          triScratch[dst + 1] = index[src + 1];
          triScratch[dst + 2] = index[src + 2];
          if (++work >= sliceTris) {
            work = 0;
            checkpoints++;
            yield { segment: s, segmentCount, phase: 'permute', done: t, total: 2 * tris };
          }
        }
        work = 0;
        for (let t = 0; t < tris; t++) {
          const src = srcIds[t] * 3;
          const dst = start + 3 * t;
          index[dst] = triScratch[src];
          index[dst + 1] = triScratch[src + 1];
          index[dst + 2] = triScratch[src + 2];
          if (++work >= sliceTris) {
            work = 0;
            checkpoints++;
            yield { segment: s, segmentCount, phase: 'permute', done: tris + t, total: 2 * tris };
          }
        }
      }
    }

    // ── 5. cluster boxes ──────────────────────────────────────────
    {
      let cluster = segFirstCluster[s];
      let work = 0;
      for (let cs = start; cs < end; cs += 3 * clusterTris, cluster++) {
        const span = cs + 3 * clusterTris;
        const ce = span < end ? span : end;
        let x0 = Infinity, y0 = Infinity, z0 = Infinity;
        let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let i = cs; i < ce; i++) {
          const v = index[i] * 3;
          const x = position[v], y = position[v + 1], z = position[v + 2];
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (z < z0) z0 = z;
          if (z > z1) z1 = z;
        }
        const o = cluster * 6;
        clusterBox[o] = x0;
        clusterBox[o + 1] = y0;
        clusterBox[o + 2] = z0;
        clusterBox[o + 3] = x1;
        clusterBox[o + 4] = y1;
        clusterBox[o + 5] = z1;
        clusterSeg[cluster] = s;
        work += clusterTris;
        if (work >= sliceTris) {
          work = 0;
          checkpoints++;
          yield { segment: s, segmentCount, phase: 'cluster', done: (cs - start) / 3, total: tris };
        }
      }
    }

    checkpoints++;
    yield { segment: s, segmentCount, phase: 'cluster', done: tris, total: tris };
  }

  // ── 6. binned-SAH tree over the cluster boxes ───────────────────
  const tree = yield* buildClusterTree(
    clusterBox,
    clusterCount,
    leafClusters,
    segmentCount,
    // The tree phase counts CLUSTERS, so the triangle budget is converted.
    Math.max(256, Math.min(TREE_SLICE_CLUSTERS, Math.ceil(sliceTris / clusterTris))),
  );
  checkpoints += tree.checkpoints;

  const data: ChunkPickData = {
    clusterTris,
    triangleCount: index.length / 3,
    segmentCount,
    clusterCount,
    segNode,
    segOwner,
    segIndexStart,
    segIndexCount,
    segBox,
    segFirstCluster,
    clusterBox,
    clusterSeg,
    clusterOrder: tree.order,
    treeBox: tree.box,
    treeLink: tree.link,
    treeRoot: 0,
    treeNodeCount: tree.nodeCount,
    treeMaxDepth: tree.maxDepth,
    blocks: options.blocks ?? true,
    doubleSided: options.doubleSided ?? false,
  };

  return {
    data,
    index,
    stats: {
      buildMs: performance.now() - t0,
      segments: segmentCount,
      clusters: clusterCount,
      treeNodes: tree.nodeCount,
      treeMaxDepth: tree.maxDepth,
      sortedSegments,
      wideSegments,
      maxSegmentTriangles,
      transientBytes,
      checkpoints,
    },
  };
}

interface ClusterTree {
  box: Float32Array;
  link: Uint32Array;
  order: Uint32Array;
  nodeCount: number;
  maxDepth: number;
  checkpoints: number;
}

/**
 * Top-down binned SAH over cluster boxes. Deterministic: the bin assignment is
 * pure arithmetic and the partition swap sequence depends only on the incoming
 * cluster order, so the worker and the inline path produce identical arrays.
 */
function* buildClusterTree(
  clusterBox: Float32Array,
  clusterCount: number,
  leafClusters: number,
  segmentCount: number,
  sliceClusters: number,
): Generator<PickBuildProgress, ClusterTree, void> {
  const order = new Uint32Array(clusterCount);
  for (let c = 0; c < clusterCount; c++) order[c] = c;
  if (clusterCount === 0) {
    return { box: new Float32Array(0), link: new Uint32Array(0), order, nodeCount: 0, maxDepth: 0, checkpoints: 0 };
  }

  const centroid = new Float32Array(clusterCount * 3);
  for (let c = 0; c < clusterCount; c++) {
    const o = c * 6;
    centroid[3 * c] = 0.5 * (clusterBox[o] + clusterBox[o + 3]);
    centroid[3 * c + 1] = 0.5 * (clusterBox[o + 1] + clusterBox[o + 4]);
    centroid[3 * c + 2] = 0.5 * (clusterBox[o + 2] + clusterBox[o + 5]);
  }

  // A binary tree whose leaves hold >= 1 cluster has < 2 * clusterCount nodes.
  const maxNodes = 2 * clusterCount;
  const box = new Float32Array(maxNodes * 6);
  const link = new Uint32Array(maxNodes * 2);
  const binBox = new Float32Array(SAH_BINS * 6);
  const binCount = new Uint32Array(SAH_BINS);
  const rightArea = new Float64Array(SAH_BINS);
  const rightCount = new Uint32Array(SAH_BINS);
  const accBox = new Float32Array(6);

  const stackNode: number[] = [0];
  const stackStart: number[] = [0];
  const stackCount: number[] = [clusterCount];
  const stackDepth: number[] = [1];
  let nodeCount = 1;
  let maxDepth = 1;
  let checkpoints = 0;
  let work = 0;

  while (stackNode.length > 0) {
    const node = stackNode.pop() as number;
    const start = stackStart.pop() as number;
    const count = stackCount.pop() as number;
    const depth = stackDepth.pop() as number;
    if (depth > maxDepth) maxDepth = depth;

    emptyBox(box, node * 6);
    let c0x = Infinity, c0y = Infinity, c0z = Infinity;
    let c1x = -Infinity, c1y = -Infinity, c1z = -Infinity;
    for (let p = start; p < start + count; p++) {
      const c = order[p];
      unionBox(box, node * 6, clusterBox, c * 6);
      const x = centroid[3 * c], y = centroid[3 * c + 1], z = centroid[3 * c + 2];
      if (x < c0x) c0x = x;
      if (x > c1x) c1x = x;
      if (y < c0y) c0y = y;
      if (y > c1y) c1y = y;
      if (z < c0z) c0z = z;
      if (z > c1z) c1z = z;
    }
    if (count <= leafClusters) {
      link[2 * node] = (PICK_LEAF_FLAG | start) >>> 0;
      link[2 * node + 1] = count;
      continue;
    }

    let bestCost = Infinity;
    let bestAxis = -1;
    let bestBin = -1;
    let bestMin = 0;
    let bestScale = 0;
    for (let axis = 0; axis < 3; axis++) {
      const lo = axis === 0 ? c0x : axis === 1 ? c0y : c0z;
      const hi = axis === 0 ? c1x : axis === 1 ? c1y : c1z;
      if (!(hi > lo)) continue;
      const scale = SAH_BINS / (hi - lo);
      for (let b = 0; b < SAH_BINS; b++) {
        emptyBox(binBox, b * 6);
        binCount[b] = 0;
      }
      for (let p = start; p < start + count; p++) {
        const c = order[p];
        let b = ((centroid[3 * c + axis] - lo) * scale) | 0;
        if (b >= SAH_BINS) b = SAH_BINS - 1;
        binCount[b]++;
        unionBox(binBox, b * 6, clusterBox, c * 6);
      }
      emptyBox(accBox, 0);
      let rc = 0;
      for (let b = SAH_BINS - 1; b > 0; b--) {
        unionBox(accBox, 0, binBox, b * 6);
        rc += binCount[b];
        rightArea[b] = halfSurfaceArea(accBox, 0);
        rightCount[b] = rc;
      }
      emptyBox(accBox, 0);
      let lc = 0;
      for (let b = 0; b < SAH_BINS - 1; b++) {
        unionBox(accBox, 0, binBox, b * 6);
        lc += binCount[b];
        if (lc === 0 || rightCount[b + 1] === 0) continue;
        const cost = lc * halfSurfaceArea(accBox, 0) + rightCount[b + 1] * rightArea[b + 1];
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestBin = b;
          bestMin = lo;
          bestScale = scale;
        }
      }
    }

    let mid: number;
    if (bestAxis < 0) {
      // Every centroid coincides (duplicate clusters): split in the middle so
      // the recursion always terminates.
      mid = start + (count >> 1);
    } else {
      let i = start;
      let j = start + count - 1;
      while (i <= j) {
        let b = ((centroid[3 * order[i] + bestAxis] - bestMin) * bestScale) | 0;
        if (b >= SAH_BINS) b = SAH_BINS - 1;
        if (b <= bestBin) i++;
        else {
          const t = order[i];
          order[i] = order[j];
          order[j] = t;
          j--;
        }
      }
      mid = i;
      if (mid === start || mid === start + count) mid = start + (count >> 1);
    }

    const left = nodeCount++;
    const right = nodeCount++;
    link[2 * node] = left;
    link[2 * node + 1] = right;
    stackNode.push(right);
    stackStart.push(mid);
    stackCount.push(start + count - mid);
    stackDepth.push(depth + 1);
    stackNode.push(left);
    stackStart.push(start);
    stackCount.push(mid - start);
    stackDepth.push(depth + 1);

    work += count;
    if (work >= sliceClusters) {
      work = 0;
      checkpoints++;
      yield { segment: -1, segmentCount, phase: 'tree', done: nodeCount, total: maxNodes };
    }
  }

  // One checkpoint at the end of the phase, always — a caller driving the
  // build must see the tree phase even on a chunk with a handful of clusters.
  checkpoints++;
  yield { segment: -1, segmentCount, phase: 'tree', done: nodeCount, total: nodeCount };

  return {
    box: box.slice(0, nodeCount * 6),
    link: link.slice(0, nodeCount * 2),
    order,
    nodeCount,
    maxDepth,
    checkpoints,
  };
}

/**
 * Build the pick structure synchronously. `options.onYield` is called at every
 * checkpoint (between segments and inside huge segments) and must be
 * synchronous — it exists so a caller can measure or abort, not to schedule.
 */
export function buildPickStructure(
  position: Float32Array,
  index: Uint32Array,
  segments: readonly PickSegmentInput[],
  options: PickBuildOptions = {},
): PickBuildResult {
  const hook = options.onYield;
  const steps = buildPickStructureSteps(position, index, segments, options);
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
    if (hook !== undefined) hook(step.value);
  }
}

/**
 * Build the pick structure, awaiting `options.onYield` at every checkpoint —
 * the shape step 1b's inline fallback uses to time-slice (yield to the event
 * loop once a slice budget is spent) without a second implementation.
 *
 * Walks the same generator as `buildPickStructure`, so the resulting arrays are
 * identical byte for byte.
 */
export async function buildPickStructureAsync(
  position: Float32Array,
  index: Uint32Array,
  segments: readonly PickSegmentInput[],
  options: PickBuildOptionsAsync = {},
): Promise<PickBuildResult> {
  const hook = options.onYield;
  const steps = buildPickStructureSteps(position, index, segments, options as PickBuildOptions);
  for (;;) {
    const step = steps.next();
    if (step.done === true) return step.value;
    if (hook !== undefined) await hook(step.value);
  }
}

// ─── Segment-only structure (plan-757 Phase 3 commit B) ─────────────

/**
 * The SEGMENT TABLE of a chunk without clusters or tree — what the bake
 * publishes for a chunk whose pick build failed (in the worker AND in the
 * inline retry), instead of rejecting the whole load. Everything that reads
 * segments keeps working unchanged: the node table (highlight, bounds), the
 * owner and `blocked` resolution, `segmentRange` / `segmentBoxUnion`; only
 * the acceleration is missing, so the traversal takes its linear walk for
 * this chunk (`treeNodeCount === 0`, see `PickQueryOptions.linear`).
 *
 * Synchronous and cheap — one pass over the triangles for the segment boxes,
 * no sort, no permutation: `index` is left exactly as staged, which is fine
 * because segment boundaries never depended on the sort (it only ever ran
 * INSIDE a segment).
 */
export function buildSegmentOnlyStructure(
  position: Float32Array,
  index: Uint32Array,
  segments: readonly PickSegmentInput[],
  options: Pick<PickBuildOptions, 'blocks' | 'doubleSided' | 'clusterTris'> = {},
): ChunkPickData {
  const segmentCount = segments.length;
  const segNode = new Uint32Array(segmentCount);
  const segOwner = new Int32Array(segmentCount);
  const segIndexStart = new Uint32Array(segmentCount);
  const segIndexCount = new Uint32Array(segmentCount);
  const segBox = new Float32Array(segmentCount * 6);
  let triangleCount = 0;
  for (let s = 0; s < segmentCount; s++) {
    const seg = segments[s];
    const count = seg.indexCount - (seg.indexCount % 3);
    const start = seg.indexStart;
    segIndexStart[s] = start;
    segIndexCount[s] = count;
    segNode[s] = seg.node ?? s;
    segOwner[s] = seg.owner ?? -1;
    triangleCount += count / 3;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity;
    let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const end = start + count;
    for (let i = start; i < end; i++) {
      const v = index[i] * 3;
      const x = position[v], y = position[v + 1], z = position[v + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const o = s * 6;
    segBox[o] = x0; segBox[o + 1] = y0; segBox[o + 2] = z0;
    segBox[o + 3] = x1; segBox[o + 4] = y1; segBox[o + 5] = z1;
  }
  return {
    clusterTris: Math.max(1, options.clusterTris ?? CLUSTER_TRIS),
    triangleCount,
    segmentCount,
    clusterCount: 0,
    segNode,
    segOwner,
    segIndexStart,
    segIndexCount,
    segBox,
    // `segmentCount + 1` zeros: every segment owns the empty cluster range.
    segFirstCluster: new Uint32Array(segmentCount + 1),
    clusterBox: new Float32Array(0),
    clusterSeg: new Uint32Array(0),
    clusterOrder: new Uint32Array(0),
    treeBox: new Float32Array(0),
    treeLink: new Uint32Array(0),
    treeRoot: 0,
    treeNodeCount: 0,
    treeMaxDepth: 0,
    blocks: options.blocks ?? true,
    doubleSided: options.doubleSided ?? false,
  };
}

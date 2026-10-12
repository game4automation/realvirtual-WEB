// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
// SPIKE plan-756 — throw-away, not product code

/**
 * Thin flat-cluster pick structure: per segment Morton sort → fixed clusters → AABB per cluster →
 * flat tree over cluster boxes. Pure typed arrays, no three.js.
 */

export const CLUSTER_TRIS = 128;
const LEAF_FLAG = 0x80000000;

export interface SegmentIn { indexStart: number; indexCount: number }

export interface BuildOpts {
  clusterTris?: number;
  /** A segment with <= clusterTris triangles is one cluster anyway → skip Morton + sort. Default true. */
  skipSortSmall?: boolean;
  /** 'phases' = every phase over all segments (clean split timing); 'segments' = all phases per segment
   *  (what a yielding inline fallback would do; records the largest single segment block). */
  order?: 'phases' | 'segments';
}

export interface BuildTimings {
  alloc: number; boxes: number; morton: number; sort: number; permute: number; clusters: number; total: number;
  maxSegmentMs: number; maxSegmentTris: number; sortedSegments: number; transientBytes: number;
}

export interface PickStructure {
  clusterTris: number;
  triCount: number;
  segCount: number;
  clusterCount: number;
  index: Uint32Array;            // reordered IN PLACE (same array as passed in)
  segIndexStart: Uint32Array;
  segIndexCount: Uint32Array;
  segBox: Float32Array;          // 6 / segment
  segFirstCluster: Uint32Array;  // segCount + 1
  clusterBox: Float32Array;      // 6 / cluster
  clusterSeg: Uint32Array;
  bytes: number;                 // seg* + cluster* arrays actually allocated
  timings: BuildTimings;
}

export interface PickTree {
  kind: string;
  leafClusters: number;
  nodeCount: number;
  root: number;
  box: Float32Array;   // 6 / node
  link: Uint32Array;   // 2 / node. inner: [left,right]; leaf: [LEAF_FLAG|firstPos, count]
  order: Uint32Array | null; // pos → cluster (null = identity)
  bytes: number;
  buildMs: number;
  maxDepth: number;
}

function expand10(v: number): number {
  v = (v | (v << 16)) & 0x030000ff;
  v = (v | (v << 8)) & 0x0300f00f;
  v = (v | (v << 4)) & 0x030c30c3;
  v = (v | (v << 2)) & 0x09249249;
  return v;
}

/** LSD radix sort of (codes, ids) on [off, off+n). Result ALWAYS ends in the B arrays (odd pass count). */
function radixSort(
  codesA: Uint32Array, idsA: Uint32Array, codesB: Uint32Array, idsB: Uint32Array,
  off: number, n: number, hist: Uint32Array,
): void {
  const bits = n >= 4096 ? 10 : 6;          // 3 or 5 passes — both odd
  const passes = 30 / bits;
  const buckets = 1 << bits;
  const mask = buckets - 1;
  let sc = codesA, si = idsA, dc = codesB, di = idsB;
  const end = off + n;
  for (let p = 0; p < passes; p++) {
    const shift = p * bits;
    hist.fill(0, 0, buckets);
    for (let i = off; i < end; i++) hist[(sc[i] >>> shift) & mask]++;
    let sum = 0;
    for (let b = 0; b < buckets; b++) { const c = hist[b]; hist[b] = sum; sum += c; }
    for (let i = off; i < end; i++) {
      const code = sc[i];
      const d = off + hist[(code >>> shift) & mask]++;
      dc[d] = code; di[d] = si[i];
    }
    const tc = sc; sc = dc; dc = tc;
    const ti = si; si = di; di = ti;
  }
}

export function buildPickStructure(
  position: Float32Array, index: Uint32Array, segments: SegmentIn[], opts: BuildOpts = {},
): PickStructure {
  const C = opts.clusterTris ?? CLUSTER_TRIS;
  const skipSmall = opts.skipSortSmall ?? true;
  const phasesMode = (opts.order ?? 'phases') === 'phases';
  const tStart = performance.now();

  const nSeg = segments.length;
  const segIndexStart = new Uint32Array(nSeg);
  const segIndexCount = new Uint32Array(nSeg);
  const segBox = new Float32Array(nSeg * 6);
  const segFirstCluster = new Uint32Array(nSeg + 1);
  let nC = 0, maxSegTris = 0, maxSortTris = 0, sortedSegments = 0;
  for (let s = 0; s < nSeg; s++) {
    const seg = segments[s];
    segIndexStart[s] = seg.indexStart; segIndexCount[s] = seg.indexCount;
    const n = seg.indexCount / 3;
    segFirstCluster[s] = nC;
    nC += Math.ceil(n / C);
    if (n > maxSegTris) maxSegTris = n;
    if (!(skipSmall && n <= C)) { sortedSegments++; if (n > maxSortTris) maxSortTris = n; }
  }
  segFirstCluster[nSeg] = nC;
  const clusterBox = new Float32Array(nC * 6);
  const clusterSeg = new Uint32Array(nC);

  // transient
  const triCount = index.length / 3;
  const keyLen = phasesMode ? triCount : maxSortTris;
  const codesA = new Uint32Array(keyLen), codesB = new Uint32Array(keyLen);
  const idsA = new Uint32Array(keyLen), idsB = new Uint32Array(keyLen);
  const scratch = new Uint32Array(maxSortTris * 3);
  const hist = new Uint32Array(1024);
  const transientBytes = keyLen * 16 + scratch.byteLength + hist.byteLength;
  const tAlloc = performance.now();

  const needsSort = (s: number): boolean => !(skipSmall && segIndexCount[s] / 3 <= C);

  const phaseBox = (s: number): void => {
    const start = segIndexStart[s], end = start + segIndexCount[s];
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = start; i < end; i++) {
      const v = index[i] * 3;
      const x = position[v], y = position[v + 1], z = position[v + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const o = s * 6;
    segBox[o] = x0; segBox[o + 1] = y0; segBox[o + 2] = z0; segBox[o + 3] = x1; segBox[o + 4] = y1; segBox[o + 5] = z1;
  };

  const phaseMorton = (s: number): void => {
    if (!needsSort(s)) return;
    const start = segIndexStart[s], n = segIndexCount[s] / 3;
    const off = phasesMode ? start / 3 : 0;
    const o = s * 6;
    const x0 = segBox[o], y0 = segBox[o + 1], z0 = segBox[o + 2];
    const ex = segBox[o + 3] - x0, ey = segBox[o + 4] - y0, ez = segBox[o + 5] - z0;
    const sx = ex > 0 ? 1024 / (3 * ex) : 0, sy = ey > 0 ? 1024 / (3 * ey) : 0, sz = ez > 0 ? 1024 / (3 * ez) : 0;
    const x03 = 3 * x0, y03 = 3 * y0, z03 = 3 * z0;
    for (let t = 0; t < n; t++) {
      const i = start + 3 * t;
      const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
      let qx = ((position[a] + position[b] + position[c] - x03) * sx) | 0;
      let qy = ((position[a + 1] + position[b + 1] + position[c + 1] - y03) * sy) | 0;
      let qz = ((position[a + 2] + position[b + 2] + position[c + 2] - z03) * sz) | 0;
      if (qx > 1023) qx = 1023; else if (qx < 0) qx = 0;
      if (qy > 1023) qy = 1023; else if (qy < 0) qy = 0;
      if (qz > 1023) qz = 1023; else if (qz < 0) qz = 0;
      codesA[off + t] = expand10(qx) | (expand10(qy) << 1) | (expand10(qz) << 2);
      idsA[off + t] = t;
    }
  };

  const phaseSort = (s: number): void => {
    if (!needsSort(s)) return;
    const n = segIndexCount[s] / 3;
    radixSort(codesA, idsA, codesB, idsB, phasesMode ? segIndexStart[s] / 3 : 0, n, hist);
  };

  const phasePermute = (s: number): void => {
    if (!needsSort(s)) return;
    const start = segIndexStart[s], cnt = segIndexCount[s], n = cnt / 3;
    const off = phasesMode ? start / 3 : 0;
    scratch.set(index.subarray(start, start + cnt));
    for (let t = 0; t < n; t++) {
      const src = idsB[off + t] * 3, dst = start + 3 * t;
      index[dst] = scratch[src]; index[dst + 1] = scratch[src + 1]; index[dst + 2] = scratch[src + 2];
    }
  };

  const phaseCluster = (s: number): void => {
    const start = segIndexStart[s], end = start + segIndexCount[s];
    let c = segFirstCluster[s];
    for (let cs = start; cs < end; cs += 3 * C, c++) {
      const ce = cs + 3 * C < end ? cs + 3 * C : end;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = cs; i < ce; i++) {
        const v = index[i] * 3;
        const x = position[v], y = position[v + 1], z = position[v + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const o = c * 6;
      clusterBox[o] = x0; clusterBox[o + 1] = y0; clusterBox[o + 2] = z0;
      clusterBox[o + 3] = x1; clusterBox[o + 4] = y1; clusterBox[o + 5] = z1;
      clusterSeg[c] = s;
    }
  };

  const tm: BuildTimings = {
    alloc: tAlloc - tStart, boxes: 0, morton: 0, sort: 0, permute: 0, clusters: 0, total: 0,
    maxSegmentMs: 0, maxSegmentTris: maxSegTris, sortedSegments, transientBytes,
  };
  if (phasesMode) {
    let t = performance.now(), u = t;
    for (let s = 0; s < nSeg; s++) phaseBox(s);
    u = performance.now(); tm.boxes = u - t; t = u;
    for (let s = 0; s < nSeg; s++) phaseMorton(s);
    u = performance.now(); tm.morton = u - t; t = u;
    for (let s = 0; s < nSeg; s++) phaseSort(s);
    u = performance.now(); tm.sort = u - t; t = u;
    for (let s = 0; s < nSeg; s++) phasePermute(s);
    u = performance.now(); tm.permute = u - t; t = u;
    for (let s = 0; s < nSeg; s++) phaseCluster(s);
    u = performance.now(); tm.clusters = u - t;
  } else {
    for (let s = 0; s < nSeg; s++) {
      const t = performance.now();
      phaseBox(s); phaseMorton(s); phaseSort(s); phasePermute(s); phaseCluster(s);
      const dt = performance.now() - t;
      if (dt > tm.maxSegmentMs) tm.maxSegmentMs = dt;
    }
  }
  tm.total = performance.now() - tStart;

  const bytes = segIndexStart.byteLength + segIndexCount.byteLength + segBox.byteLength +
    segFirstCluster.byteLength + clusterBox.byteLength + clusterSeg.byteLength;
  return {
    clusterTris: C, triCount, segCount: nSeg, clusterCount: nC, index,
    segIndexStart, segIndexCount, segBox, segFirstCluster, clusterBox, clusterSeg, bytes, timings: tm,
  };
}

// ─── Trees over cluster boxes ────────────────────────────────────────────

function unionInto(dst: Float32Array, d: number, src: Float32Array, s: number): void {
  if (src[s] < dst[d]) dst[d] = src[s];
  if (src[s + 1] < dst[d + 1]) dst[d + 1] = src[s + 1];
  if (src[s + 2] < dst[d + 2]) dst[d + 2] = src[s + 2];
  if (src[s + 3] > dst[d + 3]) dst[d + 3] = src[s + 3];
  if (src[s + 4] > dst[d + 4]) dst[d + 4] = src[s + 4];
  if (src[s + 5] > dst[d + 5]) dst[d + 5] = src[s + 5];
}
function emptyBox(dst: Float32Array, d: number): void {
  dst[d] = dst[d + 1] = dst[d + 2] = Infinity; dst[d + 3] = dst[d + 4] = dst[d + 5] = -Infinity;
}

/** Bottom-up binary tree: leaves = runs of `leafClusters` consecutive positions of `order`, adjacent pairs joined. */
function bottomUp(ps: PickStructure, order: Uint32Array | null, leafClusters: number, kind: string, t0: number): PickTree {
  const nC = ps.clusterCount;
  const nLeaves = Math.max(1, Math.ceil(nC / leafClusters));
  const box = new Float32Array(2 * nLeaves * 6);
  const link = new Uint32Array(2 * nLeaves * 2);
  let n = 0;
  let cur = new Uint32Array(nLeaves);
  for (let l = 0; l < nLeaves; l++) {
    const first = l * leafClusters, cnt = Math.min(leafClusters, nC - first);
    emptyBox(box, n * 6);
    for (let p = first; p < first + cnt; p++) unionInto(box, n * 6, ps.clusterBox, (order ? order[p] : p) * 6);
    link[2 * n] = (LEAF_FLAG | first) >>> 0; link[2 * n + 1] = cnt;
    cur[l] = n++;
  }
  let len = nLeaves, depth = 1;
  while (len > 1) {
    const nextLen = (len + 1) >> 1;
    const next = new Uint32Array(nextLen);
    for (let k = 0; k < nextLen; k++) {
      const a = cur[2 * k];
      if (2 * k + 1 >= len) { next[k] = a; continue; }   // odd one out is carried up
      const b = cur[2 * k + 1];
      emptyBox(box, n * 6);
      unionInto(box, n * 6, box, a * 6); unionInto(box, n * 6, box, b * 6);
      link[2 * n] = a; link[2 * n + 1] = b;
      next[k] = n++;
    }
    cur = next; len = nextLen; depth++;
  }
  const usedBox = box.slice(0, n * 6), usedLink = link.slice(0, n * 2);
  return {
    kind, leafClusters, nodeCount: n, root: cur[0], box: usedBox, link: usedLink, order,
    bytes: usedBox.byteLength + usedLink.byteLength + (order ? order.byteLength : 0),
    buildMs: performance.now() - t0, maxDepth: depth,
  };
}

/** Tree A — as written in the plan: bottom-up over the (segment, Morton) cluster order. */
export function buildTreeBottomUp(ps: PickStructure, leafClusters = 1): PickTree {
  return bottomUp(ps, null, leafClusters, 'A:bottom-up/cluster-order', performance.now());
}

/** Tree B — bottom-up over clusters re-sorted by the Morton code of their box centre (global box). */
export function buildTreeMorton(ps: PickStructure, leafClusters = 1): PickTree {
  const t0 = performance.now();
  const nC = ps.clusterCount, cb = ps.clusterBox;
  const g = new Float32Array(6); emptyBox(g, 0);
  for (let c = 0; c < nC; c++) unionInto(g, 0, cb, c * 6);
  const sx = g[3] > g[0] ? 1024 / (2 * (g[3] - g[0])) : 0, sy = g[4] > g[1] ? 1024 / (2 * (g[4] - g[1])) : 0,
    sz = g[5] > g[2] ? 1024 / (2 * (g[5] - g[2])) : 0;
  const cA = new Uint32Array(nC), cB = new Uint32Array(nC), iA = new Uint32Array(nC), iB = new Uint32Array(nC);
  for (let c = 0; c < nC; c++) {
    const o = c * 6;
    let qx = ((cb[o] + cb[o + 3] - 2 * g[0]) * sx) | 0, qy = ((cb[o + 1] + cb[o + 4] - 2 * g[1]) * sy) | 0,
      qz = ((cb[o + 2] + cb[o + 5] - 2 * g[2]) * sz) | 0;
    if (qx > 1023) qx = 1023; if (qy > 1023) qy = 1023; if (qz > 1023) qz = 1023;
    cA[c] = expand10(qx) | (expand10(qy) << 1) | (expand10(qz) << 2); iA[c] = c;
  }
  radixSort(cA, iA, cB, iB, 0, nC, new Uint32Array(1024));
  return bottomUp(ps, iB, leafClusters, 'B:bottom-up/cluster-morton', t0);
}

/** Tree C — top-down binned SAH (16 bins) over cluster boxes. */
export function buildTreeSAH(ps: PickStructure, leafClusters = 1): PickTree {
  const t0 = performance.now();
  const nC = ps.clusterCount, cb = ps.clusterBox;
  const order = new Uint32Array(nC);
  for (let c = 0; c < nC; c++) order[c] = c;
  const cen = new Float32Array(nC * 3);
  for (let c = 0; c < nC; c++) {
    cen[3 * c] = 0.5 * (cb[6 * c] + cb[6 * c + 3]); cen[3 * c + 1] = 0.5 * (cb[6 * c + 1] + cb[6 * c + 4]);
    cen[3 * c + 2] = 0.5 * (cb[6 * c + 2] + cb[6 * c + 5]);
  }
  const maxNodes = Math.max(1, 2 * nC);
  const box = new Float32Array(maxNodes * 6), link = new Uint32Array(maxNodes * 2);
  const BINS = 16;
  const binBox = new Float32Array(BINS * 6), binCnt = new Uint32Array(BINS);
  const rightArea = new Float64Array(BINS), rightCnt = new Uint32Array(BINS);
  const acc = new Float32Array(6);
  const area = (b: Float32Array, o: number): number => {
    const x = b[o + 3] - b[o], y = b[o + 4] - b[o + 1], z = b[o + 5] - b[o + 2];
    return x < 0 ? 0 : 2 * (x * y + y * z + z * x);
  };
  const stN: number[] = [0], stS: number[] = [0], stC: number[] = [nC], stD: number[] = [1];
  let n = 1, maxDepth = 1;
  while (stN.length) {
    const node = stN.pop()!, start = stS.pop()!, cnt = stC.pop()!, depth = stD.pop()!;
    if (depth > maxDepth) maxDepth = depth;
    emptyBox(box, node * 6);
    let c0x = Infinity, c0y = Infinity, c0z = Infinity, c1x = -Infinity, c1y = -Infinity, c1z = -Infinity;
    for (let p = start; p < start + cnt; p++) {
      const c = order[p];
      unionInto(box, node * 6, cb, c * 6);
      const x = cen[3 * c], y = cen[3 * c + 1], z = cen[3 * c + 2];
      if (x < c0x) c0x = x; if (x > c1x) c1x = x; if (y < c0y) c0y = y; if (y > c1y) c1y = y;
      if (z < c0z) c0z = z; if (z > c1z) c1z = z;
    }
    if (cnt <= leafClusters) { link[2 * node] = (LEAF_FLAG | start) >>> 0; link[2 * node + 1] = cnt; continue; }
    let bestCost = Infinity, bestAxis = -1, bestBin = -1, bestMin = 0, bestScale = 0;
    for (let axis = 0; axis < 3; axis++) {
      const lo = axis === 0 ? c0x : axis === 1 ? c0y : c0z, hi = axis === 0 ? c1x : axis === 1 ? c1y : c1z;
      if (!(hi > lo)) continue;
      const scale = BINS / (hi - lo);
      for (let b = 0; b < BINS; b++) { emptyBox(binBox, b * 6); binCnt[b] = 0; }
      for (let p = start; p < start + cnt; p++) {
        const c = order[p];
        let b = ((cen[3 * c + axis] - lo) * scale) | 0; if (b >= BINS) b = BINS - 1;
        binCnt[b]++; unionInto(binBox, b * 6, cb, c * 6);
      }
      emptyBox(acc, 0); let rc = 0;
      for (let b = BINS - 1; b > 0; b--) { unionInto(acc, 0, binBox, b * 6); rc += binCnt[b]; rightArea[b] = area(acc, 0); rightCnt[b] = rc; }
      emptyBox(acc, 0); let lc = 0;
      for (let b = 0; b < BINS - 1; b++) {
        unionInto(acc, 0, binBox, b * 6); lc += binCnt[b];
        if (lc === 0 || rightCnt[b + 1] === 0) continue;
        const cost = lc * area(acc, 0) + rightCnt[b + 1] * rightArea[b + 1];
        if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestBin = b; bestMin = lo; bestScale = scale; }
      }
    }
    let mid: number;
    if (bestAxis < 0) mid = start + (cnt >> 1);
    else {
      let i = start, j = start + cnt - 1;
      while (i <= j) {
        let b = ((cen[3 * order[i] + bestAxis] - bestMin) * bestScale) | 0; if (b >= BINS) b = BINS - 1;
        if (b <= bestBin) i++; else { const t = order[i]; order[i] = order[j]; order[j] = t; j--; }
      }
      mid = i;
      if (mid === start || mid === start + cnt) mid = start + (cnt >> 1);
    }
    const l = n++, r = n++;
    link[2 * node] = l; link[2 * node + 1] = r;
    stN.push(r); stS.push(mid); stC.push(start + cnt - mid); stD.push(depth + 1);
    stN.push(l); stS.push(start); stC.push(mid - start); stD.push(depth + 1);
  }
  const usedBox = box.slice(0, n * 6), usedLink = link.slice(0, n * 2);
  return {
    kind: 'C:top-down/binned-SAH', leafClusters, nodeCount: n, root: 0, box: usedBox, link: usedLink, order,
    bytes: usedBox.byteLength + usedLink.byteLength + order.byteLength,
    buildMs: performance.now() - t0, maxDepth,
  };
}

// ─── Ray state (module level, no allocation per ray) ─────────────────────

export const rayStats = { tris: 0, boxes: 0, maxStack: 0 };
export interface PickHit { distance: number; triangle: number; segment: number }
const hitOut: PickHit = { distance: 0, triangle: 0, segment: 0 };

const STACK = 1024;
const stackNode = new Uint32Array(STACK);
const stackT = new Float64Array(STACK);

let rox = 0, roy = 0, roz = 0, ridx = 0, ridy = 0, ridz = 0;
let nX = 0, nY = 1, nZ = 2, fX = 3, fY = 4, fZ = 5;          // near / far plane offsets inside a 6-float box
let kx = 0, ky = 1, kz = 2, okx = 0, oky = 0, okz = 0, Sx = 0, Sy = 0, Sz = 0;

function setupRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
  rox = ox; roy = oy; roz = oz;
  ridx = 1 / dx; ridy = 1 / dy; ridz = 1 / dz;
  // sign of the INVERSE, so that -0 selects the max plane as "near" (keeps NaN out of the wrong slot)
  if (ridx < 0) { nX = 3; fX = 0; } else { nX = 0; fX = 3; }
  if (ridy < 0) { nY = 4; fY = 1; } else { nY = 1; fY = 4; }
  if (ridz < 0) { nZ = 5; fZ = 2; } else { nZ = 2; fZ = 5; }
  // Woop et al. 2013: dominant axis → kz, preserve winding
  const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
  kz = ax > ay ? (ax > az ? 0 : 2) : (ay > az ? 1 : 2);
  kx = kz === 2 ? 0 : kz + 1; ky = kx === 2 ? 0 : kx + 1;
  const d = [dx, dy, dz], o = [ox, oy, oz];
  if (d[kz] < 0) { const t = kx; kx = ky; ky = t; }
  Sx = d[kx] / d[kz]; Sy = d[ky] / d[kz]; Sz = 1 / d[kz];
  okx = o[kx]; oky = o[ky]; okz = o[kz];
}

/**
 * NaN-safe slab test (Tavian Barnes part 2 idea). JS `Math.min/max` PROPAGATE NaN (unlike minps/maxps),
 * so the published form does not carry over; the comparison form below drops a NaN (0·∞) because every
 * comparison with NaN is false. Returns the entry distance, or Infinity on a miss.
 */
function slab(b: Float32Array, o: number, best: number): number {
  let tmin = 0, tmax = best;
  let tn = (b[o + nX] - rox) * ridx, tf = (b[o + fX] - rox) * ridx;
  if (tn > tmin) tmin = tn; if (tf < tmax) tmax = tf;
  tn = (b[o + nY] - roy) * ridy; tf = (b[o + fY] - roy) * ridy;
  if (tn > tmin) tmin = tn; if (tf < tmax) tmax = tf;
  tn = (b[o + nZ] - roz) * ridz; tf = (b[o + fZ] - roz) * ridz;
  if (tn > tmin) tmin = tn; if (tf < tmax) tmax = tf;
  return tmin <= tmax ? tmin : Infinity;
}

/** Watertight ray/triangle (Woop, Benthin, Wald 2013), double-sided. All arithmetic is float64 already. */
function triT(pos: Float32Array, a: number, b: number, c: number): number {
  const Az = pos[a + kz] - okz, Bz = pos[b + kz] - okz, Cz = pos[c + kz] - okz;
  const Ax = pos[a + kx] - okx - Sx * Az, Ay = pos[a + ky] - oky - Sy * Az;
  const Bx = pos[b + kx] - okx - Sx * Bz, By = pos[b + ky] - oky - Sy * Bz;
  const Cx = pos[c + kx] - okx - Sx * Cz, Cy = pos[c + ky] - oky - Sy * Cz;
  const U = Cx * By - Cy * Bx, V = Ax * Cy - Ay * Cx, W = Bx * Ay - By * Ax;
  if ((U < 0 || V < 0 || W < 0) && (U > 0 || V > 0 || W > 0)) return Infinity;
  const det = U + V + W;
  if (det === 0) return Infinity;
  const t = ((U * Az + V * Bz + W * Cz) * Sz) / det;
  return t > 0 ? t : Infinity;
}

export function raycastNearest(
  ps: PickStructure, tree: PickTree, position: Float32Array,
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, count: boolean,
): PickHit | null {
  setupRay(ox, oy, oz, dx, dy, dz);
  const tb = tree.box, tl = tree.link, order = tree.order, cb = ps.clusterBox, cseg = ps.clusterSeg;
  const sfc = ps.segFirstCluster, sis = ps.segIndexStart, sic = ps.segIndexCount, C = ps.clusterTris, index = ps.index;
  let best = Infinity, bestTri = -1, bestSeg = -1, boxes = 0, tris = 0, maxSp = 0;
  if (ps.clusterCount === 0) return null;
  const tRoot = slab(tb, tree.root * 6, best); boxes++;
  let sp = 0;
  if (tRoot !== Infinity) { stackNode[0] = tree.root; stackT[0] = tRoot; sp = 1; }
  while (sp > 0) {
    sp--;
    if (stackT[sp] >= best) continue;
    const node = stackNode[sp];
    const l0 = tl[2 * node];
    if (l0 >= LEAF_FLAG) {
      const first = l0 & 0x7fffffff, cnt = tl[2 * node + 1];
      for (let p = first; p < first + cnt; p++) {
        const c = order !== null ? order[p] : p;
        if (cnt > 1) { boxes++; if (!(slab(cb, c * 6, best) < best)) continue; }
        const s = cseg[c];
        const i0 = sis[s] + (c - sfc[s]) * C * 3;
        const segEnd = sis[s] + sic[s];
        const i1 = i0 + C * 3 < segEnd ? i0 + C * 3 : segEnd;
        tris += (i1 - i0) / 3;
        for (let i = i0; i < i1; i += 3) {
          const t = triT(position, index[i] * 3, index[i + 1] * 3, index[i + 2] * 3);
          if (t < best) { best = t; bestTri = i / 3; bestSeg = s; }
        }
      }
    } else {
      const r0 = tl[2 * node + 1];
      const ta = slab(tb, l0 * 6, best), tc = slab(tb, r0 * 6, best); boxes += 2;
      if (ta < tc) {
        if (tc < best) { stackNode[sp] = r0; stackT[sp++] = tc; }
        if (ta < best) { stackNode[sp] = l0; stackT[sp++] = ta; }
      } else {
        if (ta < best) { stackNode[sp] = l0; stackT[sp++] = ta; }
        if (tc < best) { stackNode[sp] = r0; stackT[sp++] = tc; }
      }
      if (sp > maxSp) maxSp = sp;
    }
  }
  if (count) { rayStats.tris += tris; rayStats.boxes += boxes; if (maxSp > rayStats.maxStack) rayStats.maxStack = maxSp; }
  if (bestTri < 0) return null;
  hitOut.distance = best; hitOut.triangle = bestTri; hitOut.segment = bestSeg;
  return hitOut;
}

/** Brute force over every triangle with the SAME watertight test — traversal oracle. */
export function bruteNearest(
  position: Float32Array, index: Uint32Array, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
): { distance: number; triangle: number } {
  setupRay(ox, oy, oz, dx, dy, dz);
  let best = Infinity, tri = -1;
  for (let i = 0; i < index.length; i += 3) {
    const t = triT(position, index[i] * 3, index[i + 1] * 3, index[i + 2] * 3);
    if (t < best) { best = t; tri = i / 3; }
  }
  return { distance: best, triangle: tri };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mesh-gap — mesh-exact minimum distance between the geometry of two nodes
 * (plan-641 M7). Loaded lazily by `rv-mcp-check-tools.ts`.
 *
 * Targets:
 *  - **editor tree** (authoring load, never baked): the node's own mesh and its
 *    mesh descendants, `isPickableMesh` (the ONE mesh filter, rv-pick-utils);
 *    an `InstancedMesh` contributes every instance;
 *  - **runtime tree** (baked): the chunk geometry of the node's subtree through
 *    `BakeRegistry.chunkTargetsOf` (registered nodes by their segment interval,
 *    partition objects and movers by whole chunks) plus the keep meshes below it.
 *  Anything else → `unsupported-target`.
 *
 * Contract of the render/pick pipeline (contract-bake-picking.md § 1.5 contract 3):
 * the chunk index is DATA — this module only READS it. The triangles of both
 * targets are copied into two fresh, private world-space geometries; the
 * three-mesh-bvh trees are built on THOSE copies and dropped afterwards. No
 * `boundsTree` is ever written on a scene geometry.
 *
 * Result in millimetres (world): `gapMm`, `contact` (gap ≤ tolerance),
 * `overlap` (the surfaces intersect — a penetration depth is not estimable, so
 * `gapMm` is 0) and `contained` (one target lies completely inside the other's
 * closed surface, by ray parity — also `gapMm` 0, `overlap` true).
 */

import { BufferAttribute, BufferGeometry, DoubleSide, Matrix4, Ray, Vector3 } from 'three';
import type { InstancedMesh, Mesh, Object3D } from 'three';
import { ExtendedTriangle, MeshBVH } from 'three-mesh-bvh';
import { isPickableMesh } from '../../core/engine/rv-pick-utils';
import type { ChunkHighlightTarget } from '../../core/engine/rv-bake-registry';

/**
 * Triangle budget of one check (both targets together). Measured 2026-10-20 on
 * the dev PC (i5-9600K, `tests/rv-mesh-gap.node.test.ts`): 199 704 triangles
 * (two separated spheres) 234 ms, 198 916 triangles (two dense parallel plates
 * 0.05 mm apart, the weak-pruning worst case) 202 ms — copy + BVH builds +
 * intersection + parity + dual-tree distance. Kept at the plan's 200 000 so a
 * check stays well inside the CONNECT call timeout on slower machines; larger
 * targets → `too-complex` (measure a smaller node).
 */
export const GAP_TRIANGLE_BUDGET = 200_000;
/** Default contact tolerance in millimetres. */
export const DEFAULT_TOLERANCE_MM = 0.1;

export type GapErrorCode = 'unsupported-target' | 'too-complex' | 'geometry-busy';

export class GapError extends Error {
  constructor(readonly code: GapErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GapError';
  }
}

/** The bake registry surface this module reads. */
export interface GapChunkSource {
  chunkTargetsOf(node: Object3D): ChunkHighlightTarget[] | null;
  placementOf(node: Object3D): Object3D | null;
}

export type GapTree = 'editor' | 'runtime';

/** One triangle run of one mesh (index units; `instance` set for an InstancedMesh). */
interface Source {
  readonly mesh: Mesh;
  readonly start: number;
  readonly count: number;
  readonly instance?: number;
}

/** The geometry of one target, not yet in world space. */
export interface GapTarget {
  readonly node: Object3D;
  readonly tree: GapTree;
  readonly sources: readonly Source[];
  readonly triangles: number;
}

function elementCount(geom: BufferGeometry): number {
  return geom.index ? geom.index.count : (geom.getAttribute('position')?.count ?? 0);
}

function wholeRange(mesh: Mesh): { start: number; count: number } {
  const geom = mesh.geometry as BufferGeometry;
  const total = elementCount(geom);
  const start = Math.max(0, geom.drawRange.start);
  const count = Math.min(total - start, Number.isFinite(geom.drawRange.count) ? geom.drawRange.count : total);
  return { start, count: Math.max(0, count - (count % 3)) };
}

function pushMesh(out: Source[], mesh: Mesh): void {
  const { start, count } = wholeRange(mesh);
  if (count <= 0) return;
  const inst = mesh as unknown as InstancedMesh;
  if (inst.isInstancedMesh) {
    for (let i = 0; i < inst.count; i++) out.push({ mesh, start, count, instance: i });
  } else {
    out.push({ mesh, start, count });
  }
}

/** Mesh descendants (self included) that are real geometry — chunk meshes excluded by the filter. */
function ownMeshes(node: Object3D): Mesh[] {
  const out: Mesh[] = [];
  node.traverse((o) => {
    const m = o as Mesh;
    if (m.isMesh && isPickableMesh(m)) out.push(m);
  });
  return out;
}

/**
 * Collect the geometry of `node` (M7). `chunks` is the viewer's bake registry
 * (null in a context that never bakes). Throws `unsupported-target`.
 */
export function collectGapTarget(node: Object3D, chunks: GapChunkSource | null): GapTarget {
  const sources: Source[] = [];
  const runtime = !!chunks && chunks.placementOf(node) !== null;
  if (runtime) {
    for (const t of chunks!.chunkTargetsOf(node) ?? []) {
      if (t.range) sources.push({ mesh: t.mesh, start: t.range.indexStart, count: t.range.indexCount });
      else pushMesh(sources, t.mesh);
    }
  }
  // Editor tree: the meshes themselves. Runtime tree: the keep meshes (chunk meshes are filtered out).
  for (const m of ownMeshes(node)) pushMesh(sources, m);
  const triangles = sources.reduce((n, s) => n + s.count / 3, 0);
  if (sources.length === 0 || triangles === 0) {
    throw new GapError('unsupported-target',
      `"${node.name}" carries no measurable geometry (no mesh of its own or below it, and no baked segment)`,
      { node: node.name, tree: runtime ? 'runtime' : 'editor' });
  }
  return { node, tree: runtime ? 'runtime' : 'editor', sources, triangles };
}

const _m = new Matrix4();
const _im = new Matrix4();
const _v = new Vector3();

/** Copy the triangles of `target` into a fresh WORLD-space position array (reads `matrixWorld` as it stands). */
export function worldTriangles(target: GapTarget): Float32Array {
  const out = new Float32Array(target.triangles * 9);
  let o = 0;
  for (const s of target.sources) {
    const geom = s.mesh.geometry as BufferGeometry;
    const pos = geom.getAttribute('position') as BufferAttribute | undefined;
    if (!pos) continue;
    const posArr = (pos as unknown as { array: { buffer?: ArrayBufferLike } }).array;
    const idx = geom.index;
    if (posArr.buffer?.byteLength === 0 || (idx && (idx.array as unknown as { buffer?: ArrayBufferLike }).buffer?.byteLength === 0)) {
      throw new GapError('geometry-busy', `The geometry of "${s.mesh.name}" is being indexed right now — retry in a moment`);
    }
    s.mesh.updateWorldMatrix(true, false);
    _m.copy(s.mesh.matrixWorld);
    if (s.instance !== undefined) {
      (s.mesh as unknown as InstancedMesh).getMatrixAt(s.instance, _im);
      _m.multiply(_im);
    }
    for (let k = s.start; k < s.start + s.count; k++) {
      const vi = idx ? idx.getX(k) : k;
      _v.fromBufferAttribute(pos, vi).applyMatrix4(_m);
      out[o++] = _v.x; out[o++] = _v.y; out[o++] = _v.z;
    }
  }
  return o === out.length ? out : out.subarray(0, o);
}

/** The outcome of one measurement, in millimetres. */
export interface GapResult {
  gapMm: number;
  contact: boolean;
  overlap: boolean;
  contained: boolean;
  /** Which target lies inside the other (only when `contained`). */
  containedIn?: 'a' | 'b';
  toleranceMm: number;
  /** Closest points (world, mm) — absent on overlap. */
  closestA?: [number, number, number];
  closestB?: [number, number, number];
}

function soupGeometry(positions: Float32Array): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  return g;
}

const IDENTITY = new Matrix4();
const PARITY_DIRS = [new Vector3(0.5773, 0.5774, 0.5774), new Vector3(-0.267, 0.534, -0.802), new Vector3(0.123, -0.905, 0.407)];

/** Is `point` inside the closed surface held by `bvh`? Majority of three ray parities. */
function insideByParity(bvh: MeshBVH, point: Vector3): boolean {
  let inside = 0;
  for (const dir of PARITY_DIRS) {
    const hits = bvh.raycast(new Ray(point.clone(), dir.clone().normalize()), DoubleSide);
    if (hits.length % 2 === 1) inside++;
  }
  return inside >= 2;
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const mm3 = (v: Vector3): [number, number, number] => [r3(v.x * 1000), r3(v.y * 1000), r3(v.z * 1000)];

// ─── dual-tree distance ────────────────────────────────────────────────
//
// three-mesh-bvh's `closestPointToGeometry` orders the outer traversal by the
// distance to the OTHER geometry's whole bounding box, which barely prunes:
// measured 2026-10-20, two separated 100k-triangle spheres did not finish in
// 300 s. The query below is a plain branch-and-bound over TWO trees (one per
// target): a node pair is skipped when its box distance is not below the best
// triangle distance found so far, the nearer child pair is visited first, and
// the triangle pair test is three-mesh-bvh's `ExtendedTriangle.distanceToTriangle`.
// Same pair: 234 ms (measured, see GAP_TRIANGLE_BUDGET).

/** Triangles per leaf of the private distance tree. */
const LEAF_TRIS = 8;

interface DistNode {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
  left: DistNode | null;
  right: DistNode | null;
  /** Leaf range into `order`. */
  start: number;
  count: number;
}

interface DistTree {
  readonly root: DistNode;
  /** Triangle indices, grouped per leaf. */
  readonly order: Uint32Array;
  readonly pos: Float32Array;
}

function buildDistTree(pos: Float32Array): DistTree {
  const n = Math.floor(pos.length / 9);
  const cen = new Float32Array(n * 3);
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    cen[t * 3] = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
    cen[t * 3 + 1] = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
    cen[t * 3 + 2] = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
  }
  const order = new Uint32Array(n);
  for (let t = 0; t < n; t++) order[t] = t;

  const build = (start: number, count: number): DistNode => {
    const node: DistNode = {
      minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
      left: null, right: null, start, count,
    };
    let cminX = Infinity, cminY = Infinity, cminZ = Infinity, cmaxX = -Infinity, cmaxY = -Infinity, cmaxZ = -Infinity;
    for (let k = start; k < start + count; k++) {
      const t = order[k];
      const o = t * 9;
      for (let v = 0; v < 9; v += 3) {
        const x = pos[o + v], y = pos[o + v + 1], z = pos[o + v + 2];
        if (x < node.minX) node.minX = x; if (x > node.maxX) node.maxX = x;
        if (y < node.minY) node.minY = y; if (y > node.maxY) node.maxY = y;
        if (z < node.minZ) node.minZ = z; if (z > node.maxZ) node.maxZ = z;
      }
      const cx = cen[t * 3], cy = cen[t * 3 + 1], cz = cen[t * 3 + 2];
      if (cx < cminX) cminX = cx; if (cx > cmaxX) cmaxX = cx;
      if (cy < cminY) cminY = cy; if (cy > cmaxY) cmaxY = cy;
      if (cz < cminZ) cminZ = cz; if (cz > cmaxZ) cmaxZ = cz;
    }
    if (count <= LEAF_TRIS) return node;
    const ex = cmaxX - cminX, ey = cmaxY - cminY, ez = cmaxZ - cminZ;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const mid = axis === 0 ? (cminX + cmaxX) / 2 : axis === 1 ? (cminY + cmaxY) / 2 : (cminZ + cmaxZ) / 2;
    // In-place partition by the centroid midpoint (O(count) per level).
    let i = start;
    let j = start + count - 1;
    while (i <= j) {
      if (cen[order[i] * 3 + axis] < mid) { i++; continue; }
      const tmp = order[i]; order[i] = order[j]; order[j] = tmp; j--;
    }
    let split = i - start;
    if (split === 0 || split === count) split = count >> 1; // all centroids on one side
    node.left = build(start, split);
    node.right = build(start + split, count - split);
    return node;
  };
  return { root: build(0, n), order, pos };
}

function boxDistSq(a: DistNode, b: DistNode): number {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  const dz = Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ);
  return dx * dx + dy * dy + dz * dz;
}

const isLeaf = (n: DistNode): boolean => n.left === null;
const extent = (n: DistNode): number => (n.maxX - n.minX) + (n.maxY - n.minY) + (n.maxZ - n.minZ);

/** Minimum distance between two triangle soups; the closest points go into `pa` / `pb`. */
function treeDistance(ta: DistTree, tb: DistTree, pa: Vector3, pb: Vector3): number {
  const triA = new ExtendedTriangle();
  const triB = new ExtendedTriangle();
  const qa = new Vector3();
  const qb = new Vector3();
  let best = Infinity;
  let bestSq = Infinity;
  const setTri = (tri: ExtendedTriangle, pos: Float32Array, t: number): void => {
    const o = t * 9;
    tri.a.set(pos[o], pos[o + 1], pos[o + 2]);
    tri.b.set(pos[o + 3], pos[o + 4], pos[o + 5]);
    tri.c.set(pos[o + 6], pos[o + 7], pos[o + 8]);
    tri.needsUpdate = true;
  };
  const leafPair = (a: DistNode, b: DistNode): void => {
    for (let i = a.start; i < a.start + a.count; i++) {
      setTri(triA, ta.pos, ta.order[i]);
      for (let k = b.start; k < b.start + b.count; k++) {
        setTri(triB, tb.pos, tb.order[k]);
        const d = (triA as unknown as { distanceToTriangle(o: ExtendedTriangle, t1: Vector3, t2: Vector3): number })
          .distanceToTriangle(triB, qa, qb);
        if (d < best) {
          best = d; bestSq = d * d;
          pa.copy(qa); pb.copy(qb);
        }
      }
    }
  };
  const visit = (a: DistNode, b: DistNode, dSq: number): void => {
    if (dSq >= bestSq || best === 0) return;
    if (isLeaf(a) && isLeaf(b)) { leafPair(a, b); return; }
    // Split the larger node (by box extent), visit the nearer child pair first.
    if (isLeaf(b) || (!isLeaf(a) && extent(a) >= extent(b))) {
      const l = a.left!, r = a.right!;
      const dl = boxDistSq(l, b), dr = boxDistSq(r, b);
      if (dl <= dr) { visit(l, b, dl); visit(r, b, dr); } else { visit(r, b, dr); visit(l, b, dl); }
    } else {
      const l = b.left!, r = b.right!;
      const dl = boxDistSq(a, l), dr = boxDistSq(a, r);
      if (dl <= dr) { visit(a, l, dl); visit(a, r, dr); } else { visit(a, r, dr); visit(a, l, dl); }
    }
  };
  visit(ta.root, tb.root, boxDistSq(ta.root, tb.root));
  return best;
}

/**
 * Minimum distance between two world-space triangle soups (metres in, mm out).
 * Every acceleration structure lives on private copies and is released with them.
 */
export function measureGap(a: Float32Array, b: Float32Array, toleranceMm = DEFAULT_TOLERANCE_MM): GapResult {
  const ga = soupGeometry(a);
  const gb = soupGeometry(b);
  try {
    const bvhA = new MeshBVH(ga);
    const bvhB = new MeshBVH(gb);
    (gb as unknown as { boundsTree?: MeshBVH }).boundsTree = bvhB;
    if (bvhA.intersectsGeometry(gb, IDENTITY)) {
      return { gapMm: 0, contact: true, overlap: true, contained: false, toleranceMm };
    }
    // No surface crossing: one may still lie completely inside the other.
    const pa = new Vector3(a[0], a[1], a[2]);
    const pb = new Vector3(b[0], b[1], b[2]);
    if (insideByParity(bvhA, pb)) return { gapMm: 0, contact: true, overlap: true, contained: true, containedIn: 'b', toleranceMm };
    if (insideByParity(bvhB, pa)) return { gapMm: 0, contact: true, overlap: true, contained: true, containedIn: 'a', toleranceMm };
    // The BVH builds may have re-ordered the soups' triangles — the distance tree reads them as they are now.
    const posA = ga.getAttribute('position').array as Float32Array;
    const posB = gb.getAttribute('position').array as Float32Array;
    const ia = ga.index ? deindex(posA, ga.index.array as ArrayLike<number>) : posA;
    const ib = gb.index ? deindex(posB, gb.index.array as ArrayLike<number>) : posB;
    const ca = new Vector3();
    const cb = new Vector3();
    const distM = treeDistance(buildDistTree(ia), buildDistTree(ib), ca, cb);
    const gapMm = r3(distM * 1000);
    return {
      gapMm,
      contact: gapMm <= toleranceMm,
      overlap: false,
      contained: false,
      toleranceMm,
      ...(Number.isFinite(distM) ? { closestA: mm3(ca), closestB: mm3(cb) } : {}),
    };
  } finally {
    (gb as unknown as { boundsTree?: MeshBVH }).boundsTree = undefined;
    ga.dispose();
    gb.dispose();
  }
}

/** Expand an indexed soup back into one triangle per 9 floats. */
function deindex(pos: Float32Array, index: ArrayLike<number>): Float32Array {
  const out = new Float32Array(index.length * 3);
  for (let k = 0; k < index.length; k++) {
    const v = index[k] * 3;
    out[k * 3] = pos[v]; out[k * 3 + 1] = pos[v + 1]; out[k * 3 + 2] = pos[v + 2];
  }
  return out;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

// Finds closed planar edge loops in a mesh that lie in planes perpendicular to a given axis
// (e.g. bore rims, cylinder end rings, flange edges). Only feature edges qualify: boundary
// edges (one adjacent face), non-manifold edges, or crease edges whose dihedral angle exceeds
// featureAngleDeg — smooth interior edges of flat caps are ignored. Each loop is returned as
// an ordered list of successive points (closed, without the first point repeated at the end).

import { BufferGeometry, Matrix4, Mesh, Vector3 } from 'three';

export interface PlanarLoopOptions {
  /** Max axis-coordinate deviation across a whole loop (geometry units). Default 1e-4. */
  planeTolerance?: number;
  /** Vertex weld quantization for merging duplicated vertices (seams, per-face normals). Default 1e-5. */
  weldTolerance?: number;
  /** Min dihedral angle (deg) for a 2-face edge to count as a feature edge. <= 0 accepts all edges. Default 20. */
  featureAngleDeg?: number;
  /** Loops with fewer points are discarded. Default 3. */
  minLoopPoints?: number;
}

/**
 * Finds closed loops of feature edges lying in planes perpendicular to `axis`.
 * Operates in the geometry's local space; `axis` need not be normalized.
 * Returns one ordered point list per loop.
 */
export function findPlanarLoops(
  geometry: BufferGeometry,
  axis: Vector3,
  options: PlanarLoopOptions = {},
): Vector3[][] {
  const planeTol = options.planeTolerance ?? 1e-4;
  const weldTol = options.weldTolerance ?? 1e-5;
  const featureAngleDeg = options.featureAngleDeg ?? 20;
  const minLoopPoints = Math.max(3, options.minLoopPoints ?? 3);

  const posAttr = geometry.getAttribute('position');
  if (!posAttr || posAttr.count < 3) return [];
  const index = geometry.getIndex();
  const cornerCount = index ? index.count : posAttr.count;
  const triCount = Math.floor(cornerCount / 3);
  if (triCount === 0) return [];

  const axisLen = axis.length();
  if (axisLen < 1e-12) return [];
  const ax = axis.x / axisLen;
  const ay = axis.y / axisLen;
  const az = axis.z / axisLen;

  // --- 1. Weld vertices by quantized position so seam/normal duplicates share one id ---
  const invWeld = 1 / weldTol;
  const weldOf = new Int32Array(posAttr.count);
  const keyToId = new Map<string, number>();
  const vx: number[] = [];
  const vy: number[] = [];
  const vz: number[] = [];
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    const key = `${Math.round(x * invWeld)},${Math.round(y * invWeld)},${Math.round(z * invWeld)}`;
    let id = keyToId.get(key);
    if (id === undefined) {
      id = vx.length;
      keyToId.set(key, id);
      vx.push(x);
      vy.push(y);
      vz.push(z);
    }
    weldOf[i] = id;
  }
  const vertCount = vx.length;

  // Per-vertex coordinate along the axis
  const t = new Float64Array(vertCount);
  for (let i = 0; i < vertCount; i++) t[i] = vx[i] * ax + vy[i] * ay + vz[i] * az;

  // --- 2. Collect edges with face count and dihedral information ---
  // Edge key = min(a,b) * vertCount + max(a,b)
  const edgeFaceCount = new Map<number, number>();
  const edgeNormal = new Map<number, [number, number, number]>(); // first face normal
  const edgeMinDot = new Map<number, number>(); // min dot between face normals across the edge

  const corner = (c: number): number => weldOf[index ? index.getX(c) : c];

  for (let f = 0; f < triCount; f++) {
    const a = corner(f * 3);
    const b = corner(f * 3 + 1);
    const c = corner(f * 3 + 2);
    if (a === b || b === c || a === c) continue; // degenerate after welding

    // Face normal
    const e1x = vx[b] - vx[a], e1y = vy[b] - vy[a], e1z = vz[b] - vz[a];
    const e2x = vx[c] - vx[a], e2y = vy[c] - vy[a], e2z = vz[c] - vz[a];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-14) continue;
    nx /= nl; ny /= nl; nz /= nl;

    for (let e = 0; e < 3; e++) {
      const p = e === 0 ? a : e === 1 ? b : c;
      const q = e === 0 ? b : e === 1 ? c : a;
      const key = (p < q ? p : q) * vertCount + (p < q ? q : p);
      const count = edgeFaceCount.get(key) ?? 0;
      edgeFaceCount.set(key, count + 1);
      if (count === 0) {
        edgeNormal.set(key, [nx, ny, nz]);
      } else {
        const n0 = edgeNormal.get(key)!;
        const dot = n0[0] * nx + n0[1] * ny + n0[2] * nz;
        const prev = edgeMinDot.get(key);
        edgeMinDot.set(key, prev === undefined ? dot : Math.min(prev, dot));
      }
    }
  }

  // --- 3. Qualify edges: perpendicular to axis (both endpoints on the same plane) + feature edge ---
  const cosFeature = Math.cos((featureAngleDeg * Math.PI) / 180);
  const acceptAll = featureAngleDeg <= 0;
  const ea: number[] = [];
  const eb: number[] = [];
  const adj = new Map<number, number[]>(); // welded vertex id -> qualifying edge indices

  for (const [key, faceCount] of edgeFaceCount) {
    const a = Math.floor(key / vertCount);
    const b = key % vertCount;
    if (Math.abs(t[a] - t[b]) > planeTol) continue;
    if (!acceptAll && faceCount === 2) {
      const minDot = edgeMinDot.get(key)!;
      if (minDot > cosFeature) continue; // smooth interior edge
    }
    const edgeIdx = ea.length;
    ea.push(a);
    eb.push(b);
    let la = adj.get(a);
    if (!la) adj.set(a, (la = []));
    la.push(edgeIdx);
    let lb = adj.get(b);
    if (!lb) adj.set(b, (lb = []));
    lb.push(edgeIdx);
  }

  // --- 4. Trace closed loops through degree-2 vertices ---
  const edgeCount = ea.length;
  const used = new Uint8Array(edgeCount);
  const loops: Vector3[][] = [];

  for (let e = 0; e < edgeCount; e++) {
    if (used[e]) continue;
    used[e] = 1;
    const startVert = ea[e];
    const pts: number[] = [startVert];
    let inEdge = e;
    let cur = eb[e];
    let closed = false;

    for (let guard = 0; guard <= edgeCount; guard++) {
      if (cur === startVert) {
        closed = true;
        break;
      }
      pts.push(cur);
      const nb = adj.get(cur)!;
      if (nb.length !== 2) break; // dead end or junction — not a clean loop
      const nextEdge = nb[0] === inEdge ? nb[1] : nb[0];
      if (used[nextEdge]) break;
      used[nextEdge] = 1;
      cur = ea[nextEdge] === cur ? eb[nextEdge] : ea[nextEdge];
      inEdge = nextEdge;
    }

    if (!closed || pts.length < minLoopPoints) continue;

    // Whole-loop flatness check: reject helical chains whose per-edge drift accumulated
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const v of pts) {
      if (t[v] < tMin) tMin = t[v];
      if (t[v] > tMax) tMax = t[v];
    }
    if (tMax - tMin > planeTol) continue;

    loops.push(pts.map((v) => new Vector3(vx[v], vy[v], vz[v])));
  }

  return loops;
}

/**
 * Convenience wrapper: finds planar loops on a mesh with the axis given in world space.
 * Returned points are in world space.
 */
export function findPlanarLoopsInMesh(
  mesh: Mesh,
  worldAxis: Vector3,
  options: PlanarLoopOptions = {},
): Vector3[][] {
  mesh.updateWorldMatrix(true, false);
  // Plane normals transform with the transpose of the world matrix (world -> local)
  const m = mesh.matrixWorld.elements;
  const localAxis = new Vector3(
    m[0] * worldAxis.x + m[1] * worldAxis.y + m[2] * worldAxis.z,
    m[4] * worldAxis.x + m[5] * worldAxis.y + m[6] * worldAxis.z,
    m[8] * worldAxis.x + m[9] * worldAxis.y + m[10] * worldAxis.z,
  );
  const loops = findPlanarLoops(mesh.geometry as BufferGeometry, localAxis, options);
  const world = new Matrix4().copy(mesh.matrixWorld);
  for (const loop of loops) for (const p of loop) p.applyMatrix4(world);
  return loops;
}

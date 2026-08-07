// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-shape-descriptor — PCA-based shape analysis for the MCP observation
 * layer (web_node_shape).
 *
 * Answers the core kinematize question numerically: "which axis is this part
 * organized around?". World-space subtree vertices are sampled, their 3×3
 * covariance is eigen-decomposed (Jacobi rotations — symmetric, tiny, exact
 * enough), and the eigenstructure is classified:
 *
 *   λ1 ≫ λ2 ≈ λ3   → elongated (shaft/cylinder-like), axis = e1
 *   λ1 ≈ λ2 ≫ λ3   → flat (plate/disc-like), normal = e3
 *   λ1 ≈ λ2 ≈ λ3   → compact (block/sphere-like)
 *
 * A radial-uniformity test on the cross-section separates cylinder-like from
 * box-beam-like elongation (and disc-like from rectangular plates).
 *
 * Pure math over number arrays — no viewer, no DOM — fully unit-testable.
 */

import { Vector3 } from 'three';
import type { Object3D } from 'three';
import { traverseMeshes } from '../../core/engine/rv-traverse-utils';

export type ShapeClass =
  | 'cylinder-like'
  | 'beam-like'
  | 'disc-like'
  | 'plate-like'
  | 'compact'
  | 'degenerate';

export interface ShapeDescriptor {
  shapeClass: ShapeClass;
  /** Principal axes as world-space unit vectors, strongest first. */
  axes: [number, number, number][];
  /** Extent (≈ full length) of the point cloud along each principal axis. */
  extents: [number, number, number];
  /** sqrt(λ1/λ2) — how elongated along the primary axis. */
  elongation: number;
  /** sqrt(λ2/λ3) — how flat the cross-section is. */
  flatness: number;
  /** 0..1 — how uniformly round the cross-section is (1 = perfect circle). */
  radialUniformity: number;
  /** The functional axis: primary axis for elongated shapes, the plane
   *  normal for flat shapes, null for compact shapes. */
  functionalAxis: [number, number, number] | null;
  /** Point-cloud centroid (world). */
  centroid: [number, number, number];
  sampleCount: number;
}

/** Jacobi eigen-decomposition of a symmetric 3×3 matrix.
 *  Returns eigenvalues (descending) and matching unit eigenvectors. */
export function eigenSymmetric3(m: number[][]): { values: number[]; vectors: number[][] } {
  const a = m.map((row) => [...row]);
  // v starts as identity; columns become eigenvectors.
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const pairs = [0, 1, 2].map((i) => ({
    value: a[i][i],
    vector: [v[0][i], v[1][i], v[2][i]],
  }));
  pairs.sort((x, y) => y.value - x.value);
  return { values: pairs.map((p) => p.value), vectors: pairs.map((p) => p.vector) };
}

const r3 = (n: number): number => +n.toFixed(3);
const r4 = (n: number): number => +n.toFixed(4);

/**
 * Analyze a world-space point cloud (flat xyz triplets). Thresholds chosen so
 * canonical shapes classify robustly: a 10:1 shaft is 'cylinder-like', a thin
 * disc 'disc-like', a cube 'compact'.
 */
export function analyzeShapePoints(points: Float64Array | number[]): ShapeDescriptor {
  const n = Math.floor(points.length / 3);
  if (n < 8) {
    return {
      shapeClass: 'degenerate', axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      extents: [0, 0, 0], elongation: 1, flatness: 1, radialUniformity: 0,
      functionalAxis: null, centroid: [0, 0, 0], sampleCount: n,
    };
  }
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += points[i * 3]; cy += points[i * 3 + 1]; cz += points[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < n; i++) {
    const dx = points[i * 3] - cx, dy = points[i * 3 + 1] - cy, dz = points[i * 3 + 2] - cz;
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const cov = [[xx / n, xy / n, xz / n], [xy / n, yy / n, yz / n], [xz / n, yz / n, zz / n]];
  const { values, vectors } = eigenSymmetric3(cov);
  const [l1, l2, l3] = values.map((x) => Math.max(x, 1e-12));
  const elongation = Math.sqrt(l1 / l2);
  const flatness = Math.sqrt(l2 / l3);

  // Extents: min/max projection onto each axis.
  const extents: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const [ex, ey, ez] = vectors[a];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = (points[i * 3] - cx) * ex + (points[i * 3 + 1] - cy) * ey + (points[i * 3 + 2] - cz) * ez;
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    extents[a] = r3(hi - lo);
  }

  // Radial uniformity around the primary axis: coefficient of variation of
  // the cross-section radius, folded to 0..1 (1 = circular).
  const [ax, ay, az] = vectors[0];
  let rSum = 0, r2Sum = 0;
  for (let i = 0; i < n; i++) {
    const dx = points[i * 3] - cx, dy = points[i * 3 + 1] - cy, dz = points[i * 3 + 2] - cz;
    const along = dx * ax + dy * ay + dz * az;
    const px = dx - along * ax, py = dy - along * ay, pz = dz - along * az;
    const r = Math.sqrt(px * px + py * py + pz * pz);
    rSum += r; r2Sum += r * r;
  }
  const rMean = rSum / n;
  const rVar = Math.max(0, r2Sum / n - rMean * rMean);
  const cv = rMean > 1e-9 ? Math.sqrt(rVar) / rMean : 1;
  const radialUniformity = Math.max(0, Math.min(1, 1 - cv));

  const ELONGATED = 2.2;
  const FLAT = 2.2;
  let shapeClass: ShapeClass;
  let functionalAxis: [number, number, number] | null;
  if (elongation >= ELONGATED) {
    shapeClass = radialUniformity >= 0.6 ? 'cylinder-like' : 'beam-like';
    functionalAxis = vectors[0].map(r4) as [number, number, number];
  } else if (flatness >= FLAT) {
    shapeClass = radialUniformity >= 0.6 ? 'disc-like' : 'plate-like';
    functionalAxis = vectors[2].map(r4) as [number, number, number];
  } else {
    shapeClass = 'compact';
    functionalAxis = null;
  }

  return {
    shapeClass,
    axes: vectors.map((vv) => vv.map(r4) as [number, number, number]) as [number, number, number][],
    extents,
    elongation: r3(elongation),
    flatness: r3(flatness),
    radialUniformity: r3(radialUniformity),
    functionalAxis,
    centroid: [r3(cx), r3(cy), r3(cz)],
    sampleCount: n,
  };
}

/** Max vertices sampled per analysis — stride-subsampled above this. */
export const SHAPE_SAMPLE_CAP = 20_000;

/** Gather world-space vertex samples from a subtree (stride-capped). */
export function gatherSubtreePoints(root: Object3D, cap = SHAPE_SAMPLE_CAP): Float64Array {
  root.updateMatrixWorld(true);
  let total = 0;
  traverseMeshes(root, (mesh) => {
    const pos = mesh.geometry?.getAttribute('position');
    if (pos) total += pos.count;
  });
  if (total === 0) return new Float64Array(0);
  const stride = Math.max(1, Math.ceil(total / cap));
  const out: number[] = [];
  const v = new Vector3();
  traverseMeshes(root, (mesh) => {
    const pos = mesh.geometry?.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      out.push(v.x, v.y, v.z);
    }
  });
  return Float64Array.from(out);
}

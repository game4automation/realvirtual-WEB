// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Box3, Vector3 } from 'three';

/** A rectangle in page CSS pixels. */
export interface PixelRect { x: number; y: number; w: number; h: number }

/**
 * Largest axis-aligned rectangle inside `area` that overlaps none of the
 * `obstacles` (floating panels). Candidate edges are the area and obstacle
 * edges, so the result is exact for a handful of panels.
 */
export function largestFreeRect(area: PixelRect, obstacles: readonly PixelRect[]): PixelRect {
  const clipped = obstacles
    .map(o => ({
      x0: Math.max(area.x, o.x), y0: Math.max(area.y, o.y),
      x1: Math.min(area.x + area.w, o.x + o.w), y1: Math.min(area.y + area.h, o.y + o.h),
    }))
    .filter(o => o.x1 > o.x0 && o.y1 > o.y0);
  if (clipped.length === 0) return { ...area };
  const xs = [...new Set([area.x, area.x + area.w, ...clipped.flatMap(o => [o.x0, o.x1])])].sort((a, b) => a - b);
  const ys = [...new Set([area.y, area.y + area.h, ...clipped.flatMap(o => [o.y0, o.y1])])].sort((a, b) => a - b);
  let best: PixelRect = { x: area.x, y: area.y, w: 0, h: 0 };
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
    for (let k = 0; k < ys.length; k++) for (let l = k + 1; l < ys.length; l++) {
      const w = xs[j] - xs[i], h = ys[l] - ys[k];
      if (w * h <= best.w * best.h) continue;
      const blocked = clipped.some(o => o.x0 < xs[j] && o.x1 > xs[i] && o.y0 < ys[l] && o.y1 > ys[k]);
      if (!blocked) best = { x: xs[i], y: ys[k], w, h };
    }
  }
  return best;
}

/** The eight corners of a box. */
export function boxCorners(box: Box3): Vector3[] {
  const out: Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    out.push(new Vector3(x, y, z));
  }
  return out;
}

export interface FitPoseInput {
  /** World points whose silhouette is framed — mesh vertices, or box corners as a fallback. */
  points: readonly Vector3[];
  /** Unit vector from the orbit target towards the camera — the kept view direction. */
  viewDir: Vector3;
  up: Vector3;
  /** Vertical field of view in degrees. */
  fovDeg: number;
  /** The canvas in page CSS pixels. */
  canvas: PixelRect;
  /** The region the box is framed into, in page CSS pixels. */
  region: PixelRect;
  /** Projected size relative to the region: 1 = the larger side just fits, > 1 crops the edges. */
  fill: number;
}

/**
 * Camera pose that keeps the view direction and frames `points` into `region`:
 * their projected bounds are centred on the region and the larger relative
 * side spans `fill` × the region. The camera and the orbit target shift
 * together in the view plane, so the projection itself stays untouched.
 */
export function fitPoseInRegion(input: FitPoseInput): { position: Vector3; target: Vector3 } {
  const { canvas, region, fill } = input;
  if (input.points.length === 0) throw new Error('fitPoseInRegion needs at least one point');
  const box = new Box3().setFromPoints(input.points as Vector3[]);
  const center = box.getCenter(new Vector3());
  const back = input.viewDir.clone().normalize();
  const forward = back.clone().negate();
  const right = new Vector3().crossVectors(forward, input.up).normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();
  const tanV = Math.tan((input.fovDeg * Math.PI) / 360);
  const aspect = canvas.w / canvas.h;
  // Project once into the camera basis; the loop then only shifts and scales.
  const n = input.points.length;
  const pr = new Float64Array(n), pu = new Float64Array(n), pb = new Float64Array(n);
  const rel = new Vector3();
  for (let i = 0; i < n; i++) {
    rel.subVectors(input.points[i], center);
    pr[i] = rel.dot(right); pu[i] = rel.dot(up); pb[i] = rel.dot(back);
  }
  const radius = Math.max(box.getSize(new Vector3()).length() / 2, 1e-4);
  const regionCx = region.x + region.w / 2, regionCy = region.y + region.h / 2;

  let dist = radius / Math.sin(Math.atan(tanV));
  let sx = 0, sy = 0;
  for (let iter = 0; iter < 40; iter++) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const rx = pr[i] - sx, ry = pu[i] - sy;
      // Depth along the view axis; a point at or behind the camera would blow up the projection.
      const z = Math.max(dist - pb[i], radius * 0.05);
      const px = canvas.x + ((rx / (z * tanV * aspect)) + 1) / 2 * canvas.w;
      const py = canvas.y + (1 - ry / (z * tanV)) / 2 * canvas.h;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    const scale = Math.max((maxX - minX) / region.w, (maxY - minY) / region.h) / fill;
    const pixelToWorld = (2 * dist * tanV) / canvas.h;
    sx += ((minX + maxX) / 2 - regionCx) * pixelToWorld;
    sy -= ((minY + maxY) / 2 - regionCy) * pixelToWorld;
    if (Math.abs(scale - 1) < 1e-4 && iter > 3) break;
    // Damped: the projected size is not exactly inverse to the distance for a deep box.
    dist = Math.max(dist * Math.pow(scale, 0.8), radius * 0.1);
  }
  const target = center.clone().addScaledVector(right, sx).addScaledVector(up, sy);
  return { position: target.clone().addScaledVector(back, dist), target };
}

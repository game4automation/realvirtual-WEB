// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-frame-fit-math — put a part in the middle of the frame and make it fill it.
 *
 * WHY THIS EXISTS. The agent's framing used to be
 * `fitDistanceBothAxesFor(max(size.x, size.y, size.z), fov, aspect, 1.25)` with
 * the box CENTRE as the look-at target. Measured on a Festo valve terminal, that
 * covered 54 % of the frame width and 71 % of its height and left 280 px of
 * empty frame above the part against 13 px below — and re-focusing changed
 * nothing, because both faults are independent of the viewing angle:
 *
 *  1. The largest WORLD edge is not the on-screen extent. A 119 x 84 x 166 mm
 *     part seen corner-on projects to far less than its longest edge, so the
 *     camera ends up too far back, with a further 25 % margin on top.
 *  2. Aiming at the 3D CENTRE does not centre the PICTURE. Worth stating
 *     plainly because it is counter-intuitive, and because it was tried and
 *     measured: pointing the camera exactly at the box centre does put that
 *     POINT in the middle of the frame, and still left the projected box
 *     centred 142 px BELOW the frame centre — under perspective the near
 *     underside of a box projects much further down than its far top projects
 *     up. "Centre of the bounds" and "looks centred" are different things as
 *     soon as the camera is not orthographic.
 *
 * WHAT IT DOES INSTEAD. Centre what is SEEN: the projected extent. Written in
 * the camera's own basis, "this point stays inside the frame" is a pair of
 * linear inequalities in the camera position, so the closest camera that still
 * holds everything falls out of a few min/max passes — closed form, no search.
 * On the limiting axis that already lands the extent dead centre; the other axis
 * keeps some slack, and the middle of the slack is not the middle of the
 * projection when the extreme points sit at different depths, so that one gets a
 * short bisection.
 *
 * An iterative version (alternate "shift the target" and "scale the distance")
 * came first and DIVERGED — 0.36 -> 1.16 -> 0.50 -> 3.45 of half a frame on a
 * 45-degree slab. The tests measure the resulting framing rather than restating
 * the formula, which is what caught it.
 *
 * WHAT IT STILL DOES NOT DO. It frames the geometry it is given, hidden parts
 * included. On the same terminal the geometry spans 72 % of the frame while the
 * VISIBLE silhouette spans 47 %, because the housing hides most of the rest.
 * Matching what a viewer actually sees needs the rendered mask, not bounds.
 *
 * PURE MODULE. No three.js, no DOM: plain number triples in, plain triples out,
 * testable without a renderer.
 */

export type Vec3 = readonly [number, number, number];

export interface FitPose {
  /** Where the camera goes. */
  eye: [number, number, number];
  /** What it looks at — NOT the bounds centre in general; see the note above. */
  target: [number, number, number];
}

/** Fraction of the limiting axis the content should span. */
export const DEFAULT_FRAME_FILL = 0.9;

const sub = (a: Vec3, b: Vec3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function norm(a: Vec3): [number, number, number] {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

/** The eight corners of an axis-aligned box. */
export function boxCorners(min: Vec3, max: Vec3): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < 8; i++) {
    out.push([i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
  }
  return out;
}

/**
 * Camera basis for a view direction. `forward` is where the camera looks, which
 * is the OPPOSITE of `dir` (which points from the target out towards the eye).
 *
 * The world-up fallback matters: straight down makes the usual
 * `cross(forward, [0,1,0])` degenerate, and the fit would produce NaN.
 */
function basis(dir: Vec3): {
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
} {
  const forward = norm([-dir[0], -dir[1], -dir[2]]);
  const worldUp: Vec3 = Math.abs(forward[1]) > 0.999 ? [0, 0, 1] : [0, 1, 0];
  const right = norm(cross(forward, worldUp));
  const up = cross(right, forward);
  return { forward, right, up };
}

/**
 * Pose that frames the box `[min, max]` from direction `dir`.
 *
 * `dir` points FROM the target TOWARDS the eye and is kept exactly — the fit
 * only changes how far away the camera is and what it aims at, never the angle.
 */
export function fitPoseToBox(
  min: Vec3,
  max: Vec3,
  dir: Vec3,
  fovDeg: number,
  aspect: number,
  fill: number = DEFAULT_FRAME_FILL,
): FitPose {
  return fitPoseToPoints(boxCorners(min, max), dir, fovDeg, aspect, fill);
}

/**
 * Same fit, driven by an arbitrary point cloud.
 *
 * Prefer this wherever the caller can produce the corners of the INDIVIDUAL
 * meshes: it only changes the distance, and a box's corners project further than
 * the material inside it, so per-mesh points frame tighter. It can never frame
 * looser — the box contains the points.
 */
export function fitPoseToPoints(
  points: ReadonlyArray<Vec3>,
  dir: Vec3,
  fovDeg: number,
  aspect: number,
  fill: number = DEFAULT_FRAME_FILL,
): FitPose {
  const d = norm(dir);
  const { forward, right, up } = basis(d);

  const tanHalf = Math.tan(Math.max(1, Math.min(179, fovDeg)) / 2 * Math.PI / 180);
  const asp = aspect > 1e-6 ? aspect : 1;
  const want = Math.max(0.05, Math.min(1, fill));
  // Half-frame width per unit of depth, one per axis.
  const kx = want * tanHalf * asp;
  const ky = want * tanHalf;

  // Coordinates in the camera's own basis, origin still at the world origin.
  // Every bound below is a plain min/max over these, which is why this needs no
  // iteration: the constraints are linear in the camera position.
  let pxMin = Infinity, pxMax = -Infinity;
  let pyMin = Infinity, pyMax = -Infinity;
  let wMin = Infinity, wMax = -Infinity;
  let n = 0;
  for (const p of points) {
    const u = dot(p, right), v = dot(p, up), w = dot(p, forward);
    if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(w)) continue;
    if (u + kx * w < pxMin) pxMin = u + kx * w;
    if (u - kx * w > pxMax) pxMax = u - kx * w;
    if (v + ky * w < pyMin) pyMin = v + ky * w;
    if (v - ky * w > pyMax) pyMax = v - ky * w;
    if (w < wMin) wMin = w;
    if (w > wMax) wMax = w;
    n++;
  }
  if (n === 0) {
    // Nothing to frame — a pose that at least looks somewhere valid.
    return { eye: [d[0], d[1], d[2]], target: [0, 0, 0] };
  }

  // Camera depth along `forward`. Keeping a point in frame reads as
  //   |u - a| <= kx (w - c)   and   |v - b| <= ky (w - c)
  // for a camera at (a, b, c) in this basis; rearranged, each axis caps c, and
  // the tighter cap decides the distance — "whichever axis runs out first".
  const capX = (pxMin - pxMax) / (2 * kx);
  const capY = (pyMin - pyMax) / (2 * ky);
  const span = Math.max(wMax - wMin, 1e-6);
  // Never sit inside the geometry: a degenerate point set collapses both caps
  // onto wMin, and a camera there sees nothing.
  const c = Math.min(capX, capY, wMin - 1e-3 * span - 1e-6);

  // With the depth fixed, each axis still has room to slide. On the LIMITING
  // axis both constraints are tight, so it is already centred and full; on the
  // other the slack has to be spent so the PROJECTED extent is centred, which
  // is not the middle of the slack when the extreme points sit at different
  // depths.
  const a = centreOffset(points, right, forward, c, kx, pxMax + kx * c, pxMin - kx * c);
  const b = centreOffset(points, up, forward, c, ky, pyMax + ky * c, pyMin - ky * c);

  const eye: [number, number, number] = [
    right[0] * a + up[0] * b + forward[0] * c,
    right[1] * a + up[1] * b + forward[1] * c,
    right[2] * a + up[2] * b + forward[2] * c,
  ];
  // Aim at the content's mid-depth on the view axis, so an orbit around the
  // target turns around the part rather than around its front face.
  const ct = (wMin + wMax) / 2;
  const target: [number, number, number] = [
    right[0] * a + up[0] * b + forward[0] * ct,
    right[1] * a + up[1] * b + forward[1] * ct,
    right[2] * a + up[2] * b + forward[2] * ct,
  ];
  return { eye, target };
}

/**
 * Lateral camera offset that centres the projected extent on one axis.
 *
 * The midpoint of the projected min/max shrinks as the offset grows, so it is
 * strictly decreasing and 40 bisection steps put it at machine precision on the
 * interval the fit has already shown to be feasible.
 */
function centreOffset(
  points: ReadonlyArray<Vec3>,
  axis: Vec3,
  forward: Vec3,
  cameraDepth: number,
  slope: number,
  lo: number,
  hi: number,
): number {
  if (!(hi > lo)) return (lo + hi) / 2;
  const midpoint = (offset: number): number => {
    let mn = Infinity, mx = -Infinity;
    for (const p of points) {
      const depth = dot(p, forward) - cameraDepth;
      if (depth <= 1e-9) continue;
      const n = (dot(p, axis) - offset) / (depth * slope);
      if (n < mn) mn = n;
      if (n > mx) mx = n;
    }
    return Number.isFinite(mn) ? (mn + mx) / 2 : 0;
  };
  let a = lo, b = hi;
  for (let i = 0; i < 40; i++) {
    const m = (a + b) / 2;
    if (midpoint(m) > 0) a = m; else b = m;
  }
  return (a + b) / 2;
}

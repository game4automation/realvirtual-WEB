// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The ray basis of the realvirtual sensor model (plan-664 Phase 1).
 *
 * ## Scope
 *
 * PURE and three-free: numbers in, numbers out. It knows fans, boxes, slabs and
 * noise — not the scene, not components, not time. That separation is what lets
 * the same code answer the viewer and (Phase 6) the MJCF export, and it is what
 * makes the unit tests cheap enough to run thousands of fans.
 *
 * `Rangefinder` (one ray) and `LaserScanner` (a fan) are the SAME computation —
 * a rangefinder is a fan of one.
 *
 * ## Conventions
 *
 * - Internally everything is METRES and RADIANS. The rv_extras schema speaks mm
 *   and degrees (parity with `RVSensor.RayCastLength`); the component converts.
 * - No hit is `-1`, never `Infinity` and never `NaN` (MuJoCo / mjlab
 *   convention, `engine_sensor.c`). A hit closer than `rangeMin` is also `-1`:
 *   that is the physical dead zone of a real ToF sensor, not a hit.
 * - Noise is applied AFTER the cast, never inside it (mjlab keeps its
 *   `RayCastSensor` noise-free for the same reason): the geometry stays exact
 *   and reproducible, and the error model can be changed without touching it.
 *
 * ## Allocation
 *
 * Nothing in here allocates in the hot path. The caller owns every buffer; the
 * only arrays created are in {@link buildFan}, which runs once per sensor.
 */

/** Hit classification per ray — parallel to the ranges array. */
export const HIT_NONE = 0;
export const HIT_MU = 1;
export const HIT_AGV = 2;
export const HIT_TARGET = 3;

/** Sentinel for "this ray hit nothing" (MuJoCo convention). */
export const NO_HIT = -1;

/** Number of floats one candidate box occupies in a {@link BoxBuffer}. */
export const BOX_STRIDE = 6;

/**
 * Candidate boxes as a flat `Float32Array`, six floats each
 * (`minX, minY, minZ, maxX, maxY, maxZ`) in the SENSOR's frame, plus one
 * {@link HIT_MU}-style kind per box. Flat rather than an object array because
 * the inner loop runs `rays × boxes` times.
 */
export interface BoxBuffer {
  /** `count * BOX_STRIDE` floats, world-axis-aligned in the sensor frame. */
  bounds: Float32Array;
  /** `count` entries — what a hit on that box means. */
  kinds: Uint8Array;
  /** Boxes actually filled (the arrays may be longer). */
  count: number;
}

/** Noise / dropout / quantisation of one sensor (metres). */
export interface NoiseParams {
  /** Constant σ (m) of the Gaussian distance error. */
  sigma: number;
  /** Additional σ (m) per metre of measured distance. */
  sigmaPerM: number;
  /** Constant dropout probability `[0, 1]` — a dropped ray reads `-1`. */
  dropout: number;
  /** Additional dropout probability per metre of measured distance. */
  dropoutPerM: number;
  /** Quantisation step (m); `0` = off. */
  resolution: number;
  /** Minimum range (m) — a noised value below it drops out, as in the cast. */
  rangeMin: number;
  /** Maximum range (m) — a noised value above it drops out. */
  rangeMax: number;
}

/** A noise model that changes nothing (the default of every new sensor). */
export const NO_NOISE: NoiseParams = {
  sigma: 0, sigmaPerM: 0, dropout: 0, dropoutPerM: 0, resolution: 0, rangeMin: 0, rangeMax: Infinity,
};

/**
 * Ray angles (rad) of a symmetric fan around the local +Z axis, in the local XZ
 * plane, from `-fov/2` to `+fov/2`.
 *
 * The count is `floor(fov / res) + 1`, so a 270° fan at 1° gives 271 rays and
 * both edges are real rays — the same convention a SICK microScan3 datasheet
 * uses. `fov = 0` or `res <= 0` yields the single forward ray of a rangefinder.
 */
export function buildFan(fovDeg: number, resDeg: number): Float32Array {
  if (!(fovDeg > 0) || !(resDeg > 0)) return new Float32Array([0]);
  const n = Math.floor(fovDeg / resDeg) + 1;
  const out = new Float32Array(n);
  const half = (fovDeg * Math.PI) / 360;
  const step = n > 1 ? (2 * half) / (n - 1) : 0;
  for (let i = 0; i < n; i++) out[i] = -half + i * step;
  return out;
}

/**
 * Slab test of one ray against one axis-aligned box, in the sensor frame.
 *
 * Returns the entry distance, or `-1` when the ray misses or the box lies
 * beyond `tMax`. A ray STARTING inside the box returns 0 — a sensor buried in
 * an obstacle reads its dead zone, which `castFan` then maps to `-1`.
 *
 * `idx`/`idy`/`idz` are the RECIPROCAL direction components, `±Infinity` for an
 * axis the ray runs parallel to.
 *
 * ## The parallel axis is a containment test, not a division
 *
 * The textbook form multiplies `(face - origin)` by the reciprocal on every
 * axis. For a parallel axis that reads `(face - origin) * ±∞`, which is the
 * right answer — until the origin lies EXACTLY in one of that axis' two face
 * planes. Then the term is `0 * ∞ = NaN`, every comparison against it is false,
 * and the box is silently rejected.
 *
 * That is not a corner case here: a 2D fan lies in the sensor's XZ plane, so the
 * Y axis is parallel for EVERY ray, and "the origin is exactly in a face plane"
 * is a scanner at floor height against a crate whose box starts at y = 0 — the
 * acceptance scene of this plan. Clamping the reciprocal to a large finite value
 * does not fix it either: the zero term then becomes `0` and the slab degenerates
 * to `[0, +big]` at the near face but `[-big, 0]` at the far one, so a grazing
 * ray would hit through one face and miss through the other.
 *
 * A parallel axis therefore constrains nothing except whether the origin lies
 * inside its slab at all, which is what the branches below ask.
 *
 * This is the GENERAL form, correct for any combination of parallel axes.
 * `castFan` uses it only for the few rays that need it and takes
 * {@link raySlabPlanarY} or the branch-free inline loop otherwise — see its
 * dispatch comment.
 */
export function raySlab(
  ox: number, oy: number, oz: number,
  idx: number, idy: number, idz: number,
  tMax: number,
  b: Float32Array, o: number,
): number {
  // Only `t >= 0` can be a reading, so the interval starts clamped at the
  // origin: a ray that begins inside the box then yields 0, which `castFan`
  // maps onto the dead zone.
  let tmin = 0;
  let tmax = tMax;
  let t0: number;
  let t1: number;

  if (idx === Infinity || idx === -Infinity) {
    if (ox < b[o] || ox > b[o + 3]) return NO_HIT;
  } else {
    t0 = (b[o] - ox) * idx;
    t1 = (b[o + 3] - ox) * idx;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
  }

  if (idy === Infinity || idy === -Infinity) {
    if (oy < b[o + 1] || oy > b[o + 4]) return NO_HIT;
  } else {
    t0 = (b[o + 1] - oy) * idy;
    t1 = (b[o + 4] - oy) * idy;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
  }

  if (idz === Infinity || idz === -Infinity) {
    if (oz < b[o + 2] || oz > b[o + 5]) return NO_HIT;
  } else {
    t0 = (b[o + 2] - oz) * idz;
    t1 = (b[o + 5] - oz) * idz;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    if (t0 > tmin) tmin = t0;
    if (t1 < tmax) tmax = t1;
  }

  return tmin > tmax ? NO_HIT : tmin;
}

/**
 * Slab test of one ray that lies in a HORIZONTAL plane (`dy === 0`) — the case
 * every 2D scanner ray is in.
 *
 * Y is handled as what it is for such a ray, a containment test, so this is not
 * only correct where the general form needed branches: it is also the FASTEST of
 * the three, because one range check replaces two multiplications and four
 * comparisons per candidate box. Measured against the three-axis form on the
 * plan's own scenario (3 × 271 rays, 41 of 200 crates in the fan): 0.19 ms per
 * tick instead of 0.49 ms.
 *
 * `idx` / `idz` must be finite — the caller sends a ray whose `dx` or `dz` is
 * exactly zero to {@link raySlab} instead.
 */
export function raySlabPlanarY(
  ox: number, oy: number, oz: number,
  idx: number, idz: number,
  tMax: number,
  b: Float32Array, o: number,
): number {
  if (oy < b[o + 1] || oy > b[o + 4]) return NO_HIT;
  let t0 = (b[o] - ox) * idx;
  let t1 = (b[o + 3] - ox) * idx;
  let tmin = t0 < t1 ? t0 : t1;
  let tmax = t0 < t1 ? t1 : t0;

  t0 = (b[o + 2] - oz) * idz;
  t1 = (b[o + 5] - oz) * idz;
  const zmin = t0 < t1 ? t0 : t1;
  const zmax = t0 < t1 ? t1 : t0;
  if (zmin > tmin) tmin = zmin;
  if (zmax < tmax) tmax = zmax;

  if (tmax < 0 || tmin > tmax || tmin > tMax) return NO_HIT;
  return tmin < 0 ? 0 : tmin;
}

/**
 * Cast a whole fan against the candidate boxes and write the NEAREST hit per
 * ray into `outRanges` (m, `-1` = no hit) and its kind into `outKinds`.
 *
 * `origin` is the sensor in the frame the boxes are given in; `basis` is the
 * sensor's forward (+Z) and right (+X) axis in that frame, so ray `i` points
 * along `cos(a)·forward + sin(a)·right`. Everything stays in one frame — the
 * caller (`rv-ray-scene-query`) transforms the boxes once per scan rather than
 * transforming every ray.
 *
 * Loop order is rays-outer / boxes-inner: the per-ray direction and its
 * reciprocals are then computed once, and the early `tBest` cut makes a long
 * candidate list cheap as soon as something near is hit.
 *
 * ## Why there are three inner loops
 *
 * Which axes a ray runs PARALLEL to is a property of the ray, not of the box, so
 * it is decided once per ray and never inside the box loop. That is not only
 * tidier, it is where the performance is: a test for it inside the inner loop
 * cost 1.35× (measured), and hoisting it out made the common case 2.5× FASTER
 * than the version that ignored the problem (0.19 ms instead of 0.49 ms per tick
 * for 3 × 271 rays against 41 of 200 crates).
 *
 * - **No axis parallel** — the plain three-axis slab, inlined, no branches.
 * - **Only Y parallel** — {@link raySlabPlanarY}. This is EVERY ray of a
 *   horizontal 2D fan, and the cheapest of the three.
 * - **Anything else** (a ray exactly along ±X or ±Z, a tilted fan whose ray
 *   happens to be axis-aligned) — the general {@link raySlab}.
 */
export function castFan(
  origin: ArrayLike<number>,
  forward: ArrayLike<number>,
  right: ArrayLike<number>,
  angles: Float32Array,
  rangeMin: number,
  rangeMax: number,
  boxes: BoxBuffer,
  outRanges: Float32Array,
  outKinds: Uint8Array,
): void {
  const n = angles.length;
  const ox = origin[0], oy = origin[1], oz = origin[2];
  const fx = forward[0], fy = forward[1], fz = forward[2];
  const rx = right[0], ry = right[1], rz = right[2];
  const b = boxes.bounds;
  const kinds = boxes.kinds;
  const m = boxes.count;
  for (let i = 0; i < n; i++) {
    const a = angles[i];
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const dx = fx * ca + rx * sa;
    const dy = fy * ca + ry * sa;
    const dz = fz * ca + rz * sa;
    // ±Infinity for a parallel axis is the INPUT raySlab expects — it branches
    // on it rather than multiplying by it. Do not "fix" this into a clamp.
    const idx = 1 / dx, idy = 1 / dy, idz = 1 / dz;
    let tBest = rangeMax;
    let kBest = HIT_NONE;
    if (dy === 0) {
      if (dx !== 0 && dz !== 0) {
        for (let j = 0, o = 0; j < m; j++, o += BOX_STRIDE) {
          const t = raySlabPlanarY(ox, oy, oz, idx, idz, tBest, b, o);
          if (t >= 0 && t < tBest) { tBest = t; kBest = kinds[j]; }
        }
      } else {
        for (let j = 0, o = 0; j < m; j++, o += BOX_STRIDE) {
          const t = raySlab(ox, oy, oz, idx, idy, idz, tBest, b, o);
          if (t >= 0 && t < tBest) { tBest = t; kBest = kinds[j]; }
        }
      }
    } else if (dx !== 0 && dz !== 0) {
      // No parallel axis: the textbook slab, no branch on any axis.
      for (let j = 0, o = 0; j < m; j++, o += BOX_STRIDE) {
        let t0 = (b[o] - ox) * idx;
        let t1 = (b[o + 3] - ox) * idx;
        let tmin = t0 < t1 ? t0 : t1;
        let tmax = t0 < t1 ? t1 : t0;
        t0 = (b[o + 1] - oy) * idy;
        t1 = (b[o + 4] - oy) * idy;
        const ymin = t0 < t1 ? t0 : t1;
        const ymax = t0 < t1 ? t1 : t0;
        if (ymin > tmin) tmin = ymin;
        if (ymax < tmax) tmax = ymax;
        t0 = (b[o + 2] - oz) * idz;
        t1 = (b[o + 5] - oz) * idz;
        const zmin = t0 < t1 ? t0 : t1;
        const zmax = t0 < t1 ? t1 : t0;
        if (zmin > tmin) tmin = zmin;
        if (zmax < tmax) tmax = zmax;
        if (tmax < 0 || tmin > tmax || tmin > tBest) continue;
        const t = tmin < 0 ? 0 : tmin;
        if (t < tBest) { tBest = t; kBest = kinds[j]; }
      }
    } else {
      for (let j = 0, o = 0; j < m; j++, o += BOX_STRIDE) {
        const t = raySlab(ox, oy, oz, idx, idy, idz, tBest, b, o);
        if (t >= 0 && t < tBest) { tBest = t; kBest = kinds[j]; }
      }
    }
    // Dead zone: a hit closer than rangeMin is not a reading (ToF physics).
    if (kBest === HIT_NONE || tBest < rangeMin) { outRanges[i] = NO_HIT; outKinds[i] = HIT_NONE; } else { outRanges[i] = tBest; outKinds[i] = kBest; }
  }
}

/**
 * Apply the error model in place: Gaussian distance noise, distance-dependent
 * dropout, then quantisation.
 *
 * Rays that read `-1` are left untouched and consume NO random numbers — a
 * sensor's stream must not depend on how many rays happened to miss, or the
 * same scene would de-synchronise as soon as an obstacle moves.
 *
 * `normal` and `uniform` come from ONE {@link import('./rv-prng').RandomStream}
 * of this sensor.
 */
export function applyNoise(
  ranges: Float32Array,
  p: NoiseParams,
  normal: () => number,
  uniform: () => number,
): void {
  const noisy = p.sigma > 0 || p.sigmaPerM > 0;
  const drops = p.dropout > 0 || p.dropoutPerM > 0;
  if (!noisy && !drops && !(p.resolution > 0)) return;
  for (let i = 0; i < ranges.length; i++) {
    let d = ranges[i];
    if (d < 0) continue;
    if (drops && uniform() < p.dropout + p.dropoutPerM * d) { ranges[i] = NO_HIT; continue; }
    if (noisy) d += normal() * (p.sigma + p.sigmaPerM * d);
    if (p.resolution > 0) d = Math.round(d / p.resolution) * p.resolution;
    // Noise may push a reading out of the sensor's range — that is a dropout,
    // not a clamp: reporting rangeMax would invent a wall that is not there.
    ranges[i] = d < p.rangeMin || d > p.rangeMax ? NO_HIT : d;
  }
}

/** The smallest real distance in a scan (`-1` when every ray missed). */
export function minRange(ranges: Float32Array): number {
  let best = NO_HIT;
  for (let i = 0; i < ranges.length; i++) {
    const d = ranges[i];
    if (d >= 0 && (best < 0 || d < best)) best = d;
  }
  return best;
}

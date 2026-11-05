// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-collision-tri-tri.ts — the exact triangle–triangle PENETRATION test of the
 * collision narrowphase (plan-781 F2/F3).
 *
 * The structure is Guigue–Devillers (2003): first both plane-side
 * classifications (each triangle against the other's supporting plane, a cheap
 * early-out that rejects most pairs), then the overlap of the two segments the
 * triangles cut out of the intersection line of the two planes. It differs from
 * the published predicate-only form in ONE deliberate way, and that difference
 * is the whole reason this file exists instead of `ExtendedTriangle`:
 *
 *   **Touching is not a hit (Vincent, 2026-11-05: "only real penetration").**
 *   The distances are METRIC (divided by the normal length), so a tolerance
 *   `eps` can be applied in metres:
 *     - a vertex within `eps` of the other plane counts as ON the plane;
 *     - a triangle must have vertices strictly on BOTH sides of the other plane
 *       (beyond `eps`) — a triangle that only rests on the plane is touching;
 *     - coplanar pairs (all distances within `eps`) never count — flush CAD
 *       faces resting on each other are the most common contact of all;
 *     - the two segments on the intersection line must overlap by more than
 *       `eps` — an edge merely crossing an edge is touching, not penetrating.
 *   The published orientation determinants are volume-valued (scale³), which is
 *   exactly what makes a metric tolerance impossible to express with them.
 *
 * Properties the narrowphase relies on:
 *   - **Winding-independent.** Only signed distances and projections are used,
 *     never the triangle orientation, so a MIRRORED relative matrix (det < 0)
 *     needs no vertex re-ordering — the answer is the same either way.
 *   - **Non-finite input returns false and never throws** (contract rule 14).
 *     One sum over the 18 coordinates catches NaN and ±Infinity.
 *   - **Degenerate triangles** (zero area) have no plane and return false.
 *   - **No allocation.** Everything is a local; the inputs are read in place.
 *
 * The test answers PENETRATION only. A near-miss distance (`margin > 0`) is a
 * later plan; the narrowphase applies its margin to the box pruning, never here.
 */

/**
 * Contact tolerance in metres (0.01 mm): parts closer than this — but not
 * deeper — are touching, not colliding (plan-781 F3). An algorithm tolerance,
 * not a user setting.
 */
export const TOUCH_EPS = 1e-5;

/**
 * ≈ float32 resolution relative to the coordinate magnitude (2^-20). The
 * narrowphase raises the tolerance to `max(TOUCH_EPS, TOUCH_EPS_REL · |coord|)`
 * so parts touching 1 km from the origin do not flicker (plan-781 F20).
 */
export const TOUCH_EPS_REL = 9.5367431640625e-7;

/** Scale-aware contact tolerance for coordinates up to `maxAbsCoord` (F20). */
export function touchEpsFor(maxAbsCoord: number): number {
  const rel = TOUCH_EPS_REL * (maxAbsCoord < 0 ? -maxAbsCoord : maxAbsCoord);
  return rel > TOUCH_EPS ? rel : TOUCH_EPS;
}

/**
 * True when the two triangles PENETRATE each other (see the module header for
 * the exact meaning). `a[ao..ao+8]` holds p1,q1,r1 and `b[bo..bo+8]` holds
 * p2,q2,r2 as x,y,z triples, in the SAME frame; `eps` is in that frame's units.
 */
export function trianglesPenetrate(
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  eps: number,
): boolean {
  const p1x = a[ao], p1y = a[ao + 1], p1z = a[ao + 2];
  const q1x = a[ao + 3], q1y = a[ao + 4], q1z = a[ao + 5];
  const r1x = a[ao + 6], r1y = a[ao + 7], r1z = a[ao + 8];
  const p2x = b[bo], p2y = b[bo + 1], p2z = b[bo + 2];
  const q2x = b[bo + 3], q2y = b[bo + 4], q2z = b[bo + 5];
  const r2x = b[bo + 6], r2y = b[bo + 7], r2z = b[bo + 8];

  // Rule 14: one NaN or ±Infinity anywhere poisons the sum (∞ − ∞ = NaN).
  const sum = p1x + p1y + p1z + q1x + q1y + q1z + r1x + r1y + r1z
    + p2x + p2y + p2z + q2x + q2y + q2z + r2x + r2y + r2z;
  if (sum - sum !== 0) return false;

  // ── Plane of T2, metric distances of T1's vertices ───────────────────
  let ux = q2x - p2x, uy = q2y - p2y, uz = q2z - p2z;
  let vx = r2x - p2x, vy = r2y - p2y, vz = r2z - p2z;
  let n2x = uy * vz - uz * vy;
  let n2y = uz * vx - ux * vz;
  let n2z = ux * vy - uy * vx;
  const len2 = Math.sqrt(n2x * n2x + n2y * n2y + n2z * n2z);
  if (!(len2 > 0)) return false;                 // degenerate T2
  n2x /= len2; n2y /= len2; n2z /= len2;
  const c2 = n2x * p2x + n2y * p2y + n2z * p2z;
  let dp1 = n2x * p1x + n2y * p1y + n2z * p1z - c2;
  let dq1 = n2x * q1x + n2y * q1y + n2z * q1z - c2;
  let dr1 = n2x * r1x + n2y * r1y + n2z * r1z - c2;
  if (dp1 <= eps && dp1 >= -eps) dp1 = 0;
  if (dq1 <= eps && dq1 >= -eps) dq1 = 0;
  if (dr1 <= eps && dr1 >= -eps) dr1 = 0;
  // T1 must cross π2 strictly — resting on it (or coplanar) is touching.
  if (!((dp1 > 0 || dq1 > 0 || dr1 > 0) && (dp1 < 0 || dq1 < 0 || dr1 < 0))) return false;

  // ── Plane of T1, metric distances of T2's vertices ───────────────────
  ux = q1x - p1x; uy = q1y - p1y; uz = q1z - p1z;
  vx = r1x - p1x; vy = r1y - p1y; vz = r1z - p1z;
  let n1x = uy * vz - uz * vy;
  let n1y = uz * vx - ux * vz;
  let n1z = ux * vy - uy * vx;
  const len1 = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z);
  if (!(len1 > 0)) return false;                 // degenerate T1
  n1x /= len1; n1y /= len1; n1z /= len1;
  const c1 = n1x * p1x + n1y * p1y + n1z * p1z;
  let dp2 = n1x * p2x + n1y * p2y + n1z * p2z - c1;
  let dq2 = n1x * q2x + n1y * q2y + n1z * q2z - c1;
  let dr2 = n1x * r2x + n1y * r2y + n1z * r2z - c1;
  if (dp2 <= eps && dp2 >= -eps) dp2 = 0;
  if (dq2 <= eps && dq2 >= -eps) dq2 = 0;
  if (dr2 <= eps && dr2 >= -eps) dr2 = 0;
  if (!((dp2 > 0 || dq2 > 0 || dr2 > 0) && (dp2 < 0 || dq2 < 0 || dr2 < 0))) return false;

  // ── Intersection line L = π1 ∩ π2, unit direction ────────────────────
  let lx = n1y * n2z - n1z * n2y;
  let ly = n1z * n2x - n1x * n2z;
  let lz = n1x * n2y - n1y * n2x;
  const lenL = Math.sqrt(lx * lx + ly * ly + lz * lz);
  // Both strict straddles hold, so the planes are not parallel — but a sliver
  // can still bring the angle down to rounding noise. No direction, no answer.
  if (!(lenL > 1e-12)) return false;
  lx /= lenL; ly /= lenL; lz /= lenL;

  // ── Segment of T1 on L (projections, metric) ─────────────────────────
  const pp1 = lx * p1x + ly * p1y + lz * p1z;
  const pq1 = lx * q1x + ly * q1y + lz * q1z;
  const pr1 = lx * r1x + ly * r1y + lz * r1z;
  let lo1 = Infinity, hi1 = -Infinity;
  // A vertex ON the plane lies on L; an edge with a strict sign change crosses it.
  if (dp1 === 0) { lo1 = pp1; hi1 = pp1; }
  if (dq1 === 0) { if (pq1 < lo1) lo1 = pq1; if (pq1 > hi1) hi1 = pq1; }
  if (dr1 === 0) { if (pr1 < lo1) lo1 = pr1; if (pr1 > hi1) hi1 = pr1; }
  if (dp1 * dq1 < 0) { const t = pp1 + (pq1 - pp1) * (dp1 / (dp1 - dq1)); if (t < lo1) lo1 = t; if (t > hi1) hi1 = t; }
  if (dq1 * dr1 < 0) { const t = pq1 + (pr1 - pq1) * (dq1 / (dq1 - dr1)); if (t < lo1) lo1 = t; if (t > hi1) hi1 = t; }
  if (dr1 * dp1 < 0) { const t = pr1 + (pp1 - pr1) * (dr1 / (dr1 - dp1)); if (t < lo1) lo1 = t; if (t > hi1) hi1 = t; }

  // ── Segment of T2 on L ───────────────────────────────────────────────
  const pp2 = lx * p2x + ly * p2y + lz * p2z;
  const pq2 = lx * q2x + ly * q2y + lz * q2z;
  const pr2 = lx * r2x + ly * r2y + lz * r2z;
  let lo2 = Infinity, hi2 = -Infinity;
  if (dp2 === 0) { lo2 = pp2; hi2 = pp2; }
  if (dq2 === 0) { if (pq2 < lo2) lo2 = pq2; if (pq2 > hi2) hi2 = pq2; }
  if (dr2 === 0) { if (pr2 < lo2) lo2 = pr2; if (pr2 > hi2) hi2 = pr2; }
  if (dp2 * dq2 < 0) { const t = pp2 + (pq2 - pp2) * (dp2 / (dp2 - dq2)); if (t < lo2) lo2 = t; if (t > hi2) hi2 = t; }
  if (dq2 * dr2 < 0) { const t = pq2 + (pr2 - pq2) * (dq2 / (dq2 - dr2)); if (t < lo2) lo2 = t; if (t > hi2) hi2 = t; }
  if (dr2 * dp2 < 0) { const t = pr2 + (pp2 - pr2) * (dr2 / (dr2 - dp2)); if (t < lo2) lo2 = t; if (t > hi2) hi2 = t; }

  // Overlap of the two segments, by more than the tolerance.
  const lo = lo1 > lo2 ? lo1 : lo2;
  const hi = hi1 < hi2 ? hi1 : hi2;
  return hi - lo > eps;
}

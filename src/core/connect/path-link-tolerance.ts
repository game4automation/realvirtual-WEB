// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-link-tolerance.ts — the ONE criterion for "path end A continues into
 * path start B" (plan-633 Gate R1 #7 / R2 note, shared with plan-628).
 *
 * Writing successors on snap (633 F7, 628 auto-link) and checking them on load
 * (633 F8) use the same numbers, so a link the planner writes is never reported
 * as a mismatch by the checker and vice versa:
 *
 *   - distance END(A) → START(B) ≤ 5 mm, and
 *   - angle between the END TANGENT of A and the START TANGENT of B ≤ 2°.
 *
 * Both tangents point ALONG travel (`PathEndpoint.tangent`). The opposed
 * `outward` vectors of the two ends are deliberately NOT used — they face each
 * other on a valid link and would read as ~180°.
 *
 * Ends between 5 mm and 30 mm apart are a near miss (`PATH_END_NEAR_MISS_M`):
 * the checker reports them as info, never as a link.
 */

import type { Vector3 } from 'three';

/** Shared path-link tolerance: metres and degrees, both bounds inclusive. */
export const PATH_LINK_TOLERANCE: Readonly<{ distM: number; tangentDeg: number }> = Object.freeze({
  distM: 0.005,
  tangentDeg: 2,
});

/**
 * plan-628 8.3 (E32): largest allowed angle (degrees) between the END tangent of
 * a path and the START tangent of its successor before the live check reports
 * `path-kink` ("kink at connection"). Same 2° as the link tolerance (P5) —
 * every connection is tangent-continuous.
 */
export const PATH_KINK_TOLERANCE_DEG = PATH_LINK_TOLERANCE.tangentDeg;

/** Upper bound (m) of the near-miss band (info only, never a link). */
export const PATH_END_NEAR_MISS_M = 0.03;

/** Inclusive-bound slack against float noise at exactly 5 mm / 2°. */
const BOUND_EPS = 1e-9;

/** {@link isPathLink}'s inclusive-bound slack, exported for search radii that
 *  must cover every link (plan-644: the path-end grid). Same constant. */
export const PATH_LINK_BOUND_EPS = BOUND_EPS;

/**
 * Angle in degrees between two direction vectors (0…180). Uses
 * `atan2(|a × b|, a · b)`, which stays accurate near 0° where `acos` of the
 * dot product loses all precision. Inputs need not be normalised.
 */
export function tangentAngleDeg(a: Vector3, b: Vector3): number {
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  const cross = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return (Math.atan2(cross, dot) * 180) / Math.PI;
}

/**
 * True when the end of one path continues into the start of another under
 * `tol` (default {@link PATH_LINK_TOLERANCE}): END position within `distM` of
 * the START position AND the two travel tangents within `tangentDeg`.
 * Direction matters — END → START only, never start/start or end/end.
 */
export function isPathLink(
  endPosition: Vector3,
  endTangent: Vector3,
  startPosition: Vector3,
  startTangent: Vector3,
  tol: Readonly<{ distM: number; tangentDeg: number }> = PATH_LINK_TOLERANCE,
): boolean {
  if (endPosition.distanceTo(startPosition) > tol.distM + BOUND_EPS) return false;
  return tangentAngleDeg(endTangent, startTangent) <= tol.tangentDeg + BOUND_EPS;
}

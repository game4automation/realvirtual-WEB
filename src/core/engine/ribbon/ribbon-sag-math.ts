// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-sag-math.ts — the shape a slack web takes between two contact points
 * (plan-471, Phase 4).
 *
 * PORTABLE BY CONTRACT, like every other file under `ribbon/`: no `three`, no
 * engine import, plain numbers only.
 *
 * ## Why a quartic bump and not a catenary
 *
 * The input is an EXCESS LENGTH (`|eps| * L`), and what is wanted back is a
 * depth. A catenary cannot be solved for its sag from its arc length in closed
 * form, so it would need a Newton iteration per segment per tick. A quartic does
 * it in one square root, and at the depths this feature ever shows (`d/L` well
 * under 0.2) the two are visually indistinguishable.
 *
 * The profile is
 *
 *     f(s) = 16 * d * s^2 * (1 - s)^2 ,    s in [0, 1]
 *
 * with `f(1/2) = d`, and its derivative
 *
 *     f'(s) = 32 * d * s * (1 - s) * (1 - 2s)
 *
 * The decisive property is `f'(0) = f'(1) = 0`: the sagging line leaves BOTH
 * contact points along the chord. The obvious parabola `4 s (1-s)` does not —
 * it arrives at the roller at an angle, i.e. with a visible kink exactly where
 * the eye is drawn, because the web must be tangent to the roller there.
 *
 * ## The length contract
 *
 * To second order in `d/L` (see {@link SAG_C1} for the derivation and
 * `tests/ribbon-sag-math.test.ts` for the numerical proof):
 *
 *     arc = L * (1 + SAG_C1 * d^2 / L^2)    ->    excess = SAG_C1 * d^2 / L
 *
 * so the depth that consumes a given excess is `d = sqrt(excess * L / SAG_C1)`.
 * It is an approximation, and {@link isSagEstimated} says where it stops being
 * a good one.
 */

/**
 * The second-order arc-length coefficient of the quartic profile:
 *
 *     arc  = integral_0^1 sqrt(L^2 + f'(s)^2) ds
 *          ~ L + 1/(2L) * integral_0^1 f'(s)^2 ds
 *
 * with `integral_0^1 f'^2 ds = 1024 d^2 * integral_0^1 s^2 (1-s)^2 (1-2s)^2 ds`
 * and `integral_0^1 s^2 (1-s)^2 (1-2s)^2 ds = 1/210`, giving
 * `512 d^2 / 105` and therefore `excess = 256 d^2 / (105 L)`.
 *
 * `256 / 105 = 2.438095…`, confirmed against Simpson quadrature in the tests.
 */
export const SAG_C1 = 256 / 105;

/**
 * `d / L` above which the closed-form excess of {@link SAG_C1} is more than 5 %
 * wrong — measured on the EXCESS, which is the quantity actually displayed, not
 * on the total arc length, where the same error reads as a reassuring 0.3 %
 * (Auflage A4).
 *
 * Measured: 4.9 % at 0.17, 5.4 % at 0.18, 6.6 % at 0.20, 10.0 % at 0.25.
 */
export const SAG_ESTIMATED_RATIO = 0.17;

/** A 3-vector as three plain numbers — the portable stand-in for `Vector3`. */
export interface SagVec3 {
  x: number;
  y: number;
  z: number;
}

/** True when the depth/length ratio has left the range the formula is good in. */
export function isSagEstimated(depthMm: number, lengthMm: number): boolean {
  if (!(lengthMm > 0) || !Number.isFinite(depthMm)) return false;
  return Math.abs(depthMm) / lengthMm > SAG_ESTIMATED_RATIO;
}

/** mm — the transverse offset of the sag profile at normalised position `s`. */
export function sagProfile(s: number, depthMm: number): number {
  if (!Number.isFinite(s) || !Number.isFinite(depthMm)) return 0;
  const u = s * (1 - s);
  return 16 * depthMm * u * u;
}

/** mm per unit `s` — the derivative of {@link sagProfile}; zero at both ends. */
export function sagProfileDerivative(s: number, depthMm: number): number {
  if (!Number.isFinite(s) || !Number.isFinite(depthMm)) return 0;
  return 32 * depthMm * s * (1 - s) * (1 - 2 * s);
}

/**
 * mm — the sag depth that consumes `excessMm` of extra web over a chord of
 * `lengthMm`, from the length contract in the file header.
 *
 * Capped at `L / 2`: beyond that the quartic is not a sag any more but a loop,
 * and the cap is what keeps a wildly slack zone from drawing a spike through the
 * machine. The STRAIN is deliberately NOT capped with it — the readout and the
 * alarm must keep telling the truth about how slack the web is, even when the
 * picture has run out of room (plan-471 §Alarm ist nicht Klemmung).
 */
export function sagDepth(excessMm: number, lengthMm: number): number {
  if (!(excessMm > 0) || !(lengthMm > 0)) return 0;
  const d = Math.sqrt((excessMm * lengthMm) / SAG_C1);
  if (!Number.isFinite(d)) return 0;
  return Math.min(d, lengthMm / 2);
}

/**
 * mm — the excess length a given depth consumes: the forward direction of
 * {@link sagDepth}, kept as its own function because the A4 test measures the
 * formula against numerical quadrature and needs exactly this expression.
 */
export function sagExcess(depthMm: number, lengthMm: number): number {
  if (!(lengthMm > 0) || !Number.isFinite(depthMm)) return 0;
  return (SAG_C1 * depthMm * depthMm) / lengthMm;
}

/**
 * The component of gravity perpendicular to a chord: `g_perp = g - (g . c) c`,
 * with `c` the NORMALISED chord direction.
 *
 * Written into `out` and returned as its LENGTH, so the caller can reject a
 * vertical run (where gravity is parallel to the chord and there is no direction
 * to sag in) with one comparison. `out` is normalised on a successful return;
 * on a degenerate one it is zeroed and `0` comes back.
 *
 * Both vectors must already be in the SAME frame — which, per Auflage A2, is the
 * path node's LOCAL frame, so a rotated parent makes the web sag downwards in
 * the world rather than sideways.
 */
export function perpGravity(g: SagVec3, chord: SagVec3, out: SagVec3): number {
  const cl = Math.hypot(chord.x, chord.y, chord.z);
  if (!(cl > 1e-12)) { out.x = 0; out.y = 0; out.z = 0; return 0; }
  const cx = chord.x / cl;
  const cy = chord.y / cl;
  const cz = chord.z / cl;
  const dot = g.x * cx + g.y * cy + g.z * cz;
  let px = g.x - dot * cx;
  let py = g.y - dot * cy;
  let pz = g.z - dot * cz;
  const pl = Math.hypot(px, py, pz);
  if (!(pl > 1e-12)) { out.x = 0; out.y = 0; out.z = 0; return 0; }
  px /= pl; py /= pl; pz /= pl;
  out.x = px; out.y = py; out.z = pz;
  return pl;
}

/**
 * Distribute `excessMm` over the segments in `lengthsMm` IN PROPORTION to their
 * length, writing the result into `out` (which must be at least as long).
 *
 * The last non-empty entry takes the rounding remainder, so the sum of `out` is
 * EXACTLY `excessMm` — a proportional split computed independently per segment
 * loses a few ulps, and the test that the excess is conserved would then need a
 * tolerance that hides a real distribution bug.
 *
 * Returns the number of entries written.
 */
export function distributeExcess(
  lengthsMm: readonly number[],
  excessMm: number,
  out: number[],
): number {
  const n = lengthsMm.length;
  for (let i = 0; i < n; i++) out[i] = 0;
  if (!(excessMm > 0) || n === 0) return n;
  let total = 0;
  let last = -1;
  for (let i = 0; i < n; i++) {
    const l = lengthsMm[i];
    if (l > 0 && Number.isFinite(l)) { total += l; last = i; }
  }
  if (!(total > 0) || last < 0) return n;
  let assigned = 0;
  for (let i = 0; i < n; i++) {
    if (i === last) continue;
    const l = lengthsMm[i];
    if (!(l > 0) || !Number.isFinite(l)) continue;
    const share = (excessMm * l) / total;
    out[i] = share;
    assigned += share;
  }
  out[last] = excessMm - assigned;
  return n;
}

/**
 * The unit tangent of a sagging line at normalised position `s`, written into
 * `out` (Auflage A3).
 *
 * The sagging line is `p(s) = P0 + c * L * s + n * f(s)` with `c` the unit chord
 * direction, `n` the unit sag direction and `f` the profile, so
 * `dp/ds = c * L + n * f'(s)` — ANALYTIC, not a central difference over the
 * sample grid. A central difference is what the first sketch used and it is
 * wrong for a structural reason: it reaches ACROSS the line/arc boundary at the
 * first and last sample of a segment, where the two curves meet at a corner the
 * difference quotient averages away. The web then leaves the roller at an angle
 * that is neither the arc's nor the line's.
 *
 * With `f'(0) = f'(1) = 0` the analytic tangent at both ends is exactly the
 * chord — which is exactly the taut tangent the arc hands over to.
 */
export function lineTangentAfterSag(
  chord: SagVec3,
  sagDir: SagVec3,
  s: number,
  depthMm: number,
  lengthMm: number,
  out: SagVec3,
): void {
  const fp = sagProfileDerivative(s, depthMm);
  const L = lengthMm > 0 ? lengthMm : 1;
  let x = chord.x * L + sagDir.x * fp;
  let y = chord.y * L + sagDir.y * fp;
  let z = chord.z * L + sagDir.z * fp;
  const len = Math.hypot(x, y, z);
  if (!(len > 1e-12)) { out.x = chord.x; out.y = chord.y; out.z = chord.z; return; }
  x /= len; y /= len; z /= len;
  out.x = x; out.y = y; out.z = z;
}

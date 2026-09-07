// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-dancer-math.ts — the dancer roller as a pure integrator (plan-460 F2).
 *
 * A dancer is an accumulator, not a spring. Web handling literature models it
 * exactly this way for position control: the roller stores whatever length the
 * upstream section delivers over what the downstream section takes,
 *
 *     L_acc += (v_up - v_down) * dt
 *
 * and its carriage sits at `home + L_acc / strands` along the travel axis. With
 * `strands = 2` (the usual single-wrap loop, web down and back up) one
 * millimetre of carriage travel stores two millimetres of web.
 *
 * ## Anti-windup is the whole point
 *
 * Clamping only the POSITION would let `L_acc` keep growing while the carriage
 * sits at its stop; a later reversal would then do nothing for as long as it
 * took to run the phantom length back out. {@link clampTravel} therefore
 * recomputes `L_acc` FROM the clamped position, so the integrator can never
 * hold length the machine does not have.
 *
 * No `three` import, by design: this file is the portable half a Unity port
 * transcribes verbatim (same rule as `ribbon-winder-math.ts`).
 */

/** The result of clamping a dancer position against its travel limits. */
export interface ClampedTravel {
  /** mm — the clamped carriage position along the travel axis. */
  posMm: number;
  /** mm — the accumulated web length consistent with {@link posMm}. */
  lAccMm: number;
  /** True when the carriage sits at (or below) its lower stop. */
  atMin: boolean;
  /** True when the carriage sits at (or above) its upper stop. */
  atMax: boolean;
}

/** mm — at least one strand; a 0 would divide the position by zero. */
export function normaliseStrands(strands: number): number {
  return Number.isFinite(strands) && strands >= 1 ? strands : 1;
}

/**
 * mm — the new accumulated length after `dt` seconds of `vUp` in and `vDown`
 * out. A non-positive `dt` (a paused frame) changes nothing.
 */
export function accumulate(lAccMm: number, vUp: number, vDown: number, dt: number): number {
  if (!(dt > 0)) return lAccMm;
  const delta = (vUp - vDown) * dt;
  return Number.isFinite(delta) ? lAccMm + delta : lAccMm;
}

/** mm — the carriage position for an accumulated length. */
export function positionFromAccumulated(homeMm: number, lAccMm: number, strands: number): number {
  return homeMm + lAccMm / normaliseStrands(strands);
}

/**
 * Clamp `posMm` into `[homeMm + minMm, homeMm + maxMm]` and rewind `L_acc` to
 * match (see the file header). `minMm` is `<= 0` and `maxMm` is `>= 0`, both
 * relative to `homeMm`; a reversed pair is normalised rather than rejected, so
 * a mis-authored dancer is inert instead of NaN.
 */
export function clampTravel(
  posMm: number,
  homeMm: number,
  minMm: number,
  maxMm: number,
  strands: number,
): ClampedTravel {
  const lo = homeMm + Math.min(minMm, maxMm);
  const hi = homeMm + Math.max(minMm, maxMm);
  const s = normaliseStrands(strands);
  let pos = Number.isFinite(posMm) ? posMm : homeMm;
  let atMin = false;
  let atMax = false;
  if (pos <= lo) { pos = lo; atMin = true; }
  if (pos >= hi) { pos = hi; atMax = true; }
  // Anti-windup: L_acc is DERIVED from the clamped position, never carried past it.
  return { posMm: pos, lAccMm: (pos - homeMm) * s, atMin, atMax };
}

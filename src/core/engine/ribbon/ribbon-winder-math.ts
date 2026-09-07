// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-winder-math.ts — roll build-up mathematics for `RibbonWinder` (plan-459).
 *
 * PORTABLE BY CONTRACT, exactly like `ribbon-geometry.ts`: no `three`, no engine
 * import, numbers only, so the Unity/C# port is a transcription.
 *
 * ## The one equation
 *
 * A roll of web of thickness `t` wound onto a core of radius `R0` covers the
 * annulus between `R0` and `R`. Its cross-sectional area is `π(R² − R0²)` and
 * equals the wound length times the thickness, `L·t`:
 *
 *   `R(L) = sqrt(R0² + L·t/π)`      `L(R) = π(R² − R0²)/t`
 *
 * This is the standard integration-technology diameter calculation
 * (`D = sqrt(4·t·L/π + D0²)`, Siemens DCC RibbonWinder) rewritten in radii, which is
 * what the renderer needs. Its incremental form `dR = t·v·dt/(2πR)` is NOT used:
 * integrating `L` and deriving `R` from it keeps the roll exactly reversible, so
 * a rewinder run backwards returns to its authored radius instead of drifting.
 *
 * ## Units
 *
 * Millimetres and mm/s throughout; the angular result is rad/s. All three
 * functions are total on their documented domain and never return NaN: invalid
 * configuration throws a `RangeError` at the ONE place a component can catch it
 * (its `init()`), rather than seeding a NaN into a transform.
 */

/** mm — the smallest radius any division is allowed to see. */
const MIN_RADIUS_MM = 1e-6;

function assertRollConfig(coreRadiusMm: number, thicknessMm: number): void {
  if (!(coreRadiusMm > 0) || !Number.isFinite(coreRadiusMm)) {
    throw new RangeError(`CoreRadiusMm must be > 0, got ${coreRadiusMm}`);
  }
  if (!(thicknessMm > 0) || !Number.isFinite(thicknessMm)) {
    throw new RangeError(`RibbonThicknessMm must be > 0, got ${thicknessMm}`);
  }
}

/**
 * mm — outer radius of a roll holding `lengthMm` of web.
 *
 * A negative `lengthMm` (an unwinder driven past empty by one tick of float
 * noise) clamps to the bare core rather than producing a NaN root.
 */
export function radiusFromLengthMm(
  coreRadiusMm: number,
  thicknessMm: number,
  lengthMm: number,
): number {
  assertRollConfig(coreRadiusMm, thicknessMm);
  const l = Number.isFinite(lengthMm) && lengthMm > 0 ? lengthMm : 0;
  return Math.sqrt(coreRadiusMm * coreRadiusMm + (l * thicknessMm) / Math.PI);
}

/**
 * mm — web length stored in a roll of outer radius `radiusMm`. The exact
 * inverse of {@link radiusFromLengthMm}; a radius below the core yields `0`.
 *
 * This is how `InitialWoundLengthMm = -1` is resolved: the authored CAD roll is
 * measured, and its outer radius is turned into the length it must contain.
 */
export function lengthFromRadiusMm(
  coreRadiusMm: number,
  thicknessMm: number,
  radiusMm: number,
): number {
  assertRollConfig(coreRadiusMm, thicknessMm);
  if (!Number.isFinite(radiusMm) || radiusMm <= coreRadiusMm) return 0;
  return (Math.PI * (radiusMm * radiusMm - coreRadiusMm * coreRadiusMm)) / thicknessMm;
}

/**
 * rad/s — the angular speed a roller of radius `radiusMm` turns at while the web
 * runs over it at `linearSpeedMmPerS`. Signed: a negative web speed turns the
 * roller the other way.
 *
 * `minRadiusMm` is the division guard (a winder run to a zero radius, a roller
 * whose measured radius came out degenerate); it is clamped to a hard floor so
 * a caller passing `0` still cannot divide by zero.
 */
export function angularSpeedRad(
  linearSpeedMmPerS: number,
  radiusMm: number,
  minRadiusMm: number,
): number {
  if (!Number.isFinite(linearSpeedMmPerS)) return 0;
  const floor = Number.isFinite(minRadiusMm) && minRadiusMm > MIN_RADIUS_MM
    ? minRadiusMm
    : MIN_RADIUS_MM;
  const r = Number.isFinite(radiusMm) && radiusMm > floor ? radiusMm : floor;
  return linearSpeedMmPerS / r;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-tension-math.ts — web tension as a scalar strain state (plan-471).
 *
 * PORTABLE BY CONTRACT, exactly like `ribbon-geometry.ts`: this module imports
 * NOTHING — no `three`, no engine module — so the later Unity transcription is
 * mechanical. The guard is the same grep: `rg -n "from 'three'"
 * src/core/engine/ribbon/` must stay empty.
 *
 * ## The model
 *
 * Web tension is not cloth physics. The state of the art (Shelton; Pagilla;
 * Roisum, *Web Handling*) is a scalar span model: Hooke plus mass conservation
 * over a control volume. For one zone of mechanical length `L` with entry speed
 * `v_A`, exit speed `v_B` and entry strain `eps_in`, all at the same stiffness:
 *
 *     L * d(eps)/dt = (v_B - v_A) + eps_in * v_A - eps * v_B
 *
 * whose steady state is {@link strainSteadyState}. {@link strainStepImplicit}
 * integrates it with an IMPLICIT Euler step, which is unconditionally stable for
 * `v_B >= 0` (the error factor `q = 1/(1 + dt*v_B/L)` lies in `(0, 1]`) — the
 * explicit form blows up as soon as `dt*v_B/L > 2`, which a 60 Hz tick over a
 * 200 mm span at 1 m/s already does.
 *
 * ## Why stiffness per unit WIDTH, and not E times A
 *
 * The caliper of a nonwoven is compressible and not uniquely defined, so `E*A`
 * is not measurable on it. The industry quantity is a SECANT stiffness per unit
 * width, read straight off the strip tensile curve of **EDANA/INDA NWSP 110.4**
 * — the method Russell, *Handbook of Nonwovens*, builds its characterisation
 * chapter on. Two consequences carried here: a nonwoven is strongly anisotropic
 * (only MD is modelled), and there is no Hookean region at all, so a modulus is
 * valid only as a secant at the working point — which is why a maximum strain is
 * mandatory rather than optional.
 *
 * Tension therefore is `T = K * w * eps`, with `K` in newtons per millimetre of
 * width at `eps = 1` and `w` the web width in millimetres.
 *
 * ## Sign convention
 *
 *     eps > 0   taut    T = K * w * eps    the geometry is the taut one
 *     eps = 0   limit   T = 0              exactly today's geometry
 *     eps < 0   slack   T = 0              an excess length |eps| * L sags
 *
 * A slack web carries no tension: a rope does not push. That is the ONE
 * non-linearity of the model and it lives in {@link tensionFromStrain}.
 */

/** 1 PLI (pound per linear inch) in newtons per metre. */
export const N_PER_M_PER_PLI = 175.1;

/** mm — a zone shorter than this is solved algebraically, not integrated. */
export const MIN_ZONE_LENGTH_MM = 1;

/** How a zone's strain was produced in the current tick. */
export type RibbonZoneMode = 'integrated' | 'algebraic' | 'frozen';

/**
 * The alarm / band state of one zone. `inBand` is the good case and is the ONLY
 * one that is not tinted (plan-471 E5/E6: the good web is left alone).
 */
export type RibbonZoneState = 'slack' | 'below' | 'inBand' | 'above' | 'over' | 'broken';

/**
 * The states that are an ALARM rather than a deviation.
 *
 * A web that is slack, overstretched or torn is a FAULT — the band tint pulses
 * for it, the overlay keeps its word on screen after the readouts are switched
 * off, and a PLC would latch it. `below` / `above` are a deviation inside the
 * usable range and none of those things.
 *
 * It lives here, beside {@link classify} which produces the states, so the
 * drawing code and the tint code cannot drift into two different opinions about
 * what counts as a fault — which they briefly did.
 */
export const RIBBON_ALARM_STATES: ReadonlySet<RibbonZoneState> =
  new Set<RibbonZoneState>(['slack', 'over', 'broken']);

/** True when `state` is a fault rather than a deviation. See {@link RIBBON_ALARM_STATES}. */
export function isRibbonAlarm(state: RibbonZoneState): boolean {
  return RIBBON_ALARM_STATES.has(state);
}

/** The thresholds {@link classify} compares a strain against, all as strain (1 = 100 %). */
export interface RibbonStrainThresholds {
  /** Strain below which the web counts as SLACK. */
  minStrain: number;
  /** Strain above which the web counts as OVERSTRETCHED. */
  maxStrain: number;
  /** Strain at which the web breaks; `Infinity` disables it. */
  breakStrain: number;
  /** The set-point strain the tolerance band is centred on. */
  refStrain: number;
  /** Half-width of the tolerance band, as a FRACTION of `refStrain` (0.1 = 10 %). */
  tolerance: number;
}

/**
 * The steady-state strain of a zone — the test oracle of the whole model.
 *
 *     eps_ss = (v_B - v_A + eps_in * v_A) / v_B          (v_B > 0)
 *
 * Returns `NaN` when `v_B <= 0` or any input is non-finite: the stationary
 * solution is genuinely undefined there, and a silent 0 would read as "the web
 * relaxes", which is the opposite of what a stopped exit does.
 */
export function strainSteadyState(epsIn: number, vA: number, vB: number): number {
  if (!Number.isFinite(epsIn) || !Number.isFinite(vA) || !Number.isFinite(vB)) return Number.NaN;
  if (!(vB > 0)) return Number.NaN;
  return (vB - vA + epsIn * vA) / vB;
}

/**
 * One IMPLICIT Euler step of the span equation:
 *
 *     a = dt / L
 *     eps' = (eps + a * (v_B - v_A + eps_in * v_A)) / (1 + a * v_B)
 *
 * The rules are as load-bearing as the formula (plan-471 §Integration):
 *
 * - `dt <= 0` (a paused frame) → unchanged;
 * - `v_B < 0` (the web runs backwards) → unchanged; the zone direction would
 *   have to flip, which is a follow-up plan, so the strain FREEZES rather than
 *   integrating a sign-flipped equation;
 * - `L <= 0` or any non-finite input → unchanged;
 * - `v_A = v_B = 0` → unchanged. A standing web KEEPS its strain. This is
 *   deliberate model behaviour, not an oversight: nothing enters and nothing
 *   leaves the control volume, so no material balance can change the strain.
 *   The formula produces it anyway; the early return only makes it legible.
 */
export function strainStepImplicit(
  eps: number,
  epsIn: number,
  vA: number,
  vB: number,
  lengthMm: number,
  dt: number,
): number {
  if (!Number.isFinite(eps)) return eps;
  if (!(dt > 0) || !(lengthMm > 0)) return eps;
  if (!Number.isFinite(epsIn) || !Number.isFinite(vA) || !Number.isFinite(vB)) return eps;
  if (vB < 0) return eps;
  if (vA === 0 && vB === 0) return eps;
  const a = dt / lengthMm;
  const next = (eps + a * (vB - vA + epsIn * vA)) / (1 + a * vB);
  return Number.isFinite(next) ? next : eps;
}

/**
 * N — the tension a strain carries over `widthMm` of web at a secant stiffness
 * of `stiffnessNPerMmWidth` newtons per millimetre of width at `eps = 1`.
 *
 * A slack web (`eps < 0`) carries NO tension — see the sign convention in the
 * file header.
 */
export function tensionFromStrain(stiffnessNPerMmWidth: number, widthMm: number, eps: number): number {
  if (!(stiffnessNPerMmWidth > 0) || !(widthMm > 0) || !Number.isFinite(eps)) return 0;
  if (!(eps > 0)) return 0;
  return stiffnessNPerMmWidth * widthMm * eps;
}

/**
 * The strain that carries `tensionN` over `widthMm` — the inverse of
 * {@link tensionFromStrain}, used where a FORCE is the input (a loaded dancer,
 * or the set-point tension of the unwinder).
 *
 * Unlike the forward direction this is linear through zero: a negative force
 * would be a negative strain, which is what makes it usable for a set point.
 * Returns 0 when the stiffness or the width is unusable.
 */
export function strainFromTension(tensionN: number, stiffnessNPerMmWidth: number, widthMm: number): number {
  if (!(stiffnessNPerMmWidth > 0) || !(widthMm > 0) || !Number.isFinite(tensionN)) return 0;
  return tensionN / (stiffnessNPerMmWidth * widthMm);
}

/**
 * N — the web tension a loaded dancer imposes on BOTH of its neighbouring
 * zones: the force balance at the carriage is `T = LoadN / Strands`, because
 * `Strands` runs of web carry the load together (plan-471 E9).
 */
export function tensionFromDancerLoad(loadN: number, strands: number): number {
  if (!Number.isFinite(loadN) || !(loadN > 0)) return 0;
  const s = Number.isFinite(strands) && strands >= 1 ? strands : 1;
  return loadN / s;
}

/**
 * The band / alarm state of a strain.
 *
 * The order is the contract (plan-471 §Alarm ist nicht Klemmung): `broken`
 * outranks `over`, `over` outranks `slack`, and only then is the tolerance band
 * consulted. Every comparison is made on the strain ITSELF — never on a negated
 * one — so a NaN falls through to `inBand` rather than into a random alarm.
 *
 * NOTE that none of these thresholds CLAMPS anything. They colour the band and
 * drive the signals; the single clamping rule of the whole feature is that a
 * `broken` zone freezes its strain until a reset.
 */
export function classify(eps: number, t: RibbonStrainThresholds): RibbonZoneState {
  if (!Number.isFinite(eps)) return 'inBand';
  if (eps >= t.breakStrain) return 'broken';
  if (eps > t.maxStrain) return 'over';
  if (eps < t.minStrain) return 'slack';
  const tol = Number.isFinite(t.tolerance) && t.tolerance > 0 ? t.tolerance : 0;
  const lo = t.refStrain * (1 - tol);
  const hi = t.refStrain * (1 + tol);
  if (eps < lo) return 'below';
  if (eps > hi) return 'above';
  return 'inBand';
}

/**
 * `0..1` — how far outside the tolerance band a strain sits, normalised so `1`
 * is reached at the SLACK / OVER threshold. This is the tint saturation of
 * plan-471 §Farbkonzept: `0` everywhere inside the band (the good web is not
 * coloured at all) and a hard edge at the band limit.
 *
 * The normalisation deliberately uses the distance from the band EDGE to the
 * alarm threshold rather than to the set point: it is what makes the saturation
 * grow continuously between "just out of band" and "alarm", which is the
 * property Auflage A1 tests without any resampling.
 */
export function bandDeviation(eps: number, t: RibbonStrainThresholds): number {
  if (!Number.isFinite(eps)) return 0;
  const tol = Number.isFinite(t.tolerance) && t.tolerance > 0 ? t.tolerance : 0;
  const lo = t.refStrain * (1 - tol);
  const hi = t.refStrain * (1 + tol);
  if (eps < lo) {
    const span = lo - t.minStrain;
    if (!(span > 0)) return 1;
    return Math.min(1, (lo - eps) / span);
  }
  if (eps > hi) {
    const span = t.maxStrain - hi;
    if (!(span > 0)) return 1;
    return Math.min(1, (eps - hi) / span);
  }
  return 0;
}

/** N/m — the tension per unit WIDTH, the number a web handler actually quotes. */
export function specificTension(tensionN: number, widthMm: number): number {
  if (!(widthMm > 0) || !Number.isFinite(tensionN)) return 0;
  return tensionN / (widthMm / 1000);
}

/** PLI — the same quantity in pounds per linear inch (1 PLI = 175.1 N/m). */
export function pliFromNPerM(nPerM: number): number {
  return Number.isFinite(nPerM) ? nPerM / N_PER_M_PER_PLI : 0;
}

/**
 * N*m/kg — the specific tenacity: tension per unit width divided by basis
 * weight. This is the number that makes two nonwovens of different grammage
 * comparable, which is why the basis weight is a field at all.
 */
export function specificTenacity(nPerM: number, basisWeightGsm: number): number {
  if (!(basisWeightGsm > 0) || !Number.isFinite(nPerM)) return 0;
  // gsm is g/m^2; kg/m^2 = gsm / 1000.
  return nPerM / (basisWeightGsm / 1000);
}

/**
 * The strain at which a web of `stiffnessNPerMmWidth` breaks, from the MD strip
 * tensile force per 50 mm of width that every nonwoven data sheet quotes:
 * `eps_break = (F_50 / 50) / K`. A non-positive force disables breaking
 * (`Infinity`), which is what a model without a quoted strength should do.
 */
export function breakStrain(breakForceNPer50mm: number, stiffnessNPerMmWidth: number): number {
  if (!(breakForceNPer50mm > 0) || !(stiffnessNPerMmWidth > 0)) return Number.POSITIVE_INFINITY;
  return (breakForceNPer50mm / 50) / stiffnessNPerMmWidth;
}

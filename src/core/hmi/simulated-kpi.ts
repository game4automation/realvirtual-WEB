// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * simulated-kpi — a deterministic, smoothly varying KPI value source.
 *
 * For demos and presentation models that have no live KPI data yet: a KPI is a
 * base value plus a bounded, smooth fluctuation over time. The fluctuation is
 * 1D value noise (hashed lattice values, smoothstep interpolation), so
 *
 * - the same (definition, time) always yields the same value (no Math.random),
 * - consecutive reads drift gently instead of jumping every frame,
 * - the value never leaves `base ± amplitude`.
 *
 * Pure functions only; the React side lives in `SimulatedKpiPlugin`.
 */

/** One simulated KPI chip. */
export interface SimulatedKpiDef {
  /** Chip label, e.g. "OEE". */
  label: string;
  /** Centre value the KPI fluctuates around. */
  base: number;
  /** Maximum deviation from `base` (same unit as `base`). 0 = constant. Default 0. */
  amplitude?: number;
  /** Seconds between two noise lattice points — larger = slower drift. Default 20 s. */
  period?: number;
  /** Unit text shown next to the value, e.g. "%", "pcs/h", "kg", "°C". */
  unit: string;
  /** Decimal places shown. Default 0. */
  decimals?: number;
  /** Seed so several KPIs with equal settings do not move in lockstep. Default 0. */
  seed?: number;
  /** Accent colour of value and sparkline. */
  color?: string;
  /** Optional second line under the value. */
  secondary?: string;
  /** Time span of the trend chart a click on the chip opens, in hours. Default 8 (one shift). */
  historyHours?: number;
  /** Half width of the tolerance band drawn around `base` in the trend chart (same unit as `base`). Default = `amplitude`. */
  tolerance?: number;
  /**
   * How much the trend chart shows a calm shift curve instead of the raw chip drift, 0..1.
   * 1 (default) = slow wave inside the band, ramping smoothly onto the real chip value over the
   * last 15 minutes; 0 = the raw source sampled on the grid (looks like noise over hours).
   */
  historySmoothing?: number;
}

/** Default time span of the trend chart, in hours (one shift). */
export const DEFAULT_HISTORY_HOURS = 8;
/** Default number of grid steps of one history series (96 = 5 min over one shift). */
export const DEFAULT_HISTORY_INTERVALS = 96;
/** Seconds before "now" over which the calm history curve ramps into the real chip value. */
export const HISTORY_BLEND_SEC = 900;
/** Sample spacing inside the ramp window, in seconds. */
const HISTORY_FINE_STEP = 30;
/** Slow waves of the calm history curve per history span. */
const HISTORY_SLOW_WAVES = 6;
/** Amplitude of the slow / fine component, as a fraction of the tolerance. */
const HISTORY_SLOW_AMP = 0.6;
const HISTORY_FINE_AMP = 0.1;
/** Upper bound of grid steps in one history series. */
export const MAX_HISTORY_POINTS = 2000;

/** One history series: `t` in seconds (oldest first, last = the requested end), `v` the values. */
export interface SimulatedKpiHistory {
  t: number[];
  v: number[];
  /** Spacing of the grid samples in seconds (the last sample may be closer to its predecessor). */
  step: number;
}

/** Hash an integer lattice point (+ seed) to a value in [-1, 1]. */
function latticeValue(i: number, seed: number): number {
  // Integer hash (Wang/xorshift-style) on 32 bits — deterministic across engines.
  let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul((seed | 0) + 0x9e3779b9, 0x85ebca6b)) | 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/**
 * Smooth 1D value noise in [-1, 1]. Continuous in `x`; lattice points at
 * integer `x`, smoothstep interpolation between them.
 */
export function smoothNoise1D(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = latticeValue(i, seed);
  const b = latticeValue(i + 1, seed);
  return a + (b - a) * u;
}

/** Value of `def` at time `tSec` (seconds, any monotonic clock). */
export function simulatedKpiValue(def: SimulatedKpiDef, tSec: number): number {
  const amp = def.amplitude ?? 0;
  if (amp === 0) return def.base;
  const period = def.period && def.period > 0 ? def.period : 20;
  return def.base + amp * smoothNoise1D(tSec / period, def.seed ?? 0);
}

/** `count` samples ending at `tSec`, spaced `step` seconds apart (oldest first) — for a sparkline. */
export function simulatedKpiSeries(def: SimulatedKpiDef, tSec: number, count: number, step: number): number[] {
  const out: number[] = [];
  for (let k = count - 1; k >= 0; k--) out.push(simulatedKpiValue(def, tSec - k * step));
  return out;
}

/** Display string of a value with the definition's decimals. */
export function formatSimulatedKpi(def: SimulatedKpiDef, value: number): string {
  return value.toFixed(Math.max(0, def.decimals ?? 0));
}

/** Time span of the trend chart of `def`, in hours. */
export function simulatedKpiHistoryHours(def: SimulatedKpiDef): number {
  return def.historyHours && def.historyHours > 0 ? def.historyHours : DEFAULT_HISTORY_HOURS;
}

/** Target line and tolerance band of `def`: `[base - tolerance, base + tolerance]`. */
export function simulatedKpiBand(def: SimulatedKpiDef): { target: number; low: number; high: number } {
  const tol = Math.abs(def.tolerance ?? def.amplitude ?? 0);
  return { target: def.base, low: def.base - tol, high: def.base + tol };
}

/**
 * Calm "shift curve" of `def` at `tSec`: a slow wave (period = span / 6, amplitude
 * 0.6 · tolerance) plus a small fine component (0.1 · tolerance), seeded from the
 * KPI's own seed. Deterministic; stays well inside the tolerance band.
 */
export function simulatedKpiCalmValue(def: SimulatedKpiDef, tSec: number): number {
  const band = simulatedKpiBand(def);
  const tol = band.high - band.target;
  if (tol === 0) return def.base;
  const slowPeriod = (simulatedKpiHistoryHours(def) * 3600) / HISTORY_SLOW_WAVES;
  const seed = def.seed ?? 0;
  return def.base
    + tol * HISTORY_SLOW_AMP * smoothNoise1D(tSec / slowPeriod, seed + 7919)
    + tol * HISTORY_FINE_AMP * smoothNoise1D(tSec / (slowPeriod / 8), seed + 104729);
}

/**
 * Value the trend chart shows at `tSec` for a chart ending at `endSec`: the calm
 * curve, shifted over the last `HISTORY_BLEND_SEC` by a smoothstep ramp onto the
 * chip value at `endSec` — so the curve glides into "now" instead of jumping, and
 * at `endSec` it IS the chip value. `historySmoothing` mixes it with the raw source.
 */
export function simulatedKpiHistoryValue(def: SimulatedKpiDef, tSec: number, endSec: number): number {
  const raw = simulatedKpiValue(def, tSec);
  const smoothing = Math.max(0, Math.min(1, def.historySmoothing ?? 1));
  if (smoothing === 0) return raw;
  if (tSec >= endSec) return raw; // the endpoint is always the chip value
  let shaped = simulatedKpiCalmValue(def, tSec);
  const x = 1 - (endSec - tSec) / HISTORY_BLEND_SEC;
  if (x > 0) {
    const s = x * x * (3 - 2 * x);
    const chipEnd = simulatedKpiValue(def, endSec);
    shaped += s * (chipEnd - simulatedKpiCalmValue(def, endSec));
    const band = simulatedKpiBand(def);
    shaped = Math.max(Math.min(band.low, chipEnd), Math.min(Math.max(band.high, chipEnd), shaped));
  }
  return smoothing === 1 ? shaped : smoothing * shaped + (1 - smoothing) * raw;
}

/**
 * History of `def` over its `historyHours`, ending exactly at `endSec`; the last
 * sample IS the chip's value at `endSec`.
 *
 * Samples sit on an ABSOLUTE grid (multiples of `step` on the source clock), so a
 * later end never resamples the points in between — the chart does not shimmer
 * while it follows "now". `intervals` grid steps cover the span (default 96 =
 * 5 min per shift). Inside the last `HISTORY_BLEND_SEC` the grid is refined to
 * 30 s (also absolute), so the ramp into the chip value is drawn as a curve.
 */
export function simulatedKpiHistory(
  def: SimulatedKpiDef,
  endSec: number,
  intervals: number = DEFAULT_HISTORY_INTERVALS,
): SimulatedKpiHistory {
  const span = simulatedKpiHistoryHours(def) * 3600;
  const n = Math.max(1, Math.min(MAX_HISTORY_POINTS, Math.floor(intervals)));
  const step = span / n;
  const start = endSec - span;
  const blendStart = Math.max(start, endSec - HISTORY_BLEND_SEC);
  const fine = Math.min(step, HISTORY_FINE_STEP);
  const t: number[] = [];
  const v: number[] = [];
  const push = (tk: number) => { t.push(tk); v.push(simulatedKpiHistoryValue(def, tk, endSec)); };
  // Coarse grid from the start up to (excluding) the blend window.
  for (let g = Math.ceil(start / step); g * step < blendStart; g++) push(g * step);
  // Fine grid through the ramp window, strictly before the end.
  for (let g = Math.ceil(blendStart / fine); g * fine < endSec; g++) push(g * fine);
  push(endSec);
  return { t, v, step };
}

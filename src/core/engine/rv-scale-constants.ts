// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Scale-derived viewer constants (plan-515 F10, Phase 3).
 *
 * Every number here used to be a fixed metre value tuned for machines of a
 * few metres: the orientation gizmo's 5 m fallback distance, the 0.5 m ground
 * checker square (both now only capped for small models), the FPV eye height / walk speed, the shadow camera's pad /
 * near / far. They are derived from the ONE scene scale ({@link SceneScale})
 * instead, so a 0.33 m part and a 500 m hall both get sensible values.
 *
 * Pure functions, no three.js objects — the consumers (orientation gizmo,
 * ground plane, FPV plugin, shadow fit in RVViewer) call them when the scale
 * changes (`SceneScale.onChange`) or when they act.
 */

/** Minimal scale input — a {@link SceneScaleSnapshot} satisfies it. */
export interface ScaleLike {
  readonly radius: number;
  readonly maxDim: number;
  readonly empty: boolean;
}

// ─── Orientation gizmo ──────────────────────────────────────────────────

/** Pre-515 fixed gizmo floor (5 m): the empty-scene value and the cap of the scale-derived floor. */
export const GIZMO_EMPTY_FALLBACK = 5;
/** Smallest gizmo fallback distance (1 mm). */
export const GIZMO_MIN_FALLBACK = 0.001;

/**
 * Minimum camera distance for an orientation-gizmo axis view (the click keeps
 * the current distance when it is larger).
 *
 * The pre-515 rule `d > 0.5 ? 2d : 5` with one change: the fixed 5 m floor
 * becomes `min(5 m, 2 · radius)` (at least 1 mm) for a non-empty scene. Large
 * scenes therefore behave exactly as before (a zoomed-in user stays close),
 * small models no longer jump to >= 5 m. Empty scene: `d > 0.5 ? 2d : 5`.
 *
 * @param scale Current scene scale (or null when unknown).
 * @param rootToTarget Distance model root → orbit target in metres (0 when unknown).
 */
export function gizmoFallbackDistance(scale: ScaleLike | null, rootToTarget: number): number {
  const d = Number.isFinite(rootToTarget) && rootToTarget > 0 ? rootToTarget : 0;
  if (d > 0.5) return d * 2;
  if (!scale || scale.empty || !(scale.radius > 0)) return GIZMO_EMPTY_FALLBACK;
  return Math.max(Math.min(GIZMO_EMPTY_FALLBACK, 2 * scale.radius), GIZMO_MIN_FALLBACK);
}

// ─── Ground checker ─────────────────────────────────────────────────────

/** Checker square when nothing draws (authoring playground) — the old constant. */
export const GROUND_SQUARE_DEFAULT = 0.5;
/** Smallest checker square (1 mm). */
export const GROUND_SQUARE_MIN = 0.001;

/**
 * Nearest value of the 1-2-5 series to `x` (in log space), e.g. 0.033 → 0.05,
 * 50 → 50, 0.7 → 0.5. `x <= 0` or non-finite → NaN.
 */
export function nice125(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return Number.NaN;
  const exp = Math.floor(Math.log10(x));
  const base = Math.pow(10, exp);
  const m = x / base; // 1 <= m < 10
  // Log-space midpoints between 1-2, 2-5, 5-10.
  const step = m < Math.SQRT2 ? 1 : m < Math.sqrt(10) ? 2 : m < Math.sqrt(50) ? 5 : 10;
  // Round away float noise from 10^exp (e.g. 0.1 * 5 = 0.5000000000000001).
  return Number((step * base).toPrecision(6));
}

/**
 * Metres per ground checker square: the 1-2-5 value nearest to
 * `min(0.5 m, maxDim / 10)`, at least 1 mm. Every model with maxDim >= 5 m
 * keeps the familiar 0.5 m squares; only smaller models get finer ones. An
 * empty scene keeps {@link GROUND_SQUARE_DEFAULT}.
 */
export function groundSquareSize(scale: ScaleLike | null): number {
  if (!scale || scale.empty || !(scale.maxDim > 0)) return GROUND_SQUARE_DEFAULT;
  return Math.max(nice125(Math.min(GROUND_SQUARE_DEFAULT, scale.maxDim / 10)), GROUND_SQUARE_MIN);
}

// ─── FPV ────────────────────────────────────────────────────────────────

/** Models at least this large (m) keep the human-scale FPV defaults. */
export const FPV_SMALL_MODEL_MAX_DIM = 3;
/** Human-scale FPV defaults (the old constants). */
export const FPV_DEFAULT_EYE_HEIGHT = 1.7;
export const FPV_DEFAULT_SPEED = 2.5;
export const FPV_DEFAULT_SPRINT_SPEED = 5.0;
/** A small model is crossed in about this many seconds at walk speed. */
export const FPV_CROSS_SECONDS = 3;

export interface FpvScaleDefaults {
  eyeHeight: number;
  speed: number;
  sprintSpeed: number;
}

/**
 * FPV eye height and walk / sprint speed for the scene scale.
 *
 * `maxDim < 3 m`: eye = `0.5 · maxDim` (≥ 0.5 mm), walk speed crosses the
 * model in {@link FPV_CROSS_SECONDS} (≥ 1 mm/s), sprint = 2 × walk. Larger
 * (or empty) scenes: 1.7 m, 2.5 m/s, 5 m/s as before.
 */
export function fpvScaleDefaults(scale: ScaleLike | null, out: FpvScaleDefaults): FpvScaleDefaults {
  if (!scale || scale.empty || !(scale.maxDim > 0) || scale.maxDim >= FPV_SMALL_MODEL_MAX_DIM) {
    out.eyeHeight = FPV_DEFAULT_EYE_HEIGHT;
    out.speed = FPV_DEFAULT_SPEED;
    out.sprintSpeed = FPV_DEFAULT_SPRINT_SPEED;
    return out;
  }
  const d = scale.maxDim;
  out.eyeHeight = Math.max(0.5 * d, 0.0005);
  out.speed = Math.max(d / FPV_CROSS_SECONDS, 0.001);
  out.sprintSpeed = 2 * out.speed;
  return out;
}

// ─── Shadow camera ──────────────────────────────────────────────────────

export interface ShadowCameraFit {
  /** Half extent of the orthographic shadow camera (m). */
  pad: number;
  near: number;
  far: number;
  /** Distance of the sun from the content centre (m). */
  sunDist: number;
}

/**
 * Shadow camera for content of `maxDim`: pad = `max(1.2·maxDim, 0.05)`,
 * near = `max(maxDim/1000, 1e-4)`, far = `max(4·maxDim, 0.5)`; the sun sits
 * `2·maxDim` (≥ pad) from the centre so the content lies between near and far.
 */
export function shadowCameraFor(maxDim: number, out: ShadowCameraFit): ShadowCameraFit {
  const d = Number.isFinite(maxDim) && maxDim > 0 ? maxDim : 0;
  out.pad = Math.max(d * 1.2, 0.05);
  out.near = Math.max(d / 1000, 1e-4);
  out.far = Math.max(d * 4, 0.5);
  out.sunDist = Math.max(d * 2, out.pad);
  return out;
}

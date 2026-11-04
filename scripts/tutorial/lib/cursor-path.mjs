// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Tutorial recorder (plan-2004) — the visible, human-looking mouse travel as a PURE function.
 *
 * `planMove` returns EXACTLY ONE sample per output frame. That is not a convenience: with Weg C
 * the runner dispatches exactly one `Input.dispatchMouseEvent` position per frame, so a second
 * position inside the same frame does not physically exist and must not appear in the trace.
 *
 * The duration comes from Fitts' law and is quantised IMMEDIATELY through the canonical frame
 * conversion — never with a literal clamp. `clamp(framesOf(T), 11, 36)` is a no-op at 30 fps and
 * the wrong direction at every other rate.
 */

import { framesAtMost, framesOf } from './tutorial-events.mjs';

/** Fitts constants of § 2.3 point 2 — seconds, fps-free. */
const FITTS_A = 0.15;
const FITTS_B = 0.12;
const MOVE_MIN_SEC = 0.35;
const MOVE_MAX_SEC = 1.2;

/**
 * Fitts duration in SECONDS; knows nothing about fps (the quantisation is `framesOf` /
 * `framesAtMost`).
 *
 * `T = clamp(0.15 + 0.12 * log2(D/W + 1), 0.35, 1.2)` s.
 */
export function moveDuration(distance, targetWidth) {
  const d = Math.max(0, Number(distance));
  const w = Math.max(1e-6, Number(targetWidth));
  const t = FITTS_A + FITTS_B * Math.log2(d / w + 1);
  return Math.min(MOVE_MAX_SEC, Math.max(MOVE_MIN_SEC, t));
}

/**
 * Frame count of one approach — the canonical clamp, derived from fps on every side.
 *
 * At 30 fps this yields `[11; 36]`, at 25 fps `[9; 30]`. The bounds are NEVER written as literals.
 */
export function moveFrames(distance, targetWidth, fps) {
  const t = moveDuration(distance, targetWidth);
  const lower = framesOf(MOVE_MIN_SEC, fps);
  const upper = framesAtMost(MOVE_MAX_SEC, fps);
  return Math.min(upper, Math.max(lower, framesOf(t, fps)));
}

/** mulberry32 over a FNV-1a hash of the seed string — deterministic per step and action index. */
function rng(seed) {
  let h = 2166136261 >>> 0;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Minimum-jerk progress: `s = 10t^3 - 15t^4 + 6t^5`. */
function minimumJerk(t) {
  return 10 * t ** 3 - 15 * t ** 4 + 6 * t ** 5;
}

function cubicBezier(p0, p1, p2, p3, s) {
  const u = 1 - s;
  return {
    x: u ** 3 * p0.x + 3 * u ** 2 * s * p1.x + 3 * u * s ** 2 * p2.x + s ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u ** 2 * s * p1.y + 3 * u * s ** 2 * p2.y + s ** 3 * p3.y,
  };
}

/**
 * The cursor path: one sample per output frame, the last sample EXACTLY on the target.
 *
 * @param from         current cursor position in viewport coordinates (client CSS-px = video-px at DPR 1)
 * @param to           target centre, same coordinate system
 * @param targetWidth  measured width of the target element in px (the `W` of Fitts)
 * @param seed         deterministic seed, by convention `<stepId>:<actionIndex>`
 * @param fps          REQUIRED — there is no default at the call site
 * @returns            `moveFrames` samples `{ frame, t, x, y }`; `frame` is relative (0-based)
 */
export function planMove(from, to, targetWidth, seed, fps) {
  // fps is validated inside framesOf/framesAtMost; calling without it must throw, not default.
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const count = moveFrames(distance, targetWidth, fps);
  const random = rng(seed);

  // Control points 10-20 % laterally offset, so the path bows like a hand movement.
  const nx = distance === 0 ? 0 : -(to.y - from.y) / distance;
  const ny = distance === 0 ? 0 : (to.x - from.x) / distance;
  const side = random() < 0.5 ? -1 : 1;
  const bow1 = distance * (0.1 + 0.1 * random()) * side;
  const bow2 = distance * (0.1 + 0.1 * random()) * side;
  const p1 = { x: from.x + (to.x - from.x) / 3 + nx * bow1, y: from.y + (to.y - from.y) / 3 + ny * bow1 };
  const p2 = { x: from.x + 2 * (to.x - from.x) / 3 + nx * bow2, y: from.y + 2 * (to.y - from.y) / 3 + ny * bow2 };

  const samples = [];
  for (let i = 0; i < count; i++) {
    // The LAST sample lands exactly on the target; the first on the start point.
    const linear = count === 1 ? 1 : i / (count - 1);
    const s = minimumJerk(linear);
    const point = i === count - 1 ? { x: to.x, y: to.y } : cubicBezier(from, p1, p2, to, s);
    samples.push({ frame: i, t: i / fps, x: point.x, y: point.y });
  }
  if (samples.length > 0) {
    samples[0].x = from.x;
    samples[0].y = from.y;
  }
  return samples;
}

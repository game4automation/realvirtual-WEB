// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * sensor-history-data — Deterministic fake sensor history generator.
 *
 * Generates per-sensor time-series (timestamp + state) deterministically by
 * keying a mulberry32 PRNG with a FNV-1a hash of the sensor's node path.
 * Consumers: SensorHistoryPanel (single + all-mode charts).
 *
 * The output is purely for visualization — no real signal subscriptions
 * are involved. Same sensor path + same window + same nowMs → same result.
 */

import type { WebSensorState } from '../engine/rv-web-sensor';
import type { SensorHistoryWindow } from './sensor-history-store';

// ─── PRNG ──────────────────────────────────────────────────────────────

/**
 * mulberry32 PRNG — Tomas R. Public domain.
 * 32-bit state, good distribution, seeds deterministically from uint32.
 * Reference: https://stackoverflow.com/a/47593316
 */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a 32-bit hash of a string. Used to seed the PRNG per sensor path.
 * Returns a non-negative integer in [0, 0xFFFFFFFF].
 */
export function hashPath(path: string): number {
  let h = 0x811C9DC5 >>> 0;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    // FNV prime 16777619 — use Math.imul for 32-bit overflow semantics
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ─── Generator constants ───────────────────────────────────────────────

export const WINDOW_SEC: Record<SensorHistoryWindow, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
};

/**
 * Sensor personality — determined by the first PRNG value per sensor.
 * Gives visual variety: some fast toggling, some slow, some mostly stuck.
 */
interface SensorPersonality {
  /** Dwell time multiplier (< 1 = fast, > 1 = slow). */
  dwellScale: number;
  /** Probability of actually transitioning (< 1 = tends to stay in current state). */
  transitionProb: number;
}

const PERSONALITIES: SensorPersonality[] = [
  { dwellScale: 1.0, transitionProb: 1.0 },   // normal
  { dwellScale: 0.3, transitionProb: 1.0 },   // fast toggler
  { dwellScale: 3.0, transitionProb: 1.0 },   // slow, long dwells
  { dwellScale: 1.0, transitionProb: 0.15 },  // mostly stuck (always-high or always-low)
  { dwellScale: 0.6, transitionProb: 0.8 },   // medium-fast, occasional skip
  { dwellScale: 5.0, transitionProb: 0.5 },   // very slow, half-transitions skipped
];

/** Base dwell time per state (min, max seconds). Scaled by personality. */
const DWELL_SEC: Record<WebSensorState, [number, number]> = {
  low:     [3, 12],
  high:    [1, 4],
  warning: [2, 6],
  error:   [1, 3],
  unbound: [10, 30],
};

/**
 * Markov transitions — rows sum to 1.0.
 * ISA-101: low↔high common, warning/error rare and recover quickly.
 */
const TRANSITIONS: Record<WebSensorState, Array<[WebSensorState, number]>> = {
  low:     [['high', 0.78], ['warning', 0.18], ['error', 0.04]],
  high:    [['low',  0.92], ['warning', 0.06], ['error', 0.02]],
  warning: [['low',  0.55], ['high',    0.40], ['error', 0.05]],
  error:   [['low',  0.60], ['high',    0.30], ['warning', 0.10]],
  unbound: [['unbound', 1]],
};

/** Map state → numeric y-axis value. */
const STATE_NUMERIC: Record<WebSensorState, number> = {
  low:     0,
  high:    1,
  warning: 2,
  error:   3,
  unbound: 0,
};

// ─── Public types ──────────────────────────────────────────────────────

export interface HistorySeries {
  /** Timestamps in milliseconds, sorted ascending. */
  ts: number[];
  /** Parallel array of WebSensor states. */
  state: WebSensorState[];
  /** Parallel array of numeric values (0=low, 1=high, 2=warning, 3=error). */
  numeric: number[];
}

// ─── Generator ─────────────────────────────────────────────────────────

/**
 * Pick the next state from a Markov transition table using the PRNG.
 * Walks the weighted list; last row guaranteed to catch residual.
 */
function pickNext(
  rng: () => number,
  rows: Array<[WebSensorState, number]>,
  allowNonBool: boolean,
): WebSensorState {
  // Filter to bool-only if the sensor is bool (isInt=false).
  const filtered = allowNonBool ? rows : rows.filter(([s]) => s === 'low' || s === 'high');
  if (filtered.length === 0) return 'low';
  // Re-normalize weights.
  let total = 0;
  for (const [, w] of filtered) total += w;
  if (total <= 0) return filtered[0][0];
  let r = rng() * total;
  for (const [state, w] of filtered) {
    r -= w;
    if (r <= 0) return state;
  }
  return filtered[filtered.length - 1][0];
}

/** Sample a dwell time in seconds within [min, max] for the given state. */
function sampleDwell(rng: () => number, state: WebSensorState): number {
  const [lo, hi] = DWELL_SEC[state] ?? [2, 8];
  return lo + rng() * (hi - lo);
}

/**
 * Generate deterministic sensor history for the given window ending at nowMs.
 *
 * @param sensorPath  Stable path used to seed the PRNG.
 * @param windowSec   Time window in seconds (e.g. 60 / 300 / 900 / 3600).
 * @param isInt       True if the sensor can go to warning/error; false = bool-only.
 * @param nowMs       End anchor; defaults to Date.now(). Tests should pin this.
 */
export function generateHistory(
  sensorPath: string,
  windowSec: number,
  isInt: boolean,
  nowMs: number = Date.now(),
): HistorySeries {
  const seed = hashPath(sensorPath);
  const rng = mulberry32(seed);

  // Pick a deterministic personality based on the first PRNG value.
  const personalityIdx = Math.floor(rng() * PERSONALITIES.length);
  const personality = PERSONALITIES[personalityIdx];

  const ts: number[] = [];
  const state: WebSensorState[] = [];
  const numeric: number[] = [];

  const startMs = nowMs - windowSec * 1000;

  // Initial state: "stuck" personalities start high or low based on seed.
  let cur: WebSensorState = rng() > 0.5 ? 'high' : 'low';
  let tMs = startMs;

  // Emit initial entry at the exact window start so charts have an anchor.
  ts.push(tMs);
  state.push(cur);
  numeric.push(STATE_NUMERIC[cur]);

  // Safety cap to avoid infinite loops on pathological PRNG seeds.
  const HARD_CAP = 10000;
  let steps = 0;

  while (tMs < nowMs && steps < HARD_CAP) {
    const dwell = sampleDwell(rng, cur) * personality.dwellScale;
    tMs += dwell * 1000;
    if (tMs > nowMs) tMs = nowMs;

    // Personality may suppress transitions (sensor stays in current state).
    let next: WebSensorState;
    if (rng() < personality.transitionProb) {
      next = pickNext(rng, TRANSITIONS[cur], isInt);
    } else {
      next = cur;  // stay in current state
      rng();       // consume PRNG value to keep determinism
    }
    cur = next;

    ts.push(tMs);
    state.push(cur);
    numeric.push(STATE_NUMERIC[cur]);
    steps++;
  }

  // Ensure the last entry closes exactly at nowMs for visual "now" alignment.
  // If the final transition landed earlier, extend the current state to nowMs.
  if (ts[ts.length - 1] < nowMs) {
    ts.push(nowMs);
    state.push(cur);
    numeric.push(STATE_NUMERIC[cur]);
  }

  return { ts, state, numeric };
}

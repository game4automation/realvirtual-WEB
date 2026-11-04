// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Deterministic pseudo-random numbers for the simulation (plan-664 Phase 1).
 *
 * ## Why this module exists
 *
 * Sensor noise must be REPRODUCIBLE: the same scene, the same seed and the same
 * tick sequence have to give bit-identical scans, otherwise multiuser sessions
 * drift apart and a recorded run cannot be replayed. `Math.random` is therefore
 * forbidden anywhere in the sensor path.
 *
 * Two identical copies of mulberry32 already existed in the code base
 * (`sensor-history-data.ts`, `perf/rv-synthetic-line.ts`); both now import from
 * here, and `tests/rv-ray-noise.node.test.ts` pins that their output stream is
 * unchanged to the bit.
 *
 * ## One stream per consumer
 *
 * Every sensor draws from its OWN stream, seeded from the master seed and its
 * node path. That is the whole point: with one shared stream the result of a
 * sensor would depend on how many other sensors drew before it in the same tick,
 * so adding a second scanner to a scene would change the first one's readings.
 *
 * ## Choice of generator
 *
 * mulberry32 (Tommy Ettinger, public domain): 32-bit state, passes gjrand, and
 * — unlike xoshiro128** — has no weak low bits, which matters because the
 * Box-Muller transform below consumes the full mantissa.
 */

/** A uniform random source over `[0, 1)`. */
export type Rng = () => number;

/**
 * mulberry32 — a 32-bit-state PRNG seeded deterministically from a uint32.
 * Public domain. Reference: https://stackoverflow.com/a/47593316
 *
 * Bit-for-bit the implementation that lived in `sensor-history-data.ts` and
 * `perf/rv-synthetic-line.ts`; do not "improve" it without re-pinning the
 * reference vectors in `tests/rv-ray-noise.node.test.ts`.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * FNV-1a 32-bit hash of a string → `[0, 0xFFFFFFFF]`. Used to turn a node path
 * into a seed, so two sensors in the same scene never share a stream and a
 * sensor keeps its stream across reloads.
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime, 32-bit overflow semantics
  }
  return h >>> 0;
}

/**
 * Seed of one consumer: the scene's master seed mixed with the consumer's path.
 *
 * Mixing rather than adding: `master + hash(path)` would make the pair
 * (master 1, path A) and (master 2, path B) collide whenever the hashes happen
 * to differ by one, and neighbouring master seeds would then produce
 * neighbouring — visibly correlated — streams.
 */
export function seedFor(master: number, path: string): number {
  const h = hashString(path);
  let x = (Math.imul(master >>> 0, 0x9e3779b1) ^ h) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * A standard normal source (mean 0, σ 1) over `rng`, Box-Muller with a pair
 * buffer: the transform produces two independent values per pair of uniforms,
 * and throwing the second away would both halve the throughput and — worse —
 * change the stream alignment, so the same seed would give different noise
 * depending on how many samples a scan happens to need.
 *
 * Allocation-free after construction: no array, no object per draw.
 */
export function gaussian(rng: Rng): () => number {
  let spare = 0;
  let hasSpare = false;
  return () => {
    if (hasSpare) { hasSpare = false; return spare; }
    // u is drawn away from 0 so log(u) stays finite; mulberry32 can return 0.
    let u = rng();
    while (u <= Number.MIN_VALUE) u = rng();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * rng();
    spare = r * Math.sin(theta);
    hasSpare = true;
    return r * Math.cos(theta);
  };
}

/**
 * One consumer's stream: the uniform source and its normal companion, both
 * drawing from the SAME underlying generator so the sequence stays a single
 * reproducible chain.
 */
export interface RandomStream {
  /** Uniform `[0, 1)`. */
  uniform: Rng;
  /** Standard normal (mean 0, σ 1). */
  normal: () => number;
  /** The seed this stream was built from (diagnostics / persistence). */
  readonly seed: number;
}

/** Build the stream of one consumer. `seed = 0` derives it from `master` + `path`. */
export function makeStream(master: number, path: string, seed = 0): RandomStream {
  const s = seed !== 0 ? seed >>> 0 : seedFor(master, path);
  const uniform = mulberry32(s);
  return { uniform, normal: gaussian(uniform), seed: s };
}

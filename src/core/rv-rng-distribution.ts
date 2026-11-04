// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-rng-distribution.ts -- Seedable PRNG and statistical distributions.
 *
 * SFC32 (Small Fast Counting) PRNG with 128-bit serializable state.
 * Seed derivation uses splitmix64 avalanche hash to ensure adjacent seeds
 * (0, 1, 2, ...) produce uncorrelated streams.
 *
 * All time-valued outputs are clamped to Math.max(0.001, value) to prevent
 * zero-time infinite event loops.
 *
 * Deliberately outside plugins/des/ (plan-2051 fix, des-public-boundary.node.test.ts):
 * a pure, zero-dependency leaf module used by core/fleet startup code (TaktSource) as
 * well as the DES plugin body (Downtime) -- startup code may not statically value-import
 * from plugins/des/** except through its workspace shell, so the shared RNG math lives
 * in core instead of being duplicated.
 */

// ── splitmix64 seed hash ──

/**
 * splitmix64 avalanche hash -- turns sequential seeds into well-distributed
 * 32-bit values. Used to derive the 4 initial state values for SFC32.
 */
function splitmix64(seed: number): () => number {
  let z = (seed >>> 0) + 0x9e3779b9;
  return (): number => {
    z = (z + 0x9e3779b9) >>> 0;
    let t = z ^ (z >>> 16);
    t = Math.imul(t, 0x85ebca6b);
    t = t ^ (t >>> 13);
    t = Math.imul(t, 0xc2b2ae35);
    t = t ^ (t >>> 16);
    return t >>> 0;
  };
}

// ── SFC32 PRNG ──

/** 4-tuple state for save/restore. */
export type SFC32State = [number, number, number, number];

/**
 * Historical 128-bit generator, frozen for legacy simulation sequences.
 * Its fourth word is derived from the output, unlike PractRand's counter.
 */
export class SFC32Legacy {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    const hash = splitmix64(seed);
    this.a = hash();
    this.b = hash();
    this.c = hash();
    this.d = hash();

    // Warm up 20 iterations to mix initial state
    for (let i = 0; i < 20; i++) this.next();
  }

  /** Returns a uniform random float in [0, 1). */
  next(): number {
    const a = this.a; const b = this.b;
    const c = this.c; const d = this.d;

    const t = (a + b + d) >>> 0;
    this.a = (b ^ (b >>> 9)) >>> 0;
    this.b = (c + (c << 3)) >>> 0;
    this.c = (((c << 21) | (c >>> 11)) + t) >>> 0;
    this.d = (t + 1) >>> 0;

    return t / 4294967296; // t / 2^32
  }

  /** Serialize state for snapshot. */
  getState(): SFC32State {
    return [this.a, this.b, this.c, this.d];
  }

  /** Restore state from snapshot -- deterministic continuation. */
  setState(s: SFC32State): void {
    [this.a, this.b, this.c, this.d] = s;
  }
}

// The historical stream remains the constructor used by all existing consumers.
export { SFC32Legacy as SFC32 };

/** PractRand sfc32 state, including its independent wrapping counter. */
export interface SFC32v2State { a: number; b: number; c: number; counter: number }

/** PractRand src/RNGs/sfc.cpp:78-91; reference fixtures pin seed and step. */
export class SFC32v2 {
  private a = 0;
  private b = 0;
  private c = 0;
  private counter = 1;

  private constructor() {}

  static fromSeed64(seed: bigint): SFC32v2 {
    const rng = new SFC32v2();
    const s = BigInt.asUintN(64, seed);
    rng.b = Number(s & 0xffffffffn);
    rng.c = Number(s >> 32n);
    for (let i = 0; i < 12; i++) rng.next();
    return rng;
  }

  /** Unsigned 32-bit output; no BigInt or allocation in the drawing path. */
  next(): number {
    const t = (this.a + this.b + this.counter) >>> 0;
    this.counter = (this.counter + 1) >>> 0;
    this.a = (this.b ^ (this.b >>> 9)) >>> 0;
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (((this.c << 21) | (this.c >>> 11)) + t) >>> 0;
    return t;
  }

  /** Same [0, 1) convention as SFC32Legacy.next(). */
  nextFloat(): number { return this.next() / 4294967296; }

  getState(): SFC32v2State {
    return { a: this.a, b: this.b, c: this.c, counter: this.counter };
  }

  setState(s: SFC32v2State): void {
    this.a = s.a >>> 0;
    this.b = s.b >>> 0;
    this.c = s.c >>> 0;
    this.counter = s.counter >>> 0;
  }
}

// ── Distributions ──

export interface RngSource { next(): number }
export type RngStreamState = SFC32State | SFC32v2State;
export interface RngStream extends RngSource {
  getState(): RngStreamState;
  setState(s: RngStreamState): void;
}

/** Minimum time output -- prevents zero-time infinite event loops. */
const MIN_TIME = 0.001;

/**
 * Exponential distribution with given mean.
 * mean = 1/rate, so rate = 1/mean.
 * Output clamped to >= 0.001.
 */
export function exponential(rng: RngSource, mean: number): number {
  // Inverse CDF: -mean * ln(1 - U), where U ~ Uniform[0,1)
  // Use (1 - rng.next()) to avoid ln(0)
  const u = 1 - rng.next();
  return Math.max(MIN_TIME, -mean * Math.log(u));
}

/**
 * Normal (Gaussian) distribution via Box-Muller transform.
 * Output clamped to >= 0.001 (for use as processing/transport time).
 */
export function normal(rng: RngSource, mean: number, stddev: number): number {
  // Box-Muller: generate two uniforms, return one normal
  const u1 = 1 - rng.next(); // avoid ln(0)
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(MIN_TIME, mean + stddev * z);
}

/**
 * Uniform distribution on [min, max].
 * Output clamped to >= 0.001.
 */
export function uniform(rng: RngSource, min: number, max: number): number {
  return Math.max(MIN_TIME, min + rng.next() * (max - min));
}

/**
 * Erlang distribution: sum of k independent exponential(1/rate) variables.
 * Mean = k / rate.
 * Output clamped to >= 0.001.
 */
export function erlang(rng: RngSource, k: number, rate: number): number {
  // Product of k uniforms, then -ln(product)/rate
  let product = 1;
  for (let i = 0; i < k; i++) {
    product *= (1 - rng.next()); // avoid ln(0)
  }
  return Math.max(MIN_TIME, -Math.log(product) / rate);
}

/**
 * Weibull distribution with shape k and scale lambda.
 * When k=1, degenerates to exponential with mean=lambda.
 * Output clamped to >= 0.001.
 */
export function weibull(rng: RngSource, k: number, lambda: number): number {
  // Inverse CDF: lambda * (-ln(1-U))^(1/k)
  const u = 1 - rng.next(); // avoid ln(0)
  return Math.max(MIN_TIME, lambda * Math.pow(-Math.log(u), 1 / k));
}

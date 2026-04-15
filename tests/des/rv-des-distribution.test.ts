// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestDESDistribution -- PRNG and distribution tests.
 *
 * Validates SFC32 reproducibility, state save/restore, seed independence,
 * and statistical properties of distributions.
 */

import { describe, it, expect } from 'vitest';
import {
  SFC32,
  exponential,
  normal,
  uniform,
  erlang,
  weibull,
} from '@rv-private/plugins/des/rv-des-distribution';

describe('DESDistribution', () => {
  it('exponential has correct mean (10K samples, within 10%)', () => {
    const rng = new SFC32(42);
    const targetMean = 5.0;
    const N = 10_000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      sum += exponential(rng, targetMean);
    }
    const mean = sum / N;
    expect(mean).toBeGreaterThan(4.5);
    expect(mean).toBeLessThan(5.5);
  });

  it('normal: ~68% of samples within 1 std dev', () => {
    const rng = new SFC32(42);
    const mu = 10.0;
    const sigma = 2.0;
    const N = 10_000;
    let withinOneStd = 0;
    for (let i = 0; i < N; i++) {
      const v = normal(rng, mu, sigma);
      if (v >= mu - sigma && v <= mu + sigma) withinOneStd++;
    }
    const ratio = withinOneStd / N;
    // 68% +/- 5% tolerance
    expect(ratio).toBeGreaterThan(0.60);
    expect(ratio).toBeLessThan(0.76);
  });

  it('erlang(k=3, rate=1) has mean ~3.0', () => {
    const rng = new SFC32(42);
    const N = 10_000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      sum += erlang(rng, 3, 1.0);
    }
    const mean = sum / N;
    expect(mean).toBeGreaterThan(2.7);
    expect(mean).toBeLessThan(3.3);
  });

  it('weibull(k=1, lambda=1) degenerates to exponential(mean=1)', () => {
    const rng = new SFC32(42);
    const N = 10_000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      sum += weibull(rng, 1, 1);
    }
    const mean = sum / N;
    // Exponential with lambda=1 has mean=1
    expect(mean).toBeGreaterThan(0.9);
    expect(mean).toBeLessThan(1.1);
  });

  it('all distributions output clamped to >= 0.001', () => {
    const rng = new SFC32(99);
    for (let i = 0; i < 1000; i++) {
      expect(exponential(rng, 0.0001)).toBeGreaterThanOrEqual(0.001);
      expect(normal(rng, 0, 0.0001)).toBeGreaterThanOrEqual(0.001);
      expect(uniform(rng, 0, 0.0001)).toBeGreaterThanOrEqual(0.001);
      expect(erlang(rng, 1, 10000)).toBeGreaterThanOrEqual(0.001);
      expect(weibull(rng, 1, 0.0001)).toBeGreaterThanOrEqual(0.001);
    }
  });

  it('sfc32 is reproducible from same seed', () => {
    const a = new SFC32(42);
    const b = new SFC32(42);
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('sfc32 state save/restore continues exact sequence', () => {
    const rng = new SFC32(42);
    // Advance 500 steps
    for (let i = 0; i < 500; i++) rng.next();
    const state = rng.getState();
    const expected = rng.next();

    // Restore into a fresh instance
    const restored = new SFC32(0); // seed doesn't matter, we'll overwrite state
    restored.setState(state);
    expect(restored.next()).toBe(expected);
  });

  it('splitmix64 produces uncorrelated streams from adjacent seeds', () => {
    const a = new SFC32(0);
    const b = new SFC32(1);
    const N = 1000;

    // Compute Pearson correlation coefficient
    const va: number[] = [];
    const vb: number[] = [];
    for (let i = 0; i < N; i++) {
      va.push(a.next());
      vb.push(b.next());
    }

    const meanA = va.reduce((s, v) => s + v, 0) / N;
    const meanB = vb.reduce((s, v) => s + v, 0) / N;

    let cov = 0, varA = 0, varB = 0;
    for (let i = 0; i < N; i++) {
      const da = va[i] - meanA;
      const db = vb[i] - meanB;
      cov += da * db;
      varA += da * da;
      varB += db * db;
    }

    const correlation = cov / Math.sqrt(varA * varB);
    expect(Math.abs(correlation)).toBeLessThan(0.05);
  });
});

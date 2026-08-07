// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-260 tests §9.5 — stochastic aggregation over N runs (F10):
 * mean, unbiased variance and the 95% CI half-width (t-distribution),
 * including the S5 edge cases (empty, single sample).
 */

import { describe, it, expect } from 'vitest';
import { aggregateRuns, tCritical95 } from '../src/core/material-flow/rv-run-aggregation';

describe('aggregateRuns (plan-260 §9.5)', () => {
  it('computes mean, variance and 95% CI over N runs', () => {
    const agg = aggregateRuns([0.78, 0.82, 0.80]);
    expect(agg.n).toBe(3);
    expect(agg.mean).toBeCloseTo(0.8, 10);
    // Unbiased variance of [0.78, 0.82, 0.80] = 0.0004
    expect(agg.variance).toBeCloseTo(0.0004, 10);
    // ci95 = t(df=2) * sqrt(var/n) = 4.303 * sqrt(0.0004/3)
    expect(agg.ci95).toBeCloseTo(4.303 * Math.sqrt(0.0004 / 3), 6);
    expect(agg.ci95).toBeGreaterThan(0);
  });

  it('empty input yields an all-zero aggregate (no NaN, S5)', () => {
    const agg = aggregateRuns([]);
    expect(agg).toEqual({ n: 0, mean: 0, variance: 0, ci95: 0 });
  });

  it('single sample: mean without variance/CI', () => {
    const agg = aggregateRuns([0.7]);
    expect(agg.n).toBe(1);
    expect(agg.mean).toBeCloseTo(0.7, 10);
    expect(agg.variance).toBe(0);
    expect(agg.ci95).toBe(0);
  });

  it('identical samples have zero variance and zero CI', () => {
    const agg = aggregateRuns([5, 5, 5, 5]);
    expect(agg.mean).toBe(5);
    expect(agg.variance).toBe(0);
    expect(agg.ci95).toBe(0);
  });

  it('t critical values: small-N inflation, z beyond df=30', () => {
    expect(tCritical95(1)).toBeCloseTo(12.706, 3);
    expect(tCritical95(10)).toBeCloseTo(2.228, 3);
    expect(tCritical95(100)).toBeCloseTo(1.96, 3);
    expect(tCritical95(0)).toBe(0);
  });
});

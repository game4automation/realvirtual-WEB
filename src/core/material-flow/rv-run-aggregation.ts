// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-run-aggregation.ts — stochastic aggregation over N simulation runs
 * (plan-260 F10): sample mean, sample variance and the 95% confidence
 * interval half-width over independent replications (different seeds).
 *
 * Pure math, no state. Uses the t-distribution critical value for small N
 * (the DES literature rule: CIs come from INDEPENDENT replications, samples
 * within one run are autocorrelated — plan-260 §8-C).
 */

export interface RunAggregate {
  /** Number of samples. */
  readonly n: number;
  /** Sample mean (0 when n = 0). */
  readonly mean: number;
  /** Unbiased sample variance (0 when n < 2). */
  readonly variance: number;
  /** 95% confidence interval half-width (mean ± ci95); 0 when n < 2. */
  readonly ci95: number;
}

/** Two-sided t critical values (α = 0.05) for df = 1..30; z beyond. */
const T_95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];
const Z_95 = 1.96;

/** t critical value for `df` degrees of freedom (two-sided 95%). */
export function tCritical95(df: number): number {
  if (df < 1) return 0;
  return df <= T_95.length ? T_95[df - 1] : Z_95;
}

/**
 * Aggregate a series of per-run sample values (fixed summation order —
 * plan-260 §5.3 float determinism). Empty input → all-zero aggregate (S5:
 * no NaN / division by zero).
 */
export function aggregateRuns(values: readonly number[]): RunAggregate {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, variance: 0, ci95: 0 };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;
  if (n < 2) return { n, mean, variance: 0, ci95: 0 };
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    sq += d * d;
  }
  const variance = sq / (n - 1);
  const ci95 = tCritical95(n - 1) * Math.sqrt(variance / n);
  return { n, mean, variance, ci95 };
}

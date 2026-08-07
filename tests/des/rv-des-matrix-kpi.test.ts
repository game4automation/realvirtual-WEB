// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-des-matrix-kpi-aggregation (plan-265 §9.5) — F5: KPI rows are mean ± 95%CI
 * over the replications, the aggregation filters to index < replicationCount
 * (a shrunk N never mixes in stale runs), an empty column renders "—" (no NaN),
 * and Δ-vs-baseline is correct.
 */

import { describe, it, expect } from 'vitest';
import { buildKpiRows } from '../../src/plugins/sim-controller/des-matrix-helpers';
import type { ExperimentInfo, RunInfo } from '../../src/core/material-flow/rv-run-history-store';
import type { SimDesStatistics } from '../../src/core/material-flow/simulation-kernel';

function stats(throughput: number, util: number): SimDesStatistics {
  return { simTime: 100, components: [], bottleneck: null, meanUtilization: util, throughputPerHour: throughput };
}

function run(index: number, throughput: number, util: number): RunInfo {
  return { index, seed: 42 + index, status: 'completed', stats: stats(throughput, util), checkpoints: [] };
}

function exp(name: string, replicationCount: number, runs: RunInfo[]): ExperimentInfo {
  return { model: 'M', experiment: name, baseSeed: 42, createdAt: 0, runs, replicationCount, paramOverrides: [], enabled: true, endTime: 0, statResetTime: 0 };
}

describe('DES matrix KPI aggregation', () => {
  it('computes mean ± 95%CI per experiment and Δ vs baseline', () => {
    const base = exp('Baseline', 2, [run(0, 100, 70), run(1, 120, 80)]); // mean tp 110, util 75
    const variant = exp('Fast', 2, [run(0, 140, 84), run(1, 160, 86)]);  // mean tp 150, util 85
    const rows = buildKpiRows([base, variant]);

    const tp = rows.find((r) => r.key === 'throughput')!;
    expect(tp.cells.get('Baseline')!.mean).toBeCloseTo(110, 6);
    expect(tp.cells.get('Baseline')!.deltaFromBaseline).toBeNull(); // baseline never diffs itself
    expect(tp.cells.get('Fast')!.mean).toBeCloseTo(150, 6);
    expect(tp.cells.get('Fast')!.deltaFromBaseline).toBeCloseTo(40, 6);
    expect(tp.cells.get('Fast')!.ci95).toBeGreaterThan(0); // n=2 → a real interval
  });

  it('filters to index < replicationCount (shrunk N ignores stale higher-index runs)', () => {
    // 3 archived runs but N reduced to 2 → run index 2 must NOT contribute.
    const e = exp('E', 2, [run(0, 100, 70), run(1, 100, 70), run(2, 1000, 99)]);
    const tp = buildKpiRows([e]).find((r) => r.key === 'throughput')!;
    expect(tp.cells.get('E')!.n).toBe(2);
    expect(tp.cells.get('E')!.mean).toBeCloseTo(100, 6); // the 1000 outlier is excluded
  });

  it('an empty column is flagged empty (renders "—", no NaN)', () => {
    const base = exp('Baseline', 1, [run(0, 100, 70)]);
    const empty = exp('NoRuns', 3, []);
    const rows = buildKpiRows([base, empty]);
    const tp = rows.find((r) => r.key === 'throughput')!;
    const cell = tp.cells.get('NoRuns')!;
    expect(cell.empty).toBe(true);
    expect(cell.n).toBe(0);
    expect(Number.isNaN(cell.mean)).toBe(false);
    expect(cell.deltaFromBaseline).toBeNull();
  });

  it('produces one row per KPI (throughput + utilization)', () => {
    const rows = buildKpiRows([exp('E', 1, [run(0, 100, 70)])]);
    expect(rows.map((r) => r.key)).toEqual(['throughput', 'utilization']);
    expect(rows.find((r) => r.key === 'utilization')!.cells.get('E')!.mean).toBeCloseTo(70, 6);
  });
});

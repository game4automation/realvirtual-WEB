// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-matrix-helpers.ts — pure pivot helpers for the DES Experiment Matrix
 * (plan-265 F1). Columns = experiments, rows = the UNION of parameter fields
 * across the visible experiments. Kept free of React/MUI so the pivot logic is
 * unit-testable in isolation (test 9.1).
 *
 * The KPI/result rows are assembled in the panel from `aggregateRuns` (plan-265
 * §2.6, F5) — this file owns only the parameter dimension + the baseline diff
 * derivation (F14), both pure.
 */

import type { ExperimentInfo, ParamOverrideInfo, RunInfo } from '../../core/material-flow/rv-run-history-store';
import { aggregateRuns } from '../../core/material-flow/rv-run-aggregation';
import type { SimDesStatistics } from '../../core/material-flow/simulation-kernel';

/** Cell value type for a matrix parameter cell. */
export type MatrixValue = boolean | number | string | null;

/** One experiment's cell in a parameter row. */
export interface MatrixParamCell {
  /** The override value for this experiment, or null when it uses the model default. */
  value: MatrixValue;
  /** True when this experiment explicitly overrides the field (vs. inheriting the default). */
  overridden: boolean;
  /** True when the value differs from the baseline column's value (F14). */
  diffFromBaseline: boolean;
}

/** One parameter row: a `component.field` across all experiment columns. */
export interface MatrixParamRow {
  /** Stable row key `${component}.${field}`. */
  key: string;
  /** Node hierarchy path of the override target (first experiment that defines it). */
  path: string;
  component: string;
  field: string;
  /** Per-experiment cells, keyed by experiment name. */
  cells: Map<string, MatrixParamCell>;
}

/** Override key of a single override (identifies a matrix row). */
function overrideKey(o: Pick<ParamOverrideInfo, 'component' | 'field'>): string {
  return `${o.component}.${o.field}`;
}

/**
 * Column order for the matrix: the baseline (first experiment) stays leftmost,
 * the rest keep their given order (F14 — the baseline is a fixed reference).
 * `experiments[0]` is treated as the baseline by convention.
 */
export function collectMatrixColumns(experiments: readonly ExperimentInfo[]): ExperimentInfo[] {
  return [...experiments];
}

/**
 * Build the parameter rows: the union of every `component.field` overridden by
 * ANY visible experiment. For each experiment a cell records its override value
 * (or null = model default → `overridden:false`) and whether it differs from the
 * baseline column (`experiments[0]`).
 *
 * A field the baseline overrides but a variant does not is `overridden:false` on
 * the variant (it falls back to the model default) AND `diffFromBaseline:true`
 * when that default-vs-baseline distinction is observable — but since the model
 * default is not known here, "diff from baseline" is derived purely from the two
 * override values: a variant with no override is considered to differ from a
 * baseline that DOES override (and vice-versa), and two overrides differ when
 * their values are not equal.
 */
export function collectMatrixRows(experiments: readonly ExperimentInfo[]): MatrixParamRow[] {
  const baseline = experiments[0];
  const baseByKey = new Map<string, ParamOverrideInfo>();
  if (baseline) for (const o of baseline.paramOverrides) baseByKey.set(overrideKey(o), o);

  // Union of keys in a stable, deterministic order (first appearance wins).
  const rowOrder: string[] = [];
  const rowMeta = new Map<string, { path: string; component: string; field: string }>();
  for (const exp of experiments) {
    for (const o of exp.paramOverrides) {
      const key = overrideKey(o);
      if (!rowMeta.has(key)) {
        rowMeta.set(key, { path: o.path, component: o.component, field: o.field });
        rowOrder.push(key);
      }
    }
  }

  return rowOrder.map((key) => {
    const meta = rowMeta.get(key)!;
    const base = baseByKey.get(key);
    const cells = new Map<string, MatrixParamCell>();
    for (const exp of experiments) {
      const ov = exp.paramOverrides.find((o) => overrideKey(o) === key);
      const overridden = ov !== undefined;
      const value: MatrixValue = ov ? ov.value : null;
      const isBaselineCol = exp === baseline;
      let diffFromBaseline = false;
      if (!isBaselineCol) {
        const baseOverridden = base !== undefined;
        if (overridden !== baseOverridden) diffFromBaseline = true;
        else if (overridden && baseOverridden) diffFromBaseline = ov!.value !== base!.value;
      }
      cells.set(exp.experiment, { value, overridden, diffFromBaseline });
    }
    return { key, path: meta.path, component: meta.component, field: meta.field, cells };
  });
}

// ─── KPI (result) rows ──────────────────────────────────────────────────────

/** One experiment's aggregated KPI cell (mean ± 95% CI over its replications). */
export interface MatrixKpiCell {
  /** Replications that contributed a value. */
  readonly n: number;
  readonly mean: number;
  /** 95% CI half-width (0 when n < 2). */
  readonly ci95: number;
  /** mean − baselineMean (null on the baseline column or when either has no data). */
  readonly deltaFromBaseline: number | null;
  /** True when this experiment yielded no usable runs (renders as "—"). */
  readonly empty: boolean;
}

/** One KPI (result) row across the experiment columns. */
export interface MatrixKpiRow {
  readonly key: string;
  readonly label: string;
  readonly unit?: string;
  /** Δ polarity: true = a higher value is an improvement (green ▲). Undefined
   *  when the direction is ambiguous (e.g. utilization) — the panel then
   *  renders the Δ neutrally instead of implying good/bad. */
  readonly higherIsBetter?: boolean;
  readonly cells: Map<string, MatrixKpiCell>;
}

/** A numeric KPI extractor over a run's archived statistics. */
interface KpiDef {
  key: string; label: string; unit?: string;
  higherIsBetter?: boolean;
  pick: (s: SimDesStatistics) => number;
}

const KPI_DEFS: ReadonlyArray<KpiDef> = [
  { key: 'throughput', label: 'Throughput', unit: '/h', higherIsBetter: true, pick: (s) => s.throughputPerHour },
  // Utilization has no universal "better" direction (higher can mean efficient
  // OR overloaded) — no polarity, the Δ renders neutral.
  { key: 'utilization', label: 'Mean utilization', unit: '%', pick: (s) => s.meanUtilization },
];

/**
 * The archived KPI values of an experiment for one metric, restricted to the
 * FIRST `replicationCount` replications (F5 / §2.5 — shrinking N must not mix in
 * stale higher-index runs). Runs without stats are skipped.
 */
function kpiValues(exp: ExperimentInfo, pick: (s: SimDesStatistics) => number): number[] {
  const n = exp.replicationCount;
  const out: number[] = [];
  for (const r of exp.runs as readonly RunInfo[]) {
    if (r.index >= n) continue;              // index < N filter
    if (!r.stats) continue;
    const v = pick(r.stats as SimDesStatistics);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * Build the KPI result rows: mean ± 95% CI per experiment over its replications
 * (only `index < replicationCount`), plus Δ against the baseline column
 * (`experiments[0]`). Empty columns yield `empty:true` (rendered as "—", never NaN).
 */
export function buildKpiRows(experiments: readonly ExperimentInfo[]): MatrixKpiRow[] {
  const baseline = experiments[0];
  return KPI_DEFS.map((def) => {
    const baseAgg = baseline ? aggregateRuns(kpiValues(baseline, def.pick)) : { n: 0, mean: 0, ci95: 0 };
    const cells = new Map<string, MatrixKpiCell>();
    for (const exp of experiments) {
      const agg = aggregateRuns(kpiValues(exp, def.pick));
      const empty = agg.n === 0;
      const isBaselineCol = exp === baseline;
      const deltaFromBaseline = (isBaselineCol || empty || baseAgg.n === 0)
        ? null : agg.mean - baseAgg.mean;
      cells.set(exp.experiment, { n: agg.n, mean: agg.mean, ci95: agg.ci95, deltaFromBaseline, empty });
    }
    return {
      key: def.key, label: def.label,
      ...(def.unit ? { unit: def.unit } : {}),
      ...(def.higherIsBetter !== undefined ? { higherIsBetter: def.higherIsBetter } : {}),
      cells,
    };
  });
}

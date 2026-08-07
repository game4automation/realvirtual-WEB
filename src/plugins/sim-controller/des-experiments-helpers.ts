// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-experiments-helpers.ts — pure helpers for the unified Experiments window
 * (`DESExperimentsPanel`). Kept free of React/MUI so the tree/compare logic is
 * unit-testable: run keys, seed → run-index resolution, cross-experiment
 * compare-ref collection and the model-version mismatch check.
 */

import type { ExperimentInfo, RunInfo } from '../../core/material-flow/rv-run-history-store';
import type { CompareRunRef } from './des-run-compare-store';

/** Stable selection key of a run — unique across the whole project tree. */
export function runKey(experiment: string, runIndex: number): string {
  return `${experiment}#${runIndex}`;
}

/**
 * The run (replication) index a snapshot at `seed` belongs to: an existing run
 * with that seed reuses its index, otherwise the next free index is assigned
 * (0 for an empty experiment).
 */
export function replIndexForSeed(runs: readonly RunInfo[], seed: number): number {
  const hit = runs.find((r) => r.seed === seed);
  if (hit) return hit.index;
  return runs.length === 0 ? 0 : Math.max(...runs.map((r) => r.index)) + 1;
}

/** Archived runs of an experiment, newest first (unarchived ones excluded). */
export function archivedRunsOf(exp: ExperimentInfo): RunInfo[] {
  return exp.runs
    .filter((r) => r.status !== undefined)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
}

/**
 * Collect the compare refs for the checked run keys — ACROSS all experiments
 * of the active project (the checkboxes work over the whole tree; the project
 * remains the comparison boundary by construction). Label format:
 * `Experiment · #Run (seed N)`.
 */
export function collectCompareRefs(
  experiments: readonly ExperimentInfo[],
  selected: ReadonlySet<string>,
): CompareRunRef[] {
  const refs: CompareRunRef[] = [];
  for (const exp of experiments) {
    for (const run of exp.runs) {
      if (run.status === undefined) continue;
      if (!selected.has(runKey(exp.experiment, run.index))) continue;
      refs.push({
        model: exp.model,
        exp: exp.experiment,
        repl: run.index,
        seed: run.seed,
        label: `${exp.experiment} · #${run.index} (seed ${run.seed})`,
      });
    }
  }
  return refs;
}

/**
 * True when the experiment's runs come from a DIFFERENT version of the model
 * than the one currently loaded (`glbHash` is the internal experiment identity
 * — it is never shown in the UI, only this hint is derived from it).
 */
export function hasVersionMismatch(
  exp: Pick<ExperimentInfo, 'glbHash'>,
  currentHash: string | null,
): boolean {
  return !!exp.glbHash && !!currentHash && exp.glbHash !== currentHash;
}

/** Human-readable byte size (B / KB / MB). */
export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

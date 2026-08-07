// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-run-compare-store.ts — shared selection for the run COMPARE mode
 * (plan-260 F9/F11). The public Experiments window (`DESExperimentsPanel`)
 * fills the selection — its checkboxes span ALL experiments of the ACTIVE
 * PROJECT, so the comparison stays strictly project-internal by construction;
 * the private DES compare panel subscribes and renders the multi-series
 * charts + mean ± CI table.
 */

import { createStore, type Store } from '../../core/hmi/create-store';

/** One selected run (addressed by its plan-261 storage identity). */
export interface CompareRunRef {
  readonly model: string;
  readonly exp: string;
  /** Replication index (= run). */
  readonly repl: number;
  readonly seed: number;
  /** Display label, e.g. "Experiment 1 · #2 (seed 42)". */
  readonly label: string;
}

export interface CompareState {
  /** Compare window open? */
  readonly open: boolean;
  /** Selected runs (project-internal by construction). */
  readonly runs: readonly CompareRunRef[];
}

export const desRunCompareStore: Store<CompareState> = createStore<CompareState>({
  open: false,
  runs: [],
});

export function openRunCompare(runs: readonly CompareRunRef[]): void {
  desRunCompareStore.set({ open: true, runs });
}

export function closeRunCompare(): void {
  desRunCompareStore.set((prev) => ({ ...prev, open: false }));
}

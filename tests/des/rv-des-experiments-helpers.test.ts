// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Pure DES experiment helpers (plans 260 + 261): run keys, seed → run-index
 * resolution, cross-experiment compare-ref collection, model-version mismatch
 * detection. The former tree-panel (`DESExperimentsPanel`) these helpers were
 * extracted for is gone — THE single Experiment Matrix window (plan-265) is
 * the one experiments surface; the helpers stay because the matrix (fmtBytes)
 * and the compare store contract still use them.
 */

import { describe, it, expect } from 'vitest';
import {
  runKey, replIndexForSeed, collectCompareRefs, hasVersionMismatch, archivedRunsOf,
} from '../../src/plugins/sim-controller/des-experiments-helpers';
import type { ExperimentInfo, RunInfo } from '../../src/core/material-flow/rv-run-history-store';

// ── Fixtures ──

function makeRunInfo(over: Partial<RunInfo> & Pick<RunInfo, 'index' | 'seed'>): RunInfo {
  return { status: 'completed', endedAt: 1000, simTimeReached: 60, checkpoints: [], ...over };
}

function makeExpInfo(over: Partial<ExperimentInfo> & Pick<ExperimentInfo, 'experiment'>): ExperimentInfo {
  return {
    model: 'M', baseSeed: 42, createdAt: 0, runs: [], replicationCount: 1,
    paramOverrides: [], enabled: true, endTime: 0, statResetTime: 0, ...over,
  };
}

// ── Pure helpers ──

describe('experiments helpers', () => {
  it('replIndexForSeed reuses an existing run index, otherwise the next free one', () => {
    expect(replIndexForSeed([], 42)).toBe(0);
    const runs = [makeRunInfo({ index: 0, seed: 42 }), makeRunInfo({ index: 2, seed: 7 })];
    expect(replIndexForSeed(runs, 7)).toBe(2);
    expect(replIndexForSeed(runs, 99)).toBe(3);
  });

  it('archivedRunsOf filters unarchived runs and sorts newest first', () => {
    const exp = makeExpInfo({
      experiment: 'E',
      runs: [
        makeRunInfo({ index: 0, seed: 1, endedAt: 100 }),
        { index: 1, seed: 2, checkpoints: [] }, // unarchived (no status)
        makeRunInfo({ index: 2, seed: 3, endedAt: 300 }),
      ],
    });
    expect(archivedRunsOf(exp).map((r) => r.index)).toEqual([2, 0]);
  });

  it('collectCompareRefs spans EXPERIMENT boundaries with the run-key selection', () => {
    const exps = [
      makeExpInfo({ experiment: 'Experiment 1', runs: [makeRunInfo({ index: 0, seed: 42 }), makeRunInfo({ index: 1, seed: 43 })] }),
      makeExpInfo({ experiment: 'Variant B', runs: [makeRunInfo({ index: 0, seed: 7 })] }),
    ];
    const selected = new Set([runKey('Experiment 1', 1), runKey('Variant B', 0)]);
    const refs = collectCompareRefs(exps, selected);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.exp)).toEqual(['Experiment 1', 'Variant B']);
    expect(refs[0].label).toBe('Experiment 1 · #1 (seed 43)');
    expect(refs[1].label).toBe('Variant B · #0 (seed 7)');
  });

  it('collectCompareRefs ignores unarchived runs even when their key is selected', () => {
    const exps = [makeExpInfo({ experiment: 'E', runs: [{ index: 0, seed: 1, checkpoints: [] }] })];
    expect(collectCompareRefs(exps, new Set([runKey('E', 0)]))).toHaveLength(0);
  });

  it('hasVersionMismatch only flags a DIFFERENT stored hash', () => {
    expect(hasVersionMismatch({ glbHash: 'a' }, 'b')).toBe(true);
    expect(hasVersionMismatch({ glbHash: 'a' }, 'a')).toBe(false);
    expect(hasVersionMismatch({}, 'a')).toBe(false);
    expect(hasVersionMismatch({ glbHash: 'a' }, null)).toBe(false);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-des-matrix-pivot-helpers (plan-265 §9.1) — F1: collectMatrixRows /
 * collectMatrixColumns pivot multiple ExperimentInfo into the correct
 * parameter-row × experiment-column structure; missing overrides fall back to
 * the model default (overridden:false); baseline diff (F14) is derived.
 */

import { describe, it, expect } from 'vitest';
import { collectMatrixRows, collectMatrixColumns } from '../../src/plugins/sim-controller/des-matrix-helpers';
import type { ExperimentInfo, ParamOverrideInfo } from '../../src/core/material-flow/rv-run-history-store';

function exp(name: string, overrides: ParamOverrideInfo[]): ExperimentInfo {
  return {
    model: 'M', experiment: name, baseSeed: 42, createdAt: 0, runs: [],
    replicationCount: 1, paramOverrides: overrides, enabled: true, endTime: 0, statResetTime: 0,
  };
}

const intervalA: ParamOverrideInfo = { path: 'Src', component: 'DESSource', field: 'Interval', value: 3.0 };
const intervalBase: ParamOverrideInfo = { path: 'Src', component: 'DESSource', field: 'Interval', value: 5.0 };
const capA: ParamOverrideInfo = { path: 'Buf', component: 'DESStation', field: 'Capacity', value: 40 };

describe('DES matrix pivot', () => {
  it('unions param fields across experiments and marks overrides', () => {
    // Baseline overrides Interval; A overrides Interval (differently) + Capacity; B overrides nothing.
    const expBase = exp('Baseline', [intervalBase]);
    const expA = exp('A', [intervalA, capA]);
    const expB = exp('B', []);

    const rows = collectMatrixRows([expBase, expA, expB]);
    const interval = rows.find((r) => r.key === 'DESSource.Interval');
    expect(interval).toBeDefined();

    expect(interval!.cells.get('Baseline')?.overridden).toBe(true);
    expect(interval!.cells.get('A')?.overridden).toBe(true);
    expect(interval!.cells.get('B')?.overridden).toBe(false); // default fallback
    expect(interval!.cells.get('B')?.value).toBe(null);

    // Union includes Capacity (only A overrides it).
    const cap = rows.find((r) => r.key === 'DESStation.Capacity');
    expect(cap).toBeDefined();
    expect(cap!.cells.get('A')?.overridden).toBe(true);
    expect(cap!.cells.get('Baseline')?.overridden).toBe(false);
  });

  it('derives diffFromBaseline (F14) — value diff and override-presence diff', () => {
    const expBase = exp('Baseline', [intervalBase]);
    const expA = exp('A', [intervalA]);      // same key, different value → diff
    const expB = exp('B', []);               // no override vs baseline override → diff

    const rows = collectMatrixRows([expBase, expA, expB]);
    const interval = rows.find((r) => r.key === 'DESSource.Interval')!;

    expect(interval.cells.get('Baseline')?.diffFromBaseline).toBe(false); // baseline never diffs itself
    expect(interval.cells.get('A')?.diffFromBaseline).toBe(true);
    expect(interval.cells.get('B')?.diffFromBaseline).toBe(true);
  });

  it('collectMatrixColumns keeps the baseline leftmost and order stable', () => {
    const cols = collectMatrixColumns([exp('Baseline', []), exp('A', []), exp('B', [])]);
    expect(cols.map((c) => c.experiment)).toEqual(['Baseline', 'A', 'B']);
  });

  it('returns no rows when nothing is overridden', () => {
    expect(collectMatrixRows([exp('Baseline', []), exp('A', [])])).toHaveLength(0);
  });
});

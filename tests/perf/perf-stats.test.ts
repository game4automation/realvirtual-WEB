// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-465 §9.3 — percentile maths and the heap-slope regression detector.
 *
 * These are the two pieces of arithmetic every number in a perf report passes
 * through, so they are pinned against hand-computed answers rather than against
 * whatever the implementation happens to return.
 */

import { describe, it, expect } from 'vitest';
import {
  heapSlopeMiBPerHour, percentile, percentiles,
} from '../../src/core/engine/perf/rv-perf-probe';

const MIB = 1024 * 1024;
const HOUR_MS = 3_600_000;

describe('percentiles (nearest-rank)', () => {
  it('returns hand-computable values for 1..100', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    // rank = ceil(p * n), value = sorted[rank - 1]
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile(values, 0.99)).toBe(99);
    expect(percentile(values, 1)).toBe(100);
  });

  it('does not depend on input order', () => {
    const ordered = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const shuffled = [7, 2, 10, 4, 1, 9, 3, 8, 5, 6];
    expect(percentiles(shuffled)).toEqual(percentiles(ordered));
  });

  it('is defined for the degenerate cases', () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentiles([]).count).toBe(0);
    expect(percentile([42], 0.99)).toBe(42);
  });

  it('reports max separately from p99', () => {
    const values = [...Array.from({ length: 99 }, () => 10), 500];
    const p = percentiles(values);
    expect(p.p99).toBe(10);       // rank 99 of 100 is still a fast sample
    expect(p.max).toBe(500);      // the outlier is only visible in max
  });
});

describe('heap slope (MiB/h)', () => {
  it('stays far inside the 5 MiB/h criterion for a sawtooth without drift', () => {
    // GC sawtooth around a flat mean: the value at the END of the run is
    // arbitrary, which is exactly why the criterion is a slope and not a delta.
    // A finite number of saw teeth leaves a small residual correlation with t;
    // what matters is that a 25 MiB swing with no underlying growth lands well
    // below the 5 MiB/h leak limit — and an order of magnitude below a real leak.
    const samples = Array.from({ length: 60 }, (_, i) => ({
      t: i * 60_000,
      heapUsed: (100 + (i % 6) * 5) * MIB,
    }));
    const sawtooth = Math.abs(heapSlopeMiBPerHour(samples));
    expect(sawtooth).toBeLessThan(5);

    const leaking = Array.from({ length: 60 }, (_, i) => ({
      t: i * 60_000,
      heapUsed: (100 + (i % 6) * 5 + i) * MIB,
    }));
    expect(heapSlopeMiBPerHour(leaking)).toBeGreaterThan(10 * sawtooth);
  });

  it('detects a steady climb of 1 MiB per sample', () => {
    // One sample per minute, +1 MiB each → 60 MiB/h.
    const samples = Array.from({ length: 60 }, (_, i) => ({
      t: i * 60_000,
      heapUsed: (100 + i) * MIB,
    }));
    expect(heapSlopeMiBPerHour(samples)).toBeCloseTo(60, 1);
  });

  it('measures a leak that a sawtooth is riding on', () => {
    const samples = Array.from({ length: 120 }, (_, i) => ({
      t: (i * HOUR_MS) / 60,           // 120 samples spanning two hours
      heapUsed: (200 + i * 0.5 + (i % 4) * 3) * MIB,
    }));
    // +0.5 MiB per sample, 60 samples per hour → 30 MiB/h.
    expect(heapSlopeMiBPerHour(samples)).toBeCloseTo(30, 0);
  });

  it('ignores samples without a heap reading, so GC and non-GC windows do not mix', () => {
    const withHeap = [
      { t: 0, heapUsed: 100 * MIB },
      { t: HOUR_MS, heapUsed: 105 * MIB },
    ];
    const mixed = [
      { t: 0, heapUsed: 100 * MIB },
      { t: HOUR_MS / 2 },                       // un-sampled window
      { t: HOUR_MS, heapUsed: 105 * MIB },
    ];
    expect(heapSlopeMiBPerHour(mixed)).toBeCloseTo(heapSlopeMiBPerHour(withHeap), 6);
    expect(heapSlopeMiBPerHour(withHeap)).toBeCloseTo(5, 6);
  });

  it('returns 0 rather than NaN when there is nothing to fit', () => {
    expect(heapSlopeMiBPerHour([])).toBe(0);
    expect(heapSlopeMiBPerHour([{ t: 0, heapUsed: MIB }])).toBe(0);
    // All samples at the same instant — a zero-variance x cannot define a slope.
    expect(heapSlopeMiBPerHour([
      { t: 5, heapUsed: MIB }, { t: 5, heapUsed: 2 * MIB },
    ])).toBe(0);
  });
});

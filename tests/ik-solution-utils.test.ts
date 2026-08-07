// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-solution-utils.test.ts — Pure-logic tests for the IK solution selection
 * helpers (reachable filter + dedupe, wrap-aware closest-index lookup).
 */

import { describe, it, expect } from 'vitest';
import {
  reachableSolutions,
  closestSolutionIndex,
  solutionDistanceSq,
} from '../src/core/engine/rv-ik-solution-utils';
import type { IKSolution } from '../src/core/engine/rv-ik-solver';

function sol(angles: number[], reachable = true): IKSolution {
  return { angles, reachable };
}

describe('reachableSolutions', () => {
  it('filters unreachable branches and keeps solver order', () => {
    const list = reachableSolutions([
      sol([0, 10, 20, 30, 40, 50]),
      sol([99, 99, 99, 99, 99, 99], false),
      sol([1, 11, 21, 31, 41, 51]),
    ]);
    expect(list).toEqual([
      [0, 10, 20, 30, 40, 50],
      [1, 11, 21, 31, 41, 51],
    ]);
  });

  it('dedupes configurations within the per-axis epsilon', () => {
    const list = reachableSolutions([
      sol([0, 10, 20, 30, 40, 50]),
      sol([0.001, 10.001, 20, 30, 40, 50]), // same configuration, numerical noise
      sol([0, 10, 20, 30, 40, 55]),          // genuinely different wrist
    ]);
    expect(list).toHaveLength(2);
  });

  it('treats ±180° wrap as the same angle when deduping', () => {
    const list = reachableSolutions([
      sol([180, 0, 0, 0, 0, 0]),
      sol([-180, 0, 0, 0, 0, 0]),
    ]);
    expect(list).toHaveLength(1);
  });

  it('returns copies (mutating the result must not touch the input)', () => {
    const input = [sol([1, 2, 3, 4, 5, 6])];
    const list = reachableSolutions(input);
    list[0][0] = 999;
    expect(input[0].angles[0]).toBe(1);
  });

  it('returns [] when nothing is reachable', () => {
    expect(reachableSolutions([sol([0, 0, 0, 0, 0, 0], false)])).toEqual([]);
  });
});

describe('closestSolutionIndex', () => {
  const solutions = [
    [0, 0, 0, 0, 0, 0],
    [90, 45, -30, 0, 60, 0],
    [-90, -45, 30, 0, -60, 0],
  ];

  it('finds the exact match', () => {
    expect(closestSolutionIndex(solutions, [90, 45, -30, 0, 60, 0])).toBe(1);
  });

  it('finds the nearest match for a perturbed reference', () => {
    expect(closestSolutionIndex(solutions, [-88, -44, 31, 1, -59, 0.5])).toBe(2);
  });

  it('unwraps 360°: a reference at 350° matches the branch at -10°', () => {
    const idx = closestSolutionIndex([[350, 0, 0, 0, 0, 0], [90, 0, 0, 0, 0, 0]], [-10, 0, 0, 0, 0, 0]);
    expect(idx).toBe(0);
  });

  it('returns -1 for an empty list', () => {
    expect(closestSolutionIndex([], [0, 0, 0, 0, 0, 0])).toBe(-1);
  });
});

describe('solutionDistanceSq', () => {
  it('is 0 for identical joint sets', () => {
    expect(solutionDistanceSq([1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6])).toBe(0);
  });

  it('uses the shorter way around the circle', () => {
    // 170 vs -170 → 20°, not 340°
    expect(solutionDistanceSq([170, 0, 0, 0, 0, 0], [-170, 0, 0, 0, 0, 0])).toBeCloseTo(400);
  });
});

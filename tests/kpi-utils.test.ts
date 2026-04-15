// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect } from 'vitest';
import { movingAverage } from '../src/core/hmi/kpi-utils';

describe('movingAverage', () => {
  test('output length equals input length', () => {
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toHaveLength(5);
  });

  test('correct 3-period average', () => {
    const result = movingAverage([10, 20, 30, 40, 50], 3);
    expect(result[2]).toBeCloseTo(20, 5);   // avg(10,20,30)
    expect(result[4]).toBeCloseTo(40, 5);   // avg(30,40,50)
  });

  test('partial window at start', () => {
    const result = movingAverage([10, 20, 30], 3);
    expect(result[0]).toBeCloseTo(10, 5);   // avg(10) — only 1 value
    expect(result[1]).toBeCloseTo(15, 5);   // avg(10,20)
  });

  test('empty array returns empty', () => {
    expect(movingAverage([], 3)).toHaveLength(0);
  });

  test('single element returns same value', () => {
    expect(movingAverage([42], 3)).toEqual([42]);
  });

  test('window of 1 returns original data', () => {
    const data = [5, 10, 15];
    expect(movingAverage(data, 1)).toEqual(data);
  });

  test('full-window average is correct', () => {
    // Window = data length => last element = average of all
    const result = movingAverage([2, 4, 6, 8, 10], 5);
    expect(result[4]).toBeCloseTo(6, 5);  // avg(2,4,6,8,10) = 6
  });
});

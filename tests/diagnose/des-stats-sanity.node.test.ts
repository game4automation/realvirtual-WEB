// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { checkDesStatsSanity } from '../../src/core/diagnostics/rv-des-stats-sanity';
import type { SimDesComponentStat, SimDesStatistics } from '../../src/core/material-flow/simulation-kernel';

const stats = (fields: Partial<SimDesComponentStat>): SimDesStatistics => ({
  simTime: 10, bottleneck: null, meanUtilization: 0, throughputPerHour: 0,
  components: [{ path: '/A', name: 'A', kind: 'conveyor', working: 0, setup: 0, blocked: 0,
    empty: 0, failure: 0, utilization: 0, outputPerHour: 0, totalProcessed: 0, currentState: 'Empty', ...fields }],
});

describe('DES statistics sanity', () => {
  it.each([
    [{ working: 70, blocked: 40 }, 'sum', 'shares-over-100'],
    [{ working: -3 }, 'working', 'negative'],
    [{ outputPerHour: Infinity }, 'outputPerHour', 'non-finite'],
    [{ outputPerHour: -1 }, 'outputPerHour', 'negative'],
    [{ failure: NaN }, 'failure', 'non-finite'],
    [{ transport: 101 }, 'transport', 'over-100'],
    [{ utilization: 101 }, 'utilization', 'utilization-over-100'],
    [{ working: 70, empty: 40 }, 'sum', 'shares-over-100'],
  ] as const)('reports %j', (fields, field, rule) => {
    const input = stats(fields);
    const before = structuredClone(input);
    expect(checkDesStatsSanity(input)).toMatchObject({ ok: false, issues: expect.arrayContaining([{ path: '/A', field, value: expect.any(Number), rule }]) });
    expect(input).toEqual(before);
  });
  it.each([{ working: 98.7 }, { utilization: 100.4 }, { working: 100.5 }, {}])('accepts %j', fields => {
    expect(checkDesStatsSanity(stats(fields))).toEqual({ ok: true, issues: [] });
  });
});

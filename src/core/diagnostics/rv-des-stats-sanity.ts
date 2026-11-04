// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { SimDesStatistics } from '../material-flow/simulation-kernel';

export const STATS_TOLERANCE_PP = 0.5;
export interface StatsIssue {
  path: string;
  field: string;
  value: number;
  rule: 'negative' | 'over-100' | 'shares-over-100' | 'non-finite' | 'utilization-over-100';
}

const shares = ['working', 'setup', 'blocked', 'empty', 'failure', 'transport', 'slowed', 'stopped'] as const;

/** Detect implausible statistics without changing the snapshot. */
export function checkDesStatsSanity(s: SimDesStatistics): { ok: boolean; issues: StatsIssue[] } {
  const issues: StatsIssue[] = [];
  const ceiling = 100 + STATS_TOLERANCE_PP;
  for (const c of s.components) {
    let sum = 0;
    for (const field of shares) {
      const value = c[field];
      if (value == null) continue;
      if (!Number.isFinite(value)) issues.push({ path: c.path, field, value, rule: 'non-finite' });
      else {
        sum += value;
        if (value < 0) issues.push({ path: c.path, field, value, rule: 'negative' });
        else if (value > ceiling) issues.push({ path: c.path, field, value, rule: 'over-100' });
      }
    }
    if (sum > ceiling) issues.push({ path: c.path, field: 'sum', value: sum, rule: 'shares-over-100' });
    if (c.utilization > ceiling) issues.push({ path: c.path, field: 'utilization', value: c.utilization, rule: 'utilization-over-100' });
    if (!Number.isFinite(c.outputPerHour)) issues.push({ path: c.path, field: 'outputPerHour', value: c.outputPerHour, rule: 'non-finite' });
    else if (c.outputPerHour < 0) issues.push({ path: c.path, field: 'outputPerHour', value: c.outputPerHour, rule: 'negative' });
  }
  return { ok: issues.length === 0, issues };
}

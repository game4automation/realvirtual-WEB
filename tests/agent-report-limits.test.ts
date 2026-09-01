// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import {
  MAX_CHART_BYTES,
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
  MAX_CHART_STRING,
  validateAgentChartSpec,
} from '../../realvirtual-WebViewer-Private~/src/plugins/agents/agent-report';

describe('agent report chart limits', () => {
  it('rejects non-finite values and caps series, points, and strings', () => {
    const chart = validateAgentChartSpec({
      type: 'line',
      title: 'T'.repeat(MAX_CHART_STRING + 20),
      labels: Array.from({ length: MAX_CHART_POINTS + 20 }, (_, index) => `L${index}`),
      series: Array.from({ length: MAX_CHART_SERIES + 3 }, (_, index) => ({
        name: `Series-${index}`.repeat(40),
        data: [index, Number.NaN, Number.POSITIVE_INFINITY, ...Array(MAX_CHART_POINTS).fill(index)],
      })),
    });
    expect(chart.series).toHaveLength(MAX_CHART_SERIES);
    expect(chart.labels).toHaveLength(MAX_CHART_POINTS);
    expect(chart.title).toHaveLength(MAX_CHART_STRING);
    expect(chart.series.every((series) => series.name.length <= MAX_CHART_STRING)).toBe(true);
    expect(chart.series.flatMap((series) => series.data).every(Number.isFinite)).toBe(true);
    expect(chart.series.every((series) => series.data.length <= MAX_CHART_POINTS)).toBe(true);
  });

  it('rejects over-budget chart payloads without throwing', () => {
    const raw = { type: 'line', blob: 'x'.repeat(MAX_CHART_BYTES + 1), series: [] };
    expect(() => validateAgentChartSpec(raw)).not.toThrow();
    const chart = validateAgentChartSpec(raw);
    expect(chart.type).toBe('table');
    expect(chart.fallback).toBe(true);
    expect(chart.warnings.join(' ')).toContain('exceeds');
  });
});

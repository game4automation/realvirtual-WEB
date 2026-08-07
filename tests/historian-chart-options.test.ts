// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { buildHistorianChartOption, LANE_PITCH } from '../src/core/hmi/historian-chart-options';
import { CHART_SERIES_PALETTE } from '../src/core/hmi/chart-theme';

describe('historian chart options', () => {
  it('builds a time axis with one line series per signal', () => {
    const option = buildHistorianChartOption([
      { signal: 'Speed', ts: [1_000, 2_000], values: [10, 20] },
    ]);

    expect(option.xAxis.type).toBe('time');
    expect(option.series).toHaveLength(1);
    // data = [ts, plotY, realValue] — the third slot feeds the tooltip.
    expect(option.series[0].data).toEqual([[1_000, 10, 10], [2_000, 20, 20]]);
  });

  it('uses distinct colors from the shared chart palette for overlays', () => {
    const option = buildHistorianChartOption([
      { signal: 'Speed', ts: [1_000], values: [10] },
      { signal: 'Pressure', ts: [1_000], values: [5] },
    ]);

    expect(option.color).toEqual([...CHART_SERIES_PALETTE]);
    expect(option.series[0].lineStyle.color).toBe(CHART_SERIES_PALETTE[0]);
    expect(option.series[1].lineStyle.color).toBe(CHART_SERIES_PALETTE[1]);
    expect(option.series[0].lineStyle.color).not.toBe(option.series[1].lineStyle.color);
  });

  it('keeps an empty historian response renderable', () => {
    const option = buildHistorianChartOption([]);
    expect(option.xAxis.type).toBe('time');
    expect(option.series).toEqual([]);
    expect(option.legend.data).toEqual([]);
  });

  it('renders a pure 0/1 series as a hold-last-value step line without LTTB', () => {
    const option = buildHistorianChartOption([
      { signal: 'GripperClosed', ts: [0, 1_000, 2_000], values: [0, 1, 0] },
    ]);
    expect(option.series[0].step).toBe('end');
    expect(option.series[0].sampling).toBeUndefined();
  });

  it('gives a digital-only chart a fixed High/Low axis instead of decimal ticks', () => {
    const option = buildHistorianChartOption([
      { signal: 'GripperClosed', ts: [0, 1_000], values: [1, 0] },
    ]);
    expect(option.yAxis.min).toBe(0);
    expect(option.yAxis.max).toBe(1);
    const format = option.yAxis.axisLabel.formatter as (v: number) => string;
    expect(format(1)).toBe('High');
    expect(format(0)).toBe('Low');
  });

  it('keeps the numeric axis when analog and digital series are mixed', () => {
    const option = buildHistorianChartOption([
      { signal: 'GripperClosed', ts: [0, 1_000], values: [1, 0] },
      { signal: 'Speed', ts: [0, 1_000], values: [120.5, 130.2] },
    ]);
    expect(option.yAxis.scale).toBe(true);
    expect(option.yAxis.min).toBeUndefined();
    expect(option.series[0].step).toBe('end');       // digital series still steps
    expect(option.series[1].step).toBeUndefined();   // analog stays interpolated
    expect(option.series[1].sampling).toBe('lttb');
  });

  it('stacked layout renders offset lanes with filled High bands', () => {
    const option = buildHistorianChartOption([
      { signal: 'A', ts: [0, 1_000], values: [1, 0] },
      { signal: 'B', ts: [0, 1_000], values: [0, 1] },
    ], 'stacked');
    // First selected signal renders on the TOP lane (base = PITCH), second at 0.
    expect(option.series[0].data).toEqual([[0, LANE_PITCH + 1, 1], [1_000, LANE_PITCH + 0, 0]]);
    expect(option.series[1].data).toEqual([[0, 0, 0], [1_000, 1, 1]]);
    expect(option.series[0].areaStyle?.origin).toBe(LANE_PITCH);
    expect(option.series[1].areaStyle?.origin).toBe(0);
    expect(option.series[0].endLabel?.formatter).toBe('A');
    // Lane mode hides the numeric axis (labels come from the lane end labels).
    const format = option.yAxis.axisLabel.formatter as (v: number) => string;
    expect(format(1)).toBe('');
  });

  it('overlay layout keeps multiple digital signals on the shared High/Low axis', () => {
    const option = buildHistorianChartOption([
      { signal: 'A', ts: [0], values: [1] },
      { signal: 'B', ts: [0], values: [0] },
    ], 'overlay');
    expect(option.series[0].data).toEqual([[0, 1, 1]]);   // no lane offset
    expect(option.series[1].data).toEqual([[0, 0, 0]]);
    expect(option.yAxis.max).toBe(1);
  });

  it('escapes signal names in the HTML tooltip (ECharts renders formatter output as HTML)', () => {
    const evil = 'Speed<img src=x onerror=alert(1)>';
    const option = buildHistorianChartOption([{ signal: evil, ts: [0], values: [5] }]);
    const html = (option.tooltip.formatter as (p: unknown) => string)([
      { seriesName: evil, marker: '', axisValueLabel: '12:00', data: [0, 5, 5] },
    ]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('uses sticky lane bounds when provided instead of the window min/max', () => {
    const option = buildHistorianChartOption(
      [{ signal: 'Speed', ts: [0, 1_000], values: [10, 20] }],
      'stacked',
      { Speed: { min: 0, max: 40 } },
    );
    // Normalized against 0..40 (sticky), not 10..20 (window): 10→0.25, 20→0.5.
    expect(option.series[0].data).toEqual([[0, 0.25, 10], [1_000, 0.5, 20]]);
  });

  it('survives very large series without a spread-argument overflow', () => {
    const values = new Array<number>(70_000).fill(0).map((_, i) => (i % 100) / 10);
    const ts = values.map((_, i) => i * 1_000);
    const option = buildHistorianChartOption([{ signal: 'Big', ts, values }], 'stacked');
    expect(option.series[0].data).toHaveLength(70_000);
  });

  it('stacked layout normalizes analog series into their lane and keeps the real value', () => {
    const option = buildHistorianChartOption([
      { signal: 'Speed', ts: [0, 1_000], values: [10, 20] },
      { signal: 'GripperClosed', ts: [0, 1_000], values: [0, 1] },
    ], 'stacked');
    // Analog lane (top): min→0, max→1 within the band; real values ride in slot 2.
    expect(option.series[0].data).toEqual([[0, LANE_PITCH + 0, 10], [1_000, LANE_PITCH + 1, 20]]);
    // Digital lane keeps its 0/1 band and High fill.
    expect(option.series[1].areaStyle?.origin).toBe(0);
  });

});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { generateHistory } from '../src/core/hmi/sensor-history-data';
import {
  buildSingleOption,
  buildAllOption,
  DEFAULT_CHART_THEME,
} from '../src/core/hmi/sensor-history-chart-options';
import type { SensorHistoryRef } from '../src/core/hmi/sensor-history-store';

const sensor: SensorHistoryRef = { path: 'Cell/B-IGC01', label: 'B-IGC01', isInt: true };
const theme = DEFAULT_CHART_THEME;

describe('buildSingleOption', () => {
  it('uses step line and visualMap.piecewise with 4 state colors', () => {
    const series = generateHistory(sensor.path, 60, true, 1_000_000);
    const opt = buildSingleOption(series, sensor, '5m', theme);
    const s = (opt.series as any[])[0];
    expect(s.step).toBe('start');
    expect(s.symbol).toBe('none');
    expect(s.progressive).toBe(1000);
    expect(s.large).toBe(true);

    const vm = opt.visualMap as any;
    expect(vm.type).toBe('piecewise');
    expect(vm.dimension).toBe(1);
    expect(vm.pieces).toHaveLength(4);
    // Piece values cover 0..3 (low, high, warning, error).
    expect(vm.pieces.map((p: any) => p.value)).toEqual([0, 1, 2, 3]);
  });

  it('y-axis covers all 4 states', () => {
    const series = generateHistory(sensor.path, 60, true, 1_000_000);
    const opt = buildSingleOption(series, sensor, '5m', theme);
    const y = opt.yAxis as any;
    expect(y.min).toBeLessThanOrEqual(0);
    expect(y.max).toBeGreaterThanOrEqual(3);
  });

  it('data tuples are [timestamp, numeric]', () => {
    const series = generateHistory(sensor.path, 60, true, 1_000_000);
    const opt = buildSingleOption(series, sensor, '5m', theme);
    const data = (opt.series as any[])[0].data as Array<[number, number]>;
    expect(data.length).toBe(series.ts.length);
    expect(data[0][0]).toBe(series.ts[0]);
    expect(data[0][1]).toBe(series.numeric[0]);
  });

  it('dataZoom has inside + slider', () => {
    const series = generateHistory(sensor.path, 60, true, 1_000_000);
    const opt = buildSingleOption(series, sensor, '5m', theme);
    const dz = opt.dataZoom as any[];
    expect(dz.length).toBe(2);
    const kinds = dz.map(d => d.type).sort();
    expect(kinds).toEqual(['inside', 'slider']);
  });
});

describe('buildAllOption', () => {
  it('creates one grid + xAxis + yAxis + series per sensor', () => {
    const sensors: SensorHistoryRef[] = [
      sensor,
      { ...sensor, path: 'Cell/B-IGC02', label: 'B-IGC02' },
    ];
    const allSeries = sensors.map(s => ({
      sensor: s,
      series: generateHistory(s.path, 60, true, 1_000_000),
    }));
    const opt = buildAllOption(allSeries, sensor.path, '5m', theme);
    expect((opt.grid as any[]).length).toBe(2);
    expect((opt.xAxis as any[]).length).toBe(2);
    expect((opt.yAxis as any[]).length).toBe(2);
    expect((opt.series as any[]).length).toBe(2);
  });

  it('shares zoom across all axes', () => {
    const allSeries = [{
      sensor,
      series: generateHistory(sensor.path, 60, true, 1_000_000),
    }];
    const opt = buildAllOption(allSeries, sensor.path, '5m', theme);
    const zooms = opt.dataZoom as any[];
    expect(zooms.some(z => z.xAxisIndex === 'all')).toBe(true);
  });

  it('axisPointer links across all xAxes', () => {
    const allSeries = [{
      sensor,
      series: generateHistory(sensor.path, 60, true, 1_000_000),
    }];
    const opt = buildAllOption(allSeries, sensor.path, '5m', theme);
    expect((opt.axisPointer as any).link).toEqual([{ xAxisIndex: 'all' }]);
  });

  it('collapses values to 0/1 in all-mode', () => {
    const sensors = [sensor];
    const allSeries = sensors.map(s => ({
      sensor: s,
      series: generateHistory(s.path, 60, true, 1_000_000),
    }));
    const opt = buildAllOption(allSeries, sensor.path, '5m', theme);
    const data = (opt.series as any[])[0].data as Array<[number, number]>;
    expect(data.every(([, v]) => v === 0 || v === 1)).toBe(true);
  });

  it('highlights the active sensor (heavier line, accent color)', () => {
    const sensors: SensorHistoryRef[] = [
      sensor,
      { ...sensor, path: 'Cell/B-IGC02', label: 'B-IGC02' },
    ];
    const allSeries = sensors.map(s => ({
      sensor: s,
      series: generateHistory(s.path, 60, true, 1_000_000),
    }));
    const opt = buildAllOption(allSeries, sensor.path, '5m', theme);
    const series = opt.series as any[];
    expect(series[0].lineStyle.color).toBe(theme.accent);
    expect(series[0].lineStyle.width).toBeGreaterThan(series[1].lineStyle.width);
  });

  it('x-axis shown only on the bottom-most grid', () => {
    const sensors: SensorHistoryRef[] = [
      sensor,
      { ...sensor, path: 'Cell/B-IGC02', label: 'B-IGC02' },
      { ...sensor, path: 'Cell/B-IGC03', label: 'B-IGC03' },
    ];
    const allSeries = sensors.map(s => ({
      sensor: s,
      series: generateHistory(s.path, 60, true, 1_000_000),
    }));
    const opt = buildAllOption(allSeries, sensor.path, '5m', theme);
    const x = opt.xAxis as any[];
    expect(x[0].show).toBe(false);
    expect(x[1].show).toBe(false);
    expect(x[2].show).toBe(true);
  });

  it('handles 0 sensors without crashing (no-op)', () => {
    const opt = buildAllOption([], '', '5m', theme);
    expect((opt.grid as any[]).length).toBe(0);
    expect((opt.xAxis as any[]).length).toBe(0);
    expect((opt.yAxis as any[]).length).toBe(0);
    expect((opt.series as any[]).length).toBe(0);
  });

  it('handles 1 sensor with x-axis shown on single row', () => {
    const allSeries = [{
      sensor,
      series: generateHistory(sensor.path, 60, true, 1_000_000),
    }];
    const opt = buildAllOption(allSeries, sensor.path, '5m', theme);
    const x = opt.xAxis as any[];
    expect(x.length).toBe(1);
    expect(x[0].show).toBe(true);
  });
});

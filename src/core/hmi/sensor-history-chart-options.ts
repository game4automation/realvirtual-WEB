// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * sensor-history-chart-options — ECharts option builders for the
 * SensorHistoryPanel (single-sensor and logic-analyzer all-mode).
 *
 * Single mode: step-line with visualMap.piecewise coloring per ISA-101 state.
 * All mode:    N stacked grids (one per WebSensor), shared zoom + cursor.
 *
 * Colors are read LIVE from WebSensorConfig.stateStyles so initWebSensor()
 * overrides are always reflected without re-initializing the chart module.
 */

import { WebSensorConfig, type WebSensorState } from '../engine/rv-web-sensor';
import type { HistorySeries } from './sensor-history-data';
import type { SensorHistoryRef, SensorHistoryWindow } from './sensor-history-store';

// ─── Theme ─────────────────────────────────────────────────────────────

export interface SensorHistoryChartTheme {
  accent:        string;  // highlight color for active sensor
  line:          string;  // non-active line color
  textSecondary: string;  // axis label / name color for non-active rows
}

/** Default theme — derived from rvDarkTheme accents. */
export const DEFAULT_CHART_THEME: SensorHistoryChartTheme = {
  accent:        '#4fc3f7',
  line:          '#888',
  textSecondary: '#aaa',
};

// ─── Helpers ───────────────────────────────────────────────────────────

const STATE_ORDER: WebSensorState[] = ['low', 'high', 'warning', 'error'];

function colorForState(s: WebSensorState): string {
  const c = WebSensorConfig.stateStyles[s].color;
  return '#' + c.toString(16).padStart(6, '0');
}

const STATE_LABEL: Record<WebSensorState, string> = {
  low:     'LOW',
  high:    'HIGH',
  warning: 'WARN',
  error:   'ERR',
  unbound: 'UNBOUND',
};

/** Formatter for time-axis labels based on selected window. */
function timeFormatter(window: SensorHistoryWindow): (val: number) => string {
  return (val: number) => {
    const d = new Date(val);
    // mm:ss for short windows (1m, 5m), HH:mm for longer windows (15m, 1h).
    const short = window === '1m' || window === '5m';
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    const s = d.getSeconds().toString().padStart(2, '0');
    return short ? `${m}:${s}` : `${h}:${m}`;
  };
}

/** Y-axis label formatter for single-mode: map numeric → state short label. */
function stateLabelFormatter(val: number): string {
  const idx = Math.round(val);
  return STATE_LABEL[STATE_ORDER[idx] ?? 'low'] ?? '';
}

// ─── Single-mode option ────────────────────────────────────────────────

/**
 * Build ECharts options for single-sensor step-line history with
 * per-segment state coloring via visualMap.piecewise.
 */
export function buildSingleOption(
  series: HistorySeries,
  _sensor: SensorHistoryRef,
  window: SensorHistoryWindow,
  theme: SensorHistoryChartTheme = DEFAULT_CHART_THEME,
): Record<string, unknown> {
  const data: Array<[number, number]> = new Array(series.ts.length);
  for (let i = 0; i < series.ts.length; i++) {
    data[i] = [series.ts[i], series.numeric[i]];
  }

  return {
    grid: { left: 60, right: 24, top: 24, bottom: 56 },
    xAxis: {
      type: 'time',
      axisLabel: {
        color: theme.textSecondary,
        formatter: timeFormatter(window),
      },
      axisLine: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
    },
    yAxis: {
      type: 'value',
      min: -0.2,
      max: 3.2,
      interval: 1,
      axisLabel: {
        color: theme.textSecondary,
        formatter: stateLabelFormatter,
      },
      splitNumber: 4,
      splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
    },
    visualMap: {
      type: 'piecewise',
      show: false,
      dimension: 1,
      seriesIndex: 0,
      pieces: [
        { value: 0, color: colorForState('low') },
        { value: 1, color: colorForState('high') },
        { value: 2, color: colorForState('warning') },
        { value: 3, color: colorForState('error') },
      ],
    },
    series: [{
      type: 'line',
      step: 'start',
      symbol: 'none',
      data,
      lineStyle: { width: 2 },
      progressive: 1000,
      large: true,
    }],
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(18,18,18,0.95)',
      borderColor: 'rgba(255,255,255,0.1)',
      textStyle: { color: '#fff' },
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params];
        const p = arr[0] as { value: [number, number] } | undefined;
        if (!p?.value) return '';
        const [t, n] = p.value;
        const stateIdx = Math.round(n);
        const state = STATE_ORDER[stateIdx] ?? 'low';
        const d = new Date(t);
        const hh = d.getHours().toString().padStart(2, '0');
        const mm = d.getMinutes().toString().padStart(2, '0');
        const ss = d.getSeconds().toString().padStart(2, '0');
        return `${hh}:${mm}:${ss} — ${STATE_LABEL[state]}`;
      },
    },
    dataZoom: [
      { type: 'inside' },
      { type: 'slider', height: 18, bottom: 8 },
    ],
  };
}

// ─── All-mode option (Logic-analyzer) ──────────────────────────────────

/** Input item for buildAllOption. */
export interface AllSeriesItem {
  sensor: SensorHistoryRef;
  series: HistorySeries;
}

const ROW_H = 28;       // px per track
const ROW_GAP = 6;      // px between tracks
const TOP_PAD = 12;     // top padding inside chart area
const BOTTOM_PAD = 56;  // room for time axis + slider

/**
 * Build ECharts options for the logic-analyzer multi-grid view
 * (one grid per sensor, shared zoom + cursor).
 *
 * Values collapse to 0/1 (low/high) regardless of int-state, so all tracks
 * share the same visual vocabulary.
 */
export function buildAllOption(
  allSeries: AllSeriesItem[],
  activePath: string,
  window: SensorHistoryWindow,
  theme: SensorHistoryChartTheme = DEFAULT_CHART_THEME,
): Record<string, unknown> {
  const N = Math.max(0, allSeries.length);

  const grid = allSeries.map((_, i) => ({
    left: 96,
    right: 24,
    top: TOP_PAD + i * (ROW_H + ROW_GAP),
    height: ROW_H,
  }));

  const xAxis = allSeries.map((_, i) => ({
    gridIndex: i,
    type: 'time',
    // Show axis labels only on the bottom-most grid to save vertical space.
    show: i === N - 1,
    axisLabel: {
      color: theme.textSecondary,
      formatter: timeFormatter(window),
    },
    axisLine: { lineStyle: { color: 'rgba(255,255,255,0.15)' } },
    splitLine: { show: false },
  }));

  const yAxis = allSeries.map(({ sensor }, i) => ({
    gridIndex: i,
    type: 'value',
    min: -0.2,
    max: 1.2,
    interval: 1,
    axisLabel: { show: false },
    axisTick: { show: false },
    axisLine: { show: false },
    splitLine: { show: false },
    name: sensor.label,
    nameLocation: 'middle',
    nameGap: 64,
    nameTextStyle: {
      color: sensor.path === activePath ? theme.accent : theme.textSecondary,
      fontWeight: sensor.path === activePath ? 'bold' : 'normal',
      fontSize: 11,
    },
  }));

  const series = allSeries.map(({ sensor, series: s }, i) => {
    // Collapse multi-state values to 0/1 for logic-analyzer presentation.
    const data: Array<[number, number]> = new Array(s.ts.length);
    for (let j = 0; j < s.ts.length; j++) {
      data[j] = [s.ts[j], s.numeric[j] >= 1 ? 1 : 0];
    }
    const isActive = sensor.path === activePath;
    return {
      type: 'line',
      step: 'start',
      symbol: 'none',
      xAxisIndex: i,
      yAxisIndex: i,
      data,
      lineStyle: {
        width: isActive ? 2.5 : 1.5,
        color: isActive ? theme.accent : theme.line,
      },
      areaStyle: {
        opacity: isActive ? 0.25 : 0.15,
        color: isActive ? theme.accent : theme.line,
      },
      progressive: 1000,
      large: true,
    };
  });

  const xAxisIndexAll = N > 0 ? ('all' as unknown as number) : 0;

  return {
    grid,
    xAxis,
    yAxis,
    series,
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      label: { backgroundColor: theme.accent },
      lineStyle: { color: 'rgba(255,255,255,0.35)' },
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      backgroundColor: 'rgba(18,18,18,0.95)',
      borderColor: 'rgba(255,255,255,0.1)',
      textStyle: { color: '#fff' },
    },
    dataZoom: [
      { type: 'inside', xAxisIndex: xAxisIndexAll },
      { type: 'slider', xAxisIndex: xAxisIndexAll, height: 18, bottom: 8 },
    ],
  };
}

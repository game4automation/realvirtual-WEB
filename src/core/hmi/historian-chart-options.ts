// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Pure ECharts option builder for CONNECT historian time series. */

import type { HistorianSeries } from './historian-store';
import {
  CHART_SERIES_PALETTE,
  DARK_AXIS_LABEL,
  DARK_AXIS_LINE,
  DARK_SPLIT_LINE,
  DARK_TEXT_STYLE,
  DARK_TOOLTIP_BASE,
} from './chart-theme';

/**
 * A series is digital when every point is exactly 0 or 1. CONNECT aggregates
 * bool signals with `max` (never `mean`), so recorded PLC bits arrive as pure
 * 0/1 — they render as step lines with a filled High area instead of an
 * interpolated analog curve.
 */
export function isDigitalSeries(entry: HistorianSeries): boolean {
  return entry.values.length > 0 && entry.values.every((value) => value === 0 || value === 1);
}

/** User-selectable chart layout: shared axis (overlay) or one lane per signal (stacked). */
export type HistorianChartLayout = 'overlay' | 'stacked';

/** Vertical distance between stacked lanes (1 signal band + gap). */
export const LANE_PITCH = 1.4;

interface TooltipParam {
  seriesName?: string;
  marker?: string;
  axisValueLabel?: string;
  data?: [number, number, number?];
}

/** ECharts renders tooltip-formatter strings as HTML — signal names come from
 *  the CONNECT response and must never reach the DOM unescaped. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;');
}

export function buildHistorianChartOption(
  series: readonly HistorianSeries[],
  layout: HistorianChartLayout = 'overlay',
  /** Sticky per-signal bounds (from the store) — keeps stacked lanes stable
   *  across live-follow refreshes instead of re-normalizing per window. */
  laneBounds?: Record<string, { min: number; max: number }>,
) {
  const allDigital = series.length > 0 && series.every(isDigitalSeries);
  const stacked = layout === 'stacked' && series.length > 0;
  const laneBase = (index: number): number => (stacked ? (series.length - 1 - index) * LANE_PITCH : 0);
  const digitalBySeries = new Map(series.map((entry) => [entry.signal, isDigitalSeries(entry)]));

  const formatReal = (signal: string | undefined, real: number | undefined): string => {
    if (real === undefined || Number.isNaN(real)) return '—';
    if (signal && digitalBySeries.get(signal)) return real >= 0.5 ? 'High' : 'Low';
    const rounded = Math.round(real * 1000) / 1000;
    return String(rounded === 0 ? 0 : rounded);   // normalizes "-0"
  };

  return {
    backgroundColor: 'transparent',
    textStyle: DARK_TEXT_STYLE,
    animation: false,
    color: [...CHART_SERIES_PALETTE],
    grid: { left: stacked ? 16 : 52, right: stacked ? 120 : 18, top: 28, bottom: 66 },
    tooltip: {
      ...DARK_TOOLTIP_BASE,
      trigger: 'axis' as const,
      axisPointer: { type: 'cross' as const, snap: true },
      // Stacked lanes plot normalized offsets; the tooltip must always report the
      // REAL value carried in data[2] (measurement-grade principle).
      formatter: (params: TooltipParam | TooltipParam[]) => {
        const list = Array.isArray(params) ? params : [params];
        if (list.length === 0) return '';
        const time = list[0].axisValueLabel ?? '';
        const rows = list.map((param) => {
          const real = param.data?.[2];   // real value always rides in slot 2
          return `${param.marker ?? ''}${escapeHtml(param.seriesName ?? '')}&nbsp;&nbsp;<b>${formatReal(param.seriesName, real)}</b>`;
        });
        return [time, ...rows].join('<br/>');
      },
    },
    legend: {
      type: 'scroll' as const,
      top: 0,
      data: series.map((entry) => entry.signal),
      textStyle: { color: 'rgba(255,255,255,0.7)', fontSize: 10 },
    },
    xAxis: {
      type: 'time' as const,
      axisLine: DARK_AXIS_LINE,
      axisLabel: DARK_AXIS_LABEL,
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value' as const,
      // Overlay + all digital: fixed High/Low domain — a PLC bit must never show
      // 0.2/0.4/0.6 ticks. Stacked: axis hidden, per-lane end labels identify signals.
      scale: !stacked && !allDigital,
      min: stacked ? -0.15 : allDigital ? 0 : undefined,
      max: stacked ? (series.length - 1) * LANE_PITCH + 1.15 : allDigital ? 1 : undefined,
      interval: !stacked && allDigital ? 1 : undefined,
      name: stacked || allDigital ? '' : 'Value',
      nameTextStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 10 },
      axisLine: stacked ? { show: false } : DARK_AXIS_LINE,
      axisLabel: {
        ...DARK_AXIS_LABEL,
        fontFamily: 'monospace',
        formatter: stacked
          ? () => ''
          : allDigital
            ? (value: number) => (value === 1 ? 'High' : value === 0 ? 'Low' : '')
            : undefined,
      },
      splitLine: stacked ? { show: false } : DARK_SPLIT_LINE,
    },
    dataZoom: [
      { type: 'inside' as const, filterMode: 'none' as const },
      {
        type: 'slider' as const,
        bottom: 12,
        height: 18,
        borderColor: 'rgba(255,255,255,0.08)',
        backgroundColor: 'rgba(255,255,255,0.03)',
        fillerColor: 'rgba(79,195,247,0.16)',
        textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 9 },
      },
    ],
    series: series.map((entry, index) => {
      const digital = isDigitalSeries(entry);
      const base = laneBase(index);
      const color = CHART_SERIES_PALETTE[index % CHART_SERIES_PALETTE.length];
      // Stacked analog lanes are min/max-normalized into their band; the real
      // value travels as data[2] for the tooltip. Digital bands are 0/1 as-is.
      // Bounds come from the store's sticky expand-only record when provided
      // (stable lanes under live-follow); loop-based fallback — a spread call
      // (Math.min(...values)) overflows the argument limit at ~65k points.
      let normalize = (value: number): number => value;
      if (stacked && !digital) {
        let min = entry.values.length > 0 ? entry.values[0] : 0;
        let max = min;
        for (const value of entry.values) {
          if (value < min) min = value;
          if (value > max) max = value;
        }
        const sticky = laneBounds?.[entry.signal];
        if (sticky) {
          min = Math.min(min, sticky.min);
          max = Math.max(max, sticky.max);
        }
        normalize = max > min ? (value: number) => (value - min) / (max - min) : () => 0.5;
      }
      return {
        name: entry.signal,
        type: 'line' as const,
        // Digital: hold-last-value step (a bit stays High until it falls) and no
        // LTTB — the downsampler is built for analog curves and can swallow the
        // short pulses that matter most on a PLC bit.
        step: digital ? ('end' as const) : undefined,
        sampling: digital || stacked ? undefined : ('lttb' as const),
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 1.5, color },
        itemStyle: { color },
        // Filled High band for digital signals (logic-analyzer convention).
        areaStyle: digital ? { color, opacity: 0.22, origin: base } : undefined,
        // Stacked lanes identify themselves at the right edge (axis is hidden).
        endLabel: stacked
          ? {
              show: true,
              formatter: entry.signal,
              color,
              fontSize: 10,
              width: 110,
              overflow: 'truncate' as const,
              offset: [4, 0],
            }
          : undefined,
        data: entry.ts.slice(0, entry.values.length).map((timestamp, pointIndex) => [
          timestamp,
          base + normalize(entry.values[pointIndex]),
          entry.values[pointIndex],
        ]),
      };
    }),
  };
}

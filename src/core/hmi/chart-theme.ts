// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared ECharts dark theme factory for the WebViewer.
 *
 * All charts use the same base styling (dark background, light text,
 * axis colors, tooltip styling). Per-chart customization is done via
 * spread overrides on the returned option object.
 */

/** Dark-theme text style for chart content. */
export const DARK_TEXT_STYLE = {
  fontFamily: 'Inter, Roboto, Arial, sans-serif',
  color: 'rgba(255,255,255,0.7)',
} as const;

/** Dark-theme title text style. */
export const DARK_TITLE_STYLE = {
  color: 'rgba(255,255,255,0.5)',
  fontSize: 11,
  fontWeight: 500,
} as const;

/** Dark-theme axis line style. */
export const DARK_AXIS_LINE = { lineStyle: { color: 'rgba(255,255,255,0.1)' } } as const;

/** Dark-theme axis label style. */
export const DARK_AXIS_LABEL = { color: 'rgba(255,255,255,0.3)', fontSize: 10 } as const;

/** Dark-theme split line style. */
export const DARK_SPLIT_LINE = { lineStyle: { color: 'rgba(255,255,255,0.04)' } } as const;

/** Dark-theme tooltip base configuration. */
export const DARK_TOOLTIP_BASE = {
  trigger: 'axis' as const,
  backgroundColor: 'rgba(10,10,10,0.92)',
  borderColor: 'rgba(255,255,255,0.06)',
  textStyle: { color: '#fff', fontSize: 11 },
};

interface BaseChartOptions {
  title?: string;
  legendData?: string[];
  scrollLegend?: boolean;
  grid?: { left?: number; right?: number; top?: number; bottom?: number };
  animate?: boolean;
}

/**
 * Build a base ECharts option with dark theme defaults.
 * Override per chart as needed via spread.
 */
export function createBaseChartOption(opts: BaseChartOptions = {}): Record<string, unknown> {
  const {
    title,
    legendData = [],
    scrollLegend = false,
    grid = { left: 50, right: 12, top: 24, bottom: 42 },
    animate = false,
  } = opts;

  return {
    backgroundColor: 'transparent',
    textStyle: DARK_TEXT_STYLE,
    ...(title && {
      title: { text: title, left: 8, top: 2, textStyle: DARK_TITLE_STYLE },
    }),
    legend: {
      data: legendData,
      bottom: 0,
      textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 10 },
      itemWidth: 12,
      itemHeight: 8,
      ...(scrollLegend && {
        type: 'scroll' as const,
        pageTextStyle: { color: 'rgba(255,255,255,0.5)' },
        pageIconColor: 'rgba(255,255,255,0.4)',
        pageIconInactiveColor: 'rgba(255,255,255,0.12)',
      }),
    },
    tooltip: DARK_TOOLTIP_BASE,
    grid,
    xAxis: {
      type: 'category' as const,
      axisLine: DARK_AXIS_LINE,
      axisLabel: DARK_AXIS_LABEL,
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value' as const,
      axisLine: DARK_AXIS_LINE,
      axisLabel: DARK_AXIS_LABEL,
      splitLine: DARK_SPLIT_LINE,
    },
    ...(animate && { animationDuration: 500, animationEasing: 'cubicOut' }),
  };
}

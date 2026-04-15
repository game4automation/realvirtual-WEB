// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared chart constants — used by DriveChartOverlay, SensorChartOverlay,
 * and any future real-time chart overlays.
 *
 * Note: Palettes are intentionally separate per chart type (different ordering).
 */

/** Time period durations for real-time chart overlays (seconds). */
export type TimePeriod = 30 | 60 | 120 | 300;
export const PERIOD_OPTIONS: readonly TimePeriod[] = [30, 60, 120, 300] as const;

/** Data sampling rate (points per second). */
export const CHART_SAMPLE_RATE = 10;

/** Chart data refresh interval (ms). */
export const CHART_REFRESH_INTERVAL = 200;

/** Default chart overlay width (px). */
export const CHART_DEFAULT_WIDTH = 700;

/** Drive chart color palette (cyan-first). */
export const DRIVE_PALETTE = [
  '#4fc3f7', '#e94078', '#66bb6a', '#ffa726', '#ab47bc',
  '#26c6da', '#ef5350', '#ffee58', '#8d6e63', '#78909c',
  '#ec407a', '#7e57c2', '#29b6f6', '#9ccc65', '#ff7043',
  '#5c6bc0', '#26a69a', '#d4e157', '#f44336', '#42a5f5',
] as const;

/** Sensor chart color palette (green-first). */
export const SENSOR_PALETTE = [
  '#66bb6a', '#4fc3f7', '#ffa726', '#ef5350', '#ab47bc',
  '#26c6da', '#e94078', '#ffee58', '#8d6e63', '#78909c',
  '#ec407a', '#7e57c2', '#29b6f6', '#9ccc65', '#ff7043',
  '#5c6bc0', '#26a69a', '#d4e157', '#f44336', '#42a5f5',
] as const;

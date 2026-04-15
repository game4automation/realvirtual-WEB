// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PartsChart — 24h bar chart showing parts per hour with target line and moving average.
 *
 * Bars are color-coded: green (>= target), amber (85-99%), red (< 85%).
 * Includes a dashed target markLine and a 3-hour moving average line.
 */

import { useEffect } from 'react';
import { Box } from '@mui/material';
import { ChartPanel } from '../../core/hmi/ChartPanel';
import { useKpiData } from '../../hooks/use-kpi-data';
import { movingAverage } from '../../core/hmi/kpi-utils';
import { useEChart } from '../../hooks/use-echart';
import { createBaseChartOption } from '../../core/hmi/chart-theme';

interface PartsChartProps {
  open: boolean;
  onClose: () => void;
}

function barColor(value: number, target: number): string {
  const ratio = value / target;
  if (ratio >= 1) return '#22c55e';     // Green: at or above target
  if (ratio >= 0.85) return '#f59e0b';  // Amber: 85-99%
  return '#ef4444';                      // Red: below 85%
}

export function PartsChart({ open, onClose }: PartsChartProps) {
  const kpi = useKpiData();
  const { containerRef: chartRef, chartInstance } = useEChart({ open });

  useEffect(() => {
    if (!open || !kpi) return;
    const timer = setTimeout(() => {
      const chart = chartInstance.current;
      if (!chart) return;

      const data = kpi.partsData;
      const target = kpi.partsTarget;
      const values = data.map((d) => d.parts);
      const ma = movingAverage(values, 3);

      const base = createBaseChartOption({
        title: 'Parts per Hour \u2014 Last 24h',
        legendData: ['Parts/h', '3h Average'],
        grid: { left: 45, right: 12, top: 24, bottom: 42 },
        animate: true,
      });

      chart.setOption(
        {
          ...base,
          xAxis: {
            ...(base.xAxis as object),
            data: data.map((d) => d.hour),
          },
          series: [
            {
              name: 'Parts/h',
              type: 'bar',
              data: values.map((v) => ({
                value: v,
                itemStyle: { color: barColor(v, target) },
              })),
              barMaxWidth: 20,
              markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { type: 'dashed', color: '#60a5fa', width: 1.5 },
                label: {
                  formatter: `Target: ${target}`,
                  color: '#60a5fa',
                  fontSize: 10,
                },
                data: [{ yAxis: target }],
              },
            },
            {
              name: '3h Average',
              type: 'line',
              data: ma.map((v) => Math.round(v)),
              smooth: true,
              symbol: 'none',
              lineStyle: { color: '#a78bfa', width: 2 },
              itemStyle: { color: '#a78bfa' },
            },
          ],
        },
        { notMerge: true },
      );
    }, 100);
    return () => clearTimeout(timer);
  }, [open, kpi]);

  return (
    <ChartPanel
      open={open}
      onClose={onClose}
      title="Parts per Hour"
      titleColor="#4fc3f7"
      subtitle="Last 24h"
      defaultWidth={700}
      defaultHeight={340}
      zIndex={1400}
    >
      <Box ref={chartRef} sx={{ flex: 1, minHeight: 0 }} />
    </ChartPanel>
  );
}

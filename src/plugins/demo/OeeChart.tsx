// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * OeeChart — 24h stacked bar chart showing OEE breakdown by category.
 *
 * Categories (ISA-95): Production, Waiting, Blocked, Loading, Toolchange, Downtime.
 * Each 30-minute bucket sums to 100%.
 */

import { useEffect } from 'react';
import { Box } from '@mui/material';
import { ChartPanel } from '../../core/hmi/ChartPanel';
import { useKpiData } from '../../hooks/use-kpi-data';
import { useEChart } from '../../hooks/use-echart';
import { createBaseChartOption, DARK_TOOLTIP_BASE } from '../../core/hmi/chart-theme';

const CATEGORIES = [
  { key: 'production', name: 'Production', color: '#22c55e' },
  { key: 'waiting', name: 'Waiting', color: '#f59e0b' },
  { key: 'blocked', name: 'Blocked', color: '#f97316' },
  { key: 'loading', name: 'Loading', color: '#38bdf8' },
  { key: 'toolchange', name: 'Toolchange', color: '#06b6d4' },
  { key: 'downtime', name: 'Downtime', color: '#ef4444' },
] as const;

interface OeeChartProps {
  open: boolean;
  onClose: () => void;
}

export function OeeChart({ open, onClose }: OeeChartProps) {
  const kpi = useKpiData();
  const { containerRef: chartRef, chartInstance } = useEChart({ open });

  // Set chart data
  useEffect(() => {
    if (!open || !kpi) return;
    const timer = setTimeout(() => {
      const chart = chartInstance.current;
      if (!chart) return;

      const data = kpi.oeeData;
      // Show only hourly labels (skip :30 buckets)
      const xLabels = data.map((d) => d.time);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const series: any[] = CATEGORIES.map((cat) => ({
        name: cat.name,
        type: 'bar',
        stack: 'oee',
        data: data.map((d) => d[cat.key]),
        itemStyle: { color: cat.color },
        emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(0,0,0,0.3)' } },
        barMaxWidth: 14,
      }));

      const base = createBaseChartOption({
        title: 'OEE Breakdown \u2014 Last 24h',
        legendData: CATEGORIES.map((c) => c.name),
        grid: { left: 45, right: 12, top: 24, bottom: 42 },
        animate: true,
      });

      chart.setOption(
        {
          ...base,
          tooltip: {
            ...DARK_TOOLTIP_BASE,
            formatter: (params: unknown) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const ps = params as any[];
              if (!ps.length) return '';
              let html = `<b>${ps[0].axisValue}</b><br/>`;
              for (const p of ps) {
                html += `${p.marker} ${p.seriesName}: <b>${p.value.toFixed(1)}%</b><br/>`;
              }
              return html;
            },
          },
          xAxis: {
            ...(base.xAxis as object),
            data: xLabels,
            axisLabel: {
              color: 'rgba(255,255,255,0.3)',
              fontSize: 10,
              interval: 1,
            },
          },
          yAxis: {
            ...(base.yAxis as object),
            max: 100,
            axisLabel: {
              color: 'rgba(255,255,255,0.3)',
              fontSize: 10,
              formatter: '{value}%',
            },
          },
          series,
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
      title="OEE Breakdown"
      titleColor="#66bb6a"
      subtitle="Last 24h"
      defaultWidth={750}
      defaultHeight={340}
      zIndex={1400}
    >
      <Box ref={chartRef} sx={{ flex: 1, minHeight: 0 }} />
    </ChartPanel>
  );
}

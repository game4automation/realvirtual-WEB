// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CycleTimeChart — Scatter + zone bands chart for the last 100 cycles.
 *
 * Shows individual cycle times as dots, colored by zone (green/amber/red).
 * Includes a takt time markLine and 10-cycle moving average.
 */

import { useEffect } from 'react';
import { Box } from '@mui/material';
import { ChartPanel } from '../../core/hmi/ChartPanel';
import { useKpiData } from '../../hooks/use-kpi-data';
import { movingAverage } from '../../core/hmi/kpi-utils';
import { useEChart } from '../../hooks/use-echart';
import { createBaseChartOption, DARK_TOOLTIP_BASE } from '../../core/hmi/chart-theme';

interface CycleTimeChartProps {
  open: boolean;
  onClose: () => void;
}

function dotColor(ms: number, takt: number): string {
  const s = ms / 1000;
  const taktS = takt / 1000;
  if (s <= taktS * 1.05) return '#22c55e';    // Green: within ±5% of takt
  if (s <= taktS * 1.20) return '#f59e0b';    // Amber: +5% to +20%
  return '#ef4444';                             // Red: >+20%
}

export function CycleTimeChart({ open, onClose }: CycleTimeChartProps) {
  const kpi = useKpiData();
  const { containerRef: chartRef, chartInstance } = useEChart({ open });

  useEffect(() => {
    if (!open || !kpi) return;
    const timer = setTimeout(() => {
      const chart = chartInstance.current;
      if (!chart) return;

      const data = kpi.cycleTimeData;
      const takt = kpi.taktTimeMs;
      const taktS = takt / 1000;
      const xData = data.map((_, i) => i + 1);
      const ma = movingAverage(data, 10);

      // Zone boundaries in seconds
      const greenUpper = taktS * 1.05;  // 126s at 120s takt
      const amberUpper = taktS * 1.20;  // 144s at 120s takt

      const base = createBaseChartOption({
        title: 'Cycle Time \u2014 Last 100 Cycles',
        legendData: ['Cycle Time', '10-Cycle Avg'],
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
              let html = `<b>Cycle #${ps[0].axisValue}</b><br/>`;
              for (const p of ps) {
                const v = typeof p.value === 'number' ? p.value : (p.value as number[])?.[1] ?? p.value;
                html += `${p.marker} ${p.seriesName}: <b>${(v / 1000).toFixed(1)}s</b><br/>`;
              }
              return html;
            },
          },
          xAxis: {
            ...(base.xAxis as object),
            data: xData,
            axisLabel: {
              color: 'rgba(255,255,255,0.3)',
              fontSize: 10,
              interval: 9,
            },
          },
          yAxis: {
            ...(base.yAxis as object),
            axisLabel: {
              color: 'rgba(255,255,255,0.3)',
              fontSize: 10,
              formatter: (v: number) => `${(v / 1000).toFixed(0)}s`,
            },
          },
          series: [
            // Zone bands (invisible lines with area fill)
            {
              name: '_greenZone',
              type: 'line',
              data: xData.map(() => greenUpper * 1000),
              symbol: 'none',
              lineStyle: { width: 0 },
              areaStyle: { color: 'rgba(34,197,94,0.06)', origin: taktS * 0.9 * 1000 },
              silent: true,
              z: 0,
            },
            {
              name: '_amberZone',
              type: 'line',
              data: xData.map(() => amberUpper * 1000),
              symbol: 'none',
              lineStyle: { width: 0 },
              areaStyle: { color: 'rgba(249,115,22,0.05)', origin: greenUpper * 1000 },
              silent: true,
              z: 0,
            },
            // Scatter dots
            {
              name: 'Cycle Time',
              type: 'scatter',
              data: data.map((v) => ({
                value: v,
                itemStyle: { color: dotColor(v, takt) },
              })),
              symbolSize: 5,
              markLine: {
                silent: true,
                symbol: 'none',
                lineStyle: { type: 'dashed', color: '#60a5fa', width: 1.5 },
                label: {
                  formatter: `Takt: ${taktS.toFixed(1)}s`,
                  color: '#60a5fa',
                  fontSize: 10,
                },
                data: [{ yAxis: takt }],
              },
            },
            // Moving average line
            {
              name: '10-Cycle Avg',
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
      title="Cycle Time"
      titleColor="#ffa726"
      subtitle="Last 100 Cycles"
      defaultWidth={700}
      defaultHeight={340}
      zIndex={1400}
    >
      <Box ref={chartRef} sx={{ flex: 1, minHeight: 0 }} />
    </ChartPanel>
  );
}

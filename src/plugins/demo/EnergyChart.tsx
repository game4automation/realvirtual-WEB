// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * EnergyChart — 24h stacked area chart showing power consumption by component.
 *
 * Components: Spindle, Coolant, Hydraulics, Robot, Conveyor Entry, Conveyor Exit, Auxiliary.
 * Typical values for a CNC machine tool cell (~18-25 kW peak).
 */

import { useEffect } from 'react';
import { Box } from '@mui/material';
import { ChartPanel } from '../../core/hmi/ChartPanel';
import { useKpiData } from '../../hooks/use-kpi-data';
import { useEChart } from '../../hooks/use-echart';
import { createBaseChartOption, DARK_TOOLTIP_BASE } from '../../core/hmi/chart-theme';

const COMPONENTS = [
  { key: 'spindle', name: 'Spindle', color: '#ef4444' },
  { key: 'coolant', name: 'Coolant', color: '#38bdf8' },
  { key: 'hydraulics', name: 'Hydraulics', color: '#f59e0b' },
  { key: 'robot', name: 'Robot', color: '#a78bfa' },
  { key: 'conveyorEntry', name: 'Conv. Entry', color: '#22c55e' },
  { key: 'conveyorExit', name: 'Conv. Exit', color: '#06b6d4' },
  { key: 'auxiliary', name: 'Auxiliary', color: '#94a3b8' },
] as const;

interface EnergyChartProps {
  open: boolean;
  onClose: () => void;
}

export function EnergyChart({ open, onClose }: EnergyChartProps) {
  const kpi = useKpiData();
  const { containerRef: chartRef, chartInstance } = useEChart({ open });

  // Set chart data
  useEffect(() => {
    if (!open || !kpi) return;
    const timer = setTimeout(() => {
      const chart = chartInstance.current;
      if (!chart) return;

      const data = kpi.energyData;
      const xLabels = data.map((d) => d.time);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const series: any[] = COMPONENTS.map((comp) => ({
        name: comp.name,
        type: 'line',
        stack: 'power',
        areaStyle: { opacity: 0.6 },
        data: data.map((d) => d[comp.key]),
        itemStyle: { color: comp.color },
        lineStyle: { width: 1 },
        symbol: 'none',
        emphasis: { focus: 'series' },
      }));

      const base = createBaseChartOption({
        title: 'Power Consumption \u2014 Last 24h',
        legendData: COMPONENTS.map((c) => c.name),
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
              let total = 0;
              let html = `<b>${ps[0].axisValue}</b><br/>`;
              for (const p of ps) {
                const v = p.value as number;
                total += v;
                html += `${p.marker} ${p.seriesName}: <b>${v.toFixed(1)} kW</b><br/>`;
              }
              html += `<br/><b>Total: ${total.toFixed(1)} kW</b>`;
              return html;
            },
          },
          xAxis: {
            ...(base.xAxis as object),
            data: xLabels,
            boundaryGap: false,
            axisLabel: {
              color: 'rgba(255,255,255,0.3)',
              fontSize: 10,
              interval: 1,
            },
          },
          yAxis: {
            ...(base.yAxis as object),
            axisLabel: {
              color: 'rgba(255,255,255,0.3)',
              fontSize: 10,
              formatter: '{value} kW',
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
      title="Power Consumption"
      titleColor="#ef5350"
      subtitle="Last 24h"
      defaultWidth={750}
      defaultHeight={360}
      zIndex={1400}
    >
      <Box ref={chartRef} sx={{ flex: 1, minHeight: 0 }} />
    </ChartPanel>
  );
}

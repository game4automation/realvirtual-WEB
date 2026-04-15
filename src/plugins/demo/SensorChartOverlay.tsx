// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SensorChartOverlay — Floating panel with a real-time ECharts step chart
 * showing sensor occupied/vacant states as high/low timelines.
 *
 * Uses ChartPanel for the reusable drag/resize/title-bar infrastructure.
 * Each sensor is displayed as a separate step-line series (0 = vacant, 1 = occupied).
 * Sensors are stacked vertically with offsets so they don't overlap.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Box, ToggleButtonGroup, ToggleButton } from '@mui/material';
import { useViewer } from '../../hooks/use-viewer';
import { useEChart } from '../../hooks/use-echart';
import { useSensorChartOpen } from '../../hooks/use-sensor-chart';
import { useMaintenanceMode } from '../../hooks/use-maintenance-mode';
import { BOTTOM_BAR_HEIGHT } from '../../core/hmi/layout-constants';
import { ChartPanel } from '../../core/hmi/ChartPanel';
import { SensorRecorderPlugin } from '../sensor-recorder-plugin';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import {
  type TimePeriod,
  PERIOD_OPTIONS,
  CHART_SAMPLE_RATE,
  CHART_REFRESH_INTERVAL,
  CHART_DEFAULT_WIDTH,
  SENSOR_PALETTE,
} from '../../core/hmi/chart-constants';
import { compactToggleGroupSx } from '../../core/hmi/shared-sx';
import {
  DARK_TEXT_STYLE,
  DARK_TITLE_STYLE,
  DARK_AXIS_LINE,
  DARK_AXIS_LABEL,
  DARK_TOOLTIP_BASE,
} from '../../core/hmi/chart-theme';

const DEFAULT_H = 340;
const BOTTOM_MARGIN = BOTTOM_BAR_HEIGHT + 12;

/** Vertical spacing between stacked sensors. */
const SENSOR_SPACING = 1.5;

// ─── Component ───────────────────────────────────────────────────────────

function ensureSensorRecorder(viewer: ReturnType<typeof useViewer>) {
  let plugin = viewer.getPlugin<SensorRecorderPlugin>('sensor-recorder');
  if (!plugin) {
    plugin = new SensorRecorderPlugin();
    viewer.use(plugin);
  }
  return plugin;
}

export function SensorChartOverlay() {
  const viewer = useViewer();
  const open = useSensorChartOpen();
  const maintenanceState = useMaintenanceMode();
  const suppressed = maintenanceState.mode !== 'idle';

  const [period, setPeriod] = useState<TimePeriod>(60);

  // Short display name from full path
  const shortName = useCallback((path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1];
  }, []);

  // Handle clicking a series -> highlight + focus sensor
  const handleSensorClick = useCallback(
    (seriesName: string) => {
      const sensors = viewer.transportManager?.sensors ?? [];
      const recorder = ensureSensorRecorder(viewer).recorder;
      const s = recorder.series.find((ts) => shortName(ts.path) === seriesName);
      if (!s) return;
      const sensor = sensors.find((sen) => sen === s.sensor);
      if (!sensor) return;
      const path = NodeRegistry.computeNodePath(sensor.node);
      viewer.highlightByPath(path, true);
      viewer.focusByPath(path);
    },
    [viewer, shortName],
  );

  // Shared EChart lifecycle (init/dispose/resize/window-resize)
  const handleClickRef = useRef(handleSensorClick);
  handleClickRef.current = handleSensorClick;

  const { containerRef: chartRef, chartInstance } = useEChart({
    open,
    enableWindowResize: true,
    onInit: (chart) => {
      chart.on('click', (params: unknown) => {
        const p = params as { seriesName?: string };
        if (p.seriesName) handleClickRef.current(p.seriesName);
      });
      chart.on('legendselectchanged', (params: unknown) => {
        const p = params as { name: string; selected: Record<string, boolean> };
        // Re-select (don't hide — just focus)
        chart.dispatchAction({ type: 'legendSelect', name: p.name });
        handleClickRef.current(p.name);
      });
    },
  });

  // Periodic data refresh
  useEffect(() => {
    if (!open) return;

    const update = () => {
      const chart = chartInstance.current;
      if (!chart) return;
      const recorder = ensureSensorRecorder(viewer).recorder;
      if (recorder.timeBuffer.count === 0) return;

      const samplesToShow = period * CHART_SAMPLE_RATE;
      const timeData = recorder.timeBuffer.lastN(samplesToShow);
      if (timeData.length === 0) return;

      const xData = timeData.map((t) => t.toFixed(1));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const series: any[] = [];
      const legendData: string[] = [];
      const sensorCount = recorder.series.length;

      for (let i = 0; i < sensorCount; i++) {
        const s = recorder.series[i];
        const name = shortName(s.path);
        const color = SENSOR_PALETTE[i % SENSOR_PALETTE.length];
        const offset = (sensorCount - 1 - i) * SENSOR_SPACING;

        legendData.push(name);

        // Step chart: each sensor gets offset vertically
        const rawData = s.state.lastN(samplesToShow);
        const offsetData = rawData.map((v) => v + offset);

        series.push({
          type: 'line',
          name,
          step: 'end',
          data: offsetData,
          symbol: 'none',
          lineStyle: { width: 2, color },
          itemStyle: { color },
          areaStyle: {
            color,
            opacity: 0.08,
            origin: offset,
          },
          emphasis: { lineStyle: { width: 3 } },
          tooltip: {
            valueFormatter: (v: number) => {
              const state = (v - offset) > 0.5 ? 'OCCUPIED' : 'vacant';
              return state;
            },
          },
        });
      }

      // Y-axis labels: sensor names at their offset positions
      const yAxisLabels: { value: number; label: string }[] = [];
      for (let i = 0; i < sensorCount; i++) {
        const offset = (sensorCount - 1 - i) * SENSOR_SPACING;
        yAxisLabels.push({ value: offset + 0.5, label: shortName(recorder.series[i].path) });
      }

      chart.setOption(
        {
          backgroundColor: 'transparent',
          textStyle: DARK_TEXT_STYLE,
          title: {
            text: 'Sensor Timeline',
            left: 8,
            top: 2,
            textStyle: DARK_TITLE_STYLE,
          },
          legend: {
            data: legendData,
            bottom: 0,
            textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 10 },
            pageTextStyle: { color: 'rgba(255,255,255,0.5)' },
            pageIconColor: 'rgba(255,255,255,0.4)',
            pageIconInactiveColor: 'rgba(255,255,255,0.12)',
            type: 'scroll',
            itemWidth: 14,
            itemHeight: 8,
          },
          tooltip: {
            ...DARK_TOOLTIP_BASE,
            axisPointer: { lineStyle: { color: 'rgba(255,255,255,0.12)' } },
          },
          grid: { left: 12, right: 12, top: 24, bottom: 42 },
          xAxis: {
            type: 'category',
            data: xData,
            axisLine: DARK_AXIS_LINE,
            axisLabel: DARK_AXIS_LABEL,
            splitLine: { show: false },
          },
          yAxis: {
            type: 'value',
            min: -0.2,
            max: Math.max(1.5, (sensorCount - 1) * SENSOR_SPACING + 1.3),
            axisLine: { show: false },
            axisLabel: { show: false },
            splitLine: { show: false },
          },
          series,
        },
        { notMerge: true, lazyUpdate: true },
      );
    };

    const initTimer = setTimeout(update, 100);
    const interval = setInterval(update, CHART_REFRESH_INTERVAL);
    return () => {
      clearTimeout(initTimer);
      clearInterval(interval);
    };
  }, [open, viewer, period, shortName]);

  const sensorCount = ensureSensorRecorder(viewer).recorder.series.length;

  const toolbar = (
    <>
      {/* Period selector */}
      <ToggleButtonGroup
        value={period}
        exclusive
        onChange={(_, v) => { if (v) setPeriod(v as TimePeriod); }}
        size="small"
        sx={compactToggleGroupSx('#66bb6a', '102,187,106', { ml: 'auto' })}
      >
        {PERIOD_OPTIONS.map((p) => (
          <ToggleButton key={p} value={p}>
            {p >= 60 ? `${p / 60}m` : `${p}s`}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </>
  );

  return (
    <ChartPanel
      open={open && !suppressed}
      onClose={() => viewer.toggleSensorChart(false)}
      title="Sensor Monitor"
      titleColor="#66bb6a"
      subtitle={`${sensorCount} sensors`}
      defaultWidth={CHART_DEFAULT_WIDTH}
      defaultHeight={DEFAULT_H}
      defaultPosition={{ x: 64, y: window.innerHeight - DEFAULT_H - BOTTOM_MARGIN }}
      zIndex={1500}
      toolbar={toolbar}
    >
      <Box ref={chartRef} sx={{ flex: 1, minHeight: 0 }} />
    </ChartPanel>
  );
}

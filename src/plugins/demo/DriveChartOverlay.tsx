// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DriveChartOverlay — Floating panel with a real-time ECharts chart
 * showing drive positions and/or speeds.
 *
 * Uses ChartPanel for the reusable drag/resize/title-bar infrastructure.
 * Responds to drive filter events — only shows filtered drives.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Box, ToggleButtonGroup, ToggleButton, Chip } from '@mui/material';
import { FilterAltOff } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useEChart } from '../../hooks/use-echart';
import { useDriveChartOpen } from '../../hooks/use-drive-chart';
import { useDrives } from '../../hooks/use-drives';
import { useDriveFilter } from '../../hooks/use-drive-filter';
import { useMaintenanceMode } from '../../hooks/use-maintenance-mode';
import { BOTTOM_BAR_HEIGHT } from '../../core/hmi/layout-constants';
import { ChartPanel } from '../../core/hmi/ChartPanel';
import { DriveRecorderPlugin } from '../drive-recorder-plugin';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import {
  type TimePeriod,
  PERIOD_OPTIONS,
  CHART_SAMPLE_RATE,
  CHART_REFRESH_INTERVAL,
  CHART_DEFAULT_WIDTH,
  DRIVE_PALETTE,
} from '../../core/hmi/chart-constants';
import { compactToggleGroupSx } from '../../core/hmi/shared-sx';
import {
  DARK_TEXT_STYLE,
  DARK_TITLE_STYLE,
  DARK_AXIS_LINE,
  DARK_AXIS_LABEL,
  DARK_SPLIT_LINE,
  DARK_TOOLTIP_BASE,
} from '../../core/hmi/chart-theme';

type ChartMode = 'position' | 'speed' | 'both';

const DEFAULT_H = 300;
const BOTTOM_MARGIN = BOTTOM_BAR_HEIGHT + 12;

// ─── Component ───────────────────────────────────────────────────────────

function ensureDriveRecorder(viewer: ReturnType<typeof useViewer>) {
  let plugin = viewer.getPlugin<DriveRecorderPlugin>('drive-recorder');
  if (!plugin) {
    plugin = new DriveRecorderPlugin();
    viewer.use(plugin);
  }
  return plugin;
}

export function DriveChartOverlay() {
  const viewer = useViewer();
  const open = useDriveChartOpen();
  const drives = useDrives();
  const { filter, filteredDrives, setFilter } = useDriveFilter();
  const maintenanceState = useMaintenanceMode();

  // Suppress overlay during maintenance mode
  const suppressed = maintenanceState.mode !== 'idle';

  const activeDrives = filter ? filteredDrives : drives;

  const [mode, setMode] = useState<ChartMode>('position');
  const [period, setPeriod] = useState<TimePeriod>(60);

  // Handle clicking a series -> focus drive
  const handleDriveClick = useCallback(
    (driveName: string) => {
      const cleanName = driveName.replace(/ \((pos|spd)\)$/, '');
      const drive = drives.find((d) => d.name === cleanName);
      if (!drive) return;
      const path = NodeRegistry.computeNodePath(drive.node);
      viewer.highlightByPath(path, true);
      viewer.focusByPath(path);
    },
    [drives, viewer],
  );

  // Shared EChart lifecycle (init/dispose/resize/window-resize)
  const handleDriveClickRef = useRef(handleDriveClick);
  handleDriveClickRef.current = handleDriveClick;

  const { containerRef: chartRef, chartInstance } = useEChart({
    open,
    enableWindowResize: true,
    onInit: (chart) => {
      chart.on('click', (params: unknown) => {
        const p = params as { seriesName?: string };
        if (p.seriesName) handleDriveClickRef.current(p.seriesName);
      });
      chart.on('legendselectchanged', (params: unknown) => {
        const p = params as { name: string; selected: Record<string, boolean> };
        const allSelected: Record<string, boolean> = {};
        for (const key of Object.keys(p.selected)) allSelected[key] = true;
        chart.dispatchAction({ type: 'legendSelect', name: p.name });
        handleDriveClickRef.current(p.name);
      });
    },
  });

  // Periodic data refresh
  useEffect(() => {
    if (!open) return;

    const update = () => {
      const chart = chartInstance.current;
      if (!chart) return;
      const recorder = ensureDriveRecorder(viewer).recorder;
      if (recorder.timeBuffer.count === 0) return;

      const samplesToShow = period * CHART_SAMPLE_RATE;
      const timeData = recorder.timeBuffer.lastN(samplesToShow);
      if (timeData.length === 0) return;

      const activeDriveNames = new Set(activeDrives.map((d) => d.name));

      const xData = timeData.map((t) => t.toFixed(1));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const series: any[] = [];
      const legendData: string[] = [];

      const dualAxis = mode === 'both';

      for (let i = 0; i < recorder.series.length; i++) {
        const s = recorder.series[i];
        const driveName = s.drive.name;
        if (!activeDriveNames.has(driveName)) continue;

        const color = DRIVE_PALETTE[i % DRIVE_PALETTE.length];
        const unit = s.drive.isRotary ? '\u00B0' : 'mm';

        if (mode === 'position' || mode === 'both') {
          const name = dualAxis ? `${driveName} (pos)` : driveName;
          legendData.push(name);
          series.push({
            type: 'line',
            name,
            yAxisIndex: 0,
            data: s.position.lastN(samplesToShow),
            symbol: 'none',
            lineStyle: { width: 1.5, color },
            itemStyle: { color },
            emphasis: { lineStyle: { width: 3 } },
            tooltip: { valueFormatter: (v: number) => `${v.toFixed(1)} ${unit}` },
          });
        }

        if (mode === 'speed' || mode === 'both') {
          const name = dualAxis ? `${driveName} (spd)` : driveName;
          legendData.push(name);
          series.push({
            type: 'line',
            name,
            yAxisIndex: dualAxis ? 1 : 0,
            data: s.speed.lastN(samplesToShow),
            symbol: 'none',
            lineStyle: { width: 1.5, color, type: dualAxis ? 'dashed' : 'solid' },
            itemStyle: { color },
            emphasis: { lineStyle: { width: 3 } },
            tooltip: { valueFormatter: (v: number) => `${v.toFixed(1)} ${unit}/s` },
          });
        }
      }

      const titleText = mode === 'position' ? 'Position' : mode === 'speed' ? 'Speed' : 'Position & Speed';
      const filterInfo = filter ? ` (filter: "${filter}")` : '';

      const yAxisStyle = {
        axisLine: DARK_AXIS_LINE,
        axisLabel: DARK_AXIS_LABEL,
        splitLine: DARK_SPLIT_LINE,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const yAxis: any[] = dualAxis
        ? [
            {
              type: 'value',
              name: 'Position',
              nameTextStyle: { color: 'rgba(255,255,255,0.35)', fontSize: 10 },
              ...yAxisStyle,
            },
            {
              type: 'value',
              name: 'Speed',
              nameTextStyle: { color: 'rgba(255,255,255,0.35)', fontSize: 10 },
              ...yAxisStyle,
              splitLine: { show: false },
            },
          ]
        : [{ type: 'value', ...yAxisStyle }];

      chart.setOption(
        {
          backgroundColor: 'transparent',
          textStyle: DARK_TEXT_STYLE,
          title: {
            text: titleText + filterInfo,
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
          grid: { left: 50, right: dualAxis ? 50 : 12, top: 24, bottom: 42 },
          xAxis: {
            type: 'category',
            data: xData,
            axisLine: DARK_AXIS_LINE,
            axisLabel: DARK_AXIS_LABEL,
            splitLine: { show: false },
          },
          yAxis,
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
  }, [open, viewer, mode, period, filter, activeDrives]);

  const driveCount = filter ? `${activeDrives.length}/${drives.length} drives` : `${drives.length} drives`;

  const toolbar = (
    <>
      {/* Clear filter chip */}
      {filter && (
        <Chip
          label="Clear Filter"
          size="small"
          icon={<FilterAltOff sx={{ fontSize: 12 }} />}
          onClick={() => setFilter('')}
          onDelete={() => setFilter('')}
          sx={{
            height: 20,
            fontSize: 10,
            color: '#ffa726',
            borderColor: 'rgba(255,167,38,0.3)',
            '& .MuiChip-icon': { color: '#ffa726', ml: 0.5 },
            '& .MuiChip-deleteIcon': { color: '#ffa726', fontSize: 14 },
          }}
          variant="outlined"
        />
      )}

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

      {/* Mode toggle */}
      <ToggleButtonGroup
        value={mode}
        exclusive
        onChange={(_, v) => { if (v) setMode(v as ChartMode); }}
        size="small"
        sx={compactToggleGroupSx('#4fc3f7', '79,195,247')}
      >
        <ToggleButton value="position">Position</ToggleButton>
        <ToggleButton value="speed">Speed</ToggleButton>
        <ToggleButton value="both">Both</ToggleButton>
      </ToggleButtonGroup>
    </>
  );

  return (
    <ChartPanel
      open={open && !suppressed}
      onClose={() => viewer.toggleDriveChart(false)}
      title="Drive Monitor"
      titleColor="#4fc3f7"
      subtitle={driveCount}
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

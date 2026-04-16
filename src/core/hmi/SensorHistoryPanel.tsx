// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SensorHistoryPanel — Floating, draggable, resizable panel that shows
 * deterministic sensor history for either a single WebSensor or all
 * WebSensors as a logic-analyzer multi-grid.
 *
 * Opened by the "Show" button in a pinned WebSensor tooltip
 * (see WebSensorTooltipContent.tsx). Single-instance — a second "Show"
 * on a different sensor replaces the currently shown sensor.
 *
 * Drag/resize follows the ChartPanel blueprint: local React state during
 * interaction, store persistence only on pointer-up (prevents React render
 * loops from pointermove-heavy updates).
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Box, IconButton, Paper, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import {
  Close,
  DragIndicator,
  Timeline as TimelineIcon,
  ViewAgenda,
} from '@mui/icons-material';
import { useEChart } from '../../hooks/use-echart';
import { useViewer } from '../../hooks/use-viewer';
import type { RVViewer } from '../rv-viewer';
import { RVWebSensor } from '../engine/rv-web-sensor';
import {
  sensorHistoryStore,
  useSensorHistory,
  type SensorHistoryRef,
  type SensorHistoryMode,
  type SensorHistoryWindow,
} from './sensor-history-store';
import {
  generateHistory,
  WINDOW_SEC,
} from './sensor-history-data';
import {
  buildSingleOption,
  buildAllOption,
  DEFAULT_CHART_THEME,
} from './sensor-history-chart-options';
import { useDrag } from './ChartPanel';

// ─── Constants ─────────────────────────────────────────────────────────

const MIN_W = 400;
const MIN_H = 200;
const Z_INDEX = 1550;
const WINDOW_OPTIONS: SensorHistoryWindow[] = ['1m', '5m', '15m', '1h'];

/** Hard cap — more than this many tracks in all-mode would hurt perf/readability. */
const ALL_MODE_MAX = 64;

// ─── Helpers ───────────────────────────────────────────────────────────

/** Collect all RVWebSensor instances from the scene, as SensorHistoryRefs. */
function collectAllWebSensors(viewer: RVViewer): SensorHistoryRef[] {
  const reg = viewer.registry;
  if (!reg) return [];
  const entries = reg.getAll<RVWebSensor>('WebSensor');
  const refs: SensorHistoryRef[] = [];
  for (const { path, instance } of entries) {
    if (!instance) continue;
    refs.push({
      path,
      label: instance.Label || path.split('/').pop() || '(sensor)',
      isInt: Boolean(instance.SignalInt),
    });
  }
  // Sort by label so the stacked layout is stable across renders.
  refs.sort((a, b) => a.label.localeCompare(b.label));
  if (refs.length > ALL_MODE_MAX) refs.length = ALL_MODE_MAX;
  return refs;
}

// ─── Drag-handle subcomponent ──────────────────────────────────────────

function PanelHeader({
  sensor,
  mode,
  window: win,
  onModeChange,
  onWindowChange,
  onClose,
  dragRef,
}: {
  sensor: SensorHistoryRef;
  mode: SensorHistoryMode;
  window: SensorHistoryWindow;
  onModeChange: (m: SensorHistoryMode) => void;
  onWindowChange: (w: SensorHistoryWindow) => void;
  onClose: () => void;
  dragRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <Box
      ref={dragRef}
      data-drag-handle="true"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.25,
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        flexShrink: 0,
        minHeight: 32,
        cursor: 'grab',
        userSelect: 'none',
        '&:active': { cursor: 'grabbing' },
      }}
    >
      <DragIndicator sx={{ fontSize: 14, color: 'rgba(255,255,255,0.2)' }} />
      <TimelineIcon sx={{ fontSize: 16, color: DEFAULT_CHART_THEME.accent }} />
      <Typography
        id="sensor-history-title"
        sx={{
          fontSize: 12,
          fontWeight: 700,
          color: DEFAULT_CHART_THEME.accent,
          letterSpacing: 0.3,
          fontFamily: 'monospace',
        }}
      >
        {sensor.label}
      </Typography>

      <Box sx={{ ml: 'auto' }} />

      {/* Window selector */}
      <ToggleButtonGroup
        size="small"
        exclusive
        value={win}
        onChange={(_, v) => { if (v) onWindowChange(v as SensorHistoryWindow); }}
        sx={{ height: 24, '& .MuiToggleButton-root': { px: 1, py: 0.1, fontSize: 10 } }}
      >
        {WINDOW_OPTIONS.map(opt => (
          <ToggleButton key={opt} value={opt} aria-label={`Window ${opt}`}>{opt}</ToggleButton>
        ))}
      </ToggleButtonGroup>

      {/* Mode toggle */}
      <ToggleButtonGroup
        size="small"
        exclusive
        value={mode}
        onChange={(_, v) => { if (v) onModeChange(v as SensorHistoryMode); }}
        sx={{ height: 24, ml: 0.5, '& .MuiToggleButton-root': { px: 1, py: 0.1, fontSize: 10 } }}
      >
        <ToggleButton value="single" aria-label="Single sensor view">
          <TimelineIcon sx={{ fontSize: 14, mr: 0.5 }} />
          Single
        </ToggleButton>
        <ToggleButton value="all" aria-label="All sensors view">
          <ViewAgenda sx={{ fontSize: 14, mr: 0.5 }} />
          All
        </ToggleButton>
      </ToggleButtonGroup>

      <IconButton
        size="small"
        onClick={onClose}
        aria-label="Close sensor history"
        sx={{ color: 'rgba(255,255,255,0.35)', p: 0.3, ml: 0.5, '&:hover': { color: '#fff' } }}
      >
        <Close sx={{ fontSize: 16 }} />
      </IconButton>
    </Box>
  );
}

// ─── Main Panel ────────────────────────────────────────────────────────

export function SensorHistoryPanel() {
  const state = useSensorHistory();
  const viewer = useViewer();
  const { activeSensor, mode, window: win, layout } = state;

  // Local drag position (avoids re-render loop on each pointermove).
  const [pos, setPos] = useState({ x: layout.x, y: layout.y });
  const [size, setSize] = useState({ w: layout.w, h: layout.h });

  // Sync local pos/size from store when the store changes externally
  // (e.g. restore from another tab, or initial mount).
  useEffect(() => { setPos({ x: layout.x, y: layout.y }); }, [layout.x, layout.y]);
  useEffect(() => { setSize({ w: layout.w, h: layout.h }); }, [layout.w, layout.h]);

  const dragRef = useRef<HTMLDivElement | null>(null);
  useDrag(dragRef, pos, setPos, !!activeSensor);

  // Commit drag position to store on pointer-up only.
  useEffect(() => {
    const onUp = () => {
      sensorHistoryStore.setLayout({ x: pos.x, y: pos.y });
    };
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.x, pos.y]);

  // Resize via ResizeObserver → commits to store.
  const paperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!activeSensor) return;
    const el = paperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        // Apply min constraints.
        const w = Math.max(MIN_W, Math.round(cr.width));
        const h = Math.max(MIN_H, Math.round(cr.height));
        setSize({ w, h });
        sensorHistoryStore.setLayout({ w, h });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeSensor]);

  // Close on ESC.
  useEffect(() => {
    if (!activeSensor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') sensorHistoryStore.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeSensor]);

  // Close automatically on model-cleared.
  useEffect(() => {
    const off = viewer.on('model-cleared', () => sensorHistoryStore.close());
    return () => { off(); };
  }, [viewer]);

  // All-mode: enumerate the full sensor list (memoed per viewer).
  // Depends on the scene being loaded — recomputed on model-loaded for freshness.
  const [sceneVersion, setSceneVersion] = useState(0);
  useEffect(() => {
    const offLoaded = viewer.on('model-loaded', () => setSceneVersion(v => v + 1));
    const offCleared = viewer.on('model-cleared', () => setSceneVersion(v => v + 1));
    return () => { offLoaded(); offCleared(); };
  }, [viewer]);

  const allSensors = useMemo<SensorHistoryRef[]>(() => {
    if (!activeSensor) return [];
    if (mode === 'all') return collectAllWebSensors(viewer);
    return [activeSensor];
  // sceneVersion intentionally included to trigger recollection on scene change
  }, [mode, viewer, activeSensor, sceneVersion]);

  // Generate history per sensor for the current window.
  // Date.now() is captured inside useMemo so results stay stable between re-renders
  // that don't change [allSensors, win].
  const nowMs = useMemo(() => Date.now(), [allSensors, win]);
  const allSeries = useMemo(
    () => allSensors.map(s => ({
      sensor: s,
      series: generateHistory(s.path, WINDOW_SEC[win], s.isInt, nowMs),
    })),
    [allSensors, win, nowMs],
  );

  // Build ECharts option.
  const option = useMemo(() => {
    if (!activeSensor) return null;
    if (allSeries.length === 0) return null;
    if (mode === 'single') {
      // Single mode always renders the activeSensor (first + only element).
      return buildSingleOption(allSeries[0].series, activeSensor, win, DEFAULT_CHART_THEME);
    }
    return buildAllOption(allSeries, activeSensor.path, win, DEFAULT_CHART_THEME);
  }, [mode, allSeries, activeSensor, win]);

  const { containerRef, chartInstance } = useEChart({
    open: !!activeSensor,
    enableWindowResize: true,
  });

  // Apply option with notMerge=true so mode-switches single↔all fully reset
  // the xAxis/yAxis/grid structure (otherwise old arrays linger).
  useEffect(() => {
    if (!chartInstance.current || !option) return;
    chartInstance.current.setOption(option, true);
  }, [option, chartInstance]);

  const onModeChange = useCallback((m: SensorHistoryMode) => sensorHistoryStore.setMode(m), []);
  const onWindowChange = useCallback((w: SensorHistoryWindow) => sensorHistoryStore.setWindow(w), []);
  const onClose = useCallback(() => sensorHistoryStore.close(), []);

  if (!activeSensor) return null;

  const isEmpty = allSeries.length === 0;

  return (
    <Paper
      ref={paperRef}
      elevation={8}
      role="dialog"
      aria-labelledby="sensor-history-title"
      data-ui-panel
      sx={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: size.w,
        height: size.h,
        minWidth: MIN_W,
        minHeight: MIN_H,
        zIndex: Z_INDEX,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 2,
        border: '1px solid rgba(255,255,255,0.08)',
        overflow: 'hidden',
        pointerEvents: 'auto',
        resize: 'both',
      }}
    >
      <PanelHeader
        sensor={activeSensor}
        mode={mode}
        window={win}
        onModeChange={onModeChange}
        onWindowChange={onWindowChange}
        onClose={onClose}
        dragRef={dragRef}
      />

      {isEmpty ? (
        <Box sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(255,255,255,0.5)',
          fontSize: 12,
        }}>
          No WebSensors in the current scene
        </Box>
      ) : (
        <Box ref={containerRef} sx={{ flex: 1, minHeight: 0 }} />
      )}
    </Paper>
  );
}

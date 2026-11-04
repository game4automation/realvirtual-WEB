// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DESStatsChart.tsx -- DES utilization body for the statistics hub.
 *
 * Replaces the old card/table DESStatsPanel: a single floatable window that
 * shows ALL components as horizontal STACKED utilization bars (Working / Charging /
 * Setup / Blocked / Empty / Failure …, `DES_STATE_STACK`), sorted by MATERIAL FLOW
 * (sources at the top), and
 * filterable by component type. Hovering a bar HIGHLIGHTS the matching object in
 * the 3D scene (and clears on mouse-out), so the chart and the twin are linked.
 *
 * Data comes from the live `DESRunner` (each component's `getStatistics()`),
 * refreshed on a timer. The chart uses the shared `useEChart` lifecycle hook and
 * the dark chart theme; the surrounding window is provided by the statistics hub.
 */

import { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore } from 'react';
import { Box, Chip, Stack, Typography } from '@mui/material';
import type { StatsSectionBodyProps } from '../../../core/stats/rv-stats-registry';
import { useEChart } from '../../../hooks/use-echart';
import { DARK_TEXT_STYLE, DARK_AXIS_LINE, DARK_AXIS_LABEL, DARK_SPLIT_LINE, DARK_TOOLTIP_BASE } from '../../../core/hmi/chart-theme';
import { registerRecordingTarget } from '../../../core/engine/rv-recording-targets';
import { getActiveDesRunner, desComponentsOf } from './des-active-runner';
// The stack stays the source of the built-in series (keys on the row);
// registered states (plan-644 D8) follow it through the registry.
import {
  DES_STATE_STACK as STATES,
  desHmiExtensionsVersion,
  desStateLabel,
  desStatePercent,
  registeredDesStates,
  subscribeDesHmiExtensions,
} from './des-stat-colors';
import { getDesStatsGizmos, peekDesStatsGizmos } from './des-stats-gizmos';
import { desStatsHiddenKindsStore, setDesStatsHiddenKinds, toggleDesStatsHiddenKind } from '../../sim-controller/des-stats-window-store';
import { kindOf, sortByMaterialFlow } from '../des-flow-order';

import { FS } from '../../../core/hmi/shared-sx';

const REFRESH_MS = 500;

/** One chart column (exported for the stack tests). */
export interface DESStatsRow {
  path: string;
  name: string;
  kind: string;
  workingPercent: number;
  chargingPercent: number;
  transportPercent: number;
  slowedPercent: number;
  stoppedPercent: number;
  setupPercent: number;
  blockedPercent: number;
  emptyPercent: number;
  failurePercent: number;
  outputPerHour: number;
  totalProcessed: number;
  currentState: string;
  /** Shares of the registered (non-stack) states by name (plan-644); absent → 0. */
  states?: Record<string, number>;
}
type Row = DESStatsRow;

/** Series / legend entries: the stack, then the registered states (plan-644 D8). */
function stackEntries(): { label: string; color: string; value: (r: DESStatsRow) => number }[] {
  return [
    ...STATES.map((s) => ({ label: s.label, color: s.color, value: (r: DESStatsRow) => r[s.key] as number })),
    ...registeredDesStates().map((s) => ({
      label: desStateLabel(s.name), color: s.color, value: (r: DESStatsRow) => r.states?.[s.name] ?? 0,
    })),
  ];
}

/** One stacked bar series per `DES_STATE_STACK` entry, in stack order, then one per registered state. */
export function buildStackSeries(rows: ReadonlyArray<DESStatsRow>) {
  return stackEntries().map((s) => ({
    name: s.label, type: 'bar' as const, stack: 'util',
    data: rows.map((r) => +s.value(r).toFixed(1)),
    itemStyle: { color: s.color }, barMaxWidth: 28,
    emphasis: { focus: 'series' as const },
  }));
}

export interface DESUtilizationBodyProps extends StatsSectionBodyProps {
  /** Optional selection highlighter — overrides the default per-mesh
   *  `highlighter.highlightSelection`. A model plugin whose components are
   *  mesh-heavy can supply a cheaper visual (e.g. a translucent bounding volume).
   *  Called with the selected node, or null to clear. */
  selectNode?: (node: import('three').Object3D | null) => void;
}

/** Shares of the registered states for one component (undefined without registrations). */
function extraStates(c: Parameters<typeof desStatePercent>[0]): Record<string, number> | undefined {
  const reg = registeredDesStates();
  if (reg.length === 0) return undefined;
  const out: Record<string, number> = {};
  for (const s of reg) out[s.name] = desStatePercent(c, s.name);
  return out;
}

export function DESUtilizationBody({ viewer, active, selectNode }: DESUtilizationBodyProps) {
  // A state registered after the mount rebuilds the series at once (plan-644, SOL R2 #3).
  const extVersion = useSyncExternalStore(subscribeDesHmiExtensions, desHmiExtensionsVersion);
  // Active type filter — empty set means "all" (default: everything shown).
  const hiddenKinds = useSyncExternalStore(desStatsHiddenKindsStore.subscribe, desStatsHiddenKindsStore.getSnapshot);
  // Filters retain their existing lifetime: reset when the body unmounts.
  useEffect(() => () => setDesStatsHiddenKinds([]), []);
  const [hasData, setHasData] = useState(false);
  const [kinds, setKinds] = useState<string[]>([]);

  // Live rows (sorted + filtered), kept in a ref so the chart hover handler maps
  // a bar index → component WITHOUT stale closures.
  const rowsRef = useRef<Row[]>([]);
  // Chart instance + registry version the static options were last applied for.
  const staticApplied = useRef<{ chart: unknown; ext: number } | null>(null);
  const hiddenRef = useRef(hiddenKinds);
  hiddenRef.current = hiddenKinds;

  // Hovering a bar HIGHLIGHTS the 3D object AND shows its in-scene stats badge
  // (transient — even when the global badge toggle is off). Clears on mouse-out.
  const hoverRow = useCallback((index: number | undefined) => {
    const row = index == null ? null : rowsRef.current[index];
    const node = row ? viewer.registry?.getNode(row.path) : null;
    if (node) viewer.highlighter.highlight(node, false); else viewer.highlighter.clear();
    getDesStatsGizmos(viewer).setTransient(row ? row.path : null);
  }, [viewer]);
  const clearHover = useCallback(() => {
    viewer.highlighter.clear();
    peekDesStatsGizmos(viewer)?.setTransient(null);
  }, [viewer]);

  // Clicking a bar SELECTS the component in 3D (persistent selection highlight)
  // and keeps its in-scene badge shown until another bar is clicked / window closes.
  // plan-2030 F2: the default goes through the viewer's SelectionManager (like a 3D click:
  // inspector, follow/sit); `selectNode` stays an override. `ownSelection` remembers the path
  // THIS chart selected so closing the window never clears a foreign selection.
  const ownSelection = useRef<string | null>(null);
  /** True only while the chart itself calls select()/clear() — see the subscription below. */
  const selfChanging = useRef(false);
  // Ownership ends on ANY selection change the chart did not cause (A chart -> B viewer ->
  // A viewer must leave A to the viewer on close).
  useEffect(() => {
    const sm = viewer.selectionManager;
    if (!sm?.subscribe) return;
    return sm.subscribe(() => { if (!selfChanging.current) ownSelection.current = null; });
  }, [viewer]);
  const selectRow = useCallback((index: number | undefined) => {
    const row = index == null ? null : rowsRef.current[index];
    if (selectNode) {
      const node = row ? viewer.registry?.getNode(row.path) ?? null : null;
      selectNode(node);
    } else if (row) {
      selfChanging.current = true;
      try { viewer.selectionManager.select(row.path); } finally { selfChanging.current = false; }
      ownSelection.current = row.path;
    } else {
      selfChanging.current = true;
      try { viewer.selectionManager.clear(); } finally { selfChanging.current = false; }
      ownSelection.current = null;
    }
    getDesStatsGizmos(viewer).setSelected(row ? row.path : null);
  }, [viewer, selectNode]);

  const { containerRef, chartInstance } = useEChart({
    open: active,
    enableWindowResize: true,
    onInit: (chart) => {
      chart.on('mouseover', (p: unknown) => {
        const d = (p as { dataIndex?: number }).dataIndex;
        if (typeof d === 'number') hoverRow(d);
      });
      chart.on('mouseout', clearHover);
      chart.on('globalout', clearHover);
      chart.on('click', (p: unknown) => {
        const d = (p as { dataIndex?: number }).dataIndex;
        if (typeof d === 'number') selectRow(d);
      });
    },
  });

  // Closing the hub unmounts its bodies; the shared hook only disposes on open=false.
  useEffect(() => () => {
    chartInstance.current?.dispose();
    chartInstance.current = null;
  }, [chartInstance]);

  // Resolve against the current chart ref so delayed initialization stays safe.
  useEffect(() => {
    if (!active) return;
    return registerRecordingTarget('des-stats-bar', (key) => {
      const chart = chartInstance.current;
      const container = containerRef.current;
      if (!chart || chart.isDisposed() || !container || container.getClientRects().length === 0) return null;
      const rows = rowsRef.current;
      let index = rows.findIndex((row) => row.path === key);
      if (index < 0) index = rows.findIndex((row) => row.name === key);
      const row = rows[index];
      if (!row || hiddenRef.current.has(row.kind)) return null;
      // Read the rendered stack (including legend choices), not unrounded statistics.
      const option = chart.getOption() as {
        xAxis?: Array<{ type?: string; data?: string[] }>;
        yAxis?: Array<{ type?: string; data?: string[] }>;
        series?: Array<{ type?: string; name?: string; data?: number[] }>;
        legend?: Array<{ selected?: Record<string, boolean> }>;
      };
      const vertical = option.xAxis?.[0]?.type === 'category';
      const axis = vertical ? option.xAxis?.[0] : option.yAxis?.[0];
      if (axis?.type !== 'category' || axis.data?.[index] !== row.name) return null;
      const total = (option.series ?? []).reduce((sum, series) => {
        if (series.type !== 'bar' || option.legend?.some((legend) => legend.selected?.[series.name ?? ''] === false)) return sum;
        return sum + (series.data?.[index] ?? 0);
      }, 0);
      if (!Number.isFinite(total) || total <= 0) return null;
      // Numeric category index also disambiguates rows sharing the same display name.
      const x = chart.convertToPixel({ xAxisIndex: 0 }, vertical ? index : total / 2);
      const y = chart.convertToPixel({ yAxisIndex: 0 }, vertical ? total / 2 : index);
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.left + x, y: rect.top + y };
    });
  }, [active, chartInstance, containerRef]);

  // Clear hover/highlight, transient + persistent badge + 3D selection on close.
  useEffect(() => {
    if (!active) return;
    return () => {
      clearHover();
      if (selectNode) {
        selectNode(null);
      } else {
        const own = ownSelection.current;
        const cur = viewer.selectionManager.selectedPaths;
        if (own !== null && cur.length === 1 && cur[0] === own) viewer.selectionManager.clear();
      }
      ownSelection.current = null;
      peekDesStatsGizmos(viewer)?.setSelected(null);
    };
  }, [active, viewer, clearHover, selectNode]);

  // Periodic refresh: read stats, sort by flow, filter by kind, push to the chart.
  useEffect(() => {
    if (!active) return;
    const update = () => {
      const chart = chartInstance.current;
      if (!chart) return;
      const runner = getActiveDesRunner(viewer);
      const comps = sortByMaterialFlow(runner ? desComponentsOf(runner) : []);

      // Track the set of kinds present (for the filter chips).
      const present = Array.from(new Set(comps.map(kindOf)));
      setKinds((prev) => (prev.length === present.length && prev.every((k, i) => k === present[i]) ? prev : present));

      const hidden = hiddenRef.current;
      const rows: Row[] = comps
        .filter((c) => !hidden.has(kindOf(c)))
        .map((c) => {
          const s = c.getStatistics();
          return {
            path: c.path,
            name: (c as { displayName?: string }).displayName ?? c.path.split('/').pop() ?? c.path,
            kind: kindOf(c),
            workingPercent: s.workingPercent,
            chargingPercent: s.chargingPercent ?? 0,
            transportPercent: s.transportPercent ?? 0,
            slowedPercent: s.slowedPercent ?? 0,
            stoppedPercent: s.stoppedPercent ?? 0,
            setupPercent: s.setupPercent,
            blockedPercent: s.blockedPercent,
            emptyPercent: s.emptyPercent,
            failurePercent: s.failurePercent,
            outputPerHour: s.outputPerHour,
            totalProcessed: s.totalProcessed,
            currentState: s.currentState,
            states: extraStates(c),
          };
        });
      rowsRef.current = rows;

      const names = rows.map((r) => r.name);
      const series = buildStackSeries(rows);
      setHasData(series.some(entry => entry.data.some(value => value > 0)));
      const legendData = stackEntries().map((s) => s.label);
      const applied = staticApplied.current;
      if (applied?.chart !== chart) {
        // First tick of this chart instance: static parts once (tooltip, grid, axis styles).
        // They must NOT be re-set per tick, or an open axis tooltip disappears (plan-2030 F4).
        chart.setOption({
          backgroundColor: 'transparent',
          textStyle: DARK_TEXT_STYLE,
          // Vertical stacked columns: components on the X axis (material-flow order,
          // sources left → sinks right), utilization % stacked on the Y axis.
          grid: { left: 48, right: 12, top: 40, bottom: 8, containLabel: true },
          legend: {
            type: 'scroll', data: legendData, top: 0,
            textStyle: { color: 'rgba(255,255,255,0.55)', fontSize: 10 },
            itemWidth: 12, itemHeight: 8,
          },
          tooltip: {
            ...DARK_TOOLTIP_BASE, trigger: 'axis', axisPointer: { type: 'shadow' },
            formatter: (params: unknown) => {
              const arr = params as Array<{ dataIndex: number }>;
              const idx = arr[0]?.dataIndex; const r = rowsRef.current[idx];
              if (!r) return '';
              const line = stackEntries().map((s) => `${s.label}: ${s.value(r).toFixed(0)}%`).join('<br/>');
              return `<b>${r.name}</b> <span style="opacity:0.6">(${r.kind})</span><br/>${line}`
                + `<br/>Output: ${r.outputPerHour.toFixed(0)}/h &nbsp; Total: ${r.totalProcessed}`;
            },
          },
          xAxis: {
            type: 'category', data: names,
            axisLine: DARK_AXIS_LINE, axisTick: { show: false },
            axisLabel: { ...DARK_AXIS_LABEL, rotate: 45, interval: 0, fontSize: FS.micro },
          },
          yAxis: {
            type: 'value', max: 100,
            axisLine: DARK_AXIS_LINE, splitLine: DARK_SPLIT_LINE,
            axisLabel: { ...DARK_AXIS_LABEL, formatter: '{value}%', fontSize: FS.micro },
          },
          series,
        }, { notMerge: true, lazyUpdate: true });
        staticApplied.current = { chart, ext: extVersion };
        return;
      }
      if (applied.ext !== extVersion) {
        // Registered DES states changed: legend + series set change together.
        chart.setOption({ legend: { data: legendData }, xAxis: { data: names }, series },
          { replaceMerge: ['series'], lazyUpdate: true });
        applied.ext = extVersion;
        return;
      }
      // Per tick: only categories + series data, merge mode.
      chart.setOption({ xAxis: { data: names }, series }, { lazyUpdate: true });
    };
    update();
    const id = setInterval(update, REFRESH_MS);
    return () => clearInterval(id);
  }, [active, viewer, chartInstance, extVersion]);

  // Filter chips for each present kind (default all visible).
  const filterBar = useMemo(() => (
    <Stack role="group" aria-label="Component types" direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ px: 1, pt: 0.75 }}>
      {kinds.map((k) => (
        <Chip
          key={k} label={k} size="small" aria-pressed={!hiddenKinds.has(k)}
          variant={hiddenKinds.has(k) ? 'outlined' : 'filled'}
          color={hiddenKinds.has(k) ? 'default' : 'primary'}
          onClick={() => toggleDesStatsHiddenKind(k)}
          sx={{ height: 20, fontSize: 10, textTransform: 'capitalize' }}
        />
      ))}
    </Stack>
  ), [kinds, hiddenKinds]);

  const emptyMessage = kinds.length > 0 && kinds.every(kind => hiddenKinds.has(kind))
    ? 'All component types are hidden.'
    : !hasData ? 'No values yet — start the simulation to collect statistics.' : null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {kinds.length > 1 && filterBar}
      {emptyMessage && <Typography role="status" variant="caption" sx={{ color: 'text.secondary', px: 1, pb: 0.5 }}>{emptyMessage}</Typography>}
      <Box ref={containerRef} aria-hidden={!!emptyMessage} sx={{ flex: 1, minHeight: 0, visibility: emptyMessage ? 'hidden' : 'visible' }} />
    </Box>
  );
}

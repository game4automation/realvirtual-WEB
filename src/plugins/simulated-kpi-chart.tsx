// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Trend window of the simulated KPI chips (`SimulatedKpiPlugin`).
 *
 * A click on a chip opens ONE floating window with the trend of the same
 * simulated source over `historyHours` (default one shift), a dashed target
 * line at `base` and a tolerance band `base ± tolerance`, in the chip's unit.
 * The series ends at "now", so its last point is the value the chip shows.
 *
 * One window per plugin: opening another chip replaces it. It closes via the
 * title-bar X, Escape (both from `FloatingPanel`) or a pointer press outside
 * the window and outside the chips.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box } from '@mui/material';
import { FloatingPanel } from '../core/hmi/FloatingPanel';
import { clientToCSS, getCSSViewportSize } from '../core/hmi/panel-anchor-store';
import { useEChart } from '../hooks/use-echart';
import { createBaseChartOption, DARK_AXIS_LABEL, DARK_AXIS_LINE, DARK_SPLIT_LINE } from '../core/hmi/chart-theme';
import {
  formatSimulatedKpi,
  simulatedKpiBand,
  simulatedKpiHistory,
  simulatedKpiHistoryHours,
  type SimulatedKpiDef,
} from '../core/hmi/simulated-kpi';

/** Attribute that marks a chip, so a press on a chip does not count as "outside". */
export const SIMULATED_KPI_CHIP_ATTR = 'data-simulated-kpi-chip';

/** Which chip's trend window is open (index into the plugin's `kpis`, or null). */
export class SimulatedKpiChartStore {
  private openIndex: number | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): number | null => this.openIndex;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  open(index: number): void { this.set(index); }
  close(): void { this.set(null); }

  private set(index: number | null): void {
    if (this.openIndex === index) return;
    this.openIndex = index;
    for (const fn of this.listeners) fn();
  }
}

/** Clock of the simulated source, in seconds — the same one the chips use. */
export function simulatedKpiNowSec(): number {
  return Date.now() / 1000;
}

function hourLabel(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function TrendChart({ def, refreshMs }: { def: SimulatedKpiDef; refreshMs: number }) {
  const { containerRef, chartInstance, isReady } = useEChart({ open: true });
  const [t, setT] = useState(simulatedKpiNowSec);
  useEffect(() => {
    const h = setInterval(() => setT(simulatedKpiNowSec()), refreshMs);
    return () => clearInterval(h);
  }, [refreshMs]);

  useEffect(() => {
    const chart = chartInstance.current;
    if (!isReady || !chart) return;
    const hist = simulatedKpiHistory(def, t);
    const band = simulatedKpiBand(def);
    const color = def.color ?? '#4fc3f7';
    const spread = Math.max(band.high - band.target, def.amplitude ?? 0, Math.abs(def.base) * 0.01, 1e-6);
    const fmt = (v: number) => formatSimulatedKpi(def, v);
    const base = createBaseChartOption({ grid: { left: 56, right: 16, top: 16, bottom: 28 } });
    chart.setOption(
      {
        ...base,
        legend: { show: false },
        tooltip: {
          ...(base.tooltip as object),
          trigger: 'axis',
          valueFormatter: (v: number) => `${fmt(v)} ${def.unit}`,
        },
        xAxis: {
          type: 'time',
          min: (t - simulatedKpiHistoryHours(def) * 3600) * 1000,
          max: t * 1000,
          axisLine: DARK_AXIS_LINE,
          axisLabel: { ...DARK_AXIS_LABEL, formatter: (ms: number) => hourLabel(ms), hideOverlap: true },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          min: band.target - spread * 1.6,
          max: band.target + spread * 1.6,
          axisLine: DARK_AXIS_LINE,
          axisLabel: { ...DARK_AXIS_LABEL, formatter: (v: number) => `${fmt(v)}` },
          splitLine: DARK_SPLIT_LINE,
          name: def.unit,
          nameTextStyle: { ...DARK_AXIS_LABEL },
        },
        series: [
          {
            name: def.label,
            type: 'line',
            showSymbol: false,
            smooth: 0.3,
            animation: false,
            lineStyle: { color, width: 1.5 },
            itemStyle: { color },
            data: hist.t.map((s, i) => [s * 1000, hist.v[i]]),
            markArea: {
              silent: true,
              itemStyle: { color: 'rgba(102,187,106,0.10)' },
              data: [[{ yAxis: band.low }, { yAxis: band.high }]],
            },
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { type: 'dashed', color: '#60a5fa', width: 1.2 },
              label: { formatter: `Target ${fmt(band.target)} ${def.unit}`, color: '#60a5fa', fontSize: 10, position: 'insideStartTop' },
              data: [{ yAxis: band.target }],
            },
          },
        ],
      },
      { notMerge: true },
    );
  }, [isReady, def, t, chartInstance]);

  return <Box ref={containerRef} data-testid="simulated-kpi-chart" sx={{ flex: 1, minHeight: 0 }} />;
}

const WINDOW_W = 560;
const WINDOW_H = 280;

/**
 * Where the window opens: just below the clicked chip (so it never covers the
 * KPI bar it was opened from), horizontally aligned with the chip and kept on
 * screen. CSS px (zoom-aware), like FloatingPanel's own geometry.
 */
function positionBelowChip(label: string): { x: number; y: number } | undefined {
  if (typeof document === 'undefined') return undefined;
  const host = document.querySelector(`[${SIMULATED_KPI_CHIP_ATTR}="${CSS.escape(label)}"]`);
  const el = host?.firstElementChild ?? host;
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  const vp = getCSSViewportSize();
  const x = Math.max(8, Math.min(clientToCSS(r.left), vp.w - WINDOW_W - 8));
  return { x, y: clientToCSS(r.bottom) + 8 };
}

/** The single trend window of a `SimulatedKpiPlugin` — rendered in the `overlay` slot. */
export function SimulatedKpiChartWindow({
  store, kpis, refreshMs, panelId,
}: { store: SimulatedKpiChartStore; kpis: readonly SimulatedKpiDef[]; refreshMs: number; panelId: string }) {
  const index = useSyncExternalStore(store.subscribe, store.get, store.get);
  const def = index === null ? undefined : kpis[index];
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Click outside closes. A press on a chip is not "outside": the chip's own
  // click then opens (or keeps) its window instead of closing and reopening it.
  useEffect(() => {
    if (!def) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target || typeof target.closest !== 'function') return;
      const panel = contentRef.current?.closest('[data-ui-panel]');
      if (panel && panel.contains(target)) return;
      if (target.closest(`[${SIMULATED_KPI_CHIP_ATTR}]`)) return;
      store.close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [def, store]);

  if (!def || index === null) return null;
  const hours = simulatedKpiHistoryHours(def);
  const band = simulatedKpiBand(def);
  const tolText = band.high > band.target
    ? ` · tolerance ±${formatSimulatedKpi(def, band.high - band.target)} ${def.unit}`
    : '';
  return (
    <FloatingPanel
      key={index}
      open
      onClose={() => store.close()}
      title={def.label}
      titleColor={def.color ?? '#4fc3f7'}
      subtitle={`Last ${hours} h${tolText}`}
      panelId={`${panelId}:${def.label}`}
      defaultWidth={WINDOW_W}
      defaultHeight={WINDOW_H}
      anchorToClick={false}
      defaultPosition={positionBelowChip(def.label)}
      minWidth={320}
      zIndex={1400}
      role="dialog"
      aria-label={`${def.label} trend`}
    >
      <Box ref={contentRef} sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <TrendChart def={def} refreshMs={refreshMs} />
      </Box>
    </FloatingPanel>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TankFillHistoryPlugin — Process-industry trend display of tank fill-levels.
 *
 * Registers a button in the left sidebar (button-group slot) that toggles a
 * floating, draggable, resizable ChartPanel showing a rolling 5-minute
 * historian-style trend chart: one line per tank, colored by its current
 * `resourceName` (medium).
 *
 * Scoped to the DemoProcessIndustry model — registered alongside
 * ProcessIndustryPlugin via src/plugins/models/DemoProcessIndustry/index.ts,
 * so the button disappears on any other model.
 *
 * Design constraints that kept this honest instead of gimmicky:
 *  - % fill on Y-axis (0–100) — tanks of different sizes share the axis.
 *  - 1 Hz sampling, ring buffer of 300 samples (= 5 min).
 *  - Seeds with "now" — no synthetic pre-filled history.
 *  - Alarm bands (<10/>95 red, <20/>90 yellow) as faint markArea shading.
 *    Same thresholds as TankTooltipContent.tsx — visual parity.
 *  - Legend rows click to show/hide a series (historian convention).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { Timeline } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import type { RVTank } from '../core/engine/rv-tank';
import { ChartPanel } from '../core/hmi/ChartPanel';
import { NavButton } from '../core/hmi/NavButton';
import { useEChart } from '../hooks/use-echart';
import { DARK_AXIS_LABEL, DARK_AXIS_LINE, DARK_SPLIT_LINE, DARK_TEXT_STYLE, DARK_TOOLTIP_BASE } from '../core/hmi/chart-theme';
import { ProcessIndustryPlugin } from './processindustry-plugin';

// ─── Config ─────────────────────────────────────────────────────────────

/** Process-fluid palette — mirrors ProcessIndustryPlugin's 3-D mesh palette
 *  so a viewer sees the same color in the chart and on the pipe.
 *
 *  Paint / coatings / resin plant: raw solvents & resins → intermediates →
 *  finished products → recovered solvent. */
export const RESOURCE_COLORS: Record<string, string> = {
  Xylene:              '#b39ddb',
  MEK:                 '#90caf9',
  'Epoxy Resin':       '#ffb74d',
  'Pigment Paste':     '#d84315',
  'Automotive Paint':  '#3949ab',
  'Wood Varnish':      '#6d4c41',
  'Recovered Solvent': '#4db6ac',
};
export const UNKNOWN_COLOR = '#9e9e9e';

export const SAMPLE_INTERVAL_MS = 1000;
export const HISTORY_WINDOW_S = 300;
/** Ring-buffer capacity. 1 Hz × 5 min = 300. */
export const MAX_SAMPLES = HISTORY_WINDOW_S;

/** Default floating-window size — wide enough for a readable time-axis and
 *  tall enough that the legend doesn't crowd the chart. */
const DEFAULT_WIDTH = 760;
const DEFAULT_HEIGHT = 420;

/** Dash cycle for tanks sharing the same medium — differentiates without
 *  shifting hue (ISA-101: color encodes meaning, never rank). Only solid
 *  and dashed: dotted lines read as noisy on a dense trend plot. */
const DASH_CYCLE: ReadonlyArray<'solid' | 'dashed'> = ['solid', 'dashed'];

// ─── Pure helpers (exported for tests) ──────────────────────────────────

export interface Sample { t: number; pct: number; liters: number; }

/** Snapshot a tank's current state. Returns 0% for 0-capacity tanks (no NaN). */
export function sampleTank(tank: Pick<RVTank, 'amount' | 'capacity'>, now: number = Date.now()): Sample {
  const pct = tank.capacity > 0 ? (tank.amount / tank.capacity) * 100 : 0;
  return { t: now, pct, liters: tank.amount };
}

/** Append a sample to a ring buffer, dropping the oldest once past MAX_SAMPLES. */
export function pushCappedSample(buffer: Sample[], sample: Sample): Sample[] {
  buffer.push(sample);
  if (buffer.length > MAX_SAMPLES) buffer.splice(0, buffer.length - MAX_SAMPLES);
  return buffer;
}

/** Resolve a fluid name to its line color; unknown/empty → UNKNOWN_COLOR. */
export function pickColor(resourceName: string): string {
  if (!resourceName) return UNKNOWN_COLOR;
  return RESOURCE_COLORS[resourceName] ?? UNKNOWN_COLOR;
}

/** For a list of tanks, return the per-tank dash style. Same-medium tanks
 *  cycle through DASH_CYCLE so they remain distinguishable on the chart. */
export function assignDashStyles(
  tanks: ReadonlyArray<{ resourceName: string }>,
): Array<'solid' | 'dashed'> {
  const perResource = new Map<string, number>();
  return tanks.map((t) => {
    const key = t.resourceName || '';
    const idx = perResource.get(key) ?? 0;
    perResource.set(key, idx + 1);
    return DASH_CYCLE[idx % DASH_CYCLE.length];
  });
}

// ─── Plugin ─────────────────────────────────────────────────────────────

export class TankFillHistoryPlugin implements RVViewerPlugin {
  readonly id = 'tank-fill-history';
  readonly order = 160;

  /** Sibling ProcessIndustryPlugin — we re-use its tank list instead of
   *  re-traversing the scene. Resolved in onModelLoaded. */
  private processPlugin: ProcessIndustryPlugin | null = null;

  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: TankFillHistoryButton, order: 50 },
  ];

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this.processPlugin = viewer.getPlugin<ProcessIndustryPlugin>('processindustry') ?? null;
  }

  onModelCleared(): void {
    this.processPlugin = null;
  }

  /** Live tank list (empty array if the sibling plugin is absent). */
  getTanks(): readonly RVTank[] {
    return this.processPlugin?.getTanks() ?? [];
  }
}

// ─── Left-sidebar button ────────────────────────────────────────────────

const PANEL_ID = 'tank-fill-history';

function TankFillHistoryButton({ viewer }: UISlotProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <NavButton
        icon={<Timeline />}
        label="Tank History"
        active={open}
        onClick={() => setOpen((o) => !o)}
      />
      <TankFillHistoryPanel viewer={viewer} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

// ─── Floating window ────────────────────────────────────────────────────

interface LiveReading { pct: number; liters: number; capacity: number; resource: string; color: string; }

function TankFillHistoryPanel({ viewer, open, onClose }: { viewer: RVViewer; open: boolean; onClose: () => void }) {
  const plugin = useMemo(
    () => viewer.getPlugin<TankFillHistoryPlugin>('tank-fill-history') ?? null,
    [viewer],
  );
  const tanks = plugin?.getTanks() ?? [];

  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [readings, setReadings] = useState<Map<string, LiveReading>>(new Map());
  const buffers = useRef<Map<string, Sample[]>>(new Map());
  const { containerRef, chartInstance } = useEChart({ open });

  const hasTanks = tanks.length > 0;

  // ── Sampling loop ────────────────────────────────────────────────────
  useEffect(() => {
    if (!open || !hasTanks) return;

    // Seed the ring buffers with a single "now" sample per tank so the chart
    // isn't blank on first paint. Honest seed — no synthetic backstory.
    const seedNow = Date.now();
    for (const tank of tanks) {
      const key = tank.node.uuid;
      if (!buffers.current.has(key)) {
        buffers.current.set(key, [sampleTank(tank, seedNow)]);
      }
    }

    const tick = () => {
      const now = Date.now();
      const nextReadings = new Map<string, LiveReading>();
      for (const tank of tanks) {
        const key = tank.node.uuid;
        const buf = buffers.current.get(key) ?? [];
        const sample = sampleTank(tank, now);
        pushCappedSample(buf, sample);
        buffers.current.set(key, buf);
        nextReadings.set(key, {
          pct: sample.pct,
          liters: sample.liters,
          capacity: tank.capacity,
          resource: tank.resourceName || 'Unknown',
          color: pickColor(tank.resourceName),
        });
      }
      setReadings(nextReadings);
    };

    tick(); // paint once immediately so the chart doesn't flash empty
    const id = setInterval(tick, SAMPLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [open, hasTanks, tanks]);

  // ── Chart configuration ──────────────────────────────────────────────
  useEffect(() => {
    if (!open || !hasTanks) return;
    const chart = chartInstance.current;
    if (!chart) return;

    const dashes = assignDashStyles(tanks);

    // Dedicated invisible band-carrier series so markArea doesn't move with
    // tank visibility toggling.
    const bandsSeries = {
      name: '__bands',
      type: 'line' as const,
      data: [],
      silent: true,
      showSymbol: false,
      lineStyle: { opacity: 0 },
      markArea: {
        silent: true,
        itemStyle: { opacity: 1 },
        data: [
          [{ yAxis: 0,  itemStyle: { color: 'rgba(208,2,27,0.08)' } }, { yAxis: 10  }],
          [{ yAxis: 10, itemStyle: { color: 'rgba(245,166,35,0.08)' } }, { yAxis: 20 }],
          [{ yAxis: 80, itemStyle: { color: 'rgba(245,166,35,0.08)' } }, { yAxis: 90 }],
          [{ yAxis: 90, itemStyle: { color: 'rgba(245,166,35,0.08)' } }, { yAxis: 95 }],
          [{ yAxis: 95, itemStyle: { color: 'rgba(208,2,27,0.08)' } }, { yAxis: 100 }],
        ],
      },
    };

    const dataSeries = tanks.map((tank, i) => {
      const key = tank.node.uuid;
      const buf = buffers.current.get(key) ?? [];
      const isHidden = hidden.has(key);
      return {
        name: tank.node.name || `Tank ${i + 1}`,
        type: 'line' as const,
        showSymbol: false,
        sampling: 'lttb' as const,
        lineStyle: {
          color: pickColor(tank.resourceName),
          type: dashes[i],
          width: 1.5,
          opacity: isHidden ? 0 : 1,
        },
        itemStyle: { color: pickColor(tank.resourceName) },
        data: isHidden ? [] : buf.map((s) => [s.t, s.pct]),
      };
    });

    chart.setOption(
      {
        backgroundColor: 'transparent',
        textStyle: DARK_TEXT_STYLE,
        animation: false,
        grid: { left: 44, right: 14, top: 16, bottom: 28 },
        tooltip: {
          ...DARK_TOOLTIP_BASE,
          trigger: 'axis',
          axisPointer: { type: 'cross', snap: true, label: { backgroundColor: 'rgba(10,10,10,0.92)' } },
          formatter: (params: unknown) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ps = (params as any[]).filter((p) => p.seriesName !== '__bands');
            if (ps.length === 0) return '';
            const t = new Date(ps[0].value[0]);
            const hh = String(t.getHours()).padStart(2, '0');
            const mm = String(t.getMinutes()).padStart(2, '0');
            const ss = String(t.getSeconds()).padStart(2, '0');
            let html = `<b>${hh}:${mm}:${ss}</b><br/>`;
            for (const p of ps) {
              html += `${p.marker} ${p.seriesName}: <b>${Number(p.value[1]).toFixed(1)}%</b><br/>`;
            }
            return html;
          },
        },
        xAxis: {
          type: 'time',
          axisLine: DARK_AXIS_LINE,
          axisLabel: {
            ...DARK_AXIS_LABEL,
            formatter: (v: number) => {
              const d = new Date(v);
              return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
            },
          },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          min: 0,
          max: 100,
          axisLine: DARK_AXIS_LINE,
          axisLabel: { ...DARK_AXIS_LABEL, formatter: '{value}%' },
          splitLine: DARK_SPLIT_LINE,
        },
        series: [bandsSeries, ...dataSeries],
      },
      { notMerge: true },
    );
  }, [open, chartInstance, tanks, hasTanks, hidden, readings]);

  const toggleHidden = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Center-ish default position so first-time open is obviously on screen.
  // ChartPanel additionally clamps to the viewport whenever `open` goes true.
  const defaultPos = useMemo(() => ({
    x: Math.max(80, Math.round(window.innerWidth / 2 - DEFAULT_WIDTH / 2)),
    y: Math.max(24, Math.round(window.innerHeight / 2 - DEFAULT_HEIGHT / 2) - 60),
  }), []);

  return (
    <ChartPanel
      open={open}
      onClose={onClose}
      title="Tank Fill History"
      titleColor="#4fc3f7"
      subtitle={`Last ${HISTORY_WINDOW_S / 60} min · ${SAMPLE_INTERVAL_MS} ms`}
      defaultWidth={DEFAULT_WIDTH}
      defaultHeight={DEFAULT_HEIGHT}
      defaultPosition={defaultPos}
      zIndex={1500}
      panelId={PANEL_ID}
    >
      {!hasTanks ? (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', px: 2 }}>
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
            No tanks in the current scene.
          </Typography>
        </Box>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
          {/* Chart area */}
          <Box ref={containerRef} sx={{ flex: 1, minWidth: 0 }} />

          {/* Legend column — scrollable, fixed width. */}
          <Box sx={{
            flexShrink: 0, width: 200, overflow: 'auto',
            borderLeft: '1px solid rgba(255,255,255,0.08)',
            py: 0.5,
          }}>
            {tanks.map((tank) => {
              const key = tank.node.uuid;
              const r = readings.get(key);
              const isHidden = hidden.has(key);
              const color = r?.color ?? pickColor(tank.resourceName);
              return (
                <Box
                  key={key}
                  onClick={() => toggleHidden(key)}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 0.75,
                    px: 1, py: 0.4, cursor: 'pointer',
                    opacity: isHidden ? 0.4 : 1,
                    '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
                  }}
                >
                  <Box sx={{
                    width: 12, height: 3, borderRadius: 0.5, flexShrink: 0,
                    bgcolor: color,
                    opacity: isHidden ? 0.35 : 1,
                  }} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{
                      fontSize: 11, color: '#fff', lineHeight: 1.2,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      textDecoration: isHidden ? 'line-through' : 'none',
                    }}>
                      {tank.node.name}
                    </Typography>
                    <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', lineHeight: 1.2 }}>
                      {r?.resource ?? '—'}
                    </Typography>
                  </Box>
                  <Typography sx={{
                    fontSize: 11, color, fontFamily: 'monospace', fontWeight: 700,
                    minWidth: 42, textAlign: 'right',
                  }}>
                    {r ? `${r.pct.toFixed(1)}%` : '—'}
                  </Typography>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}
    </ChartPanel>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Chip, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { StatsSectionBodyProps } from '../../core/stats/rv-stats-registry';
import type { TraceRow, TraceView } from '../../core/engine/rv-path-trace';
import type { PathTracePlugin } from '../path-trace-plugin';
import { getOverlaySnapshot, subscribeOverlayVisibility } from '../../core/overlay-visibility-store';
import {
  getTraceLegend, getTraceSettings, setTracePreset, subscribeTraceLegend, subscribeTraceSettings, tracePresetOf,
} from '../../core/trace-settings-store';
import { formatDecimal } from '../../core/hmi/rv-number-format';
import { InspectorRow, INSPECTOR_ROW_PX } from '../../core/hmi/rv-inspector-row';
import { InspectorSubheader } from '../../core/hmi/rv-inspector-blocks';
import { FS, INK_LOW, MONO } from '../../core/hmi/shared-sx';

const VIEWS = ['blocked', 'utilization'] as const;
const LABELS = { blocked: 'Blocked share', utilization: 'Utilization' };
const percent = (value: number) => `${formatDecimal(value * 100, 1)} %`;
// Bucket bounds are arc lengths (2.35619449019 m on a curve) — one decimal is the display.
const metres = (value: number) => formatDecimal(value, 1);

export default function PathTrafficSection({ viewer, active }: StatsSectionBodyProps) {
  const trace = viewer.getPlugin<PathTracePlugin>('path-trace')?.trace;
  const settings = useSyncExternalStore(subscribeTraceSettings, getTraceSettings);
  const legend = useSyncExternalStore(subscribeTraceLegend, getTraceLegend);
  const overlays = useSyncExternalStore(subscribeOverlayVisibility, getOverlaySnapshot);
  const blocked = !overlays.hidden.has('trace-blocked');
  const utilization = !overlays.hidden.has('trace-utilization');
  // topN fills the same arrays/rows on every refresh, without allocating output per tick.
  const [rows] = useState<Record<TraceView, TraceRow[]>>(() => ({ blocked: [], utilization: [] }));
  const [, refresh] = useState(0);
  useEffect(() => {
    if (!active || !trace || (!blocked && !utilization)) return;
    const update = () => {
      if (blocked) trace.topN('blocked', settings.range, 10, rows.blocked);
      if (utilization) trace.topN('utilization', settings.range, 10, rows.utilization);
      refresh(version => version + 1);
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [active, trace, blocked, utilization, settings, rows]);

  if (!active) return null;
  return <>
    <InspectorRow label="Time range" alignField="end">
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
        {([['hour', 'Last hour'], ['day', 'Last day'], ['total', 'Since start']] as const).map(([preset, label]) =>
          <Chip key={preset} label={label} size="small" component="button" type="button"
            data-testid={`trace-range-${preset}`} aria-pressed={tracePresetOf(settings) === preset}
            color={tracePresetOf(settings) === preset ? 'primary' : 'default'}
            onClick={() => { setTracePreset(preset); viewer.markRenderDirty?.(); }} />)}
      </Box>
    </InspectorRow>
    {VIEWS.map(view => {
      if (view === 'blocked' ? !blocked : !utilization) return null;
      const range = legend[view];
      return <Box key={view}>
        <InspectorSubheader>{LABELS[view]}</InspectorSubheader>
        {rows[view].length === 0 ? <Typography role="status" variant="caption" sx={{ color: 'text.secondary', px: INSPECTOR_ROW_PX }}>No traffic recorded in this time range yet.</Typography> : <>
        <Box data-testid={`trace-legend-${view}`} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5, px: INSPECTOR_ROW_PX }}>
          <Typography variant="caption" sx={{ fontFamily: MONO }}>{range ? percent(range.lo) : '—'}</Typography>
          <Box sx={{ flex: 1, height: 6, borderRadius: 3, background: 'linear-gradient(90deg, #fbc02d, #d32f2f)' }} />
          <Typography variant="caption" sx={{ fontFamily: MONO }}>{range ? percent(range.hi) : '—'}</Typography>
        </Box>
        <Table size="small" aria-label={`${LABELS[view]} top 10`} sx={{
          '& .MuiTableCell-root': { fontSize: FS.body, py: 0.5, px: 1 },
          '& .MuiTableCell-head': { fontSize: FS.micro, color: INK_LOW, textTransform: 'uppercase' },
        }}>
          <TableHead><TableRow><TableCell>Path</TableCell><TableCell>Section</TableCell><TableCell align="right">Value (%)</TableCell></TableRow></TableHead>
          <TableBody>{rows[view].map(row => <TableRow key={`${row.pathId}:${row.fromM}`}>
            <TableCell>{row.pathId}</TableCell>
            <TableCell sx={{ fontFamily: MONO }}>{metres(row.fromM)}–{metres(row.toM)} m</TableCell>
            <TableCell align="right" sx={{ fontFamily: MONO }}>{percent(row.value)}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
        </>}
      </Box>;
    })}
  </>;
}

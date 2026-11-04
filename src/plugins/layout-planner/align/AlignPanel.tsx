// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AlignPanel — the small floating window of the planner Align tool (plan-779).
 * Loaded lazily by AlignPanelHost on the first open.
 */

import { useState, useSyncExternalStore } from 'react';
import { Box, Button, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { FloatingPanel } from '../../../core/hmi/FloatingPanel';
import { Vector3Editor } from '../../../core/hmi/rv-field-editors';
import { INK_HIGH, INK_LOW, INK_MID } from '../../../core/hmi/shared-sx';
import { useViewer } from '../../../hooks/use-viewer';
import { evaluateAlign, runAlign } from './align-action';
import {
  alignClose,
  armAlignSlot,
  getAlignSnapshot,
  isSlotAlive,
  setAlignAxes,
  setAlignOffsetMm,
  subscribeAlign,
  type AlignSlot,
  type AlignSlotId,
} from './align-state';

const PANEL_WIDTH = 290;
const COLOR_A = '#ffa726';
const COLOR_B = '#42a5f5';

function SlotRow({ id, slot, armed, color }: { id: AlignSlotId; slot: AlignSlot | null; armed: boolean; color: string }) {
  const alive = isSlotAlive(slot);
  const text = armed ? 'Pick a corner…' : !slot ? '—' : alive ? slot.label : 'object gone';
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={() => armAlignSlot(id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') armAlignSlot(id); }}
      sx={{
        display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, mb: 0.5,
        borderRadius: 0.5, cursor: 'pointer',
        border: '1px solid', borderColor: armed ? color : 'rgba(255,255,255,0.1)',
        bgcolor: armed ? 'rgba(255,255,255,0.06)' : 'transparent',
        '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' },
      }}
      aria-label={`Align slot ${id}`}
    >
      <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: color, flex: 'none' }} />
      <Typography sx={{ fontSize: 12, fontWeight: 700, color: INK_HIGH, width: 14 }}>{id}</Typography>
      <Typography
        noWrap
        sx={{ fontSize: 12, flex: 1, color: armed ? INK_HIGH : slot && !alive ? 'warning.main' : INK_MID, fontStyle: armed ? 'italic' : 'normal' }}
      >
        {text}
      </Typography>
    </Box>
  );
}

export function AlignPanel() {
  const viewer = useViewer();
  const snap = useSyncExternalStore(subscribeAlign, getAlignSnapshot);
  const [busy, setBusy] = useState(false);
  const ev = evaluateAlign(viewer);
  const axesValue = (['x', 'y', 'z'] as const).filter((k) => snap.axes[k]);
  const fmt = (k: 'x' | 'y' | 'z'): string =>
    snap.axes[k] && ev.cornerA && ev.cornerB ? (ev.delta[k] * 1000).toFixed(1) : '—';

  return (
    <FloatingPanel
      open={snap.open}
      onClose={alignClose}
      title="Align"
      panelId="layout-align"
      fixedWidth={PANEL_WIDTH}
      minWidth={PANEL_WIDTH}
      autoHeight
      resizable={false}
    >
      <Box sx={{ px: 1.5, py: 1 }}>
        <SlotRow id="A" slot={snap.a} armed={snap.armed === 'A'} color={COLOR_A} />
        <SlotRow id="B" slot={snap.b} armed={snap.armed === 'B'} color={COLOR_B} />

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
          <Typography sx={{ fontSize: 11, color: INK_LOW, width: 64 }}>Axes</Typography>
          <ToggleButtonGroup
            size="small"
            value={axesValue}
            onChange={(_e, v: string[]) => setAlignAxes({ x: v.includes('x'), y: v.includes('y'), z: v.includes('z') })}
            sx={{
              '& .MuiToggleButton-root': {
                fontSize: 11, py: 0.15, px: 1.2, textTransform: 'none',
                color: 'rgba(255,255,255,0.5)', borderColor: 'rgba(255,255,255,0.1)',
                '&.Mui-selected.axis-x': { color: '#ef5350', bgcolor: 'rgba(239,83,80,0.15)' },
                '&.Mui-selected.axis-y': { color: '#66bb6a', bgcolor: 'rgba(102,187,106,0.15)' },
                '&.Mui-selected.axis-z': { color: '#42a5f5', bgcolor: 'rgba(66,165,245,0.15)' },
              },
            }}
          >
            <ToggleButton value="x" className="axis-x">X</ToggleButton>
            <ToggleButton value="y" className="axis-y">Y</ToggleButton>
            <ToggleButton value="z" className="axis-z">Z</ToggleButton>
          </ToggleButtonGroup>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
          <Typography sx={{ fontSize: 11, color: INK_LOW, width: 64, flex: 'none' }}>Offset mm</Typography>
          <Vector3Editor value={snap.offsetMm} onChange={(v) => setAlignOffsetMm(v)} />
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
          <Typography sx={{ fontSize: 11, color: INK_LOW, width: 64, flex: 'none' }}>Move mm</Typography>
          {(['x', 'y', 'z'] as const).map((k) => (
            <Typography
              key={k}
              sx={{ fontSize: 11, fontFamily: 'monospace', flex: 1, color: snap.axes[k] ? INK_HIGH : INK_LOW }}
            >
              {k.toUpperCase()} {fmt(k)}
            </Typography>
          ))}
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.25 }}>
          <Button
            size="small"
            variant="contained"
            disabled={!ev.canAlign || busy}
            onClick={() => {
              setBusy(true);
              void runAlign(viewer).finally(() => setBusy(false));
            }}
            sx={{ textTransform: 'none', fontSize: 12, py: 0.25, px: 2 }}
          >
            Align
          </Button>
        </Box>
      </Box>
    </FloatingPanel>
  );
}

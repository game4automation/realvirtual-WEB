// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ClippingPanel — Section / Clip tool panel.
 *
 * Per axis (X/Y/Z): an enable Switch, a position Slider (-100..+100 %,
 * normalized to the model bounding box) and a Flip button. Plus a global
 * "Reset All". Rendered in the shared FloatingPanel chrome (draggable,
 * resizable) — same base object as the chart / DES / sensor-history overlays,
 * so it works in every workspace mode (HMI, Planner, DES, Editor), not just
 * the docked-left HMI panels. Visibility follows the plugin's `active` flag.
 */

import { useSyncExternalStore, useCallback } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Switch,
  Slider,
  Button,
} from '@mui/material';
import { SwapHoriz, RestartAlt } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import {
  subscribeClipping,
  getClippingSnapshot,
} from '../../plugins/rv-clipping-plugin';
import type { ClipAxis, ClippingPlugin } from '../../plugins/rv-clipping-plugin';
import { FloatingPanel } from './FloatingPanel';

// ── Constants ──────────────────────────────────────────────────────────

const PANEL_WIDTH = 300;
const PANEL_HEIGHT = 260;
const AXIS_COLOR: Record<ClipAxis, string> = { x: '#ef5350', y: '#66bb6a', z: '#42a5f5' };
const AXIS_LABEL: Record<ClipAxis, string> = { x: 'X', y: 'Y', z: 'Z' };
const AXES: ClipAxis[] = ['x', 'y', 'z'];

// ── Panel Component ────────────────────────────────────────────────────

export function ClippingPanel() {
  const viewer = useViewer();
  const snap = useSyncExternalStore(subscribeClipping, getClippingSnapshot);
  const plugin = viewer.getPlugin('clipping') as ClippingPlugin | undefined;

  const handleClose = useCallback(() => {
    plugin?.closePanel();
  }, [plugin]);

  const handleToggle = useCallback((axis: ClipAxis, enabled: boolean) => {
    plugin?.setAxis(axis, { enabled });
  }, [plugin]);

  const handlePosition = useCallback((axis: ClipAxis, v: number | number[]) => {
    const val = typeof v === 'number' ? v : v[0];
    plugin?.setAxis(axis, { position: val / 100 });
  }, [plugin]);

  const handleFlip = useCallback((axis: ClipAxis, flip: boolean) => {
    plugin?.setAxis(axis, { flip: !flip });
  }, [plugin]);

  const handleReset = useCallback(() => {
    plugin?.resetAll();
  }, [plugin]);

  return (
    <FloatingPanel
      open={snap.active && !!plugin}
      onClose={handleClose}
      title="Section / Clip"
      panelId="section-clip"
      defaultWidth={PANEL_WIDTH}
      defaultHeight={PANEL_HEIGHT}
      minWidth={PANEL_WIDTH}
    >
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', py: 1, px: 1.5 }}>
        {AXES.map((axis) => {
          const s = snap.state[axis];
          const color = AXIS_COLOR[axis];
          return (
            <Box key={axis} sx={{ mb: 1.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Typography sx={{ fontSize: 13, fontWeight: 700, color, width: 16 }}>
                  {AXIS_LABEL[axis]}
                </Typography>
                <Switch
                  size="small"
                  checked={s.enabled}
                  onChange={(e) => handleToggle(axis, e.target.checked)}
                  sx={{
                    '& .Mui-checked': { color },
                    '& .Mui-checked + .MuiSwitch-track': { backgroundColor: color },
                  }}
                />
                <Box sx={{ flexGrow: 1 }} />
                <IconButton
                  size="small"
                  onClick={() => handleFlip(axis, s.flip)}
                  disabled={!s.enabled}
                  title="Flip cut direction"
                  sx={{ color: s.flip ? color : 'rgba(255,255,255,0.35)', p: 0.25 }}
                >
                  <SwapHoriz sx={{ fontSize: 16 }} />
                </IconButton>
              </Box>
              <Slider
                size="small"
                min={-100}
                max={100}
                step={1}
                value={Math.round(s.position * 100)}
                disabled={!s.enabled}
                onChange={(_, v) => handlePosition(axis, v)}
                sx={{
                  color,
                  '& .MuiSlider-thumb': { width: 10, height: 10 },
                  '& .MuiSlider-track': { height: 2 },
                  '& .MuiSlider-rail': { height: 2, opacity: 0.2 },
                }}
              />
            </Box>
          );
        })}
      </Box>

      <Box sx={{ p: 1, borderTop: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
        <Button
          fullWidth
          size="small"
          variant="outlined"
          startIcon={<RestartAlt sx={{ fontSize: 16 }} />}
          onClick={handleReset}
          sx={{
            textTransform: 'none',
            fontSize: 12,
            color: 'text.secondary',
            borderColor: 'rgba(255,255,255,0.15)',
            '&:hover': { borderColor: '#4fc3f7', color: '#4fc3f7' },
          }}
        >
          Reset All
        </Button>
      </Box>
    </FloatingPanel>
  );
}

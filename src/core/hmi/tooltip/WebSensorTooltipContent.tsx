// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * WebSensorTooltipContent — Renders a minimal tooltip for WebSensor nodes
 * showing only the sensor ID (Label) and current state.
 *
 * When the tooltip is pinned (user selected the sensor), an extra
 * "Show" button appears that opens the floating SensorHistoryPanel
 * (plan-156). The button is hidden on hover tooltips to keep the
 * hover UI minimal.
 *
 * Self-registers in the TooltipContentRegistry at module load.
 */

import { useState, useEffect } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { Timeline as TimelineIcon } from '@mui/icons-material';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';
import {
  WebSensorConfig,
  type RVWebSensor,
  type WebSensorState,
} from '../../engine/rv-web-sensor';
import { sensorHistoryStore } from '../sensor-history-store';

const REFRESH_MS = 100;

/** Data shape for web-sensor tooltips. */
export interface WebSensorTooltipData extends TooltipData {
  type: 'web-sensor';
  nodePath: string;
  /** Pre-resolved label for the Show-button aria-label + history panel header. */
  label: string;
  /** Whether the sensor may emit warning/error (int-driven) or only low/high (bool). */
  isInt: boolean;
}

/** Display label per state (uppercase for badge feel). */
const STATE_LABEL: Record<WebSensorState, string> = {
  low:     'LOW',
  high:    'HIGH',
  warning: 'WARN',
  error:   'ERROR',
  unbound: 'UNBOUND',
};

function colorForState(s: WebSensorState): string {
  return '#' + WebSensorConfig.stateStyles[s].color.toString(16).padStart(6, '0');
}

/** WebSensor tooltip content provider component. */
export function WebSensorTooltipContent({ data, viewer, isPinned }: TooltipContentProps<WebSensorTooltipData>) {
  const [info, setInfo] = useState<{ label: string; state: WebSensorState } | null>(null);

  useEffect(() => {
    const node = viewer?.registry?.getNode(data.nodePath);
    if (!node) return;

    const tick = () => {
      const inst = node.userData._rvWebSensor as RVWebSensor | undefined;
      if (!inst) return;
      setInfo({
        label: inst.Label || '(no label)',
        state: inst.getCurrentState(),
      });
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, data.nodePath]);

  // Fallback while live data hasn't ticked yet — use the label carried in data.
  const label = info?.label ?? data.label ?? '(no label)';
  const state = info?.state;
  const stateColor = state ? colorForState(state) : '#808080';

  const handleShow = () => {
    sensorHistoryStore.open({
      path:  data.nodePath,
      label,
      isInt: Boolean(data.isInt),
    });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.25 }}>
        {/* State color dot */}
        <Box sx={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          bgcolor: stateColor,
          flexShrink: 0,
        }} />
        {/* Sensor ID */}
        <Typography
          variant="subtitle2"
          sx={{ color: '#fff', fontWeight: 700, fontSize: 13, lineHeight: 1.2, fontFamily: 'monospace' }}
        >
          {label}
        </Typography>
        {/* State label */}
        {state && (
          <Typography
            variant="caption"
            sx={{ color: stateColor, fontSize: 11, fontWeight: 700, ml: 'auto', letterSpacing: 0.5 }}
          >
            {STATE_LABEL[state]}
          </Typography>
        )}
      </Box>

      {isPinned && (
        <Button
          size="small"
          variant="outlined"
          startIcon={<TimelineIcon />}
          onClick={handleShow}
          aria-label={`Show history for ${label}`}
          sx={{
            alignSelf: 'flex-start',
            mt: 0.25,
            py: 0.1,
            fontSize: 11,
            textTransform: 'none',
            color: '#4fc3f7',
            borderColor: 'rgba(79,195,247,0.5)',
            '&:hover': {
              borderColor: '#4fc3f7',
              bgcolor: 'rgba(79,195,247,0.08)',
            },
          }}
        >
          Show
        </Button>
      )}
    </Box>
  );
}

// ── Self-registration ──
tooltipRegistry.register({
  contentType: 'web-sensor',
  component: WebSensorTooltipContent as any,
});

// ── Data resolver for GenericTooltipController ──
tooltipRegistry.registerDataResolver('web-sensor', (node, viewer) => {
  const path = viewer.registry?.getPathForNode(node) ?? '';
  if (!path) return null;
  // Resolve label + isInt from the RVWebSensor instance on the node's userData.
  const inst = node.userData._rvWebSensor as RVWebSensor | undefined;
  const label = inst?.Label || path.split('/').pop() || '(sensor)';
  const isInt = Boolean(inst?.SignalInt);
  return { type: 'web-sensor', nodePath: path, label, isInt };
});

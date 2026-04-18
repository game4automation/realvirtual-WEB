// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PumpTooltipContent — Renders pump info (status, flow rate)
 * inside the generic TooltipLayer.
 *
 * Self-registers in the TooltipContentRegistry at module load.
 */

import { useState, useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';

const REFRESH_MS = 100;

/** Data shape for pump tooltips. */
export interface PumpTooltipData extends TooltipData {
  type: 'pump';
  nodePath: string;
}

/** Row helper: label on left, value on right in monospace. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ color: '#fff', fontSize: 11, fontFamily: 'monospace' }}>
        {value}
      </Typography>
    </Box>
  );
}

function formatFlow(val: number): string {
  if (Math.abs(val) >= 1000) return `${(val / 1000).toFixed(2)} m³/h`;
  return `${val.toFixed(1)} l/min`;
}

/** Pump tooltip content provider component. */
export function PumpTooltipContent({ data, viewer }: TooltipContentProps<PumpTooltipData>) {
  const [pumpData, setPumpData] = useState<{
    flowRate: number;
  } | null>(null);

  useEffect(() => {
    const node = viewer.registry?.getNode(data.nodePath);
    if (!node) return;

    const tick = () => {
      const rv = node.userData._rvPump;
      if (!rv) return;
      setPumpData({ flowRate: rv.flowRate ?? 0 });
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, data.nodePath]);

  if (!pumpData) return null;

  const isRunning = pumpData.flowRate > 0;
  const statusColor = isRunning ? '#27AE60' : '#9B9B9B';
  const statusText = isRunning ? 'Running' : 'Stopped';

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.25 }}>
        <Box sx={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          bgcolor: statusColor,
          flexShrink: 0,
        }} />
        <Typography
          variant="subtitle2"
          sx={{ color: '#4fc3f7', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}
        >
          {data.nodePath.split('/').pop() ?? 'Pump'}
        </Typography>
        <Typography variant="caption" sx={{ color: statusColor, fontSize: 10, fontWeight: 600, ml: 'auto' }}>
          {statusText}
        </Typography>
      </Box>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block', mb: 0.5 }}>
        Pump
      </Typography>
      <Row label="Flow" value={formatFlow(pumpData.flowRate)} />
    </>
  );
}

// ── Self-registration (content provider only) ──
// The data resolver for 'pump' is registered by the RVPump class module via
// registerTooltipComponent() — single source of truth.
tooltipRegistry.register({
  contentType: 'pump',
  component: PumpTooltipContent as any,
});

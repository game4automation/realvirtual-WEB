// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PipeTooltipContent — Renders pipe info (resource, flow rate, direction)
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

/** Data shape for pipe tooltips. */
export interface PipeTooltipData extends TooltipData {
  type: 'pipe';
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

/** Pipe tooltip content provider component. */
export function PipeTooltipContent({ data, viewer }: TooltipContentProps<PipeTooltipData>) {
  const [pipeData, setPipeData] = useState<{
    resourceName: string;
    flowRate: number;
  } | null>(null);

  useEffect(() => {
    const node = viewer.registry?.getNode(data.nodePath);
    if (!node) return;

    const tick = () => {
      const rv = node.userData._rvPipe;
      if (!rv) return;
      setPipeData({
        resourceName: rv.resourceName || 'Unknown',
        flowRate: rv.flowRate ?? 0,
      });
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, data.nodePath]);

  if (!pipeData) return null;

  const dirArrow = pipeData.flowRate > 0 ? ' →' : pipeData.flowRate < 0 ? ' ←' : '';

  return (
    <>
      <Typography
        variant="subtitle2"
        sx={{ color: '#4fc3f7', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}
      >
        {data.nodePath.split('/').pop() ?? 'Pipe'}
      </Typography>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block', mb: 0.5 }}>
        Pipe
      </Typography>
      <Row label="Medium" value={pipeData.resourceName} />
      <Row label="Flow" value={`${formatFlow(pipeData.flowRate)}${dirArrow}`} />
    </>
  );
}

// ── Self-registration ──
tooltipRegistry.register({
  contentType: 'pipe',
  component: PipeTooltipContent as any,
});

// ── Data resolver for GenericTooltipController ──
tooltipRegistry.registerDataResolver('pipe', (node, viewer) => {
  const path = viewer.registry?.getPathForNode(node) ?? '';
  return path ? { type: 'pipe', nodePath: path } : null;
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TankTooltipContent — Renders tank info (fill level, capacity, temperature, pressure)
 * inside the generic TooltipLayer.
 *
 * Includes a mini fill-level bar with ISA-101-compliant color coding.
 * Self-registers in the TooltipContentRegistry at module load.
 */

import { useState, useEffect } from 'react';
import { Box, Typography } from '@mui/material';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';

const REFRESH_MS = 100;

/** Data shape for tank tooltips. */
export interface TankTooltipData extends TooltipData {
  type: 'tank';
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

/** ISA-101 fill-level color: green=normal, yellow=warning, red=alarm. */
function getLevelColor(fraction: number): string {
  if (fraction < 0.1 || fraction > 0.95) return '#D0021B'; // alarm red
  if (fraction < 0.2 || fraction > 0.9) return '#F5A623';  // warning yellow
  return '#27AE60'; // normal green
}

/** Mini fill-level bar component. */
function FillBar({ fraction }: { fraction: number }) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const color = getLevelColor(clamped);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
      <Box sx={{
        width: 60,
        height: 8,
        bgcolor: 'rgba(255,255,255,0.1)',
        borderRadius: 0.5,
        overflow: 'hidden',
        position: 'relative',
      }}>
        <Box sx={{
          position: 'absolute',
          left: 0,
          bottom: 0,
          width: '100%',
          height: `${clamped * 100}%`,
          bgcolor: color,
          transition: 'height 0.3s, background-color 0.3s',
        }} />
      </Box>
      <Typography variant="caption" sx={{ color, fontSize: 11, fontFamily: 'monospace', fontWeight: 700 }}>
        {(clamped * 100).toFixed(1)}%
      </Typography>
    </Box>
  );
}

/** Tank tooltip content provider component. */
export function TankTooltipContent({ data, viewer }: TooltipContentProps<TankTooltipData>) {
  const [tankData, setTankData] = useState<{
    resourceName: string;
    capacity: number;
    amount: number;
    pressure: number;
    temperature: number;
  } | null>(null);

  useEffect(() => {
    const node = viewer.registry?.getNode(data.nodePath);
    if (!node) return;

    const tick = () => {
      const rv = node.userData._rvTank;
      if (!rv) return;
      setTankData({
        resourceName: rv.resourceName || 'Unknown',
        capacity: rv.capacity ?? 0,
        amount: rv.amount ?? 0,
        pressure: rv.pressure ?? 0,
        temperature: rv.temperature ?? 0,
      });
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [viewer, data.nodePath]);

  if (!tankData) return null;

  const fraction = tankData.capacity > 0 ? tankData.amount / tankData.capacity : 0;

  return (
    <>
      <Typography
        variant="subtitle2"
        sx={{ color: '#4fc3f7', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}
      >
        {data.nodePath.split('/').pop() ?? 'Tank'}
      </Typography>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block', mb: 0.5 }}>
        Tank
      </Typography>
      <FillBar fraction={fraction} />
      <Row label="Level" value={`${tankData.amount.toFixed(0)} / ${tankData.capacity.toFixed(0)} l`} />
      <Row label="Medium" value={tankData.resourceName} />
      {tankData.temperature !== 0 && (
        <Row label="Temp" value={`${tankData.temperature.toFixed(1)} °C`} />
      )}
      {tankData.pressure !== 0 && (
        <Row label="Pressure" value={`${tankData.pressure.toFixed(2)} bar`} />
      )}
    </>
  );
}

// ── Self-registration ──
tooltipRegistry.register({
  contentType: 'tank',
  component: TankTooltipContent as any,
});

// ── Data resolver for GenericTooltipController ──
tooltipRegistry.registerDataResolver('tank', (node, viewer) => {
  const path = viewer.registry?.getPathForNode(node) ?? '';
  return path ? { type: 'tank', nodePath: path } : null;
});

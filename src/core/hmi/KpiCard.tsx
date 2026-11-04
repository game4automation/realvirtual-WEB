// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect, useRef } from 'react';
import { Box, Typography, Paper } from '@mui/material';
import { ACCENT, FIELD_BORDER, FIELD_BORDER_HOVER, FS, INK_MID, MONO } from './shared-sx';

interface KpiCardProps {
  label: string;
  value: string;
  unit: string;
  secondary?: string;
  color?: string;
  sparkline?: number[];
  /** Enable slow rolling demo animation (default: true) */
  animate?: boolean;
  onClick?: () => void;
}

function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const w = 120;
  const h = 28;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = w / (data.length - 1);

  const points = data
    .map((v, i) => `${i * step},${h - ((v - min) / range) * (h - 4) - 2}`)
    .join(' ');

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        bottom: 4,
        left: 0,
        width: '100%',
        height: '50%',
        opacity: 0.25,
      }}
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Static dummy sparkline data per KPI
const SPARKLINES: Record<string, number[]> = {
  OEE: [82, 84, 81, 86, 87, 85, 88, 87, 86, 87, 89, 87, 86, 88, 87],
  'Parts/h': [26, 28, 27, 29, 30, 28, 31, 28, 30, 28, 29, 28, 27, 29, 28],
  'Cycle Time': [132, 127, 130, 126, 129, 131, 126, 128, 130, 129, 127, 129, 131, 128, 129],
  Power: [18.2, 19.5, 22.1, 24.3, 23.8, 21.4, 8.5, 22.7, 24.1, 23.5, 22.9, 19.8, 8.2, 23.6, 24.0],
};

/** Detect decimal precision of the original value string (e.g. "4.2" → 1, "87" → 0) */
function detectPrecision(value: string): number {
  const dot = value.indexOf('.');
  return dot < 0 ? 0 : value.length - dot - 1;
}

/**
 * Hook that slowly rolls sparkline data and drifts the displayed value.
 * Shifts the array left every ~1.5s and appends a jittered new point.
 */
function useAnimatedKpi(seed: number[], baseValue: string, active: boolean) {
  const precision = detectPrecision(baseValue);
  const [data, setData] = useState<number[]>(() => [...seed]);
  const [displayValue, setDisplayValue] = useState(baseValue);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!active || seed.length < 2) return;

    // Compute a stable center and range from the seed data
    const sMin = Math.min(...seed);
    const sMax = Math.max(...seed);
    const sCenter = (sMin + sMax) / 2;
    const sRange = sMax - sMin || 1;
    const jit = sRange * 0.15; // ±15% of the data range per tick

    const interval = setInterval(() => {
      const prev = dataRef.current;
      const last = prev[prev.length - 1];
      // Random walk with mean-reversion toward seed center
      const reversion = (sCenter - last) * 0.1;
      const noise = (Math.random() - 0.5) * 2 * jit;
      let next = last + reversion + noise;
      // Clamp within a reasonable band around the seed range
      next = Math.max(sMin - sRange * 0.2, Math.min(sMax + sRange * 0.2, next));

      const newData = [...prev.slice(1), next];
      setData(newData);
      setDisplayValue(next.toFixed(precision));
    }, 1500);

    return () => clearInterval(interval);
    // seed array identity is stable (from SPARKLINES constant)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, seed, precision]);

  return { sparkData: data, displayValue };
}

export function KpiCard({ label, value, unit, secondary, color = ACCENT, sparkline, animate = true, onClick }: KpiCardProps) {
  const seed = sparkline ?? SPARKLINES[label] ?? [];
  const { sparkData, displayValue } = useAnimatedKpi(seed, value, animate && seed.length >= 2);

  return (
    <Paper
      component={onClick ? 'button' : 'div'}
      type={onClick ? 'button' : undefined}
      elevation={0}
      onClick={onClick}
      sx={{
        position: 'relative',
        overflow: 'hidden',
        minWidth: { xs: 0, sm: 130 },
        flexShrink: 1,
        px: { xs: 1, sm: 1.5 },
        py: 1,
        borderRadius: 1,
        border: `1px solid ${FIELD_BORDER}`,
        boxShadow: 'none',
        font: 'inherit',
        textAlign: 'left',
        appearance: 'none',
        pointerEvents: 'auto',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 120ms ease',
        '&:hover': onClick ? { borderColor: FIELD_BORDER_HOVER } : undefined,
        '&:focus-visible': { outline: `2px solid ${ACCENT}`, outlineOffset: '2px' },
      }}
    >
      {/* Not animated: the caller owns the series (it may change every render). */}
      <MiniSparkline data={animate ? sparkData : seed} color={color} />
      <Box component="span" sx={{ display: 'block', position: 'relative', zIndex: 1 }}>
        <Typography
          component="span"
          sx={{
            display: 'block',
            color: INK_MID,
            fontSize: FS.label,
            lineHeight: 1.3,
            mb: 0.25,
          }}
        >
          {label}
        </Typography>
        <Box component="span" sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
          <Typography
            component="span"
            sx={{
              fontWeight: 700,
              color,
              lineHeight: 1.1,
              fontSize: { xs: '1.35rem', sm: '1.75rem' },
              fontFamily: MONO,
              fontVariantNumeric: 'tabular-nums',
              transition: 'opacity 0.3s ease',
            }}
          >
            {animate ? displayValue : value}
          </Typography>
          <Typography component="span" sx={{ color: INK_MID, fontSize: FS.body }}>
            {unit}
          </Typography>
        </Box>
        {secondary && (
          <Typography
            component="span"
            sx={{
              display: 'block',
              color: INK_MID,
              fontSize: FS.label,
              mt: 0.25,
              lineHeight: 1.3,
            }}
          >
            {secondary}
          </Typography>
        )}
      </Box>
    </Paper>
  );
}

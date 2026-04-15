// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Typography, Box } from '@mui/material';

/** Shared sx for compact MUI TextFields in settings tabs. */
export const tfSx = {
  '& .MuiInputBase-root': { fontSize: 12, fontFamily: 'monospace', bgcolor: 'rgba(255,255,255,0.04)' },
  '& .MuiInputBase-input': { py: 0.75, px: 1.25 },
  '& .MuiInputLabel-root': { fontSize: 12 },
} as const;

export function StatRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>{label}</Typography>
      <Typography variant="caption" sx={{ color: color ?? '#4fc3f7', fontWeight: 600, fontFamily: 'monospace' }}>
        {value}
      </Typography>
    </Box>
  );
}

export function BudgetRow({ label, pct, color }: { label: string; pct: number; color: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, my: 0.25 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', width: 72, flexShrink: 0, fontSize: 11 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, height: 6, bgcolor: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
        <Box sx={{ height: '100%', width: `${pct}%`, bgcolor: color, borderRadius: 3, transition: 'width 0.3s' }} />
      </Box>
      <Typography variant="caption" sx={{ color: 'text.secondary', width: 36, textAlign: 'right', fontSize: 11, fontFamily: 'monospace' }}>
        {pct}%
      </Typography>
    </Box>
  );
}

export function budgetPct(value: number, budget: number): { pct: number; color: string } {
  const pct = Math.min(Math.round((value / budget) * 100), 100);
  const color = pct < 60 ? '#66bb6a' : pct < 85 ? '#ffa726' : '#ef5350';
  return { pct, color };
}

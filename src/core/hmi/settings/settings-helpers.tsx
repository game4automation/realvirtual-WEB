// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from '../../rv-safe-storage';

import { useState, type ReactNode } from 'react';
import { Typography, Box, Collapse, Slider } from '@mui/material';
import { ExpandMore } from '@mui/icons-material';

/** Shared sx for compact MUI TextFields in settings tabs. */
export const tfSx = {
  '& .MuiInputBase-root': { fontSize: 12, fontFamily: 'monospace', bgcolor: 'rgba(255,255,255,0.04)' },
  '& .MuiInputBase-input': { py: 0.75, px: 1.25 },
  '& .MuiInputLabel-root': { fontSize: 12 },
} as const;

// ── Collapsible settings section ─────────────────────────────────────────
// A bordered "box" with its title inside a clickable header. Expand/collapse
// state persists per-section to localStorage so a user's open/closed layout
// survives reloads. Reusable across all settings tabs.

const SECTION_COLLAPSE_KEY = 'rv-settings-section-collapsed';

function loadCollapsedSections(): Set<string> {
  try {
    const raw = readLocalStorage(SECTION_COLLAPSE_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function persistCollapsedSection(id: string, collapsed: boolean): void {
  const set = loadCollapsedSections();
  if (collapsed) set.add(id); else set.delete(id);
  try {
    writeLocalStorage(SECTION_COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    /* quota exceeded or storage disabled — ignore */
  }
}

/**
 * A collapsible, bordered settings section with its title inside the box.
 *
 * @param id    Stable storage key for the expand/collapse state (unique per section).
 * @param title Header text shown inside the box.
 * @param defaultExpanded Whether the section starts open when no stored state exists.
 */
export function SettingsSection({ id, title, defaultExpanded = true, children }: {
  id: string;
  title: string;
  defaultExpanded?: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(() => {
    const collapsed = loadCollapsedSections();
    return collapsed.has(id) ? false : defaultExpanded;
  });

  const toggle = () => {
    setExpanded((prev) => {
      const next = !prev;
      persistCollapsedSection(id, !next);
      return next;
    });
  };

  return (
    <Box sx={{ border: '1px solid rgba(255,255,255,0.1)', borderRadius: 1, overflow: 'hidden' }}>
      <Box
        onClick={toggle}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1,
          py: 0.5,
          cursor: 'pointer',
          userSelect: 'none',
          bgcolor: 'rgba(255,255,255,0.03)',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
        }}
      >
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, fontSize: 11 }}>
          {title}
        </Typography>
        <ExpandMore sx={{ fontSize: 16, color: 'text.disabled', transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.15s' }} />
      </Box>
      <Collapse in={expanded}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, px: 0.75, py: 0.625 }}>
          {children}
        </Box>
      </Collapse>
    </Box>
  );
}

/** Compact sizing forced onto any MUI input/select rendered inside a FieldRow,
 *  so dropdowns and text fields stay short and match the caption-sized labels. */
const COMPACT_INPUT_SX = {
  '& .MuiInputBase-root': { fontSize: 13 },
  '& .MuiSelect-select': { py: '3px', minHeight: 'unset !important', lineHeight: 1.4 },
  '& .MuiOutlinedInput-input': { py: '3px' },
};

// ── Single-line setting rows ─────────────────────────────────────────────
// Compact label-on-the-left / control-on-the-right rows so every field stays
// on one line. Reusable across all settings tabs.

/**
 * A single-line setting row: a fixed-width label on the left and the
 * control(s) right-aligned on the right. Use for selects, switches, inputs,
 * color pickers — anything that should sit on one line next to its label.
 *
 * @param hint Optional secondary line shown below the row (small, dim).
 */
export function FieldRow({ label, children, hint, labelColor }: {
  label: ReactNode;
  children: ReactNode;
  hint?: string;
  labelColor?: string;
}) {
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 22 }}>
        <Typography variant="caption" sx={{ color: labelColor ?? 'text.secondary', flexShrink: 0, minWidth: 84, whiteSpace: 'nowrap' }}>
          {label}
        </Typography>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 1, justifyContent: 'flex-end', ...COMPACT_INPUT_SX }}>
          {children}
        </Box>
      </Box>
      {hint && (
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', fontSize: 10, mt: 0.125, lineHeight: 1.3 }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}

/**
 * A single-line slider row: label · slider · numeric readout. Wraps the very
 * common slider pattern so callers don't repeat the flex/value plumbing.
 *
 * @param format   Formats the right-side readout (default: 2-decimal fixed).
 * @param valueText Overrides the readout entirely (e.g. "Native", "45°").
 */
export function SliderRow({ label, value, onChange, min, max, step, disabled, format = (v) => v.toFixed(2), valueText, hint }: {
  label: ReactNode;
  value: number;
  onChange: (event: Event, value: number | number[]) => void;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  format?: (v: number) => string;
  valueText?: string;
  hint?: string;
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <Slider size="small" min={min} max={max} step={step} value={value} onChange={onChange} disabled={disabled} sx={{ flex: 1, minWidth: 60 }} />
      <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 30, textAlign: 'right', flexShrink: 0 }}>
        {valueText ?? format(value)}
      </Typography>
    </FieldRow>
  );
}

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

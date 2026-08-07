// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * panel-primitives — the shared building blocks of the editor's docked panels.
 *
 * Extracted from KinematicsPanel ("Quick Edit") when the Materials window
 * arrived and needed the same collapsible sections and dense action buttons.
 * The two panels dock into the same slot and are read as one tool, so their
 * section headers and button metrics must not drift apart.
 *
 * Metrics follow DESIGN.md: 10px/700 uppercase section captions in the Label
 * role, 24px-high outlined buttons, hairline dividers, no shadows.
 */

import { useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Box, Typography, Collapse, Divider, Button, Tooltip } from '@mui/material';
import { ExpandMore, ChevronRight } from '@mui/icons-material';
import { useButtonSim, type ButtonSimPhase } from './button-sim-store';

/**
 * Simulated-interaction styles for "the AI clicks this button"
 * (button-sim-store): the same visual states a real mouse produces —
 * hover tint, then a pressed depression — because CSS `:hover`/`:active`
 * cannot be triggered synthetically. `accent` is the button's hover color.
 */
export function buttonSimSx(phase: ButtonSimPhase | null, accent: string): object {
  if (phase === 'hover') {
    return { borderColor: accent, color: accent, backgroundColor: 'rgba(255,255,255,0.04)' };
  }
  if (phase === 'pressed') {
    return {
      borderColor: accent, color: accent,
      backgroundColor: 'rgba(79,195,247,0.18)',
      transform: 'scale(0.96)',
    };
  }
  return {};
}

/**
 * Collapsible section with an uppercase caption header.
 *
 * `accent` tints the header and its bottom border — used to mark a section as
 * belonging to a specific subsystem. Without it the header sits on plain dark
 * glass.
 */
export function Section({ title, children, defaultOpen = true, accent, headerAction }: {
  title: string; children: ReactNode; defaultOpen?: boolean; accent?: string; headerAction?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const iconColor = accent ?? 'rgba(255,255,255,0.35)';
  const captionColor = accent ?? 'rgba(255,255,255,0.45)';
  return (
    <Box>
      <Box
        onClick={() => setOpen(o => !o)}
        sx={{
          display: 'flex', alignItems: 'center', gap: 0.25, cursor: 'pointer', userSelect: 'none',
          px: 1, py: 0.375,
          bgcolor: accent ? accent + '14' : 'rgba(0,0,0,0.2)',
          borderBottom: accent ? `1px solid ${accent}33` : 'none',
          '&:hover': { '& > .MuiTypography-root': { color: accent ?? 'rgba(255,255,255,0.7)', filter: accent ? 'brightness(1.2)' : 'none' } },
        }}
      >
        {open
          ? <ExpandMore sx={{ fontSize: 14, color: iconColor }} />
          : <ChevronRight sx={{ fontSize: 14, color: iconColor }} />}
        <Typography variant="caption" sx={{
          color: captionColor, fontSize: 10,
          textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700,
        }}>
          {title}
        </Typography>
        {headerAction && (
          <Box onClick={(e) => e.stopPropagation()} sx={{ ml: 'auto', display: 'flex', alignItems: 'center' }}>
            {headerAction}
          </Box>
        )}
      </Box>
      <Collapse in={open}>
        <Box sx={{ pt: 0.5, pb: 1, pl: 2, pr: 1 }}>{children}</Box>
      </Collapse>
      <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />
    </Box>
  );
}

/**
 * Small outlined action button. Disabled state carries a reason tooltip.
 *
 * The reason tooltip is load-bearing, not a nicety: these panels keep every
 * action visible and grey out what does not apply, so the tooltip is the only
 * thing telling the user what the selection is missing.
 */
export function ActionButton({ label, tooltip, onClick, disabled, disabledReason, icon: Icon, color, flashId }: {
  label: string;
  tooltip?: string;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  icon?: ComponentType<{ sx?: object }>;
  color?: string;
  /** button-sim-store id — the MCP bridge simulates a human click on this
   *  button (hover → press → release) when a tool runs the equivalent
   *  action. Omit for buttons without an MCP counterpart. */
  flashId?: string;
}) {
  const simPhase = useButtonSim(flashId ?? '');
  const tip = disabled ? (disabledReason ?? tooltip ?? '') : (tooltip ?? '');
  const button = (
    <Button
      size="small"
      variant="outlined"
      onClick={onClick}
      disabled={disabled}
      data-rv-button-id={flashId}
      startIcon={Icon ? <Icon sx={{ fontSize: 14 }} /> : undefined}
      sx={{
        // Button metrics mirror the Property Inspector's action buttons
        // (height 24, px 0.75, fontSize 10/600, 14px icons).
        justifyContent: 'flex-start',
        textTransform: 'none',
        fontSize: 10,
        fontWeight: 600,
        height: 24,
        py: 0, px: 0.75,
        minWidth: 0,
        width: '100%',
        color: disabled ? 'text.disabled' : (color ?? 'text.secondary'),
        borderColor: 'rgba(255,255,255,0.15)',
        '&:hover': { borderColor: color ?? 'primary.main', color: color ?? 'primary.main' },
        '& .MuiButton-startIcon': { mr: 0.5, ml: 0 },
        transition: 'transform 120ms ease, background-color 120ms ease',
        ...buttonSimSx(simPhase, color ?? '#4fc3f7'),
      }}
    >
      {label}
    </Button>
  );
  if (!tip) return button;
  return (
    <Tooltip title={tip} placement="left">
      {/* Tooltip on a disabled Button needs a wrapping element. */}
      <span style={{ display: 'flex', minWidth: 0 }}>{button}</span>
    </Tooltip>
  );
}

/** Two-column button grid (the Unity QuickEdit row layout). */
export function ButtonGrid({ children, columns = 2 }: { children: ReactNode; columns?: number }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 0.5 }}>
      {children}
    </Box>
  );
}

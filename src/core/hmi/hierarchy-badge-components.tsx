// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Hierarchy badge presentational components.
 *
 * Stateless components extracted from `rv-hierarchy-browser.tsx` (plan-177 Phase 5):
 * - `BadgeChip` — small colored MUI Chip used for type / signal labels
 * - `StepStateDot` — pulsing dot indicating Active / Waiting LogicStep state
 * - `ContainerProgressBadge` — small monospace progress counter (e.g. "1.2s/3.0s")
 * - `NodeBadges` — composite row that renders type badges + live signal badges
 */

import { memo, useMemo } from 'react';
import { Box, Chip, Typography } from '@mui/material';
import type { RVViewer } from '../rv-viewer';
import type { SignalStore } from '../engine/rv-signal-store';
import type { StepStateInfo } from '../engine/rv-logic-engine';
import { StepState } from '../engine/rv-logic-step';
import { STEP_STATE_COLORS } from './rv-logic-step-colors';
import { SignalBadge, type SignalDirection } from './rv-signal-badge';
import { CHIP_RADIUS } from './shared-sx';
import {
  badgeColor,
  badgeLabel,
  formatContainerProgress,
  formatSignalValue,
  isLogicStepType,
  signalBadgeColor,
  splitTypes,
} from './hierarchy-utils';

// ─── BadgeChip ───────────────────────────────────────────────────────────

/**
 * Passive type label (Rec, Replay, TS, …). Deliberately NOT chip-shaped:
 * no border, no pill radius, dimmed typography — interactivity must look
 * exclusive to interactive elements (filter chips, SignalBadge). The type
 * color is kept at reduced strength for category scanning.
 *
 * When `onClick` is supplied the chip becomes a shortcut that opens the
 * property inspector for the row (a single click, vs. the row's double-click):
 * it gains a pointer cursor and a subtle hover strengthen, but keeps the flat,
 * borderless look so it still reads as a label first.
 */
export function BadgeChip({
  color,
  label,
  onClick,
}: {
  color: string;
  label: string;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const clickable = !!onClick;
  return (
    <Chip
      label={label}
      size="small"
      onClick={onClick}
      // Row uses double-click to open the inspector; the chip does it on a
      // single click, so swallow the chip's own dblclick to avoid a stray fit.
      onDoubleClick={clickable ? (e) => e.stopPropagation() : undefined}
      title={clickable ? 'Open in inspector' : undefined}
      className={clickable ? 'rv-type-chip-btn' : undefined}
      sx={{
        height: 16,
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: 0.3,
        bgcolor: color + '14',
        color: color + 'e0',
        // Passive by default; the border stays transparent so revealing it on
        // row-hover causes no layout shift (Chip is border-box). The row sets
        // `--rv-chip-border` on hover (a neutral hairline) so every clickable
        // chip in the hovered row reads as a target; direct chip-hover then
        // strengthens to the chip's own color — an honest affordance ladder.
        border: clickable ? '1px solid var(--rv-chip-border, transparent)' : 'none',
        borderRadius: CHIP_RADIUS,
        flexShrink: 0,
        cursor: clickable ? 'pointer' : 'default',
        transition: clickable ? 'border-color 0.1s, background-color 0.1s, color 0.1s' : undefined,
        '& .MuiChip-label': { px: 0.4, py: 0 },
        ...(clickable && {
          '&:hover': { bgcolor: color + '28', color, borderColor: color + '99' },
        }),
      }}
    />
  );
}

// ─── StepStateDot ────────────────────────────────────────────────────────

export function StepStateDot({ stepState }: { stepState: StepState }) {
  // Only show dot for Active (pulsing green) and Waiting (pulsing amber). No dot for Idle/Finished.
  if (stepState === StepState.Idle || stepState === StepState.Finished) return null;
  return (
    <Box
      sx={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        bgcolor: STEP_STATE_COLORS[stepState],
        flexShrink: 0,
        mr: 0.5,
        animation: 'rv-pulse 1.5s ease-in-out infinite',
      }}
    />
  );
}

// ─── ContainerProgressBadge ──────────────────────────────────────────────

export function ContainerProgressBadge({ text }: { text: string }) {
  return (
    <Typography
      component="span"
      sx={{
        fontSize: 11,
        fontFamily: 'monospace',
        color: 'text.secondary',
        ml: 0.25,
        flexShrink: 0,
      }}
    >
      {text}
    </Typography>
  );
}

// ─── NodeBadges (composite) ──────────────────────────────────────────────

export interface NodeBadgesProps {
  types: string[];
  signalStore: SignalStore | null;
  path: string | null;
  stepInfo?: StepStateInfo | null;
  /** Viewer for interactive signal chips (tooltip, force, Shift+Drag). Optional —
   *  without it signal types fall back to the plain BadgeChip rendering. */
  viewer?: RVViewer;
  /** Opens the property inspector for this row. When set, non-signal type chips
   *  become a single-click shortcut to it (the row itself needs a double-click). */
  onOpenInspector?: (path: string) => void;
}

/** Renders component badges + signal badges (signals always right-most with live values).
 *  Signal types render as the central interactive {@link SignalBadge} (plan-246 F1):
 *  hover tooltip, click-to-force, Shift+Drag and the global chip variant all work in
 *  the hierarchy exactly like everywhere else. The badge self-tracks the live value
 *  (throttled) — no `raw` prop, so large virtualized lists stay cheap. */
export const NodeBadges = memo(function NodeBadges({
  types,
  signalStore,
  path,
  stepInfo,
  viewer,
  onOpenInspector,
}: NodeBadgesProps) {
  const [nonSignalTypes, signalTypes] = useMemo(() => splitTypes(types), [types]);

  if (nonSignalTypes.length === 0 && signalTypes.length === 0) return null;

  const stepState = stepInfo?.state;
  const progressText = stepInfo ? formatContainerProgress(stepInfo) : null;
  // Single-click on a type chip opens the inspector (stopPropagation so the
  // row's own select/expand click doesn't also fire). Signal chips keep their
  // own click-to-force gesture and are unaffected.
  const chipClick = path && onOpenInspector
    ? (e: React.MouseEvent) => { e.stopPropagation(); onOpenInspector(path); }
    : undefined;
  // Resolve the SignalStore key for this node once per render (cheap Map lookup).
  const signalName = signalTypes.length > 0 && path && signalStore
    ? signalStore.nameForPath(path)
    : undefined;

  // flexShrink: 0 — chips render at full width; the node NAME (flex: 1,
  // ellipsis) is what truncates when space runs out, never the chips.
  return (
    <Box sx={{ display: 'flex', gap: 0.25, flexShrink: 0, ml: 'auto', alignItems: 'center' }}>
      {nonSignalTypes.map((type) => (
        <BadgeChip
          key={type}
          color={badgeColor(type, isLogicStepType(type) ? stepState : undefined)}
          label={badgeLabel(type, isLogicStepType(type) ? stepState : undefined)}
          onClick={chipClick}
        />
      ))}
      {progressText && <ContainerProgressBadge text={progressText} />}
      {signalTypes.length > 0 && nonSignalTypes.length > 0 && (
        <Box sx={{ width: 2, flexShrink: 0 }} />
      )}
      {signalTypes.map((type) => {
        // Standard interactive chip when the store name resolves; otherwise keep
        // the previous static chip (e.g. signals not yet registered in the store).
        if (viewer && signalName) {
          const direction: SignalDirection = type.startsWith('PLCOutput') ? 'output'
            : type.startsWith('PLCInput') ? 'input' : 'unknown';
          return (
            <SignalBadge
              key={type}
              viewer={viewer}
              signalName={signalName}
              direction={direction}
              plcType={type}
            />
          );
        }
        return (
          <BadgeChip
            key={type}
            color={signalBadgeColor(type, signalStore, path)}
            label={`${badgeLabel(type)} ${formatSignalValue(type, signalStore, path)}`}
          />
        );
      })}
    </Box>
  );
});

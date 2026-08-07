// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LeftPanel — Generic left-side panel container for docked overlays.
 *
 * Provides standardized positioning, header with close button,
 * optional toolbar, optional footer, optional resize handle,
 * and mobile full-screen behavior.
 *
 * Content area uses overflow:hidden — children manage their own scrolling.
 * Width is always a controlled prop (no internal width state).
 */

import { useState, useCallback } from 'react';
import { Paper, Box, Typography, IconButton } from '@mui/material';
import { Close } from '@mui/icons-material';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useViewportInsets } from '../../hooks/use-viewport-insets';
import {
  LEFT_PANEL_TOP,
  ACTIVITY_BAR_WIDTH,
  LEFT_PANEL_ZINDEX,
  LEFT_PANEL_MOBILE_ZINDEX,
} from './layout-constants';
import type { SxProps } from '@mui/material/styles';

/** Dark surface for docked windows — the MIDDLE of three darkness tiers:
 *  outer toolbars (rgba(38,38,38,0.95)) are darkest, windows are a touch
 *  brighter, and floating viewport glass (theme Paper) is the brightest.
 *  Needs `!important` to override the theme's bright glass Paper background,
 *  which is itself `!important`. */
export const WINDOW_DARK_BG = 'rgba(48, 48, 48, 0.93)';

// ─── Pure helper functions (exported for testing) ──────────────────────

/** Clamp a width value between min and max, handling NaN gracefully. */
export function clampWidth(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** Build the root Paper sx styles for desktop/mobile modes. */
export function buildPanelSx(opts: {
  width: number;
  isMobile: boolean;
  leftOffset?: number;
  mobile?: 'full-screen' | 'hidden';
  anchor?: 'left' | 'right';
  /** Extra top inset (css-px) so the docked window clears the optional title bar. */
  topOffset?: number;
}): Record<string, unknown> {
  const { width, isMobile, leftOffset, mobile = 'full-screen', anchor = 'left', topOffset = 0 } = opts;

  if (isMobile && mobile === 'hidden') {
    return {
      display: 'none',
      position: 'fixed',
      inset: 0,
      width: '100%',
      height: '100%',
      zIndex: LEFT_PANEL_MOBILE_ZINDEX,
      flexDirection: 'column',
      overflow: 'hidden',
      pointerEvents: 'auto',
      borderRadius: 0,
    };
  }

  if (isMobile) {
    // Mobile: true fullscreen modal covering the entire viewport (TopBar + ButtonPanel + BottomBar).
    // TopBar close button stays on top (zIndex 9001) so panel can still be dismissed.
    return {
      position: 'fixed',
      inset: 0,
      width: '100%',
      height: '100%',
      zIndex: LEFT_PANEL_MOBILE_ZINDEX,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      pointerEvents: 'auto',
      borderRadius: 0,
    };
  }

  // Edge-to-edge docking (VSCode-style): the window is flush, square, and runs
  // full height from the very top to the viewport bottom. Left-anchored
  // windows sit immediately right of the activity bar (default left =
  // ACTIVITY_BAR_WIDTH); right-anchored windows sit flush to the right edge.
  const offset = leftOffset ?? (anchor === 'right' ? 0 : ACTIVITY_BAR_WIDTH);
  const anchorSide = anchor === 'right'
    ? { right: offset, left: 'auto' as const, borderLeft: '1px solid rgba(255,255,255,0.08)' }
    : { left: offset, right: 'auto' as const, borderRight: '1px solid rgba(255,255,255,0.08)' };

  return {
    position: 'fixed',
    ...anchorSide,
    top: LEFT_PANEL_TOP + topOffset,
    bottom: 0,
    width,
    zIndex: LEFT_PANEL_ZINDEX,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    pointerEvents: 'auto',
    borderRadius: 0,
  };
}

// ─── Component ──────────────────────────────────────────────────────────

export interface LeftPanelProps {
  /** Title displayed in header. String or ReactNode for custom styling. */
  title: React.ReactNode;
  /** Close button handler. */
  onClose: () => void;
  /** Panel content. */
  children: React.ReactNode;
  /** Width on desktop in px. Default: 320. */
  width?: number;
  /** Left offset on desktop in px. Default: LEFT_PANEL_LEFT (8). */
  leftOffset?: number;
  /** Whether right edge is resizable. Default: false. */
  resizable?: boolean;
  /** Min width when resizable. Default: 200. */
  minWidth?: number;
  /** Max width when resizable. Default: 600. */
  maxWidth?: number;
  /** Called during resize with new width. */
  onResize?: (width: number) => void;
  /** Optional toolbar between title and close button. */
  toolbar?: React.ReactNode;
  /** Optional footer below content area. */
  footer?: React.ReactNode;
  /** Mobile display policy. 'full-screen' or 'hidden'. Default: 'full-screen'. */
  mobile?: 'full-screen' | 'hidden';
  /**
   * Which screen edge the panel docks to. Default: 'left' (preserves all
   * existing call sites). Pass 'right' to dock the panel to the right edge —
   * resize handle and offset mirror automatically.
   */
  anchor?: 'left' | 'right';
  /**
   * Use an inner (inset) shadow instead of the default outer drop shadow.
   * Drops the Paper elevation to 0 and overlays a non-interactive inset
   * shadow so the panel reads as recessed rather than raised. Default: false.
   */
  innerShadow?: boolean;
  /** Additional sx props merged into root Paper. */
  sx?: SxProps;
  /** Header padding override sx. */
  headerSx?: SxProps;
}

export function LeftPanel({
  title,
  onClose,
  children,
  width = 320,
  leftOffset,
  resizable = false,
  minWidth = 200,
  maxWidth = 600,
  onResize,
  toolbar,
  footer,
  mobile = 'full-screen',
  anchor = 'left',
  innerShadow = false,
  sx: sxOverride,
  headerSx,
}: LeftPanelProps) {
  const isMobile = useMobileLayout();
  const topOffset = useViewportInsets().top;
  const [dragging, setDragging] = useState(false);

  // ── Resize handle ──
  // For a right-anchored panel the handle lives on the LEFT edge and dragging
  // LEFT (negative delta) must INCREASE the width — so we flip the sign.
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const sign = anchor === 'right' ? -1 : 1;

    const onMove = (ev: PointerEvent) => {
      const delta = (ev.clientX - startX) * sign;
      const newWidth = clampWidth(startWidth + delta, minWidth, maxWidth);
      onResize?.(newWidth);
    };
    const onUp = () => {
      setDragging(false);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    setDragging(true);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [width, minWidth, maxWidth, onResize, anchor]);

  const panelSx = buildPanelSx({ width, isMobile, leftOffset, mobile, anchor, topOffset });

  return (
    <Paper
      elevation={innerShadow ? 0 : 4}
      data-ui-panel
      sx={{ backgroundColor: `${WINDOW_DARK_BG} !important`, ...panelSx, ...((sxOverride ?? {}) as Record<string, unknown>) }}
    >
      {/* Unified header — title (left), optional toolbar, close (X). Padding and
          title style match the Models window guide so every docked window reads
          the same. Callers can pass a plain string title for the standard look,
          or a ReactNode for custom headers (icon + label, two-line, …). */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 1.5,
          py: 1.25,
          gap: 0.5,
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          flexShrink: 0,
          ...(headerSx as Record<string, unknown> ?? {}),
        }}
      >
        {/* Title area — flex:1 */}
        <Box sx={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
          {typeof title === 'string' ? (
            <Typography
              variant="subtitle2"
              sx={{
                fontWeight: 600,
                fontSize: '0.8rem',
                color: 'text.primary',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={title}
            >
              {title}
            </Typography>
          ) : (
            title
          )}
        </Box>

        {/* Optional toolbar */}
        {toolbar}

        {/* Close button */}
        <IconButton size="small" aria-label="Close panel" onClick={onClose} sx={{ color: 'text.secondary', p: 0.25, flexShrink: 0 }}>
          <Close sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      {/* Content area — children manage their own scrolling */}
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {children}
      </Box>

      {/* Optional footer */}
      {footer && (
        <Box sx={{ flexShrink: 0, borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
          {footer}
        </Box>
      )}

      {/* Optional inner (inset) shadow — a non-interactive overlay that recesses
          the panel. Rendered above content so it stays visible regardless of
          child backgrounds; pointer-events:none keeps everything below clickable
          (including the resize handle). */}
      {innerShadow && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            boxShadow: 'inset 0 0 6px 0 rgba(0, 0, 0, 0.3)',
            zIndex: 3,
          }}
        />
      )}

      {/* Optional resize handle — sits on the inward-facing edge
          (right edge for left-anchored panels, left edge for right-anchored). */}
      {resizable && !isMobile && (
        <Box
          onPointerDown={handleResizeStart}
          sx={{
            position: 'absolute',
            ...(anchor === 'right' ? { left: 0 } : { right: 0 }),
            top: 0,
            bottom: 0,
            width: 5,
            cursor: 'col-resize',
            bgcolor: dragging ? 'rgba(79, 195, 247, 0.3)' : 'transparent',
            '&:hover': { bgcolor: 'rgba(79, 195, 247, 0.2)' },
            transition: 'background-color 0.15s',
            zIndex: 1,
          }}
        />
      )}
    </Paper>
  );
}

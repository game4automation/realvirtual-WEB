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
import {
  LEFT_PANEL_TOP,
  LEFT_PANEL_LEFT,
  LEFT_PANEL_BOTTOM,
  LEFT_PANEL_ZINDEX,
  LEFT_PANEL_MOBILE_ZINDEX,
} from './layout-constants';
import type { SxProps } from '@mui/material/styles';

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
}): Record<string, unknown> {
  const { width, isMobile, leftOffset, mobile = 'full-screen' } = opts;

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

  return {
    position: 'fixed',
    left: leftOffset ?? LEFT_PANEL_LEFT,
    top: LEFT_PANEL_TOP,
    bottom: LEFT_PANEL_BOTTOM,
    right: 'auto',
    width,
    zIndex: LEFT_PANEL_ZINDEX,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    pointerEvents: 'auto',
    borderRadius: 2,
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
  sx: sxOverride,
  headerSx,
}: LeftPanelProps) {
  const isMobile = useMobileLayout();
  const [dragging, setDragging] = useState(false);

  // ── Resize handle ──
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;

    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
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
  }, [width, minWidth, maxWidth, onResize]);

  const panelSx = buildPanelSx({ width, isMobile, leftOffset, mobile });

  return (
    <Paper
      elevation={4}
      data-ui-panel
      sx={{ ...panelSx, ...((sxOverride ?? {}) as Record<string, unknown>) }}
    >
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 1,
          py: 0.25,
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          flexShrink: 0,
          ...(headerSx as Record<string, unknown> ?? {}),
        }}
      >
        {/* Title area — flex:1 */}
        <Box sx={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
          {typeof title === 'string' ? (
            <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.primary' }}>
              {title}
            </Typography>
          ) : (
            title
          )}
        </Box>

        {/* Optional toolbar */}
        {toolbar}

        {/* Close button */}
        <IconButton size="small" onClick={onClose} sx={{ color: 'text.secondary', p: 0.25, flexShrink: 0 }}>
          <Close sx={{ fontSize: 14 }} />
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

      {/* Optional resize handle — right edge */}
      {resizable && !isMobile && (
        <Box
          onPointerDown={handleResizeStart}
          sx={{
            position: 'absolute',
            right: 0,
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

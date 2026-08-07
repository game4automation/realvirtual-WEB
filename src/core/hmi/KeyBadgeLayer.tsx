// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * KeyBadgeLayer — Blender-style "screencast keys" badge in the lower-left
 * corner of the viewport. Shows the shortcut chord the user hit (`S`,
 * `S › I`) plus the resolved action label; fades out via key-badge-store's
 * auto-hide. Purely presentational — push keys with showKeyBadge /
 * appendKeyBadge. Mounted once in App.tsx next to <ContextMenuLayer />.
 *
 * Anchored to the actual 3D viewport region (not the browser window): the
 * left offset follows useViewportInsets — the same source of truth ViewportFrame
 * confines the canvas with — so the badge stays in the canvas corner when the
 * activity bar or a left-docked window is open. Never intercepts pointer events.
 */

import { Box, Fade, Typography } from '@mui/material';
import { useKeyBadge } from './key-badge-store';
import { useViewportInsets } from '../../hooks/use-viewport-insets';

/** Above BottomBar, below dialogs/menus. */
const BADGE_ZINDEX = 8500;

/** Single key-cap chip (monospace, per DESIGN.md measurement-value rule). */
function KeyCap({ label }: { label: string }) {
  return (
    <Box
      component="span"
      sx={{
        fontFamily: 'monospace',
        fontSize: 12,
        lineHeight: 1,
        color: 'rgba(255,255,255,0.9)',
        bgcolor: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: 0.5,
        px: 0.75,
        py: 0.5,
      }}
    >
      {label}
    </Box>
  );
}

export function KeyBadgeLayer() {
  const snap = useKeyBadge();
  // Lower-left corner of the CANVAS region: inset by the activity bar + any
  // open left-docked window (css-px — this layer lives inside the zoomed
  // HMIShell, same as KpiBar/BottomBar). Insets are 0 when full-bleed.
  const { left: insetLeft } = useViewportInsets();

  return (
    <Fade in={snap !== null} timeout={{ enter: 80, exit: 400 }}>
      <Box
        sx={{
          position: 'fixed',
          left: insetLeft + 16,
          bottom: 16,
          zIndex: BADGE_ZINDEX,
          pointerEvents: 'none',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1.25,
          py: 0.75,
          bgcolor: 'rgba(30, 30, 30, 0.85)',
          backdropFilter: 'blur(calc(12px * var(--rv-ui-blur-scale, 1)))',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 1,
        }}
      >
        {(snap?.keys ?? []).map((key, i) => [
          i > 0 && (
            <Typography
              key={`sep-${i}`}
              component="span"
              sx={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}
            >
              ›
            </Typography>
          ),
          <KeyCap key={`key-${i}`} label={key} />,
        ])}
        {snap?.label && (
          <Typography
            component="span"
            sx={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', ml: 0.5 }}
          >
            {snap.label}
          </Typography>
        )}
      </Box>
    </Fade>
  );
}

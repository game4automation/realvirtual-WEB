// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TitleBar — optional top title bar shown at the very top of the viewer, OUTSIDE
 * the 3D viewport (it pushes the canvas and other top-anchored chrome down).
 *
 * Spans the full width to the RIGHT of the top-left logo (the activity bar's
 * LogoBadge): on desktop it starts at ACTIVITY_BAR_WIDTH, on mobile (where the
 * activity bar is a bottom strip) it spans full width from the left edge.
 *
 * Center cluster: an optional leading logo (wide format supported) followed by
 * the configured title text. Driven entirely by the branding store — renders
 * null unless `branding.titleBar` is set.
 */

import { Box, Typography } from '@mui/material';
import { useCustomBranding } from './branding-store';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { ACTIVITY_BAR_WIDTH, TITLE_BAR_HEIGHT, LEFT_PANEL_ZINDEX } from './layout-constants';

export function TitleBar() {
  const branding = useCustomBranding();
  const isMobile = useMobileLayout();

  if (!branding?.titleBar) return null;

  const logoHeight = branding.titleLogoHeight ?? 24;

  return (
    <Box
      data-ui-panel
      sx={{
        position: 'fixed',
        top: 0,
        // Start right of the top-left logo (activity bar). On mobile the activity
        // bar lives at the bottom, so the bar spans the full width.
        left: isMobile ? 0 : ACTIVITY_BAR_WIDTH,
        right: 0,
        height: TITLE_BAR_HEIGHT,
        zIndex: LEFT_PANEL_ZINDEX,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        px: 2,
        bgcolor: 'rgba(38,38,38,0.95)',
        backdropFilter: 'blur(calc(12px * var(--rv-ui-blur-scale, 1)))',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        color: 'rgba(255,255,255,0.92)',
        pointerEvents: 'auto',
      }}
    >
      {branding.titleLogoUrl && (
        <Box
          component="img"
          src={branding.titleLogoUrl}
          alt={branding.title ?? 'Logo'}
          sx={{ height: logoHeight, width: 'auto', objectFit: 'contain', flexShrink: 0 }}
        />
      )}
      {branding.titleLogoUrl && branding.title && (
        <Box
          aria-hidden
          sx={{
            flexShrink: 0,
            width: '1px',
            height: logoHeight,
            mx: 0.5,
            background: 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.28), transparent)',
          }}
        />
      )}
      {branding.title && (
        <Typography
          noWrap
          sx={{ fontWeight: 600, fontSize: 15, letterSpacing: 0.2, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {branding.title}
        </Typography>
      )}
    </Box>
  );
}

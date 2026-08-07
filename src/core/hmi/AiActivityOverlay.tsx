// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AiActivityOverlay — the AI status TEXT that rides beside the AI activity
 * button (in the activity bar, above Settings) over the 3D scene.
 *
 * The icon itself lives in the ActivityBar (always shown while the MCP bridge is
 * connected, click opens the AI settings). This overlay adds ONLY the status
 * text, and only DURING an interaction (a tool call) — nothing when idle. The
 * label comes from ai-activity-store (fed by the bridge) and auto-clears.
 *
 * Mounted as a direct child of HMIShell (alongside the other overlays).
 */

import { Box, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { ACTIVITY_BAR_WIDTH } from './layout-constants';
import { useMcpBridge } from '../../hooks/use-mcp-bridge';
import { useAiActivity } from './ai-activity-store';

export function AiActivityOverlay() {
  const mcp = useMcpBridge();
  const activity = useAiActivity();
  const theme = useTheme();

  // Text only while connected AND interacting — the icon is the activity-bar button.
  if (!mcp.connected || !activity) return null;

  // Accent-colored pill beside the AI icon (accent = bridge active / AI working).
  // Uses the theme accent so custom branding recolors it too — matching the
  // activity-bar AI button, which already turns `primary` while AI is working.
  const accent = theme.palette.primary.main;

  return (
    <Box
      role="status"
      sx={{
        position: 'fixed',
        left: ACTIVITY_BAR_WIDTH + 6,  // just right of the activity bar
        bottom: 50,                    // aligned with the AI button (above Settings)
        zIndex: 9400,
        pointerEvents: 'none',
        px: 1,
        py: 0.5,
        borderRadius: 1.5,
        bgcolor: alpha(accent, 0.95),
        border: `1px solid ${accent}`,
        boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(calc(6px * var(--rv-ui-blur-scale, 1)))',
        maxWidth: 'min(40vw, 320px)',
      }}
    >
      <Typography
        variant="caption"
        noWrap
        sx={{ display: 'block', fontWeight: 600, color: theme.palette.primary.contrastText }}
      >
        AI · {activity}
      </Typography>
    </Box>
  );
}

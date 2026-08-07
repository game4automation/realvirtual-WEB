// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MobileLibraryTab — the small reveal tab for the compact layout.
 *
 * Extracted from `LayoutLibraryPanel.tsx` for plan-344 Phase 4: the library
 * panel itself is now lazily loaded, but this tab is what a phone user sees
 * BEFORE the library has ever been opened. If it lived inside the lazy chunk it
 * could only be shown by first fetching that chunk — which would defeat the
 * splitting and, worse, leave phones with no way to reach the library while the
 * chunk is still in flight. It is intentionally tiny and dependency-light.
 */

import { Box, Paper, Typography } from '@mui/material';
import { ViewSidebar, KeyboardArrowUp } from '@mui/icons-material';
import { WINDOW_DARK_BG } from '../../core/hmi/LeftPanel';
import { LEFT_PANEL_ZINDEX } from '../../core/hmi/layout-constants';

/** Height reserved for the bottom nav strips (ActivityBar / ButtonPanel). */
const MOBILE_NAV_CLEARANCE = 48;

/** Small bottom tab shown on the compact layout while the planner is active
 *  and the library is closed. Tapping it opens the horizontal strip. Sits above
 *  the bottom nav strips (ActivityBar / ButtonPanel). */
export function MobileLibraryTab({ onOpen }: { onOpen: () => void }) {
  return (
    <Box
      sx={{
        position: 'fixed', left: 0, right: 0,
        bottom: `calc(${MOBILE_NAV_CLEARANCE}px + env(safe-area-inset-bottom, 0px))`,
        zIndex: LEFT_PANEL_ZINDEX,
        display: 'flex', justifyContent: 'center', pointerEvents: 'none',
      }}
    >
      <Paper
        elevation={6}
        data-ui-panel
        onClick={onOpen}
        sx={{
          pointerEvents: 'auto', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 0.75,
          px: 1.5, py: 0.75, borderRadius: 1,
          backgroundColor: `${WINDOW_DARK_BG} !important`,
        }}
      >
        <ViewSidebar sx={{ fontSize: 18, color: 'primary.main' }} />
        <Typography variant="caption" sx={{ fontWeight: 600, fontSize: 12 }}>Library</Typography>
        <KeyboardArrowUp sx={{ fontSize: 16, color: 'text.secondary' }} />
      </Paper>
    </Box>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectsDashboard — the full-screen shell over the viewport (plan-372 §3.1,
 * Phase 7).
 *
 * Replaces both the narrow "Models" panel and the TopBar project switcher. The
 * shell itself is only a titled frame: a header (optional back arrow, title,
 * search, caller actions, close) and one body slot. Which of the two screens
 * fills that slot is the host's decision, not the shell's — that is what keeps
 * this file testable without a project store.
 *
 * ## Back is not Escape
 *
 * When `onBack` is supplied the header grows an arrow, and that arrow is the
 * *only* way up a level. Escape keeps meaning "close the dashboard" on both
 * screens: a user who wants the viewport back should never have to guess how
 * many times to press it.
 *
 * ## Deliberately NOT a focus trap
 *
 * This is an overlay, not a modal dialog: the simulation keeps running behind
 * it and the user may legitimately tab to the mobile ActivityBar pill (which
 * sits above it at {@link MOBILE_CHROME_ZINDEX}) to get out. A trap would make
 * the only exit unreachable by keyboard. It is announced as
 * `role="region"` + `aria-label` rather than `role="dialog"` for the same
 * reason — it does not take over the application.
 *
 * ## Insets, not fixed offsets
 *
 * The shell positions itself from `useViewportInsets()` so it sits below an
 * optional branding title bar and beside the activity bar, instead of
 * hard-coding either. Those are configurable per deployment; a fixed offset
 * would leave a customer build with the overlay under its own title bar.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Box, IconButton, TextField, Tooltip, Typography, InputAdornment } from '@mui/material';
import { ArrowBack, Close, Search } from '@mui/icons-material';
import { useViewportInsets } from '../../../hooks/use-viewport-insets';
import { getFloatingPanelRoot } from '../HMIShell';
import { PROJECTS_DASHBOARD_ZINDEX, ACTIVITY_BAR_WIDTH } from '../layout-constants';
import {
  closeProjectsDashboard,
  getProjectsDashboardSnapshot,
  setProjectsSearch,
  subscribeProjectsDashboard,
} from './projects-dashboard-store';

export interface ProjectsDashboardProps {
  /** Header headline — "Projects", or the open project's name. */
  title: string;
  /** Supplied only on the project screen; renders the back arrow. */
  onBack?: () => void;
  /** Tab strip, rendered next to the title rather than above the content. */
  headerTabs?: React.ReactNode;
  /** Hide the search field on screens with nothing worth filtering. */
  showSearch?: boolean;
  /** Header actions rendered left of the close button. */
  headerActions?: React.ReactNode;
  /** The screen itself. Laid out as a row so a detail pane can sit beside it. */
  children: React.ReactNode;
}

export function ProjectsDashboard({
  title,
  onBack,
  headerTabs,
  showSearch = true,
  headerActions,
  children,
}: ProjectsDashboardProps) {
  const snap = useSyncExternalStore(subscribeProjectsDashboard, getProjectsDashboardSnapshot);
  const insets = useViewportInsets();

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeProjectsDashboard();
    }
  }, []);

  useEffect(() => {
    if (!snap.open) return;
    window.addEventListener('keydown', onKeyDown);
    // Cleanup is mandatory: React 19 StrictMode double-mounts in dev, and a
    // leaked listener would close the dashboard twice per Escape.
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [snap.open, onKeyDown]);

  if (!snap.open) return null;

  const root = getFloatingPanelRoot();

  const content = (
    <Box
      role="region"
      aria-label="Projects"
      sx={{
        position: 'fixed',
        top: insets.top,
        left: ACTIVITY_BAR_WIDTH,
        right: 0,
        bottom: 0,
        zIndex: PROJECTS_DASHBOARD_ZINDEX,
        display: 'flex',
        flexDirection: 'column',
        // Tier-3 glass over the viewport (DESIGN.md) — the 3D scene stays
        // faintly visible so the overlay reads as part of the same product.
        bgcolor: 'rgba(18, 20, 24, 0.94)',
        backdropFilter: 'blur(calc(12px * var(--rv-ui-blur-scale, 1)))',
        pointerEvents: 'auto',
      }}
    >
      {/* Header — title and window chrome only. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1.5,
          py: 1,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}
      >
        {onBack && (
          <Tooltip title="Back to projects">
            <IconButton size="small" onClick={onBack} aria-label="Back to projects">
              <ArrowBack sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        )}
        <Typography sx={{ fontSize: 15, fontWeight: 600 }}>{title}</Typography>
        {headerTabs}
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Close (Esc)">
          <IconButton size="small" onClick={closeProjectsDashboard} aria-label="Close Projects">
            <Close sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Sub-header — the tools, on their own bar.
          Search and the verbs used to ride the title row and drifted to the far
          right, the opposite corner from the content they act on. A bar of their
          own, centred, puts them over the list itself. */}
      {(showSearch || headerActions) && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexWrap: 'wrap',
            gap: 1,
            px: 1.5,
            py: 1,
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}
        >
          {showSearch && (
            <TextField
              size="small"
              placeholder="Search…"
              value={snap.search}
              onChange={(e) => setProjectsSearch(e.target.value)}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start" sx={{ mr: 0.5 }}>
                      <Search sx={{ fontSize: 16, color: 'text.disabled' }} />
                    </InputAdornment>
                  ),
                  sx: { fontSize: 12, height: 28 },
                },
              }}
              sx={{ width: 240 }}
            />
          )}
          {headerActions}
        </Box>
      )}

      {/* The active screen. A row, so a detail pane can sit beside the body. */}
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {children}
      </Box>
    </Box>
  );

  // Portal into the floating-panel root so the overlay escapes any transformed
  // ancestor (a CSS transform would make `position: fixed` resolve against the
  // ancestor instead of the viewport). Inline render is the documented fallback
  // before HMIShell has mounted.
  return root ? createPortal(content, root) : content;
}

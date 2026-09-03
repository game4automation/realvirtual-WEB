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

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
  /**
   * Quiet facts beside the title — backend kind, document count, read-only.
   *
   * In the header because they describe the PROJECT, and the header is the one
   * place that already names it; the detail pane below is reserved for the
   * current selection and shows nothing when there is none.
   */
  subtitle?: string;
  /** Supplied only on the project screen; renders the back arrow. */
  onBack?: () => void;
  /** Tab strip, rendered next to the title rather than above the content. */
  headerTabs?: React.ReactNode;
  /** Controls on the title row itself (project menu), left of the close X. */
  titleActions?: React.ReactNode;
  /** Hide the search field on screens with nothing worth filtering. */
  showSearch?: boolean;
  /**
   * Full-width band between the title row and the tools, for the open document
   * (plan-709 F3).
   *
   * Above the search bar and not beside it: the search bar is for finding what
   * you have not opened yet, and the one thing you HAVE opened should not have
   * to compete with it for the same row.
   */
  hero?: React.ReactNode;
  /** Header actions rendered left of the close button. */
  headerActions?: React.ReactNode;
  /** The screen itself. Laid out as a row so a detail pane can sit beside it. */
  children: React.ReactNode;
}

export function ProjectsDashboard({
  title,
  subtitle,
  onBack,
  headerTabs,
  titleActions,
  showSearch = true,
  hero,
  headerActions,
  children,
}: ProjectsDashboardProps) {
  const snap = useSyncExternalStore(subscribeProjectsDashboard, getProjectsDashboardSnapshot);
  const insets = useViewportInsets();

  /**
   * Exit choreography: a close SLIDES the dashboard off to the left instead
   * of blinking it away — the freshly loaded model behind it is the reveal.
   * The element keeps `display: flex` for the slide's duration, then goes
   * back to the hidden-not-unmounted rule below. Under reduced motion the
   * close stays instant.
   */
  const [closing, setClosing] = useState(false);
  const wasOpen = useRef(snap.open);
  useEffect(() => {
    const was = wasOpen.current;
    wasOpen.current = snap.open;
    if (snap.open) { setClosing(false); return; }
    if (!was) return;
    if (typeof matchMedia === 'function'
      && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setClosing(true);
    const t = setTimeout(() => setClosing(false), 320);
    return () => clearTimeout(t);
  }, [snap.open]);

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

  const root = getFloatingPanelRoot();

  const content = (
    <Box
      role="region"
      aria-label="Projects"
      // Hidden, not unmounted, while closed (the host gates the very first
      // mount): reopening must be instant and must resume the exact view —
      // tree expansion, scroll, selection — which unmounting threw away.
      sx={{
        position: 'fixed',
        top: insets.top,
        left: ACTIVITY_BAR_WIDTH,
        right: 0,
        bottom: 0,
        zIndex: PROJECTS_DASHBOARD_ZINDEX,
        display: snap.open || closing ? 'flex' : 'none',
        flexDirection: 'column',
        // The exit slide (see `closing` above). Transitioned only on the way
        // OUT: reopening snaps into place, because a place you return to
        // should not perform an entrance.
        transform: closing && !snap.open ? 'translateX(-100%)' : 'none',
        opacity: closing && !snap.open ? 0 : 1,
        transition: closing && !snap.open
          ? 'transform 300ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease-out'
          : 'none',
        // Tier-3 glass over the viewport (DESIGN.md) — the 3D scene stays
        // faintly visible so the overlay reads as part of the same product.
        // The blur lives HERE, the paint on the sections below: the hero band
        // wears a lighter wash than the rest, and one backdrop-filter on the
        // root is what lets both share a single blurred scene behind them.
        backdropFilter: 'blur(calc(8px * var(--rv-ui-blur-scale, 1)))',
        // A sliding overlay must not take clicks with it.
        pointerEvents: closing && !snap.open ? 'none' : 'auto',
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
          bgcolor: 'rgba(18, 20, 24, 0.94)',
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
        {subtitle && (
          <Typography
            data-testid="projects-header-subtitle"
            sx={{ fontSize: 11, color: 'text.secondary', whiteSpace: 'nowrap', mt: '2px' }}
          >
            {subtitle}
          </Typography>
        )}
        {headerTabs}
        <Box sx={{ flex: 1 }} />
        {titleActions}
        <Tooltip title="Close (Esc)">
          <IconButton size="small" onClick={closeProjectsDashboard} aria-label="Close Projects">
            <Close sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* The open document, full width, above the tools. Its band is the one
          section that keeps a LIGHTER wash: the blurred scene shows through
          behind the hero card, which is what sets the open document apart
          from the working surfaces below it. */}
      <Box
        sx={{
          flexShrink: 0,
          bgcolor: 'rgba(18, 20, 24, 0.65)',
          // A soft inset shadow from the band's top and bottom edges — the
          // recessed look that makes the translucent band read as BEHIND the
          // opaque surfaces above and below it.
          boxShadow: 'inset 0 8px 10px -8px rgba(0,0,0,0.55), '
            + 'inset 0 -8px 10px -8px rgba(0,0,0,0.55)',
        }}
      >
        {hero}
      </Box>

      {/* Sub-header — the tools, on their own bar. Filters and verbs read
          left-to-right from the start of the bar; search sits centred, under
          the hero card it shares an axis with. */}
      {(showSearch || headerActions) && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 1,
            px: 1.5,
            py: 1,
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
            bgcolor: 'rgba(18, 20, 24, 0.94)',
          }}
        >
          {headerActions}
          {/* Two equal spacers, not one: search sits in the CENTRE of the bar,
              so the flexible space has to be split either side of it rather
              than all collected before it. The verbs keep the left edge. */}
          <Box sx={{ flex: 1 }} />
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
          <Box sx={{ flex: 1 }} />
        </Box>
      )}

      {/* The active screen. A row, so a detail pane can sit beside the body. */}
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0, bgcolor: 'rgba(18, 20, 24, 0.94)' }}>
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

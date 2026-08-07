// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { Box, Paper } from '@mui/material';
import { ChevronLeft, ChevronRight } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useSlot } from '../../hooks/use-slot';
import { ACTIVITY_BAR_WIDTH, FLOATING_TOP_MARGIN, LEFT_PANEL_ZINDEX } from './layout-constants';
import { useLeftWindowWidth } from '../../hooks/use-left-window-width';
import { useViewportInsets } from '../../hooks/use-viewport-insets';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { WelcomeModal } from './WelcomeModal';
import { useCustomBranding } from './branding-store';
import { useKioskHasTour, startKioskFromWelcome } from '../../plugins/kiosk-plugin';
import { useActiveContexts, evaluateVisibilityRule, useUIVisible } from './ui-context-store';
import { WELCOME_AUTO_OPEN_UI_ELEMENT_ID, WELCOME_AUTO_OPEN_VISIBILITY_RULE } from './welcome-modal-store';
import { useMode } from '../../hooks/use-mode';

/* Logo URL: use BASE_URL so it resolves correctly under sub-folder deploys (e.g. Bunny CDN /demo/) */
const logoUrl = `${import.meta.env.BASE_URL}logo.png`;

/**
 * BrandingContent — the logo image for the activity bar: the default realvirtual
 * mark, or a custom logo when custom branding is set. Constrained to fit the
 * narrow (30px) vertical activity bar — icon only, no text.
 */
function BrandingContent() {
  const custom = useCustomBranding();

  // No branding, or branding that doesn't override the activity-bar mark →
  // keep the default realvirtual logo. A project sets `logoUrl` only when it
  // wants its own mark here; Mauser leaves it so the platform logo stays.
  if (!custom?.logoUrl) {
    return <img src={logoUrl} alt="realvirtual" style={{ height: 24, width: 24 }} />;
  }
  return (
    <img
      src={custom.logoUrl}
      alt={custom.name ?? 'Logo'}
      style={{ height: 24, width: 'auto', maxWidth: 38, objectFit: 'contain' }}
    />
  );
}

// ── Logo Badge (the top mark of the left activity bar) ──────────────────

/** Clickable realvirtual (or custom) logo at the top of the activity bar.
 *  Opens the About / Welcome modal. Icon-only to fit the 30px vertical bar. */
const WELCOME_DISMISSED_KEY = 'rv-welcome-dismissed';

export function LogoBadge() {
  // Two openings, kept in separate state on purpose:
  //  - `manualOpen`  — the user clicked the logo. Honoured in every workspace.
  //  - `autoPending` — first visit in this browser; the dialog shows itself.
  const [manualOpen, setManualOpen] = useState(false);
  const [autoPending, setAutoPending] = useState(() => !localStorage.getItem(WELCOME_DISMISSED_KEY));

  // plan-387 (F4): in the Viewer workspace the dialog must not open ITSELF —
  // it is a product pitch whose "Planner Demo" button is an authoring entry
  // point, and a spectator following a shared link should see the machine.
  // Gated through the rule system (id + `hiddenIn`) rather than by asking for
  // the active mode, so a deployment can override it like any other chrome
  // element. The logo stays visible and clickable; About remains reachable.
  const autoOpenAllowed = useUIVisible(
    WELCOME_AUTO_OPEN_UI_ELEMENT_ID,
    WELCOME_AUTO_OPEN_VISIBILITY_RULE,
  );
  const aboutOpen = manualOpen || (autoPending && autoOpenAllowed);

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          py: 0.5,
          cursor: 'pointer',
          borderRadius: 1,
          '&:hover': { backgroundColor: 'rgba(255,255,255,0.06)' },
        }}
        onClick={() => setManualOpen(true)}
        title="About"
      >
        <BrandingContent />
      </Box>

      <WelcomeModalHost
        open={aboutOpen}
        onClose={() => {
          setManualOpen(false);
          setAutoPending(false);
          localStorage.setItem(WELCOME_DISMISSED_KEY, '1');
        }}
      />
    </>
  );
}

/** Thread kiosk-plugin's useKioskHasTour() hook + onStartDemo callback into WelcomeModal. */
function WelcomeModalHost({ open, onClose }: { open: boolean; onClose: () => void }) {
  const hasKioskTour = useKioskHasTour();
  return (
    <WelcomeModal
      open={open}
      onClose={onClose}
      onStartDemo={hasKioskTour ? startKioskFromWelcome : undefined}
    />
  );
}

// ── Button Panel (floating contextual-tool toolbar) ─────────────────────

/**
 * ButtonPanel — the FLOATING left toolbar for contextual mode TOOLS contributed
 * via the `button-group` slot (e.g. the Layout Planner's grid/snap/delete tools,
 * measurement, …). It floats over the 3D view and shifts right to clear the
 * activity bar and any open left-docked window.
 *
 * NOT the activity bar — window-opener buttons live in ActivityBar.tsx.
 */
export function ButtonPanel({ dock = false }: { dock?: boolean } = {}) {
  const viewer = useViewer();
  const allEntries = useSlot('button-group');

  // Active UI contexts (planner, fpv, xr, …). Drives entry visibility filtering.
  const contexts = useActiveContexts();

  /**
   * Filter slot entries to those that should currently render.
   *  - Entry has explicit `visibilityRule` → evaluate it directly.
   *  - No rule → visible by default, EXCEPT in a "focused" workspace mode
   *    (any active mode other than the default `hmi`, e.g. Planner or DES),
   *    where only buttons that opt in via a visibility rule are shown.
   */
  const { active: activeMode } = useMode();
  const entries = useMemo(() => {
    const focusedMode = activeMode !== null && activeMode !== 'hmi';
    return allEntries.filter((entry) => {
      if (entry.visibilityRule) {
        return evaluateVisibilityRule(entry.visibilityRule, contexts);
      }
      return !focusedMode;
    });
  }, [allEntries, contexts, activeMode]);

  const isMobile = useMobileLayout();

  // Shift the floating toolbar right to clear the activity bar AND any open
  // left-docked window (shared with the floating mode switcher).
  const windowWidth = useLeftWindowWidth();
  const buttonLeftOffset = ACTIVITY_BAR_WIDTH + (windowWidth > 0 ? windowWidth + 8 : 8);
  // Clear the optional top title bar when present.
  const topInset = useViewportInsets().top;

  // Scroll affordance for the mobile tool row — left/right chevrons appear only
  // when the row actually overflows in that direction.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollHint, setScrollHint] = useState({ left: false, right: false });
  const updateScrollHint = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setScrollHint({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 });
  }, []);
  useEffect(() => {
    if (!isMobile) return;
    const el = scrollRef.current;
    if (!el) return;
    updateScrollHint();
    el.addEventListener('scroll', updateScrollHint, { passive: true });
    const ro = new ResizeObserver(updateScrollHint);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', updateScrollHint); ro.disconnect(); };
  }, [isMobile, updateScrollHint, entries.length]);

  if (entries.length === 0) return null;

  const buttons = entries.map((entry, i) => {
    const Comp = entry.component;
    return <Comp key={`btn-${i}`} viewer={viewer} />;
  });

  const paper = (
    <Paper
      elevation={4}
      data-ui-panel
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.25,
        p: 0.5,
        borderRadius: isMobile ? 0 : 2,
        pointerEvents: 'auto',
        ...(isMobile && { width: '100%' }),
      }}
    >
      {isMobile ? (
        <>
          <Box
            ref={scrollRef}
            sx={{
              display: 'flex', flexDirection: 'row', gap: 0.25,
              justifyContent: 'safe center',
              overflowX: 'auto', WebkitOverflowScrolling: 'touch',
              scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' },
              '& > *': { flexShrink: 0 },
              // Touch-friendly hit targets (~44px) + slightly larger icons.
              '& .MuiIconButton-root': { minWidth: 44, minHeight: 44 },
              '& .MuiSvgIcon-root': { fontSize: 22 },
            }}
          >
            {buttons}
          </Box>
          {scrollHint.left && (
            <Box
              onClick={() => scrollRef.current?.scrollBy({ left: -120, behavior: 'smooth' })}
              aria-label="Scroll tools left"
              sx={{
                position: 'absolute', left: 0, top: 0, bottom: 0, width: 40,
                display: 'flex', alignItems: 'center', justifyContent: 'flex-start', pl: 0.25,
                cursor: 'pointer', pointerEvents: 'auto',
                background: 'linear-gradient(to right, rgba(18,18,18,0.97) 45%, rgba(18,18,18,0))',
              }}
            >
              <ChevronLeft sx={{ fontSize: 28, color: '#fff' }} />
            </Box>
          )}
          {scrollHint.right && (
            <Box
              onClick={() => scrollRef.current?.scrollBy({ left: 120, behavior: 'smooth' })}
              aria-label="Scroll tools right"
              sx={{
                position: 'absolute', right: 0, top: 0, bottom: 0, width: 40,
                display: 'flex', alignItems: 'center', justifyContent: 'flex-end', pr: 0.25,
                cursor: 'pointer', pointerEvents: 'auto',
                background: 'linear-gradient(to left, rgba(18,18,18,0.97) 45%, rgba(18,18,18,0))',
              }}
            >
              <ChevronRight sx={{ fontSize: 28, color: '#fff' }} />
            </Box>
          )}
        </>
      ) : buttons}
    </Paper>
  );

  // Inside the shared MobileBottomDock the dock owns positioning + safe-area.
  if (isMobile && dock) return paper;

  return (
    <Box
      sx={isMobile ? {
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: LEFT_PANEL_ZINDEX,
        display: 'flex',
        pointerEvents: 'none',
        pb: 'env(safe-area-inset-bottom, 0px)',
      } : {
        position: 'fixed',
        left: buttonLeftOffset,
        top: topInset + FLOATING_TOP_MARGIN + 6,
        bottom: 8,
        zIndex: LEFT_PANEL_ZINDEX,
        display: 'flex',
        alignItems: 'center',
        pointerEvents: 'none',
      }}
    >
      {paper}
    </Box>
  );
}

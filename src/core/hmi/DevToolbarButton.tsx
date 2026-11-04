// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DevToolbarButton — the dev server's entry point in the activity bar
 * (plan-615 F1/F2), replacing the former red `ENTWICKLUNGSSERVER` banner.
 *
 * - **Icon only; the tooltip** names what the banner named: session label,
 *   port, machine, served path and branch.
 * - **Canonical checkout** (`isCanonicalCheckout`): the button is permanently
 *   red with a warning dot, and the tab title carries `[⚠ CANONICAL]` — never
 *   hover-only, because not noticing a tab served from the canonical checkout
 *   is the expensive mistake (ADR-040). A worktree session stays discreet and
 *   keeps the `[Plan N]` title prefix.
 * - **Click** opens {@link DevToolbarPopover}: view switch, snapshot, status, flags.
 * - **Placement**: the last entry of the activity bar (below Settings and Help)
 *   and of the mobile pill — the same button in the same place in the dev view
 *   AND the delivered view (`rv-view-profile.ts`; the delivered view still
 *   shows the bar).
 * - {@link DevHandle} — a small translucent handle at the screen edge — is only
 *   the fallback for a page with NO activity bar mounted (a delivery whose
 *   config hides the bar, a shell without one). Every mounted button registers
 *   with a tiny counter; {@link DevSessionHost} renders the handle only while
 *   that count is 0.
 *
 * Everything here is dev-server only: callers render it behind
 * `RV_SERVE_INFO !== null`, which is the literal `null` in every build, so
 * Rollup drops the subtree and no machine path is ever shipped
 * (tests/dev-toolbar-bundle-absence.node.test.ts).
 */

import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { Badge, Box, IconButton, Popover, Portal, Tooltip } from '@mui/material';
import { Code } from '@mui/icons-material';
import { RV_SERVE_INFO, isCanonicalCheckout, formatSessionLabel, type RVServeInfo } from '../rv-serve-info';
import { DevToolbarPopover, serveSessionLines } from './DevToolbarPopover';
import { ERROR, FIELD_BORDER, FS, INK_HIGH, INK_MID, MONO, PANEL_SURFACE } from './shared-sx';

/** Tab-title prefix of a tab served from the canonical checkout. */
export const CANONICAL_TITLE_PREFIX = '[⚠ CANONICAL]';

/**
 * Above every product layer, including the welcome overlay (10000) — like the
 * former banner: the dev entry must stay reachable on every fresh load, and it
 * never exists in a build.
 */
export const DEV_UI_ZINDEX = 10001;

// ─── Mounted-button counter (decides whether the fallback handle shows) ─────

let mountedBarButtons = 0;
const barButtonListeners: Array<() => void> = [];

function notifyBarButtons(): void {
  for (const listener of barButtonListeners.slice()) listener();
}

function subscribeBarButtons(listener: () => void): () => void {
  barButtonListeners.push(listener);
  return () => {
    const i = barButtonListeners.indexOf(listener);
    if (i >= 0) barButtonListeners.splice(i, 1);
  };
}

/** Number of dev toolbar buttons currently mounted in an activity bar. */
export function getMountedDevBarButtonCount(): number {
  return mountedBarButtons;
}

/**
 * Registers a mounted bar button. A layout effect, so the fallback handle is
 * removed before the first paint instead of flashing for one frame.
 */
function useRegisterBarButton(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    mountedBarButtons += 1;
    notifyBarButtons();
    return () => {
      mountedBarButtons -= 1;
      notifyBarButtons();
    };
  }, [active]);
}

// ─── Title prefix ───────────────────────────────────────────────────────────

/** The tab-title prefix for a served session: `[⚠ CANONICAL]` or `[Plan N]`. */
export function serveSessionTitlePrefix(info: RVServeInfo | null): string {
  if (!info) return '';
  return isCanonicalCheckout(info) ? CANONICAL_TITLE_PREFIX : `[${formatSessionLabel(info)}]`;
}

/**
 * Prefixes the tab title with the session while mounted. With several tabs
 * open the tab bar is where you actually look.
 */
export function useServeSessionTitle(info: RVServeInfo | null = RV_SERVE_INFO): void {
  const prefix = serveSessionTitlePrefix(info);
  useEffect(() => {
    if (!prefix) return;
    const original = document.title;
    document.title = `${prefix} ${original}`;
    return () => { document.title = original; };
  }, [prefix]);
}

// ─── Shared pieces ──────────────────────────────────────────────────────────

/** Opaque floating-panel surface for the tooltip (shared-sx tokens only). */
const tooltipSlotProps = {
  tooltip: {
    sx: {
      bgcolor: PANEL_SURFACE,
      color: INK_HIGH,
      border: `1px solid ${FIELD_BORDER}`,
      maxWidth: 'none',
    },
  },
} as const;

function tooltipBody(info: RVServeInfo) {
  const port = typeof window !== 'undefined' ? window.location.port : '';
  return (
    <Box component="span" sx={{ display: 'block', whiteSpace: 'pre-line', fontFamily: MONO, fontSize: FS.label }}>
      {serveSessionLines(info, port).join('\n')}
    </Box>
  );
}

/** The icon with the canonical warning dot. */
function DevIcon({ canonical }: { canonical: boolean }) {
  return (
    <Badge
      variant="dot"
      color="warning"
      invisible={!canonical}
      overlap="circular"
      data-testid="dev-toolbar-badge"
    >
      <Code />
    </Badge>
  );
}

type DevPlacement = 'right' | 'top';

/**
 * Popover holding the dev tools. Never opens upward: from the bar button
 * (`right`) it opens to the side, top edge level with the button and growing
 * downward (MUI shifts it up only as far as the viewport requires); from the
 * mobile pill (`top`) it drops down below it. Opaque surface like the other activity-bar popovers, never taller
 * than the viewport (scrolls inside).
 */
function DevPopover({ info, anchor, placement, onClose }: {
  info: RVServeInfo; anchor: HTMLElement | null; placement: DevPlacement; onClose: () => void;
}) {
  const fromTop = placement === 'top';
  return (
    <Popover
      open={anchor !== null}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={fromTop ? { vertical: 'bottom', horizontal: 'right' } : { vertical: 'top', horizontal: 'right' }}
      transformOrigin={fromTop ? { vertical: 'top', horizontal: 'right' } : { vertical: 'top', horizontal: 'left' }}
      sx={{ zIndex: DEV_UI_ZINDEX + 1 }}
      slotProps={{
        paper: {
          'data-testid': 'dev-toolbar-popover-paper',
          sx: {
            ...(fromTop ? { mt: 1 } : { ml: 1 }),
            maxHeight: 'calc(100dvh - 16px)',
            overflowY: 'auto',
            backgroundColor: `${PANEL_SURFACE} !important`,
          },
        } as never,
      }}
    >
      <DevToolbarPopover info={info} />
    </Popover>
  );
}

// ─── Button, fallback handle, App-root host ────────────────────────────────

/**
 * The dev entry in the activity bar — the bar's last entry, in the dev view and
 * the delivered view alike. Renders nothing outside the dev server.
 */
export function DevToolbarButton({
  placement = 'right',
  info = RV_SERVE_INFO,
}: { placement?: DevPlacement; info?: RVServeInfo | null }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useRegisterBarButton(info !== null);
  if (!info) return null;
  const canonical = isCanonicalCheckout(info);
  return (
    <>
      <Tooltip title={tooltipBody(info)} placement={placement} slotProps={tooltipSlotProps}>
        <IconButton
          size="medium"
          data-testid="dev-toolbar-button"
          data-canonical={canonical ? 'true' : 'false'}
          aria-label={canonical ? 'Dev tools (canonical checkout)' : 'Dev tools'}
          onClick={(e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget)}
          sx={canonical
            ? { color: ERROR, bgcolor: `${ERROR}29`, '&:hover': { bgcolor: `${ERROR}40` } }
            : { color: INK_MID }}
        >
          <DevIcon canonical={canonical} />
        </IconButton>
      </Tooltip>
      <DevPopover info={info} anchor={anchor} placement={placement} onClose={() => setAnchor(null)} />
    </>
  );
}

/**
 * Fallback entry for a page without any activity bar: a small translucent
 * handle at the bottom-left screen edge that opens the same popover. Portalled
 * to <body>, so no shell, UI zoom or welcome overlay can cover it.
 */
export function DevHandle({ info = RV_SERVE_INFO }: { info?: RVServeInfo | null }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!info) return null;
  const canonical = isCanonicalCheckout(info);
  return (
    <Portal>
      <Tooltip title={tooltipBody(info)} placement="right" slotProps={tooltipSlotProps}>
        <IconButton
          size="small"
          data-ui-panel
          data-testid="dev-handle"
          data-canonical={canonical ? 'true' : 'false'}
          aria-label="Dev tools"
          onClick={(e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget)}
          sx={{
            position: 'fixed', left: 4, bottom: 4, zIndex: DEV_UI_ZINDEX,
            opacity: 0.35, transition: 'opacity 120ms',
            color: canonical ? ERROR : INK_MID,
            '&:hover, &:focus-visible': { opacity: 1 },
          }}
        >
          <DevIcon canonical={canonical} />
        </IconButton>
      </Tooltip>
      <DevPopover info={info} anchor={anchor} placement="right" onClose={() => setAnchor(null)} />
    </Portal>
  );
}

/**
 * App-root part of the dev toolbar: the tab-title prefix for every shell, plus
 * the {@link DevHandle} while no activity bar button is mounted.
 */
export function DevSessionHost({ info = RV_SERVE_INFO }: { info?: RVServeInfo | null }) {
  useServeSessionTitle(info);
  const barButtons = useSyncExternalStore(subscribeBarButtons, getMountedDevBarButtonCount, getMountedDevBarButtonCount);
  if (!info) return null;
  return barButtons === 0 ? <DevHandle info={info} /> : null;
}

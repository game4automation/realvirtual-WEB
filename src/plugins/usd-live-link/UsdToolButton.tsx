// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * UsdToolButton — the USD entry of the main menu (activity bar) (plan-637 F1/F2/F9).
 *
 * Only the icon button lives in the entry chunk. The menu (Export / Import /
 * Sync, status, connection settings, the export and import dialogs) is
 * `UsdToolMenu`, loaded by `React.lazy` on the first click and kept mounted
 * afterwards so an open dialog or message survives closing the menu.
 *
 * Like the CONNECT button, a status dot on the icon carries the link state
 * (green live, amber connecting / transferring / token needed, red error, none
 * while off); the icon itself turns primary only while the menu is open.
 */

import { lazy, Suspense, useState, useSyncExternalStore } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import { Layers } from '@mui/icons-material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { ERROR, SUCCESS, WARN } from '../../core/hmi/shared-sx';
import type { UsdLiveLinkPlugin } from './usd-live-link-plugin';
import type { LiveLinkState } from './live-link-store';

const UsdToolMenu = lazy(() => import('./UsdToolMenu').then((m) => ({ default: m.UsdToolMenu })));

/** Id of the menu surface (the button's `aria-controls`). */
export const USD_MENU_ID = 'usd-menu-popover';

/** Colour of the status dot on the button, or null (no dot while off). */
export function usdStatusDotColor(state: LiveLinkState): string | null {
  switch (state.status) {
    case 'live': return SUCCESS;
    case 'error': return ERROR;
    case 'off': return null;
    default: return WARN; // needs-token, connecting, mounting
  }
}

export function UsdToolButton({ viewer }: UISlotProps) {
  const plugin = viewer.getPlugin<UsdLiveLinkPlugin>('usd-live-link') ?? null;
  const state = useSyncExternalStore(
    plugin?.store.subscribe ?? (() => () => {}),
    plugin?.store.getSnapshot ?? (() => null),
  );
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [menuMounted, setMenuMounted] = useState(false);

  if (!plugin || !state) return null;
  const live = state.status === 'live';
  const open = !!anchorEl;
  const dot = usdStatusDotColor(state);

  return (
    <>
      <Tooltip title={`USD — export, import, sync to Isaac Sim${live ? ' (live)' : ''}`} placement="right">
        <IconButton
          size="medium"
          color={open ? 'primary' : 'inherit'}
          sx={{ position: 'relative' }}
          data-testid="usd-tool-button"
          aria-label="USD"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? USD_MENU_ID : undefined}
          onClick={(e) => { setMenuMounted(true); setAnchorEl(e.currentTarget); }}
        >
          <Layers />
          {dot && (
            <Box
              data-testid="usd-status-dot"
              data-color={dot}
              sx={{ position: 'absolute', top: 6, right: 6, width: 6, height: 6, borderRadius: '50%', bgcolor: dot }}
            />
          )}
        </IconButton>
      </Tooltip>
      {menuMounted && (
        <Suspense fallback={null}>
          <UsdToolMenu viewer={viewer} anchorEl={anchorEl} onClose={() => setAnchorEl(null)} />
        </Suspense>
      )}
    </>
  );
}

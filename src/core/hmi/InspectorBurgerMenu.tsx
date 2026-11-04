// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * InspectorBurgerMenu — the Property Inspector's own ⋮ menu (plan-2013, Concept D).
 *
 * Today it carries exactly one entry: "Variant management". That is deliberate — Thomas
 * asked for the switch to sit in the inspector's burger menu rather than in Settings, so
 * the mode is turned on next to the rows it changes. The menu renders nothing at all while
 * no document publishes a variant mode context, which keeps a viewer without variants
 * looking exactly as it did.
 *
 * Eager and tiny: it only reads the preference store (`rv-variant-ui-mode.ts`) and calls
 * its `setMode`, which is what loads the lazy variants runtime.
 */

import { useState, useSyncExternalStore } from 'react';
import { ListItemIcon, Menu, MenuItem, IconButton, Tooltip, Typography } from '@mui/material';
import { Check, MoreVert } from '@mui/icons-material';
import { ERROR, FS, ICON_SIZE, INK_LOW } from './shared-sx';
import {
  getVariantModeContext,
  subscribeVariantMode,
  variantModeActive,
  variantModeVersion,
} from './rv-variant-ui-mode';

export function InspectorBurgerMenu() {
  useSyncExternalStore(subscribeVariantMode, variantModeVersion);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctx = getVariantModeContext();
  if (!ctx) return null;
  const on = variantModeActive();

  const toggle = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await ctx.setMode(!on);
      setAnchor(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tooltip title="Inspector options">
        <IconButton
          size="small"
          aria-label="Inspector options"
          aria-haspopup="menu"
          data-testid="inspector-burger"
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{ color: 'text.secondary', p: 0.25 }}
        >
          <MoreVert sx={{ fontSize: ICON_SIZE.sm }} />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => { setAnchor(null); setError(null); }}
        MenuListProps={{ dense: true, 'aria-label': 'Inspector options' }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          role="menuitemcheckbox"
          aria-checked={on}
          disabled={busy}
          data-testid="inspector-variant-mode"
          onClick={() => void toggle()}
          sx={{ fontSize: FS.body, minHeight: 28 }}
        >
          <ListItemIcon sx={{ minWidth: 24, color: 'inherit' }}>
            {on && <Check sx={{ fontSize: ICON_SIZE.sm }} />}
          </ListItemIcon>
          Variant management
        </MenuItem>
        <Typography sx={{ px: 2, pb: 0.5, maxWidth: 260, fontSize: FS.micro, color: error ? ERROR : INK_LOW }} role={error ? 'alert' : undefined}>
          {error ?? 'Shows a variant icon on every value row and the variant switcher in the simulation toolbar.'}
        </Typography>
      </Menu>
    </>
  );
}

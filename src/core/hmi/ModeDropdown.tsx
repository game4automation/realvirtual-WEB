// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from '../rv-safe-storage';

/**
 * ModeDropdown — Blender-style workspace mode switcher (plan-198).
 *
 * Rendered as a flex SIBLING of the top toolbar (inside TopBar's shared fixed
 * flex row), so layout — not measurement — keeps it glued to the toolbar's
 * right edge at matching height. It's its own themed Paper (same elevation /
 * radius as the toolbar) and stretches to the toolbar's height via the parent's
 * `alignItems: stretch`. Shows the active mode (icon + label) with a chevron;
 * clicking opens a menu of all registered modes. Renders nothing until at least
 * one mode is registered.
 */

import { useEffect, useMemo, useState, type ComponentType, type ReactElement } from 'react';
import { Box, Menu, MenuItem, ListItemIcon, ListItemText, Typography, ButtonBase, Paper } from '@mui/material';
import {
  ArrowDropDown, Check, ViewQuilt, AccountTree, GridView, ViewInAr, Dashboard, Edit, Handyman,
} from '@mui/icons-material';
import { useMode } from '../../hooks/use-mode';
import { useViewer } from '../../hooks/use-viewer';
import { createIntentPrefetcher, lazyFeaturesForMode } from '../rv-feature-prefetch';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useUIZoom } from './visual-settings-store';
import { useUIVisible } from './ui-context-store';
import type { ModeId } from '../rv-mode-manager';
import { ACCENT_BORDER, FIELD_BORDER, FIELD_BORDER_HOVER } from './shared-sx';

/** localStorage key of the last on-demand mode picked in the dropdown (plan-652 §2.4.6). */
const LAST_LAZY_MODE_KEY = 'rv-last-lazy-mode';

function rememberLazyMode(id: string): void {
  writeLocalStorage(LAST_LAZY_MODE_KEY, id);
}

function recallLazyMode(): string | null {
  return readLocalStorage(LAST_LAZY_MODE_KEY);
}

/** Maps a descriptor `icon` name (or mode id) to a MUI icon component. */
const ICONS: Record<string, ComponentType<{ fontSize?: 'small' | 'medium' }>> = {
  hmi: ViewQuilt,
  des: AccountTree,
  planner: GridView,
  editor: Edit,
  commissioning: Handyman,
  ViewQuilt, AccountTree, GridView, ViewInAr, Dashboard, Edit, Handyman,
};

function iconFor(idOrName: string | undefined, fallback: string): ReactElement {
  const Comp = (idOrName && ICONS[idOrName]) || ICONS[fallback] || Dashboard;
  return <Comp fontSize="small" />;
}

export function ModeDropdown() {
  const { active, modes, setMode, locked } = useMode();
  const viewer = useViewer();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  // plan-652 §2.4.6: hovering / focusing an on-demand mode (Editor, DES) starts the import of
  // its feature after 80 ms, so the click finds the chunk in flight or done. Import only —
  // activation stays with the mode's enter guard.
  const prefetch = useMemo(() => createIntentPrefetcher(() => viewer.features), [viewer]);
  useEffect(() => () => prefetch.cancelAll(), [prefetch]);
  const isMobile = useMobileLayout();
  // The menu renders in a portal OUTSIDE the zoomed HMIShell, so it doesn't
  // inherit the UI scale — apply it explicitly (mirrors HMIShell's zoom).
  const uiZoom = useUIZoom();
  // Embedding a viewer in a foreign page must not offer a way out into the full
  // app (plan-387 F5). Driven by the `embedded` CONTEXT (set once at boot in
  // main.ts) rather than by reading `window.self !== window.top` here, so a
  // deployment can override the rule and tests need no real iframe.
  const switcherVisible = useUIVisible('mode-switcher', { hiddenIn: ['embedded'] });

  // Hidden when the workspace is locked to a single mode (kiosk / HMI-only
  // deployments like a customer kiosk 3D-HMI), when embedded, or when nothing is registered yet.
  if (locked || !switcherVisible || modes.length === 0) return null;

  const current = modes.find((m) => m.id === active) ?? modes[0];
  const open = !!anchor;

  const handleSelect = (id: ModeId) => {
    setAnchor(null);
    prefetch.cancelAll();
    if (id !== active) {
      if (lazyFeaturesForMode(viewer.features, id).length > 0) rememberLazyMode(id);
      setMode(id);
    }
  };

  const handleOpen = (target: HTMLElement) => {
    setAnchor(target);
    // The last on-demand mode the user picked is the likeliest next pick: import it now.
    const last = recallLazyMode();
    if (last && last !== active) prefetch.down(last);
  };

  return (
    <Paper
      elevation={0}
      data-ui-panel
      sx={{
        borderRadius: 1,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        px: 0.5,
        boxShadow: 'none',
        border: `1px solid ${open ? ACCENT_BORDER : FIELD_BORDER}`,
        transition: 'border-color 120ms ease',
        '&:hover': { borderColor: open ? ACCENT_BORDER : FIELD_BORDER_HOVER },
      }}
    >
      <ButtonBase
        onClick={(e) => handleOpen(e.currentTarget)}
        aria-label="Switch workspace mode"
        aria-haspopup="menu"
        aria-expanded={open}
        sx={{
          alignSelf: 'stretch',
          minHeight: isMobile ? 32 : 22,
          px: 0.75,
          py: 0,
          gap: 0.5,
          borderRadius: 1,
          color: 'inherit',
          bgcolor: open ? 'rgba(255,255,255,0.14)' : 'transparent',
          transition: 'background-color 120ms',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' },
        }}
      >
        <Box sx={{ display: 'inline-flex', color: 'primary.light' }}>
          {iconFor(current.icon ?? current.id, current.id)}
        </Box>
        <Typography
          sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1, whiteSpace: 'nowrap', textAlign: 'left' }}
        >
          {current.label}
        </Typography>
        <ArrowDropDown
          fontSize="small"
          sx={{ opacity: 0.7, transition: 'transform 120ms', transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </ButtonBase>
      <Menu
        anchorEl={anchor}
        open={open}
        onClose={() => { setAnchor(null); prefetch.cancelAll(); }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.75,
              minWidth: 200,
              // Portal content doesn't inherit HMIShell's zoom — apply UI scale here.
              zoom: uiZoom,
              bgcolor: 'rgba(30, 30, 30, 0.95)',
              backdropFilter: 'blur(calc(12px * var(--rv-ui-blur-scale, 1)))',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: 'none',
              '& .MuiList-root': { py: 0.5 },
            },
          },
        }}
      >
        {modes.map((m) => {
          const isActive = m.id === active;
          return (
            <MenuItem
              key={m.id}
              selected={isActive}
              onClick={() => handleSelect(m.id)}
              onPointerEnter={() => prefetch.enter(m.id)}
              onFocus={() => prefetch.enter(m.id)}
              onPointerLeave={() => prefetch.leave(m.id)}
              onPointerDown={() => prefetch.down(m.id)}
              sx={{
                fontSize: 13,
                py: 0.6,
                px: 1.25,
                gap: 0.5,
                minHeight: 'auto',
                '&:hover': { bgcolor: 'rgba(255,255,255,0.06)' },
                '&.Mui-selected': { bgcolor: 'rgba(79,195,247,0.14)' },
                '&.Mui-selected:hover': { bgcolor: 'rgba(79,195,247,0.20)' },
              }}
            >
              <ListItemIcon sx={{ minWidth: 30, color: isActive ? 'primary.light' : 'rgba(255,255,255,0.7)' }}>
                {iconFor(m.icon ?? m.id, m.id)}
              </ListItemIcon>
              <ListItemText
                primary={m.label}
                slotProps={{ primary: { sx: { fontSize: 13, fontWeight: isActive ? 600 : 400 } } }}
              />
              <Box component="span" sx={{ display: 'inline-flex', ml: 2, width: 16, color: 'primary.light' }}>
                {isActive && <Check sx={{ fontSize: 16 }} />}
              </Box>
            </MenuItem>
          );
        })}
      </Menu>
    </Paper>
  );
}

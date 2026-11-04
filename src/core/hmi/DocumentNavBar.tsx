// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentNavBar — the way back after a reference's asset was opened in this
 * tab (`document-nav.ts`). The FIRST element of the floating top-left cluster
 * (`TopBar.tsx`, before the mode switcher):
 *
 *   [←] fufu › sidecutter
 *
 * Built exactly like the {@link ModeDropdown} next to it — the same bordered
 * Paper, the same 22px buttons with their padding and hover, the same 13px
 * semibold label — so the two read as one row. The breadcrumb starts at the document where the chain
 * began; every earlier entry jumps back to it. Renders nothing while there is
 * no way back.
 */

import { Fragment, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, ButtonBase, Menu, MenuItem, Paper, Tooltip, Typography } from '@mui/material';
import { useUIZoom } from './visual-settings-store';
import { ArrowBack, ChevronRight } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { getOpenDocumentBase } from '../editor/active-asset-store';
import { getSceneStore } from './scene/scene-store-singleton';
import { CHIP_HOVER, FIELD_BORDER, FIELD_BORDER_HOVER, ICON_SIZE, INK_HIGH, INK_LOW, INK_MID } from './shared-sx';
import { getDocumentNav, navigateBack, subscribeDocumentNav, syncDocumentNav } from './document-nav';
import { createDocumentNavHost } from './document-nav-host';

export interface NavCrumb {
  /** Frame index Back jumps to; the open document carries `frames.length`. */
  index: number;
  label: string;
  current: boolean;
}

/** The breadcrumb of a navigation chain: the root where it began, every frame, then the open document. */
export function navCrumbs(
  frames: readonly { name: string }[],
  current: { name: string } | null,
): NavCrumb[] {
  const out = frames.map((f, i) => ({ index: i, label: f.name, current: false }));
  if (current) out.push({ index: frames.length, label: current.name, current: true });
  return out;
}

/** One slot of the rendered breadcrumb: a crumb, or the collapsed middle of a long chain. */
export type NavSlot = NavCrumb | { more: NavCrumb[] };

/** Chains longer than this collapse their middle into one "…" slot. */
export const MAX_VISIBLE_CRUMBS = 4;

/**
 * `root › … › parent › current` once the chain is longer than
 * {@link MAX_VISIBLE_CRUMBS}: the root (where it began), the parent (Back's
 * target) and the current document stay visible, the rest sits behind "…".
 */
export function collapseCrumbs(crumbs: readonly NavCrumb[]): NavSlot[] {
  if (crumbs.length <= MAX_VISIBLE_CRUMBS) return [...crumbs];
  return [crumbs[0]!, { more: crumbs.slice(1, -2) }, ...crumbs.slice(-2)];
}

/** Label typography of the top-left cluster (the mode switcher's). */
const LABEL_SX = { fontSize: 13, lineHeight: 1, whiteSpace: 'nowrap' } as const;

/** Long document names are cut with "…"; the full name is in the tooltip. */
const ANCESTOR_MAX_WIDTH = 140;
const CURRENT_MAX_WIDTH = 180;
const truncateSx = (maxWidth: number) => ({
  ...LABEL_SX,
  fontWeight: 600,
  display: 'block',
  maxWidth,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}) as const;

export function DocumentNavBar({ viewer }: { viewer: RVViewer }) {
  const nav = useSyncExternalStore(subscribeDocumentNav, getDocumentNav);
  const host = useMemo(() => createDocumentNavHost(viewer), [viewer]);
  const isMobile = useMobileLayout();

  // A document opened any other way ends the chain.
  useEffect(() => {
    const store = getSceneStore();
    if (!store) return;
    return store.subscribe(() => {
      const base = getOpenDocumentBase();
      syncDocumentNav(base?.kind === 'document' ? base.documentId : null);
    });
  }, []);

  const slots = useMemo(() => collapseCrumbs(navCrumbs(nav.frames, nav.current)), [nav.frames, nav.current]);
  const hidden = useMemo(() => slots.flatMap((s) => ('more' in s ? s.more : [])), [slots]);
  const onBack = useCallback(() => { void navigateBack(host); }, [host]);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const uiZoom = useUIZoom();

  if (nav.frames.length === 0) return null;
  const parent = nav.frames[nav.frames.length - 1]!;

  /** The mode switcher's button optics: 22px tall, 6px sides, quiet hover. */
  const buttonSx = {
    alignSelf: 'stretch',
    minHeight: isMobile ? 32 : 22,
    px: 0.75,
    py: 0,
    gap: 0.5,
    borderRadius: 1,
    color: 'inherit',
    transition: 'background-color 120ms',
    '&:hover': { bgcolor: CHIP_HOVER },
    '&.Mui-disabled': { opacity: 0.5 },
  } as const;

  return (
    <Paper
      elevation={0}
      data-ui-panel
      role="navigation"
      aria-label="Opened references"
      data-testid="document-nav-bar"
      sx={{
        borderRadius: 1,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        px: 0.5,
        // 8px to the mode switcher instead of the cluster's 4px: the way back is
        // its own group, not the start of the mode label.
        mr: 0.5,
        boxShadow: 'none',
        border: `1px solid ${FIELD_BORDER}`,
        transition: 'border-color 120ms ease',
        '&:hover': { borderColor: FIELD_BORDER_HOVER },
      }}
    >
      <Tooltip title={`Back to ${parent.name}`} placement="bottom">
        <span style={{ display: 'flex', alignSelf: 'stretch' }}>
          <ButtonBase
            onClick={onBack}
            disabled={nav.busy}
            aria-label={`Back to ${parent.name}`}
            data-testid="document-nav-back"
            // Neutral at rest: the mode switcher's icon right next to it is the
            // cluster's blue lead; blue here only says "you can press this".
            sx={{ ...buttonSx, px: 0.25, color: INK_MID, '&:hover': { bgcolor: CHIP_HOVER, color: 'primary.light' } }}
          >
            {/* The mode switcher's icon size (MUI `small`, 20px). */}
            <ArrowBack fontSize="small" />
          </ButtonBase>
        </span>
      </Tooltip>

      <Box sx={{ display: 'flex', alignItems: 'center', alignSelf: 'stretch', gap: 0.25, pl: 0.25, pr: 0.5 }}>
        {slots.map((slot, i) => (
          <Fragment key={'more' in slot ? 'more' : slot.index}>
            {i > 0 && (
              <ChevronRight aria-hidden sx={{ fontSize: ICON_SIZE.sm, color: INK_LOW }} />
            )}
            {'more' in slot ? (
              <Tooltip title={slot.more.map((c) => c.label).join(' › ')} placement="bottom">
                <span style={{ display: 'flex', alignSelf: 'stretch' }}>
                  <ButtonBase
                    onClick={(e) => setMoreAnchor(e.currentTarget)}
                    disabled={nav.busy}
                    aria-label={`${slot.more.length} more`}
                    aria-haspopup="menu"
                    data-testid="document-nav-crumb-more"
                    sx={{ ...buttonSx, px: 0.5, mx: -0.5, color: INK_MID, '&:hover': { bgcolor: CHIP_HOVER, color: INK_HIGH } }}
                  >
                    <Box component="span" sx={{ ...LABEL_SX, fontWeight: 600 }}>…</Box>
                  </ButtonBase>
                </span>
              </Tooltip>
            ) : slot.current ? (
              <Tooltip title={slot.label} placement="bottom">
                <Typography
                  component="span"
                  aria-current="page"
                  data-testid="document-nav-crumb-current"
                  sx={{ ...truncateSx(CURRENT_MAX_WIDTH), color: INK_HIGH }}
                >
                  {slot.label}
                </Typography>
              </Tooltip>
            ) : (
              <Tooltip
                title={slot.index === 0 ? `Back to ${slot.label} (where you started)` : `Back to ${slot.label}`}
                placement="bottom"
              >
                <span style={{ display: 'flex', alignSelf: 'stretch' }}>
                  <ButtonBase
                    onClick={() => { void navigateBack(host, slot.index); }}
                    disabled={nav.busy}
                    data-testid={`document-nav-crumb-${slot.index}`}
                    sx={{ ...buttonSx, px: 0.5, mx: -0.5, color: INK_MID, '&:hover': { bgcolor: CHIP_HOVER, color: INK_HIGH } }}
                  >
                    <Box component="span" sx={truncateSx(ANCESTOR_MAX_WIDTH)}>{slot.label}</Box>
                  </ButtonBase>
                </span>
              </Tooltip>
            )}
          </Fragment>
        ))}
        <Menu
          anchorEl={moreAnchor}
          open={moreAnchor !== null}
          onClose={() => setMoreAnchor(null)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          // Portal content does not inherit HMIShell's zoom (ModeDropdown does the same).
          slotProps={{ paper: { sx: { mt: 0.75, zoom: uiZoom, boxShadow: 'none', border: `1px solid ${FIELD_BORDER}` } } }}
        >
          {hidden.map((c) => (
            <MenuItem
              key={c.index}
              data-testid={`document-nav-more-${c.index}`}
              onClick={() => { setMoreAnchor(null); void navigateBack(host, c.index); }}
              sx={{ fontSize: 13, py: 0.6, px: 1.25, minHeight: 'auto' }}
            >
              {c.label}
            </MenuItem>
          ))}
        </Menu>
      </Box>
    </Paper>
  );
}

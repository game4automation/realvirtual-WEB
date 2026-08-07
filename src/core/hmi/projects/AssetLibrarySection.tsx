// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AssetLibrarySection — one library's assets, under a header that says where
 * they came from (plan-702 Phase 1/3).
 *
 * The Assets tab used to be one grid. A user with a project library, the
 * realvirtual standard catalog, a customer GitHub repo and a local folder saw
 * four sources' worth of cards with nothing distinguishing them. A section per
 * library restores the answer to "where is this from" without a click, and the
 * header carries what only the source knows: its kind, its health, and whether
 * it can be detached again.
 *
 * ## The header is a real button
 *
 * `<button aria-expanded aria-controls>` — the WAI-ARIA accordion pattern. A
 * `<div onClick>` looks identical and is unreachable by keyboard, which on a
 * collapsed section means its contents are unreachable too.
 * https://www.w3.org/WAI/ARIA/apg/patterns/accordion/
 *
 * ## Collapsed means unmounted
 *
 * The grid is not hidden with `display:none`; it is not rendered. Cards pull
 * their own previews on mount, so a hidden grid would keep every thumbnail
 * request of every closed section alive (plan-702 §5.3 / S6).
 *
 * ## Why the header holds only four type roles
 *
 * DESIGN.md defines exactly four: Title 14/600, Body 13/400, Label 11/500 and
 * Data 11 mono. The first cut of this header invented 9.5px, 10px and 12px on
 * top of them, which is what made a row of five small elements read as noise
 * rather than as a hierarchy. Name = Title, kind badge and status = Label,
 * count = Data. Nothing else gets a size.
 *
 * ## Amber, never red
 *
 * A library that failed to load is a warning, not a machine state. Red and
 * green are spoken for by the two-axis signal rule (hue = PLC direction), so
 * a red "Failed to load" here would collide with that vocabulary. Warnings
 * carry one shared amber and are told apart by icon + label (DESIGN.md §2).
 */

import { useState } from 'react';
import {
  Box,
  Chip,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Delete,
  ExpandMore,
  FolderOpen,
  LockOutlined,
  MoreVert,
  Refresh,
  WarningAmber,
} from '@mui/icons-material';
import { CARD_MIN_WIDTH_PX } from '../../../plugins/layout-planner/CatalogBrowser';
import { CHIP_RADIUS } from '../shared-sx';
import { ProjectCard } from './ProjectSections';
import type { AssetLibraryGroup } from './assets-library-groups';

export interface AssetLibrarySectionProps {
  group: AssetLibraryGroup;
  collapsed: boolean;
  /** True while a search term filters the tab — changes the counter wording. */
  searchActive: boolean;
  /** First section in the list: suppresses the separating hairline. */
  first?: boolean;
  onToggle(): void;
  /** Re-scan a local folder. Offered only when the source exposes `refresh`. */
  onRefresh?(): void;
  /** Re-request the browser's read permission for a local folder. */
  onGrantPermission?(): void;
  /** Detach the library. Offered only when the source exposes `remove`. */
  onRemove?(): void;
}

/** Short badge naming the kind of source, so two same-named ones stay apart. */
const KIND_LABEL: Record<AssetLibraryGroup['kind'], string> = {
  project: 'Project',
  bundled: 'Bundled',
  url: 'URL',
  github: 'GitHub',
  local: 'Local',
  cloud: 'Cloud',
};

/** 180 ms, ease-out — DESIGN.md's 150–250 ms band, no bounce. */
const CHEVRON_MOTION = 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)';

export function AssetLibrarySection({
  group,
  collapsed,
  searchActive,
  first = false,
  onToggle,
  onRefresh,
  onGrantPermission,
  onRemove,
}: AssetLibrarySectionProps) {
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const panelId = `rv-assets-section-${group.groupKey}`;
  const headerId = `${panelId}-header`;

  // "3 of 48" while filtering; a plain total otherwise. The unfiltered number
  // is what tells the user the section has more in it than the search shows.
  const count = searchActive && group.cards.length !== group.totalCount
    ? `${group.cards.length} of ${group.totalCount}`
    : String(group.totalCount);

  // One amber warning slot: at most one of these is ever true, and each is
  // told apart by its icon and its words, never by its colour alone.
  const warning = group.needsPermission
    ? { icon: <LockOutlined sx={{ fontSize: 13 }} />, text: 'Access expired', title: 'The browser dropped read permission for this folder' }
    : group.error
      ? { icon: <WarningAmber sx={{ fontSize: 13 }} />, text: 'Failed to load', title: group.error }
      : null;

  return (
    <Box
      component="section"
      sx={{
        pt: first ? 0 : 1.5,
        mt: first ? 0 : 1.5,
        borderTop: first ? 'none' : '1px solid',
        borderColor: 'rgba(255,255,255,0.08)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
        <Box
          component="button"
          type="button"
          id={headerId}
          aria-expanded={!collapsed}
          aria-controls={panelId}
          onClick={onToggle}
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 0.5,
            py: 0.5,
            background: 'none',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            color: 'text.primary',
            textAlign: 'left',
            font: 'inherit',
            '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
            '&:active': { bgcolor: 'rgba(255,255,255,0.07)' },
            // DESIGN.md: a visible focus ring, never removed. Inset so it
            // cannot be clipped by the scroll container.
            '&:focus-visible': {
              outline: '1px solid',
              outlineColor: 'primary.main',
              outlineOffset: '-1px',
            },
          }}
        >
          <ExpandMore
            sx={{
              fontSize: 16,
              flexShrink: 0,
              color: 'text.secondary',
              transform: collapsed ? 'rotate(-90deg)' : 'none',
              transition: CHEVRON_MOTION,
              '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
            }}
          />

          {/* Title role — this is a section header inside a panel. */}
          <Typography
            component="span"
            sx={{
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {group.label}
          </Typography>

          {/* Label role. `writable` rides in the tooltip: as a separate word in
              the row it was pure noise, and the kind already implies it. */}
          <Tooltip title={group.writable ? `${KIND_LABEL[group.kind]} · writable` : KIND_LABEL[group.kind]}>
            <Chip
              label={KIND_LABEL[group.kind]}
              size="small"
              variant="outlined"
              sx={{
                flexShrink: 0,
                height: 18,
                borderRadius: CHIP_RADIUS,
                borderColor: 'rgba(255,255,255,0.14)',
                color: 'text.secondary',
                '& .MuiChip-label': {
                  px: 0.75,
                  fontSize: 11,
                  fontWeight: 500,
                  lineHeight: 1.3,
                },
              }}
            />
          </Tooltip>

          <Box sx={{ flex: 1, minWidth: 8 }} />

          {warning && (
            <Tooltip title={warning.title}>
              <Box
                component="span"
                sx={{
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.5,
                  color: 'warning.main',
                }}
              >
                {warning.icon}
                <Typography component="span" sx={{ fontSize: 11, fontWeight: 500, lineHeight: 1.3 }}>
                  {warning.text}
                </Typography>
              </Box>
            </Tooltip>
          )}

          {/* Data role — a count is a value the user compares across sections. */}
          <Typography
            component="span"
            sx={{
              flexShrink: 0,
              fontFamily: 'monospace',
              fontSize: 11,
              lineHeight: 1.3,
              color: 'text.secondary',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {count}
          </Typography>
        </Box>

        {group.needsPermission && onGrantPermission && (
          <Tooltip title="Grant read access again">
            <IconButton size="small" onClick={onGrantPermission} aria-label="Grant access">
              <FolderOpen sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        )}
        {group.refreshable && onRefresh && (
          <Tooltip title="Refresh this library">
            <IconButton size="small" onClick={onRefresh} aria-label="Refresh library">
              <Refresh sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
        )}
        {group.removable && onRemove && (
          <>
            <IconButton
              size="small"
              onClick={(e) => setMenuAnchor(e.currentTarget)}
              aria-label={`Library actions for ${group.label}`}
            >
              <MoreVert sx={{ fontSize: 15 }} />
            </IconButton>
            <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
              <MenuItem
                onClick={() => { setMenuAnchor(null); onRemove(); }}
                sx={{ fontSize: 13 }}
              >
                <ListItemIcon sx={{ minWidth: 26 }}><Delete sx={{ fontSize: 16 }} /></ListItemIcon>
                Remove library
              </MenuItem>
            </Menu>
          </>
        )}
      </Box>

      {!collapsed && (
        <Box id={panelId} role="region" aria-labelledby={headerId} sx={{ pt: 1 }}>
          {group.cards.length === 0 ? (
            // Indented to the title, not the chevron, so the empty line reads
            // as belonging to this library.
            <Typography sx={{ fontSize: 13, color: 'text.secondary', pl: 3, pb: 0.5 }}>
              {group.needsPermission
                ? 'Grant read access to list this folder.'
                : group.error
                  ? 'This library could not be loaded.'
                  : group.loaded
                    ? 'This library is empty.'
                    : 'Loading…'}
            </Typography>
          ) : (
            <Box
              sx={{
                display: 'grid',
                // Same track sizing and gap as the Models/Scenes grids, so a
                // section reads as the same surface, only labelled.
                gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH_PX.comfortable}px, 1fr))`,
                gap: 1.25,
              }}
            >
              {group.cards.map(c => (
                <ProjectCard key={c.key} card={c} />
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

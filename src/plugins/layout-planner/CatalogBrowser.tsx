// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CatalogBrowser — shared presentational shell for a single Library tab.
 *
 * Renders the common chrome every catalog source now uses: an optional header
 * row (icon + count/title + actions), a search field, a collection/category
 * chip row, and a responsive flat grid of cards (supplied as children). The
 * Local Folder, remote URL / GitHub, and (private) Asset Manager tabs all wrap
 * their cards in this component so the library window looks identical
 * regardless of where the assets come from.
 *
 * Purely presentational: it owns no data and no filtering. Callers derive chips
 * with `deriveChips`, filter with `filterByChip`, and pass the already-filtered
 * cards as `children`.
 */

import type { ReactNode } from 'react';
import { Box, Typography, TextField, Chip, Tooltip, IconButton, InputAdornment } from '@mui/material';
import { Search } from '@mui/icons-material';
import { RV_SCROLL_CLASS, filterChipSx } from '../../core/hmi/shared-sx';
import type { LibraryChip } from '../../core/library/library-chips';

export interface CatalogBrowserAction {
  key: string;
  title: string;
  icon: ReactNode;
  onClick: () => void;
  /** Optional colour override for the icon (e.g. destructive remove). */
  color?: string;
}

/**
 * How dense the card grid is (plan-372 Phase 6).
 *
 * `compact` is the planner's narrow left panel; `comfortable` is the Projects
 * dashboard, which has the full viewport width and can afford readable cards.
 * The variant is the *only* thing that decides column width — there is exactly
 * one grid definition in the codebase and it lives below, so a second browser
 * can never drift out of alignment with the first.
 */
export type CatalogBrowserVariant = 'compact' | 'comfortable';

/** Minimum card width per variant. Single source of truth for the grid. */
export const CARD_MIN_WIDTH_PX: Record<CatalogBrowserVariant, number> = {
  compact: 72,
  comfortable: 148,
};

export interface CatalogBrowserProps {
  /** Grid density. Defaults to `compact` (the planner panel's historical look). */
  variant?: CatalogBrowserVariant;

  /** Leading header icon (e.g. folder / cloud). Omit for plain catalogs. */
  headerIcon?: ReactNode;
  /** Header text — typically "<n> assets — <name>". Omit to hide the header. */
  headerText?: ReactNode;
  /** Header action buttons (refresh, remove, …). */
  headerActions?: CatalogBrowserAction[];

  searchText: string;
  onSearchChange: (text: string) => void;
  searchPlaceholder?: string;

  /** Chips to show. When empty, the chip row (incl. the "All" chip) is hidden. */
  chips: LibraryChip[];
  /** Count behind the "All" chip — the unfiltered total for this tab. */
  totalCount: number;
  selectedChip: string | null;
  onSelectChip: (key: string | null) => void;

  /** When true, `emptyContent` is shown instead of the card grid. */
  empty?: boolean;
  emptyContent?: ReactNode;

  /** The already-filtered card elements. */
  children: ReactNode;
}

// Matches the Hierarchy browser's search field exactly (rv-hierarchy-browser.tsx).
// pl tightens the icon's left inset (default 14px); the adornment's mr tightens
// the gap to the text (default 8px) — see startAdornment below.
const SEARCH_INPUT_SX = { fontSize: 12, height: 26, pl: 1.25 } as const;
const SEARCH_ROOT_SX = {
  '& .MuiOutlinedInput-root': {
    bgcolor: 'rgba(255, 255, 255, 0.04)',
    '& fieldset': { borderColor: 'rgba(255, 255, 255, 0.08)' },
    '&:hover fieldset': { borderColor: 'rgba(255, 255, 255, 0.15)' },
    '&.Mui-focused fieldset': { borderColor: 'primary.main' },
  },
} as const;

export function CatalogBrowser({
  variant = 'compact',
  headerIcon,
  headerText,
  headerActions,
  searchText,
  onSearchChange,
  searchPlaceholder = 'Search...',
  chips,
  totalCount,
  selectedChip,
  onSelectChip,
  empty,
  emptyContent,
  children,
}: CatalogBrowserProps) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Header */}
      {(headerText !== undefined || headerIcon || (headerActions?.length ?? 0) > 0) && (
        <Box sx={{ px: 0.75, py: 0.5, display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
          {headerIcon}
          <Typography
            variant="caption"
            sx={{
              fontSize: 10,
              color: 'text.secondary',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {headerText}
          </Typography>
          {headerActions?.map((a) => (
            <Tooltip key={a.key} title={a.title}>
              <IconButton size="small" onClick={a.onClick} sx={{ p: 0.25, color: a.color }}>
                {a.icon}
              </IconButton>
            </Tooltip>
          ))}
        </Box>
      )}

      {/* Chip row first — same look as the Hierarchy type-filter chips
          (filterChipSx) incl. the borderBottom separator line. The search bar
          sits below this line. */}
      {chips.length > 0 && (
        <Box sx={{ px: 0.75, py: 0.5, display: 'flex', flexWrap: 'wrap', gap: 0.25, borderBottom: '1px solid rgba(255, 255, 255, 0.05)', flexShrink: 0 }}>
          <Chip
            label={`All (${totalCount})`}
            size="small"
            onClick={() => onSelectChip(null)}
            sx={filterChipSx(selectedChip === null)}
          />
          {chips.map((chip) => (
            <Chip
              key={chip.key}
              label={`${chip.label} (${chip.count})`}
              size="small"
              onClick={() => onSelectChip(selectedChip === chip.key ? null : chip.key)}
              sx={filterChipSx(selectedChip === chip.key)}
            />
          ))}
        </Box>
      )}

      {/* Search — sits under the chip-row separator line. */}
      <Box sx={{ px: 0.75, py: 0.5, borderBottom: '1px solid rgba(255, 255, 255, 0.05)', flexShrink: 0 }}>
        <TextField
          size="small"
          fullWidth
          placeholder={searchPlaceholder}
          value={searchText}
          onChange={(e) => onSearchChange(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start" sx={{ mr: 0.5 }}>
                  <Search sx={{ fontSize: 16, color: 'text.disabled' }} />
                </InputAdornment>
              ),
              sx: SEARCH_INPUT_SX,
            },
          }}
          sx={SEARCH_ROOT_SX}
        />
      </Box>

      {/* Card grid (or empty content). pt gives a margin between the chip-row
          separator line and the first card row. */}
      <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, pt: 1, pb: 1 }}>
        {empty ? (
          emptyContent
        ) : (
          <Box
            sx={{
              px: 0.75,
              display: 'grid',
              gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH_PX[variant]}px, 1fr))`,
              gap: 0.75,
            }}
          >
            {children}
          </Box>
        )}
      </Box>
    </Box>
  );
}

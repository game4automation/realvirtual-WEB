// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalBrowser — sort toolbar for the Signals view of the Hierarchy Browser.
 *
 * Renders the small "A–Z / In / Out" chip row that appears only when the
 * type filter is set to `signals`. Kept as a stand-alone component so the
 * Signals-specific UI is self-contained and easy to extend with future
 * signal-only controls (e.g. group-by-PLC, filter-by-bool, etc.).
 *
 * Extracted from `rv-hierarchy-browser.tsx` (plan-177 Phase 5).
 */

import { Box, Chip } from '@mui/material';
import { filterChipSx } from './shared-sx';
import type { SignalSort } from './hierarchy-utils';

const SIGNAL_SORTS: ReadonlyArray<readonly [SignalSort, string]> = [
  ['name', 'A–Z'],
  ['type', 'In / Out'],
];

export interface SignalBrowserProps {
  /** Current sort mode. */
  sort: SignalSort;
  /** Sort change callback. */
  onSortChange: (sort: SignalSort) => void;
}

/** Toolbar shown above the flat signals list, lets the user toggle sort order. */
export function SignalBrowser({ sort, onSortChange }: SignalBrowserProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        gap: 0.25,
        px: 0.75,
        py: 0.25,
        borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
        flexShrink: 0,
        alignItems: 'center',
      }}
    >
      {SIGNAL_SORTS.map(([key, label]) => (
        <Chip
          key={key}
          label={label}
          size="small"
          onClick={() => onSortChange(key)}
          sx={filterChipSx(sort === key)}
        />
      ))}
    </Box>
  );
}

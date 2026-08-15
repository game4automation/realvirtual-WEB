// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DirtyDot — the one way the product says "there is unsaved work here".
 *
 * Before this module the same statement was made five different ways: a 9px
 * `#ff9800` circle plus an "UNSAVED" caption on the scene card, a 7px
 * `warning.main` circle on the asset card, a `#ffb74d` marker in the script
 * editor, and a bare `' •'` glued to the label in the document-stack
 * breadcrumb. Four of those hardcoded a colour that the theme already owns, and
 * the fifth was not a dot at all. A user who learns the mark in one panel should
 * recognise it in the next, which is the whole reason to have a mark.
 *
 * The ink is `warning.main` — the theme token, never a literal. Amber and not
 * the accent because unsaved work is a state to notice, not a control to use,
 * and Instrument Blue is reserved for the latter (DESIGN.md).
 *
 * Two sizes, and the reason they differ: inline next to a name the dot rides in
 * the text and takes 7px; over an ActivityBar icon it is a badge in the corner
 * of a 6px grid, matching the ambient project dot it has to sit beside without
 * looking like a second kind of thing.
 */

import { Box } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';

/** What every dirty mark in the product is tinted with. */
export const DIRTY_INK = 'warning.main';

export interface DirtyDotProps {
  /** Diameter in px. 7 inline (default), 6 as an icon badge. */
  size?: number;
  /** Hover text. Overridden where the surface can say something more precise. */
  title?: string;
  /** Extra positioning — the badge variants pass `position: 'absolute'` here. */
  sx?: SxProps<Theme>;
}

export function DirtyDot({ size = 7, title = 'Unsaved changes', sx }: DirtyDotProps) {
  return (
    <Box
      component="span"
      data-testid="dirty-dot"
      aria-label={title}
      title={title}
      sx={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        bgcolor: DIRTY_INK,
        verticalAlign: 'middle',
        flexShrink: 0,
        ...sx,
      }}
    />
  );
}

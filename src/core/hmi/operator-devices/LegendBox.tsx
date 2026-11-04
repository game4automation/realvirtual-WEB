// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * LegendBox — the legend plate under an operator device (plan-542 F11): the
 * full width of its grid cell, a FIXED number of lines high, text centred.
 * Every device in a row therefore puts its legend on the same baseline, centred
 * under its own centre, whatever the legend's length.
 *
 * `marker` draws the lamp dot to the left of the text — absolutely positioned,
 * so a lit lamp never shifts the legend. `tone` colours the text (the red
 * "PRESSED" of an E-stop).
 */

import type { ReactNode } from 'react';
import { Box } from '@mui/material';
import { FS, INK_HIGH } from '../shared-sx';

/** Legend line height in px (11 px type × 1.25). */
export const LEGEND_LINE = 14;

/** Legend line height on a plate packed `compact` (10 px type × 1.2). */
export const LEGEND_LINE_COMPACT = 12;

export function LegendBox({ children, lines = 1, marker, tone, compact }: {
  children: ReactNode;
  lines?: number;
  marker?: string;
  tone?: string;
  /** One line less tall and a size smaller, for a `compact` plate (plan-659). */
  compact?: boolean;
}) {
  const line = compact ? LEGEND_LINE_COMPACT : LEGEND_LINE;
  return (
    <Box
      component="span"
      data-part="legend"
      sx={{
        width: '100%',
        height: lines * line,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        fontSize: compact ? FS.micro : FS.label,
        fontWeight: 500,
        lineHeight: `${line}px`,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        textAlign: 'center',
        textWrap: 'balance',
        // Visible: the lamp dot hangs outside the text to the left.
        overflow: 'visible',
        color: tone ?? INK_HIGH,
      }}
    >
      <Box component="span" data-part="legend-text" sx={{ position: 'relative' }}>
        {marker && (
          // A zero-width anchor at the start of the FIRST line (glued to the
          // first word by a word joiner): the dot hangs left of that line, so a
          // two-line legend keeps it inside its cell instead of in the column
          // gap (plan-543), and a lit lamp still never shifts the text.
          <Box
            component="span"
            aria-hidden
            data-part="lamp-anchor"
            sx={{ display: 'inline-block', position: 'relative', width: 0, height: line, verticalAlign: 'top' }}
          >
            <svg
              data-part="lamp-dot"
              aria-hidden
              width="6"
              height="6"
              viewBox="0 0 6 6"
              style={{ position: 'absolute', right: 4, top: 4 }}
            >
              <circle cx="3" cy="3" r="3" fill={marker} />
            </svg>
          </Box>
        )}
        {marker && '⁠'}
        {children}
      </Box>
    </Box>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * KeyLegend — the engraved legend card of an operator panel (plan-659): which
 * KEYS operate the machine, and what each one does.
 *
 * Why a panel needs one. Every other device here answers a question the
 * operator already has ("is it running?", "how fast?"). A keyboard binding
 * answers one he cannot even ask: nothing on the plate hints that W walks the
 * robot away from the camera. The status strip was carrying `WASD · SPACE · R`
 * as a reminder, which is a reminder for someone who already knows — the first
 * person to meet the plate had to ask how to drive it.
 *
 * So it is a LEGEND, not help: the same thing the printed card under a real
 * control box is. Always visible, never a dialog, nothing to open or dismiss —
 * an operator reads it once and stops seeing it. It has no signals and no
 * state; it is text the document carries, so a panel that is operated by
 * pointer alone simply omits it.
 *
 * Two shapes on purpose:
 *
 *   * the ROWS are keys and effects, and the key cell is a monospace cap, so
 *     "W / S" reads as two keys rather than as a word. A `/` in the authored
 *     key text splits the caps — the author writes `"W / S"`, not markup.
 *   * the NOTE is one line of prose for what a key/effect table cannot say
 *     (that the keys are held, that a dial and not a key sets the speed).
 */

import { Box } from '@mui/material';
import { FS, INK_LOW, INK_MID, MONO } from '../shared-sx';

export interface KeyLegendRow {
  /** The keys, e.g. `"W / S"`. A `/` draws each key as its own cap. */
  key: string;
  /** What they do, e.g. `"Away from / toward the camera"`. */
  text: string;
}

export interface KeyLegendProps {
  /** Heading of the card, e.g. "Keyboard — hold". Optional. */
  title?: string;
  rows: readonly KeyLegendRow[];
  /** One line of prose under the rows. Optional. */
  note?: string;
  /** Tighter type and leading, for a plate packed `compact`. */
  compact?: boolean;
}

/** `"W / S"` → `['W', 'S']`; a single key stays a one-element list. */
function caps(key: string): string[] {
  return key.split('/').map((k) => k.trim()).filter((k) => k.length > 0);
}

export function KeyLegend({ title, rows, note, compact }: KeyLegendProps) {
  const size = compact ? FS.micro : FS.label;
  return (
    <Box
      data-part="key-legend"
      role="group"
      aria-label={title ?? 'Keyboard'}
      sx={{
        // A hairline above, and the card sits on the plate — the same
        // separation the printed legend card has from the devices.
        borderTop: '1px solid rgba(255,255,255,0.08)',
        pt: compact ? 0.5 : 0.75,
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 0.25 : 0.5,
      }}
    >
      {title && (
        <Box
          component="span"
          data-part="key-legend-title"
          sx={{
            fontSize: FS.micro, fontWeight: 600, letterSpacing: '0.04em',
            textTransform: 'uppercase', color: INK_LOW, lineHeight: 1.3,
          }}
        >
          {title}
        </Box>
      )}
      <Box
        component="dl"
        sx={{
          m: 0,
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr)',
          columnGap: 0.75,
          rowGap: compact ? 0.25 : 0.5,
          alignItems: 'baseline',
        }}
      >
        {/* dt / dd land in the two columns by themselves — no row wrapper, so
            every key cap and every effect share one baseline grid. */}
        {rows.map((row) => [
          <Box
            key={`${row.key}-keys`}
            component="dt"
            data-part="key-legend-row"
            sx={{ m: 0, display: 'flex', alignItems: 'center', gap: 0.25 }}
          >
            {caps(row.key).map((cap, i) => (
              <Box key={cap} component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
                {i > 0 && (
                  <Box component="span" aria-hidden sx={{ fontSize: FS.micro, color: INK_LOW }}>/</Box>
                )}
                <Box
                  component="span"
                  data-part="key-cap"
                  sx={{
                    fontFamily: MONO,
                    fontSize: FS.micro,
                    fontWeight: 600,
                    lineHeight: 1.4,
                    color: INK_MID,
                    px: 0.4,
                    // The cap: inset and outlined, like the key it names.
                    bgcolor: 'rgba(0,0,0,0.35)',
                    border: '1px solid rgba(255,255,255,0.14)',
                    borderRadius: '2px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cap}
                </Box>
              </Box>
            ))}
          </Box>,
          <Box
            key={`${row.key}-text`}
            component="dd"
            data-part="key-legend-text"
            sx={{ m: 0, fontSize: size, lineHeight: 1.35, color: INK_MID, minWidth: 0 }}
          >
            {row.text}
          </Box>,
        ])}
      </Box>
      {note && (
        <Box
          component="span"
          data-part="key-legend-note"
          sx={{ fontSize: FS.micro, lineHeight: 1.35, color: INK_LOW, textWrap: 'pretty' }}
        >
          {note}
        </Box>
      )}
    </Box>
  );
}

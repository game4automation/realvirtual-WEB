// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentModeChip — the mode a click on a document row will open it in
 * (plan-513 F10).
 *
 * Extracted from the recents row (plan-478), where it was born, so that every
 * surface that lists documents — recents, the model search, the cards — says
 * the same thing in the same shape. The mode it shows is the caller's
 * `effectiveOpenMode` answer, i.e. exactly what the open chain will do; the
 * chip never invents a mode of its own.
 *
 * Renders NOTHING for a mode this build does not register (`modeLabel`
 * answers undefined) and for no mode at all: a chip naming a mode the user
 * cannot be put into would promise something the chain deliberately does not
 * do, and a row with no target says so by having no chip.
 */

import { Box, type SxProps, type Theme } from '@mui/material';
import { CHIP_RADIUS } from '../shared-sx';

export interface DocumentModeChipProps {
  /** The mode the row opens in, or null/undefined when it names none. */
  mode: string | null | undefined;
  /** `viewer.modes.descriptor(id)?.label` — undefined for a mode this build lacks. */
  modeLabel(mode: string): string | undefined;
  /** `data-testid` of the chip element. */
  testId?: string;
  /** Placement extras (margins, absolute position) — never the chip's own look. */
  sx?: SxProps<Theme>;
}

export function DocumentModeChip({ mode, modeLabel, testId, sx }: DocumentModeChipProps) {
  const label = mode ? modeLabel(mode) : undefined;
  if (!label) return null;
  return (
    <Box
      data-testid={testId}
      data-mode={mode}
      sx={[
        {
          flexShrink: 0, px: 0.75, py: 0.25,
          borderRadius: CHIP_RADIUS,
          border: '1px solid rgba(255,255,255,0.14)',
          fontSize: 10, letterSpacing: 0.4, color: 'text.secondary',
          whiteSpace: 'nowrap',
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {label}
    </Box>
  );
}

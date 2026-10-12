// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * MappedBadge — the `mapped / total` chip of a signal report (plan-589 §2.2).
 *
 * It was the auto-map strip's own block (`ConnectAutoMapSection`, plan-545) until the reconcile
 * report arrived and a second surface needed the same chip. Two copies of "green when nothing
 * needs attention, amber when something does" is exactly the drift that makes a badge
 * untrustworthy — so the rule lives here, once, and the callers pass numbers.
 *
 * Grey (no colour claim) while there is no report: an interface nobody has reconciled yet is not
 * "0 of 0 fine".
 */

import { Chip, Tooltip } from '@mui/material';
import { ISA_AMBER, ISA_GREEN } from './isa-colors';

export interface MappedBadgeProps {
  /** Couplings that are complete. */
  mapped: number;
  /** All rows of the report (couplings plus everything that is not one). */
  total: number;
  /** Rows that need a human: the warning categories. */
  problems: number;
  /** False while no report exists — the badge then stays neutral. */
  hasReport?: boolean;
  /** What the numbers are about, e.g. `'model PLC signals'`. */
  subject?: string;
  'data-testid'?: string;
}

export function MappedBadge({
  mapped, total, problems, hasReport = true, subject = 'signals',
  'data-testid': testId = 'mapped-badge',
}: MappedBadgeProps) {
  const color = !hasReport ? 'rgba(255,255,255,0.6)' : problems > 0 ? ISA_AMBER : ISA_GREEN;
  const title = `${mapped} of ${total} ${subject} mapped`
    + (problems > 0 ? ` · ${problems} need attention` : '');
  return (
    <Tooltip title={title}>
      <Chip
        size="small"
        data-testid={testId}
        label={`${mapped} / ${total}`}
        sx={{
          height: 16, fontSize: 10, fontFamily: 'monospace', color,
          border: `1px solid ${color}`, bgcolor: 'transparent',
        }}
      />
    </Tooltip>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentCrumbs — the breadcrumb chip row, once (plan-709 §2.1, phase 3).
 *
 * Extracted from `DocumentStackBar.tsx` so the floating stack bar and the
 * document card render the SAME chips instead of two spellings of one idiom.
 * The row itself is the house form (`MobileSelectionSheet.tsx:98-118`):
 * horizontally scrollable, chevron separators, 11px secondary ink, the current
 * leaf in high ink at weight 600, a stale frame in italic.
 *
 * It lives beside the card rather than in `core/ops/` because it is presentation
 * — `core/ops` is the renderer-free op layer and a `.tsx` there would be the
 * first exception to that.
 *
 * Clicking a chip is navigation, not a jump: the handler is the stack bar's own
 * Back (one frame at a time, §2.7.3 of plan-703). A row without `onCrumbClick`
 * renders plain text, which is what the single-chip scene case needs.
 */

import { Box, Typography } from '@mui/material';
import { ChevronRight } from '@mui/icons-material';
import type { RvStackCrumb } from '../../ops/rv-document-stack';
import { RV_SCROLL_CLASS } from '../shared-sx';
import { DirtyDot } from '../rv-dirty-dot';

export interface DocumentCrumbsProps {
  crumbs: RvStackCrumb[];
  /**
   * Storage location, rendered as dimmed segments in FRONT of the chain.
   *
   * The chain alone says which document and how deep the descend went, never
   * where the thing lives — so a card showed a bare leaf name and the user had
   * to remember the rest. These segments are location and not navigation: they
   * stay plain text even when the chain behind them is clickable.
   */
  location?: string[];
  /** Called for a chip that is not the current one. Absent = plain text. */
  onCrumbClick?: (crumb: RvStackCrumb) => void;
  /** `data-testid` stem; the current chip gets `-current`. */
  testIdPrefix?: string;
  /** Chip font size in px. 11 in the stack bar, 10 in the compact card. */
  fontSize?: number;
  ariaLabel?: string;
}

export function DocumentCrumbs({
  crumbs,
  location,
  onCrumbClick,
  testIdPrefix = 'stack-crumb',
  fontSize = 11,
  ariaLabel = 'Document stack',
}: DocumentCrumbsProps) {
  return (
    <Box
      className={RV_SCROLL_CLASS}
      aria-label={ariaLabel}
      sx={{
        flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 0.25,
        overflowX: 'auto', whiteSpace: 'nowrap',
      }}
    >
      {(location ?? []).map((segment, i) => (
        <Box
          key={`loc:${i}:${segment}`}
          sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
        >
          <Typography
            data-testid="document-location-crumb"
            component="span"
            sx={{ fontSize, fontWeight: 400, color: 'text.disabled' }}
          >
            {segment}
          </Typography>
          <ChevronRight sx={{ fontSize: 14, color: 'text.disabled' }} />
        </Box>
      ))}
      {crumbs.map((c) => {
        const clickable = !!onCrumbClick && !c.current;
        return (
          <Box
            key={`${c.index}:${c.occurrence}`}
            sx={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
          >
            <Typography
              data-testid={c.current ? `${testIdPrefix}-current` : testIdPrefix}
              component={clickable ? 'button' : 'span'}
              onClick={clickable ? () => onCrumbClick!(c) : undefined}
              sx={{
                fontSize,
                fontWeight: c.current ? 600 : 400,
                color: c.current ? 'text.primary' : 'text.secondary',
                fontStyle: c.stale ? 'italic' : 'normal',
                ...(clickable
                  ? {
                      // A button that has to read as a breadcrumb: the element
                      // is a real button for the keyboard, and nothing else.
                      background: 'none', border: 0, p: 0, m: 0,
                      font: 'inherit', cursor: 'pointer',
                      '&:hover': { color: 'text.primary' },
                    }
                  : {}),
              }}
            >
              {c.label}
              {c.dirty && (
                <DirtyDot size={6} sx={{ ml: 0.5 }} title={`${c.label} has unsaved changes`} />
              )}
            </Typography>
            {!c.current && <ChevronRight sx={{ fontSize: 14, color: 'text.disabled' }} />}
          </Box>
        );
      })}
    </Box>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-inspector-row.tsx — the single shared layout primitive for Property
 * Inspector rows.
 *
 * Every `label → field` row (editable field, read-only live value, transform
 * vector, nested sub-field) routes through `InspectorRow` so the columns line
 * up identically across the whole inspector. The layout is a CSS Grid — grid
 * guarantees the field column starts/ends at the same x on every row, which
 * flex `minWidth/maxWidth` cannot promise once label lengths vary.
 *
 * Scalar row (4 tracks):
 *   [dot gutter] [label ≤40%] [flexible gap] [field ≤50%, right-anchored]
 * Full-width row (`fullWidthField`, 3 tracks) — for composite editors that
 * cannot fit 40% (Vector3, editable object expander):
 *   [dot gutter] [label ≤40%] [field fills the rest]
 */

import { Box, Typography, Tooltip } from '@mui/material';
import type { ReactNode } from 'react';
import {
  INSPECTOR_DOT_GUTTER,
  INSPECTOR_LABEL_MAX,
  INSPECTOR_FIELD_MAX,
  INSPECTOR_FIELD_MIN,
  INSPECTOR_ROW_GAP,
} from './layout-constants';

export interface InspectorRowProps {
  /** Field name / label node (left column). */
  label: ReactNode;
  /** Native title (tooltip / a11y) for the truncated label. */
  labelTitle?: string;
  /** MUI color token or hex for the label text. Default `text.primary`. */
  labelColor?: string;
  /** Field-cell content (editor, chip, or read-only value). */
  children: ReactNode;
  /** Override / status dot for the leading gutter. Omit → empty gutter. */
  dot?: ReactNode;
  /** Composite fields (Vector3, object expander) opt out of the 40% field cap. */
  fullWidthField?: boolean;
  /** Field-cell main-axis alignment. `end` for toggles/chips; default `stretch`. */
  alignField?: 'end' | 'stretch';
  /** Optional element pinned to the right of the field cell (e.g. a reset button). */
  trailing?: ReactNode;
  /** Row opacity (dim ignored/disabled fields). Default 1. */
  opacity?: number;
  /** Min row height. Default 20 to match the hierarchy row height. */
  minHeight?: number;
  /** Vertical padding (MUI spacing units). Default 0. */
  py?: number;
  /** Wrap the row in a left-placed MUI Tooltip when set. */
  rowTooltip?: string;
  /** Tighter typography for nested sub-field rows. */
  dense?: boolean;
}

export function InspectorRow({
  label,
  labelTitle,
  labelColor = 'text.primary',
  children,
  dot,
  fullWidthField = false,
  alignField = 'stretch',
  trailing,
  opacity = 1,
  minHeight = 20,
  py = 0,
  rowTooltip,
  dense = false,
}: InspectorRowProps) {
  // Scalar: gutter · label(≤40%) · spacer(1fr) · field(≤50%).
  // Full-width: gutter · label(≤40%) · field(1fr) — field spans the rest.
  const gridTemplateColumns = fullWidthField
    ? `${INSPECTOR_DOT_GUTTER}px minmax(0, ${INSPECTOR_LABEL_MAX}) 1fr`
    : `${INSPECTOR_DOT_GUTTER}px minmax(0, ${INSPECTOR_LABEL_MAX}) 1fr minmax(${INSPECTOR_FIELD_MIN}px, ${INSPECTOR_FIELD_MAX})`;

  const row = (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns,
        columnGap: `${INSPECTOR_ROW_GAP}px`,
        alignItems: 'center',
        px: 1,
        py,
        minHeight,
        opacity,
        '&:hover': { bgcolor: 'rgba(255,255,255,0.02)' },
      }}
    >
      {/* Leading gutter — override / status dot (col 1). */}
      <Box
        sx={{
          gridColumn: 1,
          width: INSPECTOR_DOT_GUTTER,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {dot}
      </Box>

      {/* Label (col 2) — capped at 40%, ellipsis-truncated. `minWidth:0` is
          required inside the minmax(0,…) track or the ellipsis never triggers. */}
      <Typography
        sx={{
          gridColumn: 2,
          fontSize: dense ? 10 : 11,
          color: labelColor,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={labelTitle}
      >
        {label}
      </Typography>

      {/* Field cell — last track (col 4 scalar / col 3 full-width). The 1fr
          spacer track (col 3, scalar) stays empty, pinning the field right. */}
      <Box
        sx={{
          gridColumn: fullWidthField ? 3 : 4,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: trailing ? `${INSPECTOR_ROW_GAP}px` : 0,
          justifyContent: alignField === 'end' ? 'flex-end' : 'stretch',
        }}
      >
        {children}
        {trailing}
      </Box>
    </Box>
  );

  if (!rowTooltip) return row;
  return (
    <Tooltip title={rowTooltip} placement="left" disableHoverListener={!rowTooltip}>
      {row}
    </Tooltip>
  );
}

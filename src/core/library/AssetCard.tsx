// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AssetCard — the one library card (plan-372 Phase 6).
 *
 * Generalised out of the planner's `ThumbnailCard`. The Projects dashboard and
 * the planner panel show the same assets and must look like the same product;
 * two card implementations would drift within a release.
 *
 * ## Presentational only — on purpose
 *
 * Everything behavioural stays with the caller: drag payload, hover-intent
 * prefetch, the context menu, and the preview request itself. The card takes
 * DOM handlers as props and spreads them onto its root. That is what let the
 * planner's drag behaviour move here *unchanged* rather than be reimplemented
 * — the handlers are the same functions, just passed in.
 *
 * ## Variants
 *
 * `compact` reproduces the planner's narrow left panel pixel for pixel (72px
 * columns, 9px label). `comfortable` is the dashboard's wider grid. Both share
 * this component so a change to the visual language lands in both at once.
 */

import { forwardRef, type ReactNode } from 'react';
import { Box, Typography, Tooltip } from '@mui/material';
import {
  TimerOutlined, Landscape, MenuBookOutlined, PrecisionManufacturingOutlined,
  SettingsEthernet,
} from '@mui/icons-material';
import type { LibraryCatalogEntry } from './library-types';

/** Matches `CatalogBrowserVariant`; kept structural to avoid a circular import. */
export type AssetCardVariant = 'compact' | 'comfortable';

/**
 * Which layer of the two-level model an entry came from (§2.3).
 *
 * `bundled` entries ship with a delivered build and cannot be edited in place;
 * the badge is what tells a user why an action is unavailable before they try
 * it. `user` entries are the normal, writable case and carry no badge.
 */
export type AssetTier = 'bundled' | 'user';

export interface AssetCardProps {
  entry: LibraryCatalogEntry;
  variant?: AssetCardVariant;
  /** Shows a small badge when `'bundled'`. Omit or `'user'` for no badge. */
  tier?: AssetTier;
  /** Highlights the card as the active placement target. */
  selected?: boolean;
  /** Cursor hint only — the caller owns the actual drag payload. */
  draggable?: boolean;
  /**
   * Explicit cursor override. The planner needs `crosshair` while a placement
   * is armed, which is a planner concept this component should not know about.
   */
  cursor?: string;
  /** Rendered inside the preview square when the entry has no thumbnail. */
  placeholderAction?: ReactNode;
  /**
   * The asset decoded but holds nothing renderable (a freshly created "New
   * asset"). Renders a stated "Empty" tile instead of a blank preview square —
   * an empty file is a fact, a blank square is a bug report.
   */
  empty?: boolean;
  /**
   * A stated glyph tile for an entry that has no picture BY NATURE — a CONNECT
   * configuration or knowledge file, for instance — rather than one whose
   * picture merely has not arrived. Takes precedence over the thumbnail slot.
   */
  glyph?: 'connect' | 'knowledge';
  /** Tooltip body (usually the component's behaviour description). */
  tooltip?: ReactNode;
  /** Controlled tooltip visibility — suppressed while dragging. */
  tooltipOpen?: boolean;

  onDragStart?: React.DragEventHandler<HTMLDivElement>;
  onDragEnd?: React.DragEventHandler<HTMLDivElement>;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  onDoubleClick?: React.MouseEventHandler<HTMLDivElement>;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
  onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
}

/** Per-variant type scale. The compact column matches the pre-372 planner. */
const SCALE = {
  compact: { label: 9, tag: 7, badge: 7, glyph: 28, glyphLabel: 8 },
  comfortable: { label: 12, tag: 9, badge: 9, glyph: 40, glyphLabel: 10 },
} as const;

const ACCENT = 'rgba(79, 195, 247';   // Instrument Blue (DESIGN.md), alpha appended
const SPLAT = 'rgba(139, 195, 74';
const NEUTRAL = 'rgba(255, 255, 255';
// The reference-file type colors (user decision 2026-08-19): CONNECT is green,
// knowledge is realvirtual Magenta — same hues as the hero card's slot wells.
const CONNECT = 'rgba(102, 187, 106';
const KNOWLEDGE = 'rgba(233, 64, 120';

export const AssetCard = forwardRef<HTMLDivElement, AssetCardProps>(function AssetCard(
  {
    entry,
    variant = 'compact',
    tier,
    selected = false,
    draggable = false,
    cursor,
    placeholderAction,
    empty = false,
    glyph,
    tooltip,
    tooltipOpen,
    ...handlers
  },
  ref,
) {
  const s = SCALE[variant];

  const preview = glyph === 'connect' ? (
    <GlyphTile
      accent={CONNECT}
      icon={<SettingsEthernet sx={{ fontSize: s.glyph, color: `${CONNECT}, 0.6)` }} />}
      label="Connect"
      labelSize={s.glyphLabel}
    />
  ) : glyph === 'knowledge' ? (
    <GlyphTile
      accent={KNOWLEDGE}
      icon={<MenuBookOutlined sx={{ fontSize: s.glyph, color: `${KNOWLEDGE}, 0.6)` }} />}
      label="Knowledge"
      labelSize={s.glyphLabel}
    />
  ) : entry.thumbnailUrl ? (
    <Box
      component="img"
      src={entry.thumbnailUrl}
      alt={entry.name}
      sx={{
        width: '100%',
        aspectRatio: '1',
        objectFit: 'cover',
        borderRadius: 0.5,
        bgcolor: 'rgba(255,255,255,0.05)',
      }}
      draggable={false}
    />
  ) : entry.virtual ? (
    <GlyphTile
      accent={ACCENT}
      icon={<TimerOutlined sx={{ fontSize: s.glyph, color: `${ACCENT}, 0.6)` }} />}
      label={entry.desType?.replace('DES', '') ?? 'Virtual'}
      labelSize={s.glyphLabel}
    />
  ) : entry.splatUrl ? (
    <GlyphTile
      accent={SPLAT}
      icon={<Landscape sx={{ fontSize: s.glyph, color: `${SPLAT}, 0.6)` }} />}
      label="Splat"
      labelSize={s.glyphLabel}
    />
  ) : empty ? (
    // Neutral, not accented: an empty asset is a normal state on the way to
    // authored content, not something to advertise.
    <GlyphTile
      accent={NEUTRAL}
      icon={<PrecisionManufacturingOutlined sx={{ fontSize: s.glyph, color: `${NEUTRAL}, 0.45)` }} />}
      label="Empty"
      labelSize={s.glyphLabel}
    />
  ) : (
    <Box
      sx={{
        width: '100%',
        aspectRatio: '1',
        borderRadius: 0.5,
        bgcolor: 'rgba(255,255,255,0.05)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}
    >
      {placeholderAction}
    </Box>
  );

  // A clickable card is a real control: focusable, activatable with Enter or
  // Space. Selection gates the detail pane — "the accessible route" — so a
  // pointer-only card would lock keyboard users out of every asset verb.
  const clickable = typeof handlers.onClick === 'function';

  const card = (
    <Box
      ref={ref}
      draggable={draggable}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable
        ? (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handlers.onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>);
            }
          }
        : undefined}
      {...handlers}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.25,
        p: 0.5,
        borderRadius: 1,
        cursor: cursor ?? (draggable ? 'grab' : 'pointer'),
        bgcolor: selected ? `${ACCENT}, 0.15)` : 'rgba(255,255,255,0.03)',
        border: selected ? `1px solid ${ACCENT}, 0.5)` : '1px solid rgba(255,255,255,0.06)',
        '&:hover': { bgcolor: `${ACCENT}, 0.08)`, borderColor: `${ACCENT}, 0.2)` },
        // DESIGN.md: a visible focus ring, never removed. Inset so the grid's
        // scroll container cannot clip it.
        '&:focus-visible': {
          outline: `1px solid ${ACCENT}, 1)`,
          outlineOffset: '-1px',
        },
        transition: 'all 0.15s',
        userSelect: 'none',
        // Skip layout/paint for cards outside the viewport (plan-372 §2.8).
        // The intrinsic size must be a real estimate per variant: too small and
        // the scrollbar jumps as cards render in, which is worse than not
        // containing at all.
        contentVisibility: 'auto',
        containIntrinsicSize: variant === 'comfortable' ? '180px 200px' : '92px 108px',
      }}
    >
      {preview}

      {tier === 'bundled' && (
        <Typography
          component="span"
          title="Ships with this build — edits are saved as your own copy"
          sx={{
            position: 'absolute',
            top: 4,
            right: 4,
            fontSize: s.badge,
            lineHeight: 1.2,
            px: 0.5,
            py: 0.125,
            borderRadius: 0.5,
            bgcolor: 'rgba(0,0,0,0.55)',
            color: 'rgba(255,255,255,0.7)',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            pointerEvents: 'none',
          }}
        >
          Bundled
        </Typography>
      )}

      <Typography
        sx={{
          fontSize: s.label,
          color: 'text.secondary',
          textAlign: 'center',
          lineHeight: 1.2,
          maxWidth: '100%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.name}
      </Typography>

      {entry.tags && entry.tags.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.25, justifyContent: 'center', mt: 0.125 }}>
          {entry.tags.map(tag => (
            <Typography
              key={tag}
              component="span"
              sx={{
                fontSize: s.tag,
                lineHeight: 1.2,
                px: 0.5,
                py: 0.125,
                borderRadius: 0.5,
                bgcolor: `${ACCENT}, 0.1)`,
                color: `${ACCENT}, 0.7)`,
                whiteSpace: 'nowrap',
              }}
            >
              {tag}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );

  if (!tooltip) return card;
  return (
    <Tooltip title={tooltip} open={tooltipOpen} placement="right" arrow disableInteractive>
      {card}
    </Tooltip>
  );
});

/** Dashed placeholder tile for entries that have no GLB to render. */
function GlyphTile({ accent, icon, label, labelSize }: {
  accent: string; icon: ReactNode; label: string; labelSize: number;
}) {
  return (
    <Box
      sx={{
        width: '100%',
        aspectRatio: '1',
        borderRadius: 0.5,
        bgcolor: `${accent}, 0.08)`,
        border: `1px dashed ${accent}, 0.3)`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.5,
      }}
    >
      {icon}
      <Typography sx={{ fontSize: labelSize, color: `${accent}, 0.5)`, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Typography>
    </Box>
  );
}

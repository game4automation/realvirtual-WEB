// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The card a visitor sees after opening a shared link (plan-386 §3.1).
 *
 * ## Presentational only
 *
 * Modelled on `AssetCard`, not on `AssetActiveCard`: the latter is a document
 * controller that owns loading, saving and dirty state, and none of that has a
 * counterpart here. This component receives a finished view model and a set of
 * callbacks and renders them. That is what keeps it testable without a viewer.
 *
 * ## It never disappears entirely
 *
 * Without an `rv_share` block the card shrinks to its label plus filename — it
 * does not vanish, so a visitor always sees that he is looking at a shared
 * model. (The former "loaded from <host>" row was dropped from the display on
 * Thomas' request; `info.originHost` and the trust checks behind it are
 * unchanged.)
 *
 * ## Placement
 *
 * Bottom-left of the 3D viewport region, never on the HMI chrome:
 * - desktop: left of the card = activity bar + any open left-docked window
 *   (`useViewportInsets().left`, handed in as `viewportLeft`) + the floating ButtonPanel column (8 + 46 + 8),
 *   bottom = `BOTTOM_BAR_HEIGHT + 12` — the floor every floating panel keeps
 *   above the search bar. Full-bleed (HMI hidden, FPV/XR): 16 px from the edge.
 * - compact layout (< 900 px): above the mobile tool dock and the search button
 *   (60 + 40 + 8 px plus safe area), 16 px from the left; at ≤ 600 px it spans
 *   the full width minus 16 px gutters.
 *
 * The expiry row follows the opposite rule: it appears **only** when the
 * provider actually set a deadline (F5). A default "expires: never" line would
 * teach visitors to ignore the row that matters.
 */

import { Box, Paper, Typography, Button, IconButton, Stack, Tooltip } from '@mui/material';
import {
  Close, Download, HourglassBottom, OpenInNew,
  BookmarkAddOutlined, BookmarkAdded, Lock,
} from '@mui/icons-material';
import type { SharedGlbInfo } from './rv-share-meta';
import { FS, ICON_SIZE, INK_LOW, INK_MID } from '../hmi/shared-sx';
import { ACTIVITY_BAR_WIDTH, BOTTOM_BAR_HEIGHT } from '../hmi/layout-constants';

const ACCENT = '#4fc3f7';

/** Gap between the card and whatever chrome it clears. */
const GUTTER = 16;
/** The floating ButtonPanel column right of the activity bar: 8 gap + 46 wide + 8 gap. */
const BUTTON_COLUMN_CLEARANCE = 8 + ACTIVITY_BAR_WIDTH + 8;
/** Desktop floor: the same clearance every floating panel keeps above the search bar. */
const DESKTOP_BOTTOM = BOTTOM_BAR_HEIGHT + 12;
/** Compact floor: the search FAB (bottom 60, 40 tall) and the dock below it, plus a gap. */
const COMPACT_BOTTOM = 'calc(108px + env(safe-area-inset-bottom, 0px))';

export interface SharedGlbInfoCardProps {
  /** The loaded share. `null` while loading or after a failure. */
  info: SharedGlbInfo | null;
  /** User-facing failure sentence (expired link, CORS, oversize …). */
  error?: string | null;
  loading?: boolean;
  /** Hides the download button when the provider disabled it (F14). */
  onDownload?: (() => void) | undefined;
  /** "Open in realvirtual WEB" — escalation into the full app (F12). */
  onOpenInApp?: (() => void) | undefined;
  /** "Add to my library" — the one write the receiver may ask for (F13). */
  onAddToLibrary?: (() => void) | undefined;
  /** Already bookmarked: the button says so instead of offering a second copy. */
  bookmarked?: boolean;
  onDismiss?: (() => void) | undefined;
  /**
   * Left edge of the 3D viewport region in css-px (`useViewportInsets().left`:
   * activity bar + open left-docked window; 0 = full-bleed). Passed in by the
   * slot wrapper so the card itself stays renderable without a viewer.
   */
  viewportLeft?: number;
  /** Compact (mobile) layout — the card rises above the tool dock. */
  compact?: boolean;
}

/** Human date for the expiry row; falls back to the raw ISO string. */
function formatExpiry(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString();
}

export function SharedGlbInfoCard({
  info,
  error = null,
  loading = false,
  onDownload,
  onOpenInApp,
  onAddToLibrary,
  bookmarked = false,
  onDismiss,
  viewportLeft = 0,
  compact = false,
}: SharedGlbInfoCardProps) {
  if (!info && !error && !loading) return null;

  const left = compact || viewportLeft === 0 ? GUTTER : viewportLeft + BUTTON_COLUMN_CLEARANCE;

  const meta = info?.meta ?? null;
  // "assembly · Thomas Strigl · CC-BY-4.0" — only the parts that exist, so a
  // bare file does not render a row of orphaned separators.
  const subtitle = [meta?.level, meta?.author, meta?.license].filter(Boolean).join(' · ');

  return (
    <Paper
      elevation={0}
      sx={{
        position: 'absolute',
        left,
        bottom: compact ? COMPACT_BOTTOM : DESKTOP_BOTTOM,
        zIndex: 12,
        width: 320,
        maxWidth: `calc(100vw - ${left + GUTTER}px)`,
        // Phone width: full width minus the gutters, nothing beside it.
        '@media (max-width: 600px)': { left: GUTTER, right: GUTTER, width: 'auto', maxWidth: 'none' },
        p: 1.5,
        borderRadius: 1.5,
        bgcolor: 'rgba(18,20,24,0.86)',
        backdropFilter: 'blur(calc(8px * var(--rv-ui-blur-scale, 1)))',
        border: '1px solid rgba(255,255,255,0.08)',
        color: 'rgba(255,255,255,0.9)',
        pointerEvents: 'auto',
      }}
      data-testid="shared-glb-info-card"
    >
      <Stack direction="row" alignItems="flex-start" spacing={1}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            sx={{
              fontSize: 9,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: `${ACCENT}99`,
            }}
          >
            {error ? 'Shared link' : 'Shared model'}
          </Typography>
          <Typography
            sx={{
              fontSize: 15,
              lineHeight: 1.3,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={info?.name ?? undefined}
          >
            {loading && !info ? 'Loading…' : (info?.name ?? 'Not available')}
          </Typography>
          {subtitle && (
            <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', mt: 0.25 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        {onDismiss && (
          <IconButton size="small" onClick={onDismiss} aria-label="Dismiss" sx={{ mt: -0.5, mr: -0.5 }}>
            <Close sx={{ fontSize: 16, color: 'rgba(255,255,255,0.5)' }} />
          </IconButton>
        )}
      </Stack>

      {error && (
        <Typography
          data-testid="shared-glb-error"
          sx={{ fontSize: 12, color: '#ffb4a2', mt: 1, lineHeight: 1.4 }}
        >
          {error}
        </Typography>
      )}

      {info && (
        <>
          <Box sx={{ height: '1px', bgcolor: 'rgba(255,255,255,0.08)', my: 1, '&:last-child': { display: 'none' } }} />

          {/* Expiry — only when the provider set one (F5). */}
          {meta?.expiresAt && (
            <Stack direction="row" spacing={0.75} alignItems="center">
              <HourglassBottom sx={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }} />
              <Typography data-testid="shared-glb-expiry" sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
                link expires on {formatExpiry(meta.expiresAt)}
              </Typography>
            </Stack>
          )}

          {/* Encrypted — the link was opened with a password (plan-560). */}
          {info.encrypted && (
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.5 }}>
              <Lock sx={{ fontSize: ICON_SIZE.sm, color: INK_LOW }} />
              <Typography data-testid="shared-glb-encrypted" sx={{ fontSize: FS.label, color: INK_MID }}>
                Encrypted — opened with password
              </Typography>
            </Stack>
          )}

          {info.embeddedOrigins.length > 0 && (
            <Tooltip
              title={info.embeddedOrigins.map(o => o.url ?? o.assetId).join('\n')}
              placement="top"
            >
              <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', mt: 0.5, cursor: 'help' }}>
                contains {info.embeddedOrigins.length} embedded asset
                {info.embeddedOrigins.length === 1 ? '' : 's'}
              </Typography>
            </Tooltip>
          )}

          {onOpenInApp && (
            <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
              <Button
                data-testid="shared-glb-open-in-app"
                size="small"
                variant="outlined"
                startIcon={<OpenInNew sx={{ fontSize: 14 }} />}
                onClick={onOpenInApp}
                disabled={loading}
                sx={{ fontSize: 11, textTransform: 'none', flex: 1, borderColor: `${ACCENT}55`, color: ACCENT }}
              >
                Open in realvirtual WEB
              </Button>
            </Stack>
          )}

          {(onAddToLibrary || onDownload) && (
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              {onAddToLibrary && (
                <Button
                  data-testid="shared-glb-bookmark"
                  size="small"
                  variant="text"
                  startIcon={bookmarked
                    ? <BookmarkAdded sx={{ fontSize: 14 }} />
                    : <BookmarkAddOutlined sx={{ fontSize: 14 }} />}
                  onClick={onAddToLibrary}
                  disabled={bookmarked}
                  sx={{ fontSize: 11, textTransform: 'none', flex: 1, color: 'rgba(255,255,255,0.7)' }}
                >
                  {bookmarked ? 'In my library' : 'Add to my library'}
                </Button>
              )}
              {onDownload && (
                <Button
                  data-testid="shared-glb-download"
                  size="small"
                  variant="text"
                  startIcon={<Download sx={{ fontSize: 14 }} />}
                  onClick={onDownload}
                  sx={{ fontSize: 11, textTransform: 'none', color: 'rgba(255,255,255,0.7)' }}
                >
                  {info.encrypted ? 'Download (encrypted)' : 'GLB'}
                </Button>
              )}
            </Stack>
          )}
        </>
      )}
    </Paper>
  );
}

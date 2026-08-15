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
 * Without an `rv_share` block the card shrinks to filename plus origin — it does
 * not vanish. The origin line *is* the security measure (§2.8): a visitor must
 * always be able to see that what he is looking at came from somewhere else,
 * which is the standard countermeasure for `?src=<foreign url>` patterns.
 * Everything else on the card is optional decoration around that one line.
 *
 * The expiry row follows the opposite rule: it appears **only** when the
 * provider actually set a deadline (F5). A default "expires: never" line would
 * teach visitors to ignore the row that matters.
 */

import { Box, Paper, Typography, Button, IconButton, Stack, Tooltip } from '@mui/material';
import {
  Close, Download, Public, HourglassBottom, OpenInNew,
  BookmarkAddOutlined, BookmarkAdded,
} from '@mui/icons-material';
import type { SharedGlbInfo } from './rv-share-meta';

const ACCENT = '#4fc3f7';

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
}: SharedGlbInfoCardProps) {
  if (!info && !error && !loading) return null;

  const meta = info?.meta ?? null;
  // "assembly · Thomas Strigl · CC-BY-4.0" — only the parts that exist, so a
  // bare file does not render a row of orphaned separators.
  const subtitle = [meta?.level, meta?.author, meta?.license].filter(Boolean).join(' · ');

  return (
    <Paper
      elevation={0}
      sx={{
        position: 'absolute',
        left: 16,
        bottom: 16,
        zIndex: 12,
        width: 320,
        maxWidth: 'calc(100vw - 32px)',
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
          <Box sx={{ height: '1px', bgcolor: 'rgba(255,255,255,0.08)', my: 1 }} />

          {/* Origin — the one row that is always present. */}
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Public sx={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }} />
            <Typography
              data-testid="shared-glb-origin"
              sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              loaded from {info.originHost ?? 'an unknown source'}
            </Typography>
          </Stack>

          {/* Expiry — only when the provider set one (F5). */}
          {meta?.expiresAt && (
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.5 }}>
              <HourglassBottom sx={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }} />
              <Typography data-testid="shared-glb-expiry" sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
                link expires on {formatExpiry(meta.expiresAt)}
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
                  GLB
                </Button>
              )}
            </Stack>
          )}
        </>
      )}
    </Paper>
  );
}

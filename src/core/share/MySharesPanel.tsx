// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * "My shared links" (plan-386 §3.2b, F11).
 *
 * ## This is the control, not a convenience
 *
 * The plan chose *no automatic deletion* as the default: a link in an offer or
 * a piece of documentation should still work in six months, and a link that
 * dies unannounced undermines the point of sharing (Alternative G). That choice
 * is only defensible because of this list. Without a place where a sender sees
 * everything he ever shared and can remove it in one click, indefinite hosting
 * would mean nobody can tidy up what they published a year ago — and that is
 * not a feature, it is a liability.
 *
 * So this panel is reachable from the login, not buried in settings, and the
 * delete button acts immediately: no confirmation dance for a destructive
 * action the sender came here specifically to perform. Afterwards the link
 * answers `410` (`myShares_DeleteRemovesAndReturns410`).
 *
 * ## Only his own
 *
 * The scoping is the server's job — the list endpoint answers for the bearer of
 * the session and nothing else (`myShares_ListsOnlyOwnUploads`). The client
 * neither filters nor asks for anyone else's, which is the only arrangement
 * where a client bug cannot widen the disclosure.
 */

import { useCallback, useEffect, useState } from 'react';
import { Box, IconButton, LinearProgress, Stack, Tooltip, Typography } from '@mui/material';
import { DeleteOutline, HourglassBottom } from '@mui/icons-material';

import { listMyShares, deleteShare, type MyShareEntry } from './rv-share-upload';
import { describeShareApiError, type MagicLinkSession } from './rv-share-session';

export interface MySharesPanelProps {
  session: MagicLinkSession;
  /** Notified after a successful deletion, e.g. to refresh a surrounding view. */
  onDeleted?: (id: string) => void;
}

export function MySharesPanel({ session, onDeleted }: MySharesPanelProps) {
  const [entries, setEntries] = useState<MyShareEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setEntries(await listMyShares(session));
    } catch (e) {
      setEntries([]);
      setError(describeShareApiError(e));
    }
  }, [session]);

  useEffect(() => { void reload(); }, [reload]);

  const handleDelete = useCallback(async (id: string) => {
    setDeleting(id);
    setError(null);
    try {
      await deleteShare(session, id);
      // Drop it locally rather than re-listing: the sender asked for it to be
      // gone and should see it gone, not a spinner.
      setEntries(prev => (prev ?? []).filter(e => e.id !== id));
      onDeleted?.(id);
    } catch (e) {
      setError(describeShareApiError(e));
    } finally {
      setDeleting(null);
    }
  }, [session, onDeleted]);

  if (entries === null) {
    return (
      <Box sx={{ py: 2 }} data-testid="my-shares-loading">
        <LinearProgress />
      </Box>
    );
  }

  return (
    <Box data-testid="my-shares">
      <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 1 }}>
        {session.email}
      </Typography>

      {error && (
        <Typography sx={{ fontSize: 12, color: 'error.main', mb: 1 }} data-testid="my-shares-error">
          {error}
        </Typography>
      )}

      {entries.length === 0 && !error && (
        <Typography sx={{ fontSize: 13, color: 'text.secondary' }} data-testid="my-shares-empty">
          You have not shared anything yet.
        </Typography>
      )}

      <Stack divider={<Box sx={{ height: '1px', bgcolor: 'divider' }} />}>
        {entries.map(entry => (
          <Stack
            key={entry.id}
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ py: 0.75 }}
            data-testid={`my-share-${entry.id}`}
          >
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                sx={{
                  fontSize: 13,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: entry.expired ? 'text.disabled' : 'text.primary',
                }}
              >
                {entry.name}{entry.expired ? ' (expired)' : ''}
              </Typography>
              {entry.expiresAt && (
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <HourglassBottom sx={{ fontSize: 12, opacity: 0.5 }} />
                  <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                    expires on {formatDate(entry.expiresAt)}
                  </Typography>
                </Stack>
              )}
            </Box>

            <Typography sx={{ fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}>
              {formatSize(entry.sizeBytes)}
            </Typography>
            <Typography sx={{ fontSize: 12, color: 'text.secondary', whiteSpace: 'nowrap' }}>
              {formatDate(entry.createdAt)}
            </Typography>

            <Tooltip title="Delete now">
              <span>
                <IconButton
                  size="small"
                  disabled={deleting === entry.id}
                  onClick={() => void handleDelete(entry.id)}
                  data-testid={`my-share-delete-${entry.id}`}
                  aria-label={`Delete ${entry.name}`}
                >
                  <DeleteOutline sx={{ fontSize: 16 }} />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RegenerateThumbnailsDialog — progress and result of "Regenerate thumbnails"
 * (plan-776 #20).
 *
 * Reads the run's progress store and nothing else: the run itself is the
 * registry command `project.regenerateThumbnails`, which the project row's ⋮
 * menu dispatches by id. This file must not import the renderer or the writer
 * (guard 9.5) — and it does not need to: the store tells it the count, the
 * document in progress and, at the end, what failed.
 *
 * Open while a run is in progress (whoever started it — a run from MCP shows
 * here too) and after it, until the result is closed. Cancel stops after the
 * current document; every thumbnail written so far stays.
 */

import { useSyncExternalStore } from 'react';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Typography,
} from '@mui/material';
import { ERROR, FS, INK_LOW, INK_MID, MONO, SUCCESS, WARN } from '../shared-sx';
import {
  dismissRegenerateProgress,
  getRegenerateProgress,
  requestRegenerateCancel,
  subscribeRegenerateProgress,
  type RegenerateProgress,
} from '../../thumbnails/rv-thumbnail-regenerate-progress';

/** "9 written, 2 failed" — the one result sentence (also used by the host's message). */
export function regenerateSummary(p: Pick<RegenerateProgress, 'written' | 'failures' | 'cancelled' | 'done' | 'total'>): string {
  const parts = [`${p.written} written`];
  if (p.failures.length > 0) parts.push(`${p.failures.length} failed`);
  const sentence = parts.join(', ');
  return p.cancelled ? `Cancelled after ${p.done} of ${p.total} — ${sentence}.` : `${sentence}.`;
}

export function RegenerateThumbnailsDialog() {
  const p = useSyncExternalStore(subscribeRegenerateProgress, getRegenerateProgress);
  const open = p.running || p.finished;
  const counted = p.total > 0;
  const value = counted ? Math.round((p.done / p.total) * 100) : 0;

  return (
    <Dialog
      open={open}
      disableEscapeKeyDown={p.running}
      onClose={() => { if (!p.running) dismissRegenerateProgress(); }}
      maxWidth="xs"
      fullWidth
      onKeyDown={e => e.stopPropagation()}
      aria-labelledby="regenerate-thumbnails-title"
      data-testid="regenerate-thumbnails-dialog"
    >
      <DialogTitle id="regenerate-thumbnails-title" sx={{ fontSize: FS.title }}>
        {p.running ? 'Regenerating thumbnails' : 'Thumbnails regenerated'}
        {p.projectName && (
          <Typography component="span" sx={{ fontSize: FS.body, color: INK_LOW, ml: 1 }}>
            {p.projectName}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent>
        {p.running && (
          <>
            <Typography sx={{ fontSize: FS.body, color: INK_MID, mb: 0.5 }} data-testid="regenerate-thumbnails-count">
              {counted ? `${Math.min(p.done + 1, p.total)} / ${p.total}` : 'Opening the project…'}
            </Typography>
            <Typography
              sx={{
                fontSize: FS.label, color: INK_LOW, fontFamily: MONO, mb: 1.5,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              data-testid="regenerate-thumbnails-current"
            >
              {p.cancelRequested ? 'Stopping after this document…' : p.current ?? ' '}
            </Typography>
            <LinearProgress
              variant={counted ? 'determinate' : 'indeterminate'}
              value={value}
              aria-label="Regenerating thumbnails"
            />
          </>
        )}
        {!p.running && p.finished && (
          <Box data-testid="regenerate-thumbnails-result">
            {p.error ? (
              <Typography sx={{ fontSize: FS.body, color: ERROR }}>{p.error}</Typography>
            ) : (
              <Typography sx={{ fontSize: FS.body, color: p.failures.length > 0 ? WARN : SUCCESS }}>
                {regenerateSummary(p)}
              </Typography>
            )}
            {p.failures.length > 0 && (
              <Box component="ul" sx={{ m: 0, mt: 1, pl: 2, fontSize: FS.label, color: INK_MID }}>
                {p.failures.map(f => (
                  <li key={f.documentId}>
                    <Box component="span" sx={{ fontWeight: 600 }}>{f.name}</Box>
                    {' — '}
                    {f.reason}
                  </li>
                ))}
              </Box>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        {p.running ? (
          <Button
            size="small"
            onClick={requestRegenerateCancel}
            disabled={p.cancelRequested}
            data-testid="regenerate-thumbnails-cancel"
            sx={{ textTransform: 'none' }}
          >
            {p.cancelRequested ? 'Cancelling…' : 'Cancel'}
          </Button>
        ) : (
          <Button
            size="small"
            onClick={dismissRegenerateProgress}
            data-testid="regenerate-thumbnails-close"
            sx={{ textTransform: 'none' }}
          >
            Close
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

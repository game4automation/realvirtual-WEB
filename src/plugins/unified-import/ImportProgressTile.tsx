// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ImportProgressTile.tsx — the floating glass outcome tile shown after the
 * Unified Import Dialog closes. Bottom-right over the scene, floating glass
 * tier, no shadow.
 *
 * One of two views of the import-job store (the other is the Unified Import
 * Dialog). While a job RUNS the dialog stays open as a blocking modal and
 * hosts the progress itself, so this tile normally only shows outcomes:
 * success (brief confirmation, auto-dismisses), warning/error (short text +
 * "Details" reopening the dialog with the kept inputs). The running view is
 * kept as a fallback for any job that runs with the dialog closed.
 */

import { useEffect, useRef, useState } from 'react';
import { Box, Button, IconButton, LinearProgress, Paper, Portal, Typography } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import { CheckCircleOutline, Close, ErrorOutline, WarningAmber } from '@mui/icons-material';
import { abortImportJob, dismissImportOutcome, useImportJob } from './import-job-store';

/** How long the success confirmation stays before auto-dismissing (ms). */
const SUCCESS_DISMISS_MS = 4000;

interface ImportProgressTileProps {
  /** Reopen the Unified Import Dialog (same job, kept inputs). */
  onOpenDialog: () => void;
}

export function ImportProgressTile({ onOpenDialog }: ImportProgressTileProps) {
  const job = useImportJob();

  // Success confirmations dismiss themselves — the changed scene is the real
  // confirmation; the tile only bridges the moment.
  useEffect(() => {
    if (job.outcome?.kind !== 'success') return;
    const t = setTimeout(dismissImportOutcome, SUCCESS_DISMISS_MS);
    return () => clearTimeout(t);
  }, [job.outcome]);

  if (job.status !== 'running' && !job.outcome) return null;
  if (job.outcome?.kind === 'cancelled') return null; // dialog shows the cancel note

  const running = job.status === 'running';
  const outcome = job.outcome;

  return (
    <Portal>
      <Paper
        data-testid="import-progress-tile"
        elevation={0}
        onClick={running ? onOpenDialog : undefined}
        sx={{
          position: 'fixed',
          right: 16,
          bottom: 16,
          width: 340,
          maxWidth: 'calc(100vw - 32px)',
          p: 1.5,
          borderRadius: 1,
          border: '1px solid rgba(255,255,255,0.08)',
          zIndex: (theme) => theme.zIndex.snackbar,
          cursor: running ? 'pointer' : 'default',
        }}
      >
        {running && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                {job.progress?.label ?? `Importing ${job.providerLabel ?? ''}…`}
              </Typography>
              {job.progress?.percent != null && (
                <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.primary', flexShrink: 0 }}>
                  {Math.round(job.progress.percent * 100)}%
                </Typography>
              )}
              <IconButton
                size="small"
                aria-label="Cancel import"
                onClick={(e) => { e.stopPropagation(); abortImportJob(); }}
                sx={{ p: 0.25, flexShrink: 0 }}
              >
                <Close fontSize="small" />
              </IconButton>
            </Box>
            <LinearProgress
              variant={job.progress?.percent != null ? 'determinate' : 'indeterminate'}
              value={job.progress?.percent != null ? job.progress.percent * 100 : undefined}
              sx={{ mt: 0.75 }}
            />
            {job.progress?.detail && (
              <Typography variant="caption" noWrap sx={{ display: 'block', mt: 0.5, color: 'text.secondary' }}>
                {job.progress.detail}
              </Typography>
            )}
          </>
        )}

        {!running && outcome && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {outcome.kind === 'success' && <CheckCircleOutline fontSize="small" color="success" />}
            {outcome.kind === 'warning' && <WarningAmber fontSize="small" color="warning" />}
            {outcome.kind === 'error' && <ErrorOutline fontSize="small" color="error" />}
            <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
              {outcome.kind === 'success'
                ? `Import complete — ${outcome.importedNames.join(', ') || 'done'}`
                : outcome.kind === 'warning'
                  ? `Imported with warnings — ${outcome.warnings[0] ?? ''}`
                  : `Import failed — ${outcome.errors[0] ?? ''}`}
            </Typography>
            {outcome.kind !== 'success' && (
              <Button size="small" onClick={onOpenDialog} sx={{ textTransform: 'none', flexShrink: 0 }}>
                Details
              </Button>
            )}
            <IconButton
              size="small"
              aria-label="Dismiss"
              onClick={dismissImportOutcome}
              sx={{ p: 0.25, flexShrink: 0 }}
            >
              <Close fontSize="small" />
            </IconButton>
          </Box>
        )}
      </Paper>
    </Portal>
  );
}

/**
 * ImportJobAnnouncer — the ONE screen-reader live region for the import job,
 * rendered whether the dialog or the tile is showing. Throttled: announcing
 * every progress tick would spam the reader, total silence for a minutes-long
 * conversion would read as a hang.
 */
export function ImportJobAnnouncer() {
  const job = useImportJob();
  const lastAnnounceRef = useRef(0);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (job.status === 'running' && job.progress) {
      const now = Date.now();
      if (now - lastAnnounceRef.current < 5000) return;
      lastAnnounceRef.current = now;
      setAnnouncement(
        job.progress.percent != null
          ? `${job.progress.label}, ${Math.round(job.progress.percent * 100)} percent`
          : job.progress.label,
      );
      return;
    }
    lastAnnounceRef.current = 0;
    if (job.outcome) {
      setAnnouncement(
        job.outcome.kind === 'success' ? 'Import complete'
          : job.outcome.kind === 'warning' ? 'Import finished with warnings'
          : job.outcome.kind === 'error' ? `Import failed: ${job.outcome.errors[0] ?? ''}`
          : 'Import cancelled',
      );
    } else {
      setAnnouncement('');
    }
  }, [job]);

  return <Box role="status" aria-live="polite" sx={visuallyHidden}>{announcement}</Box>;
}

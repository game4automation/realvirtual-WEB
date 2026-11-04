// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectOperationDialog — the blocking "Open project… / Deleting…" dialog of
 * the projects dashboard, with the step it is in.
 *
 * It used to say "Please wait while the project is updated." for every step of
 * every verb, so a one-minute file hash and a switch waiting on an invisible
 * question looked the same. It now shows the current step from
 * `project-op-progress` (which the project store reports into), the elapsed
 * time, and a Details list of the finished steps with their durations. A step
 * that waits on the user is said as such.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Button, Collapse, Dialog, DialogContent, DialogTitle, LinearProgress, Typography } from '@mui/material';
import {
  getProjectOpProgress,
  subscribeProjectOpProgress,
} from '../../project/project-op-progress';

export interface ProjectOperationDialogProps {
  /** The verb's label ("Open project"), or null when no verb runs. */
  label: string | null;
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

export function ProjectOperationDialog({ label }: ProjectOperationDialogProps) {
  const progress = useSyncExternalStore(subscribeProjectOpProgress, getProjectOpProgress);
  const [now, setNow] = useState(() => Date.now());
  const [showDetails, setShowDetails] = useState(false);
  const open = label !== null;

  useEffect(() => {
    if (!open) { setShowDetails(false); return; }
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [open]);

  const cur = progress.current;
  const elapsed = progress.startedAt !== null ? Math.max(0, now - progress.startedAt) : 0;
  const stepElapsed = cur ? Math.max(0, now - cur.startedAt) : 0;

  return (
    <Dialog open={open} disableEscapeKeyDown maxWidth="xs" fullWidth
      onKeyDown={e => e.stopPropagation()}
      aria-labelledby="project-operation-title" aria-describedby="project-operation-description">
      <DialogTitle id="project-operation-title">{label}…</DialogTitle>
      <DialogContent>
        <Typography id="project-operation-description" sx={{ mb: 0.5 }}>
          {cur ? cur.label : 'Please wait while the project is updated.'}
        </Typography>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1.5 }}
          data-testid="project-operation-elapsed">
          {cur?.waitingForUser
            ? `Answer the open question to continue · ${fmtMs(stepElapsed)}`
            : cur
              ? `${fmtMs(stepElapsed)} in this step · ${fmtMs(elapsed)} total`
              : progress.startedAt !== null ? `${fmtMs(elapsed)} total` : ''}
        </Typography>
        <LinearProgress aria-label={label ?? 'Updating project'} />
        {progress.finished.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Button size="small" onClick={() => setShowDetails(v => !v)}
              sx={{ textTransform: 'none', px: 0, minWidth: 0, fontSize: 12 }}>
              {showDetails ? 'Hide details' : `Details (${progress.finished.length} step${progress.finished.length === 1 ? '' : 's'} done)`}
            </Button>
            <Collapse in={showDetails}>
              <Box component="ul" sx={{ m: 0, pl: 2, fontSize: 12, color: 'text.secondary' }}>
                {progress.finished.map((s, i) => (
                  <li key={`${s.label}:${i}`}>{s.label} — {fmtMs(s.durationMs ?? 0)}</li>
                ))}
              </Box>
            </Collapse>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}

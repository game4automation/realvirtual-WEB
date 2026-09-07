// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * UnifiedImportButton.tsx — entry point for the Unified Import Dialog
 * (plan-238 §3.2). Lives in the 'button-group' toolbar slot, editor-only.
 *
 * Also hosts the two job views outside the dialog: the floating outcome
 * tile (shown while the dialog is closed) and the screen-reader announcer
 * (always). While a job runs the dialog stays open as a blocking modal; it
 * also stays mounted (`keepMounted`) so the provider tabs keep their state.
 */

import { useEffect, useState } from 'react';
import { Tooltip, IconButton, CircularProgress } from '@mui/material';
import { ViewInAr } from '@mui/icons-material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { UnifiedImportDialog } from './UnifiedImportDialog';
import { ImportJobAnnouncer, ImportProgressTile } from './ImportProgressTile';
import { useImportJob } from './import-job-store';

// ─── Open-on-request (2026-09-05) ────────────────────────────────────────
// The dialog's open flag is local to the button, which is right for clicks
// but leaves a deep link with no way in. `?doc=new&mode=editor` wants the
// import dialog up as soon as the editor is on screen — so the request is
// parked here and consumed by the button when it mounts (the button exists
// only in editor mode, which is exactly the moment the request is for).
let _openRequested = false;
const _openListeners = new Set<() => void>();

/** Ask the next mounted import button to open its dialog. */
export function requestUnifiedImportOpen(): void {
  _openRequested = true;
  for (const l of _openListeners) l();
}

function consumeUnifiedImportOpenRequest(): boolean {
  const was = _openRequested;
  _openRequested = false;
  return was;
}

export function UnifiedImportButton({ viewer }: UISlotProps) {
  const [open, setOpen] = useState(() => consumeUnifiedImportOpenRequest());
  const job = useImportJob();
  const running = job.status === 'running';

  useEffect(() => {
    const onRequest = () => { if (consumeUnifiedImportOpenRequest()) setOpen(true); };
    _openListeners.add(onRequest);
    return () => { _openListeners.delete(onRequest); };
  }, []);

  return (
    <>
      <Tooltip
        title={running
          ? 'Import running — click for progress'
          : 'Import 3D / CAD files — STEP, JT, USD, GLB, Onshape, Asset Manager'}
        placement="right"
      >
        <IconButton size="small" sx={{ p: 0.75 }} onClick={() => setOpen(true)} data-testid="unified-import-button">
          {running
            ? <CircularProgress size={18} thickness={5} sx={{ color: 'primary.main' }} />
            : <ViewInAr fontSize="small" />}
        </IconButton>
      </Tooltip>
      {(open || running) && (
        <UnifiedImportDialog viewer={viewer} open={open} onClose={() => setOpen(false)} />
      )}
      {!open && <ImportProgressTile onOpenDialog={() => setOpen(true)} />}
      <ImportJobAnnouncer />
    </>
  );
}

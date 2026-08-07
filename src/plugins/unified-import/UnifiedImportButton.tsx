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

import { useState } from 'react';
import { Tooltip, IconButton, CircularProgress } from '@mui/material';
import { ViewInAr } from '@mui/icons-material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { UnifiedImportDialog } from './UnifiedImportDialog';
import { ImportJobAnnouncer, ImportProgressTile } from './ImportProgressTile';
import { useImportJob } from './import-job-store';

export function UnifiedImportButton({ viewer }: UISlotProps) {
  const [open, setOpen] = useState(false);
  const job = useImportJob();
  const running = job.status === 'running';

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

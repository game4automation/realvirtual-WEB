// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AddProjectProgress — the running GLB scan, inline in the Projects section
 * (plan-743 F3).
 *
 * The scan has no cap and no ignore list, so the counter is not decoration: it
 * is the only way a user can tell "this is a big folder" from "this is a
 * symlink loop", and Cancel is the only way out of the second. Both are on
 * screen for the whole run.
 *
 * Inline rather than a floating tile (unlike `ImportProgressTile`, whose
 * structure this follows): the scan produces a row in the very list it sits
 * above, so the progress belongs in that list's header where the result will
 * appear.
 */

import { Box, Button, LinearProgress, Typography } from '@mui/material';
import { abortAddScan, useAddProjectJob } from '../../project/rv-project-add-job';

export function AddProjectProgress() {
  const job = useAddProjectJob();
  if (job.status !== 'running') return null;

  const p = job.progress;
  const files = p?.visited ?? 0;
  const models = p?.found ?? 0;

  return (
    <Box
      data-testid="add-project-progress"
      sx={{
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 1,
        bgcolor: 'rgba(255,255,255,0.03)',
        px: 2,
        py: 1.25,
        mb: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography
          sx={{
            fontSize: 12, color: 'text.secondary', flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {`Scanning “${job.folderName ?? ''}”… `}
          {/* Localised separators, because these numbers get large enough to
              be unreadable without them — which is the whole point of showing
              them at all. */}
          {`${files.toLocaleString()} files, ${models.toLocaleString()} models`}
        </Typography>
        <Button
          size="small"
          data-testid="add-project-cancel"
          onClick={abortAddScan}
          sx={{ textTransform: 'none', flexShrink: 0 }}
        >
          Cancel
        </Button>
      </Box>
      {/* Indeterminate on purpose: the tree's size is unknown until it has been
          walked, and a bar that guesses a percentage would be lying. */}
      <LinearProgress sx={{ mt: 1, height: 2, borderRadius: 1 }} />
    </Box>
  );
}

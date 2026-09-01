// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SaveDialogs — the three dialogs of the ONE save path, rendered.
 *
 * Save dialogs are document INFRASTRUCTURE, not authoring UI. plan-434 moved
 * the asset editor's authoring tools into the commercial sibling; saving is not
 * one of them, because every tier opens documents and writes them back, and a
 * Community build with a different save flow would be a second product. These
 * dialogs therefore stay in the AGPL core deliberately — a later 434-style
 * sweep must not collect them.
 *
 * Mounted once, in the `overlay` slot, so the save path can ask a question from
 * anywhere: the card's Save button, Ctrl+S, the "Save as…" menu and the exit
 * guard all run outside React, and the promise plumbing lives in
 * `save-dialog-store`.
 *
 * Design: Glass Control Room — the MUI dialog surface `DocumentCard` already
 * uses, 13px Inter, Instrument Blue on the one primary action, error ink
 * reserved for the destructive answer.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { UISlotEntry } from '../../rv-ui-plugin';
import type { RVViewerPlugin } from '../../rv-plugin';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import {
  getPendingSaveDialog,
  getSaveDialogsVersion,
  subscribeSaveDialogs,
} from './save-dialog-store';

export function SaveDialogs() {
  useSyncExternalStore(subscribeSaveDialogs, getSaveDialogsVersion);
  const pending = getPendingSaveDialog();

  const [nameValue, setNameValue] = useState('');
  useEffect(() => {
    if (pending?.kind === 'name') setNameValue(pending.initial);
  }, [pending]);

  if (!pending) return null;

  if (pending.kind === 'unsaved') {
    return (
      <Dialog
        open
        data-testid="save-dialog-unsaved"
        onClose={() => pending.resolve('cancel')}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>Unsaved changes</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: 13 }}>
            “{pending.documentName}” has changes that are not stored yet.
            Save them before leaving?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            size="small"
            sx={{ textTransform: 'none' }}
            onClick={() => pending.resolve('cancel')}
          >
            Cancel
          </Button>
          <Button
            size="small"
            color="warning"
            sx={{ textTransform: 'none' }}
            onClick={() => pending.resolve('discard')}
          >
            Discard
          </Button>
          <Button
            size="small"
            variant="contained"
            sx={{ textTransform: 'none' }}
            onClick={() => pending.resolve('save')}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  if (pending.kind === 'name') {
    const trimmed = nameValue.trim();
    const submit = (): void => { if (trimmed) pending.resolve(trimmed); };
    return (
      <Dialog
        open
        data-testid="save-dialog-name"
        onClose={() => pending.resolve(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>{pending.title}</DialogTitle>
        <DialogContent>
          {/* Problem before solution: WHY there is a dialog at all, then the
              one field that answers it. */}
          <DialogContentText sx={{ fontSize: 13, mb: 1 }}>
            {pending.description
              ?? 'This asset is read-only. Save a copy into your project to edit and keep it.'}
          </DialogContentText>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Name"
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          {pending.folder !== undefined && (
            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 1 }}>
              Folder: {pending.folder || 'Project root'}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            size="small"
            sx={{ textTransform: 'none' }}
            onClick={() => pending.resolve(null)}
          >
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={!trimmed}
            sx={{ textTransform: 'none' }}
            onClick={submit}
          >
            {pending.confirmLabel}
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  // save-problem — one message, the concrete reason, and a way out (F5).
  //
  // The reason is rendered VERBATIM and with `pre-line`, so the caller that
  // knows the situation can put "what happened" and "what to do about it" on
  // separate lines instead of one run-on sentence. plan-444's residual refusal
  // (a part moved inside an asset that is itself referenced) is the case that
  // needs it: without the second line the user is told a save failed and not
  // how to make it succeed.
  return (
    <Dialog
      open
      data-testid="save-dialog-problem"
      onClose={() => pending.resolve('cancel')}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>Cannot save</DialogTitle>
      <DialogContent>
        <DialogContentText
          data-testid="save-dialog-problem-reason"
          sx={{ fontSize: 13, whiteSpace: 'pre-line' }}
        >
          {pending.reason}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button
          size="small"
          sx={{ textTransform: 'none' }}
          onClick={() => pending.resolve('cancel')}
        >
          Cancel
        </Button>
        {pending.canDownload && (
          <Button
            size="small"
            data-testid="save-dialog-problem-download"
            sx={{ textTransform: 'none' }}
            onClick={() => pending.resolve('download')}
          >
            Download .glb
          </Button>
        )}
        {/* The click IS the fresh user gesture a permission re-grant needs —
            `requestPermission()` throws without one, and the activation is
            consumed by the call. */}
        {pending.canRetry && (
          <Button
            size="small"
            variant="contained"
            data-testid="save-dialog-problem-retry"
            sx={{ textTransform: 'none' }}
            onClick={() => pending.resolve('retry')}
          >
            Try again
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

// ─── Mount ──────────────────────────────────────────────────────────────

/**
 * The one mount of the save dialogs.
 *
 * A plugin rather than a JSX tag inside `DocumentCard`, and that is not
 * ceremony: the card is mounted TWICE (the hierarchy header and the dashboard
 * hero), so rendering the dialogs from it would put two of every dialog on
 * screen and let the second steal the first one's backdrop. The store is a
 * singleton, so its renderer has to be one too — which is exactly what the
 * `overlay` slot is.
 *
 * No `modes` and no visibility rule on purpose: saving is reachable in every
 * mode, and a save prompt that cannot render is a save that hangs.
 */
export class SaveDialogsPlugin implements RVViewerPlugin {
  readonly id = 'save-dialogs';
  readonly order = 71;

  readonly slots: UISlotEntry[] = [
    { slot: 'overlay', component: SaveDialogs, order: 96 },
  ];
}

/** The single, named registration call site. */
export function registerSaveDialogsPlugin(
  viewer: { use: (p: RVViewerPlugin, group?: string) => unknown },
): void {
  viewer.use(new SaveDialogsPlugin(), 'core');
}

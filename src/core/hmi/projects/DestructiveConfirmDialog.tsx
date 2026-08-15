// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DestructiveConfirmDialog — the one confirm behind every destructive verb of
 * the Projects dashboard (delete asset / scene / project, remove library).
 *
 * Replaces four `window.confirm` call sites. The OS alert put the product's
 * highest-anxiety moment into unstyled browser chrome: no error-colored
 * action, no object name in a title, indistinguishable from any other site's
 * popup. One shared dialog keeps the copy pattern of those confirms — name the
 * object, state the consequence — inside the glass system.
 *
 * The destructive button is `color="error"` and NOT auto-focused: Enter must
 * not delete. Focus starts on Cancel, the safe default.
 */

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';

export interface DestructiveConfirmRequest {
  /** Dialog title naming the verb and object kind, e.g. "Delete asset". */
  title: string;
  /** Consequence line naming the object, e.g. 'Delete "Belt"? …'. */
  message: string;
  /** Label of the destructive button, e.g. "Delete". */
  confirmLabel: string;
  /** Runs on confirm. The dialog closes either way. */
  onConfirm: () => void;
}

export interface DestructiveConfirmDialogProps {
  request: DestructiveConfirmRequest | null;
  onClose: () => void;
}

export function DestructiveConfirmDialog({ request, onClose }: DestructiveConfirmDialogProps) {
  return (
    <Dialog open={request !== null} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>
        {request?.title}
      </DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: 13 }}>
          {request?.message}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button size="small" autoFocus onClick={onClose} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          color="error"
          data-testid="destructive-confirm"
          onClick={() => {
            const confirm = request?.onConfirm;
            onClose();
            confirm?.();
          }}
          sx={{ textTransform: 'none' }}
        >
          {request?.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

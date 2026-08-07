// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared destructive-action confirmation (replaces window.confirm).
 *
 * Extracted from ConnectPanel so both the panel and the CONNECT settings
 * window can use it without an import cycle.
 */

import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';

export interface ConfirmAction {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}

/**
 * Product-styled confirmation for destructive actions. Names the action and its
 * payload, uses a specific confirm label ("Delete interface", never "OK"), and
 * focuses Cancel by default so Enter never destroys anything by accident.
 */
export function ConfirmActionDialog({ action, onClose }: { action: ConfirmAction | null; onClose: () => void }) {
  return (
    <Dialog open={!!action} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14 }}>{action?.title}</DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>{action?.message}</Typography>
      </DialogContent>
      <DialogActions>
        <Button autoFocus onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button
          color="error"
          variant="contained"
          onClick={() => { void action?.onConfirm(); onClose(); }}
          sx={{ textTransform: 'none' }}
        >
          {action?.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

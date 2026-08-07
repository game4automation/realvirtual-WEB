// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ForceConfirmDialog — global "are you sure?" gate shown on the first signal
 * force in a session. Confirming allows forcing until the page reloads.
 * Mounted once in HMIShell; driven by force-confirm-store.
 */

import { useSyncExternalStore } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';
import { Bolt } from '@mui/icons-material';
import {
  subscribeForceConfirm,
  getForceConfirmOpen,
  resolveForceConfirm,
} from './force-confirm-store';

export function ForceConfirmDialog() {
  const open = useSyncExternalStore(subscribeForceConfirm, getForceConfirmOpen);

  return (
    <Dialog open={open} onClose={() => resolveForceConfirm(false)} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14, fontWeight: 600 }}>
        <Bolt sx={{ color: '#ffb300' }} />
        Force signals?
      </DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ fontSize: 13 }}>
          Forcing overrides a signal's value and holds it — incoming updates from the
          PLC or interface are ignored until you release the force. Use this for
          testing only.
          <br /><br />
          Enable forcing for this session?
        </DialogContentText>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" onClick={() => resolveForceConfirm(false)} sx={{ textTransform: 'none', mr: 'auto' }}>
          Cancel
        </Button>
        <Button
          size="small"
          variant="contained"
          color="warning"
          onClick={() => resolveForceConfirm(true)}
          sx={{ textTransform: 'none' }}
        >
          Enable forcing
        </Button>
      </DialogActions>
    </Dialog>
  );
}

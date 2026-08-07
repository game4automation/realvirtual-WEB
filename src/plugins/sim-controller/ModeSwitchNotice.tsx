// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ModeSwitchNotice — a brief overlay notice shown when the user switches between
 * the authoring/operating workspaces (Planner ⇄ HMI ⇄ DES). These modes are NOT
 * yet continuous: switching clears all moving parts (MUs). The notice informs the
 * user so the reset is not a surprise. Auto-dismissing, non-blocking.
 *
 * Mounted in the `overlay` slot (no visibility rule) so it catches every switch.
 */

import { useEffect, useState } from 'react';
import { Snackbar, Alert } from '@mui/material';
import type { UISlotProps } from '../../core/rv-ui-plugin';

/** Workspaces between which a switch clears MUs (no cross-mode continuity yet). */
const SWITCH_MODES = new Set(['planner', 'hmi', 'des']);

export function ModeSwitchNotice({ viewer }: UISlotProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const off = viewer.on('mode-changed', ({ from, to }) => {
      if (from && to && from !== to && SWITCH_MODES.has(from) && SWITCH_MODES.has(to)) {
        setOpen(true);
      }
    });
    return off;
  }, [viewer]);

  return (
    <Snackbar
      open={open}
      autoHideDuration={4000}
      onClose={() => setOpen(false)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert
        severity="info"
        variant="filled"
        onClose={() => setOpen(false)}
        sx={{ fontSize: 12, alignItems: 'center' }}
      >
        Switching workspace clears all moving parts (MUs) — the modes are not yet continuous.
      </Alert>
    </Snackbar>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useSyncExternalStore } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import SettingsInputComponent from '@mui/icons-material/SettingsInputComponent';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import {
  getSignalLinkModeSnapshot,
  setSignalLinkModeExplicit,
  subscribeSignalLinkMode,
} from './signal-link-mode-store';

export function SignalLinkModeButton({ viewer }: UISlotProps) {
  const snapshot = useSyncExternalStore(
    subscribeSignalLinkMode,
    getSignalLinkModeSnapshot,
  );
  if (!viewer.signalBindingManager) return null;

  return (
    <Tooltip
      title={snapshot.explicit
        ? 'Signal linking: ON (click badges to bind live signals)'
        : 'Signal linking: OFF'}
      placement="right"
    >
      <IconButton
        size="small"
        data-testid="signal-link-mode-toggle"
        aria-label="Toggle signal linking mode"
        aria-pressed={snapshot.explicit}
        onClick={() => setSignalLinkModeExplicit(!snapshot.explicit)}
        sx={{
          p: 0.75,
          color: snapshot.explicit ? 'primary.main' : 'text.disabled',
        }}
      >
        <SettingsInputComponent sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  );
}

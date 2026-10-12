// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Box } from '@mui/material';
import { ACTIVITY_BAR_WIDTH } from './layout-constants';

let anchor: HTMLElement | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getAnchor = () => anchor;

/** Registers the row's host beside the activity bar's agent icon. */
export function setAgentActivityAnchor(element: HTMLElement | null): void {
  if (anchor === element) return;
  anchor = element;
  listeners.forEach((listener) => listener());
}

/** Keeps the eye and status centered together; mobile has no activity-bar icon. */
export function AgentActivityRow({ children }: { children: ReactNode }) {
  const host = useSyncExternalStore(subscribe, getAnchor, getAnchor);
  const row = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: 'max-content',
      pointerEvents: 'none', ...(host ? {} : {
        position: 'fixed', left: ACTIVITY_BAR_WIDTH + 6, bottom: 50, zIndex: 9400,
      }) }}>
      {children}
    </Box>
  );
  return host ? createPortal(row, host) : row;
}

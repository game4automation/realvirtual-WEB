// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * event-queue-overlay.tsx -- bridges the DES toolbar's Event Queue button to the
 * `DESEventQueueWindow` (filter / category / footer).
 *
 * The open-state lives in a store (`event-queue-window-store`) so the
 * `DESControllerToolbar` button and this overlay share one source of truth.
 * Registered by `DESWorkspacePlugin` as a lazily imported `mode:des` overlay
 * (plan-680: one module in both builds, no stub any more). The live
 * runner is resolved from the active simulation kernel (re-checked on
 * mode/model changes).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { UISlotProps } from '../../../core/rv-ui-plugin';
import {
  isEventQueueWindowOpen, subscribeEventQueueWindow, setEventQueueWindowOpen,
} from '../../sim-controller/event-queue-window-store';
import { DESEventQueueWindow } from './DESEventQueueWindow';
import type { DESRunner } from '../des-runner';
import { getActiveDesRunner } from './des-active-runner';

export function EventQueueOverlay({ viewer }: UISlotProps) {
  const open = useSyncExternalStore(subscribeEventQueueWindow, isEventQueueWindowOpen);
  const [source, setSource] = useState<DESRunner | null>(null);

  useEffect(() => {
    const check = (): void => setSource(getActiveDesRunner(viewer));
    check();
    const u1 = viewer.on('simulation-mode-changed', check as (d: unknown) => void);
    const u2 = viewer.on('model-loaded', check as (d: unknown) => void);
    return () => { u1(); u2(); };
  }, [viewer]);

  if (!source) return null;
  return (
    <DESEventQueueWindow
      source={source}
      open={open}
      onClose={() => setEventQueueWindowOpen(false)}
    />
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for subscribing to maintenance mode state changes.
 *
 * Returns the current MaintenanceState from the MaintenancePlugin,
 * updated on every 'maintenance-mode-changed' event.
 */

import { useState, useEffect } from 'react';
import { useViewer } from './use-viewer';
import type {
  MaintenanceMode,
  MaintenanceState,
  StepResult,
} from '../plugins/demo/maintenance-plugin';

/** Default state when maintenance is idle. */
const IDLE_STATE: MaintenanceState = {
  mode: 'idle' as MaintenanceMode,
  procedure: null,
  currentStep: 0,
  stepResults: [],
  isCameraAnimating: false,
  isLive: false,
  renderModeLocked: false,
};

/**
 * The plugin's state at mount time. A component that mounts AFTER the guide
 * started (the MessagePanel swaps to the MaintenancePanel on the very event
 * that starts it) would otherwise sit in IDLE until the next change and render
 * nothing — the dialog never appeared (plan-522 Phase 5 finding).
 */
function initialState(viewer: ReturnType<typeof useViewer>): MaintenanceState {
  const plugin = viewer.getPlugin?.('maintenance') as { getState?(): MaintenanceState } | undefined;
  return plugin?.getState?.() ?? IDLE_STATE;
}

/** Subscribe to maintenance-mode-changed events. Returns current state. */
export function useMaintenanceMode(): MaintenanceState {
  const viewer = useViewer();
  const [state, setState] = useState<MaintenanceState>(() => initialState(viewer));

  useEffect(() => {
    const off = viewer.on('maintenance-mode-changed' as string, (data: unknown) => {
      const d = data as {
        active: boolean;
        mode: MaintenanceMode;
        procedure: MaintenanceState['procedure'];
        currentStep: number;
        stepResults: StepResult[];
        isCameraAnimating: boolean;
        isLive?: boolean;
        renderModeLocked?: boolean;
      };
      setState({
        mode: d.mode,
        procedure: d.procedure,
        currentStep: d.currentStep,
        stepResults: d.stepResults,
        isCameraAnimating: d.isCameraAnimating,
        isLive: d.isLive ?? false,
        renderModeLocked: d.renderModeLocked ?? false,
      });
    });
    return off;
  }, [viewer]);

  return state;
}

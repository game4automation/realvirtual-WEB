// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectionModeToggle — the Simulation / PLC toggle (plan-539 F15).
 *
 * Sits next to the simulation controls (TopBar leading slot) in the Viewer and
 * Commissioning workspaces. Shows the current mode — "Simulation" (the model's
 * virtual PLC runs), "PLC" (a real PLC owns the outputs) or "PLC (interface)"
 * (a live interface is connected; locked) — and switches it on click through
 * `viewer.connectionMode`, which also writes `StartMode` into the document so
 * the next save keeps it.
 */

import { useSyncExternalStore } from 'react';
import { Memory, SettingsInputComponent } from '@mui/icons-material';
import type { UISlotEntry, UISlotProps } from '../rv-ui-plugin';
import { ActionGroupPill, ActionSegment } from './action-group';
import { modeContext } from '../rv-mode-manager';
import { connectionModeLabel, type ConnectionModeState } from '../engine/rv-connection-mode';

export { connectionModeLabel };

/** Tooltip for a mode state. */
function connectionModeTitle(state: ConnectionModeState): string {
  if (state.locked) return 'A live PLC interface writes the model outputs — the virtual PLC is off. Disconnect the interface to switch.';
  return state.mode === 'Simulation'
    ? 'Simulation: the model\'s virtual PLC runs. Click to switch to PLC (a real PLC owns the outputs).'
    : 'PLC: virtual-PLC logic is off, a real PLC owns the outputs. Click to switch to Simulation.';
}

export function ConnectionModeToggle({ viewer }: UISlotProps) {
  const controller = viewer.connectionMode;
  // Re-render on every controller notification; the snapshot is a cheap key.
  const key = useSyncExternalStore(
    (cb) => {
      const off1 = controller.subscribe(cb);
      const off2 = viewer.on?.('connection-state-changed', cb);
      const off3 = viewer.on?.('simulation-pause-changed', cb);
      return () => {
        off1();
        if (typeof off2 === 'function') off2();
        if (typeof off3 === 'function') off3();
      };
    },
    () => {
      const s = controller.state;
      return `${s.mode}|${s.source}|${s.locked}|${s.interfaceConnected}|${viewer.isSimulationPaused}`;
    },
  );
  void key;
  const state = controller.state;
  // Only relevant while an interface is connected and the simulation runs —
  // hidden in pure edit (paused) and in plain standalone simulation.
  if (!state.interfaceConnected || viewer.isSimulationPaused) return null;
  const label = connectionModeLabel(state);
  // Compact state readout: SIM / PLC; the full sentence lives in the tooltip.
  const plc = state.mode !== 'Simulation';
  return (
    <ActionGroupPill>
      <ActionSegment
        title={`${label} — ${connectionModeTitle(state)}`}
        icon={plc ? <SettingsInputComponent /> : <Memory />}
        label={plc ? 'PLC' : 'SIM'}
        color={state.locked ? 'success.main' : undefined}
        sx={{ fontSize: 12, letterSpacing: 0.5 }}
        onClick={() => {
          if (state.locked) return;
          controller.setMode(plc ? 'Simulation' : 'PLC');
        }}
        buttonProps={{
          'data-testid': 'connection-mode-toggle',
          'aria-label': `Simulation / PLC mode: ${label}`,
          'aria-disabled': state.locked,
        }}
      />
    </ActionGroupPill>
  );
}

/** UI registration — the viewer registers it lazily (plan-539 F15). */
export const CONNECTION_MODE_UI: { id: string; slots: UISlotEntry[] } = {
  id: 'connection-mode',
  slots: [{
    slot: 'toolbar-status',
    component: ConnectionModeToggle,
    order: 12,
    visibilityId: 'connection-mode-toggle',
    // Viewer + Commissioning only (the Planner, DES, HMI and Editor workspaces
    // have no virtual-PLC switch).
    visibilityRule: { shownOnlyInAny: [modeContext('viewer'), modeContext('commissioning')] },
  }],
};

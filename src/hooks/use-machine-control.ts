// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for subscribing to machine control state changes.
 *
 * Returns the current MachineControlState from the MachineControlPlugin,
 * updated on every 'machine-control-changed' event.
 */

import { useState, useEffect } from 'react';
import { useViewer } from './use-viewer';
import type {
  MachineState,
  MachineMode,
  MachineComponent,
  MachineControlState,
} from '../plugins/demo/machine-control-plugin';

/** Default state when no model is loaded. */
const INITIAL_STATE: MachineControlState = {
  state: 'STOPPED' as MachineState,
  mode: 'AUTO' as MachineMode,
  components: [],
  errorComponentIdx: -1,
};

/** Subscribe to machine-control-changed events. Returns current state. */
export function useMachineControl(): MachineControlState {
  const viewer = useViewer();
  const [state, setState] = useState<MachineControlState>(INITIAL_STATE);

  useEffect(() => {
    const off = viewer.on('machine-control-changed' as string, (data: unknown) => {
      const d = data as {
        state: MachineState;
        mode: MachineMode;
        components: MachineComponent[];
        errorComponentIdx: number;
      };
      setState({
        state: d.state,
        mode: d.mode,
        components: d.components,
        errorComponentIdx: d.errorComponentIdx,
      });
    });
    return off;
  }, [viewer]);

  return state;
}

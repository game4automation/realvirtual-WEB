// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for subscribing to multiuser state changes.
 *
 * Returns the current MultiuserSnapshot from the MultiuserPlugin,
 * updated on every 'multiuser-changed' event.
 */

import { useState, useEffect } from 'react';
import { useViewer } from './use-viewer';
import type { MultiuserSnapshot } from '../plugins/multiuser-plugin';

/** Default state when MultiuserPlugin is not loaded. */
const INITIAL: MultiuserSnapshot = {
  connected: false,
  status: 'idle',
  statusMessage: '',
  serverUrl: '',
  localName: 'Browser',
  localRole: 'observer',
  playerCount: 0,
  players: [],
};

/** Subscribe to multiuser-changed events. Returns current snapshot. */
export function useMultiuser(): MultiuserSnapshot {
  const viewer = useViewer();
  const [state, setState] = useState<MultiuserSnapshot>(INITIAL);

  useEffect(() => {
    const off = viewer.on('multiuser-changed' as string, (data: unknown) => {
      setState(data as MultiuserSnapshot);
    });
    return off;
  }, [viewer]);

  return state;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for interface connection status.
 *
 * Subscribes to 'interface-connected' and 'interface-disconnected' events.
 *
 * Usage:
 *   const connected = useInterfaceStatus('keba-interface');
 */

import { useState, useEffect } from 'react';
import { useViewer } from './use-viewer';

/** Returns true if the specified interface is connected. */
export function useInterfaceStatus(interfaceId: string): boolean {
  const viewer = useViewer();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const off1 = viewer.on('interface-connected', (d) => {
      if (d.interfaceId === interfaceId) setConnected(true);
    });
    const off2 = viewer.on('interface-disconnected', (d) => {
      if (d.interfaceId === interfaceId) setConnected(false);
    });
    return () => { off1(); off2(); };
  }, [viewer, interfaceId]);

  return connected;
}

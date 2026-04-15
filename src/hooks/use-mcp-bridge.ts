// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for subscribing to MCP bridge state changes.
 *
 * Returns the current McpBridgeSnapshot from the McpBridgePlugin,
 * updated on every 'mcp-bridge-changed' event.
 */

import { useState, useEffect } from 'react';
import { useViewer } from './use-viewer';
import type { McpBridgeSnapshot } from '../plugins/mcp-bridge-plugin';

/** Default state when MCP plugin is not loaded or model not yet available. */
const INITIAL: McpBridgeSnapshot = {
  connected: false,
  port: '18712',
  toolCount: 0,
  toolNames: [],
  enabled: false,
  reconnectAttempt: 0,
  reconnectDelay: 0,
};

/** Subscribe to mcp-bridge-changed events. Returns current snapshot. */
export function useMcpBridge(): McpBridgeSnapshot {
  const viewer = useViewer();
  const [state, setState] = useState<McpBridgeSnapshot>(INITIAL);

  useEffect(() => {
    const off = viewer.on('mcp-bridge-changed' as string, (data: unknown) => {
      setState(data as McpBridgeSnapshot);
    });
    return off;
  }, [viewer]);

  return state;
}

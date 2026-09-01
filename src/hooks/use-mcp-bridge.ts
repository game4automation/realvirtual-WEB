// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for subscribing to MCP bridge state changes.
 *
 * Returns the current McpBridgeSnapshot from the McpBridgePlugin,
 * updated on every 'mcp-bridge-changed' event.
 */

import { useViewerEvent } from './use-viewer-event';
import { useViewer } from './use-viewer';
import type { McpBridgePluginAPI } from '../core/types/plugin-types';
// plan-713 NF3 — the ONE value import that kept the ~168 kB MCP cluster in the
// eager entry bundle, even though main.ts loads the bridge lazily. It points at
// the leaf constants module now; the type import below is erased at compile time
// and costs nothing.
import { DEFAULT_BRIDGE_PORT } from '../plugins/mcp-bridge/rv-mcp-bridge-ports';
import type { McpBridgeSnapshot, McpServerLogLine } from '../plugins/mcp-bridge-plugin';

/** Default state when MCP plugin is not loaded or model not yet available. */
const INITIAL: McpBridgeSnapshot = {
  connected: false,
  port: DEFAULT_BRIDGE_PORT,
  toolCount: 0,
  toolNames: [],
  enabled: false,
  reconnectAttempt: 0,
  reconnectDelay: 0,
  serverStatus: null,
};

/**
 * Subscribe to mcp-bridge-changed events. Returns the current snapshot.
 *
 * Seeds from the plugin's live snapshot on mount so a persisted (restored)
 * enabled/port state is shown immediately — the plugin's `init()` emit happens
 * before this component subscribes, so without seeding the UI would briefly
 * show the disabled default after a page reload.
 */
export function useMcpBridge(): McpBridgeSnapshot {
  const viewer = useViewer();
  const plugin = viewer.getPlugin<McpBridgePluginAPI & { getSnapshot?: () => McpBridgeSnapshot }>('mcp-bridge');
  const initial = plugin?.getSnapshot?.() ?? INITIAL;
  return useViewerEvent('mcp-bridge-changed', initial, (data) => data);
}

const NO_LOG: McpServerLogLine[] = [];

/** Subscribe to mcp-bridge-log events. Returns the buffered server log lines (seeded from the plugin on mount). */
export function useMcpBridgeLog(): McpServerLogLine[] {
  const viewer = useViewer();
  const plugin = viewer.getPlugin<McpBridgePluginAPI & { serverLog?: McpServerLogLine[] }>('mcp-bridge');
  const initial = plugin?.serverLog ?? NO_LOG;
  return useViewerEvent('mcp-bridge-log', initial, (data) => data);
}

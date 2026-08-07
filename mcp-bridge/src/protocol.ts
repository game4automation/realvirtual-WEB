// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Wire protocol shared between the Node bridge and the browser
 * (src/plugins/mcp-bridge-plugin.ts). The browser side is the source of truth;
 * these types mirror what it sends/expects and must stay in sync.
 */

export const DEFAULT_WEB_PORT = 18714;
export const WS_PATH = '/webviewer';

/** JSON-Schema fragment for a single tool's inputs (as produced by generateToolSchemas). */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

/**
 * MCP standard tool annotations (spec revision 2025-03-26). Announced by the browser and
 * forwarded verbatim to the MCP client — the SAME wire field CONNECT reads, so both transports
 * announce identically. A hint, never an authorisation boundary: missing or false means write.
 */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
}

/** A browser-announced tool. */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /** Side-effect classification; passed through to the MCP client unchanged. */
  annotations?: ToolAnnotations;
  /** Per-call timeout hint in ms (long-running tools like screenshot bursts).
   *  Bridge-internal — stripped before the tool list is served to the MCP client. */
  timeoutMs?: number;
}

// ── browser → server ──

export interface DiscoverMessage {
  type: 'discover';
  tools: ToolSchema[];
  instructions?: string;
  schema_version?: string;
}

export interface ResultMessage {
  type: 'result';
  id: number;
  result?: string;
  error?: string;
}

export type ControlAction = 'pause' | 'resume' | 'shutdown';

export interface ControlMessage {
  type: 'control';
  action: ControlAction;
}

export type BrowserMessage = DiscoverMessage | ResultMessage | ControlMessage;

// ── server → browser ──

export interface CallMessage {
  type: 'call';
  id: number;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface LogLine {
  level: string;
  ts: number;
  msg: string;
}

export interface LogMessage {
  type: 'log';
  lines: LogLine[];
}

/**
 * Live bridge health, pushed to the browser so the UI can show the FULL chain
 * (browser ⟷ bridge ⟷ AI client), not just the WebSocket leg. A browser being
 * connected to the bridge says nothing about whether a real Claude is attached;
 * this frame closes that gap.
 */
export interface BridgeStatus {
  /** OS process id of this bridge — disambiguates duplicate/stale bridges. */
  pid: number;
  /** Bound WebSocket port. */
  port: number;
  /** Bridge process uptime in ms. */
  uptimeMs: number;
  /** MCP host that launched us (initialize clientInfo.name), e.g. "claude-code". null = not yet initialized. */
  clientName: string | null;
  clientVersion: string | null;
  /** True once an MCP host (Claude) has completed the initialize handshake. */
  clientConnected: boolean;
  /** ms since the last MCP request (tools/list or a tool call); null = none yet. */
  lastRequestAgoMs: number | null;
}

export interface StatusMessage {
  type: 'status';
  status: BridgeStatus;
}

export type ServerMessage = CallMessage | LogMessage | StatusMessage;

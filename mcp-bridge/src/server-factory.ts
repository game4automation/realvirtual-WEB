// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from './log.js';
import { ToolRegistry } from './tool-registry.js';
import { WebBridge } from './web-bridge.js';
import { DEFAULT_WEB_PORT, type BridgeStatus } from './protocol.js';

export interface BridgeServerOptions {
  port?: number;
  host?: string;
  /** Fail when the requested WS port is busy instead of probing higher ports. */
  strictPort?: boolean;
  /** Server `instructions` advertised at the MCP initialize handshake. */
  instructions?: string;
  callTimeoutMs?: number;
  logger?: Logger;
  /** Bind the WS server when the MCP client initializes (default true). */
  autoStart?: boolean;
  /** Called when the browser requests `control: shutdown`. */
  onShutdownRequested?: () => void;
}

export interface BridgeServer {
  server: Server;
  bridge: WebBridge;
  registry: ToolRegistry;
  logger: Logger;
}

/**
 * Wire a low-level MCP `Server` to a `WebBridge` + `ToolRegistry`.
 *
 * - ListTools  → current registry (browser-defined, dynamic).
 * - CallTool   → routed to the browser over WS (with kwargs-unwrap).
 * - discover   → registry replaced, `tools/list_changed` emitted.
 * - control    → pause/resume the bridge, or request shutdown via callback.
 *
 * Pure factory: no stdio, no process.exit, no signal handlers (see index.ts).
 */
export function createBridgeServer(opts: BridgeServerOptions = {}): BridgeServer {
  const logger = opts.logger ?? new Logger();
  const registry = new ToolRegistry();
  const bridge = new WebBridge({
    port: opts.port ?? DEFAULT_WEB_PORT,
    host: opts.host,
    strictPort: opts.strictPort,
    callTimeoutMs: opts.callTimeoutMs,
    logger,
  });
  // Mirror logs to the browser. No-ops until a browser is connected.
  logger.setSink((lines) => bridge.sendLog(lines));

  const server = new Server(
    { name: 'realvirtual-webviewer', version: '1.0.0' },
    { capabilities: { tools: { listChanged: true } }, instructions: opts.instructions ?? '' },
  );

  // ── live status: who's attached + last activity, pushed to the browser ──
  const startedAt = Date.now();
  let mcpInitialized = false;
  let lastRequestAt: number | null = null;

  const buildStatus = (): BridgeStatus => {
    // getClientVersion() exists on the SDK Server but is not in every type
    // shipped — read it defensively so a version bump can't break the build.
    const client = (server as unknown as {
      getClientVersion?: () => { name?: string; version?: string } | undefined;
    }).getClientVersion?.();
    return {
      pid: process.pid,
      port: bridge.port,
      uptimeMs: Date.now() - startedAt,
      clientName: client?.name ?? null,
      clientVersion: client?.version ?? null,
      clientConnected: mcpInitialized,
      lastRequestAgoMs: lastRequestAt === null ? null : Date.now() - lastRequestAt,
    };
  };
  const pushStatus = (): void => { if (bridge.connected) bridge.sendStatus(buildStatus()); };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    lastRequestAt = Date.now();
    return { tools: registry.list() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    lastRequestAt = Date.now();
    pushStatus(); // reflect "AI is active now" in the UI immediately
    const name = request.params.name;
    let args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // kwargs-unwrap: some MCP proxies (Claude Code) pass all args as a single
    // JSON-string under "kwargs". Mirror the Python bridge behaviour.
    const keys = Object.keys(args);
    if (keys.length === 1 && keys[0] === 'kwargs' && typeof args.kwargs === 'string') {
      try {
        const parsed = JSON.parse(args.kwargs);
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
      } catch { /* leave as-is */ }
    }

    if (!registry.has(name)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
        isError: true,
      };
    }

    try {
      // Long-running tools (screenshot bursts, editor drive verify) announce a
      // per-tool timeout in discover; undefined falls back to the bridge default.
      const result = await bridge.callBrowser(name, args, registry.timeoutMs(name));
      // Image tools return { __rvImage: { data, mimeType, ...metadata } } →
      // emit MCP image content so the assistant sees an actual image. Any
      // EXTRA fields (idmask legend, camera pose, bounds, crop rect, …) ride
      // along as a second text block — machine-readable metadata instead of
      // pixels burned into the frame.
      if (result.includes('__rvImage')) {
        try {
          const img = (JSON.parse(result) as { __rvImage?: Record<string, unknown> }).__rvImage;
          const data = img?.data;
          if (img && typeof data === 'string' && data.length > 0) {
            const { data: _d, mimeType, width, height, ...meta } = img;
            const content: Array<
              { type: 'image'; data: string; mimeType: string } | { type: 'text'; text: string }
            > = [{ type: 'image', data, mimeType: (mimeType as string) ?? 'image/png' }];
            if (Object.keys(meta).length > 0) {
              content.push({ type: 'text', text: JSON.stringify({ width, height, ...meta }) });
            }
            return { content, isError: false };
          }
        } catch { /* not an image payload — fall through to text */ }
      }
      return { content: [{ type: 'text', text: result }], isError: false };
    } catch (e) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }],
        isError: true,
      };
    }
  });

  // The browser also sends `instructions` in discover, but MCP instructions are
  // one-shot (sent only at the initialize handshake), so they are loaded from
  // webviewer.mcp.md at startup (see index.ts) and intentionally not updated here.
  bridge.on('discover', (tools) => {
    registry.replace(tools);
    void server.sendToolListChanged();
    // A browser just (re)connected and announced its tools — seed the UI with
    // the current chain status so it knows which AI client is attached.
    pushStatus();
  });

  // Browser gone: drop the now-unreachable tools so Claude stops advertising them.
  bridge.on('disconnect', () => {
    registry.clear();
    void server.sendToolListChanged();
  });

  bridge.on('control', (action) => {
    if (action === 'shutdown') opts.onShutdownRequested?.();
    else if (action === 'pause') bridge.setPaused(true);
    else if (action === 'resume') bridge.setPaused(false);
  });

  // Lazy WS bind: only after the MCP client has initialized, so two Claude
  // sessions do not both try to grab the port at process start. Also record
  // that a real MCP host (Claude) is now attached — surfaced in the status.
  server.oninitialized = () => {
    mcpInitialized = true;
    if (opts.autoStart !== false) void bridge.start();
  };

  // Heartbeat: refresh the browser's status view (uptime + "last AI activity")
  // a few times a minute. unref() so this timer never keeps the process alive.
  const statusTimer = setInterval(pushStatus, 4000);
  (statusTimer as { unref?: () => void }).unref?.();

  return { server, bridge, registry, logger };
}

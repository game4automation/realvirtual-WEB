// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Entry point: local MCP stdio server bridging Claude <-> realvirtual WEB browser.
 *
 * Runs on a SEPARATE port (18714 by default). The Unity Python server is left at its
 * old standard (Unity 18711 + its own WebViewer bridge 18712, no --no-webviewer); this
 * Node bridge runs in parallel on 18714, so both coexist without a conflict. Point the
 * browser at 18714 to use this Node bridge.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Logger } from './log.js';
import { createBridgeServer } from './server-factory.js';
import { DEFAULT_WEB_PORT } from './protocol.js';

// ── stdout/stderr hardening ─────────────────────────────────────────────────
// stdout belongs exclusively to the JSON-RPC stdio transport. A stray write
// (including an uncaught error stacktrace) would corrupt the channel, so route
// fatal conditions to stderr and exit instead of letting Node print to stdout.
const logger = new Logger();

process.on('uncaughtException', (err) => {
  process.stderr.write(`[fatal] uncaughtException: ${err.stack ?? String(err)}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`[fatal] unhandledRejection: ${detail}\n`);
  process.exit(1);
});

// ── CLI args ────────────────────────────────────────────────────────────────
function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const port = Number(getArg('--web-port') ?? process.env.RV_WEB_PORT ?? DEFAULT_WEB_PORT);
const strictPort = process.argv.includes('--strict-web-port');

// ── instructions: read webviewer.mcp.md from disk (NOT a Vite ?raw import) ────
function loadInstructions(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // .../mcp-bridge/dist
    const mdPath = resolve(here, '..', '..', 'webviewer.mcp.md'); // WebViewer root
    return readFileSync(mdPath, 'utf8');
  } catch (e) {
    logger.warn(`Could not read webviewer.mcp.md: ${(e as Error).message}`);
    return '';
  }
}

// ── wire up ──────────────────────────────────────────────────────────────────
const { server, bridge } = createBridgeServer({
  port,
  strictPort,
  instructions: loadInstructions(),
  logger,
  onShutdownRequested: () => { void shutdown(0); },
});

let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down...');
  try { await bridge.close(); } catch { /* ignore */ }
  try { await server.close(); } catch { /* ignore */ }
  process.exit(code);
}
process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });

const transport = new StdioServerTransport();
await server.connect(transport);
logger.info(`MCP stdio transport connected (web port ${port}).`);

// When the MCP host (Claude Code / Desktop) goes away — window reload, client
// quit, or crash — its stdio pipe to us closes. Exit immediately so we RELEASE
// the WebSocket port instead of lingering as a zombie that keeps holding the
// port (and the browser tab) hostage for the next session. Without this, every
// host reload can leave a stale bridge behind, and the replacement bridge then
// hits EADDRINUSE and silently degrades (0 tools). This is the #1 stability fix.
server.onclose = () => { void shutdown(0); };
process.stdin.on('end', () => { void shutdown(0); });
process.stdin.on('close', () => { void shutdown(0); });

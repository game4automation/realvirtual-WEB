// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-bridge-ports — the two bridge port constants, and nothing else.
 *
 * A module for two strings looks absurd until you read what it buys (plan-713
 * NF3, measured and written up in `tests/bundle-splitting.test.ts`): `main.ts`
 * loads the MCP bridge through `await import(...)`, so the whole ~168 kB
 * cluster — plugin, editor tools, view tools, analyzer, embedded help markdown —
 * is MEANT to be lazy. It was dragged back into the eager entry by exactly one
 * value import of `DEFAULT_BRIDGE_PORT` in `src/hooks/use-mcp-bridge.ts`. Every
 * other importer uses `import type` and is erased.
 *
 * Six characters of string constant cost about five percent of the startup
 * bundle. Splitting them out costs one file and changes no behaviour: the
 * plugin re-exports both names, so nothing that imports them from there breaks.
 */

/**
 * Default bridge port: realvirtual CONNECT (plan-327 AP5). CONNECT is the standard
 * `web_*` transport — it needs neither Node nor Vite and is the only path that works
 * for a static WebViewer delivery. A profile that still carries a Node port (18714 /
 * 18715) keeps it: that counts as an explicitly pinned port, so the emergency
 * fallback survives the default change instead of being silently taken away.
 */
export const DEFAULT_BRIDGE_PORT = '5100';

/**
 * The Node bridge's historic default port — kept only as the documented fallback
 * (see `doc-ai-integration.md` → *Falling back to the Node bridge*).
 */
export const NODE_FALLBACK_PORT = '18714';

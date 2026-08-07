// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { ToolSchema } from './protocol.js';

/**
 * Self-managed registry of browser-announced tools.
 *
 * The low-level MCP `Server` does not own a tool list (unlike the high-level
 * `McpServer`), so we keep the list here and serve it from the ListTools handler.
 * `replace()` is called on every `discover`; `clear()` on browser disconnect.
 */
export class ToolRegistry {
  private readonly _tools = new Map<string, ToolSchema>();

  /** Replace the whole set with the announced tools (ignores entries without a name). */
  replace(tools: ToolSchema[]): void {
    this._tools.clear();
    for (const t of tools) {
      if (t && typeof t.name === 'string' && t.name.length > 0) {
        this._tools.set(t.name, t);
      }
    }
  }

  clear(): void {
    this._tools.clear();
  }

  has(name: string): boolean {
    return this._tools.has(name);
  }

  /** Per-call timeout hint announced by the browser for this tool (ms), if any. */
  timeoutMs(name: string): number | undefined {
    return this._tools.get(name)?.timeoutMs;
  }

  /**
   * Side-effect classification announced for this tool. Missing annotation or an explicit
   * `false` both mean "treat as a write" — the same secure-by-default rule CONNECT applies, so
   * a client sees one behaviour regardless of which bridge it talks to.
   */
  isReadOnly(name: string): boolean {
    return this._tools.get(name)?.annotations?.readOnlyHint === true;
  }

  /**
   * Tool list for the MCP client. Only the bridge-internal `timeoutMs` hint is stripped —
   * `annotations` is part of the MCP tool shape and must reach the client, otherwise the two
   * transports advertise the same tools differently.
   */
  list(): ToolSchema[] {
    return [...this._tools.values()].map(({ timeoutMs: _timeoutMs, ...rest }) => rest);
  }

  get size(): number {
    return this._tools.size;
  }
}

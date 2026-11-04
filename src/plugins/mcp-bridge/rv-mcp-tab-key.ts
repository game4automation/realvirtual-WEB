// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-tab-key.ts — plan-2220 (security review): the per-tab key CONNECT sends THIS tab, and only this tab,
 * in the `status` frames of its `/webviewer` channel. The AI panel presents it to `POST /ai/prompt`, so CONNECT
 * can tell whether the request comes from the current owner tab — only the owner's own opt-ins ("AI may control
 * SolidCraft") count, never another tab's. Null while the channel is down or the gateway predates the key.
 *
 * A leaf module on purpose: the private AI panel reads it without pulling in the MCP bridge cluster
 * (plan-713 NF3). The key is a secret: never log it, never put it in a URL.
 */

let tabKey: string | null = null;

/** Set by the MCP bridge from each `status` frame; null on disconnect. */
export function setBridgeTabKey(key: string | null): void {
  tabKey = typeof key === 'string' && key.length > 0 ? key : null;
}

/** The current key of this tab's CONNECT channel, or null. */
export function getBridgeTabKey(): string | null {
  return tabKey;
}

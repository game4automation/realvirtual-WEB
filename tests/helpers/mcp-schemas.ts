// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mcp-schemas — the schemas the MCP tool tests share (plan-707 Phase 3).
 *
 * It used to carry its own copy of the delegate list. Since plan-713 Phase 1
 * there is only ONE list — `McpBridgePlugin.mcpToolInstances`, backed by
 * `src/plugins/mcp-bridge/rv-mcp-instances.ts` — and this helper reads it
 * instead of restating it.
 *
 * That closes the drift class outright rather than one instance of it: the
 * plan-707 KNOWN GAP (`McpProjectTools` announced but linted by nothing until
 * plan-716 found it) and the still-open `McpSignalBindTools` omission in
 * `rv-mcp-bridge.test.ts` were both the same bug — four hand-maintained copies
 * of a list that has exactly one correct value.
 */

import {
  generateToolSchemasMulti,
  type ToolSchema,
} from '../../src/core/engine/rv-mcp-tools';
import { McpBridgePlugin } from '../../src/plugins/mcp-bridge-plugin';

/**
 * Every decorated instance whose tools are announced — read from the plugin, so
 * this can never disagree with what `_sendDiscover` sends.
 */
export function allInstances(): readonly object[] {
  return new McpBridgePlugin().mcpToolInstances;
}

/** Tools contributed per delegate class — the attributable half of the plan-713 baseline. */
export function delegateCensus(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const instance of allInstances()) {
    const name = instance.constructor.name;
    out[name] = (out[name] ?? 0) + generateToolSchemasMulti([instance]).length;
  }
  return out;
}

/** Merged schemas of every announced delegate instance. */
export function allSchemas(): ToolSchema[] {
  return generateToolSchemasMulti(allInstances());
}

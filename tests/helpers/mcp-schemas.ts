// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mcp-schemas — the ONE instance list the MCP tool tests share (plan-707 Phase 3).
 *
 * It used to live inside `rv-mcp-tool-conventions.test.ts` as a private
 * function. Three tests now need the same schemas (the convention lint, the
 * `web_describe` test and the documentation drift gate), and three private
 * copies of a list that must mirror `McpBridgePlugin._sendDiscover` is exactly
 * how one of them ends up stale.
 *
 * **Keep this in step with `mcp-bridge-plugin.ts::_sendDiscover`.** An instance
 * missing here means its tools are announced to agents but linted by nothing —
 * and, since plan-707, documented by nothing either.
 *
 * The plan-707 KNOWN GAP is closed (plan-716 Phase 5): `McpProjectTools` was
 * announced by `_sendDiscover` and absent here, so `web_model_list` — the tool
 * plan-716 §2.7 makes THE one document list, and the one the deprecated
 * `webScene*` aliases now point agents at — appeared in no generated reference
 * and was checked by no lint. The blocker was the domain vocabulary, not the
 * tools: `model` and `project` are two ordinary domains and are now in the
 * whitelist, and `web_ping` is a root-level probe like `web_status`.
 */

import { generateToolSchemasMulti, type ToolSchema } from '../../src/core/engine/rv-mcp-tools';
import { McpBridgePlugin } from '../../src/plugins/mcp-bridge-plugin';
import { McpViewTools } from '../../src/plugins/mcp-bridge/rv-mcp-view-tools';
import { McpObserveTools } from '../../src/plugins/mcp-bridge/rv-mcp-observe-tools';
import { McpEditorTools } from '../../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import { McpHelpTool } from '../../src/plugins/mcp-bridge/rv-mcp-help-tool';
import { McpSignalBindTools } from '../../src/plugins/mcp-bridge/rv-mcp-signal-bind-tools';
import { McpKnowledgeTools } from '../../src/plugins/mcp-bridge/rv-mcp-knowledge-tools';
import { McpDescribeTool } from '../../src/plugins/mcp-bridge/rv-mcp-describe-tool';
import { McpProjectTools } from '../../src/plugins/mcp-bridge/rv-mcp-project-tools';

/** Merged schemas of every linted delegate instance. */
export function allSchemas(): ToolSchema[] {
  return generateToolSchemasMulti([
    new McpBridgePlugin(),
    new McpViewTools(() => undefined),
    new McpObserveTools(() => undefined),
    new McpEditorTools(() => undefined),
    new McpSignalBindTools(() => undefined),
    new McpKnowledgeTools(() => undefined),
    new McpDescribeTool(() => undefined),
    new McpProjectTools(() => undefined),
    new McpHelpTool(),
  ]);
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The command interface has no remaining bound aliases.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { buildMultiDispatcher, generateToolSchemasMulti } from '../src/core/engine/rv-mcp-tools';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { boundAliasToolNames, macroCapableToolNames, McpCommandTools, withMacroMetaParams } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { ToolRegistry } from '../mcp-bridge/src/tool-registry';

describe('MCP command surface', () => {
  const instances = new McpBridgePlugin().mcpToolInstances;
  const dispatcher = buildMultiDispatcher(instances);
  const schemas = generateToolSchemasMulti(instances);
  const registry = new ToolRegistry();
  beforeAll(() => registry.replace(schemas));

  it('has no bound aliases or alias macro metadata', () => {
    expect(boundAliasToolNames(dispatcher).size).toBe(0);
    expect(macroCapableToolNames(dispatcher, commandRegistry).size).toBe(0);
    expect(withMacroMetaParams(schemas, new Set())).toEqual(schemas);
    expect(dispatcher.has('web_editor_set_field')).toBe(false);
    expect(registry.has('web_editor_set_field')).toBe(false);
  });

  it('lists the command interface and strips bridge-internal fields', () => {
    const tools = registry.list();
    for (const name of ['web_commands', 'web_execute', 'web_query', 'web_batch', 'web_status', 'web_help']) {
      expect(tools.some((tool) => tool.name === name), name).toBe(true);
    }
    for (const tool of tools) {
      expect(tool).not.toHaveProperty('listed');
      expect(tool).not.toHaveProperty('timeoutMs');
    }
  });

  it('web_commands omits retired tool metadata', async () => {
    const answer = JSON.parse(await new McpCommandTools(() => undefined).webCommands());
    expect(answer.commands.some((entry: { id: string }) => entry.id === 'editor.setField')).toBe(true);
    for (const entry of answer.commands) {
      expect(entry).not.toHaveProperty('tool');
      expect(entry).not.toHaveProperty('description');
    }
  });
});

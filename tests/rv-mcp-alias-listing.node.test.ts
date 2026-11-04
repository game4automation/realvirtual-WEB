// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 6: former aliases are unlisted tombstones, including with emergency switches.
 */

import { MOVED_TOOLS, movedToolSchemas } from '../src/plugins/mcp-bridge/rv-mcp-moved-tools';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildMultiDispatcher, generateToolSchemasMulti, type ToolSchema } from '../src/core/engine/rv-mcp-tools';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureEditorCommandsRegistered } from '../src/core/hmi/editor-command-descriptors';
import { ensureSimCommandsRegistered } from '../src/plugins/sim-controller/sim-commands';
import { ensureViewCommandsRegistered } from '../src/core/hmi/view-commands';
import { ensureSessionOverlayCommandsRegistered } from '../src/core/hmi/session-overlay-commands';
import { ensureComponentCommandsRegistered } from '../src/core/hmi/component-commands';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../src/core/hmi/signal-automap-commands';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import { ensurePlannerCommandsRegistered } from '../src/plugins/layout-planner/planner-commands';
import { ensureMechanismCommandsRegistered } from '../src/core/hmi/mechanism-command-descriptors';
import {
  McpCommandTools,
  aliasDescriptionOf,
  aliasesListed,
  boundAliasToolNames,
  LIST_ALIASES_STORAGE_KEY,
  macroCapableToolNames,
  setAliasDescriptions,
  withAliasListing,
  withMacroMetaParams,
} from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { ToolRegistry, aliasesListedFromEnv } from '../mcp-bridge/src/tool-registry';
import type { ToolSchema as BridgeToolSchema } from '../mcp-bridge/src/protocol';

let schemas: ToolSchema[];
let aliases: Set<string>;
let dispatcher: ReturnType<typeof buildMultiDispatcher>;

/** What a client receives from `tools/list` (bridge-internal fields stripped). */
function wireList(listAliases: boolean, announced: ToolSchema[]): BridgeToolSchema[] {
  const reg = new ToolRegistry(aliasesListedFromEnv(listAliases ? { RV_MCP_LIST_ALIASES: '1' } : {}));
  reg.replace(announced as BridgeToolSchema[]);
  return reg.list();
}

beforeAll(async () => {
  ensureEditorCommandsRegistered();
  ensureSimCommandsRegistered();
  ensureViewCommandsRegistered();
  ensureSessionOverlayCommandsRegistered();
  ensureComponentCommandsRegistered();
  ensureQueryCommandsRegistered();
  ensureDocumentCommandsRegistered();
  ensureSignalAutomapCommandsRegistered();
  ensureDesPlcCommandsRegistered();
  ensurePlannerCommandsRegistered();
  ensureMechanismCommandsRegistered();
  const { McpBridgePlugin } = await import('../src/plugins/mcp-bridge-plugin');
  const instances = new McpBridgePlugin().mcpToolInstances;
  dispatcher = buildMultiDispatcher(instances);
  schemas = withMacroMetaParams(generateToolSchemasMulti(instances), macroCapableToolNames(dispatcher, commandRegistry));
  aliases = boundAliasToolNames(dispatcher);
}, 240_000);

describe('plan-641 Nachtrag — aliases out of tools/list', () => {
  it('Phase 6 has 159 tombstones, hidden even with the emergency switch', () => {
    expect(MOVED_TOOLS).toHaveLength(159);
    for (const listAliases of [false, true]) {
      const announced = withAliasListing([...schemas, ...movedToolSchemas()], aliases,
        aliasesListed(listAliases ? '?mcpAliases=1' : '?mcpAliases=0'));
      for (const tombstone of announced.filter((s) => s.tombstone)) expect(tombstone.listed).toBe(false);
      const names = wireList(listAliases, announced).map((s) => s.name);
      const reg = new ToolRegistry(listAliases);
      reg.replace(announced as BridgeToolSchema[]);
      for (const moved of MOVED_TOOLS) {
        expect(names, moved.tool).not.toContain(moved.tool);
        expect(reg.has(moved.tool), moved.tool).toBe(true);
        expect(reg.isReadOnly(moved.tool), moved.tool).toBe(true);
      }
    }
  });

  it('measures the catalogue before / after', () => {
    const before = wireList(true, withAliasListing(schemas, aliases, false));
    const after = wireList(false, withAliasListing(schemas, aliases, false));
    const bytes = (l: unknown[]) => Buffer.byteLength(JSON.stringify({ tools: l }), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`[alias-listing] before: ${before.length} tools, ${bytes(before)} B (~${Math.round(bytes(before) / 4)} tok); `
      + `after: ${after.length} tools, ${bytes(after)} B (~${Math.round(bytes(after) / 4)} tok); bound aliases: ${aliases.size}; listed: ${after.length}; tombstones: ${MOVED_TOOLS.length}; bytes: ${bytes(after)}`);
    expect(after.length).toBe(before.length - aliases.size);
    expect(aliases.size).toBe(0);
    expect(macroCapableToolNames(dispatcher, commandRegistry).size).toBe(0);
    expect(withMacroMetaParams(schemas, new Set())).toEqual(schemas);
    if (process.env.RV_DUMP_ALIASES) console.log(`[alias-names] ${[...aliases].sort().map((a) => { const c = dispatcher.get(a)?.command; return a + "=" + (typeof c === "string" ? c : (c?.branches ?? []).map((b) => b.id).join("/")); }).join(",")}`);
  });

  it('bound aliases are missing from tools/list, the command interface stays', () => {
    const names = new Set(wireList(false, withAliasListing(schemas, aliases, false)).map((t) => t.name));
    for (const a of aliases) expect(names.has(a), a).toBe(false);
    for (const n of ['web_commands', 'web_execute', 'web_batch', 'web_status', 'web_help']) expect(names.has(n), n).toBe(true);
    expect(aliases.has('web_execute')).toBe(false);
  });

  it('retired aliases have no decorated handlers', () => {
    const reg = new ToolRegistry(false);
    reg.replace(withAliasListing(schemas, aliases, false) as BridgeToolSchema[]);
    for (const moved of MOVED_TOOLS) expect(dispatcher.has(moved.tool), moved.tool).toBe(false);
    expect(dispatcher.has('web_editor_set_field')).toBe(false);
    expect(reg.has('web_editor_set_field')).toBe(false);
  });

  it('no bridge-internal field reaches the client', () => {
    for (const t of wireList(true, withAliasListing(schemas, aliases, false))) {
      expect('listed' in t, t.name).toBe(false);
      expect('timeoutMs' in t, t.name).toBe(false);
    }
  });

  it('the switches leave the listed catalogue unchanged', () => {
    const full = wireList(false, withAliasListing(schemas, aliases, true)).map((t) => t.name);
    const nodeSide = wireList(true, withAliasListing(schemas, aliases, false)).map((t) => t.name);
    expect(nodeSide).toEqual(full);
    expect(aliases.size).toBe(0);
  });

  it('switch sources: URL, localStorage, env; default hidden', () => {
    const store = (v: string | null) => ({ getItem: (k: string) => (k === LIST_ALIASES_STORAGE_KEY ? v : null) });
    expect(aliasesListed('', store(null))).toBe(false);
    expect(aliasesListed('?mcpAliases=1', store(null))).toBe(true);
    expect(aliasesListed('?mcpAliases=0', store('1'))).toBe(false);
    expect(aliasesListed('', store('1'))).toBe(true);
    expect(aliasesListedFromEnv({})).toBe(false);
    expect(aliasesListedFromEnv({ RV_MCP_LIST_ALIASES: '1' })).toBe(true);
  });

  it('web_commands omits retired alias metadata without inventing a description', async () => {
    setAliasDescriptions(dispatcher, schemas);
    const d = aliasDescriptionOf('editor.setField');
    expect(d).toBeUndefined();
    const answer = JSON.parse(await new McpCommandTools(() => undefined).webCommands());
    const row = answer.commands.find((entry: { id: string }) => entry.id === 'editor.setField');
    expect(row).toBeDefined();
    for (const entry of answer.commands) {
      expect(entry).not.toHaveProperty('tool');
      expect(entry).not.toHaveProperty('description');
    }
  });
});

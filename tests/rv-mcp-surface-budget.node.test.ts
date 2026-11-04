// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { beforeAll, describe, expect, it } from 'vitest';
import { buildMultiDispatcher, generateToolSchemasMulti, type ToolSchema } from '../src/core/engine/rv-mcp-tools';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureEditorCommandsRegistered } from '../src/core/hmi/editor-command-descriptors';
import { boundAliasToolNames, macroCapableToolNames, withAliasListing, withMacroMetaParams } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { ensureSessionOverlayCommandsRegistered } from '../src/core/hmi/session-overlay-commands';
import { ensureComponentCommandsRegistered } from '../src/core/hmi/component-commands';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../src/core/hmi/signal-automap-commands';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import { ensureViewCommandsRegistered } from '../src/core/hmi/view-commands';
import { ensureSimCommandsRegistered } from '../src/plugins/sim-controller/sim-commands';
import { movedToolSchemas } from '../src/plugins/mcp-bridge/rv-mcp-moved-tools';

// plan-2007: Phase 0 measured 154; Phase 1 removes 14 writes. Final target: 70 browser + web_call_pending.
// plan-2007 Phase 2A: component fields, kinematize and two imports moved to commands.
// Phase 2B: five document / USD / automap tools moved to registry commands.
// Phase 3 retires eight mechanism authoring / sizing tools.
// Phase 4A retires 18 read-only mechanism, IK and editor tools.
// Phase 4B retires 16 queries; web_layout_timings retains its clearing operation.
// Phase 4C retires 15 runtime / remaining queries: 74 browser tools (+ CONNECT web_call_pending = 75).
// The three parametric tools (plan-2003) and layout_timings still remain beyond the planned 70.
const LISTED_MAX = 74;
let schemas: ToolSchema[];
let dispatcher: ReturnType<typeof buildMultiDispatcher>;
let aliases: Set<string>;

beforeAll(async () => {
  const { McpBridgePlugin } = await import('../src/plugins/mcp-bridge-plugin');
  const instances = new McpBridgePlugin().mcpToolInstances;
  dispatcher = buildMultiDispatcher(instances);
  ensureEditorCommandsRegistered();
  ensureSessionOverlayCommandsRegistered();
  ensureComponentCommandsRegistered();
  ensureQueryCommandsRegistered();
  ensureDocumentCommandsRegistered();
  ensureSignalAutomapCommandsRegistered();
  ensureDesPlcCommandsRegistered();
  ensureViewCommandsRegistered();
  ensureSimCommandsRegistered();
  aliases = boundAliasToolNames(dispatcher);
  schemas = withAliasListing(
    withMacroMetaParams(generateToolSchemasMulti(instances), macroCapableToolNames(dispatcher, commandRegistry)),
    aliases, false,
  );
  schemas.push(...movedToolSchemas().filter((s) => !dispatcher.has(s.name)));
}, 240_000);

describe('MCP surface budget (plan-2007)', () => {
  it('measures and bounds the listed surface', () => {
    const listed = schemas.filter((s) => s.listed !== false);
    const bytes = Buffer.byteLength(JSON.stringify(listed), 'utf8');
    console.info(`[surface-budget] listed=${listed.length}, bound=${aliases.size}, tombstones=${schemas.filter((s) => s.tombstone).length}, bytes=${bytes}, ~tokens=${Math.round(bytes / 4)}`);
    expect(listed.length).toBeLessThanOrEqual(LISTED_MAX);
  });

  it('keeps every tombstone unlisted, read-only and undecorated', () => {
    for (const s of movedToolSchemas()) {
      expect(schemas.find((entry) => entry.name === s.name)).toMatchObject({ listed: false, tombstone: true, annotations: { readOnlyHint: true } });
      expect(dispatcher.has(s.name), s.name).toBe(false);
    }
  });
});

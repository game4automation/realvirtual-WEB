// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ToolSchema } from '../src/core/engine/rv-mcp-tools';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { commandClassOf } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';
import { ensureEditorCommandsRegistered } from '../src/core/hmi/editor-command-descriptors';
import { ensurePlannerCommandsRegistered } from '../src/plugins/layout-planner/planner-commands';
import { ensureLibraryCommandsRegistered } from '../src/core/library/library-commands';
import { ensurePathNetworkCommandsRegistered } from '../src/plugins/path-network/path-network-commands';
import { ensureDiagnoseCommandsRegistered } from '../src/core/diagnostics/diagnose-command-descriptors';
import { ensureSimCommandsRegistered } from '../src/plugins/sim-controller/sim-commands';
import { ensureViewCommandsRegistered } from '../src/core/hmi/view-commands';
import { ensureSessionOverlayCommandsRegistered } from '../src/core/hmi/session-overlay-commands';
import { ensureComponentCommandsRegistered } from '../src/core/hmi/component-commands';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../src/core/hmi/signal-automap-commands';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import { setCommandStepHooks } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { ToolRegistry } from '../mcp-bridge/src/tool-registry';
import type { ToolSchema as BridgeToolSchema } from '../mcp-bridge/src/protocol';
type Bridge = {
  _aiEnabled: boolean;
  _emitChanged: () => void;
  _ws: { readyState: number; send: (raw: string) => void };
  _sendDiscover: () => void;
  _handleMessage: (raw: string) => Promise<void>;
};
let bridge: Bridge;
let schemas: ToolSchema[];
const frames: Array<{ type: string; id?: number; tools?: ToolSchema[]; result?: string; error?: string }> = [];
afterAll(() => setCommandStepHooks(null));
beforeAll(async () => {
  ensureEditorCommandsRegistered();
  ensurePlannerCommandsRegistered();
  ensureLibraryCommandsRegistered();
  ensurePathNetworkCommandsRegistered();
  ensureDiagnoseCommandsRegistered();
  ensureSimCommandsRegistered();
  ensureViewCommandsRegistered();
  ensureSessionOverlayCommandsRegistered();
  ensureComponentCommandsRegistered();
  ensureQueryCommandsRegistered();
  ensureDocumentCommandsRegistered();
  ensureSignalAutomapCommandsRegistered();
  ensureDesPlcCommandsRegistered();
  const { McpBridgePlugin } = await import('../src/plugins/mcp-bridge-plugin');
  bridge = new McpBridgePlugin() as unknown as Bridge;
  bridge._aiEnabled = true;
  bridge._emitChanged = () => {};
  bridge._ws = { readyState: 1, send: (raw) => frames.push(JSON.parse(raw)) };
  bridge._sendDiscover();
  schemas = frames.find((frame) => frame.type === 'discover')!.tools!;
}, 240_000);

describe('MCP retired tool removal', () => {
  it.each([
    ['component.setFields', 'edit', undefined],
    ['editor.kinematize', 'edit', 60_000],
    ['editor.importGlb', 'file', 120_000],
    ['editor.importCad', 'file', 600_000],
  ] as const)('Phase 2A metadata: %s', (id, toolClass, timeoutMs) => {
    const d = commandRegistry.get(id)!;
    expect(d).toMatchObject({ readOnly: false, macro: true });
    expect(commandClassOf(d)).toBe(toolClass);
    expect(d.timeoutMs).toBe(timeoutMs);
    expect(d.cancellable).toBeUndefined();
    expect(d.scope).toBe(id === 'component.setFields' ? 'none' : 'editor');
    expect(d.undoLabel).toBeTruthy();
  });
  it('leaves no tombstones in discovery or the client tool list', () => {
    expect(existsSync(new URL('../src/plugins/mcp-bridge/rv-mcp-moved-tools.ts', import.meta.url))).toBe(false);
    const registry = new ToolRegistry();
    registry.replace(schemas as BridgeToolSchema[]);
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of [...schemas, ...registry.list()]) {
      expect(schema).not.toHaveProperty('tombstone');
      expect(schema.description).not.toMatch(/^MOVED/);
    }
  });

  it('contains no source references to the removed mechanism', () => {
    function sources(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? sources(path) : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
      });
    }
    for (const root of ['../src/', '../mcp-bridge/src/']) {
      for (const path of sources(fileURLToPath(new URL(root, import.meta.url)))) {
        expect(readFileSync(path, 'utf8'), path).not.toMatch(/MOVED_TOOLS|movedToolAnswer|mcpAliases|RV_MCP_LIST_ALIASES/);
      }
    }
  });

  it.each(['web_component_set', 'web_editor_set_field', 'web_signal_set_bool', 'web_unknown_242'])(
    '%s receives the ordinary unknown-tool answer', async (tool) => {
      await bridge._handleMessage(JSON.stringify({ type: 'call', id: 242, tool, arguments: {} }));
      const frame = frames.at(-1)!;
      expect(frame).toMatchObject({ type: 'result', id: 242, error: `Unknown tool: ${tool}` });
      expect(frame.result).toBeUndefined();
      expect(frame.error).not.toContain('MOVED');
    },
  );
});

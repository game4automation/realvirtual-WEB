// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { listToolEntries } from '../src/core/engine/rv-mcp-tools';
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
import { withAliasListing } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { MOVED_TOOLS, MOVED_TOOLS_REMOVE_AT, movedToolAnswer, movedToolOf, movedToolSchemas, semverGte, type MovedTool } from '../src/plugins/mcp-bridge/rv-mcp-moved-tools';

let decorated: Set<string>;
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
  decorated = new Set(new McpBridgePlugin().mcpToolInstances.flatMap((i) => listToolEntries(i).map((e) => e.name)));
}, 240_000);

const synthetic: MovedTool = {
  tool: 'web_old', movedTo: ['test.inspect', 'test.list'], door: 'web_query',
  example: 'web_query("test.inspect")',
};

describe('plan-2007 moved tools', () => {
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
  it('has exactly one tombstone per name and concrete examples with real argument names', () => {
    expect(new Set(MOVED_TOOLS.map((m) => m.tool)).size).toBe(MOVED_TOOLS.length);
    for (const m of MOVED_TOOLS) {
      expect(m.example).not.toContain('\n');
      const call = /^(web_execute|web_query)\("([^"]+)", (.*)\)$/.exec(m.example);
      expect(call, m.tool).not.toBeNull();
      expect(call![1]).toBe(m.door);
      expect(m.movedTo).toContain(call![2]);
      const args = JSON.parse(call![3]);
      const desc = commandRegistry.get(call![2])!;
      for (const key of Object.keys(args)) expect(key in desc.argsSchema, `${m.tool}: ${key}`).toBe(true);
    }
  });

  it('has registered targets, the matching door, and no remaining decorator', () => {
    for (const m of MOVED_TOOLS) {
      expect(m.movedTo.length, m.tool).toBeGreaterThan(0);
      for (const id of m.movedTo) expect(commandRegistry.get(id), id).toBeDefined();
      expect(m.door === 'web_query', m.tool).toBe(m.movedTo.every((id) => commandRegistry.get(id)?.readOnly === true));
      expect(decorated.has(m.tool), m.tool).toBe(false);
    }
  });

  it('answers with the replacement commands, door, example and deadline', () => {
    expect(movedToolOf('web_old', [synthetic])).toBe(synthetic);
    expect(movedToolOf('web_missing', [synthetic])).toBeUndefined();
    expect(JSON.parse(movedToolAnswer(synthetic))).toEqual({
      error: 'MOVED', message: 'web_old moved to command test.inspect, test.list — use web_query',
      movedTo: ['test.inspect', 'test.list'], use: 'web_query', example: synthetic.example, removedAfter: '6.7.0',
    });
  });

  it('keeps tombstones unlisted even with the alias switch', () => {
    const schemas = movedToolSchemas([synthetic]);
    expect(schemas[0]).toMatchObject({
      name: 'web_old', listed: false, tombstone: true, annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    });
    expect(withAliasListing(schemas, new Set(), true)[0].listed).toBe(false);
    expect(withAliasListing([{ ...schemas[0], listed: true }], new Set(), true)[0].listed).toBe(false);
  });

  it('requires tombstone removal by the release deadline', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(semverGte(pkg.version, MOVED_TOOLS_REMOVE_AT), 'remove tombstones (plan-2007 §2.3c)').toBe(false);
  });

  it.each([
    ['6.5.0', '6.7.0', false], ['6.7.0', '6.7.0', true], ['6.7.1', '6.7.0', true],
    ['6.10.0', '6.7.9', true], ['7.0.0', '6.99.99', true], ['6.7.0-rc.1', '6.7.0', true],
    ['6.6.99', '6.7.0-rc.2', false], ['6.7.1', '6.7.2', false],
  ])('compares %s >= %s as %s', (a, b, expected) => {
    expect(semverGte(a, b)).toBe(expected);
  });
});

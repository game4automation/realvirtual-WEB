// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry, CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureSimCommandsRegistered } from '../src/plugins/sim-controller/sim-commands';
import { ensureSessionOverlayCommandsRegistered } from '../src/core/hmi/session-overlay-commands';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureKnowledgeCommandsRegistered } from '../src/plugins/mcp-bridge/rv-mcp-knowledge-tools';
import { ensureDocumentInfoCommandsRegistered } from '../src/plugins/mcp-bridge/rv-mcp-document-info-tools';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { commandClassOf } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';
import { getSensorDataStore } from '../src/core/engine/rv-sensor-data-store';

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({
    getSnapshot: () => ({ project: null }), getProject: () => null, getBackend: () => null,
  }),
}));
vi.mock('../src/core/editor/active-document-view', () => ({
  resolveActiveDocumentView: () => null,
}));
vi.mock('../src/core/hmi/prompt-task-store', () => ({
  getPromptTaskStore: () => ({
    listSerialized: (includeClaimed: boolean) => JSON.stringify({
      tasks: includeClaimed ? [{ id: 'claimed', status: 'claimed' }] : [],
      open: 0, claimed: 1, truncated: false,
    }),
  }),
}));

const CASES: Array<[string, string, Record<string, string>]> = [
  ['web_drive_list', 'drive.list', {}],
  ['web_sensor_list', 'sensor.list', {}],
  ['web_sensor_read', 'sensor.read', { path: 'string' }],
  ['web_transport_status', 'transport.status', {}],
  ['web_logic_flow', 'logic.flow', {}],
  ['web_trace_top', 'trace.top', { view: 'string', range: 'string', n: 'number' }],
  ['web_collision_status', 'collision.status', { includeBodies: 'boolean' }],
  ['web_group_list', 'group.list', {}],
  ['web_knowledge_get', 'knowledge.get', { path: 'string' }],
  ['web_knowledge_list', 'knowledge.list', { query: 'string', limit: 'number' }],
  ['web_document_info_get', 'document.infoGet', { document: 'string' }],
  ['web_import_usd_extras', 'document.usdExtrasPreview', { path: 'string' }],
  ['web_link_compose', 'link.compose', { model: 'string', glb: 'string', doc: 'string', scene: 'string', mode: 'string', option: 'string', base: 'string' }],
  ['web_part_lookup', 'part.lookup', { name: 'string' }],
  ['web_prompt_list', 'prompt.list', { includeClaimed: 'boolean' }],
];
function register(registry = commandRegistry) {
  ensureQueryCommandsRegistered(registry);
  ensureSimCommandsRegistered(registry);
  ensureSessionOverlayCommandsRegistered(registry);
  ensureDocumentCommandsRegistered(registry);
  ensureKnowledgeCommandsRegistered(registry);
  ensureDocumentInfoCommandsRegistered(registry);
}
const viewer = {
  modes: { activeMode: 'hmi', has: () => true }, getPlugin: () => undefined,
  collisionManager: { bodies: [], pairs: [], activePairs: [] },
} as unknown as RVViewer;
const query = async (id: string, args = {}, v = viewer) => {
  const result = JSON.parse(await new McpCommandTools(() => v).webQuery(id, JSON.stringify(args)));
  expect(result).toHaveProperty('value');
  return result.value;
};
beforeAll(() => register());
afterEach(() => { commandRegistry.attachViewer(undefined); getSensorDataStore().clear(); });

describe('plan-2007 Phase 4C query parity', { timeout: 30_000 }, () => {
  it.each(CASES)('%s retains the original parameters and a read-only command', (old, id, schema) => {
    const registry = new CommandRegistry();
    register(registry);
    const count = registry.list().length;
    register(registry);
    expect(registry.list()).toHaveLength(count);
    const d = registry.get(id)!;
    expect(d).toMatchObject({ readOnly: true, available: true, scope: 'none', argsSchema: schema });
    expect(Object.keys(d.argsSchema ?? {})).toEqual(Object.keys(schema));
    expect(d.macro).toBeUndefined();
    expect(d.undoLabel).toBeUndefined();
    expect(commandClassOf(d)).toBe('read');
  });

  it.each(CASES)('%s runs through web_query and preserves the empty-scene value', async (_old, id) => {
    const expected: Record<string, unknown> = {
      'drive.list': [], 'sensor.list': [], 'sensor.read': { sensors: [] },
      'transport.status': { error: 'No transport manager' },
      'logic.flow': { error: 'No logic engine' },
      'trace.top': { error: 'Path trace plugin not loaded' },
      'collision.status': { bodies: 0, bodiesByRole: {}, checkedPairs: 0, sessionWatched: 0, collisions: 0, pairs: [] },
      'group.list': { error: 'No group registry (no model loaded)' },
      'knowledge.get': { error: 'No registry available' },
      'knowledge.list': { error: 'No registry available' },
      'document.infoGet': { error: 'Nothing is loaded.' },
      'document.usdExtrasPreview': { error: 'No document is open.' },
      'part.lookup': { error: 'name is required' },
      'prompt.list': { tasks: [], open: 0, claimed: 1, truncated: false },
    };
    if (id === 'link.compose') {
      // Explicit identity/base avoids browser location and optional scene-store state.
      expect(await query(id, { scene: 'empty', base: 'https://example.org/viewer/' })).toEqual({
        url: 'https://example.org/viewer/?scene=empty&mode=hmi',
        params: { scene: 'empty', mode: 'hmi' }, warnings: [],
      });
    } else {
      expect(await query(id)).toEqual(expected[id]);
    }
  });

  it('keeps USD preview and link timeouts', () => {
    expect(commandRegistry.get('document.usdExtrasPreview')!.timeoutMs).toBe(120_000);
    expect(commandRegistry.get('link.compose')!.timeoutMs).toBe(30_000);
  });

  it('keeps drive rounding and sensor occupancy fields, and remains callable through web_execute', async () => {
    const drive = {
      name: 'Axis', currentPosition: 1.23456, targetPosition: 2.34567, targetSpeed: 3.45678,
      isRunning: true, jogForward: false, jogBackward: true,
      Direction: 'LinearX', UpperLimit: 10, LowerLimit: 0, Acceleration: 20,
    };
    const v = { ...viewer, drives: [drive], transportManager: { sensors: [{
      node: { name: 'Gate' }, occupied: true, mode: 'Collision',
      SensorOccupied: 'GateOn', SensorNotOccupied: 'GateOff',
    }] } } as unknown as RVViewer;
    const expected = [{
      name: 'Axis', currentPosition: 1.235, targetPosition: 2.346, targetSpeed: 3.457,
      isRunning: true, jogForward: false, jogBackward: true, direction: 'LinearX',
      upperLimit: 10, lowerLimit: 0, acceleration: 20,
    }];
    expect(await query('drive.list', {}, v)).toEqual(expected);
    expect(JSON.parse(await new McpCommandTools(() => v).webExecute('drive.list')).value).toEqual(expected);
    expect(await query('sensor.list', {}, v)).toEqual([{
      name: 'Gate', occupied: true, mode: 'Collision', signalOccupied: 'GateOn', signalNotOccupied: 'GateOff',
    }]);
  });

  it('passes includeClaimed through without consuming the queue', async () => {
    const expected = { tasks: [{ id: 'claimed', status: 'claimed' }], open: 0, claimed: 1, truncated: false };
    expect(await query('prompt.list', { includeClaimed: true })).toEqual(expected);
    expect(await query('prompt.list', { includeClaimed: true })).toEqual(expected);
  });
});

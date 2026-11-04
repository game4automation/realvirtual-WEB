// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryValue } from './helpers/query-value';
import { BoxGeometry, Mesh, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry, CommandRegistry, type CommandContext } from '../src/core/hmi/rv-command-registry';
import { ensureSessionOverlayCommandsRegistered } from '../src/core/hmi/session-overlay-commands';
import { ensureComponentCommandsRegistered } from '../src/core/hmi/component-commands';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureDocumentCommandsRegistered } from '../src/core/hmi/document-commands';
import { ensureSignalAutomapCommandsRegistered } from '../src/core/hmi/signal-automap-commands';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import { ensureViewCommandsRegistered } from '../src/core/hmi/view-commands';
import { ensureSimCommandsRegistered } from '../src/plugins/sim-controller/sim-commands';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { commandClassOf } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';
import { loadGroupVisibilitySettings, saveGroupVisibilitySettings } from '../src/core/hmi/group-visibility-store';

vi.mock('../src/core/hmi/rv-command-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/rv-command-registry')>();
  return { ...actual, commandRegistry: new actual.CommandRegistry() };
});
vi.mock('../src/plugins/mcp-bridge/rv-mcp-dialog-policy', () => ({
  installMcpDialogPolicy: vi.fn(async () => () => []),
}));

function register(registry = commandRegistry) {
  ensureSessionOverlayCommandsRegistered(registry);
  ensureComponentCommandsRegistered(registry);
  ensureQueryCommandsRegistered(registry);
  ensureDocumentCommandsRegistered(registry);
  ensureSignalAutomapCommandsRegistered(registry);
  ensureDesPlcCommandsRegistered(registry);
  ensureViewCommandsRegistered(registry);
  ensureSimCommandsRegistered(registry);
}

beforeEach(() => {
  register();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => {
  commandRegistry.attachViewer(undefined);
  vi.unstubAllGlobals();
});

const asViewer = (v: object) => v as RVViewer;
const read = async (p: Promise<string>) => JSON.parse(await p);
function fixture() {
  const node = new Object3D();
  const group = { name: 'Cover', visible: true, nodes: [node] };
  const collisionManager = {
    register: vi.fn(), unregister: vi.fn(), invalidate: vi.fn(), reset: vi.fn(),
    bodies: [{ key: 'Robot', role: 'Robot', meshes: [node], aabbOnly: false }],
    activePairs: [{ aPath: 'Robot', aRole: 'Robot', bPath: 'Floor', bRole: 'Environment', since: 2 }],
    pairs: [{}],
  };
  const modes = {
    activeMode: 'hmi', has: (mode: string) => ['hmi', 'des'].includes(mode),
    available: () => [{ id: 'hmi' }, { id: 'des' }], refusalReason: () => null,
    setModeAsync: vi.fn(async (mode: string) => { modes.activeMode = mode; }),
  };
  const viewer = asViewer({
    modes, collisionManager, registry: { getNode: (path: string) => path === 'Robot' ? node : undefined },
    groups: {
      get: (name: string) => name === 'Cover' ? group : undefined,
      getAll: () => [group], getGroupNames: () => ['Cover'],
      setVisible: (_name: string, visible: boolean) => { group.visible = visible; },
    },
    autoFilters: { isIsolateActive: true, showAll: vi.fn() },
    markRenderDirty: vi.fn(), markShadowsDirty: vi.fn(), exitIsolate: vi.fn(), isolateNodes: vi.fn(),
    setSourceMarkersVisible: vi.fn(), transportManager: { sources: [{}, {}] },
    getPlugin: () => ({ trace: { simTime: 12.34567 }, attachedTo: 'des' }),
  });
  return { viewer, collisionManager, modes };
}

describe('Phase 1 session command contracts', () => {
  it('registers eagerly once per registry with the original argument names and classes', () => {
    const registry = new CommandRegistry();
    register(registry);
    const count = registry.list().length;
    register(registry);
    expect(registry.list()).toHaveLength(count);
    const specs = [
      ['group.setVisible', { name: 'string', visible: 'boolean' }, false, 'edit'],
      ['group.setListed', { name: 'string', listed: 'boolean' }, false, 'edit'],
      ['view.isolate', { paths: 'string' }, false, 'edit'],
      ['view.sourceMarkers', { visible: 'boolean' }, false, 'edit'],
      ['trace.set', { blocked: 'boolean', utilization: 'boolean', range: 'string', windowSec: 'number' }, false, 'sim'],
      ['trace.state', {}, true, 'read'],
      ['collision.watch', { assignmentsJson: 'string' }, false, 'edit'],
      ['collision.reset', { clearWatch: 'boolean' }, false, 'edit'],
      ['collision.status', { includeBodies: 'boolean' }, true, 'read'],
      ['workspace.setMode', { mode: 'string' }, false, 'edit'],
      ['sim.setConnectionMode', { mode: 'string' }, false, 'sim'],
      ['sim.connectionMode', {}, true, 'read'],
    ] as const;
    for (const [id, argsSchema, readOnly, cls] of specs) {
      const descriptor = registry.get(id)!;
      expect(descriptor).toMatchObject({ argsSchema, readOnly, scope: 'none', available: true });
      expect(commandClassOf(descriptor)).toBe(cls);
      // plan-2007: view.isolate / view.sourceMarkers load their bodies lazily (eager startup graph).
      if (!id.startsWith('view.')) expect(descriptor.eagerImpl).toBeDefined();
      expect(descriptor.macro).not.toBe(true);
      expect(descriptor.undoLabel).toBeUndefined();
      expect(descriptor.mcp).toBeUndefined();
    }
  });

  it('reports original viewer and group preconditions', async () => {
    for (const id of ['group.setVisible', 'view.isolate', 'view.sourceMarkers', 'collision.watch', 'collision.reset', 'collision.status', 'workspace.setMode', 'sim.setConnectionMode', 'sim.connectionMode']) {
      const d = commandRegistry.get(id)!;
      const impl = d.eagerImpl ?? (await d.impl())!;
      expect(impl.enabled({ viewer: undefined } as unknown as CommandContext, {}))
        .toEqual({ reason: 'No viewer' });
    }
    expect(commandRegistry.enabled('group.setVisible', {}, asViewer({})))
      .toEqual({ reason: 'No group registry (no model loaded)' });
  });

  it('preserves group results and persisted isolation/exclusion behavior', async () => {
    const { viewer } = fixture();
    const tools = new McpCommandTools(() => viewer);
    saveGroupVisibilitySettings({ hiddenGroups: [], isolatedGroup: 'Cover', isolatedAutoFilter: 'Drive', excludedFromOverlay: ['Cover'], autoExcludedKinematic: ['Cover'] });
    expect((await read(tools.webExecute('group.setVisible', JSON.stringify({ name: 'Cover', visible: false })))).value)
      .toEqual({ ok: true, name: 'Cover', visible: false, members: 1 });
    expect(loadGroupVisibilitySettings()).toMatchObject({ hiddenGroups: ['Cover'], isolatedGroup: null, isolatedAutoFilter: null });
    expect(viewer.autoFilters?.showAll).toHaveBeenCalled();
    expect((await read(tools.webExecute('group.setListed', JSON.stringify({ name: 'Cover', listed: true })))).value)
      .toEqual({ ok: true, name: 'Cover', listed: true, excluded: [] });
    expect(loadGroupVisibilitySettings().autoExcludedKinematic).toEqual([]);
    expect((await read(tools.webExecute('group.setVisible', JSON.stringify({ name: 'missing', visible: true })))).value)
      .toEqual({ error: 'Unknown group "missing"', known: ['Cover'] });
  });

  it('separates trace reads from writes and retains validation and rounding', async () => {
    const { viewer } = fixture();
    const tools = new McpCommandTools(() => viewer);
    expect(await read(tools.webQuery('trace.set', '{"blocked":true}'))).toMatchObject({ kind: 'not-read-only' });
    const value = (await read(tools.webExecute('trace.set', '{"blocked":true,"utilization":false,"range":"start","windowSec":86400}'))).value;
    expect(value).toEqual({ blocked: true, utilization: false, range: 'start', windowSec: 86400, simTime: 12.3457, kernel: 'des' });
    expect((await read(tools.webQuery('trace.state'))).value).toEqual(value);
    expect(await read(tools.webExecute('trace.set', '{"range":"wrong"}'))).toMatchObject({
      status: 'failed', value: { error: 'Unknown range "wrong" — use window or start' },
    });
  });

  it('shares collision watches with the read-only status command and isolates viewers', async () => {
    const { viewer, collisionManager } = fixture();
    const tools = new McpCommandTools(() => viewer);
    const args = { assignmentsJson: JSON.stringify([{ path: 'Robot', role: 'Robot' }, { path: 'missing', role: 'Robot' }, { path: 'Robot', role: 'None' }]) };
    expect((await read(tools.webExecute('collision.watch', JSON.stringify(args)))).value).toEqual({
      registered: [{ path: 'Robot', role: 'Robot' }], missing: ['missing'], invalid: ['Robot (None)'],
      note: 'Bodies are rebuilt on the next simulation tick; check web_query("collision.status", {}) while the simulation runs.',
    });
    const status = (await read(tools.webQuery('collision.status', '{"includeBodies":true}'))).value;
    expect(status).toEqual({
      bodies: 1, bodiesByRole: { Robot: 1 }, checkedPairs: 1, sessionWatched: 1, collisions: 1,
      pairs: [{ a: 'Robot', aRole: 'Robot', b: 'Floor', bRole: 'Environment', since: 2 }],
      bodyList: [{ path: 'Robot', role: 'Robot', meshes: 1, aabbOnly: false }],
    });
    expect(await read(queryValue(viewer, 'collision.status', { includeBodies: true }))).toEqual(status);
    expect((await read(queryValue(fixture().viewer, 'collision.status'))).sessionWatched).toBe(0);
    expect((await read(tools.webExecute('collision.reset'))).value).toEqual({ ok: true, removedWatch: 0, remainingWatch: 1 });
    expect((await read(tools.webExecute('collision.reset', '{"clearWatch":true}'))).value).toEqual({ ok: true, removedWatch: 1, remainingWatch: 0 });
    expect(collisionManager.unregister).toHaveBeenCalledOnce();
  });

  it('frames the isolated mesh with the agent eye while leaving the user camera alone', async () => {
    const geometry = new BoxGeometry(2, 2, 2);
    const mesh = new Mesh(geometry);
    const eye = {
      ensure: vi.fn(), setPose: vi.fn(),
      pose: { px: 0, py: 0, pz: 5, tx: 0, ty: 0, tz: 0, fov: 45, aspect: 1 },
    };
    const viewer = asViewer({
      modes: { activeMode: 'hmi' }, registry: { getNode: () => mesh },
      agentEye: eye, isolateNodes: vi.fn(), camera: { marker: 'unchanged' },
    });
    const tools = new McpCommandTools(() => viewer);
    try {
      expect((await read(tools.webExecute('view.isolate', '{"paths":"Robot"}'))).value)
        .toEqual({ isolated: 1, active: true, framed: true });
      expect(eye.ensure).toHaveBeenCalledOnce();
      expect(eye.setPose).toHaveBeenCalledWith({
        px: expect.any(Number), py: expect.any(Number), pz: expect.any(Number),
        tx: expect.any(Number), ty: expect.any(Number), tz: expect.any(Number),
      });
      expect(viewer.camera).toEqual({ marker: 'unchanged' });
      expect(viewer.isolateNodes).toHaveBeenCalledWith([mesh], false);
    } finally { geometry.dispose(); }
  });

  it('preserves view results and awaits the workspace mode', async () => {
    const { viewer, modes } = fixture();
    const tools = new McpCommandTools(() => viewer);
    expect((await read(tools.webExecute('view.isolate'))).value).toEqual({ isolated: 0, active: false });
    expect((await read(tools.webExecute('view.isolate', '{"paths":"Robot,missing"}'))).value)
      .toEqual({ isolated: 1, active: true, framed: false, unresolved: ['missing'] });
    expect(viewer.isolateNodes).toHaveBeenCalledWith(expect.any(Array), false);
    expect((await read(tools.webExecute('view.sourceMarkers', '{"visible":false}'))).value)
      .toEqual({ ok: true, visible: false, affectedSources: 2 });
    expect((await read(tools.webExecute('workspace.setMode', '{"mode":"des"}'))).value)
      .toEqual({ mode: 'des', available: ['hmi', 'des'] });
    expect(modes.setModeAsync).toHaveBeenCalledWith('des');
  });
});

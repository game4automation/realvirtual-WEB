// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry, CommandRegistry } from '../src/core/hmi/rv-command-registry';
import { ensurePlannerCommandsRegistered } from '../src/plugins/layout-planner/planner-commands';
import { ensureLibraryCommandsRegistered } from '../src/core/library/library-commands';
import { ensureQueryCommandsRegistered } from '../src/core/hmi/query-commands';
import { ensureSignalBindCommandsRegistered } from '../src/plugins/mcp-bridge/rv-mcp-signal-bind-tools';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import { ensureDiagnoseCommandsRegistered } from '../src/core/diagnostics/diagnose-command-descriptors';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { MOVED_TOOLS } from '../src/plugins/mcp-bridge/rv-mcp-moved-tools';
import { commandClassOf } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';
import { registerPlcControl, registerPlcRuntime } from '../src/core/plc-control';
import { queryCommand } from './helpers/query-command';

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({ getProject: () => null, getBackend: () => null }),
}));
vi.mock('../src/core/library/library-store-singleton', () => ({
  getLibraryStore: () => ({ catalogUrls: [], catalogs: new Map(), catalogErrors: new Map() }),
}));

const CASES: Array<[string, string, string[]]> = [
  [
    "web_layout_list",
    "layout.list",
    []
  ],
  [
    "web_layout_export",
    "layout.export",
    []
  ],
  [
    "web_layout_snap_list",
    "layout.snapList",
    [
      "id"
    ]
  ],
  [
    "web_layout_snap_suggest",
    "layout.snapSuggest",
    [
      "targetId",
      "targetSnapName"
    ]
  ],
  [
    "web_library_list",
    "library.list",
    []
  ],
  [
    "web_catalog_list",
    "library.catalogList",
    [
      "source",
      "query",
      "limit"
    ]
  ],
  [
    "web_catalog_describe",
    "library.catalogDescribe",
    [
      "catalogId"
    ]
  ],
  [
    "web_signal_bindings_list",
    "signal.bindingsList",
    [
      "filter",
      "boundOnly",
      "limit"
    ]
  ],
  [
    "web_signal_sources_list",
    "signal.sourcesList",
    [
      "filter",
      "limit"
    ]
  ],
  [
    "web_signal_reconcile",
    "signal.reconcile",
    [
      "interfaceId"
    ]
  ],
  [
    "web_signal_usage",
    "signal.usage",
    [
      "name"
    ]
  ],
  [
    "web_des_components",
    "des.components",
    [
      "busyOnly"
    ]
  ],
  [
    "web_des_stats",
    "des.stats",
    []
  ],
  [
    "web_des_bottleneck",
    "des.bottleneck",
    []
  ],
  [
    "web_plc_status",
    "plc.status",
    [
      "program"
    ]
  ],
  [
    "web_des_status",
    "des.status",
    []
  ]
];
const register = (registry = commandRegistry) => {
  ensurePlannerCommandsRegistered(registry);
  ensureLibraryCommandsRegistered(registry);
  ensureSignalBindCommandsRegistered(registry);
  ensureDesPlcCommandsRegistered(registry);
  ensureDiagnoseCommandsRegistered(registry);
  ensureQueryCommandsRegistered(registry);
};
const viewer = { modes: { activeMode: 'hmi' }, getPlugin: () => undefined } as unknown as RVViewer;
beforeAll(() => { register(); registerPlcControl(null); registerPlcRuntime(null); });
afterEach(() => commandRegistry.attachViewer(undefined));

// The first web_query of a family lazy-loads its impl module (planner, library, signal);
// under a parallel suite that import alone can exceed vitest's 5 s default.
describe('plan-2007 Phase 4B query parity', { timeout: 30_000 }, () => {
  it.each(CASES)('%s has one query tombstone and the original argument names', (old, id, keys) => {
    const registry = new CommandRegistry();
    register(registry);
    const count = registry.list().length;
    register(registry);
    expect(registry.list()).toHaveLength(count);
    const d = registry.get(id)!;
    expect(d).toMatchObject({ readOnly: true, available: true, scope: 'none' });
    expect(d.macro).toBeUndefined();
    expect(d.undoLabel).toBeUndefined();
    expect(commandClassOf(d)).toBe('read');
    expect(Object.keys(d.argsSchema ?? {})).toEqual(keys);
    const moved = MOVED_TOOLS.filter((m) => m.tool === old);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ movedTo: [id], door: 'web_query' });
    expect(moved[0].example).toContain(`web_query("${id}",`);
  });

  it.each(CASES)('%s runs through web_query with the original empty-scene result', async (_old, id) => {
    if (id === 'des.status') {
      // Documented plan-2005 successor: richer status, with its existing disabled guard.
      const r = JSON.parse(await new McpCommandTools(() => viewer).webQuery(id, '{}'));
      expect(r).toMatchObject({ ok: false, kind: 'disabled', error: 'not in DES mode' });
      return;
    }
    let expected: unknown;
    if (id.startsWith('layout.') || id.startsWith('library.catalog')) {
      expected = { error: 'Layout planner not available — call web_execute("workspace.setMode", {mode:"planner"}) first' };
    } else if (id === 'library.list') {
      // plan-778 F10: the library PROJECTS of the open project ride along (none here).
      expected = { project: null, libraries: [], libraryProjects: [] };
    } else if (id === 'signal.bindingsList') {
      expected = { total: 0, matched: 0, returned: 0, truncated: false, slots: [], orphans: [] };
    } else if (id === 'signal.sourcesList') {
      expected = { error: 'No signal store available' };
    } else if (id === 'signal.reconcile') {
      expected = { error: 'Not connected to a CONNECT gateway — connect in the CONNECT panel first.' };
    } else if (id === 'signal.usage') {
      expected = { error: 'name is required' };
    } else if (id === 'plc.status') {
      expected = { error: 'PLC not available in this build' };
    } else {
      expected = { error: 'DES not active — call web_execute("workspace.setMode", {"mode":"des"}) first.' };
    }
    expect(await queryCommand(viewer, id)).toEqual(expected);
  });

  it('keeps layout snapshots, placement rows, free ports and catalog metadata', async () => {
    const root = new Object3D(); root.name = 'Fixture';
    const snapNode = new Object3D(); snapNode.name = 'Snap-XP-fixture'; root.add(snapNode);
    const entry = { id: 'fixture', name: 'Fixture', category: 'custom', glbUrl: '/fixture.glb' };
    const placement = { id: 'p1', catalogId: 'fixture', label: 'Fixture', position: [1, 2, 3], rotation: [0, 90, 0] };
    const snapshot = { placements: [placement], catalogs: ['/catalog.json'], grid: 0.1 };
    const planner = {
      store: { getSnapshot: () => ({ catalogs: new Map([['/catalog.json', { entries: [entry] }]]) }) },
      snapshotPlacements: () => ({ placements: [placement] }),
      snapshotAsLayoutFile: vi.fn(() => snapshot),
      getPlacedRootById: (id: string) => id === 'p1' ? root : undefined,
    };
    const snap = { object3D: snapNode, occupied: false, typeId: 'fixture', flow: 'out', dir: { axis: 'X', code: 'XP' } };
    const v = { ...viewer, getPlugin: (id: string) => id === 'layout-planner' ? planner
      : id === 'snap-point' ? { getRegistry: () => ({ getByOwnerRoot: () => [snap] }) } : undefined } as unknown as RVViewer;
    expect(await queryCommand(v, 'layout.export')).toEqual(snapshot);
    expect(planner.snapshotAsLayoutFile).toHaveBeenCalledWith('Untitled');
    expect(await queryCommand(v, 'layout.list')).toEqual([{ ...placement, bounds: null }]);
    expect(await queryCommand(v, 'layout.snapList', { id: 'p1' })).toEqual({
      id: 'p1', label: 'Fixture', freeSnaps: [{ snapName: snapNode.name, typeId: 'fixture', flow: 'out', axis: 'X', dirCode: 'XP' }], occupiedCount: 0,
    });
    expect(await queryCommand(v, 'layout.snapSuggest', { targetId: 'missing' })).toEqual({
      error: 'No placement "missing". Use web_query(\"layout.list\", {}).',
    });
    expect(await queryCommand(v, 'library.catalogList', { query: 'fixture', limit: 1 })).toEqual([{
      catalogId: 'fixture', name: 'Fixture', category: 'custom', source: 'catalog',
      library: '/catalog.json', footprintMm: null, description: null,
    }]);
    expect(await queryCommand(v, 'library.catalogDescribe', { catalogId: 'fixture' })).toEqual({
      catalogId: 'fixture', name: 'Fixture', category: 'custom', footprintMm: null,
      behaviorType: null, description: null, docs: null,
    });
  });

  it('keeps DES filtering, statistics and bottleneck thresholds; uses the richer status successor', async () => {
    const components = [
      { path: 'Source', load: 0, inTransit: 0, blocked: 0 },
      { path: 'Machine', load: 1, inTransit: 0, blocked: 0 },
      { path: 'Sink', load: 0, inTransit: 1, blocked: 0 },
    ];
    const bottleneck = { path: 'Machine', name: 'Machine', working: 90 };
    const statistics = {
      bottleneck, meanUtilization: 40, throughputPerHour: 120,
      components: [{ path: 'Source', blocked: 31, empty: 0 }, { ...bottleneck, blocked: 0, empty: 0 }, { path: 'Sink', blocked: 0, empty: 51 }],
    };
    const ctl = {
      componentStates: () => components, statistics: () => statistics,
      subMode: 'animated', multiplier: 2, statResetTime: 1, simTime: 5, endTime: 10,
      eventStats: () => ({ currentTime: 5, processed: 7, pending: 2, nextEventTime: 6 }),
    };
    const v = { ...viewer, simulationKernel: { desControl: () => ctl }, isSimulationPaused: false, simulationPauseReasons: [] } as unknown as RVViewer;
    expect(await queryCommand(v, 'des.components', { busyOnly: true })).toEqual({ total: 3, shown: 2, components: components.slice(1) });
    expect(await queryCommand(v, 'des.stats')).toEqual(statistics);
    expect(await queryCommand(v, 'des.bottleneck')).toEqual({
      bottleneck, meanUtilization: 40, throughputPerHour: 120,
      diagnosis: "'Machine' is the bottleneck — working 90% of the time. 1 upstream component(s) are blocked behind it; 1 downstream component(s) are starved.",
    });
    expect(await queryCommand(v, 'des.status')).toEqual({
      runState: 'running', reason: 'running', simTime: 5, endTime: 10, progress: 0.5,
      finishedAt: null, processed: 7, pending: 2, nextEventTime: 6, pauseReasons: [],
      subMode: 'animated', multiplier: 2, statResetTime: 1,
    });
  });

  it('keeps the timing tool because clear=true mutates its buffers', () => {
    expect(MOVED_TOOLS.some((m) => m.tool === 'web_layout_timings')).toBe(false);
    expect(commandRegistry.get('layout.timings')).toBeUndefined();
  });
});

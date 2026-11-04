// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.18 — the MCP path contract (F9 / F15, Phase 3b).
 *
 *  - `web_signal_bindings_list` keeps printing `componentPath` and adds `componentAddress`;
 *    `web_signal_bind` accepts the same value it printed (path) AND the address;
 *  - a node path an MCP caller types in the AUTHORED spelling reaches the tool in the
 *    registry's spelling (`normalizeUserPathArgs`, never by a guess; `componentPath`
 *    and file paths are not node paths);
 *  - a reference a caller writes as a PATH (`web_execute("component.setFields", …)` / `web_editor_set_field`
 *    → a setField op) is stored as the target's ADDRESS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryCommand } from './helpers/query-command';
import { Object3D, Scene } from 'three';
import '../src/core/engine/rv-signal-construction';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { McpSignalBindTools } from '../src/plugins/mcp-bridge/rv-mcp-signal-bind-tools';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { applyForward } from '../src/core/hmi/scene/rv-scene-executors';
import { RV_SEEDED_NODE_ID_KEY } from '../src/core/engine/rv-authored-keys';
import { normalizeUserPathArgs } from '../src/plugins/mcp-bridge/rv-mcp-user-paths';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import type { RvSceneOp } from '../src/core/ops/rv-unified-ops';
import type { RVViewer } from '../src/core/rv-viewer';
import { CR, node, sceneToGlb } from './helpers/migrate-769-fixtures';

function bindFixture() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const root = new Object3D();
  root.name = 'Machine';
  root.userData[RV_SEEDED_NODE_ID_KEY] = 'a0000000-0000-5000-8000-000000000000';
  registry.registerNode('Machine', root);
  const ids: Record<string, string> = {};
  for (const [i, arm] of ['Left', 'Right'].entries()) {
    const n = new Object3D();
    n.name = arm;
    n.userData[RV_SEEDED_NODE_ID_KEY] = ids[arm] = `a0000000-0000-5000-8000-00000000000${i + 1}`;
    root.add(n);
    const path = `Machine/${arm}`;
    store.register(`${arm}.Forward`, `${path}/Forward`, false, 'PLCInputBool');
    n.userData.realvirtual = { Drive_Simple: { Forward: { type: 'ComponentReference', path: `${path}/Forward`, componentType: 'PLCInputBool' } } };
    registry.registerNode(path, n);
    registry.register('Drive_Simple', path, {
      Forward: `${arm}.Forward`, Backward: null, commandBackward: () => {}, neutralizeBackward: () => {},
    });
  }
  registry.registerDocument(root, '');
  store.register('PLC.Start', 'plc/start', false, 'PLCOutputBool');
  store.registerSignalProvider({ interfaceId: 'plc-1', signal: 'PLC.Start' }, true);
  const mgr = new SignalBindingManager(store, registry);
  let mappings: unknown[] = [];
  const planner = {
    id: 'layout-planner',
    store: {
      getSnapshot: () => ({ placed: [{ id: 'p1', signalMappings: mappings }] }),
      updateSignalMappings: (_id: string, next: unknown[]) => { mappings = next; },
      subscribe: () => () => {},
    },
    getPlacedRootById: (id: string) => (id === 'p1' ? root : null),
    findPlacedAncestor: (n: Object3D) => { for (let c: Object3D | null = n; c; c = c.parent) if (c === root) return { id: 'p1', root }; return null; },
  };
  const viewer = {
    registry, signalStore: store, signalBindingManager: mgr,
    getPlugin: (id: string) => (id === 'layout-planner' ? planner : undefined),
    behaviors: { getActiveBinds: () => [] },
    modes: { activeMode: 'hmi' },
  } as unknown as RVViewer;
  return { viewer, tools: new McpSignalBindTools(() => viewer), ids, mappings: () => mappings };
}

const target: EditTarget = {
  available: true, setField: () => {}, unsetField: () => {}, withTransaction: async (_l, fn) => { await fn(); },
};

describe('plan-769 9.18 — MCP path contract', () => {
  beforeEach(() => setActiveEditTarget(target));
  afterEach(() => { setActiveEditTarget(null); vi.restoreAllMocks(); });

  it('bindings_list prints componentPath + componentAddress; bind accepts either', async () => {
    const f = bindFixture();
    const list = await queryCommand(f.viewer, 'signal.bindingsList') as { slots: Array<Record<string, unknown>> };
    const left = list.slots.find((s) => s.slot === 'Forward' && s.componentPath === 'Left')!;
    expect(left.componentAddress).toBe(`#${f.ids.Left}`);
    // The value the list printed (path) binds …
    expect(JSON.parse(await f.tools.bindSlot('p1', 'Left', 'Forward', 'PLC.Start')).error).toBeUndefined();
    // … and so does the address.
    const viaAddress = JSON.parse(await f.tools.bindSlot('p1', `#${f.ids.Right}`, 'Forward', 'PLC.Start'));
    expect(viaAddress.error).toBeUndefined();
    const bound = f.mappings() as Array<{ componentPath?: string }>;
    expect(bound.map((m) => m.componentPath).sort()).toEqual(['Left', 'Right']);
  });

  it('a node path in AUTHORED spelling reaches the tool in the registry spelling; guesses and non-node paths are left alone', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new Scene();
    scene.name = 'Cell';
    const a = node('NL6:501');
    a.add(node('Pin'));
    const b = node('NL6:501');
    b.add(node('Pin2'));
    scene.add(a, b, node('Solo'));
    const loaded = await loadGLB('cell.glb', new Scene(), { data: await sceneToGlb(scene), preserveHierarchy: true, loadKinematicsSidecar: false });
    const reg = loaded.registry;
    let pin2: Object3D | null = null;
    loaded.root.traverse((n) => { if (n.name === 'Pin2') pin2 = n; });
    const runtime = reg.getPathForNode(pin2!)!;
    expect(runtime).not.toContain('NL6:501'); // the loader renamed it
    const authored = `${reg.getPathForNode(loaded.root) ? `${reg.getPathForNode(loaded.root)}/` : ''}NL6:501/Pin2`;
    const out = normalizeUserPathArgs(reg, {
      path: 'NL6:501/Pin2', paths: `Solo,NL6:501/Pin2`, componentPath: 'NL6:501/Pin2', documentPath: 'models/x.glb', other: 'NL6:501/Pin2',
    })!;
    expect(out.path).toBe(runtime);
    expect((out.paths as string).split(',')[1]).toBe(runtime);
    expect(out.componentPath).toBe('NL6:501/Pin2');
    expect(out.documentPath).toBe('models/x.glb');
    expect(out.other).toBe('NL6:501/Pin2');
    // A leaf only a guessing stage would find is passed through unchanged.
    expect(normalizeUserPathArgs(reg, { path: 'Pin2' })!.path).toBe('Pin2');
    void authored;
  });

  it('a reference written as a PATH through a setField op is stored as the target\'s ADDRESS (op carries it too)', async () => {
    const scene = new Scene();
    scene.name = 'Plant';
    scene.add(node('Axis', { Drive: { Direction: 'LinearX' } }), node('Holder', { RefHolder: {} }));
    const loaded = await loadGLB('plant.glb', new Scene(), { data: await sceneToGlb(scene), preserveHierarchy: true, loadKinematicsSidecar: false });
    const reg = loaded.registry;
    let axis: Object3D | null = null;
    let holder: Object3D | null = null;
    loaded.root.traverse((n) => { if (n.name === 'Axis') axis = n; if (n.name === 'Holder') holder = n; });
    const viewer = { registry: reg, currentModelRoot: loaded.root, markRenderDirty() {} } as unknown as RVViewer;
    const op = {
      id: 'op1', ts: 0, schemaV: 1, kind: 'setField', nodePath: reg.getPathForNode(holder!)!,
      componentType: 'RefHolder', fieldName: 'To', value: CR('Axis', 'realvirtual.Drive'), prev: undefined,
    } as unknown as RvSceneOp;
    await applyForward(op, { viewer });
    const expected = { type: 'ComponentReference', address: `#${identityIdOf(axis!)}`, componentType: 'realvirtual.Drive' };
    expect((holder!.userData.realvirtual as Record<string, Record<string, unknown>>).RefHolder.To).toEqual(expected);
    expect((op as unknown as { value: unknown }).value).toEqual(expected);
  });
});

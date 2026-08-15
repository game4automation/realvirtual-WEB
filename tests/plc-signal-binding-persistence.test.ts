// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-418 9.5 — a binding on a raw PLC signal node survives a model reload.
 *
 * Two persistence paths, deliberately different (plan Entscheidungs-Log):
 *  - a FREE signal node persists as a `SignalLinks/Mappings` scene field op on
 *    that node — a scene overlay, never baked into the shared GLB;
 *  - a node inside a Planner placement persists with the placement, through
 *    `placed.signalMappings`.
 *
 * "Reload" is modelled the way the productive path does it: a fresh
 * `SignalBindingManager` over freshly loaded nodes, replaying the persisted
 * mappings via `applyMappings()`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { registerSignal } from '../src/core/engine/rv-signal-construction';
import { PLC_SIGNAL_SLOT } from '../src/core/engine/rv-binding-slot-resolver';
import { resetSlotAuthority, isSignalLiveControlled } from '../src/core/engine/rv-slot-authority';
import { createSignalBindingPersistence } from '../src/plugins/signal-bind/signal-binding-persistence';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';
import type { RVViewer } from '../src/core/rv-viewer';

afterEach(() => { setActiveEditTarget(null); resetSlotAuthority(); });

const NODE_PATH = 'DemoCell/PLCInterface/Enable';

/** A loaded scene with one free PLCInputBool node plus an external tag. */
function loadScene() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'DemoCell';
  scene.add(root);
  const iface = new Object3D();
  iface.name = 'PLCInterface';
  root.add(iface);
  const node = new Object3D();
  node.name = 'Enable';
  iface.add(node);

  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('DemoCell', root);
  registry.registerNode('DemoCell/PLCInterface', iface);
  const sigData = { Name: 'Enable', Status: { Value: false } };
  node.userData.realvirtual = { PLCInputBool: sigData };
  registry.registerNode(NODE_PATH, node);
  registerSignal(node, 'PLCInputBool', sigData, NODE_PATH, store, registry);
  store.register('PLC.Enable', 'PLC/Enable', false, 'PLCInputBool');
  store.buildIndex();

  return { scene, root, node, registry, store };
}

const MAPPING: SignalMapping = {
  kind: 'mapped-signal',
  componentPath: '.',
  slot: PLC_SIGNAL_SLOT,
  signal: 'PLC.Enable',
  interfaceId: 'plc',
  direction: 'plcInput',
  enabled: true,
};

describe('free PLC node — SignalLinks scene overlay', () => {
  it('writes the mapping as a SignalLinks/Mappings field op without touching the GLB extras', () => {
    const setField = vi.fn();
    setActiveEditTarget({
      available: true, setField, unsetField: vi.fn(),
      withTransaction: async (_label, fn) => fn(),
    } satisfies EditTarget);
    const f = loadScene();
    const target = { kind: 'node' as const, nodePath: NODE_PATH, node: f.node };
    const adapter = createSignalBindingPersistence(
      { getPlugin: () => undefined } as unknown as RVViewer,
      target,
    );

    adapter.write([{ ...MAPPING }]);

    expect(setField).toHaveBeenCalledWith(NODE_PATH, 'SignalLinks', 'Mappings', [MAPPING], []);
    // The signal's own extras key is untouched — the two coexist on one node.
    expect(f.node.userData.realvirtual).toMatchObject({ PLCInputBool: { Name: 'Enable' } });
    expect(f.node.userData.realvirtual.SignalLinks).toBeUndefined();
    expect(adapter.read()).toEqual([MAPPING]);
  });

  it('a reloaded node carrying SignalLinks re-binds its slot', () => {
    // Reload: the persisted overlay is applied back onto the node extras, the
    // way the plugin's onModelLoaded traversal reads it.
    const f = loadScene();
    f.node.userData.realvirtual.SignalLinks = { Mappings: [{ ...MAPPING }] };

    const target = { kind: 'node' as const, nodePath: NODE_PATH, node: f.node };
    const adapter = createSignalBindingPersistence(
      { getPlugin: () => undefined } as unknown as RVViewer,
      target,
    );
    expect(adapter.read()).toEqual([MAPPING]);

    const manager = new SignalBindingManager(f.store, f.registry);
    const applied = manager.applyMappings(NODE_PATH, f.node, adapter.read());

    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ slot: PLC_SIGNAL_SLOT, componentPath: '.' });
    manager.tick(1 / 60);
    expect(manager.getBindingLiveness(NODE_PATH, PLC_SIGNAL_SLOT, '.')).toBe('live');
  });
});

describe('PLC node inside a placement — placed.signalMappings', () => {
  const PLACED_MAPPING: SignalMapping = {
    ...MAPPING,
    componentPath: 'PLCInterface/Enable',
    direction: 'plcOutput',
  };

  function plannerFor(mappings: SignalMapping[]) {
    const placed = [{ id: 'placed-cell', signalMappings: mappings }];
    return {
      id: 'layout-planner',
      store: {
        getSnapshot: () => ({ placed }),
        updateSignalMappings: (id: string, next: SignalMapping[]) => {
          const entry = placed.find((p) => p.id === id);
          if (entry) entry.signalMappings = next;
        },
        subscribe: () => () => {},
      },
    };
  }

  it('persists through the planner store and survives a reload', () => {
    const f = loadScene();
    const planner = plannerFor([]);
    const viewer = { getPlugin: () => planner } as unknown as RVViewer;
    const target = { kind: 'placed' as const, placedId: 'placed-cell', node: f.root };
    const adapter = createSignalBindingPersistence(viewer, target);

    adapter.write([{ ...PLACED_MAPPING }]);
    expect(adapter.read()).toEqual([PLACED_MAPPING]);

    // Reload: fresh manager, mappings replayed from the planner snapshot.
    const manager = new SignalBindingManager(f.store, f.registry);
    const applied = manager.applyMappings('placed-cell', f.root, adapter.read());

    expect(applied).toHaveLength(1);
    manager.tick(1 / 60);
    expect(manager.getBindingLiveness('placed-cell', PLC_SIGNAL_SLOT, 'PLCInterface/Enable')).toBe('live');
    // Control role (PLC → viewer) raises the name-keyed gate for the signal.
    expect(isSignalLiveControlled('Enable')).toBe(true);
  });

  it('drops a mapping whose slot no longer exists after reload', () => {
    const f = loadScene();
    const manager = new SignalBindingManager(f.store, f.registry);

    const applied = manager.applyMappings('placed-cell', f.root, [{
      ...PLACED_MAPPING,
      componentPath: 'PLCInterface/Vanished',
    }]);

    expect(applied).toEqual([]);
  });
});

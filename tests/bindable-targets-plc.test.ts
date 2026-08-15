// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-418 9.2 — discovery of raw PLC signal nodes.
 *
 * Both discovery entry points run over the SAME consolidated pre-filter
 * (`hasResolverComponent`), so this suite exercises them together: the badge
 * scan (`enumerateAllBindableTargets`) and the drag scan
 * (`enumerateCompatibleTargets`) must agree on what is a target.
 *
 * The placement case is the deliberate asymmetry: a PLC node INSIDE a Planner
 * placement is never a target of its own — the placement is one aggregate
 * element and carries the signal's slot.
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { registerSignal } from '../src/core/engine/rv-signal-construction';
import {
  hasResolverComponent,
  PLC_SIGNAL_SLOT,
} from '../src/core/engine/rv-binding-slot-resolver';
import { enumerateAllBindableTargets } from '../src/plugins/signal-bind/bindable-targets';
import { enumerateCompatibleTargets } from '../src/plugins/signal-bind/compatible-targets';
import type { RVViewer } from '../src/core/rv-viewer';

function fixture() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'DemoCell';
  scene.add(root);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('DemoCell', root);

  const iface = new Object3D();
  iface.name = 'PLCInterface';
  root.add(iface);
  registry.registerNode('DemoCell/PLCInterface', iface);

  const add = (name: string, sigType: string) => {
    const node = new Object3D();
    node.name = name;
    iface.add(node);
    const path = `DemoCell/PLCInterface/${name}`;
    const sigData = { Name: name, Status: { Value: sigType.includes('Bool') ? false : 0 } };
    node.userData.realvirtual = { [sigType]: sigData };
    registry.registerNode(path, node);
    registerSignal(node, sigType, sigData, path, store, registry);
    return { node, path };
  };

  const start = add('EntryConveyorStart', 'PLCOutputBool');
  const speed = add('EntrySpeed', 'PLCOutputFloat');
  store.buildIndex();
  return { scene, root, iface, registry, store, start, speed };
}

function viewerOf(
  registry: NodeRegistry,
  manager: SignalBindingManager,
  planner?: unknown,
): RVViewer {
  return {
    registry,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] },
    getPlugin: (id: string) => (id === 'layout-planner' ? planner : undefined),
  } as unknown as RVViewer;
}

const BOOL_PAYLOAD = {
  name: 'PLC.Start',
  interfaceId: 'plc',
  direction: 'output' as const,
  origin: 'connect' as const,
  plcType: 'PLCOutputBool',
};

describe('discovery pre-filter', () => {
  it('accepts a raw PLC signal node (consolidated hasResolverComponent)', () => {
    const f = fixture();
    expect(hasResolverComponent(f.start.node)).toBe(true);
    expect(hasResolverComponent(f.iface)).toBe(false);
  });
});

describe('enumerateAllBindableTargets with raw PLC signal nodes', () => {
  it('lists every free PLC signal node as its own node target', () => {
    const f = fixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    const targets = enumerateAllBindableTargets(viewerOf(f.registry, manager));

    expect(targets.map((t) => t.id).sort()).toEqual([f.speed.path, f.start.path].sort());
    expect(new Set(targets.map((t) => t.kind))).toEqual(new Set(['node']));
  });

  it('does NOT list a PLC node inside a placement — the placement carries its slot', () => {
    const f = fixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    const planner = {
      store: { getSnapshot: () => ({ placed: [{ id: 'placed-cell' }] }) },
      getPlacedRootById: () => f.root,
      findPlacedAncestor: (node: Object3D) => {
        for (let cur: Object3D | null = node; cur; cur = cur.parent) {
          if (cur === f.root) return { id: 'placed-cell', root: f.root };
        }
        return null;
      },
    };

    const targets = enumerateAllBindableTargets(viewerOf(f.registry, manager, planner));
    expect(targets.map((t) => t.id)).toEqual(['placed-cell']);
    expect(targets[0].kind).toBe('placed');

    // The aggregated placement offers BOTH signals as slots, addressed by
    // their path relative to the placement root.
    const slots = manager.getElementSlots('placed-cell', f.root, 'aggregate');
    expect(slots.filter((s) => s.kind !== 'unavailable' && s.slot === PLC_SIGNAL_SLOT)
      .map((s) => (s.kind === 'unavailable' ? '' : s.componentPath)).sort())
      .toEqual(['PLCInterface/EntryConveyorStart', 'PLCInterface/EntrySpeed']);
  });
});

describe('enumerateCompatibleTargets with raw PLC signal nodes', () => {
  it('offers only the type-compatible signal node for a Bool payload', () => {
    const f = fixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    const compatible = enumerateCompatibleTargets(viewerOf(f.registry, manager), BOOL_PAYLOAD);

    expect(compatible.map((t) => t.id)).toEqual([f.start.path]);
    expect(compatible[0].compatibleSlotCount).toBe(1);
  });

  it('rejects a Bool payload on a Float signal node (hard type check)', () => {
    const f = fixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    const compatible = enumerateCompatibleTargets(viewerOf(f.registry, manager), BOOL_PAYLOAD);

    expect(compatible.some((t) => t.id === f.speed.path)).toBe(false);
  });

  it('rejects a viewer→PLC payload on a PLCOutput slot (direction check)', () => {
    const f = fixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    const compatible = enumerateCompatibleTargets(viewerOf(f.registry, manager), {
      ...BOOL_PAYLOAD,
      direction: 'input',
    });

    expect(compatible).toEqual([]);
  });
});

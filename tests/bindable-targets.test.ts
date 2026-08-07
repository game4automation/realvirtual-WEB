// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { constructDrive } from '../src/core/engine/rv-signal-construction';
import {
  resolveComponentRefs,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import { enumerateAllBindableTargets } from '../src/plugins/signal-bind/bindable-targets';
import type { RVViewer } from '../src/core/rv-viewer';

function loaderDrive() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Model';
  scene.add(root);
  const node = new Object3D();
  node.name = 'Axis';
  root.add(node);
  const rv = {
    Drive: { Direction: 'LinearX' },
    Drive_Simple: {},
  };
  node.userData.realvirtual = rv;
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Model/Axis', node);
  const result = constructDrive(node, rv, rv.Drive, 'Model/Axis', registry, store)!;
  store.buildIndex();
  const ctx = { registry, signalStore: store, scene, root } as ComponentContext;
  for (const pending of result.pendingBehaviors) {
    resolveComponentRefs(pending.component as unknown as Record<string, unknown>, registry);
    registry.register(pending.type, pending.path, pending.component);
    pending.component.init(ctx);
  }
  return { scene, root, node, registry, store };
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
    getPlugin: (id: string) => id === 'layout-planner' ? planner : undefined,
  } as unknown as RVViewer;
}

describe('enumerateAllBindableTargets', () => {
  it('finds a GLB drive constructed through the loader path without a planner plugin', () => {
    const fixture = loaderDrive();
    const manager = new SignalBindingManager(fixture.store, fixture.registry);
    const targets = enumerateAllBindableTargets(viewerOf(fixture.registry, manager));
    expect(targets.map((target) => target.id)).toEqual(['Model/Axis']);
  });

  it('finds and deduplicates a planner placement', () => {
    const fixture = loaderDrive();
    const manager = new SignalBindingManager(fixture.store, fixture.registry);
    const planner = {
      store: { getSnapshot: () => ({ placed: [{ id: 'placed-axis' }] }) },
      getPlacedRootById: () => fixture.node,
      findPlacedAncestor: (node: Object3D) =>
        node === fixture.node ? { id: 'placed-axis', root: fixture.node } : null,
    };
    const targets = enumerateAllBindableTargets(viewerOf(fixture.registry, manager, planner));
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: 'placed-axis', kind: 'placed' });
  });

  it('excludes nodes with no resolvable slots', () => {
    const registry = new NodeRegistry();
    const store = new SignalStore();
    const plain = new Object3D();
    plain.name = 'Plain';
    plain.userData.realvirtual = { Drive_Simple: {} };
    registry.registerNode('Plain', plain);
    const manager = new SignalBindingManager(store, registry);
    expect(enumerateAllBindableTargets(viewerOf(registry, manager))).toEqual([]);
  });
});

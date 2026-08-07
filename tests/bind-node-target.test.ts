// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { findSignalBindTarget, signalBindTargetId } from '../src/plugins/signal-bind/signal-bind-target';
import type { RVViewer } from '../src/core/rv-viewer';

function makeNodeHarness() {
  const scene = new Scene();
  const machine = new Object3D();
  machine.name = 'Machine';
  machine.userData.realvirtual = { Conveyor: {} };
  const mesh = new Object3D();
  mesh.name = 'Housing';
  machine.add(mesh);
  scene.add(machine);

  const registry = new NodeRegistry();
  registry.registerNode('Machine', machine);
  registry.registerNode('Machine/Housing', mesh);
  const store = new SignalStore();
  store.register('Flow.Run', 'Machine/Signals/Flow.Run', false, 'PLCInputBool');
  store.register('External.Run', 'Connect/External.Run', true, 'PLCInputBool');
  const manager = new SignalBindingManager(store, registry);
  const viewer = {
    registry,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] },
    getPlugin: () => undefined,
  } as unknown as RVViewer;
  return { viewer, machine, mesh, manager };
}

describe('generic GLB signal bind target', () => {
  it('resolves a child hit to the component node path and its registered signal slot', () => {
    const { viewer, machine, mesh, manager } = makeNodeHarness();

    const target = findSignalBindTarget(viewer, mesh);

    expect(target).toMatchObject({ kind: 'node', nodePath: 'Machine', node: machine });
    expect(signalBindTargetId(target!)).toBe('Machine');
    expect(manager.getElementSlots('Machine', machine)).toEqual([
      expect.objectContaining({ slot: 'Flow.Run', targetName: 'Flow.Run' }),
    ]);
  });

  it('reports the restored node binding as live for the badge state', () => {
    const { machine, manager } = makeNodeHarness();
    manager.applyMappings('Machine', machine, [{
      slot: 'Flow.Run', signal: 'External.Run', interfaceId: 'mqtt-main',
      direction: 'plcInput', enabled: true,
    }]);
    manager.tick(0.02);

    expect(manager.getElementState('Machine')).toBe('live');
  });
});

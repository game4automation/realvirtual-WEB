// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.8 signal-binding-instance-scope — instance isolation across GLB copies.
 *
 * Two PlacedComponent ids (same GLB) with their own bindings → element states
 * are independent, and the relay writes the INSTANCE-SCOPED slot name, not the
 * generic one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { clearLiveControl } from '../src/core/engine/rv-live-control';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';

function makeConveyor(store: SignalStore, registry: NodeRegistry, scope: string): Object3D {
  const root = new Object3D();
  root.name = scope;
  root.userData.realvirtual = { LayoutObject: { Label: scope }, Conveyor: {} };
  registry.registerNode(scope, root);
  store.register(scopeSignalName(scope, 'Flow.Run'), `${scope}/Flow.Run`, false, 'PLCInputBool');
  return root;
}

describe('signal-binding instance scope', () => {
  beforeEach(() => clearLiveControl());

  it('keeps two placements of the same asset independent', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);

    const rootA = makeConveyor(store, registry, 'Conveyor');
    const rootB = makeConveyor(store, registry, 'Conveyor_2');
    const runA = scopeSignalName('Conveyor', 'Flow.Run');
    const runB = scopeSignalName('Conveyor_2', 'Flow.Run');
    expect(runA).not.toBe(runB);

    // Only A is bound to a present source.
    store.register('Src', '__iface__/Src', true, 'PLCOutputBool');
    mgr.bind('idA', rootA, { slot: 'Flow.Run', signal: 'Src', direction: 'plcInput', enabled: true });
    mgr.tick(1 / 60);

    expect(mgr.getElementState('idA')).toBe('live');
    expect(mgr.getElementState('idB')).toBe('unbound');
    expect(mgr.isLive('idA')).toBe(true);
    expect(mgr.isLive('idB')).toBe(false);

    // The relay wrote the instance-scoped slot of A, not B and not the generic.
    expect(store.getBool(runA)).toBe(true);
    expect(store.getBool(runB)).toBe(false);
  });
});

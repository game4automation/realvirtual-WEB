// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.2 signal-binding-override — live signal takes control, internal logic silent.
 *
 * A Conveyor's Flow.Run is bound to a CONNECT source. Setting the source false
 * → after tick() the element is liveControlled and Flow.Run === false (the relay
 * value wins; the Conveyor's internal Run=true self-assertion is gated by the
 * live-control registry).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { isSignalLiveControlled, clearLiveControl } from '../src/core/engine/rv-live-control';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

/** Build a placed Conveyor element rooted at a LayoutObject. Returns [root, scope]. */
function makeConveyor(store: SignalStore, registry: NodeRegistry, scope: string): Object3D {
  const root = new Object3D();
  root.name = scope;
  root.userData.realvirtual = {
    LayoutObject: { Label: scope, CatalogId: 'conveyor', Locked: false },
    Conveyor: {},
  };
  registry.registerNode(scope, root);
  // Register Flow signals under their instance-scoped names (mirrors the behavior).
  for (const key of ['Run', 'Occupied', 'Running']) {
    const n = scopeSignalName(scope, `Flow.${key}`);
    store.register(n, `${scope}/Flow.${key}`, false, key === 'Run' ? 'PLCInputBool' : 'PLCOutputBool');
  }
  return root;
}

describe('signal-binding override', () => {
  beforeEach(() => clearLiveControl());

  it('live source takes control and overrides the Conveyor Flow.Run', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);

    const scope = 'Conveyor_01';
    const root = makeConveyor(store, registry, scope);
    const flowRun = scopeSignalName(scope, 'Flow.Run');

    // Simulate the internal behavior having set Flow.Run true.
    store.set(flowRun, true);

    // Register a CONNECT source signal (present) and bind it.
    store.register('Motor.Run', '__iface__/Motor.Run', false, 'PLCOutputBool');
    const mapping: SignalMapping = { slot: 'Flow.Run', signal: 'Motor.Run', direction: 'plcInput', enabled: true };
    mgr.bind('id1', root, mapping);

    // Source goes false → relay queues the write; tick flushes + sets liveControlled.
    store.set('Motor.Run', false);
    mgr.tick(1 / 60);

    expect(mgr.isLive('id1')).toBe(true);
    expect(isSignalLiveControlled(flowRun)).toBe(true);
    expect(store.getBool(flowRun)).toBe(false); // relay value wins
  });

  it('the gate suppresses the Conveyor internal Run=true self-assertion', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);
    const scope = 'Conveyor_02';
    const root = makeConveyor(store, registry, scope);
    const flowRun = scopeSignalName(scope, 'Flow.Run');

    store.register('Motor.Run', '__iface__/Motor.Run', false, 'PLCOutputBool');
    mgr.bind('id2', root, { slot: 'Flow.Run', signal: 'Motor.Run', direction: 'plcInput', enabled: true });
    store.set('Motor.Run', true);
    mgr.tick(1 / 60);

    // The behavior would call `if (!flowRunIsLive(self)) self.sig.Run.set(true)`.
    // flowRunIsLive returns isSignalLiveControlled(scoped Flow.Run) → true here.
    expect(isSignalLiveControlled(flowRun)).toBe(true);
  });

  it('without a present source the element stays in self-sim (not live)', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);
    const scope = 'Conveyor_03';
    const root = makeConveyor(store, registry, scope);

    // Bind to a source name that is NOT registered (no CONNECT source present).
    mgr.bind('id3', root, { slot: 'Flow.Run', signal: 'Absent.Signal', direction: 'plcInput', enabled: true });
    mgr.tick(1 / 60);

    expect(mgr.isLive('id3')).toBe(false);
    expect(mgr.getElementState('id3')).toBe('pending');
  });
});

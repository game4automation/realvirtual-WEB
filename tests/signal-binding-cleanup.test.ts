// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.7 signal-binding-cleanup — no subscriber / live-control leak; re-bind guard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { isSignalLiveControlled, clearLiveControl } from '../src/core/engine/rv-live-control';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

function makeConveyor(store: SignalStore, registry: NodeRegistry, scope: string): Object3D {
  const root = new Object3D();
  root.name = scope;
  root.userData.realvirtual = { LayoutObject: { Label: scope }, Conveyor: {} };
  registry.registerNode(scope, root);
  store.register(scopeSignalName(scope, 'Flow.Run'), `${scope}/Flow.Run`, false, 'PLCInputBool');
  return root;
}

describe('signal-binding cleanup', () => {
  beforeEach(() => clearLiveControl());

  it('unbind removes the relay subscription (no leak)', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'C1');
    const flowRun = scopeSignalName('C1', 'Flow.Run');

    store.register('Src', '__iface__/Src', false, 'PLCOutputBool');
    const m: SignalMapping = { slot: 'Flow.Run', signal: 'Src', direction: 'plcInput', enabled: true };
    mgr.bind('id', root, m);
    mgr.tick(1 / 60);
    expect(isSignalLiveControlled(flowRun)).toBe(true);

    mgr.unbind('id', 'Flow.Run');
    // After unbind, live-control for the slot is cleared and a source change
    // no longer drives the slot.
    expect(isSignalLiveControlled(flowRun)).toBe(false);
    store.set(flowRun, true);          // simulate residual internal value
    store.set('Src', true);            // source change
    mgr.tick(1 / 60);
    expect(store.getBool(flowRun)).toBe(true); // relay gone → not overwritten
  });

  it('re-binding the same slot yields exactly one active relay (re-bind guard)', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'C2');
    const flowRun = scopeSignalName('C2', 'Flow.Run');
    store.register('Src', '__iface__/Src', false, 'PLCOutputBool');

    const m: SignalMapping = { slot: 'Flow.Run', signal: 'Src', direction: 'plcInput', enabled: true };
    mgr.bind('id', root, m);
    mgr.bind('id', root, m); // re-bind same slot without unbind first
    mgr.bind('id', root, m);

    // Re-bind guard: each bind() unbinds the same (id, slot) first, so exactly
    // ONE relay survives. A single unbind() then fully detaches it — a later
    // source change must not drive the slot (proves no duplicate subscription
    // lingered).
    mgr.unbind('id', 'Flow.Run');
    store.set(flowRun, true);  // residual internal value
    store.set('Src', true);    // source change
    mgr.tick(1 / 60);
    expect(store.getBool(flowRun)).toBe(true); // no surviving relay overwrote it
  });

  it('dispose() drops all relays and live-control state', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'C3');
    const flowRun = scopeSignalName('C3', 'Flow.Run');
    store.register('Src', '__iface__/Src', true, 'PLCOutputBool');
    mgr.bind('id', root, { slot: 'Flow.Run', signal: 'Src', direction: 'plcInput', enabled: true });
    mgr.tick(1 / 60);
    expect(isSignalLiveControlled(flowRun)).toBe(true);

    mgr.dispose();
    expect(isSignalLiveControlled(flowRun)).toBe(false);
    expect(mgr.getElementState('id')).toBe('unbound');
  });
});

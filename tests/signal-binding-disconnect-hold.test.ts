// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.3 signal-binding-disconnect-hold — reconnect-hold prevents state jumps.
 *
 * Source present → liveControlled. Remove the source → within holdMs the element
 * stays live; after the dt-accumulated timer elapses → falls back to sim. The
 * hold is driven by synthetic dt steps (tick), never real timers.
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

describe('signal-binding disconnect hold', () => {
  beforeEach(() => clearLiveControl());

  it('holds liveControlled for holdMs after the source disappears, then releases', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const mgr = new SignalBindingManager(store, registry);
    mgr.holdMs = 800;

    const root = makeConveyor(store, registry, 'Conv');
    store.register('Src.Run', '__iface__/Src.Run', true, 'PLCOutputBool');
    mgr.bind('id', root, { slot: 'Flow.Run', signal: 'Src.Run', direction: 'plcInput', enabled: true });

    // Source present → live.
    mgr.tick(0.1);
    expect(mgr.isLive('id')).toBe(true);

    // Remove the source from the store entirely (simulate disconnect).
    store.clear();
    makeConveyor(store, registry, 'Conv'); // re-register only the slot signal

    // 500 ms of hold → still live.
    mgr.tick(0.5);
    expect(mgr.isLive('id')).toBe(true);

    // Another 400 ms → total 900 ms > holdMs(800) → released.
    mgr.tick(0.4);
    expect(mgr.isLive('id')).toBe(false);
  });
});

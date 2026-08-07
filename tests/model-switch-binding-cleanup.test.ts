// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.13 — model switch hygiene:
 *  - dispose() releases every binding (claims, live-control flags, relays,
 *    pending writes) — the old model leaves nothing behind.
 *  - the node-persistence WeakMap follows Object3D identity: a NEW node object
 *    (reload) re-seeds from its `SignalLinks.Mappings` rv_extras on first read;
 *    runtime edits on the OLD node object never leak onto the new one.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import {
  claimedSlotCount,
  liveControlledCount,
  resetSlotAuthority,
} from '../src/core/engine/rv-slot-authority';
import {
  createSignalBindingPersistence,
  syncNodeSignalBindingPersistence,
} from '../src/plugins/signal-bind/signal-binding-persistence';
import type { RVViewer } from '../src/core/rv-viewer';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';

function makeConveyor(store: SignalStore, registry: NodeRegistry, scope: string): Object3D {
  const root = new Object3D();
  root.name = scope;
  root.userData.realvirtual = { LayoutObject: { Label: scope }, Conveyor: {} };
  registry.registerNode(scope, root);
  store.register(scopeSignalName(scope, 'Flow.Run'), `${scope}/Flow.Run`, false, 'PLCOutputBool');
  return root;
}

const AXIS_MAPPINGS = [
  { slot: 'Flow.Run', signal: 'Plc.Run', interfaceId: 'plc', direction: 'plcOutput' as const, enabled: true },
];

function makeNodeWithLinks(): Object3D {
  const node = new Object3D();
  node.name = 'Conv';
  node.userData.realvirtual = {
    Conveyor: {},
    SignalLinks: { Mappings: AXIS_MAPPINGS.map((m) => ({ ...m })) },
  };
  return node;
}

describe('model switch binding cleanup (plan-325 9.13)', () => {
  beforeEach(() => resetSlotAuthority());

  it('dispose releases claims, live-control flags and queued relay writes', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    store.register('Ext.Run', '__iface__/Ext.Run', true, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'Ext.Run' }, true);
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'Conv');

    mgr.bind('conv', root, {
      slot: 'Flow.Run', signal: 'Ext.Run', interfaceId: 'plc', direction: 'plcOutput', enabled: true,
    });
    mgr.tick(0.02);
    expect(mgr.isLive('conv')).toBe(true);
    expect(claimedSlotCount()).toBeGreaterThan(0);
    expect(liveControlledCount()).toBeGreaterThan(0);

    mgr.dispose();
    expect(claimedSlotCount()).toBe(0);
    expect(liveControlledCount()).toBe(0);
    expect(mgr.isLive('conv')).toBe(false);

    // A source change after dispose relays nothing.
    const scoped = scopeSignalName('Conv', 'Flow.Run');
    const before = store.get(scoped);
    store.set('Ext.Run', false);
    store.set('Ext.Run', true);
    mgr.tick(0.02);
    expect(store.get(scoped)).toBe(before);
  });

  it('re-seeds node persistence from SignalLinks.Mappings for a NEW node object after reload', () => {
    const viewer = {} as RVViewer;
    const node1 = makeNodeWithLinks();
    const p1 = createSignalBindingPersistence(viewer, { kind: 'node', nodePath: 'Conv', node: node1 });
    expect(p1.read()).toHaveLength(1);

    // Runtime edit clears the mappings on the LIVE adapter of node1.
    syncNodeSignalBindingPersistence(node1, []);
    expect(p1.read()).toHaveLength(0);

    // Model reload → NEW Object3D identity for the same path. The WeakMap entry
    // of node1 is irrelevant now; the new adapter re-seeds from rv_extras.
    const node2 = makeNodeWithLinks();
    const p2 = createSignalBindingPersistence(viewer, { kind: 'node', nodePath: 'Conv', node: node2 });
    expect(p2.read()).toEqual(AXIS_MAPPINGS);

    // The old node's runtime state did not leak onto the new node.
    expect(p1.read()).toHaveLength(0);
  });
});

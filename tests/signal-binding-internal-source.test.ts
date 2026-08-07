// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.3 — internal signal source (`sourceKind:'internal'`):
 *  - bind → immediately live WITHOUT any CONNECT provider — also while a
 *    CONNECT session has providers registered (S1: both flags set).
 *  - relay copies internal source → slot signal via the batched flush.
 *  - drive-stop handover on the live edge.
 *  - unbind → neutralize (slot driven to off).
 *  - hold grace period when the internal source vanishes (no status flicker).
 *  - no CONNECT regression: a legacy mapping on the same manager stays governed
 *    by its provider.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Object3D } from 'three';
// Side effect: registers the Drive_* behavior schemas for the generic resolver.
import '../src/core/engine/rv-signal-construction';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { resetSlotAuthority, getSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

function makeConveyor(store: SignalStore, registry: NodeRegistry, scope: string): Object3D {
  const root = new Object3D();
  root.name = scope;
  root.userData.realvirtual = { LayoutObject: { Label: scope }, Conveyor: {} };
  registry.registerNode(scope, root);
  store.register(scopeSignalName(scope, 'Flow.Run'), `${scope}/Flow.Run`, false, 'PLCOutputBool');
  return root;
}

function internalMapping(signal: string): SignalMapping {
  return { slot: 'Flow.Run', sourceKind: 'internal', signal, direction: 'plcOutput', enabled: true };
}

describe('internal signal source (plan-325 9.3)', () => {
  beforeEach(() => resetSlotAuthority());

  it('goes live immediately without a provider — even while a CONNECT session is active', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    // Active CONNECT session: an unrelated provider is registered+connected.
    store.register('Plc.Other', '__iface__/Plc.Other', false, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'Plc.Other' }, true);
    // Internal model signal (no provider).
    store.register('ModelToggle', 'Cell/ModelToggle', false, 'PLCOutputBool');

    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'Conv');
    mgr.bind('conv', root, internalMapping('ModelToggle'));

    mgr.tick(0.02);
    expect(mgr.getBindingLiveness('conv', 'Flow.Run')).toBe('live');
    expect(mgr.isLive('conv')).toBe(true);
    // The binding claims 'bound' authority like a CONNECT binding.
    const slotId = mgr.getSlotId('conv', 'Flow.Run');
    expect(slotId && getSlotAuthority(slotId)).toBe('bound');

    // Relay: internal source change reaches the slot signal on the next tick.
    store.set('ModelToggle', true);
    mgr.tick(0.02);
    expect(store.get(scopeSignalName('Conv', 'Flow.Run'))).toBe(true);
  });

  it('does not adopt a same-named CONNECT provider identity for internal mappings', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    store.register('Shared', 'Cell/Shared', false, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'Shared' }, true);
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'ConvB');
    const mapping = internalMapping('Shared');
    mgr.bind('convB', root, mapping);
    expect(mapping.interfaceId).toBeUndefined();
    mgr.tick(0.02);
    expect(mgr.getBindingLiveness('convB', 'Flow.Run')).toBe('live');
  });

  it('stops the drive on the live-control handover edge', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    store.register('ModelToggle', 'Cell/ModelToggle', false, 'PLCOutputBool');
    store.register('Axis.Forward', 'Axis/Forward', false, 'PLCOutputBool');
    const mgr = new SignalBindingManager(store, registry);

    // GLB-wired Drive_Simple with an underlying drive (handover participant).
    const root = new Object3D();
    root.name = 'Axis';
    root.userData.realvirtual = { Drive_Simple: {} };
    registry.registerNode('Axis', root);
    registry.register('Drive_Simple', 'Axis', { Forward: 'Axis.Forward', Backward: null });
    const stop = vi.fn();
    registry.register('Drive', 'Axis', { stop, isOwner: true });

    mgr.bind('axis', root, {
      slot: 'Forward', sourceKind: 'internal', signal: 'ModelToggle', direction: 'plcOutput', enabled: true,
    });
    mgr.tick(0.02);
    expect(mgr.isLive('axis')).toBe(true);
    expect(stop).toHaveBeenCalled();
  });

  it('unbind neutralizes the slot (driven to off, not held)', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    store.register('ModelToggle', 'Cell/ModelToggle', true, 'PLCOutputBool');
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'ConvD');
    const scoped = scopeSignalName('ConvD', 'Flow.Run');

    mgr.bind('convD', root, internalMapping('ModelToggle'));
    mgr.tick(0.02);
    expect(store.get(scoped)).toBe(true);

    mgr.unbind('convD', 'Flow.Run');
    mgr.tick(0.02);
    expect(mgr.isLive('convD')).toBe(false);
    expect(mgr.getBindingLiveness('convD', 'Flow.Run')).toBeUndefined();
  });

  it('applies the reconnect-hold grace period when the internal source vanishes (S1)', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    store.register('ModelToggle', 'Cell/ModelToggle', false, 'PLCOutputBool');
    const mgr = new SignalBindingManager(store, registry);
    mgr.holdMs = 800;
    const root = makeConveyor(store, registry, 'ConvE');

    mgr.bind('convE', root, internalMapping('ModelToggle'));
    mgr.tick(0.1);
    expect(mgr.getBindingLiveness('convE', 'Flow.Run')).toBe('live');

    // Internal source vanishes (model switch / reload situation).
    store.clear();
    makeConveyor(store, registry, 'ConvE');

    mgr.tick(0.5); // 500 ms < holdMs → hold, still live-controlled
    expect(mgr.getBindingLiveness('convE', 'Flow.Run')).toBe('hold');
    expect(mgr.isLive('convE')).toBe(true);

    mgr.tick(0.4); // 900 ms total > holdMs → disconnected
    expect(mgr.getBindingLiveness('convE', 'Flow.Run')).toBe('disconnected');
    expect(mgr.isLive('convE')).toBe(false);
  });

  it('keeps CONNECT mappings governed by their provider on the same manager (no regression)', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    store.register('Plc.Run', '__iface__/Plc.Run', false, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: 'plc', signal: 'Plc.Run' }, false); // registered, NOT connected
    const mgr = new SignalBindingManager(store, registry);
    const root = makeConveyor(store, registry, 'ConvF');

    mgr.bind('convF', root, {
      slot: 'Flow.Run', signal: 'Plc.Run', interfaceId: 'plc', direction: 'plcOutput', enabled: true,
    });
    mgr.tick(0.02);
    // Provider registered but disconnected → never-live CONNECT binding stays non-live.
    expect(mgr.getBindingLiveness('convF', 'Flow.Run')).toBe('disconnected');
    expect(mgr.isLive('convF')).toBe(false);
  });
});

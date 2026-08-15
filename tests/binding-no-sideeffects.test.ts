// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-421 §9.3 — the late resolution is REALLY in-memory.
 *
 * Plan-421 deliberately does not persist the resolved `interfaceId` (that is
 * the F4 follow-up). This file is what makes "in-memory" checkable rather than
 * asserted: the resolution must not reach the persistence door, must not touch
 * the store beyond the relay it already owns, and must therefore repeat itself
 * on every reload — which is exactly why not persisting is safe.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

afterEach(() => {
  setActiveEditTarget(null);
  resetSlotAuthority();
});

function fixture() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const root = new Object3D();
  root.name = 'Conv';
  root.userData.realvirtual = { LayoutObject: { Label: 'Conv' }, Conveyor: {} };
  registry.registerNode('Conv', root);
  store.register(scopeSignalName('Conv', 'Flow.Run'), 'Conv/Flow.Run', false, 'PLCOutputBool');
  const manager = new SignalBindingManager(store, registry);
  return { store, registry, manager, root };
}

const NAMES_ONLY: SignalMapping = {
  slot: 'Flow.Run', signal: 'Src.Run', direction: 'plcOutput', enabled: true,
};

function addProvider(store: SignalStore, interfaceId: string, signal: string): void {
  store.register(signal, `__iface__/${signal}`, true, 'PLCOutputBool');
  store.registerSignalProvider({ interfaceId, signal }, true);
}

/** Every store name → value, as a comparable snapshot. */
function storeSnapshot(store: SignalStore): Map<string, boolean | number> {
  return new Map(store.getAll());
}

describe('late resolution side-effects (plan-421 §9.3)', () => {
  it('writes nothing through the persistence door', () => {
    // `setActiveEditTarget` IS the door: `signal-binding-persistence` turns a
    // mapping change into a `setField` op (and thus an undo entry) through it.
    // Zero calls here means zero ops, zero undo entries, zero scene mutation.
    const setField = vi.fn();
    const unsetField = vi.fn();
    const withTransaction = vi.fn(async (_label: string, fn: () => Promise<void>) => { await fn(); });
    setActiveEditTarget({ available: true, setField, unsetField, withTransaction } satisfies EditTarget);

    const { store, manager, root } = fixture();
    manager.applyMappings('Conv', root, [{ ...NAMES_ONLY }]);
    manager.tick(0.02);
    setField.mockClear();
    unsetField.mockClear();
    withTransaction.mockClear();

    addProvider(store, 'mqtt-1', 'Src.Run');
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');

    expect(setField).not.toHaveBeenCalled();
    expect(unsetField).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('leaves the loaded scene extras untouched', () => {
    const { store, manager, root } = fixture();
    root.userData.realvirtual.SignalLinks = { Mappings: [{ ...NAMES_ONLY }] };
    const before = JSON.stringify(root.userData.realvirtual);

    manager.applyMappings('Conv', root, [{ ...NAMES_ONLY }]);
    manager.tick(0.02);
    addProvider(store, 'mqtt-1', 'Src.Run');
    manager.tick(0.02);

    expect(JSON.stringify(root.userData.realvirtual)).toBe(before);
  });

  it('changes nothing in the store beyond the relay target it already owns', () => {
    const { store, manager, root } = fixture();
    manager.applyMappings('Conv', root, [{ ...NAMES_ONLY }]);
    manager.tick(0.02);
    addProvider(store, 'mqtt-1', 'Src.Run');
    const before = storeSnapshot(store);

    manager.tick(0.02);
    const after = storeSnapshot(store);

    const changed = [...after.keys()].filter(k => after.get(k) !== before.get(k));
    expect(changed).toEqual([scopeSignalName('Conv', 'Flow.Run')]);
    // And the CONNECT source itself was never written back.
    expect(after.get('Src.Run')).toBe(before.get('Src.Run'));
  });

  it('resolves again after every reload — which is why nothing has to be persisted', () => {
    const { store, manager, registry, root } = fixture();
    addProvider(store, 'mqtt-1', 'Src.Run');

    for (let reload = 0; reload < 3; reload++) {
      // A reload re-applies the SAME persisted (names-only) mapping.
      manager.applyMappings('Conv', root, [{ ...NAMES_ONLY }]);
      manager.tick(0.02);
      expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');
      manager.unbindAll('Conv');
    }
    void registry;
  });
});

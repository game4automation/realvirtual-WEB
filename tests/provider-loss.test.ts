// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.3 provider-loss — losing the bound source drops authority back to
 * 'component' and neutralizes the command slot (plan-317 contract preserved).
 *
 * Two paths:
 *  - disconnect: the provider disappears; after the reconnect hold expires the
 *    binding goes 'disconnected', releases its bound claim and writes the
 *    neutral value onto the slot.
 *  - unbind: an explicit unbind releases the claim immediately and removes the
 *    slot from the slot↔channel index.
 * Test template: tests/des/axis-ownership.test.ts (release semantics).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import {
  channelForSlot,
  claimedSlotCount,
  getSlotAuthority,
  liveControlledCount,
  resetSlotAuthority,
} from '../src/core/engine/rv-slot-authority';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';

afterEach(() => resetSlotAuthority());

function fixture() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const root = new Object3D();
  root.name = 'Conv';
  root.userData.realvirtual = { LayoutObject: { Label: 'Conv' }, Conveyor: {} };
  registry.registerNode('Conv', root);
  const target = scopeSignalName('Conv', 'Flow.Run');
  store.register(target, 'Conv/Flow.Run', false, 'PLCInputBool');
  const manager = new SignalBindingManager(store, registry);
  manager.holdMs = 800;
  return { store, registry, manager, root, target };
}

describe('provider loss (9.3)', () => {
  it('falls back to component authority and neutralizes the slot after the hold', () => {
    const { store, registry, manager, root, target } = fixture();
    store.register('Src.Run', '__iface__/Src.Run', true, 'PLCOutputBool');
    manager.bind('Conv', root, {
      slot: 'Flow.Run', signal: 'Src.Run', direction: 'plcInput', enabled: true,
    });
    manager.tick(0.1);
    const slotId = manager.getSlotId('Conv', 'Flow.Run')!;
    expect(getSlotAuthority(slotId)).toBe('bound');
    expect(store.get(target)).toBe(true); // relay applied the live value

    // Source disappears (disconnect): during the hold the claim is KEPT.
    store.clear();
    store.register(target, 'Conv/Flow.Run', true, 'PLCInputBool');
    void registry; // re-registration of the slot signal only — node stays
    manager.tick(0.5);
    expect(manager.isLive('Conv')).toBe(true);
    expect(getSlotAuthority(slotId)).toBe('bound'); // hold keeps the claim

    // Hold expires → disconnected: claim released, slot neutralized (off).
    manager.tick(0.4);
    expect(manager.isLive('Conv')).toBe(false);
    expect(getSlotAuthority(slotId)).toBe('component');
    expect(store.get(target)).toBe(false);   // 317 contract: command slot → off
    expect(liveControlledCount()).toBe(0);
  });

  it('unbind releases the claim immediately and cleans the channel index', () => {
    const { store, manager, root } = fixture();
    store.register('Src.Run', '__iface__/Src.Run', true, 'PLCOutputBool');
    manager.bind('Conv', root, {
      slot: 'Flow.Run', signal: 'Src.Run', direction: 'plcInput', enabled: true,
    });
    manager.tick(0.1);
    const slotId = manager.getSlotId('Conv', 'Flow.Run')!;
    expect(getSlotAuthority(slotId)).toBe('bound');
    expect(channelForSlot(slotId)).toBeDefined();

    manager.unbind('Conv', 'Flow.Run', '.');
    expect(getSlotAuthority(slotId)).toBe('component');
    expect(channelForSlot(slotId)).toBeUndefined();
    expect(claimedSlotCount()).toBe(0);
  });
});

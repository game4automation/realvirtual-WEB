// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.1 authority-changed-sequence — bound → forced → unforce → bound.
 *
 * Verifies the latent claim stack through the SignalBindingManager: a live
 * binding claims 'bound'; an operator force overlays 'forced' WITHOUT
 * destroying the bound claim; unforce restores 'bound' and redispatches the
 * live source value onto the slot (wasForced template, plan-317 R4-6).
 * Test template: tests/des/axis-ownership.test.ts (claim/release registry).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import {
  getSlotAuthority,
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
  store.register('Src.Run', '__iface__/Src.Run', false, 'PLCOutputBool');
  const manager = new SignalBindingManager(store, registry);
  return { store, manager, root, target };
}

describe('authority changed sequence (9.1)', () => {
  it('walks bound → forced → unforce → bound with a redispatch after unforce', () => {
    const { store, manager, root, target } = fixture();
    manager.bind('Conv', root, {
      slot: 'Flow.Run', signal: 'Src.Run', direction: 'plcInput', enabled: true,
    });
    manager.tick(1 / 60);
    const slotId = manager.getSlotId('Conv', 'Flow.Run');
    expect(slotId).toBeDefined();

    // 1) Live binding → 'bound'; relay is authoritative.
    expect(manager.isLive('Conv')).toBe(true);
    expect(getSlotAuthority(slotId!)).toBe('bound');

    // 2) Operator force overlays as a LATENT claim → 'forced'.
    store.forceSignal(target, false);
    manager.tick(1 / 60);
    expect(getSlotAuthority(slotId!)).toBe('forced');

    // While forced, the live source value must NOT reach the slot.
    store.set('Src.Run', true);
    manager.tick(1 / 60);
    expect(store.get(target)).toBe(false);
    expect(getSlotAuthority(slotId!)).toBe('forced');

    // 3) Unforce → 'bound' restored (stack, not displaced) + the held live
    //    source value is redispatched onto the slot.
    store.unforce(target);
    manager.tick(1 / 60);
    expect(getSlotAuthority(slotId!)).toBe('bound');
    expect(store.get(target)).toBe(true);
  });

  it('claims forced already at bind time when the target starts out forced', () => {
    const { store, manager, root, target } = fixture();
    store.forceSignal(target, true);
    manager.bind('Conv', root, {
      slot: 'Flow.Run', signal: 'Src.Run', direction: 'plcInput', enabled: true,
    });
    const slotId = manager.getSlotId('Conv', 'Flow.Run');
    expect(getSlotAuthority(slotId!)).toBe('forced');
    store.unforce(target);
    manager.tick(1 / 60);
    expect(getSlotAuthority(slotId!)).toBe('bound');
  });
});

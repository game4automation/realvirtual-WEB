// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.1 — generic slot resolution: EVERY registered schema type with
 * `componentRef + signal` fields yields slots (not just the former
 * BINDING_SLOT_RV_KEYS whitelist); types WITHOUT such fields yield none
 * (private-schema guard I2); contract-less fields classify as 'unavailable'
 * (S5); the synthetic Conveyor descriptor fallback stays intact.
 *
 * Whitelist parity for Drive_* / Sensor stays covered by
 * tests/resolve-bindable-slots.test.ts (unchanged, regression gate).
 */
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { resolveBindableSlots } from '../src/core/engine/rv-binding-slot-resolver';
import { scopeSignalName, instanceScope } from '../src/core/engine/rv-instance-scope';

function fixture(rv: Record<string, unknown>, name = 'Widget') {
  const root = new Object3D();
  root.name = name;
  root.userData.realvirtual = rv;
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode(name, root);
  return { root, registry, store };
}

describe('generic slot resolution (plan-325 9.1)', () => {
  it('yields slots for a NON-whitelist schema type with componentRef+signal fields and a command contract', () => {
    registerComponentSchema('GadgetDrive325', {
      Label: { type: 'string' },
      Run: { type: 'componentRef', signal: 'PLCOutputBool' },
    });
    const f = fixture({ GadgetDrive325: {} }, 'Gadget');
    const instance = {
      Run: null,
      commandRun: (_v: boolean | number) => { /* command */ },
      neutralizeRun: () => { /* neutral */ },
    };
    f.registry.register('GadgetDrive325', 'Gadget', instance);

    const slots = resolveBindableSlots(f.root, f.store, f.registry);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      kind: 'direct-property',
      slot: 'Run',
      direction: 'plcOutput',
      componentType: 'GadgetDrive325',
    });
  });

  it('yields NO slots for schema types without componentRef+signal fields (private-schema guard I2)', () => {
    registerComponentSchema('PlainGadget325', {
      Speed: { type: 'number' },
      Target: { type: 'componentRef' }, // ref WITHOUT signal → not a slot
    });
    const f = fixture({ PlainGadget325: { Speed: 5 } }, 'Plain');
    f.registry.register('PlainGadget325', 'Plain', { Speed: 5, Target: null });
    expect(resolveBindableSlots(f.root, f.store, f.registry)).toEqual([]);
  });

  it('classifies a schema signal field without command/feedback contract as unavailable, never bindable (S5)', () => {
    registerComponentSchema('ContractlessGadget325', {
      Go: { type: 'componentRef', signal: 'PLCOutputBool' },
      Done: { type: 'componentRef', signal: 'PLCInputBool' },
    });
    const f = fixture({ ContractlessGadget325: {} }, 'NoContract');
    f.registry.register('ContractlessGadget325', 'NoContract', { Go: null, Done: null });

    const slots = resolveBindableSlots(f.root, f.store, f.registry);
    expect(slots).toEqual([
      { kind: 'unavailable', slot: 'Go', reason: 'Missing command contract for ContractlessGadget325.Go' },
      { kind: 'unavailable', slot: 'Done', reason: 'Missing feedback contract for ContractlessGadget325.Done' },
    ]);
  });

  it('keeps the synthetic Conveyor Flow.* descriptor fallback', () => {
    const f = fixture({ LayoutObject: { Label: 'Conv' }, Conveyor: {} }, 'Conv');
    const scoped = scopeSignalName(instanceScope(f.root), 'Flow.Run');
    f.store.register(scoped, 'Conv/Flow.Run', false, 'PLCOutputBool');

    const slots = resolveBindableSlots(f.root, f.store, f.registry);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      kind: 'mapped-signal',
      slot: 'Flow.Run',
      targetName: scoped,
      componentType: 'Conveyor',
    });
  });

  it('ignores rv keys with non-object values and unregistered instances', () => {
    registerComponentSchema('OrphanGadget325', {
      Run: { type: 'componentRef', signal: 'PLCOutputBool' },
    });
    // Marker present but NO registry instance → no slots, no crash.
    const f = fixture({ name: 'x', OrphanGadget325: {} }, 'Orphan');
    expect(resolveBindableSlots(f.root, f.store, f.registry)).toEqual([]);
  });
});

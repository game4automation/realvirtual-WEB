// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * slot-display-label.test.ts — plan-341 Phase 4 §9.8.
 *
 * The display-name layer must satisfy two things at once:
 *  1. `Drive_Simple` PRINTS "Acceleration" while its identity stays the
 *     misspelled `Accelaration`. That slot comes from the GENERIC schema
 *     iteration, not from a descriptor — SLOT_DESCRIPTORS.Drive_Simple only
 *     declares Forward/Backward. Both sources are therefore exercised.
 *  2. Every identity composition is BIT-IDENTICAL to before the layer existed:
 *     `slotRowKey()`, `makeSlotId()` and the persisted `SignalMapping.slot`.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { constructDrive } from '../src/core/engine/rv-signal-construction';
import { resolveComponentRefs, type ComponentContext } from '../src/core/engine/rv-component-registry';
import { resolveBindableSlots } from '../src/core/engine/rv-binding-slot-resolver';
import { makeSlotId } from '../src/core/engine/rv-slot-authority';
import { slotRowKey, type SlotRow } from '../src/core/hmi/rv-signal-slot-row';
import {
  SLOT_DESCRIPTORS,
  type SignalSlotDescriptor,
} from '../src/plugins/signal-bind/slot-descriptors';
import { slotDisplayLabel, slotLabelOverride } from '../src/plugins/signal-bind/slot-display-label';
import { upsertMappingForRow } from '../src/plugins/signal-bind/slot-row-models';

/** An unwired Drive_Simple — every schema slot resolves to a direct row. */
function buildUnwiredDrive() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Cell';
  root.userData.realvirtual = { LayoutObject: { Label: 'Cell' } };
  scene.add(root);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Cell', root);

  const node = new Object3D();
  node.name = 'Axis';
  root.add(node);
  const rv = { Drive: { Direction: 'LinearX' }, Drive_Simple: {} };
  node.userData.realvirtual = rv;
  registry.registerNode('Cell/Axis', node);
  const pending = constructDrive(node, rv, rv.Drive, 'Cell/Axis', registry, store);

  store.buildIndex();
  const ctx = { registry, signalStore: store, scene, root } as ComponentContext;
  for (const entry of pending?.pendingBehaviors ?? []) {
    resolveComponentRefs(entry.component as unknown as Record<string, unknown>, registry);
    registry.register(entry.type, entry.path, entry.component);
    entry.component.init(ctx);
  }
  return { root, registry, store };
}

describe('slotDisplayLabel — schema slots (the Accelaration case)', () => {
  it('renames the misspelled Drive_Simple schema slot for display only', () => {
    expect(slotDisplayLabel('Drive_Simple', 'Accelaration')).toBe('Acceleration');
  });

  it('is NOT reachable through SLOT_DESCRIPTORS — the typo lives in the schema layer', () => {
    // Guard against the earlier plan draft's wrong assumption: were the typo a
    // descriptor, this assertion would fail and the schema branch would be dead.
    expect(SLOT_DESCRIPTORS.Drive_Simple.map((d) => d.slot)).toEqual(['Forward', 'Backward']);
  });

  it('carries the label out of the real resolver onto the direct-property slot', () => {
    const fixture = buildUnwiredDrive();
    const slots = resolveBindableSlots(fixture.root, fixture.store, fixture.registry);
    const accel = slots.find((slot) => slot.slot === 'Accelaration');
    expect(accel).toBeTruthy();
    expect(accel!.label).toBe('Acceleration');
    // Identity untouched on the very same row.
    expect(accel!.slot).toBe('Accelaration');
  });

  it('leaves schema slots without an entry byte-identical to before', () => {
    const fixture = buildUnwiredDrive();
    const slots = resolveBindableSlots(fixture.root, fixture.store, fixture.registry);
    for (const slot of slots) {
      if (slot.slot === 'Accelaration') continue;
      // No display entry → no `label` at all, so existing exact-shape
      // assertions on resolver output keep passing unchanged.
      expect(slot.label).toBeUndefined();
    }
    expect(slotDisplayLabel('Drive_Simple', 'IsAtSpeed')).toBe('IsAtSpeed');
    expect(slotLabelOverride('Drive_Simple', 'IsAtSpeed')).toBeUndefined();
  });
});

describe('slotDisplayLabel — descriptor slots', () => {
  const original: SignalSlotDescriptor[] = SLOT_DESCRIPTORS.Conveyor;
  const originalDriveSimple: SignalSlotDescriptor[] = SLOT_DESCRIPTORS.Drive_Simple;
  afterEach(() => {
    SLOT_DESCRIPTORS.Conveyor = original;
    SLOT_DESCRIPTORS.Drive_Simple = originalDriveSimple;
  });

  it('reads a descriptor label', () => {
    SLOT_DESCRIPTORS.Conveyor = original.map((d) =>
      (d.slot === 'Flow.Run' ? { ...d, label: 'Run' } : d));
    expect(slotDisplayLabel('Conveyor', 'Flow.Run')).toBe('Run');
  });

  it('lets a descriptor label win over the schema table', () => {
    SLOT_DESCRIPTORS.Drive_Simple = [
      ...originalDriveSimple,
      { slot: 'Accelaration', type: 'float', direction: 'plcOutput', label: 'Ramp' },
    ];
    expect(slotDisplayLabel('Drive_Simple', 'Accelaration')).toBe('Ramp');
  });

  it('keeps descriptor slots without a label on their raw name', () => {
    expect(slotDisplayLabel('Conveyor', 'Flow.Run')).toBe('Flow.Run');
    expect(slotDisplayLabel('Drive_Simple', 'Forward')).toBe('Forward');
    expect(slotDisplayLabel('Drive_DestinationMotor', 'IsAtPosition')).toBe('IsAtPosition');
  });
});

describe('slotDisplayLabel — fallbacks', () => {
  it('returns the raw name for unknown component types and unknown slots', () => {
    expect(slotDisplayLabel('NoSuchComponent', 'Accelaration')).toBe('Accelaration');
    expect(slotDisplayLabel('Drive_Simple', 'NoSuchSlot')).toBe('NoSuchSlot');
  });

  it('never throws on empty input', () => {
    expect(slotDisplayLabel('', 'Accelaration')).toBe('Accelaration');
    expect(slotDisplayLabel('Drive_Simple', '')).toBe('');
  });
});

describe('identity is bit-identical after introducing display labels', () => {
  it('slotRowKey composes from the RAW slot', () => {
    const row: SlotRow = {
      componentPath: 'Axis',
      kind: 'direct-property',
      slot: 'Accelaration',
      label: 'Acceleration',
    };
    expect(slotRowKey(row)).toBe('Axis\u0000direct-property\u0000Accelaration');
  });

  it('makeSlotId composes from the RAW slot', () => {
    expect(makeSlotId('Cell', 'Axis', 'Drive_Simple', 'Accelaration'))
      .toBe('Cell\u0000Axis\u0000Drive_Simple\u0000Accelaration');
  });

  it('the persisted SignalMapping keeps the RAW slot', () => {
    const next = upsertMappingForRow([], {
      slot: 'Accelaration',
      componentPath: 'Axis',
      kind: 'direct-property',
      direction: 'plcOutput',
      label: 'Acceleration',
    } as Parameters<typeof upsertMappingForRow>[1], {
      name: 'PLC.Accel',
      interfaceId: 'plc',
      direction: 'output',
    });
    expect(next).toBeTruthy();
    expect(next![0].slot).toBe('Accelaration');
    expect(JSON.stringify(next![0])).not.toContain('Acceleration"');
    expect(JSON.stringify(next![0])).not.toContain('label');
  });
});

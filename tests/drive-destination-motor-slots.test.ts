// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-destination-motor-slots.test.ts — Plan 232, Phase 4 (Step D), §9.6.
 *
 * plan-226 slot resolution for Drive_DestinationMotor:
 *  - slotsForTypes(['Drive_DestinationMotor']) lists all 8 slots with float/bool types.
 *  - resolveElementSlots maps each slot to its resolved store NAME + instance.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Scene } from 'three';
import { slotsForTypes } from '../src/plugins/signal-bind/slot-descriptors';
import { resolveElementSlots } from '../src/core/engine/rv-binding-slot-resolver';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVDriveDestinationMotor } from '../src/core/engine/rv-drive-destination-motor';

describe('Drive_DestinationMotor slot descriptors (plan-232 Phase 4)', () => {
  it('slotsForTypes lists the 8 standard slots with correct value types', () => {
    const slots = slotsForTypes(['Drive_DestinationMotor']);
    const byName = Object.fromEntries(slots.map((s) => [s.slot, s]));
    expect(slots.length).toBe(8);

    // Commands consume PLC outputs (PLC → Viewer).
    expect(byName.Destination).toMatchObject({ type: 'float', direction: 'plcOutput' });
    expect(byName.StartDrive).toMatchObject({ type: 'bool', direction: 'plcOutput' });
    expect(byName.TargetSpeed).toMatchObject({ type: 'float', direction: 'plcOutput' });
    expect(byName.Acceleration).toMatchObject({ type: 'float', direction: 'plcOutput' });
    // Feedback writes PLC inputs (Viewer → PLC).
    expect(byName.IsAtPosition).toMatchObject({ type: 'float', direction: 'plcInput' });
    expect(byName.IsAtSpeed).toMatchObject({ type: 'float', direction: 'plcInput' });
    expect(byName.IsAtDestination).toMatchObject({ type: 'bool', direction: 'plcInput' });
    expect(byName.IsDriving).toMatchObject({ type: 'bool', direction: 'plcInput' });
  });

  it('resolveElementSlots maps each slot to its store name + motor instance', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();

    // Parent under a scene root so computeNodePath(root) === 'Turntable'
    // (it stops at the scene root, which has no parent).
    const scene = new Scene();
    const sceneRoot = new Object3D();
    scene.add(sceneRoot);
    const root = new Object3D();
    root.name = 'Turntable';
    root.userData.realvirtual = { LayoutObject: { Label: 'Turntable' }, Drive_DestinationMotor: {} };
    sceneRoot.add(root);
    const path = NodeRegistry.computeNodePath(root); // 'Turntable'
    registry.registerNode(path, root);

    // Register the 8 signals (names + paths) as the loader auto-provisioning would.
    const specs: [string, 'bool' | 'float'][] = [
      ['Destination', 'float'], ['StartDrive', 'bool'],
      ['TargetSpeed', 'float'], ['Acceleration', 'float'],
      ['IsAtPosition', 'float'], ['IsAtSpeed', 'float'],
      ['IsAtDestination', 'bool'], ['IsDriving', 'bool'],
    ];
    const motor = new RVDriveDestinationMotor(root);
    for (const [slot, t] of specs) {
      const name = `Turntable.${slot}`;
      const sigPath = `${path}/Signals/${slot}`;
      const plcType = t === 'bool' ? 'PLCOutputBool' : 'PLCOutputFloat';
      store.register(name, sigPath, t === 'bool' ? false : 0, plcType);
      (motor as unknown as Record<string, unknown>)[slot] = sigPath;
    }
    store.buildIndex();
    registry.register('Drive_DestinationMotor', path, motor);

    const resolved = resolveElementSlots(root, store, registry);
    const bySlot = Object.fromEntries(resolved.map((r) => [r.slot, r]));
    expect(Object.keys(bySlot).sort()).toEqual([
      'Acceleration', 'Destination', 'IsAtDestination', 'IsAtPosition',
      'IsAtSpeed', 'IsDriving', 'StartDrive', 'TargetSpeed',
    ]);
    // targetName resolves to the store NAME, not the path.
    expect(bySlot.Destination.targetName).toBe('Turntable.Destination');
    expect(bySlot.Destination.type).toBe('float');
    expect(bySlot.IsAtDestination.type).toBe('bool');
    // instance is the motor (carries liveControlled gate).
    expect(bySlot.Destination.instance).toBe(motor);
  });
});

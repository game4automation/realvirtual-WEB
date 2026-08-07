// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  constructDrive,
  DRIVE_BEHAVIOR_MAP,
  signalSpecsFromSchema,
} from '../src/core/engine/rv-signal-construction';

const SIGNAL_BEARING_BEHAVIORS = [
  'Drive_Simple',
  'Drive_Cylinder',
  'Drive_DestinationMotor',
  'Drive_FollowPosition',
  'Drive_Speed',
  'Drive_PositionSwitch',
] as const;

function construct(type: string, extras: Record<string, unknown> = {}) {
  const node = new Object3D();
  node.name = 'Axis';
  const rv = { Drive: { Direction: 'LinearX' }, [type]: extras };
  node.userData.realvirtual = rv;
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Axis', node);
  const result = constructDrive(node, rv, rv.Drive, 'Axis', registry, store);
  return { node, rv, registry, store, result };
}

describe('drive construction without automatic signal provisioning', () => {
  for (const type of SIGNAL_BEARING_BEHAVIORS) {
    it(`${type} creates no signal nodes, store entries or stamped references`, () => {
      const { node, rv, store, result } = construct(type);
      expect(result).not.toBeNull();
      expect(node.children.find(child => child.name === 'Signals')).toBeUndefined();
      expect([...store.getAll().keys()]).toEqual([]);

      const component = result!.pendingBehaviors[0].component as unknown as Record<string, unknown>;
      for (const spec of signalSpecsFromSchema(DRIVE_BEHAVIOR_MAP[type].schema)) {
        expect(component[spec.slot]).toBeNull();
        expect((rv[type] as Record<string, unknown>)[spec.slot]).toBeUndefined();
      }
    });
  }

  it('keeps an authored component reference and does not fill the remaining slots', () => {
    const authored = {
      Destination: {
        type: 'ComponentReference',
        path: 'Signals/Command',
        componentType: 'PLCOutputFloat',
      },
    };
    const { node, result, store } = construct('Drive_DestinationMotor', authored);
    const motor = result!.pendingBehaviors[0].component as unknown as Record<string, unknown>;
    expect(motor.Destination).toEqual(authored.Destination);
    expect(motor.StartDrive).toBeNull();
    expect(node.children.find(child => child.name === 'Signals')).toBeUndefined();
    expect([...store.getAll().keys()]).toEqual([]);
  });

  it('activates only the first authored Drive_* behavior and reports later ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = new Object3D();
    node.name = 'Axis';
    const rv = {
      Drive: { Direction: 'LinearX' },
      Drive_Simple: {},
      Drive_DestinationMotor: {},
    };
    node.userData.realvirtual = rv;
    const registry = new NodeRegistry();
    const result = constructDrive(node, rv, rv.Drive, 'Axis', registry, new SignalStore())!;
    expect(result.behaviors).toEqual(['Drive_Simple']);
    expect(result.pendingBehaviors.map(entry => entry.type)).toEqual(['Drive_Simple']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Drive_DestinationMotor'));
    warn.mockRestore();
  });
});

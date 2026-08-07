// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import {
  registerSignal,
  constructDrive,
  SIGNAL_TYPES,
  DRIVE_BEHAVIOR_MAP,
} from '../src/core/engine/rv-signal-construction';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVDrive } from '../src/core/engine/rv-drive';

describe('rv-signal-construction', () => {
  describe('SIGNAL_TYPES', () => {
    it('contains the six expected PLC signal types', () => {
      expect(SIGNAL_TYPES).toEqual([
        'PLCOutputBool',
        'PLCInputBool',
        'PLCOutputFloat',
        'PLCInputFloat',
        'PLCOutputInt',
        'PLCInputInt',
      ]);
    });
  });

  describe('DRIVE_BEHAVIOR_MAP', () => {
    it('exposes the known drive behaviors', () => {
      expect(Object.keys(DRIVE_BEHAVIOR_MAP).sort()).toEqual([
        'Drive_Cylinder',
        'Drive_DestinationMotor',
        'Drive_ErraticPosition',
        'Drive_FollowPosition',
        'Drive_Gear',
        'Drive_PositionSwitch',
        'Drive_Simple',
        'Drive_Speed',
      ]);
    });
  });

  describe('registerSignal', () => {
    let signalStore: SignalStore;
    let registry: NodeRegistry;
    let node: Object3D;

    beforeEach(() => {
      signalStore = new SignalStore();
      registry = new NodeRegistry();
      node = new Object3D();
      node.name = 'TestNode';
    });

    it('registers a PLCOutputBool signal with the Name from extras', () => {
      const sigData = { Name: 'MySig', Status: { Value: true } };
      const ok = registerSignal(node, 'PLCOutputBool', sigData, 'root/TestNode', signalStore, registry);
      expect(ok).toBe(true);
      // signal exists in store under the configured name
      expect(signalStore.get('MySig')).toBe(true);
      // registry has the signal type mapping
      const entries = registry.getComponentsAt('root/TestNode');
      const sigEntry = entries.find(([t]) => t === 'PLCOutputBool');
      expect(sigEntry).toBeDefined();
      expect((sigEntry![1] as { signalName: string }).signalName).toBe('MySig');
      expect((sigEntry![1] as { address: string }).address).toBe('root/TestNode');
    });

    it('registers a PLCInputFloat signal with numeric initial value', () => {
      const sigData = { Name: 'Speed', Status: { Value: 42.5 } };
      const ok = registerSignal(node, 'PLCInputFloat', sigData, 'root/TestNode', signalStore, registry);
      expect(ok).toBe(true);
      expect(signalStore.get('Speed')).toBe(42.5);
    });

    it('registers a PLCOutputInt signal with numeric initial value', () => {
      const sigData = { Name: 'Count', Status: { Value: 7 } };
      const ok = registerSignal(node, 'PLCOutputInt', sigData, 'root/TestNode', signalStore, registry);
      expect(ok).toBe(true);
      expect(signalStore.get('Count')).toBe(7);
    });

    it('falls back to signalNameOverride when extras have no Name', () => {
      const sigData = { Status: { Value: false } };
      const ok = registerSignal(
        node,
        'PLCInputBool',
        sigData,
        'root/TestNode',
        signalStore,
        registry,
        'OriginalNodeName',
      );
      expect(ok).toBe(true);
      expect(signalStore.get('OriginalNodeName')).toBe(false);
    });

    it('falls back to node.name when no extras Name and no override', () => {
      const sigData = { Status: { Value: false } };
      const ok = registerSignal(node, 'PLCInputBool', sigData, 'root/TestNode', signalStore, registry);
      expect(ok).toBe(true);
      expect(signalStore.get('TestNode')).toBe(false);
    });

    it('defaults to false for Bool when Status is missing', () => {
      const sigData = {};
      const ok = registerSignal(node, 'PLCOutputBool', sigData, 'root/TestNode', signalStore, registry);
      expect(ok).toBe(true);
      expect(signalStore.get('TestNode')).toBe(false);
    });

    it('defaults to 0 for Float when Status is missing', () => {
      const sigData = {};
      const ok = registerSignal(node, 'PLCInputFloat', sigData, 'root/TestNode', signalStore, registry);
      expect(ok).toBe(true);
      expect(signalStore.get('TestNode')).toBe(0);
    });

    it('returns false and registers nothing for an unknown signal type', () => {
      const sigData = { Name: 'Ghost', Status: { Value: true } };
      const ok = registerSignal(node, 'PLCOutputUnknown', sigData, 'root/TestNode', signalStore, registry);
      expect(ok).toBe(false);
      // Should NOT have been added under any name
      expect(signalStore.get('Ghost')).toBeUndefined();
      // Registry should not contain the unknown type
      const entries = registry.getComponentsAt('root/TestNode');
      const ghost = entries.find(([t]) => t === 'PLCOutputUnknown');
      expect(ghost).toBeUndefined();
    });
  });

  describe('constructDrive', () => {
    let signalStore: SignalStore;
    let registry: NodeRegistry;
    let node: Object3D;

    beforeEach(() => {
      signalStore = new SignalStore();
      void signalStore; // not used directly by constructDrive but kept for symmetry
      registry = new NodeRegistry();
      node = new Object3D();
      node.name = 'DriveNode';
    });

    it('returns null when Direction is missing', () => {
      const rv = { Drive: {} };
      const result = constructDrive(node, rv, rv.Drive, 'root/DriveNode', registry);
      expect(result).toBeNull();
    });

    it('constructs an RVDrive with minimal extras (Direction only)', () => {
      const driveData = { Direction: 'LinearX' };
      const rv = { Drive: driveData };
      const result = constructDrive(node, rv, driveData, 'root/DriveNode', registry);
      expect(result).not.toBeNull();
      expect(result!.drive).toBeInstanceOf(RVDrive);
      expect(result!.behaviors).toEqual([]);
      expect(result!.pendingBehaviors).toEqual([]);
      // node.userData was tagged
      expect(node.userData._rvType).toBe('Drive');
      // registry has the drive registered
      const entries = registry.getComponentsAt('root/DriveNode');
      const driveEntry = entries.find(([t]) => t === 'Drive');
      expect(driveEntry).toBeDefined();
      expect(driveEntry![1]).toBe(result!.drive);
    });

    it('collects Drive_Simple as a behavior with a pending component', () => {
      const driveData = { Direction: 'LinearX' };
      const rv = {
        Drive: driveData,
        Drive_Simple: { /* schema-default extras */ },
      };
      const result = constructDrive(node, rv, driveData, 'root/DriveNode', registry);
      expect(result).not.toBeNull();
      expect(result!.behaviors).toEqual(['Drive_Simple']);
      expect(result!.pendingBehaviors.length).toBe(1);
      expect(result!.pendingBehaviors[0].type).toBe('Drive_Simple');
      expect(result!.pendingBehaviors[0].path).toBe('root/DriveNode');
      // drive collected the behavior in its own arrays
      expect(result!.drive.Behaviors).toEqual(['Drive_Simple']);
      expect(result!.drive.BehaviorExtras['Drive_Simple']).toBeDefined();
    });

    it('invokes onBehaviorExtras callback for every collected behavior (for validation hook)', () => {
      const driveData = { Direction: 'LinearX' };
      const drive_simple_extras = { foo: 1 };
      const drive_cyl_extras = { bar: 2 };
      const rv = {
        Drive: driveData,
        Drive_Simple: drive_simple_extras,
        Drive_Cylinder: drive_cyl_extras,
      };
      const seen: Array<{ key: string; data: unknown }> = [];
      const result = constructDrive(
        node, rv, driveData, 'root/DriveNode', registry, signalStore,
        (key, data) => { seen.push({ key, data }); },
      );
      expect(result).not.toBeNull();
      // both behaviors must be reported via callback
      const keys = seen.map(s => s.key).sort();
      expect(keys).toEqual(['Drive_Cylinder', 'Drive_Simple']);
      // data matches the original extras references (not copies)
      const simpleEntry = seen.find(s => s.key === 'Drive_Simple');
      expect(simpleEntry!.data).toBe(drive_simple_extras);
    });

    it('does NOT create pending components for unrecognized Drive_* keys', () => {
      const driveData = { Direction: 'LinearX' };
      const rv = {
        Drive: driveData,
        Drive_Unknown: { foo: 1 },
      };
      const result = constructDrive(node, rv, driveData, 'root/DriveNode', registry);
      expect(result).not.toBeNull();
      // The key is still collected on the drive (passed through to drive.Behaviors)
      expect(result!.drive.Behaviors).toEqual(['Drive_Unknown']);
      // But no pending behavior instance is created (no entry in DRIVE_BEHAVIOR_MAP)
      expect(result!.pendingBehaviors).toEqual([]);
    });
  });
});

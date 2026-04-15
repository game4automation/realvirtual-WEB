// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Component Registry Tests
 *
 * Tests for applySchema (all field types), resolveComponentRefs,
 * and getConsumedFieldsFromSchema.
 */
import { describe, it, expect } from 'vitest';
import { Vector3, Object3D } from 'three';
import {
  applySchema,
  resolveComponentRefs,
  registerComponentSchema,
  registerComponent,
  getRegisteredFactories,
  getConsumedFieldsFromSchema,
  type ComponentSchema,
  type RVComponent,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

// ─── applySchema Tests ──────────────────────────────────────────

describe('applySchema', () => {
  it('maps number fields — schema key = property name', () => {
    const instance: Record<string, unknown> = { TargetSpeed: 0 };
    const schema: ComponentSchema = { TargetSpeed: { type: 'number', default: 100 } };
    applySchema(instance, schema, { TargetSpeed: 500 });
    expect(instance.TargetSpeed).toBe(500);
  });

  it('uses default when field missing from extras', () => {
    const instance: Record<string, unknown> = { TargetSpeed: 0 };
    const schema: ComponentSchema = { TargetSpeed: { type: 'number', default: 100 } };
    applySchema(instance, schema, {});
    expect(instance.TargetSpeed).toBe(100);
  });

  it('uses default when field is null', () => {
    const instance: Record<string, unknown> = { TargetSpeed: 0 };
    const schema: ComponentSchema = { TargetSpeed: { type: 'number', default: 100 } };
    applySchema(instance, schema, { TargetSpeed: null });
    expect(instance.TargetSpeed).toBe(100);
  });

  it('uses default when field is undefined', () => {
    const instance: Record<string, unknown> = { TargetSpeed: 0 };
    const schema: ComponentSchema = { TargetSpeed: { type: 'number', default: 100 } };
    applySchema(instance, schema, { TargetSpeed: undefined });
    expect(instance.TargetSpeed).toBe(100);
  });

  it('coerces boolean values', () => {
    const instance: Record<string, unknown> = { UseLimits: false };
    const schema: ComponentSchema = { UseLimits: { type: 'boolean', default: false } };
    applySchema(instance, schema, { UseLimits: true });
    expect(instance.UseLimits).toBe(true);
  });

  it('maps string fields', () => {
    const instance: Record<string, unknown> = { Name: '' };
    const schema: ComponentSchema = { Name: { type: 'string', default: '' } };
    applySchema(instance, schema, { Name: 'TestDrive' });
    expect(instance.Name).toBe('TestDrive');
  });

  it('maps enum via enumMap', () => {
    const instance: Record<string, unknown> = { Direction: 0 };
    const schema: ComponentSchema = {
      Direction: { type: 'enum', default: 0, enumMap: { LinearX: 0, LinearY: 1, LinearZ: 2 } },
    };
    applySchema(instance, schema, { Direction: 'LinearY' });
    expect(instance.Direction).toBe(1);
  });

  it('uses enum default for unknown enum value', () => {
    const instance: Record<string, unknown> = { Direction: 0 };
    const schema: ComponentSchema = {
      Direction: { type: 'enum', default: 0, enumMap: { LinearX: 0, LinearY: 1 } },
    };
    applySchema(instance, schema, { Direction: 'UnknownValue' });
    expect(instance.Direction).toBe(0);
  });

  it('produces THREE.Vector3 for vector3 type', () => {
    const instance: Record<string, unknown> = { TransportDirection: new Vector3() };
    const schema: ComponentSchema = { TransportDirection: { type: 'vector3' } };
    applySchema(instance, schema, { TransportDirection: { x: 1, y: 2, z: 3 } });
    expect(instance.TransportDirection).toBeInstanceOf(Vector3);
    const v = instance.TransportDirection as Vector3;
    expect(v.x).toBe(1);
    expect(v.y).toBe(2);
    expect(v.z).toBe(3);
  });

  it('produces THREE.Vector3 with unityCoords (negate X)', () => {
    const instance: Record<string, unknown> = { TransportDirection: new Vector3() };
    const schema: ComponentSchema = { TransportDirection: { type: 'vector3', unityCoords: true } };
    applySchema(instance, schema, { TransportDirection: { x: 1, y: 0, z: 0 } });
    expect(instance.TransportDirection).toBeInstanceOf(Vector3);
    const v = instance.TransportDirection as Vector3;
    expect(v.x).toBe(-1); // Unity LHS -> glTF RHS: negate X
    expect(v.y).toBe(0);
    expect(v.z).toBe(0);
  });

  it('resolves field aliases', () => {
    const instance: Record<string, unknown> = { UseRaycast: false };
    const schema: ComponentSchema = { UseRaycast: { type: 'boolean', default: false, aliases: ['Mode'] } };
    applySchema(instance, schema, { Mode: true });
    expect(instance.UseRaycast).toBe(true);
  });

  it('prefers primary key over alias', () => {
    const instance: Record<string, unknown> = { UseRaycast: false };
    const schema: ComponentSchema = { UseRaycast: { type: 'boolean', default: false, aliases: ['Mode'] } };
    applySchema(instance, schema, { UseRaycast: true, Mode: false });
    expect(instance.UseRaycast).toBe(true);
  });

  it('preserves raw ComponentRef for later resolution', () => {
    const ref = { type: 'ComponentReference', path: 'Robot/Grip', componentType: 'realvirtual.PLCOutputBool' };
    const instance: Record<string, unknown> = { SignalPick: null };
    const schema: ComponentSchema = { SignalPick: { type: 'componentRef' } };
    applySchema(instance, schema, { SignalPick: ref });
    expect(instance.SignalPick).toEqual(ref);
  });

  it('handles multiple fields in one schema', () => {
    const instance: Record<string, unknown> = { TargetSpeed: 0, UseLimits: false, Direction: 0 };
    const schema: ComponentSchema = {
      TargetSpeed: { type: 'number', default: 100 },
      UseLimits: { type: 'boolean', default: false },
      Direction: { type: 'enum', default: 0, enumMap: { LinearX: 0, LinearY: 1 } },
    };
    applySchema(instance, schema, { TargetSpeed: 200, UseLimits: true, Direction: 'LinearY' });
    expect(instance.TargetSpeed).toBe(200);
    expect(instance.UseLimits).toBe(true);
    expect(instance.Direction).toBe(1);
  });

  it('does not modify fields not in schema', () => {
    const instance: Record<string, unknown> = { TargetSpeed: 0, ExtraField: 'keep' };
    const schema: ComponentSchema = { TargetSpeed: { type: 'number', default: 100 } };
    applySchema(instance, schema, { TargetSpeed: 500 });
    expect(instance.ExtraField).toBe('keep');
  });
});

// ─── resolveComponentRefs Tests ─────────────────────────────────

describe('resolveComponentRefs', () => {
  function createMockRegistry(): NodeRegistry {
    const registry = new NodeRegistry();
    // Register nodes
    const signalNode = new Object3D();
    signalNode.name = 'PickPart';
    registry.registerNode('Robot/PickPart', signalNode);
    registry.register('PLCOutputBool', 'Robot/PickPart', { address: 'Robot/PickPart', signalName: 'PickPart' });

    const sensorNode = new Object3D();
    sensorNode.name = 'Sensor1';
    registry.registerNode('Cell/Sensor1', sensorNode);
    const mockSensor = { node: sensorNode, occupied: false };
    registry.register('Sensor', 'Cell/Sensor1', mockSensor);

    const driveNode = new Object3D();
    driveNode.name = 'Drive1';
    registry.registerNode('Cell/Drive1', driveNode);
    const mockDrive = { node: driveNode, name: 'Drive1' };
    registry.register('Drive', 'Cell/Drive1', mockDrive);

    return registry;
  }

  it('resolves signal ComponentRef to address string', () => {
    const registry = createMockRegistry();
    const instance: Record<string, unknown> = {
      SignalPick: {
        type: 'ComponentReference',
        path: 'Robot/PickPart',
        componentType: 'realvirtual.PLCOutputBool',
      },
    };
    resolveComponentRefs(instance, registry);
    expect(typeof instance.SignalPick).toBe('string');
    expect(instance.SignalPick).toBe('Robot/PickPart');
  });

  it('resolves sensor ComponentRef to sensor instance', () => {
    const registry = createMockRegistry();
    const instance: Record<string, unknown> = {
      PartToGrip: {
        type: 'ComponentReference',
        path: 'Cell/Sensor1',
        componentType: 'realvirtual.Sensor',
      },
    };
    resolveComponentRefs(instance, registry);
    expect(instance.PartToGrip).not.toBeNull();
    expect((instance.PartToGrip as { node: Object3D }).node.name).toBe('Sensor1');
  });

  it('resolves drive ComponentRef to drive instance', () => {
    const registry = createMockRegistry();
    const instance: Record<string, unknown> = {
      DriveRef: {
        type: 'ComponentReference',
        path: 'Cell/Drive1',
        componentType: 'realvirtual.Drive',
      },
    };
    resolveComponentRefs(instance, registry);
    expect(instance.DriveRef).not.toBeNull();
    expect((instance.DriveRef as { name: string }).name).toBe('Drive1');
  });

  it('leaves primitive fields untouched', () => {
    const registry = createMockRegistry();
    const instance: Record<string, unknown> = {
      GripRange: 50,
      Name: 'test',
      Active: true,
    };
    resolveComponentRefs(instance, registry);
    expect(instance.GripRange).toBe(50);
    expect(instance.Name).toBe('test');
    expect(instance.Active).toBe(true);
  });

  it('sets unresolvable ref to null (does not throw)', () => {
    const registry = createMockRegistry();
    const instance: Record<string, unknown> = {
      SignalPick: {
        type: 'ComponentReference',
        path: 'Missing/Path',
        componentType: 'realvirtual.PLCOutputBool',
      },
    };
    // Should not throw
    resolveComponentRefs(instance, registry);
    // Signal refs return path even if not found (fallback in registry.resolve)
    expect(instance.SignalPick).toBe('Missing/Path');
  });

  it('handles null value in instance (not a ref)', () => {
    const registry = createMockRegistry();
    const instance: Record<string, unknown> = {
      SignalPick: null,
      GripRange: 50,
    };
    resolveComponentRefs(instance, registry);
    expect(instance.SignalPick).toBeNull();
    expect(instance.GripRange).toBe(50);
  });
});

// ─── getConsumedFieldsFromSchema Tests ──────────────────────────

describe('getConsumedFieldsFromSchema', () => {
  it('returns schema keys for registered component', () => {
    const schema: ComponentSchema = {
      TargetSpeed: { type: 'number', default: 100 },
      UseLimits: { type: 'boolean', default: false },
    };
    registerComponentSchema('TestComponent', schema);
    const fields = getConsumedFieldsFromSchema('TestComponent');
    expect(fields).toContain('TargetSpeed');
    expect(fields).toContain('UseLimits');
  });

  it('includes aliases in consumed fields', () => {
    const schema: ComponentSchema = {
      UseRaycast: { type: 'boolean', default: false, aliases: ['Mode'] },
    };
    registerComponentSchema('TestSensor', schema);
    const fields = getConsumedFieldsFromSchema('TestSensor');
    expect(fields).toContain('UseRaycast');
    expect(fields).toContain('Mode');
  });

  it('returns empty for unregistered component', () => {
    const fields = getConsumedFieldsFromSchema('UnknownComponent');
    expect(fields).toEqual([]);
  });
});

// ─── registerComponent / getRegisteredFactories Tests ────────────

describe('registerComponent (factory auto-discovery)', () => {
  class FakeComponent implements RVComponent {
    static readonly schema: ComponentSchema = {
      Speed: { type: 'number', default: 50 },
    };
    readonly node: Object3D;
    isOwner = true;
    Speed = 50;
    constructor(node: Object3D) { this.node = node; }
    init(_ctx: ComponentContext): void { /* noop */ }
  }

  it('registers factory and makes it discoverable', () => {
    registerComponent({
      type: 'FakeComponent',
      schema: FakeComponent.schema,
      create: (node) => new FakeComponent(node),
    });
    const factories = getRegisteredFactories();
    expect(factories.has('FakeComponent')).toBe(true);
  });

  it('factory creates correct instance', () => {
    const factory = getRegisteredFactories().get('FakeComponent')!;
    const node = new Object3D();
    const instance = factory.create(node, null);
    expect(instance).toBeInstanceOf(FakeComponent);
    expect(instance.node).toBe(node);
  });

  it('also registers schema for CONSUMED field derivation', () => {
    const fields = getConsumedFieldsFromSchema('FakeComponent');
    expect(fields).toContain('Speed');
  });

  it('supports needsAABB flag', () => {
    registerComponent({
      type: 'AABBComponent',
      schema: {},
      needsAABB: true,
      create: (node) => new FakeComponent(node),
    });
    const factory = getRegisteredFactories().get('AABBComponent')!;
    expect(factory.needsAABB).toBe(true);
  });

  it('supports beforeSchema and afterCreate hooks', () => {
    const calls: string[] = [];
    registerComponent({
      type: 'HookedComponent',
      schema: FakeComponent.schema,
      create: (node) => new FakeComponent(node),
      beforeSchema: () => { calls.push('before'); },
      afterCreate: () => { calls.push('after'); },
    });
    const factory = getRegisteredFactories().get('HookedComponent')!;
    const node = new Object3D();
    const inst = factory.create(node, null);
    factory.beforeSchema!(inst, {});
    factory.afterCreate!(inst, node);
    expect(calls).toEqual(['before', 'after']);
  });
});

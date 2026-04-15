// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * NodeRegistry Tests
 *
 * Tests centralized object discovery: path lookup, type queries,
 * hierarchy traversal, and ComponentReference resolution.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';

// ─── Helpers ──────────────────────────────────────────────────────

/** Build a hierarchy: root > a > b > c, returning all nodes */
function buildHierarchy(): { root: Object3D; a: Object3D; b: Object3D; c: Object3D } {
  const root = new Object3D();
  root.name = 'Scene';
  const a = new Object3D();
  a.name = 'CellA';
  const b = new Object3D();
  b.name = 'Conveyor';
  const c = new Object3D();
  c.name = 'Motor';
  root.add(a);
  a.add(b);
  b.add(c);
  return { root, a, b, c };
}

/** Register a full hierarchy into the registry */
function registerHierarchy(registry: NodeRegistry, root: Object3D): void {
  root.traverse((node) => {
    if (node === root) return; // skip scene root
    const path = NodeRegistry.computeNodePath(node);
    registry.registerNode(path, node);
  });
}

// ─── computeNodePath Tests ────────────────────────────────────────

describe('NodeRegistry.computeNodePath', () => {
  it('should compute path for deeply nested node', () => {
    const { c } = buildHierarchy();
    expect(NodeRegistry.computeNodePath(c)).toBe('CellA/Conveyor/Motor');
  });

  it('should compute path for direct child of root', () => {
    const { a } = buildHierarchy();
    expect(NodeRegistry.computeNodePath(a)).toBe('CellA');
  });

  it('should compute path for intermediate node', () => {
    const { b } = buildHierarchy();
    expect(NodeRegistry.computeNodePath(b)).toBe('CellA/Conveyor');
  });

  it('should return empty string for root node', () => {
    const root = new Object3D();
    root.name = 'Scene';
    expect(NodeRegistry.computeNodePath(root)).toBe('');
  });
});

// ─── Node Registration & Lookup ───────────────────────────────────

describe('NodeRegistry node registration', () => {
  let registry: NodeRegistry;
  let hierarchy: ReturnType<typeof buildHierarchy>;

  beforeEach(() => {
    registry = new NodeRegistry();
    hierarchy = buildHierarchy();
    registerHierarchy(registry, hierarchy.root);
  });

  it('should find node by exact path', () => {
    expect(registry.getNode('CellA/Conveyor/Motor')).toBe(hierarchy.c);
    expect(registry.getNode('CellA/Conveyor')).toBe(hierarchy.b);
    expect(registry.getNode('CellA')).toBe(hierarchy.a);
  });

  it('should find node by path suffix', () => {
    // "Conveyor/Motor" should match "CellA/Conveyor/Motor"
    expect(registry.getNode('Conveyor/Motor')).toBe(hierarchy.c);
  });

  it('should return null for non-existent path', () => {
    expect(registry.getNode('NonExistent/Path')).toBeNull();
  });

  it('should return path for node via getPathForNode', () => {
    expect(registry.getPathForNode(hierarchy.c)).toBe('CellA/Conveyor/Motor');
    expect(registry.getPathForNode(hierarchy.a)).toBe('CellA');
  });

  it('should return null for unregistered node', () => {
    const orphan = new Object3D();
    expect(registry.getPathForNode(orphan)).toBeNull();
  });
});

// ─── Component Registration & Typed Lookup ────────────────────────

describe('NodeRegistry component registration', () => {
  let registry: NodeRegistry;
  let hierarchy: ReturnType<typeof buildHierarchy>;

  beforeEach(() => {
    registry = new NodeRegistry();
    hierarchy = buildHierarchy();
    registerHierarchy(registry, hierarchy.root);
  });

  it('should register and retrieve component by type and path', () => {
    const mockDrive = { name: 'testDrive' };
    registry.register('Drive', 'CellA/Conveyor', mockDrive);

    expect(registry.getByPath('Drive', 'CellA/Conveyor')).toBe(mockDrive);
  });

  it('should return null for unregistered type', () => {
    expect(registry.getByPath('Drive', 'CellA/Conveyor')).toBeNull();
  });

  it('should support multiple component types on same path', () => {
    const mockDrive = { name: 'drive' };
    const mockSurface = { name: 'surface' };
    registry.register('Drive', 'CellA/Conveyor', mockDrive);
    registry.register('TransportSurface', 'CellA/Conveyor', mockSurface);

    expect(registry.getByPath('Drive', 'CellA/Conveyor')).toBe(mockDrive);
    expect(registry.getByPath('TransportSurface', 'CellA/Conveyor')).toBe(mockSurface);
  });

  it('should find component by path suffix', () => {
    const mockDrive = { name: 'drive' };
    registry.register('Drive', 'CellA/Conveyor', mockDrive);
    expect(registry.getByPath('Drive', 'Conveyor')).toBe(mockDrive);
  });
});

// ─── getAll (FindObjectsOfType) ───────────────────────────────────

describe('NodeRegistry.getAll', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
    const hierarchy = buildHierarchy();
    registerHierarchy(registry, hierarchy.root);
  });

  it('should return all instances of a type', () => {
    registry.register('Drive', 'CellA/Conveyor', { name: 'drive1' });
    registry.register('Drive', 'CellA/Conveyor/Motor', { name: 'drive2' });

    const allDrives = registry.getAll('Drive');
    expect(allDrives.length).toBe(2);
    expect(allDrives.map((d) => d.path).sort()).toEqual([
      'CellA/Conveyor',
      'CellA/Conveyor/Motor',
    ]);
  });

  it('should return empty array for unregistered type', () => {
    expect(registry.getAll('LogicStep')).toEqual([]);
  });

  it('should return single element when only one registered', () => {
    registry.register('Sensor', 'CellA/Conveyor', { name: 'sensor1' });
    const all = registry.getAll('Sensor');
    expect(all.length).toBe(1);
    expect(all[0].path).toBe('CellA/Conveyor');
  });
});

// ─── findInParent (GetComponentInParent) ──────────────────────────

describe('NodeRegistry.findInParent', () => {
  let registry: NodeRegistry;
  let hierarchy: ReturnType<typeof buildHierarchy>;

  beforeEach(() => {
    registry = new NodeRegistry();
    hierarchy = buildHierarchy();
    registerHierarchy(registry, hierarchy.root);
  });

  it('should find component on the node itself', () => {
    const mockDrive = { name: 'selfDrive' };
    registry.register('Drive', 'CellA/Conveyor', mockDrive);

    expect(registry.findInParent(hierarchy.b, 'Drive')).toBe(mockDrive);
  });

  it('should find component on parent node', () => {
    const mockDrive = { name: 'parentDrive' };
    registry.register('Drive', 'CellA', mockDrive);

    // Motor (c) looks up, finds Drive on CellA (a)
    expect(registry.findInParent(hierarchy.c, 'Drive')).toBe(mockDrive);
  });

  it('should find closest ancestor (not further up)', () => {
    const driveA = { name: 'driveA' };
    const driveB = { name: 'driveB' };
    registry.register('Drive', 'CellA', driveA);
    registry.register('Drive', 'CellA/Conveyor', driveB);

    // Motor (c) finds driveB on Conveyor (b), not driveA on CellA (a)
    expect(registry.findInParent(hierarchy.c, 'Drive')).toBe(driveB);
  });

  it('should return null when no ancestor has the component', () => {
    expect(registry.findInParent(hierarchy.c, 'Drive')).toBeNull();
  });
});

// ─── findInChildren (GetComponentInChildren) ──────────────────────

describe('NodeRegistry.findInChildren', () => {
  let registry: NodeRegistry;
  let hierarchy: ReturnType<typeof buildHierarchy>;

  beforeEach(() => {
    registry = new NodeRegistry();
    hierarchy = buildHierarchy();
    registerHierarchy(registry, hierarchy.root);
  });

  it('should find component on the node itself', () => {
    const mockSensor = { name: 'selfSensor' };
    registry.register('Sensor', 'CellA', mockSensor);

    expect(registry.findInChildren(hierarchy.a, 'Sensor')).toBe(mockSensor);
  });

  it('should find component in child', () => {
    const mockSensor = { name: 'childSensor' };
    registry.register('Sensor', 'CellA/Conveyor/Motor', mockSensor);

    expect(registry.findInChildren(hierarchy.a, 'Sensor')).toBe(mockSensor);
  });

  it('should return null when no child has the component', () => {
    expect(registry.findInChildren(hierarchy.a, 'Sensor')).toBeNull();
  });
});

// ─── findAllInChildren (GetComponentsInChildren) ──────────────────

describe('NodeRegistry.findAllInChildren', () => {
  let registry: NodeRegistry;
  let hierarchy: ReturnType<typeof buildHierarchy>;

  beforeEach(() => {
    registry = new NodeRegistry();
    hierarchy = buildHierarchy();
    registerHierarchy(registry, hierarchy.root);
  });

  it('should collect all descendants with given type', () => {
    registry.register('Sensor', 'CellA/Conveyor', { name: 's1' });
    registry.register('Sensor', 'CellA/Conveyor/Motor', { name: 's2' });

    const all = registry.findAllInChildren(hierarchy.a, 'Sensor');
    expect(all.length).toBe(2);
    expect(all.map((s) => (s.instance as { name: string }).name).sort()).toEqual(['s1', 's2']);
  });

  it('should include self if it has the component', () => {
    registry.register('Drive', 'CellA', { name: 'selfDrive' });
    registry.register('Drive', 'CellA/Conveyor', { name: 'childDrive' });

    const all = registry.findAllInChildren(hierarchy.a, 'Drive');
    expect(all.length).toBe(2);
  });

  it('should return empty array when no children have the type', () => {
    const all = registry.findAllInChildren(hierarchy.a, 'LogicStep');
    expect(all.length).toBe(0);
  });
});

// ─── Duplicate Names ──────────────────────────────────────────────

describe('NodeRegistry duplicate name handling', () => {
  it('should distinguish same-named nodes at different paths', () => {
    const root = new Object3D();
    root.name = 'Scene';

    const cellA = new Object3D();
    cellA.name = 'CellA';
    root.add(cellA);

    const cellB = new Object3D();
    cellB.name = 'CellB';
    root.add(cellB);

    // Both cells have a child named "Sensor"
    const sensorA = new Object3D();
    sensorA.name = 'Sensor';
    cellA.add(sensorA);

    const sensorB = new Object3D();
    sensorB.name = 'Sensor';
    cellB.add(sensorB);

    const registry = new NodeRegistry();
    registerHierarchy(registry, root);

    // Full paths are unique
    expect(registry.getNode('CellA/Sensor')).toBe(sensorA);
    expect(registry.getNode('CellB/Sensor')).toBe(sensorB);
    expect(registry.getNode('CellA/Sensor')).not.toBe(sensorB);
  });
});

// ─── registerAlias (Three.js name dedup) ─────────────────────────

describe('NodeRegistry.registerAlias', () => {
  it('should find renamed node via alias path', () => {
    // Simulate Three.js renaming "Grip" → "Grip_1" for the second node
    const root = new Object3D();
    root.name = 'Scene';

    const robot = new Object3D();
    robot.name = 'Robot';
    root.add(robot);

    // Deep Grip (component, keeps name "Grip")
    const tcp = new Object3D();
    tcp.name = 'TCP';
    robot.add(tcp);
    const gripDeep = new Object3D();
    gripDeep.name = 'Grip';
    tcp.add(gripDeep);

    // Signal Grip (renamed by Three.js to "Grip_1")
    const gripSignal = new Object3D();
    gripSignal.name = 'Grip_1'; // Three.js dedup
    robot.add(gripSignal);

    const registry = new NodeRegistry();
    registerHierarchy(registry, root);

    // Without alias: "Robot/Grip" resolves to the deep Grip via suffix
    expect(registry.getNode('Robot/Grip')).toBeNull(); // suffix "Grip" candidates: "Robot/TCP/Grip" — doesn't endsWith "/Robot/Grip"

    // Register alias for the original path
    registry.registerAlias('Robot/Grip', gripSignal);

    // Now "Robot/Grip" resolves to gripSignal via alias
    expect(registry.getNode('Robot/Grip')).toBe(gripSignal);
  });

  it('should not overwrite existing node registration', () => {
    const root = new Object3D();
    root.name = 'Scene';
    const a = new Object3D();
    a.name = 'NodeA';
    root.add(a);
    const b = new Object3D();
    b.name = 'NodeB';
    root.add(b);

    const registry = new NodeRegistry();
    registerHierarchy(registry, root);

    // Try to register alias with path that already exists
    registry.registerAlias('NodeA', b);
    // Should NOT overwrite — NodeA still points to 'a'
    expect(registry.getNode('NodeA')).toBe(a);
  });

  it('should not affect nodePaths reverse lookup', () => {
    const root = new Object3D();
    root.name = 'Scene';
    const node = new Object3D();
    node.name = 'Grip_1';
    root.add(node);

    const registry = new NodeRegistry();
    registerHierarchy(registry, root);

    // Canonical path is "Grip_1"
    expect(registry.getPathForNode(node)).toBe('Grip_1');

    // Register alias
    registry.registerAlias('Grip', node);

    // Canonical path unchanged
    expect(registry.getPathForNode(node)).toBe('Grip_1');
    // But alias works
    expect(registry.getNode('Grip')).toBe(node);
  });

  it('should resolve signal ComponentRef via alias', () => {
    const root = new Object3D();
    root.name = 'Scene';
    const robot = new Object3D();
    robot.name = 'Robot';
    root.add(robot);
    const gripSignal = new Object3D();
    gripSignal.name = 'Grip_1'; // Renamed by Three.js
    robot.add(gripSignal);

    const registry = new NodeRegistry();
    registerHierarchy(registry, root);
    registry.registerAlias('Robot/Grip', gripSignal);

    // Resolve signal ComponentRef with original C# path
    const ref: ComponentRef = {
      type: 'ComponentReference',
      path: 'Robot/Grip',
      componentType: 'realvirtual.PLCOutputBool',
    };
    const result = registry.resolve(ref);
    // Should resolve to the canonical path (Grip_1), not the alias
    expect(result.signalAddress).toBe('Robot/Grip_1');
  });
});

// ─── resolve (ComponentReference) ─────────────────────────────────

describe('NodeRegistry.resolve', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
    const hierarchy = buildHierarchy();
    registerHierarchy(registry, hierarchy.root);
    registry.register('Drive', 'CellA/Conveyor', { name: 'mockDrive' });
    registry.register('Sensor', 'CellA/Conveyor/Motor', { name: 'mockSensor' });
  });

  it('should resolve Drive reference', () => {
    const ref: ComponentRef = {
      type: 'ComponentReference',
      path: 'CellA/Conveyor',
      componentType: 'realvirtual.Drive',
    };
    const result = registry.resolve(ref);
    expect(result.drive).toEqual({ name: 'mockDrive' });
  });

  it('should resolve Sensor reference', () => {
    const ref: ComponentRef = {
      type: 'ComponentReference',
      path: 'CellA/Conveyor/Motor',
      componentType: 'realvirtual.Sensor',
    };
    const result = registry.resolve(ref);
    expect(result.sensor).toEqual({ name: 'mockSensor' });
  });

  it('should resolve PLC signal reference as address', () => {
    const ref: ComponentRef = {
      type: 'ComponentReference',
      path: 'CellA/Signals/Start',
      componentType: 'realvirtual.PLCOutputBool',
    };
    const result = registry.resolve(ref);
    expect(result.signalAddress).toBe('CellA/Signals/Start');
  });

  it('should return empty for null/undefined ref', () => {
    expect(registry.resolve(null)).toEqual({});
    expect(registry.resolve(undefined)).toEqual({});
  });

  it('should return empty for non-ComponentReference type', () => {
    const ref = { type: 'Other', path: 'foo', componentType: 'Drive' } as ComponentRef;
    expect(registry.resolve(ref)).toEqual({});
  });
});

// ─── clear ────────────────────────────────────────────────────────

describe('NodeRegistry.clear', () => {
  it('should clear all registrations', () => {
    const registry = new NodeRegistry();
    const hierarchy = buildHierarchy();
    registerHierarchy(registry, hierarchy.root);
    registry.register('Drive', 'CellA/Conveyor', { name: 'drive' });

    expect(registry.size.nodes).toBeGreaterThan(0);
    expect(registry.size.components).toBeGreaterThan(0);

    registry.clear();

    expect(registry.size.nodes).toBe(0);
    expect(registry.size.components).toBe(0);
    expect(registry.size.types).toEqual([]);
    expect(registry.getNode('CellA/Conveyor')).toBeNull();
  });
});

// ─── size / stats ─────────────────────────────────────────────────

describe('NodeRegistry.size', () => {
  it('should report correct stats', () => {
    const registry = new NodeRegistry();
    const hierarchy = buildHierarchy();
    registerHierarchy(registry, hierarchy.root);

    registry.register('Drive', 'CellA/Conveyor', { name: 'd1' });
    registry.register('Sensor', 'CellA/Conveyor/Motor', { name: 's1' });
    registry.register('TransportSurface', 'CellA/Conveyor', { name: 'ts1' });

    const s = registry.size;
    expect(s.nodes).toBe(3); // CellA, CellA/Conveyor, CellA/Conveyor/Motor
    expect(s.components).toBe(3); // Drive, Sensor, TransportSurface
    expect(s.types.sort()).toEqual(['Drive', 'Sensor', 'TransportSurface']);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { Object3D } from 'three';

describe('NodeRegistry.search()', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
    const paths = [
      'DemoCell/EntryConveyor',
      'DemoCell/ExitConveyor',
      'DemoCell/Robot/Axis1',
      'DemoCell/Robot/Axis2',
      'DemoCell/Robot/Axis3',
      'DemoCell/Sensors/EntrySensor',
      'DemoCell/Sensors/ExitSensor',
    ];
    for (const path of paths) {
      const obj = new Object3D();
      obj.name = path.split('/').pop()!;
      registry.registerNode(path, obj);
    }
    registry.register('Drive', 'DemoCell/Robot/Axis1', { name: 'Axis1' });
    registry.register('Drive', 'DemoCell/Robot/Axis2', { name: 'Axis2' });
    registry.register('TransportSurface', 'DemoCell/EntryConveyor', { name: 'Entry' });
    registry.register('Sensor', 'DemoCell/Sensors/EntrySensor', { name: 'EntrySensor' });
  });

  it('should find nodes by partial name match', () => {
    const results = registry.search('Axis');
    expect(results).toHaveLength(3);
    expect(results.map(r => r.path)).toContain('DemoCell/Robot/Axis1');
  });

  it('should be case-insensitive', () => {
    expect(registry.search('axis')).toHaveLength(3);
    expect(registry.search('AXIS')).toHaveLength(3);
  });

  it('should return empty array for no matches', () => {
    expect(registry.search('NonExistent')).toHaveLength(0);
  });

  it('should include component types in results', () => {
    const results = registry.search('Axis1');
    expect(results).toHaveLength(1);
    expect(results[0].types).toContain('Drive');
  });

  it('should return types=[] for nodes without components', () => {
    const results = registry.search('Axis3');
    expect(results).toHaveLength(1);
    expect(results[0].types).toEqual([]);
  });

  it('should NOT match parent path segments, only node name', () => {
    // "DemoCell" is a path segment but not a node name
    expect(registry.search('DemoCell')).toHaveLength(0);
    // "Robot" is a path segment but not a node name
    expect(registry.search('Robot')).toHaveLength(0);
  });

  it('should match nodes whose name contains the search term', () => {
    // "Conveyor" matches EntryConveyor and ExitConveyor
    expect(registry.search('Conveyor')).toHaveLength(2);
    // "Sensor" matches EntrySensor and ExitSensor
    expect(registry.search('Sensor')).toHaveLength(2);
  });

  it('should return empty for empty search term', () => {
    expect(registry.search('')).toHaveLength(0);
  });

  it('should match exact node names', () => {
    const results = registry.search('EntryConveyor');
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('DemoCell/EntryConveyor');
  });
});

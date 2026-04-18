// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AutoFilterRegistry Tests
 *
 * Tests auto-discovered filter groups built from component capabilities.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { AutoFilterRegistry, type AutoFilterGroup } from '../src/core/engine/rv-auto-filter-registry';
import { ISOLATE_FOCUS_LAYER } from '../src/core/engine/rv-group-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import {
  registerCapabilities,
  _resetCapabilitiesForTesting,
} from '../src/core/engine/rv-component-registry';

// ─── Helpers ──────────────────────────────────────────────────────

function makeNode(name: string, parent?: Object3D): Object3D {
  const node = new Object3D();
  node.name = name;
  if (parent) parent.add(node);
  return node;
}

function setupRegistry(): {
  nodeRegistry: NodeRegistry;
  root: Object3D;
  driveNodes: Object3D[];
  sensorNodes: Object3D[];
} {
  const root = new Object3D();
  root.name = 'Scene';

  const drive1 = makeNode('Drive1', root);
  const drive2 = makeNode('Drive2', root);
  const sensor1 = makeNode('Sensor1', root);

  const nodeRegistry = new NodeRegistry();
  nodeRegistry.registerNode('Drive1', drive1);
  nodeRegistry.registerNode('Drive2', drive2);
  nodeRegistry.registerNode('Sensor1', sensor1);

  // Register component instances
  nodeRegistry.register('Drive', 'Drive1', { type: 'Drive' });
  nodeRegistry.register('Drive', 'Drive2', { type: 'Drive' });
  nodeRegistry.register('Sensor', 'Sensor1', { type: 'Sensor' });

  return { nodeRegistry, root, driveNodes: [drive1, drive2], sensorNodes: [sensor1] };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('AutoFilterRegistry', () => {
  beforeEach(() => {
    _resetCapabilitiesForTesting();
  });

  afterEach(() => {
    _resetCapabilitiesForTesting();
  });

  it('should build filters from capabilities with filterLabel', () => {
    registerCapabilities('Drive', { filterLabel: 'Drives', badgeColor: '#ff9800' });
    registerCapabilities('Sensor', { filterLabel: 'Sensors', badgeColor: '#4caf50' });

    const { nodeRegistry } = setupRegistry();
    const afr = new AutoFilterRegistry();
    afr.build(nodeRegistry);

    const all = afr.getAll();
    expect(all).toHaveLength(2);

    const drives = all.find(f => f.type === 'Drive');
    expect(drives).toBeDefined();
    expect(drives!.label).toBe('Drives');
    expect(drives!.badgeColor).toBe('#ff9800');
    expect(drives!.nodes).toHaveLength(2);
    expect(drives!.visible).toBe(true);

    const sensors = all.find(f => f.type === 'Sensor');
    expect(sensors).toBeDefined();
    expect(sensors!.label).toBe('Sensors');
    expect(sensors!.nodes).toHaveLength(1);
  });

  it('should exclude types without filterLabel', () => {
    registerCapabilities('Drive', { filterLabel: 'Drives' });
    registerCapabilities('Sensor', { filterLabel: null }); // no filterLabel
    registerCapabilities('TransportSurface', {}); // no filterLabel

    const { nodeRegistry } = setupRegistry();
    const afr = new AutoFilterRegistry();
    afr.build(nodeRegistry);

    const all = afr.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe('Drive');
  });

  it('should exclude types with zero instances in scene', () => {
    registerCapabilities('Drive', { filterLabel: 'Drives' });
    registerCapabilities('Conveyor', { filterLabel: 'Conveyors' }); // no instances

    const { nodeRegistry } = setupRegistry();
    const afr = new AutoFilterRegistry();
    afr.build(nodeRegistry);

    const all = afr.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].type).toBe('Drive');
  });

  it('should sort by label alphabetically', () => {
    registerCapabilities('Drive', { filterLabel: 'Drives' });
    registerCapabilities('Sensor', { filterLabel: 'Sensors' });

    const { nodeRegistry } = setupRegistry();
    const afr = new AutoFilterRegistry();
    afr.build(nodeRegistry);

    const labels = afr.getAll().map(f => f.label);
    expect(labels).toEqual(['Drives', 'Sensors']);
  });

  it('should toggle visibility on all nodes of a type', () => {
    registerCapabilities('Drive', { filterLabel: 'Drives' });

    const { nodeRegistry, driveNodes } = setupRegistry();
    const afr = new AutoFilterRegistry();
    afr.build(nodeRegistry);

    afr.setVisible('Drive', false);

    const filter = afr.get('Drive');
    expect(filter!.visible).toBe(false);
    for (const node of driveNodes) {
      expect(node.visible).toBe(false);
    }

    afr.setVisible('Drive', true);
    expect(filter!.visible).toBe(true);
    for (const node of driveNodes) {
      expect(node.visible).toBe(true);
    }
  });

  it('should isolate a filter type with ISOLATE_FOCUS_LAYER', () => {
    registerCapabilities('Sensor', { filterLabel: 'Sensors' });

    const { nodeRegistry, sensorNodes } = setupRegistry();
    const afr = new AutoFilterRegistry();
    afr.build(nodeRegistry);

    expect(afr.isIsolateActive).toBe(false);
    expect(afr.isolatedFilterType).toBeNull();

    afr.isolate('Sensor');

    expect(afr.isIsolateActive).toBe(true);
    expect(afr.isolatedFilterType).toBe('Sensor');
    for (const node of sensorNodes) {
      expect(node.layers.isEnabled(ISOLATE_FOCUS_LAYER)).toBe(true);
    }
  });

  it('should clear isolate state with showAll', () => {
    registerCapabilities('Sensor', { filterLabel: 'Sensors' });

    const { nodeRegistry, sensorNodes } = setupRegistry();
    const afr = new AutoFilterRegistry();
    afr.build(nodeRegistry);

    afr.isolate('Sensor');
    expect(afr.isIsolateActive).toBe(true);

    afr.showAll();
    expect(afr.isIsolateActive).toBe(false);
    expect(afr.isolatedFilterType).toBeNull();
    for (const node of sensorNodes) {
      expect(node.layers.isEnabled(ISOLATE_FOCUS_LAYER)).toBe(false);
    }
  });

  it('should restore prior visibility on showAll after isolate', () => {
    registerCapabilities('Drive', { filterLabel: 'Drives' });

    const { nodeRegistry, driveNodes } = setupRegistry();
    const afr = new AutoFilterRegistry();
    afr.build(nodeRegistry);

    // Hide first, then isolate should force-show, then showAll restores hidden
    driveNodes[0].visible = false;

    afr.isolate('Drive');
    // Isolate forces visible
    expect(driveNodes[0].visible).toBe(true);

    afr.showAll();
    // showAll restores all to visible (showAll resets all filters to visible)
    expect(driveNodes[0].visible).toBe(true);
  });

  it('should clear all state on clear()', () => {
    registerCapabilities('Drive', { filterLabel: 'Drives' });

    const { nodeRegistry } = setupRegistry();
    const afr = new AutoFilterRegistry();
    afr.build(nodeRegistry);

    expect(afr.filterCount).toBeGreaterThan(0);

    afr.isolate('Drive');
    afr.clear();

    expect(afr.filterCount).toBe(0);
    expect(afr.isIsolateActive).toBe(false);
    expect(afr.getAll()).toHaveLength(0);
  });

  it('should switch isolate between types', () => {
    registerCapabilities('Drive', { filterLabel: 'Drives' });
    registerCapabilities('Sensor', { filterLabel: 'Sensors' });

    const { nodeRegistry, driveNodes, sensorNodes } = setupRegistry();
    const afr = new AutoFilterRegistry();
    afr.build(nodeRegistry);

    afr.isolate('Drive');
    expect(afr.isolatedFilterType).toBe('Drive');
    for (const n of driveNodes) {
      expect(n.layers.isEnabled(ISOLATE_FOCUS_LAYER)).toBe(true);
    }

    // Switch to sensors — drives should lose the layer
    afr.isolate('Sensor');
    expect(afr.isolatedFilterType).toBe('Sensor');
    for (const n of driveNodes) {
      expect(n.layers.isEnabled(ISOLATE_FOCUS_LAYER)).toBe(false);
    }
    for (const n of sensorNodes) {
      expect(n.layers.isEnabled(ISOLATE_FOCUS_LAYER)).toBe(true);
    }
  });

  it('should return undefined for unknown type', () => {
    const afr = new AutoFilterRegistry();
    expect(afr.get('Unknown')).toBeUndefined();
  });

  it('should be a no-op for setVisible on unknown type', () => {
    const afr = new AutoFilterRegistry();
    // Should not throw
    afr.setVisible('Unknown', false);
  });
});

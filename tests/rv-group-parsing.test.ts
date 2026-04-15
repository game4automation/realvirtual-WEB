// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

/** Helper: simulate GLB extras on a node */
function setGroupExtras(node: Object3D, groups: Record<string, unknown>) {
  node.userData = { realvirtual: groups };
}

describe('Group Parsing from GLB Extras', () => {
  it('parses single Group component', () => {
    const node = new Object3D();
    node.name = 'ConveyorBelt';
    setGroupExtras(node, {
      Group: { _fullTypeName: 'realvirtual.Group', _enabled: true, GroupName: 'Conveyors' },
    });

    const registry = new GroupRegistry();
    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    for (const key of Object.keys(rv)) {
      if (key === 'Group' || /^Group_\d+$/.test(key)) {
        const g = rv[key];
        if (g._enabled !== false) {
          registry.register(g.GroupName as string, node);
        }
      }
    }
    expect(registry.get('Conveyors')!.nodes).toContain(node);
  });

  it('parses multiple Group components on same node', () => {
    const node = new Object3D();
    setGroupExtras(node, {
      Group: { _enabled: true, GroupName: 'Conveyors' },
      Group_1: { _enabled: true, GroupName: 'Entry' },
    });

    const registry = new GroupRegistry();
    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    for (const key of Object.keys(rv)) {
      if (key === 'Group' || /^Group_\d+$/.test(key)) {
        const g = rv[key];
        if (g._enabled !== false) registry.register(g.GroupName as string, node);
      }
    }
    expect(registry.getGroupNames()).toContain('Conveyors');
    expect(registry.getGroupNames()).toContain('Entry');
  });

  it('resolves GroupNamePrefix using NodeRegistry', () => {
    const prefixNode = new Object3D();
    prefixNode.name = 'DemoCell';
    const groupNode = new Object3D();

    const nodeReg = new NodeRegistry();
    nodeReg.registerNode('DemoCell', prefixNode);

    setGroupExtras(groupNode, {
      Group: { _enabled: true, GroupName: 'Conveyors', GroupNamePrefix: 'DemoCell' },
    });

    const rv = groupNode.userData.realvirtual as Record<string, Record<string, unknown>>;
    const g = rv.Group;
    let resolvedName = g.GroupName as string;
    if (g.GroupNamePrefix) {
      const prefixObj = nodeReg.getNode(g.GroupNamePrefix as string);
      if (prefixObj) resolvedName = prefixObj.name + (g.GroupName as string);
    }
    expect(resolvedName).toBe('DemoCellConveyors');
  });

  it('falls back to raw GroupName if prefix not found', () => {
    const groupNode = new Object3D();
    const nodeReg = new NodeRegistry();

    setGroupExtras(groupNode, {
      Group: { _enabled: true, GroupName: 'Conveyors', GroupNamePrefix: 'NonExistent/Path' },
    });

    const rv = groupNode.userData.realvirtual as Record<string, Record<string, unknown>>;
    const g = rv.Group;
    let resolvedName = g.GroupName as string;
    if (g.GroupNamePrefix) {
      const prefixObj = nodeReg.getNode(g.GroupNamePrefix as string);
      if (prefixObj) resolvedName = prefixObj.name + (g.GroupName as string);
    }
    expect(resolvedName).toBe('Conveyors');
  });

  it('skips disabled Group components (_enabled: false)', () => {
    const node = new Object3D();
    setGroupExtras(node, {
      Group: { _enabled: false, GroupName: 'Disabled' },
      Group_1: { _enabled: true, GroupName: 'Active' },
    });

    const registry = new GroupRegistry();
    const rv = node.userData.realvirtual as Record<string, Record<string, unknown>>;
    for (const key of Object.keys(rv)) {
      if (key === 'Group' || /^Group_\d+$/.test(key)) {
        const g = rv[key];
        if (g._enabled !== false) registry.register(g.GroupName as string, node);
      }
    }
    expect(registry.getGroupNames()).toEqual(['Active']);
  });
});

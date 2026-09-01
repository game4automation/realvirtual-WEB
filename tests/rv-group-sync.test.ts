// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Group as ThreeGroup, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import {
  GROUP_KEY_RE,
  getGroupComponentKeys,
  resolveGroupName,
  syncNodeGroups,
  syncSubtreeGroups,
  type GroupSyncHost,
} from '../src/core/engine/rv-group-sync';

function makeHost(groups: GroupRegistry | null = null): GroupSyncHost {
  return { groups, registry: { getNode: () => null } };
}

function nodeWithGroups(...names: string[]): Object3D {
  const node = new Object3D();
  const rv: Record<string, unknown> = {};
  names.forEach((name, i) => {
    rv[i === 0 ? 'Group' : `Group_${i}`] = { GroupName: name };
  });
  node.userData['realvirtual'] = rv;
  return node;
}

describe('GROUP_KEY_RE / getGroupComponentKeys', () => {
  it('matches Group and Group_N keys only', () => {
    expect(GROUP_KEY_RE.test('Group')).toBe(true);
    expect(GROUP_KEY_RE.test('Group_1')).toBe(true);
    expect(GROUP_KEY_RE.test('Group_12')).toBe(true);
    expect(GROUP_KEY_RE.test('GroupName')).toBe(false);
    expect(GROUP_KEY_RE.test('Grouping')).toBe(false);
    expect(GROUP_KEY_RE.test('Group_')).toBe(false);
  });

  it('collects Group keys from an rv extras object', () => {
    const rv = { Group: {}, Group_1: {}, Drive: {}, GroupName: {} };
    expect(getGroupComponentKeys(rv)).toEqual(['Group', 'Group_1']);
    expect(getGroupComponentKeys(undefined)).toEqual([]);
  });
});

describe('resolveGroupName', () => {
  it('returns GroupName as-is without prefix', () => {
    expect(resolveGroupName({ GroupName: 'Conveyors' }, null)).toBe('Conveyors');
  });

  it('skips disabled and unnamed components', () => {
    expect(resolveGroupName({ GroupName: 'X', _enabled: false }, null)).toBeNull();
    expect(resolveGroupName({}, null)).toBeNull();
    expect(resolveGroupName({ GroupName: '' }, null)).toBeNull();
  });

  it('prepends the prefix node name when resolvable (buildGroups parity)', () => {
    const prefixNode = new Object3D();
    prefixNode.name = 'Line1';
    const registry = { getNode: (p: string) => (p === 'Root/Line1' ? prefixNode : null) };
    expect(resolveGroupName({ GroupName: 'Belt', GroupNamePrefix: 'Root/Line1' }, registry)).toBe('Line1Belt');
    // Unresolvable prefix falls back to the plain name
    expect(resolveGroupName({ GroupName: 'Belt', GroupNamePrefix: 'Missing' }, registry)).toBe('Belt');
  });
});

describe('syncNodeGroups', () => {
  it('lazily creates the registry and adds memberships', () => {
    const host = makeHost(null);
    const node = nodeWithGroups('Conveyors');
    expect(syncNodeGroups(host, node)).toBe(true);
    expect(host.groups).not.toBeNull();
    expect(host.groups!.getGroupNamesForNode(node)).toEqual(['Conveyors']);
  });

  it('removes membership when the Group component is gone', () => {
    const host = makeHost(new GroupRegistry());
    const node = nodeWithGroups('Conveyors');
    syncNodeGroups(host, node);
    delete (node.userData['realvirtual'] as Record<string, unknown>)['Group'];
    expect(syncNodeGroups(host, node)).toBe(true);
    expect(host.groups!.getGroupNamesForNode(node)).toEqual([]);
    expect(host.groups!.getGroupNames()).not.toContain('Conveyors');
  });

  it('moves membership on GroupName rename', () => {
    const host = makeHost(new GroupRegistry());
    const node = nodeWithGroups('Old');
    syncNodeGroups(host, node);
    ((node.userData['realvirtual'] as Record<string, unknown>)['Group'] as Record<string, unknown>)['GroupName'] = 'New';
    expect(syncNodeGroups(host, node)).toBe(true);
    expect(host.groups!.getGroupNamesForNode(node)).toEqual(['New']);
    expect(host.groups!.getGroupNames()).not.toContain('Old');
  });

  it('supports multiple Group components per node', () => {
    const host = makeHost(new GroupRegistry());
    const node = nodeWithGroups('A', 'B');
    expect(syncNodeGroups(host, node)).toBe(true);
    expect(host.groups!.getGroupNamesForNode(node)).toEqual(['A', 'B']);
  });

  it('is idempotent — second sync without changes reports false', () => {
    const host = makeHost(new GroupRegistry());
    const node = nodeWithGroups('A');
    syncNodeGroups(host, node);
    expect(syncNodeGroups(host, node)).toBe(false);
  });

  it('does not create a registry for a node without groups', () => {
    const host = makeHost(null);
    expect(syncNodeGroups(host, new Object3D())).toBe(false);
    expect(host.groups).toBeNull();
  });
});

describe('syncSubtreeGroups', () => {
  it('detach unregisters every node of the subtree; attach restores from extras', () => {
    const host = makeHost(new GroupRegistry());
    const root = nodeWithGroups('Roots');
    const child = nodeWithGroups('Children');
    root.add(child);
    syncSubtreeGroups(host, root, 'attach');
    expect(host.groups!.getGroupNames()).toEqual(['Children', 'Roots']);

    expect(syncSubtreeGroups(host, root, 'detach')).toBe(true);
    expect(host.groups!.getGroupNames()).toEqual([]);

    expect(syncSubtreeGroups(host, root, 'attach')).toBe(true);
    expect(host.groups!.getGroupNamesForNode(root)).toEqual(['Roots']);
    expect(host.groups!.getGroupNamesForNode(child)).toEqual(['Children']);
  });

  it('detach with no memberships reports false', () => {
    const host = makeHost(new GroupRegistry());
    expect(syncSubtreeGroups(host, new Object3D(), 'detach')).toBe(false);
  });
});

// ─── the wiring, not just the function ───────────────────────────────────────
// Every test above calls syncNodeGroups directly, which says nothing about
// whether anything ever calls it. That gap is expensive: a Group component that
// reaches userData without reaching the GroupRegistry produces a kinematic axis
// whose drive gizmo moves an empty node — visible only by dragging it. So this
// block goes through the REAL AssetDocument/executor, the way every group author
// does (group-actions.ts' addComponent, and the PLMXML import's group mode).

describe('the asset executor keeps viewer.groups in sync (real op path)', () => {
  function makeDocViewer() {
    const scene = new Scene();
    const model = new ThreeGroup();
    model.name = 'Asset';
    scene.add(model);
    const part = new Object3D();
    part.name = 'Part';
    model.add(part);
    const part2 = new Object3D();
    part2.name = 'Part2';
    model.add(part2);
    const registry = new NodeRegistry();
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const viewer = {
      scene,
      registry,
      groups: null as GroupRegistry | null,
      signalStore: null,
      transportManager: null,
      get currentModelRoot() { return model; },
      markRenderDirty() {},
      markShadowsDirty() {},
      emit() {},
      rebuildGroupedBvh() {},
    } as unknown as RVViewer;
    return {
      viewer, part, part2,
      partPath: NodeRegistry.computeNodePath(part),
      part2Path: NodeRegistry.computeNodePath(part2),
    };
  }

  it('addComponent Group registers the member immediately — no save, no reload', async () => {
    const { viewer, part, partPath } = makeDocViewer();
    const doc = scratchAssetDocument(viewer);

    doc.addComponent(partPath, 'Group', { GroupName: 'ZL1_axis' });
    await doc.whenIdle();

    expect(viewer.groups).not.toBeNull();
    expect(viewer.groups!.get('ZL1_axis')?.nodes).toEqual([part]);
    doc.dispose();
  });

  it('memberships survive a whole transaction and unwind on undo', async () => {
    const { viewer, part, part2, partPath, part2Path } = makeDocViewer();
    const doc = scratchAssetDocument(viewer);

    // One transaction, one fire-and-forget Group op per member — the exact shape
    // the PLMXML import applies (plmxml-import.ts, group mode: one addComponent
    // per top-level member of an axis, none of them awaited individually).
    await doc.withTransaction('Import kinematics', async () => {
      doc.addComponent(partPath, 'Group', { GroupName: 'ZL1_axis' });
      doc.addComponent(part2Path, 'Group', { GroupName: 'ZL1_axis' });
      await doc.whenIdle();
    });
    expect(viewer.groups!.get('ZL1_axis')?.nodes).toEqual([part, part2]);

    // Undo of the composite must take the whole group with it — otherwise a
    // reverted import leaves an axis driving nodes it no longer owns.
    await doc.undo();
    expect(viewer.groups!.getGroupNames()).toEqual([]);

    await doc.redo();
    expect(viewer.groups!.get('ZL1_axis')?.nodes).toEqual([part, part2]);
    doc.dispose();
  });

  it('a node in two groups is registered in both', async () => {
    const { viewer, part, partPath } = makeDocViewer();
    const doc = scratchAssetDocument(viewer);

    // Awaited one at a time on purpose: `addComponent` derives its `_N` key from
    // the node's CURRENT extras, so two un-awaited adds of the SAME base type on
    // the SAME node both resolve to `Group` and the second overwrites the first.
    // Not this module's concern (the import writes one Group per node), but the
    // reason this case is written the way it is.
    doc.addComponent(partPath, 'Group', { GroupName: 'ZL1_axis' });
    await doc.whenIdle();
    doc.addComponent(partPath, 'Group', { GroupName: 'Maintenance' });
    await doc.whenIdle();

    expect(viewer.groups!.getGroupNamesForNode(part).sort())
      .toEqual(['Maintenance', 'ZL1_axis']);
    doc.dispose();
  });

  it('removeComponent and a renamed GroupName unregister the old membership', async () => {
    const { viewer, part, partPath } = makeDocViewer();
    const doc = scratchAssetDocument(viewer);

    doc.addComponent(partPath, 'Group', { GroupName: 'Old' });
    await doc.whenIdle();
    doc.setField(partPath, 'Group', 'GroupName', 'New', 'Old');
    await doc.whenIdle();
    expect(viewer.groups!.getGroupNamesForNode(part)).toEqual(['New']);

    doc.removeComponent(partPath, 'Group');
    await doc.whenIdle();
    expect(viewer.groups!.getGroupNamesForNode(part)).toEqual([]);
    doc.dispose();
  });
});

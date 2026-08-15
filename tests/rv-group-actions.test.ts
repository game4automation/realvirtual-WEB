// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import type { AddComponentOp, RemoveComponentOp } from '../src/core/editor/rv-asset-ops';
import type { RvAssetOp } from '../src/core/ops/rv-unified-ops';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import {
  nodeHasGroupNamed,
  listGroupNamesForMenu,
  listKinematicsForMenu,
  buildKinematicMenuItems,
  selectionHasAnyGroup,
  sceneHasKinematicForGroup,
  kinematicGroupNodesForSelection,
  groupSelection,
  ungroupSelection,
  autoAssignToKinematic,
} from '@rv-private/plugins/asset-editor/group-actions';
import { createKinematicWithGroup } from '@rv-private/plugins/asset-editor/kinematics/create-actions';

/** Fake AssetDocument capturing withTransaction/applyOp/create/addComponent calls. */
function makeDoc() {
  const ops: RvAssetOp[] = [];
  const transactions: string[] = [];
  const created: { parentPath: string | null; baseName: string }[] = [];
  const doc = {
    async withTransaction(label: string, fn: () => Promise<void>) {
      transactions.push(label);
      await fn();
    },
    async applyOp(op: RvAssetOp) {
      ops.push(op);
    },
    async createEmptyNode(parentPath: string | null, baseName: string) {
      created.push({ parentPath, baseName });
      return baseName;
    },
    addComponent(nodePath: string, baseType: string, fields: Record<string, unknown>) {
      ops.push({ kind: 'addComponent', nodePath, componentType: baseType, fields } as unknown as RvAssetOp);
      return baseType;
    },
  };
  return { doc: doc as unknown as AssetDocument, ops, transactions, created };
}

/** Fake viewer with a path→node registry, a traversable model root for the
 *  kinematic scan, and a recording selection manager. */
function makeViewer(nodes: Record<string, Object3D>, groups: GroupRegistry | null = null) {
  const root = new Object3D();
  for (const node of Object.values(nodes)) root.add(node);
  const selected: string[] = [];
  const revealed: string[] = [];
  const viewer = {
    groups,
    registry: { getNode: (p: string) => nodes[p] ?? null },
    currentModelRoot: root,
    selectionManager: { select: (p: string) => selected.push(p) },
    getPlugin: () => ({ selectAndRevealExclusive: (p: string) => revealed.push(p) }),
  } as unknown as RVViewer;
  return Object.assign(viewer, { _selected: selected, _revealed: revealed });
}

function nodeWith(rv: Record<string, unknown> | null): Object3D {
  const node = new Object3D();
  if (rv) node.userData['realvirtual'] = rv;
  return node;
}

describe('nodeHasGroupNamed', () => {
  it('matches GroupName across all Group* keys', () => {
    const node = nodeWith({ Group: { GroupName: 'A' }, Group_1: { GroupName: 'B' } });
    expect(nodeHasGroupNamed(node, 'A')).toBe(true);
    expect(nodeHasGroupNamed(node, 'B')).toBe(true);
    expect(nodeHasGroupNamed(node, 'C')).toBe(false);
    expect(nodeHasGroupNamed(nodeWith(null), 'A')).toBe(false);
  });
});

describe('listGroupNamesForMenu', () => {
  it('lists registry names excluding kinematic groups; empty when no registry', () => {
    const groups = new GroupRegistry();
    groups.register('UserGroup', new Object3D());
    groups.register('KinGroup', new Object3D());
    groups.markAsKinematic('KinGroup');
    expect(listGroupNamesForMenu(makeViewer({}, groups))).toEqual(['UserGroup']);
    expect(listGroupNamesForMenu(makeViewer({}, null))).toEqual([]);
  });
});

describe('selectionHasAnyGroup', () => {
  it('true when any selected node carries a Group component', () => {
    const nodes = {
      a: nodeWith(null),
      b: nodeWith({ Group: { GroupName: 'X' } }),
    };
    const viewer = makeViewer(nodes);
    expect(selectionHasAnyGroup(viewer, ['a'])).toBe(false);
    expect(selectionHasAnyGroup(viewer, ['a', 'b'])).toBe(true);
    expect(selectionHasAnyGroup(viewer, ['missing'])).toBe(false);
  });
});

describe('sceneHasKinematicForGroup', () => {
  it('finds Kinematic components (any _N key) referencing the group', () => {
    const nodes = {
      axis: nodeWith({ Kinematic_1: { GroupName: 'Line1' } }),
      other: nodeWith({ Kinematic: { GroupName: 'Other' } }),
    };
    const viewer = makeViewer(nodes);
    expect(sceneHasKinematicForGroup(viewer, 'Line1')).toBe(true);
    expect(sceneHasKinematicForGroup(viewer, 'Other')).toBe(true);
    expect(sceneHasKinematicForGroup(viewer, 'Nope')).toBe(false);
  });
});

describe('kinematicGroupNodesForSelection', () => {
  it('collects the group members referenced by Kinematic components on the selection', () => {
    const m1 = new Object3D();
    const m2 = new Object3D();
    const groups = new GroupRegistry();
    groups.register('Axis1', m1);
    groups.register('Axis1', m2);
    const nodes = {
      kin: nodeWith({ Kinematic: { GroupName: 'Axis1' } }),
      plain: nodeWith(null),
      empty: nodeWith({ Kinematic: { GroupName: '' } }),
    };
    const viewer = makeViewer(nodes, groups);
    expect(new Set(kinematicGroupNodesForSelection(viewer, ['kin']))).toEqual(new Set([m1, m2]));
    expect(kinematicGroupNodesForSelection(viewer, ['plain'])).toEqual([]);
    expect(kinematicGroupNodesForSelection(viewer, ['empty'])).toEqual([]);
    expect(kinematicGroupNodesForSelection(viewer, ['missing'])).toEqual([]);
  });
});

describe('groupSelection', () => {
  it('adds one Group op per node + auto-creates a selected Kinematic root node, ONE transaction', async () => {
    const nodes = { a: nodeWith(null), b: nodeWith(null) };
    const viewer = makeViewer(nodes);
    const { doc, ops, transactions, created } = makeDoc();
    await groupSelection(viewer, doc, ['a', 'b'], 'Line1');

    expect(transactions).toHaveLength(1);
    expect(ops).toHaveLength(3);
    for (const op of ops.slice(0, 2) as AddComponentOp[]) {
      expect(op.kind).toBe('addComponent');
      expect(op.componentType).toBe('Group');
      expect(op.fields).toEqual({ GroupName: 'Line1' });
    }
    expect((ops[0] as AddComponentOp).nodePath).toBe('a');
    expect((ops[1] as AddComponentOp).nodePath).toBe('b');

    // No Kinematic referenced "Line1" → a top-level node named after the
    // group is created, gets the linked Kinematic, and ends up selected.
    expect(created).toEqual([{ parentPath: null, baseName: 'Line1' }]);
    const kin = ops[2] as AddComponentOp;
    expect(kin.componentType).toBe('Kinematic');
    expect(kin.nodePath).toBe('Line1');
    expect(kin.fields).toMatchObject({ GroupName: 'Line1', IntegrateGroupEnable: true });
    expect(viewer._selected).toEqual(['Line1']);
    // Exclusive hierarchy reveal — collapses all other top-level branches.
    expect(viewer._revealed).toEqual(['Line1']);
  });

  it('does NOT create a Kinematic node when one already references the group', async () => {
    const nodes = {
      axis: nodeWith({ Kinematic: { GroupName: 'Line1' } }),
      fresh: nodeWith(null),
    };
    const viewer = makeViewer(nodes);
    const { doc, ops, created } = makeDoc();
    await groupSelection(viewer, doc, ['fresh'], 'Line1');
    expect(ops).toHaveLength(1);
    expect(created).toHaveLength(0);
    expect(viewer._selected).toEqual([]);
  });

  it('skips nodes already in the group (same GroupName)', async () => {
    const nodes = {
      member: nodeWith({ Group: { GroupName: 'Line1' } }),
      fresh: nodeWith(null),
    };
    const { doc, ops } = makeDoc();
    await groupSelection(makeViewer(nodes), doc, ['member', 'fresh'], 'Line1');
    expect((ops as AddComponentOp[]).filter(o => o.componentType === 'Group')).toHaveLength(1);
    expect((ops[0] as AddComponentOp).nodePath).toBe('fresh');
  });

  it('dedupes the component key per node (Group, Group_1, …)', async () => {
    const nodes = { a: nodeWith({ Group: { GroupName: 'Other' } }) };
    const { doc, ops } = makeDoc();
    await groupSelection(makeViewer(nodes), doc, ['a'], 'Line1');
    expect((ops[0] as AddComponentOp).componentType).toBe('Group_1');
  });

  it('no-ops on empty/whitespace name, empty selection, or all-member selection', async () => {
    const nodes = { member: nodeWith({ Group: { GroupName: 'Line1' } }) };
    const { doc, ops, transactions, created } = makeDoc();
    await groupSelection(makeViewer(nodes), doc, ['member'], '   ');
    await groupSelection(makeViewer(nodes), doc, [], 'Line1');
    await groupSelection(makeViewer(nodes), doc, ['member'], 'Line1');
    expect(ops).toHaveLength(0);
    expect(transactions).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});

describe('listKinematicsForMenu', () => {
  it('lists one entry per distinct linked group, labeled by axis node name', () => {
    const axis1 = nodeWith({ Kinematic: { GroupName: 'Lift' } });
    axis1.name = 'LiftAxis';
    const axis2 = nodeWith({ Kinematic_1: { GroupName: 'Turn' } }); // unnamed → group name
    const dupe = nodeWith({ Kinematic: { GroupName: 'Lift' } });
    const unlinked = nodeWith({ Kinematic: { GroupName: '' } });
    const viewer = makeViewer({ axis1, axis2, dupe, unlinked });
    expect(listKinematicsForMenu(viewer)).toEqual([
      { label: 'LiftAxis', groupName: 'Lift' },
      { label: 'Turn', groupName: 'Turn' },
    ]);
  });
});

describe('buildKinematicMenuItems', () => {
  it('one row per kinematic plus a trailing "New kinematic…" input row', () => {
    const axis = nodeWith({ Kinematic: { GroupName: 'Lift' } });
    axis.name = 'LiftAxis';
    const items = buildKinematicMenuItems(makeViewer({ axis }));
    expect(items.map((i) => i.label)).toEqual(['LiftAxis', 'New kinematic…']);
    expect(items[items.length - 1].input?.placeholder).toBe('Kinematic name');
  });
});

describe('createKinematicWithGroup', () => {
  it('creates a root axis node + linked Kinematic in ONE transaction, selects and reveals it', async () => {
    const viewer = makeViewer({});
    const { doc, ops, transactions, created } = makeDoc();
    await createKinematicWithGroup(viewer, doc);

    expect(transactions).toHaveLength(1);
    expect(created).toEqual([{ parentPath: null, baseName: 'Kinematic' }]);
    const kin = ops[0] as AddComponentOp;
    expect(kin.componentType).toBe('Kinematic');
    expect(kin.nodePath).toBe('Kinematic');
    expect(kin.fields).toMatchObject({ GroupName: 'Kinematic', IntegrateGroupEnable: true });
    expect(viewer._selected).toEqual(['Kinematic']);
    expect(viewer._revealed).toEqual(['Kinematic']);
  });

  it('skips names taken by kinematic GroupNames, registry groups, or root node names', async () => {
    const groups = new GroupRegistry();
    groups.register('Kinematic_1', new Object3D());
    const rootChild = nodeWith(null);
    rootChild.name = 'Kinematic_2';
    const nodes = {
      axis: nodeWith({ Kinematic: { GroupName: 'Kinematic' } }),
      taken: rootChild,
    };
    const viewer = makeViewer(nodes, groups);
    const { doc, created, ops } = makeDoc();
    await createKinematicWithGroup(viewer, doc);

    expect(created).toEqual([{ parentPath: null, baseName: 'Kinematic_3' }]);
    expect((ops[0] as AddComponentOp).fields).toMatchObject({ GroupName: 'Kinematic_3' });
  });
});

describe('autoAssignToKinematic', () => {
  it('adds every boxed node to the group in ONE transaction, then re-selects the kinematic', async () => {
    const nodes = { axis: nodeWith({ Kinematic: { GroupName: 'Lift' } }), a: nodeWith(null), b: nodeWith(null) };
    const viewer = makeViewer(nodes);
    const { doc, ops, transactions } = makeDoc();
    await autoAssignToKinematic(viewer, doc, ['a', 'b'], 'Lift', 'axis');

    expect(transactions).toHaveLength(1);
    expect(ops).toHaveLength(2);
    for (const op of ops as AddComponentOp[]) {
      expect(op.componentType).toBe('Group');
      expect(op.fields).toEqual({ GroupName: 'Lift' });
    }
    expect(viewer._selected).toEqual(['axis']);
  });

  it('skips the armed axis, other kinematics, existing members and missing nodes', async () => {
    const nodes = {
      axis: nodeWith({ Kinematic: { GroupName: 'Lift' } }),
      otherAxis: nodeWith({ Kinematic_1: { GroupName: 'Turn' } }),
      member: nodeWith({ Group: { GroupName: 'Lift' } }),
      fresh: nodeWith(null),
    };
    const viewer = makeViewer(nodes);
    const { doc, ops } = makeDoc();
    await autoAssignToKinematic(viewer, doc, ['axis', 'otherAxis', 'member', 'gone', 'fresh'], 'Lift', 'axis');

    expect(ops).toHaveLength(1);
    expect((ops[0] as AddComponentOp).nodePath).toBe('fresh');
  });

  it('no-ops without a transaction when nothing is assignable, but still restores selection', async () => {
    const nodes = { axis: nodeWith({ Kinematic: { GroupName: 'Lift' } }), member: nodeWith({ Group: { GroupName: 'Lift' } }) };
    const viewer = makeViewer(nodes);
    const { doc, ops, transactions } = makeDoc();
    await autoAssignToKinematic(viewer, doc, ['member'], 'Lift', 'axis');

    expect(ops).toHaveLength(0);
    expect(transactions).toHaveLength(0);
    expect(viewer._selected).toEqual(['axis']);
  });
});

describe('ungroupSelection', () => {
  it('removes every Group* component with correct prevFields in ONE transaction', async () => {
    const nodes = {
      a: nodeWith({ Group: { GroupName: 'X' }, Group_1: { GroupName: 'Y' }, Drive: {} }),
      b: nodeWith({ Group: { GroupName: 'X' } }),
      c: nodeWith(null),
    };
    const { doc, ops, transactions } = makeDoc();
    await ungroupSelection(makeViewer(nodes), doc, ['a', 'b', 'c']);

    expect(transactions).toHaveLength(1);
    expect(ops).toHaveLength(3);
    const removals = ops as RemoveComponentOp[];
    expect(removals.every((op) => op.kind === 'removeComponent')).toBe(true);
    expect(removals.map((op) => `${op.nodePath}:${op.componentType}`)).toEqual([
      'a:Group', 'a:Group_1', 'b:Group',
    ]);
    expect(removals[0].prevFields).toEqual({ GroupName: 'X' });
    expect(removals[1].prevFields).toEqual({ GroupName: 'Y' });
    // prevFields must be a clone, not the live extras object
    expect(removals[0].prevFields).not.toBe(
      (nodes.a.userData['realvirtual'] as Record<string, unknown>)['Group'],
    );
  });

  it('no-ops when the selection carries no Group components', async () => {
    const { doc, ops, transactions } = makeDoc();
    await ungroupSelection(makeViewer({ a: nodeWith({ Drive: {} }) }), doc, ['a']);
    expect(ops).toHaveLength(0);
    expect(transactions).toHaveLength(0);
  });
});

describe('assign to kinematic — replace other kinematic membership (not non-kinematic)', () => {
  it('groupSelection moves the object out of another kinematic group but keeps non-kinematic groups', async () => {
    const nodes = {
      turnAxis: nodeWith({ Kinematic: { GroupName: 'Turn' } }),   // makes 'Turn' a kinematic group
      liftAxis: nodeWith({ Kinematic: { GroupName: 'Lift' } }),   // target already has a kinematic
      obj: nodeWith({ Group: { GroupName: 'Turn' }, Group_1: { GroupName: 'Visuals' } }),
    };
    const viewer = makeViewer(nodes);
    const { doc, ops, transactions } = makeDoc();
    await groupSelection(viewer, doc, ['obj'], 'Lift');

    expect(transactions).toHaveLength(1);
    const remove = ops.filter(o => o.kind === 'removeComponent') as RemoveComponentOp[];
    const add = ops.filter(o => o.kind === 'addComponent') as AddComponentOp[];
    // The other KINEMATIC membership ('Turn' on key 'Group') is removed.
    expect(remove).toHaveLength(1);
    expect(remove[0].componentType).toBe('Group');
    expect(remove[0].prevFields).toEqual({ GroupName: 'Turn' });
    // The non-kinematic 'Visuals' membership is left untouched.
    expect(remove.some(r => (r.prevFields as Record<string, unknown>).GroupName === 'Visuals')).toBe(false);
    // The new membership reuses the freed 'Group' key.
    expect(add).toHaveLength(1);
    expect(add[0].componentType).toBe('Group');
    expect(add[0].fields).toEqual({ GroupName: 'Lift' });
  });

  it('autoAssignToKinematic moves a boxed object out of another kinematic group before assigning', async () => {
    const nodes = {
      axis: nodeWith({ Kinematic: { GroupName: 'Lift' } }),
      turnAxis: nodeWith({ Kinematic: { GroupName: 'Turn' } }),
      obj: nodeWith({ Group: { GroupName: 'Turn' } }),
    };
    const viewer = makeViewer(nodes);
    const { doc, ops } = makeDoc();
    await autoAssignToKinematic(viewer, doc, ['obj'], 'Lift', 'axis');

    const remove = ops.filter(o => o.kind === 'removeComponent') as RemoveComponentOp[];
    const add = ops.filter(o => o.kind === 'addComponent') as AddComponentOp[];
    expect(remove).toHaveLength(1);
    expect(remove[0].prevFields).toEqual({ GroupName: 'Turn' });
    expect(add).toHaveLength(1);
    expect(add[0].fields).toEqual({ GroupName: 'Lift' });
  });

  it('keeps a purely non-kinematic membership (stays additive) when assigning to a kinematic', async () => {
    const nodes = {
      axis: nodeWith({ Kinematic: { GroupName: 'Lift' } }),
      obj: nodeWith({ Group: { GroupName: 'Visuals' } }), // nothing kinematic references 'Visuals'
    };
    const viewer = makeViewer(nodes);
    const { doc, ops } = makeDoc();
    await autoAssignToKinematic(viewer, doc, ['obj'], 'Lift', 'axis');

    expect(ops.filter(o => o.kind === 'removeComponent')).toHaveLength(0);
    const add = ops.filter(o => o.kind === 'addComponent') as AddComponentOp[];
    expect(add).toHaveLength(1);
    expect(add[0].componentType).toBe('Group_1'); // added alongside 'Visuals'
    expect(add[0].fields).toEqual({ GroupName: 'Lift' });
  });
});

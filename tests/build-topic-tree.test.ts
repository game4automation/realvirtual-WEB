// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-352 §9.1 — the derived MQTT topic tree. Pure function, no React, no store: split on `/`,
 * count subtrees, keep every level (no single-child compression), sort nodes before leaves, and
 * leave separator-less addresses as top-level leaves.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTopicTree,
  ancestorPathsOf,
  flattenTopicTree,
  type TopicTreeEntry,
} from '../src/core/hmi/build-topic-tree';

interface Sig { name: string; address: string }

const sig = (name: string, address: string): Sig => ({ name, address });
const addressOf = (s: Sig) => s.address;

/** All node paths of a tree, in render order (everything open). */
function nodePaths(entries: ReadonlyArray<TopicTreeEntry<Sig>>): string[] {
  return flattenTopicTree(entries, { isOpen: () => true })
    .filter(r => r.kind === 'node')
    .map(r => (r as { path: string }).path);
}

describe('buildTopicTree', () => {
  it('splitsOnSlash_countsSubtree', () => {
    const tree = buildTopicTree([
      sig('OpenDoor', 'rv/demo/out/OpenDoor'),
      sig('Machining', 'rv/demo/out/Machining'),
      sig('OnSwitch', 'rv/demo/in/OnSwitch'),
    ], addressOf);

    expect(nodePaths(tree)).toEqual(['rv', 'rv/demo', 'rv/demo/in', 'rv/demo/out']);

    const rows = flattenTopicTree(tree, { isOpen: () => true });
    const counts = new Map(rows.filter(r => r.kind === 'node').map(r => {
      const n = r as { path: string; count: number };
      return [n.path, n.count];
    }));
    expect(counts.get('rv')).toBe(3);
    expect(counts.get('rv/demo')).toBe(3);
    expect(counts.get('rv/demo/out')).toBe(2);
    expect(counts.get('rv/demo/in')).toBe(1);
  });

  it('keepsEveryLevel_noSingleChildCompression', () => {
    // A single-child chain must stay four separate, individually collapsible levels (F2).
    const tree = buildTopicTree([sig('Deep', 'a/b/c/d/Leaf')], addressOf);
    expect(nodePaths(tree)).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/d']);

    // Collapsing the middle level hides everything below it, and only that.
    const rows = flattenTopicTree(tree, { isOpen: (p) => p !== 'a/b' });
    expect(rows.map(r => r.kind === 'node' ? r.path : 'LEAF')).toEqual(['a', 'a/b']);
  });

  it('sortsNodesBeforeLeaves', () => {
    // Insertion order is deliberately "wrong" — a leaf first, node labels descending.
    const tree = buildTopicTree([
      sig('ZLeaf', 'rv/ZLeaf'),
      sig('ALeaf', 'rv/ALeaf'),
      sig('Deep', 'rv/zzz/Deep'),
      sig('Other', 'rv/aaa/Other'),
    ], addressOf);

    const rows = flattenTopicTree(tree, { isOpen: () => true });
    // rv > (nodes aaa, zzz) > leaves ALeaf, ZLeaf — nodes first, each group alphabetical.
    expect(rows.map(r => r.kind === 'node' ? `N:${r.path}` : `L:${r.item.name}`)).toEqual([
      'N:rv',
      'N:rv/aaa', 'L:Other',
      'N:rv/zzz', 'L:Deep',
      'L:ALeaf', 'L:ZLeaf',
    ]);
  });

  it('ancestorPathsForLeaf', () => {
    expect(ancestorPathsOf('rv/demo/out/OpenDoor')).toEqual(['rv', 'rv/demo', 'rv/demo/out']);
    expect(ancestorPathsOf('rv/OpenDoor')).toEqual(['rv']);
    expect(ancestorPathsOf('%Q0.1')).toEqual([]);
    expect(ancestorPathsOf('')).toEqual([]);
  });

  it('addressWithoutSlash_staysTopLevelLeaf', () => {
    const tree = buildTopicTree([
      sig('Out1', '%Q0.1'),
      sig('In1', '%I0.0'),
      sig('Nested', 'rv/demo/Nested'),
    ], addressOf);

    const rows = flattenTopicTree(tree, { isOpen: () => true });
    // No node is created for a separator-less address; both stay leaves at depth 0.
    const leaves = rows.filter(r => r.kind === 'leaf') as Array<{ depth: number; item: Sig }>;
    expect(leaves.find(l => l.item.name === 'Out1')!.depth).toBe(0);
    expect(leaves.find(l => l.item.name === 'In1')!.depth).toBe(0);
    expect(leaves.find(l => l.item.name === 'Nested')!.depth).toBe(2);
    expect(nodePaths(tree)).toEqual(['rv', 'rv/demo']);
  });

  it('prunes empty branches when a filter predicate is given', () => {
    const keep = sig('OnSwitch', 'rv/demo/in/OnSwitch');
    const tree = buildTopicTree([
      keep,
      sig('OpenDoor', 'rv/demo/out/OpenDoor'),
      sig('Other', 'other/Thing'),
    ], addressOf);

    const rows = flattenTopicTree(tree, { isOpen: () => true, isLeafVisible: (s) => s === keep });
    expect(rows.map(r => r.kind === 'node' ? `N:${r.path}` : `L:${r.item.name}`)).toEqual([
      'N:rv', 'N:rv/demo', 'N:rv/demo/in', 'L:OnSwitch',
    ]);
  });
});

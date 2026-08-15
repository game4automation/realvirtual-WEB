// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-node-id.test.ts — plan-397 Phase 1.
 *
 * `NodeId` is the identity every cross-file override hangs on. Two properties
 * carry the whole design, and both are regression-guarded here:
 *
 *  1. **Reload stability for files we never write** (plan review BLOCKER 3).
 *     Loading the same unmodified bytes twice must yield the same ids — a random
 *     id would be different every session, and since a library asset must stay
 *     untouched it could never be written back to fix that.
 *
 *  2. **Occurrence separation** (plan review R2-1). Ten references to one asset
 *     produce ten subtrees carrying IDENTICAL ids. Only the pair
 *     (occurrence, NodeId) tells them apart, so the registry index must be
 *     composite — a flat id index would collapse all ten and land an edit on the
 *     wrong one.
 */

import { describe, it, expect } from 'vitest';
import { Group, Object3D } from 'three';
import {
  RV_NODE_ID_KEY,
  ROOT_OCCURRENCE,
  childOccurrence,
  deriveNodeId,
  deriveNodeIdsForSubtree,
  ensureOwnNodeIds,
  fullNodeAddress,
  getNodeId,
  newNodeId,
  occurrenceDepth,
  parseNodeAddress,
  setNodeId,
} from '../src/core/engine/rv-node-id';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { sanitizeUserDataForExport } from '../src/core/editor/rv-asset-glb-export';

const FILE_SHA = 'a3f1c0de5b6789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const OTHER_SHA = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

/** A three-node subtree standing in for a parsed foreign asset. */
function buildForeignSubtree(): { root: Group; indexOf: (n: Object3D) => number | null } {
  const root = new Group();
  root.name = 'Press';
  const gripper = new Group();
  gripper.name = 'Gripper';
  const motor = new Object3D();
  motor.name = 'Motor';
  gripper.add(motor);
  root.add(gripper);

  // Stands in for `collectGltfNodeIndices()`: node → index in the file's nodes[].
  const indices = new Map<Object3D, number>([[root, 0], [gripper, 1], [motor, 2]]);
  return { root, indexOf: (n) => indices.get(n) ?? null };
}

function collectIds(root: Object3D): string[] {
  const ids: string[] = [];
  root.traverse((n) => { const id = getNodeId(n); if (id) ids.push(id); });
  return ids;
}

describe('NodeId derivation for files we do not write', () => {
  it('derives the same id twice for the same bytes and index', async () => {
    expect(await deriveNodeId(FILE_SHA, 7)).toBe(await deriveNodeId(FILE_SHA, 7));
  });

  it('yields the same ids when the same unmodified file is parsed twice', async () => {
    const a = buildForeignSubtree();
    const b = buildForeignSubtree();
    await deriveNodeIdsForSubtree(a.root, FILE_SHA, a.indexOf);
    await deriveNodeIdsForSubtree(b.root, FILE_SHA, b.indexOf);
    expect(collectIds(b.root)).toEqual(collectIds(a.root));
    expect(collectIds(a.root)).toHaveLength(3);
  });

  it('gives different nodes of one file different ids', async () => {
    const { root, indexOf } = buildForeignSubtree();
    await deriveNodeIdsForSubtree(root, FILE_SHA, indexOf);
    expect(new Set(collectIds(root)).size).toBe(3);
  });

  it('changes the ids when the source file changes — the orphan signal', async () => {
    const a = buildForeignSubtree();
    const b = buildForeignSubtree();
    await deriveNodeIdsForSubtree(a.root, FILE_SHA, a.indexOf);
    await deriveNodeIdsForSubtree(b.root, OTHER_SHA, b.indexOf);
    expect(collectIds(b.root)).not.toEqual(collectIds(a.root));
  });

  it('keeps an id the file already carries instead of deriving over it', async () => {
    const { root, indexOf } = buildForeignSubtree();
    setNodeId(root, 'authored-id');
    const stamped = await deriveNodeIdsForSubtree(root, FILE_SHA, indexOf);
    expect(stamped).toBe(2);              // root was left alone
    expect(getNodeId(root)).toBe('authored-id');
  });

  it('skips nodes with no glTF index — they have no position in the source file', async () => {
    const { root, indexOf } = buildForeignSubtree();
    const opCreated = new Object3D();
    opCreated.name = 'AddedByOp';
    root.add(opCreated);
    await deriveNodeIdsForSubtree(root, FILE_SHA, indexOf);
    expect(getNodeId(opCreated)).toBeNull();
  });

  it('refuses to derive without file bytes or with a bogus index', async () => {
    await expect(deriveNodeId('', 0)).rejects.toThrow(/fileSha256/);
    await expect(deriveNodeId(FILE_SHA, -1)).rejects.toThrow(/non-negative/);
  });
});

describe('NodeId on files we write', () => {
  it('mints an id per node and preserves it on the next pass', () => {
    const { root } = buildForeignSubtree();
    expect(ensureOwnNodeIds(root)).toBe(3);
    const first = collectIds(root);
    expect(ensureOwnNodeIds(root)).toBe(0);   // nothing left to mint
    expect(collectIds(root)).toEqual(first);
  });

  it('mints distinct ids', () => {
    expect(newNodeId()).not.toBe(newNodeId());
  });
});

describe('NodeId survives the export sanitizer', () => {
  it('is not stripped — it carries no underscore prefix', () => {
    const node = new Object3D();
    node.userData.realvirtual = { Drive: { TargetSpeed: 100 } };
    node.userData._rvOrigName = 'Motor';     // internal marker, must go
    setNodeId(node, 'keep-me');

    sanitizeUserDataForExport(node);

    expect(node.userData._rvOrigName).toBeUndefined();
    expect((node.userData.realvirtual as Record<string, unknown>)[RV_NODE_ID_KEY]).toBe('keep-me');
    expect(RV_NODE_ID_KEY.startsWith('_')).toBe(false);
  });
});

describe('Occurrence addressing', () => {
  it('builds and parses a full address', () => {
    const occ = childOccurrence(childOccurrence(ROOT_OCCURRENCE, 'a1b2c3'), 'd4e5f6');
    expect(occ).toBe('a1b2c3/d4e5f6');
    expect(occurrenceDepth(occ)).toBe(2);

    const address = fullNodeAddress(occ, '7890ab');
    expect(address).toBe('a1b2c3/d4e5f6#7890ab');
    expect(parseNodeAddress(address)).toEqual({ occurrence: 'a1b2c3/d4e5f6', nodeId: '7890ab' });
  });

  it('treats a bare id as living in the root file', () => {
    expect(parseNodeAddress('abc')).toEqual({ occurrence: ROOT_OCCURRENCE, nodeId: 'abc' });
  });

  it('refuses to extend the chain with a reference node that has no id', () => {
    expect(() => childOccurrence(ROOT_OCCURRENCE, '')).toThrow(/NodeId/);
  });
});

describe('NodeRegistry composite (occurrence, NodeId) index', () => {
  /** Ten "occurrences" of one asset — same ids, different objects. */
  function tenOccurrences(): { registry: NodeRegistry; motors: Object3D[]; occurrences: string[] } {
    const registry = new NodeRegistry();
    const motors: Object3D[] = [];
    const occurrences: string[] = [];
    for (let i = 0; i < 10; i++) {
      const subtree = new Group();
      subtree.name = `Press_${i}`;
      const motor = new Object3D();
      motor.name = 'Motor';
      setNodeId(motor, 'shared-motor-id');    // SAME id — same source bytes
      subtree.add(motor);

      const occ = childOccurrence(ROOT_OCCURRENCE, `ref-${i}`);
      registry.registerNodeIdsForSubtree(subtree, occ);
      motors.push(motor);
      occurrences.push(occ);
    }
    return { registry, motors, occurrences };
  }

  it('keeps ten occurrences of the same NodeId apart', () => {
    const { registry, motors, occurrences } = tenOccurrences();
    for (let i = 0; i < 10; i++) {
      expect(registry.getNodeByAddress('shared-motor-id', occurrences[i])).toBe(motors[i]);
    }
    expect(new Set(registry.getRegisteredAddresses()).size).toBe(10);
  });

  it('resolves a root-file node under the empty occurrence', () => {
    const registry = new NodeRegistry();
    const node = new Object3D();
    setNodeId(node, 'root-node');
    registry.registerNodeId(node);
    expect(registry.getNodeByAddress('root-node')).toBe(node);
    expect(registry.getAddressForNode(node)).toBe('#root-node');
  });

  it('returns null for an id that exists in another occurrence only', () => {
    const { registry } = tenOccurrences();
    expect(registry.getNodeByAddress('shared-motor-id', 'ref-nonexistent')).toBeNull();
  });

  it('skips nodes without a NodeId instead of indexing junk', () => {
    const registry = new NodeRegistry();
    const node = new Object3D();
    expect(registry.registerNodeId(node)).toBeNull();
    expect(registry.getRegisteredAddresses()).toEqual([]);
  });

  it('follows the remap table when a node moved in an updated asset', () => {
    const registry = new NodeRegistry();
    const moved = new Object3D();
    setNodeId(moved, 'new-id');
    registry.registerNodeId(moved, 'ref-a');
    registry.addNodeIdRemap('ref-a#old-id', 'ref-a#new-id');

    expect(registry.getNodeByAddress('old-id', 'ref-a')).toBe(moved);
  });

  it('keeps the first registration on a duplicate id within one occurrence', () => {
    const registry = new NodeRegistry();
    const first = new Object3D();
    const second = new Object3D();
    setNodeId(first, 'dup');
    setNodeId(second, 'dup');
    registry.registerNodeId(first);
    registry.registerNodeId(second);
    expect(registry.getNodeByAddress('dup')).toBe(first);
  });

  it('drops addresses again on unregisterSubtree — no detached nodes handed out', () => {
    const registry = new NodeRegistry();
    const root = new Group();
    root.name = 'Asset';
    const motor = new Object3D();
    motor.name = 'Motor';
    setNodeId(motor, 'motor-id');
    root.add(motor);
    registry.registerNode('Asset', root);
    registry.registerNode('Asset/Motor', motor);
    registry.registerNodeIdsForSubtree(root);

    expect(registry.getNodeByAddress('motor-id')).toBe(motor);
    registry.unregisterSubtree(root);
    expect(registry.getNodeByAddress('motor-id')).toBeNull();
    expect(registry.getAddressForNode(motor)).toBeNull();
  });

  it('drops the whole index on clear()', () => {
    const { registry } = tenOccurrences();
    registry.clear();
    expect(registry.getRegisteredAddresses()).toEqual([]);
  });
});

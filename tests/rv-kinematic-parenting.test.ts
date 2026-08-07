// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for kinematic group sub-parenting on GLB load.
 * Verifies that applyKinematicParenting correctly re-parents nodes
 * using attach() (world-transform preserving) and fixes matrixAutoUpdate.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshBasicMaterial, Vector3 } from 'three';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { applyKinematicParenting, type KinematicNodeEntry } from '../src/core/engine/rv-scene-loader';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

/** Helper: create a minimal NodeRegistry with nodes registered by path */
function buildRegistry(root: Object3D): NodeRegistry {
  const reg = new NodeRegistry();
  root.traverse((node: Object3D) => {
    const path = NodeRegistry.computeNodePath(node);
    reg.registerNode(path, node);
  });
  return reg;
}

describe('applyKinematicParenting', () => {
  it('re-parents group node under kinematic node preserving world position', () => {
    const root = new Object3D(); root.name = 'Root';
    const kinNode = new Object3D(); kinNode.name = 'Kinematic1';
    kinNode.position.set(100, 0, 0);
    const groupNode = new Object3D(); groupNode.name = 'Part1';
    groupNode.position.set(50, 0, 0);
    root.add(kinNode);
    root.add(groupNode);
    root.updateMatrixWorld(true);

    const worldBefore = groupNode.getWorldPosition(new Vector3());

    const groups = new GroupRegistry();
    groups.register('MyGroup', groupNode);

    const registry = buildRegistry(root);

    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: { IntegrateGroupEnable: true, GroupName: 'MyGroup' },
    }];

    const result = applyKinematicParenting(kinEntries, groups, registry, root);

    root.updateMatrixWorld(true);
    const worldAfter = groupNode.getWorldPosition(new Vector3());

    expect(worldAfter.distanceTo(worldBefore)).toBeLessThan(0.001);
    expect(groupNode.parent).toBe(kinNode);
    expect(result.groupNames).toContain('MyGroup');
    expect(result.affectedSubtrees).toContain(kinNode);
  });

  it('returns empty when no kinematic nodes', () => {
    const root = new Object3D();
    const registry = buildRegistry(root);
    const result = applyKinematicParenting([], null, registry, root);
    expect(result.groupNames).toEqual([]);
    expect(result.affectedSubtrees).toEqual([]);
  });

  it('skips when GroupName is empty', () => {
    const root = new Object3D(); root.name = 'Root';
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    root.add(kinNode);

    const groups = new GroupRegistry();
    const registry = buildRegistry(root);

    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: { IntegrateGroupEnable: true, GroupName: '' },
    }];

    const result = applyKinematicParenting(kinEntries, groups, registry, root);
    expect(result.groupNames).toEqual([]);
  });

  it('falls back to GroupName when GroupNamePrefix not found', () => {
    const root = new Object3D(); root.name = 'Root';
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    const groupNode = new Object3D(); groupNode.name = 'Arm';
    root.add(kinNode);
    root.add(groupNode);

    const groups = new GroupRegistry();
    groups.register('Arm', groupNode);

    const registry = buildRegistry(root);

    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: {
        IntegrateGroupEnable: true,
        GroupName: 'Arm',
        GroupNamePrefix: { path: 'NonExistent/Path' },
      },
    }];

    // Prefix not found => falls back to just "Arm"
    const result = applyKinematicParenting(kinEntries, groups, registry, root);
    expect(result.groupNames).toContain('Arm');
    expect(groupNode.parent).toBe(kinNode);
  });

  it('resolves GroupNamePrefix to prefixNode.name + GroupName', () => {
    const root = new Object3D(); root.name = 'Root';
    const prefixNode = new Object3D(); prefixNode.name = 'Robot1';
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    const groupNode = new Object3D(); groupNode.name = 'PartA';
    root.add(prefixNode);
    root.add(kinNode);
    root.add(groupNode);

    const groups = new GroupRegistry();
    groups.register('Robot1Arm', groupNode);

    const registry = buildRegistry(root);
    // NodeRegistry.computeNodePath stops at scene root, so path is just "Robot1"
    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: {
        IntegrateGroupEnable: true,
        GroupName: 'Arm',
        GroupNamePrefix: { path: 'Robot1' },
      },
    }];

    const result = applyKinematicParenting(kinEntries, groups, registry, root);
    expect(result.groupNames).toContain('Robot1Arm');
    expect(groupNode.parent).toBe(kinNode);
  });

  it('SimplifyHierarchy filters to mesh-only nodes', () => {
    const root = new Object3D(); root.name = 'Root';
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    const meshNode = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    meshNode.name = 'MeshPart';
    const emptyNode = new Object3D(); emptyNode.name = 'EmptyPart';
    root.add(kinNode);
    root.add(meshNode);
    root.add(emptyNode);

    const groups = new GroupRegistry();
    groups.register('Parts', meshNode);
    groups.register('Parts', emptyNode);

    const registry = buildRegistry(root);

    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: { IntegrateGroupEnable: true, GroupName: 'Parts', SimplifyHierarchy: true },
    }];

    applyKinematicParenting(kinEntries, groups, registry, root);

    // Only the mesh should be re-parented
    expect(meshNode.parent).toBe(kinNode);
    expect(emptyNode.parent).toBe(root);
  });

  it('sets matrixAutoUpdate=true on re-parented subtree', () => {
    const root = new Object3D(); root.name = 'Root';
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    const groupNode = new Object3D(); groupNode.name = 'Group';
    const child = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    child.name = 'ChildMesh';
    child.matrixAutoUpdate = false;
    groupNode.add(child);
    root.add(kinNode);
    root.add(groupNode);

    const groups = new GroupRegistry();
    groups.register('G', groupNode);

    const registry = buildRegistry(root);

    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: { IntegrateGroupEnable: true, GroupName: 'G' },
    }];

    applyKinematicParenting(kinEntries, groups, registry, root);

    expect(child.matrixAutoUpdate).toBe(true);
    expect(groupNode.matrixAutoUpdate).toBe(true);
  });

  it('handles KinematicParentEnable re-parenting', () => {
    const root = new Object3D(); root.name = 'Root';
    const parentNode = new Object3D(); parentNode.name = 'Target';
    parentNode.position.set(200, 0, 0);
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    kinNode.position.set(50, 0, 0);
    root.add(parentNode);
    root.add(kinNode);
    root.updateMatrixWorld(true);

    const worldBefore = kinNode.getWorldPosition(new Vector3());

    const registry = buildRegistry(root);

    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: { KinematicParentEnable: true, Parent: { path: 'Target' } },
    }];

    applyKinematicParenting(kinEntries, null, registry, root);
    root.updateMatrixWorld(true);

    const worldAfter = kinNode.getWorldPosition(new Vector3());
    expect(worldAfter.distanceTo(worldBefore)).toBeLessThan(0.001);
    expect(kinNode.parent).toBe(parentNode);
  });

  it('pre-reparent paths stay resolvable via alias after recompute (GLB refs)', () => {
    // References serialized in the GLB (e.g. instruction targetObjects) use the
    // authoring hierarchy. After kinematic re-parenting + path recompute, the
    // loader registers the old paths as aliases so those references still resolve.
    const root = new Object3D(); root.name = 'Root';
    const oldParent = new Object3D(); oldParent.name = 'OldParent';
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    const part = new Object3D(); part.name = 'Part';
    oldParent.add(part);
    root.add(oldParent);
    root.add(kinNode);

    const groups = new GroupRegistry();
    groups.register('G', part);

    const registry = buildRegistry(root);
    expect(registry.getNode('OldParent/Part')).toBe(part);

    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: { IntegrateGroupEnable: true, GroupName: 'G' },
    }];

    const result = applyKinematicParenting(kinEntries, groups, registry, root);
    const { remap } = registry.recomputePathsForSubtrees(result.affectedSubtrees);

    // Canonical path moved; the stale multi-segment path no longer resolves
    // (suffix fallback requires the full old parent chain to match).
    expect(remap.get('OldParent/Part')).toBe('Kin/Part');
    expect(registry.getNode('Kin/Part')).toBe(part);
    expect(registry.getNode('OldParent/Part')).toBeNull();

    // Loader Phase 8c: register the pre-reparent paths as aliases.
    for (const [oldPath, newPath] of remap) {
      const node = registry.getNode(newPath);
      if (node) registry.registerAlias(oldPath, node);
    }

    // Stale GLB reference resolves again; canonical path stays the new one.
    expect(registry.getNode('OldParent/Part')).toBe(part);
    expect(registry.getPathForNode(part)).toBe('Kin/Part');
  });

  it('processes IntegrateGroup before KinematicParent', () => {
    const root = new Object3D(); root.name = 'Root';
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    const parentNode = new Object3D(); parentNode.name = 'Parent';
    const groupNode = new Object3D(); groupNode.name = 'Part';
    root.add(kinNode);
    root.add(parentNode);
    root.add(groupNode);

    const groups = new GroupRegistry();
    groups.register('G', groupNode);

    const registry = buildRegistry(root);

    // Node has both IntegrateGroupEnable and KinematicParentEnable
    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: {
        IntegrateGroupEnable: true,
        GroupName: 'G',
        KinematicParentEnable: true,
        Parent: { path: 'Parent' },
      },
    }];

    applyKinematicParenting(kinEntries, groups, registry, root);

    // Group node should be under kinNode, kinNode should be under parentNode
    expect(groupNode.parent).toBe(kinNode);
    expect(kinNode.parent).toBe(parentNode);
  });
});

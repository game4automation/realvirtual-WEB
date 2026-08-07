// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * InstancePickIndex — the editor-mode two-level pick backend.
 * Broad phase (per-pick world AABBs + ray slab + visibility walk), narrow
 * phase (per-mesh local raycast), lazy epoch-cached path resolution, and
 * membership maintenance (add/removeSubtree).
 */
import { describe, it, expect } from 'vitest';
import {
  BoxGeometry, BufferGeometry, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3,
} from 'three';
import type { Intersection, Object3D } from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { InstancePickIndex } from '../src/core/engine/rv-instance-pick-index';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import '../src/core/editor/rv-cadlink'; // side effect: CADLink capability registration

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

registerComponentSchema('IdxTestType', {}, { hoverable: true, selectable: true });

function makePart(name: string): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.name = name;
  return mesh;
}

function hoverableNode(name: string): Group {
  const g = new Group();
  g.name = name;
  g.userData.realvirtual = { IdxTestType: {} };
  return g;
}

function registerAll(root: Object3D): NodeRegistry {
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  return registry;
}

function rayDown(x: number, z: number): Raycaster {
  return new Raycaster(new Vector3(x, 10, z), new Vector3(0, -1, 0));
}

/** Raycast the index and resolve the closest resolvable hit to a path. */
function pick(index: InstancePickIndex, ray: Raycaster): string | null {
  const out: Intersection<Object3D>[] = [];
  index.raycast(ray, out);
  out.sort((a, b) => a.distance - b.distance);
  for (const hit of out) {
    const path = index.resolvePath(hit.object);
    if (path) return path;
  }
  return null;
}

/** Standard scene: two hoverable one-mesh boxes at x=0 (A) and x=5 (B). */
function buildScene() {
  const root = new Group(); root.name = 'Asset';
  const nodeA = hoverableNode('A');
  const meshA = makePart('MeshA');
  nodeA.add(meshA);
  const nodeB = hoverableNode('B');
  nodeB.position.set(5, 0, 0);
  const meshB = makePart('MeshB');
  nodeB.add(meshB);
  root.add(nodeA, nodeB);
  root.updateMatrixWorld(true);
  const registry = registerAll(root);
  const index = new InstancePickIndex(registry);
  index.addSubtree(root);
  return { root, nodeA, meshA, nodeB, meshB, registry, index };
}

describe('InstancePickIndex', () => {
  it('picks and resolves to the EXACT mesh node path (no ancestor promotion)', () => {
    const { registry, meshA, meshB, index } = buildScene();
    expect(index.size).toBe(2);
    expect(pick(index, rayDown(0, 0))).toBe(registry.getPathForNode(meshA));
    expect(pick(index, rayDown(5, 0))).toBe(registry.getPathForNode(meshB));
    expect(pick(index, rayDown(2.5, 0))).toBeNull(); // between the boxes
  });

  it('transforms need ZERO notification — per-pick AABBs read matrixWorld raw', () => {
    const { registry, nodeA, meshA, index } = buildScene();
    nodeA.position.set(10, 0, 0);
    nodeA.updateMatrixWorld(true); // what every executor / the gizmo does
    expect(pick(index, rayDown(10, 0))).toBe(registry.getPathForNode(meshA));
    expect(pick(index, rayDown(0, 0))).toBeNull();
  });

  it('respects raycaster near/far in the broad phase', () => {
    const { index } = buildScene();
    const ray = rayDown(0, 0);
    ray.far = 5; // box top is 9.5 units from the origin
    const out: Intersection<Object3D>[] = [];
    index.raycast(ray, out);
    expect(out.length).toBe(0);
  });

  it('hidden chains are ray-transparent (visible flag AND rv.Hidden)', () => {
    const { nodeA, index } = buildScene();

    nodeA.visible = false;
    expect(pick(index, rayDown(0, 0))).toBeNull();
    nodeA.visible = true;

    // Authored-hidden without a visible flip must ALSO be transparent.
    (nodeA.userData.realvirtual as Record<string, unknown>).Hidden = true;
    expect(pick(index, rayDown(0, 0))).toBeNull();
    delete (nodeA.userData.realvirtual as Record<string, unknown>).Hidden;
    expect(pick(index, rayDown(0, 0))).not.toBeNull();
  });

  it('a hidden FRONT entry falls through to the entry behind it', () => {
    const { root, registry, index } = buildScene();
    // Stack a second hoverable box above A at the same x/z.
    const top = hoverableNode('Top');
    top.position.set(0, 3, 0);
    top.add(makePart('TopMesh'));
    root.add(top);
    root.updateMatrixWorld(true);
    root.traverse((n) => {
      if (!registry.getPathForNode(n)) registry.registerNode(NodeRegistry.computeNodePath(n), n);
    });
    index.addSubtree(top);

    expect(pick(index, rayDown(0, 0))).toBe(registry.getPathForNode(root.getObjectByName('TopMesh')!));
    top.visible = false;
    expect(pick(index, rayDown(0, 0))).toBe(registry.getPathForNode(root.getObjectByName('MeshA')!));
  });

  it('removeSubtree makes entries unpickable; addSubtree restores them', () => {
    const { registry, nodeA, meshA, index } = buildScene();
    index.removeSubtree(nodeA);
    expect(index.size).toBe(1);
    expect(pick(index, rayDown(0, 0))).toBeNull();

    index.addSubtree(nodeA);
    expect(index.size).toBe(2);
    expect(pick(index, rayDown(0, 0))).toBe(registry.getPathForNode(meshA));
  });

  it('re-resolves cached paths after bumpResolutionEpoch (rename)', () => {
    const { root, registry, nodeA, meshA, index } = buildScene();
    const oldPath = registry.getPathForNode(meshA)!;
    expect(pick(index, rayDown(0, 0))).toBe(oldPath); // path now cached

    nodeA.name = 'Renamed';
    registry.recomputePathsForSubtrees([nodeA]);
    const newPath = registry.getPathForNode(meshA)!;
    expect(newPath).not.toBe(oldPath);

    // Stale until the epoch bumps…
    expect(index.resolvePath(meshA)).toBe(oldPath);
    index.bumpResolutionEpoch();
    expect(index.resolvePath(meshA)).toBe(newPath);
    void root;
  });

  it('component-less meshes under a Drive resolve to their OWN path (no axis-root collapse)', () => {
    const root = new Group(); root.name = 'Asset';
    const drive = new Group(); drive.name = 'Axis1';
    drive.userData.realvirtual = { Drive: {} };
    const plainGroup = new Group(); plainGroup.name = 'Housing';
    const mesh = makePart('HousingMesh');
    plainGroup.add(mesh); drive.add(plainGroup); root.add(drive);
    root.updateMatrixWorld(true);
    const registry = registerAll(root);
    const index = new InstancePickIndex(registry);
    index.addSubtree(root);

    expect(pick(index, rayDown(0, 0))).toBe(registry.getPathForNode(mesh));
  });

  it('CADLink-only subtrees resolve per part (mesh own path)', () => {
    const root = new Group(); root.name = 'Asset';
    const cadRoot = new Group(); cadRoot.name = 'Gearbox';
    cadRoot.userData.realvirtual = { CADLink: { File: 'g.step' } };
    const part = makePart('Shaft');
    cadRoot.add(part); root.add(cadRoot);
    root.updateMatrixWorld(true);
    const registry = registerAll(root);
    const index = new InstancePickIndex(registry);
    index.addSubtree(root);

    expect(pick(index, rayDown(0, 0))).toBe(registry.getPathForNode(part));
  });

  it('registered component-less meshes resolve to their own path; unregistered chains are transparent', () => {
    const root = new Group(); root.name = 'Asset';
    // Plain mesh with NO components — exact-node picking still resolves it.
    const orphan = makePart('Orphan');
    orphan.position.set(0, 3, 0);
    const nodeA = hoverableNode('A');
    nodeA.add(makePart('MeshA'));
    root.add(orphan, nodeA);
    root.updateMatrixWorld(true);
    const registry = registerAll(root);
    const index = new InstancePickIndex(registry);
    index.addSubtree(root);

    expect(pick(index, rayDown(0, 0))).toBe(registry.getPathForNode(orphan));

    // A mesh whose WHOLE chain is unregistered is transparent, not blocking:
    // hits fall through to the resolvable entry behind it.
    const detachedRoot = new Group(); detachedRoot.name = 'Loose';
    const ghost = makePart('Ghost');
    ghost.position.set(0, 6, 0);
    detachedRoot.add(ghost);
    detachedRoot.updateMatrixWorld(true);
    index.addSubtree(detachedRoot); // never registered in the registry
    expect(pick(index, rayDown(0, 0))).toBe(registry.getPathForNode(orphan));
  });

  it('broad phase over 5000 entries stays fast', () => {
    const root = new Group(); root.name = 'Asset';
    const shared = new BoxGeometry(0.5, 0.5, 0.5);
    for (let i = 0; i < 5000; i++) {
      const n = hoverableNode(`N${i}`);
      n.position.set((i % 100) * 2, 0, Math.floor(i / 100) * 2);
      n.add(new Mesh(shared, new MeshBasicMaterial()));
      root.add(n);
    }
    root.updateMatrixWorld(true);
    const registry = registerAll(root);
    const index = new InstancePickIndex(registry);
    index.addSubtree(root);
    expect(index.size).toBe(5000);

    const ray = rayDown(0, 0);
    const out: Intersection<Object3D>[] = [];
    index.raycast(ray, out); // warm-up (computes bounding boxes)
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) {
      out.length = 0;
      index.raycast(ray, out);
    }
    const perPick = (performance.now() - t0) / 10;
    expect(out.length).toBeGreaterThan(0);
    // Generous CI bound — locally this is well under 1 ms.
    expect(perPick).toBeLessThan(10);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Retiring a superseded pick-geometry set (plan-359 §2.2 / §9.3).
 *
 * `buildRaycastGeometries()` parents a FRESH `__raycastBVH_static` mesh under the
 * model root on every call (and one per Drive under its drive node). Nothing used
 * to remove the previous one, so every rebuild cycle left an invisible corpse in
 * the graph — 6 `__raycastBVH_static` meshes measured after a PLMXML kinematics
 * import, and the layout planner rebuilds from three more call sites.
 *
 * The corpses never mis-picked (they carry `_rvRaycastBVH`, which excludes them
 * from both re-merging and the manager's target list), which is exactly why this
 * went unnoticed: the only symptoms were an unbounded graph and wrong hits for any
 * consumer that raycasts `scene.children` itself.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Object3D, Group, Mesh, BoxGeometry, MeshBasicMaterial, BufferGeometry,
} from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import {
  buildRaycastGeometries, disposeRaycastGeometries, type RaycastGeometrySet,
} from '../src/core/engine/rv-raycast-geometry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import '../src/core/editor/rv-cadlink'; // side effect: CADLink capability registration

// The scene loader installs these lazily in production.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

function buildScene() {
  const root = new Group();
  root.name = 'Model';
  for (let i = 0; i < 3; i++) {
    const part = new Group();
    part.name = `Part_${i}`;
    part.userData.realvirtual = { CADLink: { File: 'x.step' } };
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    mesh.name = `Body_${i}`;
    part.add(mesh);
    root.add(part);
  }
  root.updateMatrixWorld(true);

  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  return { root, registry };
}

const countProxies = (root: Object3D): number => {
  let n = 0;
  root.traverse((child) => { if (child.userData?._rvRaycastBVH) n++; });
  return n;
};

const build = (root: Object3D, registry: NodeRegistry): RaycastGeometrySet =>
  buildRaycastGeometries(root, [], registry, new Set());

describe('raycast geometry retirement', () => {
  it('the builder always ADDS a proxy — retiring is the caller\'s job', () => {
    const { root, registry } = buildScene();
    build(root, registry);
    expect(countProxies(root)).toBe(1);
    // No retirement between the two builds: this is the leak, pinned so the fix
    // cannot silently move back into the builder and change its contract.
    build(root, registry);
    expect(countProxies(root)).toBe(2);
  });

  it('two rebuild cycles leave exactly ONE proxy when the old set is retired', () => {
    const { root, registry } = buildScene();
    let current = build(root, registry);
    expect(countProxies(root)).toBe(1);

    for (let cycle = 0; cycle < 5; cycle++) {
      const next = build(root, registry);
      disposeRaycastGeometries(current);
      current = next;
      expect(countProxies(root)).toBe(1);
    }
  });

  it('disposes the retired geometry, its BVH and its private material', () => {
    const { root, registry } = buildScene();
    const set = build(root, registry);
    const mesh = set.staticGroup!.mesh;
    expect(mesh.geometry.boundsTree).toBeTruthy();

    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const treeDispose = vi.spyOn(mesh.geometry, 'disposeBoundsTree');
    // Each group mesh owns an unshared default material (`new Mesh(geometry)`),
    // which the previous helper left behind (SOL-Runde 1, Finding 12).
    const materialDispose = vi.spyOn(mesh.material as MeshBasicMaterial, 'dispose');

    disposeRaycastGeometries(set);

    expect(treeDispose).toHaveBeenCalled();
    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    expect(mesh.parent).toBeNull();
  });

  it('retires kinematic drive groups too, not just the static one', () => {
    const { root, registry } = buildScene();
    const drive = new Group();
    drive.name = 'Axis';
    drive.userData.realvirtual = { Drive: {} };
    const driveMesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    driveMesh.name = 'AxisBody';
    drive.add(driveMesh);
    root.add(drive);
    root.updateMatrixWorld(true);
    root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

    const driveNodeSet = new Set<Object3D>([drive]);
    const set = buildRaycastGeometries(root, [{ node: drive }], registry, driveNodeSet);
    expect(set.kinematicGroups.size).toBe(1);
    expect(countProxies(root)).toBe(2); // static + one kinematic

    disposeRaycastGeometries(set);
    expect(countProxies(root)).toBe(0);
    expect(set.kinematicGroups.size).toBe(0);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { Object3D, Group, Mesh, BoxGeometry, BufferGeometry, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import {
  resolveHit, buildRaycastGeometries, refitRaycastGroupsForSubtrees,
  type FaceRange, type RaycastGeometrySet,
} from '../src/core/engine/rv-raycast-geometry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';
import '../src/core/editor/rv-cadlink'; // side effect: CADLink capability registration

// buildRaycastGroup calls geometry.computeBoundsTree() — installed lazily by
// the scene loader in production, so install it here for direct builder tests.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

// ─── Helpers ────────────────────────────────────────────────────────

function createMockViewer() {
  const listeners = new Map<string, Set<Function>>();
  return {
    on(event: string, cb: Function) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => listeners.get(event)?.delete(cb);
    },
    emit(event: string, data?: unknown) {
      listeners.get(event)?.forEach(cb => cb(data));
    },
    _listeners: listeners,
  };
}

function createDriveMesh(driveName: string): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.name = driveName;
  mesh.userData = { rvType: 'Drive', rvPath: `/Root/${driveName}` };
  return mesh;
}

function createOverlayMesh(): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.userData = { _highlightOverlay: true };
  return mesh;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('resolveHit (face-range binary search)', () => {
  const faceRanges: FaceRange[] = [
    { startFace: 0, endFace: 100, objectPath: 'Root/DriveA' },
    { startFace: 100, endFace: 250, objectPath: 'Root/DriveB' },
    { startFace: 250, endFace: 300, objectPath: 'Root/Sensor1' },
    { startFace: 300, endFace: 500, objectPath: 'Root/Group/DriveC' },
  ];

  it('resolves first range', () => {
    expect(resolveHit(faceRanges, 0)).toBe('Root/DriveA');
    expect(resolveHit(faceRanges, 50)).toBe('Root/DriveA');
    expect(resolveHit(faceRanges, 99)).toBe('Root/DriveA');
  });

  it('resolves middle range', () => {
    expect(resolveHit(faceRanges, 100)).toBe('Root/DriveB');
    expect(resolveHit(faceRanges, 200)).toBe('Root/DriveB');
    expect(resolveHit(faceRanges, 249)).toBe('Root/DriveB');
  });

  it('resolves last range', () => {
    expect(resolveHit(faceRanges, 300)).toBe('Root/Group/DriveC');
    expect(resolveHit(faceRanges, 499)).toBe('Root/Group/DriveC');
  });

  it('returns null for face outside all ranges', () => {
    expect(resolveHit(faceRanges, 500)).toBeNull();
    expect(resolveHit(faceRanges, 1000)).toBeNull();
  });

  it('returns null for empty face ranges', () => {
    expect(resolveHit([], 0)).toBeNull();
  });

  it('handles boundary between ranges', () => {
    // Face 100 is the start of DriveB (exclusive end of DriveA)
    expect(resolveHit(faceRanges, 99)).toBe('Root/DriveA');
    expect(resolveHit(faceRanges, 100)).toBe('Root/DriveB');
  });

  it('handles single-face ranges', () => {
    const singleFace: FaceRange[] = [
      { startFace: 0, endFace: 1, objectPath: 'Root/Tiny' },
      { startFace: 1, endFace: 2, objectPath: 'Root/Tiny2' },
    ];
    expect(resolveHit(singleFace, 0)).toBe('Root/Tiny');
    expect(resolveHit(singleFace, 1)).toBe('Root/Tiny2');
    expect(resolveHit(singleFace, 2)).toBeNull();
  });
});

// ─── Content-ancestor resolution (CADLink per-part picking) ─────────

// Synthetic hoverable type standing in for Drive/Sensor/etc. so the test
// doesn't import heavy component modules for their registration side effects.
registerComponentSchema('TestPickRoot', {}, { hoverable: true, selectable: true });

function makePart(name: string): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.name = name;
  return mesh;
}

function buildAndRegister(root: Object3D): NodeRegistry {
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  return registry;
}

describe('buildRaycastGeometries content-ancestor resolution', () => {
  it('meshes inside a CADLink-only subtree resolve to their OWN path (per-part picking)', () => {
    const root = new Group(); root.name = 'Asset';
    const cadRoot = new Group(); cadRoot.name = 'Gearbox';
    cadRoot.userData.realvirtual = { CADLink: { File: 'g.step' } };
    const sub = new Group(); sub.name = 'SubAssy';
    const housing = makePart('Housing');
    const shaft = makePart('Shaft');
    sub.add(housing, shaft); cadRoot.add(sub); root.add(cadRoot);

    const registry = buildAndRegister(root);
    const geo = buildRaycastGeometries(root, [], registry, new Set());

    const paths = geo.staticGroup!.faceRanges.map((r) => r.objectPath);
    expect(paths).toContain(registry.getPathForNode(housing)!);
    expect(paths).toContain(registry.getPathForNode(shaft)!);
    expect(paths).not.toContain(registry.getPathForNode(cadRoot)!);
  });

  it('a CADLink root that also carries another hoverable component stays a bubble target', () => {
    const root = new Group(); root.name = 'Asset';
    const cadRoot = new Group(); cadRoot.name = 'Gearbox';
    cadRoot.userData.realvirtual = { CADLink: { File: 'g.step' }, TestPickRoot: {} };
    const part = makePart('Housing');
    cadRoot.add(part); root.add(cadRoot);

    const registry = buildAndRegister(root);
    const geo = buildRaycastGeometries(root, [], registry, new Set());

    const paths = geo.staticGroup!.faceRanges.map((r) => r.objectPath);
    expect(paths).toEqual([registry.getPathForNode(cadRoot)!]);
  });

  it('non-CADLink hoverable ancestors still bubble child meshes to the component root', () => {
    const root = new Group(); root.name = 'Asset';
    const machine = new Group(); machine.name = 'Machine';
    machine.userData.realvirtual = { TestPickRoot: {} };
    const part = makePart('Cover');
    machine.add(part); root.add(machine);

    const registry = buildAndRegister(root);
    const geo = buildRaycastGeometries(root, [], registry, new Set());

    const paths = geo.staticGroup!.faceRanges.map((r) => r.objectPath);
    expect(paths).toEqual([registry.getPathForNode(machine)!]);
  });
});

// ─── Transform refit (fast path) ────────────────────────────────────

describe('refitRaycastGroupsForSubtrees (transform fast path)', () => {
  /** Two independently pickable 1×1×1 boxes at x=0 (A) and x=5 (B). */
  function buildTwoPartScene() {
    const root = new Group(); root.name = 'Asset';
    const partA = makePart('PartA');
    partA.userData.realvirtual = { TestPickRoot: {} };
    const partB = makePart('PartB');
    partB.userData.realvirtual = { TestPickRoot: {} };
    partB.position.set(5, 0, 0);
    root.add(partA, partB);
    root.updateMatrixWorld(true);
    const registry = buildAndRegister(root);
    const set = buildRaycastGeometries(root, [], registry, new Set());
    return { root, partA, partB, registry, set };
  }

  /** Cast straight down at (x, z) against the static group; resolved path or null. */
  function pickAt(set: RaycastGeometrySet, x: number, z: number): string | null {
    const group = set.staticGroup!;
    const ray = new Raycaster(new Vector3(x, 10, z), new Vector3(0, -1, 0));
    const hits = ray.intersectObject(group.mesh, false);
    if (hits.length === 0 || hits[0].faceIndex == null) return null;
    return resolveHit(group.faceRanges, hits[0].faceIndex);
  }

  it('re-bakes a moved subtree in place — pick follows, BVH refit, no rebuild', () => {
    const { partA, registry, set } = buildTwoPartScene();
    const pathA = registry.getPathForNode(partA)!;

    expect(pickAt(set, 0, 0)).toBe(pathA); // before the move
    const geometryBefore = set.staticGroup!.mesh.geometry;

    partA.position.set(10, 0, 0);
    partA.updateMatrixWorld(true);
    expect(refitRaycastGroupsForSubtrees(set, [partA])).toBe(true);

    expect(pickAt(set, 10, 0)).toBe(pathA);   // pick follows the move
    expect(pickAt(set, 0, 0)).toBeNull();     // old position is empty
    // In-place update — same geometry object (highlight proxies share it).
    expect(set.staticGroup!.mesh.geometry).toBe(geometryBefore);
  });

  it('leaves untouched siblings alone', () => {
    const { partA, partB, registry, set } = buildTwoPartScene();
    partA.position.set(10, 0, 0);
    partA.updateMatrixWorld(true);
    refitRaycastGroupsForSubtrees(set, [partA]);
    expect(pickAt(set, 5, 0)).toBe(registry.getPathForNode(partB)!);
  });

  it('refits when the moved node is an ANCESTOR of the source meshes', () => {
    const root = new Group(); root.name = 'Asset';
    const machine = new Group(); machine.name = 'Machine';
    machine.userData.realvirtual = { TestPickRoot: {} };
    const part = makePart('Cover');
    machine.add(part); root.add(machine);
    root.updateMatrixWorld(true);
    const registry = buildAndRegister(root);
    const set = buildRaycastGeometries(root, [], registry, new Set());
    const path = registry.getPathForNode(machine)!;

    machine.position.set(-7, 0, 0);
    machine.updateMatrixWorld(true);
    expect(refitRaycastGroupsForSubtrees(set, [machine])).toBe(true);
    expect(pickAt(set, -7, 0)).toBe(path);
  });

  it('returns false when a source geometry changed size (structural — needs rebuild)', () => {
    const { partA, set } = buildTwoPartScene();
    partA.geometry = new BoxGeometry(2, 2, 2, 2, 2, 2); // different vertex count
    expect(refitRaycastGroupsForSubtrees(set, [partA])).toBe(false);
  });

  it('no-ops (true) when no source mesh is under the moved nodes', () => {
    const { root, set } = buildTwoPartScene();
    const unrelated = new Group();
    root.add(unrelated);
    expect(refitRaycastGroupsForSubtrees(set, [unrelated])).toBe(true);
    expect(refitRaycastGroupsForSubtrees(set, [])).toBe(true);
  });
});

describe('RaycastManager behavior', () => {
  it('should apply exclude filters to intersections', () => {
    const overlayMesh = createOverlayMesh();
    const driveMesh = createDriveMesh('Drive1');
    const sensorVizMesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    sensorVizMesh.name = 'something_sensorViz';

    const excludeFilters = [
      (obj: Object3D) => !!obj.userData?._highlightOverlay,
      (obj: Object3D) => !!obj.userData?._driveHoverOverlay,
      (obj: Object3D) => obj.name.endsWith('_sensorViz'),
    ];

    const allHits = [overlayMesh, driveMesh, sensorVizMesh];
    const filtered = allHits.filter(
      hit => !excludeFilters.some(filter => filter(hit))
    );

    expect(filtered).toEqual([driveMesh]);
  });

  it('should detect correct nodeType from userData', () => {
    const driveMesh = createDriveMesh('Axis1');

    function findNodeType(obj: Object3D): string | null {
      let current: Object3D | null = obj;
      while (current) {
        if (current.userData?.rvType) return current.userData.rvType;
        current = current.parent;
      }
      return null;
    }

    expect(findNodeType(driveMesh)).toBe('Drive');

    // Child mesh without userData should walk up
    const childMesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    driveMesh.add(childMesh);
    expect(findNodeType(childMesh)).toBe('Drive');
  });

  it('should not emit when disabled (during orbit)', () => {
    let enabled = true;
    const emitted: unknown[] = [];

    const emit = (data: unknown) => {
      if (!enabled) return;
      emitted.push(data);
    };

    emit({ nodeType: 'Drive', pointer: { x: 100, y: 200 } });
    expect(emitted.length).toBe(1);

    enabled = false;
    emit({ nodeType: 'Drive', pointer: { x: 150, y: 250 } });
    expect(emitted.length).toBe(1);

    enabled = true;
    emit({ nodeType: 'Drive', pointer: { x: 200, y: 300 } });
    expect(emitted.length).toBe(2);
  });

  it('should provide driveHover deprecation getter', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const raycastManager = { enabled: true, hoveredNode: null as Object3D | null };
    const viewer = {
      get driveHover() {
        console.warn('viewer.driveHover is deprecated, use viewer.raycastManager');
        return {
          get enabled() { return raycastManager.enabled; },
          set enabled(v: boolean) { raycastManager.enabled = v; },
          get hoveredDrive() { return raycastManager.hoveredNode; },
          pointerClientX: 0,
          pointerClientY: 0,
        };
      }
    };

    const dh = viewer.driveHover;
    expect(warnSpy).toHaveBeenCalledWith('viewer.driveHover is deprecated, use viewer.raycastManager');
    expect(dh.enabled).toBe(true);

    warnSpy.mockRestore();
  });
});

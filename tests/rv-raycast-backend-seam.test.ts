// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RaycastBackend seam — the pluggable pick-geometry backend (editor instance
 * pick index) behind RaycastManager. Pins the contract with a FAKE backend:
 *
 *   - picking works with an EMPTY classic target list (editor mode has no
 *     merged groups / MU pools at first — the old `_targets.length === 0`
 *     early-outs must not fire when a backend is installed)
 *   - backend hits run through the SAME gate pipeline (visibility gate with
 *     fall-through to hits behind, isolation gate, hover-type gate)
 *   - backend hits and classic-target hits merge into ONE distance-sorted
 *     stream (closest wins regardless of category)
 */

import { describe, it, expect } from 'vitest';
import {
  Group, Mesh, BoxGeometry, BufferGeometry, MeshBasicMaterial,
  PerspectiveCamera, Raycaster, Scene, Vector3,
} from 'three';
import type { Intersection, Object3D } from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { buildRaycastGeometries } from '../src/core/engine/rv-raycast-geometry';
import { RaycastManager, type RaycastBackend } from '../src/core/engine/rv-raycast-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

registerComponentSchema('SeamTestType', {}, { hoverable: true, selectable: true });

function makeHighlighterMock() {
  return { highlight() {}, highlightInstancedMU() {}, clear() {} };
}

function makeManager(registry: NodeRegistry) {
  return new RaycastManager(
    { domElement: document.createElement('canvas') } as unknown as { readonly domElement: HTMLCanvasElement },
    () => new PerspectiveCamera(), new Scene(), registry,
    makeHighlighterMock() as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
    { emit() {} },
  );
}

/** A hoverable box node (Group carrying the type) with one child mesh at z. */
function makeBoxNode(name: string, z: number): { node: Group; mesh: Mesh } {
  const node = new Group();
  node.name = name;
  node.userData.realvirtual = { SeamTestType: {} };
  node.userData._rvType = 'SeamTestType';
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.name = `${name}Mesh`;
  mesh.position.set(0, 0, z);
  node.add(mesh);
  return { node, mesh };
}

/**
 * Fake backend: real ray vs the entry meshes (native three raycast is fine —
 * the seam is about MERGING and RESOLUTION, not acceleration).
 */
function makeFakeBackend(entries: { mesh: Mesh; path: string }[]): RaycastBackend {
  const byMesh = new Map<Object3D, string>(entries.map((e) => [e.mesh, e.path]));
  return {
    raycast(raycaster: Raycaster, out: Intersection<Object3D>[]): void {
      for (const { mesh } of entries) mesh.raycast(raycaster, out);
    },
    resolvePath(mesh: Object3D): string | null {
      return byMesh.get(mesh) ?? null;
    },
  };
}

const RAY_ORIGIN = new Vector3(0, 0, 10);
const RAY_DIR = new Vector3(0, 0, -1);

function buildBackendScene() {
  const root = new Group();
  root.name = 'Root';
  const front = makeBoxNode('Front', 2);
  const rear = makeBoxNode('Rear', 0);
  root.add(front.node, rear.node);
  root.updateMatrixWorld(true);
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  return { root, registry, front, rear };
}

describe('RaycastBackend seam', () => {
  it('picks via the backend with an EMPTY classic target list (hover + click guards)', () => {
    const { registry, front, rear } = buildBackendScene();
    const rm = makeManager(registry);
    rm.setBackend(makeFakeBackend([
      { mesh: front.mesh, path: registry.getPathForNode(front.node)! },
      { mesh: rear.mesh, path: registry.getPathForNode(rear.node)! },
    ]));
    rm.enableHoverType('SeamTestType', true);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(front.node));
    rm.dispose();
  });

  it('returns null with neither targets nor backend (no crash)', () => {
    const { registry } = buildBackendScene();
    const rm = makeManager(registry);
    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBeNull();
    rm.dispose();
  });

  it('visibility gate rejects a backend hit and falls through to the hit behind', () => {
    const { registry, front, rear } = buildBackendScene();
    front.node.visible = false;
    const rm = makeManager(registry);
    rm.setBackend(makeFakeBackend([
      { mesh: front.mesh, path: registry.getPathForNode(front.node)! },
      { mesh: rear.mesh, path: registry.getPathForNode(rear.node)! },
    ]));
    rm.enableHoverType('SeamTestType', true);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(rear.node));
    rm.dispose();
  });

  it('isolation gate applies to backend hits', () => {
    const { registry, front, rear } = buildBackendScene();
    const rm = makeManager(registry);
    rm.setBackend(makeFakeBackend([
      { mesh: front.mesh, path: registry.getPathForNode(front.node)! },
      { mesh: rear.mesh, path: registry.getPathForNode(rear.node)! },
    ]));
    rm.enableHoverType('SeamTestType', true);
    rm.setIsolationGate((node) => node !== front.node);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(rear.node));
    rm.dispose();
  });

  it('merges backend and classic-target hits into one distance-sorted stream', () => {
    // Backend owns the REAR box; a merged static group owns the FRONT box.
    // The closer (front, merged-group) hit must win although the backend
    // appended its hit first.
    const root = new Group();
    root.name = 'Root';
    const front = makeBoxNode('Front', 2);
    const rear = makeBoxNode('Rear', 0);
    root.add(front.node);
    root.updateMatrixWorld(true);

    const registry = new NodeRegistry();
    root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const geo = buildRaycastGeometries(root, [], registry, new Set());

    // Rear node lives OUTSIDE the merged scene — backend-only entry.
    const rearRoot = new Group();
    rearRoot.name = 'RearRoot';
    rearRoot.add(rear.node);
    rearRoot.updateMatrixWorld(true);
    rearRoot.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

    const rm = makeManager(registry);
    rm.setRaycastGeometry(geo, []);
    rm.setBackend(makeFakeBackend([
      { mesh: rear.mesh, path: registry.getPathForNode(rear.node)! },
    ]));
    rm.enableHoverType('SeamTestType', true);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(front.node));

    // Hide the front node → the sorted stream falls through to the backend hit.
    front.node.visible = false;
    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(rear.node));
    rm.dispose();
  });
});

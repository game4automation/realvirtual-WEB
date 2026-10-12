// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RaycastBackend seam — the pluggable pick-geometry backend (instance pick
 * index, chunk pick backend) behind RaycastManager. Pins the contract with a
 * FAKE backend:
 *
 *   - picking works with an EMPTY classic target list (a model without MU
 *     pools has only backend geometry — the old `_targets.length === 0`
 *     early-outs must not fire when a backend is installed)
 *   - backend hits run through the SAME gate pipeline (visibility gate with
 *     fall-through to hits behind, isolation gate, hover-type gate)
 *   - hits of the primary backend and of an additional backend (the chunk
 *     pick backend of a baked scene) merge into ONE distance-sorted stream
 *     (closest wins regardless of category)
 */

import { describe, it, expect } from 'vitest';
import {
  Group, Mesh, BoxGeometry, BufferGeometry, MeshBasicMaterial,
  PerspectiveCamera, Raycaster, Scene, Vector3,
} from 'three';
import type { Intersection, Object3D } from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { RaycastManager, type RaycastBackend } from '../src/core/engine/rv-raycast-manager';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { PickBackend } from '../src/core/engine/rv-pick-backend';
import { bakeAndPlace } from './fixtures/bake-fixture';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

registerComponentSchema('SeamTestType', {}, { pick: 'select' });

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

  it('merges primary-backend and chunk-backend hits into one distance-sorted stream', async () => {
    // The fake primary backend owns the REAR box; the baked scene (chunk pick
    // backend, an ADDITIONAL backend) owns the FRONT box. The closer (front,
    // chunk) hit must win although the primary backend appended its hit first.
    const root = new Group();
    root.name = 'Root';
    const front = makeBoxNode('Front', 2);
    const rear = makeBoxNode('Rear', 0);
    root.add(front.node);
    root.updateMatrixWorld(true);

    // plan-754: the bake is destructive — register the placed TEMPLATE.
    const bakeRegistry = new BakeRegistry();
    const placed = await bakeAndPlace(root, bakeRegistry);

    const registry = new NodeRegistry();
    placed.template.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    // The survivor is a NEW object — `front.node` above went with `root`.
    const frontPlaced = placed.node(front.node.name);

    // Rear node lives OUTSIDE the baked scene — primary-backend-only entry.
    const rearRoot = new Group();
    rearRoot.name = 'RearRoot';
    rearRoot.add(rear.node);
    rearRoot.updateMatrixWorld(true);
    rearRoot.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

    const rm = makeManager(registry);
    rm.addBackend(new PickBackend(bakeRegistry));
    rm.setBackend(makeFakeBackend([
      { mesh: rear.mesh, path: registry.getPathForNode(rear.node)! },
    ]));
    rm.enableHoverType('SeamTestType', true);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(frontPlaced));

    // Hide the front node → the sorted stream falls through to the backend hit.
    frontPlaced.visible = false;
    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(rear.node));
    rm.dispose();
  });
});

// ─── RuntimeMetadata on a parent: editor exact-node vs baked grouping ──────

describe('RuntimeMetadata parent — pick resolution per backend', () => {
  /** Station (RuntimeMetadata) → Part (SeamTestType) → PartMesh at z = 0. */
  function buildStation() {
    const root = new Group();
    root.name = 'Root';
    const station = new Group();
    station.name = 'Station';
    station.userData.realvirtual = { RuntimeMetadata: { content: '<name>Station</name>' } };
    station.userData._rvMetadata = { content: '<name>Station</name>' };
    station.userData._rvType = 'Metadata';
    const part = makeBoxNode('Part', 0);
    station.add(part.node);
    root.add(station);
    root.updateMatrixWorld(true);
    return { root, station, part };
  }

  it('editor (path backend): a part under a metadata station resolves to the EXACT part', () => {
    const { root, station, part } = buildStation();
    const registry = new NodeRegistry();
    root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const rm = makeManager(registry);
    rm.setBackend(makeFakeBackend([{ mesh: part.mesh, path: registry.getPathForNode(part.node)! }]));
    rm.enableHoverType('SeamTestType', true);
    rm.enableHoverType('Metadata', true);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(part.node));
    expect(rm.hoveredNodePath).not.toBe(registry.getPathForNode(station));
    rm.dispose();
  });

  it('runtime (baked): a plain mesh under a metadata station resolves to the station', async () => {
    await import('../src/core/engine/rv-metadata'); // registers RuntimeMetadata pick:'select'
    const root = new Group();
    root.name = 'Root';
    const station = new Group();
    station.name = 'Station';
    station.userData.realvirtual = { RuntimeMetadata: { content: '<name>Station</name>' } };
    const plain = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    plain.name = 'PlainPart';
    station.add(plain);
    root.add(station);
    root.updateMatrixWorld(true);

    const bakeRegistry = new BakeRegistry();
    const placed = await bakeAndPlace(root, bakeRegistry);
    const registry = new NodeRegistry();
    placed.template.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const stationPlaced = placed.node('Station');

    const rm = makeManager(registry);
    rm.addBackend(new PickBackend(bakeRegistry));
    rm.enableHoverType('Metadata', true);
    rm.enableHoverType('RuntimeMetadata', true);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(stationPlaced));
    rm.dispose();
  });
});

describe('RuntimeMetadata parent — REAL InstancePickIndex (editor backend)', () => {
  it('hover over a plain part under a metadata station resolves to the part', async () => {
    await import('../src/core/engine/rv-metadata');
    const { InstancePickIndex } = await import('../src/core/engine/rv-instance-pick-index');
    const root = new Group();
    root.name = 'Root';
    const station = new Group();
    station.name = 'Station';
    station.userData.realvirtual = { RuntimeMetadata: { content: '<name>S</name>' } };
    station.userData._rvMetadata = { content: '<name>S</name>' };
    station.userData._rvType = 'Metadata';
    const part = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    part.name = 'PlainPart';
    station.add(part);
    root.add(station);
    root.updateMatrixWorld(true);
    const registry = new NodeRegistry();
    root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    const index = new InstancePickIndex(registry);
    index.addSubtree(root);
    const rm = makeManager(registry);
    rm.setBackend(index);
    rm.enableHoverType('Metadata', true);
    rm.enableHoverType('RuntimeMetadata', true);
    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(part));
    rm.dispose();
  });
});

describe('aux raycast targets — a hidden gizmo never catches the pointer', () => {
  it('an aux hull under a HIDDEN group falls through to the backend hit behind it', () => {
    const { registry, front, rear } = buildBackendScene();
    const rm = makeManager(registry);
    // Backend owns only the REAR box; the FRONT box plays the gizmo hull
    // (WebError flash hull: visible mesh under a hidden root group).
    rm.setBackend(makeFakeBackend([{ mesh: rear.mesh, path: registry.getPathForNode(rear.node)! }]));
    rm.enableHoverType('SeamTestType', true);
    const hullGroup = new Group();
    hullGroup.visible = false;
    front.node.remove(front.mesh);
    hullGroup.add(front.mesh);
    front.node.add(hullGroup);
    front.node.updateMatrixWorld(true);
    rm.addAuxRaycastTarget(front.mesh, front.node);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(rear.node));

    // Shown again → the hull resolves to its owner and wins by distance.
    hullGroup.visible = true;
    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(front.node));
    rm.dispose();
  });
});

describe('aux raycast targets — the EnergyChain envelope proxy stays pickable', () => {
  it('an invisible mesh flagged _rvEnergyChainProxy still resolves to its owner', () => {
    const { registry, front, rear } = buildBackendScene();
    const rm = makeManager(registry);
    rm.setBackend(makeFakeBackend([{ mesh: rear.mesh, path: registry.getPathForNode(rear.node)! }]));
    rm.enableHoverType('SeamTestType', true);
    front.mesh.visible = false;
    front.mesh.userData._rvEnergyChainProxy = true;
    rm.addAuxRaycastTarget(front.mesh, front.node);

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(front.node));
    rm.dispose();
  });
});

describe('aux raycast targets — onTop (WebLabel billboards) win over geometry in front', () => {
  it('an onTop aux target BEHIND the front box is the hover result; raycastSurface still reports the box', () => {
    const { registry, front, rear } = buildBackendScene();
    const rm = makeManager(registry);
    rm.setBackend(makeFakeBackend([{ mesh: front.mesh, path: registry.getPathForNode(front.node)! }]));
    rm.enableHoverType('SeamTestType', true);
    // The rear box's mesh plays the billboard: an aux target of the rear node, drawn on top.
    rm.addAuxRaycastTarget(rear.mesh, rear.node, { onTop: true });

    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(rear.node));

    // Without onTop the closer front box wins (distance order).
    rm.addAuxRaycastTarget(rear.mesh, rear.node);
    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(front.node));
    rm.dispose();
  });
});

describe('raycastSurfaceAlong — the pointer-free surface query (WebLabel pin cast)', () => {
  it('answers the first owned surface along an arbitrary ray, skipping onTop overlays', () => {
    const { registry, front, rear } = buildBackendScene();
    const rm = makeManager(registry);
    rm.setBackend(makeFakeBackend([
      { mesh: front.mesh, path: registry.getPathForNode(front.node)! },
      { mesh: rear.mesh, path: registry.getPathForNode(rear.node)! },
    ]));
    const out = { point: new Vector3(), distance: 0, blocked: false, path: null as string | null };
    expect(rm.raycastSurfaceAlong(RAY_ORIGIN, RAY_DIR, out)).toBe(true);
    expect(out.path).toBe(registry.getPathForNode(front.node));
    expect(out.point.z).toBeCloseTo(2.5, 5);

    // An onTop overlay in the way is not a surface.
    const overlay = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    overlay.position.set(0, 0, 5); overlay.updateMatrixWorld(true);
    rm.addAuxRaycastTarget(overlay, front.node, { onTop: true });
    expect(rm.raycastSurfaceAlong(RAY_ORIGIN, RAY_DIR, out)).toBe(true);
    expect(out.point.z).toBeCloseTo(2.5, 5);
    rm.dispose();
  });
});

describe('raycastNodeAlong — first hit that belongs to the node, past everything in between (WebLabel pin)', () => {
  it('finds the rear node behind the front box and behind an owner-less blocking chunk', async () => {
    const { registry, front, rear } = buildBackendScene();
    const rm = makeManager(registry);
    rm.setBackend(makeFakeBackend([
      { mesh: front.mesh, path: registry.getPathForNode(front.node)! },
      { mesh: rear.mesh, path: registry.getPathForNode(rear.node)! },
    ]));
    const out = { point: new Vector3(), distance: 0 };
    // Front box is first along the ray — the rear node is still found.
    expect(rm.raycastNodeAlong(RAY_ORIGIN, RAY_DIR, rear.node, out)).toBe(true);
    expect(out.point.z).toBeCloseTo(0.5, 5);
    // A node not on the ray → false.
    const elsewhere = new Group(); elsewhere.name = 'Elsewhere'; registry.registerNode('Elsewhere', elsewhere);
    expect(rm.raycastNodeAlong(RAY_ORIGIN, RAY_DIR, elsewhere, out)).toBe(false);

    // An opaque, owner-less baked chunk in front BLOCKS the surface query but not this one.
    const blocker = new Group(); blocker.name = 'Blocker';
    const plain = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()); plain.position.set(0, 0, 6);
    blocker.add(plain); blocker.updateMatrixWorld(true);
    const bakeRegistry = new BakeRegistry();
    const placed = await bakeAndPlace(blocker, bakeRegistry);
    placed.template.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
    rm.addBackend(new PickBackend(bakeRegistry));
    const surf = { point: new Vector3(), distance: 0, blocked: false, path: null as string | null };
    expect(rm.raycastSurfaceAlong(RAY_ORIGIN, RAY_DIR, surf) && surf.blocked).toBe(true);
    expect(rm.raycastNodeAlong(RAY_ORIGIN, RAY_DIR, rear.node, out)).toBe(true);
    expect(out.point.z).toBeCloseTo(0.5, 5);
    rm.dispose();
  });
});

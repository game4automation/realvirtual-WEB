// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.5 / plan-756 §9.4 — the baked pick backend (was
 * chunk-pick-backend.test.ts; same scenarios, the backend was renamed with the
 * hard cut of step 1d).
 *
 * Two instances of ONE baked asset share every chunk geometry; a ray through
 * the second instance must resolve to the SECOND instance's node, and to the
 * innermost `nodes[]` window (the Drive, not the placement). A face outside
 * every window resolves to the chunk owner; an `action` node reports its
 * type (the viewer's click handler then fires `onClick` without selecting);
 * `placementOf(node)` walks back to the placement root.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  BufferGeometry, Group, Mesh, PerspectiveCamera, Scene, Vector3,
} from 'three';
import type { Object3D } from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import '../src/core/engine/rv-scene-loader';
import { RaycastManager } from '../src/core/engine/rv-raycast-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema, getCapabilities } from '../src/core/engine/rv-component-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { PickBackend } from '../src/core/engine/rv-pick-backend';
import type { BakedAsset } from '../src/core/engine/rv-bake-chunk';
import { bakeAndPlace, bakeTree, group, uberMesh, withComponent } from './fixtures/bake-fixture';

/** Plain lookup — after plan-754 a traverse reaches everything there is. */
function findNode(root: Object3D, name: string): Object3D | undefined {
  let found: Object3D | undefined;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

/** `findNode` as a null-returning assertion helper. */
function findNodeOrNull(root: Object3D, name: string): Object3D | null {
  return findNode(root, name) ?? null;
}

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

registerComponentSchema('PickActionTest', {}, { pick: 'action' });

const uber = new RVUberMaterial(false);

/**
 * Asset (all boxes 1³):
 *   Machine
 *   ├─ frame            static chunk, window = root (owner)
 *   ├─ Drive-A {Drive}  mover chunk, mesh `arm` at z=+2
 *   └─ Button {PickActionTest} mesh at z=-2 (static chunk, own window)
 */
function makeAsset(): Group {
  const root = group('Machine');
  root.add(uberMesh(uber, 'frame'));
  const drive = withComponent(group('Drive-A'), 'Drive');
  drive.add(uberMesh(uber, 'arm', [0, 0, 2]));
  root.add(drive);
  const button = withComponent(uberMesh(uber, 'Button', [0, 0, -2]), 'PickActionTest');
  root.add(button);
  return root;
}

function makeHighlighterMock() {
  return { highlight() {}, highlightInstancedMU() {}, clear() {} };
}

function makeManager(registry: NodeRegistry, scene: Scene): RaycastManager {
  return new RaycastManager(
    { domElement: document.createElement('canvas') } as unknown as { readonly domElement: HTMLCanvasElement },
    () => new PerspectiveCamera(), scene, registry,
    makeHighlighterMock() as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
    { emit() {} },
  );
}

function registerAll(registry: NodeRegistry, root: Object3D): void {
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
}

const DOWN = new Vector3(0, -1, 0);

describe('PickBackend (plan-753 §9.5)', () => {
  let baked: BakedAsset;
  beforeAll(async () => {
    baked = await bakeTree(makeAsset(), { uber });
  });

  function setup() {
    const scene = new Scene();
    const bakeRegistry = new BakeRegistry();
    const a = new Group(); a.name = 'A'; scene.add(a);
    const b = new Group(); b.name = 'B'; b.position.x = 10; scene.add(b);
    const instA = bakeRegistry.instantiate(baked, a);
    const instB = bakeRegistry.instantiate(baked, b);
    scene.updateMatrixWorld(true);
    const registry = new NodeRegistry();
    registerAll(registry, a);
    registerAll(registry, b);
    const rm = makeManager(registry, scene);
    rm.addBackend(new PickBackend(bakeRegistry));
    rm.enableHoverType('Drive', true);
    rm.enableHoverType('PickActionTest', true);
    return { scene, bakeRegistry, a, b, instA, instB, registry, rm };
  }

  it('bakes into a static chunk plus one mover chunk with shared geometry', () => {
    expect(baked.chunks.map((c) => c.key).sort()).toEqual(['mover:Drive-A', 'static']);
  });

  it('resolves a ray through the second instance to ITS drive node — not the first one', () => {
    const { rm, instA, instB, registry } = setup();
    const driveB = instB.logicNodes.find((n) => n.name === 'Drive-A')!;
    const driveA = instA.logicNodes.find((n) => n.name === 'Drive-A')!;
    expect(driveB).not.toBe(driveA);
    rm.updateFromXRController(new Vector3(10, 5, 2), DOWN);
    expect(rm.hoveredNode).toBe(driveB);
    expect(rm.hoveredNodeType).toBe('Drive');
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(driveB));
    rm.dispose();
  });

  it('a face outside every window resolves to the chunk owner (the placement root)', () => {
    const { rm, a } = setup();
    rm.updateFromXRController(new Vector3(0, 5, 0), DOWN); // the `frame` box
    expect(rm.hoveredNode).toBe(a);
    rm.dispose();
  });

  it('an action node resolves with its own type (click fires, never selects)', () => {
    const { rm, instB } = setup();
    rm.updateFromXRController(new Vector3(10, 5, -2), DOWN);
    const button = instB.logicNodes.find((n) => n.name === 'Button')!;
    expect(rm.hoveredNode).toBe(button);
    expect(rm.hoveredNodeType).toBe('PickActionTest');
    expect(getCapabilities(rm.hoveredNodeType!).pick).toBe('action');
    // The logic node is a plain node — the geometry lives in the chunk.
    expect((button as Mesh).isMesh).toBeFalsy();
    rm.dispose();
  });

  it('placementOf() derives the placement from the innermost node', () => {
    const { bakeRegistry, a, b, instB } = setup();
    const driveB = instB.logicNodes.find((n) => n.name === 'Drive-A')!;
    expect(bakeRegistry.placementOf(driveB)).toBe(b);
    expect(bakeRegistry.placementOf(a)).toBe(a);
    expect(bakeRegistry.placementOf(new Group())).toBeNull();
  });

  it('the backend passes non-registry meshes through (resolvePath null, no hit)', () => {
    const { rm, bakeRegistry } = setup();
    const backend = new PickBackend(bakeRegistry);
    expect(backend.resolvePath()).toBeNull();
    expect(backend.resolveHit({ object: new Mesh(), faceIndex: 0 })).toBeNull();
    rm.dispose();
  });

  it('a released instance is no longer pickable; the other one still is', () => {
    const { rm, bakeRegistry, instA, b } = setup();
    const before = baked.instances; // shared asset — earlier setups hold instances too
    bakeRegistry.release(instA);
    rm.updateFromXRController(new Vector3(0, 5, 0), DOWN);
    expect(rm.hoveredNode).toBeNull();
    rm.updateFromXRController(new Vector3(10, 5, 0), DOWN);
    expect(rm.hoveredNode).toBe(b);
    expect(baked.instances).toBe(before - 1);
    expect(instA.released).toBe(true);
    expect(instA.chunks.every((m) => m.parent === null)).toBe(true);
    rm.dispose();
  });
});

// ─── plan-754 Phase 1c: the loader variant (identity placement) ─────────
// Was "in-place instance (plan-753 Phase 4a)". The masking half of that test
// is gone with the in-place bake — nothing is masked any more, the merged
// nodes simply do not exist. What survives it is the PICK contract of an
// identity placement, which is what the loader still produces.
describe('PickBackend — identity placement (loader, plan-754)', () => {
  it('resolves to the surviving nodes of the template; release leaves them alone', async () => {
    const scene = new Scene();
    const bakeRegistry = new BakeRegistry();
    const placed = await bakeAndPlace(makeAsset(), bakeRegistry, { uber });
    const template = placed.template;
    scene.add(template);
    scene.updateMatrixWorld(true);

    expect(placed.instance.identity).toBe(true);
    expect(placed.instance.root).toBe(template);
    // The merged CAD leaves are REMOVED, not masked (plan-754 G4).
    expect(findNodeOrNull(template, 'frame')).toBeNull();
    expect(findNodeOrNull(template, 'arm')).toBeNull();

    const registry = new NodeRegistry();
    registerAll(registry, template);
    const rm = makeManager(registry, scene);
    rm.addBackend(new PickBackend(bakeRegistry));
    rm.enableHoverType('Drive', true);
    rm.enableHoverType('PickActionTest', true);
    // Mover window: the Drive node itself (no clone).
    rm.updateFromXRController(new Vector3(0, 5, 2), DOWN);
    expect(rm.hoveredNode).toBe(placed.node('Drive-A'));
    // Root catch-all window: transparent (no pickable ancestor — the ray
    // passes through).
    rm.updateFromXRController(new Vector3(0, 5, 0), DOWN);
    expect(rm.hoveredNode).toBeNull();
    // Action node window: the action node, a survivor of the template.
    rm.updateFromXRController(new Vector3(0, 5, -2), DOWN);
    expect(rm.hoveredNode).toBe(placed.node('Button'));

    const driveNode = placed.node('Drive-A');
    bakeRegistry.release(placed.instance);
    expect(placed.instance.chunks.every((m) => m.parent === null)).toBe(true);
    // Release takes out the chunk meshes and nothing else: the document graph
    // of an identity placement is not the placement's to dismantle.
    expect(driveNode.parent).toBe(template);
    rm.dispose();
  });
});

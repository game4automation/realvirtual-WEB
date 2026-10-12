// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-756 §9.3 / §9.4a — the SEMANTICS of the baked pick backend.
 *
 *  - an opaque segment without a pick owner BLOCKS: what lies behind it, in the
 *    same chunk and in another chunk, is not picked (Q5);
 *  - "blocked" is not "pass": the manager's hit loop ENDS on it and never falls
 *    through to a farther hit of another backend;
 *  - a TRANSPARENT chunk never blocks — a guard behind safety glass stays
 *    selectable (the glass guard of the plan's task list);
 *  - a hidden node's segments are skipped DURING the traversal, so the part
 *    behind it is picked (F2) — per INSTANCE, never on the shared structure:
 *    two placements sharing one chunk geometry hide independently;
 *  - a SURFACE query (the `.raycast` override) still hits the blocker: occlusion
 *    is a node-pick rule, not a geometry rule (F3);
 *  - a `dynamic` keep mesh stays pickable after its geometry was rewritten (F9).
 */
import { describe, it, expect } from 'vitest';
import {
  BufferAttribute, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, Scene, Vector3,
} from 'three';
import type { Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { RaycastManager, RAYCAST_BLOCKED, type RaycastBackend } from '../src/core/engine/rv-raycast-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerCapabilities, registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { PickBackend } from '../src/core/engine/rv-pick-backend';
import { bakeAndPlace, bakeTree, group, uberMesh, withComponent } from './fixtures/bake-fixture';

// A SCHEMA type, not just capabilities: only a node with a registered component
// becomes a logic node, and a cloned (planner) placement needs that to have an
// instance node of its own.
registerComponentSchema('TestPickSem', {}, { pick: 'select' });
registerCapabilities('TestDynKeep', { pick: 'select', bake: 'keep', dynamicGeometry: true });

const uber = new RVUberMaterial(false);

/** Straight down the -Z axis from z = +10 — every fixture is laid out on it. */
const RAY_ORIGIN = new Vector3(0, 0, 10);
const RAY_DIR = new Vector3(0, 0, -1);

function makeManager(registry: NodeRegistry, scene: Scene): RaycastManager {
  return new RaycastManager(
    { domElement: document.createElement('canvas') } as unknown as { readonly domElement: HTMLCanvasElement },
    () => new PerspectiveCamera(), scene, registry,
    { highlight() {}, highlightInstancedMU() {}, clear() {} } as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
    { emit() {} },
  );
}

function registerAll(registry: NodeRegistry, root: Object3D): void {
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
}

/** Place a destructive bake, wire a manager with the pick backend, hover -Z. */
async function place(root: Object3D, opts: { survives?: (n: Object3D) => boolean } = {}) {
  const scene = new Scene();
  const bakeRegistry = new BakeRegistry();
  const placed = await bakeAndPlace(root, bakeRegistry, { uber, ...opts });
  scene.add(placed.template);
  scene.updateMatrixWorld(true);
  const registry = new NodeRegistry();
  registerAll(registry, placed.template);
  const rm = makeManager(registry, scene);
  rm.addBackend(new PickBackend(bakeRegistry));
  rm.enableHoverType('TestPickSem', true);
  rm.enableHoverType('TestDynKeep', true);
  const hover = (): Object3D | null => {
    rm.updateFromXRController(RAY_ORIGIN, RAY_DIR);
    return rm.hoveredNode;
  };
  return { scene, bakeRegistry, placed, rm, registry, hover };
}

describe('PickBackend — occlusion (plan-756 Q5)', () => {
  it('an opaque unowned segment blocks a pickable part behind it in the SAME chunk', async () => {
    const root = group('Asset');
    // `Cover` survives the bake but carries no component: its triangles land in
    // the static chunk with `segOwner === -1`.
    const cover = group('Cover');
    cover.add(uberMesh(uber, 'coverMesh', [0, 0, 0]));
    const inner = withComponent(group('Inner'), 'TestPickSem');
    inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
    root.add(cover, inner);

    const { placed, hover } = await place(root, { survives: (n) => n.name === 'Cover' });
    // ONE chunk — both boxes share the uber material.
    expect(placed.baked.chunks).toHaveLength(1);
    expect(placed.baked.chunks[0].blocks).toBe(true);
    expect(hover()).toBeNull();

    // Control: the ray DOES reach `Inner` once the blocker is out of the way, so
    // the null above is the block and not a ray that missed.
    placed.node('Cover').visible = false;
    expect(hover()).toBe(placed.node('Inner'));
  });

  it('an opaque unowned segment blocks a part in ANOTHER chunk', async () => {
    const root = group('Asset');
    const cover = group('Cover');
    cover.add(uberMesh(uber, 'coverMesh', [0, 0, 0]));
    // A mover: its own chunk, and pickable.
    const drive = withComponent(group('Drive-A'), 'Drive');
    drive.add(uberMesh(uber, 'arm', [0, 0, -3]));
    root.add(cover, drive);

    const { placed, rm, hover } = await place(root, { survives: (n) => n.name === 'Cover' });
    rm.enableHoverType('Drive', true);
    expect(placed.baked.chunks.map((c) => c.key).sort()).toEqual(['mover:Drive-A', 'static']);
    expect(hover()).toBeNull();

    // Hiding the blocking chunk's node lets the mover through — the block is the
    // COVER's geometry, not a property of the mover chunk.
    placed.node('Cover').visible = false;
    expect(hover()).toBe(placed.node('Drive-A'));
  });

  it('a transparent chunk never blocks — the part behind glass stays selectable', async () => {
    const root = group('Asset');
    const cover = group('Cover');
    const glass = uberMesh(uber, 'glass', [0, 0, 0]);
    glass.material = new MeshStandardMaterial({ transparent: true, opacity: 0.4 });
    glass.userData._rvUberBaked = false;
    cover.add(glass);
    const inner = withComponent(group('Inner'), 'TestPickSem');
    inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
    root.add(cover, inner);

    const { placed, hover } = await place(root, { survives: (n) => n.name === 'Cover' });
    const glassChunk = placed.baked.chunks.find((c) => c.key.startsWith('tex:'))!;
    expect(glassChunk, 'the transparent material gets its own chunk').toBeTruthy();
    expect(glassChunk.blocks).toBe(false);
    expect(glassChunk.pick.blocks).toBe(false);
    expect(hover()).toBe(placed.node('Inner'));
  });

  it('a hidden node is skipped during the traversal and the part behind it is picked', async () => {
    const root = group('Asset');
    const cover = withComponent(group('Cover'), 'TestPickSem');
    cover.add(uberMesh(uber, 'coverMesh', [0, 0, 0]));
    const inner = withComponent(group('Inner'), 'TestPickSem');
    inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
    root.add(cover, inner);

    const { placed, hover } = await place(root);
    expect(hover()).toBe(placed.node('Cover'));
    placed.node('Cover').visible = false;
    expect(hover()).toBe(placed.node('Inner'));
  });

  it('the surface query hits the blocker: occlusion is a node-pick rule only', async () => {
    const root = group('Asset');
    const cover = group('Cover');
    cover.add(uberMesh(uber, 'coverMesh', [0, 0, 0]));
    const inner = withComponent(group('Inner'), 'TestPickSem');
    inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
    root.add(cover, inner);

    const { placed, hover } = await place(root, { survives: (n) => n.name === 'Cover' });
    expect(hover()).toBeNull();

    // The same geometry through `mesh.raycast` (measure / annotate / MCP): the
    // NEAREST triangle, which is the cover's front face at z = +0.5.
    const raycaster = new Raycaster(RAY_ORIGIN.clone(), RAY_DIR.clone());
    const hits: ReturnType<Raycaster['intersectObject']> = [];
    placed.instance.chunks[0].raycast(raycaster, hits);
    expect(hits).toHaveLength(1);
    expect(hits[0].point.z).toBeCloseTo(0.5, 5);
  });

  it('"blocked" is not "pass": the manager never falls through to a farther backend hit', async () => {
    const root = group('Asset');
    const cover = group('Cover');
    cover.add(uberMesh(uber, 'coverMesh', [0, 0, 0]));
    root.add(cover);

    const { placed, scene, rm, registry, hover } = await place(root, { survives: (n) => n.name === 'Cover' });
    // A second backend whose hit sits BEHIND the blocker and resolves fine. With
    // "blocked" collapsed into "pass" this would be hovered.
    const decoy = withComponent(new Group(), 'TestPickSem');
    decoy.name = 'Decoy';
    decoy.position.set(0, 0, -6);
    scene.add(decoy);
    scene.updateMatrixWorld(true);
    registry.registerNode('Decoy', decoy);
    const behind: RaycastBackend = {
      raycast(_rc, out) {
        out.push({ distance: 16, point: new Vector3(0, 0, -6), object: decoy } as never);
      },
      resolvePath: () => null,
      resolveHit: () => decoy,
    };
    rm.addBackend(behind);
    expect(hover()).toBeNull();

    // Without the blocker in the way the decoy IS reachable, so the test above
    // really measured the block and not a broken decoy.
    placed.node('Cover').visible = false;
    expect(hover()).toBe(decoy);
  });
});

describe('PickBackend — per-instance hidden state (plan-756 §9.4a)', () => {
  it('two placements share one chunk geometry; hiding a node in one hides it only there', async () => {
    const root = group('Asset');
    const cover = withComponent(group('Cover'), 'TestPickSem');
    cover.add(uberMesh(uber, 'coverMesh', [0, 0, 0]));
    const inner = withComponent(group('Inner'), 'TestPickSem');
    inner.add(uberMesh(uber, 'innerMesh', [0, 0, -3]));
    root.add(cover, inner);

    const baked = await bakeTree(root, { uber });
    const scene = new Scene();
    const bakeRegistry = new BakeRegistry();
    const a = new Group(); a.name = 'A'; scene.add(a);
    const b = new Group(); b.name = 'B'; b.position.x = 20; scene.add(b);
    const instA = bakeRegistry.instantiate(baked, a);
    const instB = bakeRegistry.instantiate(baked, b);
    scene.updateMatrixWorld(true);
    // The shared geometry is literally the same object in both placements.
    expect(instA.chunks[0].geometry).toBe(instB.chunks[0].geometry);

    const registry = new NodeRegistry();
    registerAll(registry, a);
    registerAll(registry, b);
    const rm = makeManager(registry, scene);
    rm.addBackend(new PickBackend(bakeRegistry));
    rm.enableHoverType('TestPickSem', true);

    const coverA = instA.logicNodes.find((n) => n.name === 'Cover')!;
    const innerA = instA.logicNodes.find((n) => n.name === 'Inner')!;
    const coverB = instB.logicNodes.find((n) => n.name === 'Cover')!;

    rm.updateFromXRController(new Vector3(0, 0, 10), RAY_DIR);
    expect(rm.hoveredNode).toBe(coverA);
    rm.updateFromXRController(new Vector3(20, 0, 10), RAY_DIR);
    expect(rm.hoveredNode).toBe(coverB);

    coverA.visible = false;
    scene.updateMatrixWorld(true);
    rm.updateFromXRController(new Vector3(0, 0, 10), RAY_DIR);
    expect(rm.hoveredNode, 'A sees through its own hidden cover').toBe(innerA);
    rm.updateFromXRController(new Vector3(20, 0, 10), RAY_DIR);
    expect(rm.hoveredNode, 'B is untouched — nothing was written on the shared structure').toBe(coverB);
    rm.dispose();
  });
});

describe('PickBackend — dynamic keep meshes (plan-756 F9)', () => {
  it('a keep mesh whose geometry was rewritten is picked at its NEW position', async () => {
    const root = group('Asset');
    const volume = withComponent(uberMesh(uber, 'Volume', [0, 0, 0]), 'TestDynKeep');
    root.add(volume);

    const { placed, hover } = await place(root);
    expect(placed.baked.keep.map((k) => k.path)).toEqual(['Volume']);
    const keepMesh = placed.instance.keep[0];
    expect(hover()).toBe(keepMesh);

    // Rewrite the geometry: move every vertex out of the ray's way.
    const geometry = keepMesh.geometry;
    const position = geometry.getAttribute('position') as BufferAttribute;
    const moved = new Float32Array(position.array as Float32Array);
    for (let i = 0; i < moved.length; i += 3) moved[i] += 40;
    geometry.setAttribute('position', new BufferAttribute(moved, 3));
    expect(hover(), 'the old geometry is not picked any more').toBeNull();

    // And back — the structure/box follows the geometry, it is not cached stale.
    for (let i = 0; i < moved.length; i += 3) moved[i] -= 40;
    geometry.setAttribute('position', new BufferAttribute(moved.slice(), 3));
    expect(hover()).toBe(keepMesh);
  });
});

describe('PickBackend — resolveHit contract', () => {
  it('a mesh the registry does not own resolves to null, never to BLOCKED', async () => {
    const root = group('Asset');
    root.add(uberMesh(uber, 'frame'));
    const { bakeRegistry } = await place(root);
    const backend = new PickBackend(bakeRegistry);
    expect(backend.resolvePath()).toBeNull();
    expect(backend.resolveHit({ object: new Mesh() })).toBeNull();
    expect(backend.resolveHit({ object: new Mesh() })).not.toBe(RAYCAST_BLOCKED);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-756 §9.3 / §9.4a — the `.raycast` INSTANCE override (F4).
 *
 * A stray `THREE.Raycaster` — measurement, annotation, the MCP surface verbs,
 * the signal-bind drop overlay — must get the fast path without knowing anything
 * about the bake:
 *
 *  - `intersectObjects(scene.children, true)` returns `distance` / `point` /
 *    `face.normal` / `object` equal to a brute-force oracle over the same
 *    geometry;
 *  - `near` / `far` are honoured in WORLD distance, and `firstHitOnly` is
 *    satisfied by construction (one hit per mesh at most);
 *  - `faceIndex` indexes the PERMUTED `geometry.index` — the three vertices read
 *    through it contain the hit point (§2.4a.11);
 *  - `Mesh.prototype.raycast` is NOT touched (R6), and a collision tick on a
 *    chunk builds no tree and changes no pick result (§2.4a.10, plan-781);
 *  - keep meshes answer through the override too, with the AUTHORED index order.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Mesh, Raycaster, Scene, Vector3, type BufferAttribute, type Intersection, type Object3D } from 'three';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { RVCollisionManager } from '../src/core/engine/rv-collision-manager';
import '../src/core/engine/rv-scene-loader';
import { registerCapabilities, registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { hasPickRaycast } from '../src/core/engine/rv-pick-backend';
import { raycastRangeBruteForce } from '../src/core/engine/rv-pick-structure';
import { bakeAndPlace, group, uberMesh, withComponent } from './fixtures/bake-fixture';

registerComponentSchema('TestPickOv', {}, { pick: 'select' });
registerCapabilities('TestKeepOv', { pick: 'select', bake: 'keep' });

const uber = new RVUberMaterial(false);

/**
 * `Asset { Part{TestPickOv}: box@z=0, Far{TestPickOv}: box@z=-6, Keeper{keep}: box@x=8 }`
 * — one static chunk plus one keep mesh, all on the -Z ray from z = +10.
 */
function makeAsset() {
  const root = group('Asset');
  const part = withComponent(group('Part'), 'TestPickOv');
  part.add(uberMesh(uber, 'partMesh', [0, 0, 0]));
  const far = withComponent(group('Far'), 'TestPickOv');
  far.add(uberMesh(uber, 'farMesh', [0, 0, -6]));
  const keeper = withComponent(uberMesh(uber, 'Keeper', [8, 0, 0]), 'TestKeepOv');
  root.add(part, far, keeper);
  return root;
}

/** Nearest hit over the WHOLE geometry, computed independently of the structure. */
function bruteOracle(mesh: Mesh, origin: Vector3, dir: Vector3): { distance: number; triangle: number } | null {
  const geometry = mesh.geometry;
  const position = (geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
  const index = geometry.getIndex()!.array as Uint32Array;
  const inv = mesh.matrixWorld.clone().invert();
  const o = origin.clone().applyMatrix4(inv);
  const d = dir.clone().transformDirection(inv);
  const hit = raycastRangeBruteForce(position, index, 0, index.length, o.x, o.y, o.z, d.x, d.y, d.z);
  if (!hit) return null;
  const local = d.clone().multiplyScalar(hit.distance).add(o).applyMatrix4(mesh.matrixWorld);
  return { distance: origin.distanceTo(local), triangle: hit.triangle };
}

describe('.raycast instance override (plan-756 F4)', () => {
  let scene: Scene;
  let chunkMesh: Mesh;
  let keepMesh: Mesh;
  let placed: Awaited<ReturnType<typeof bakeAndPlace>>;
  let bakeRegistry: BakeRegistry;

  beforeAll(async () => {
    scene = new Scene();
    bakeRegistry = new BakeRegistry();
    placed = await bakeAndPlace(makeAsset(), bakeRegistry, { uber });
    scene.add(placed.template);
    scene.updateMatrixWorld(true);
    chunkMesh = placed.instance.chunks[0];
    keepMesh = placed.instance.keep[0];
  });

  it('chunk and keep meshes carry the override; the PROTOTYPE is untouched', () => {
    expect(hasPickRaycast(chunkMesh)).toBe(true);
    expect(hasPickRaycast(keepMesh)).toBe(true);
    // The template mesh got it at bake time, before any placement existed.
    expect(hasPickRaycast(placed.baked.chunks[0].templateMesh!)).toBe(true);
    // R6: the PROTOTYPE is never ours. Whatever is installed there (three's own
    // `raycast`, or `acceleratedRaycast` once three-mesh-bvh patched it) keeps
    // serving every non-baked mesh — an instance property only SHADOWS it.
    expect(hasPickRaycast(new Mesh())).toBe(false);
    expect(Mesh.prototype.raycast).not.toBe(chunkMesh.raycast);
    // Patching the prototype afterwards must not take the chunk meshes over.
    const original = Mesh.prototype.raycast;
    Mesh.prototype.raycast = acceleratedRaycast;
    try {
      expect(hasPickRaycast(chunkMesh)).toBe(true);
      expect(hasPickRaycast(keepMesh)).toBe(true);
    } finally {
      Mesh.prototype.raycast = original;
    }
  });

  it('a plain intersectObjects agrees with the brute-force oracle', () => {
    const origin = new Vector3(0, 0, 10);
    const dir = new Vector3(0, 0, -1);
    const raycaster = new Raycaster(origin.clone(), dir.clone());
    const hits = raycaster.intersectObjects(scene.children, true);
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0];
    expect(hit.object).toBe(chunkMesh);

    const oracle = bruteOracle(chunkMesh, origin, dir)!;
    expect(oracle).toBeTruthy();
    expect(hit.distance).toBeCloseTo(oracle.distance, 5);
    // Front face of the box at z = 0 → the hit point sits on z = +0.5 and the
    // local normal points back along +Z.
    expect(hit.point.z).toBeCloseTo(0.5, 5);
    expect(hit.face!.normal.z).toBeCloseTo(1, 5);
    expect(hit.faceIndex).toBe(oracle.triangle);
  });

  it('faceIndex indexes the PERMUTED geometry.index — its vertices contain the hit point', () => {
    const raycaster = new Raycaster(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
    const hits: Intersection<Object3D>[] = [];
    chunkMesh.raycast(raycaster, hits);
    expect(hits).toHaveLength(1);
    const { faceIndex, face, point } = hits[0];
    const index = chunkMesh.geometry.getIndex()!;
    // The reported face vertices ARE the ones the final index names.
    expect(face!.a).toBe(index.getX(faceIndex! * 3));
    expect(face!.b).toBe(index.getX(faceIndex! * 3 + 1));
    expect(face!.c).toBe(index.getX(faceIndex! * 3 + 2));
    // …and the triangle they span contains the hit point (z = +0.5 plane).
    const position = chunkMesh.geometry.getAttribute('position') as BufferAttribute;
    for (const v of [face!.a, face!.b, face!.c]) {
      expect(position.getZ(v)).toBeCloseTo(point.z, 5);
    }
  });

  it('honours near and far in world distance, and returns at most one hit per mesh', () => {
    const raycaster = new Raycaster(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
    (raycaster as unknown as { firstHitOnly?: boolean }).firstHitOnly = true;
    const all: Intersection<Object3D>[] = [];
    chunkMesh.raycast(raycaster, all);
    expect(all).toHaveLength(1);
    const d = all[0].distance;

    // far just short of the hit → nothing.
    raycaster.far = d - 0.01;
    const tooNear: Intersection<Object3D>[] = [];
    chunkMesh.raycast(raycaster, tooNear);
    expect(tooNear).toHaveLength(0);

    // near past the FIRST surface → the traversal still answers the nearest
    // triangle, which is now outside [near, far] → nothing.
    raycaster.far = Infinity;
    raycaster.near = d + 0.01;
    const tooFar: Intersection<Object3D>[] = [];
    chunkMesh.raycast(raycaster, tooFar);
    expect(tooFar).toHaveLength(0);

    raycaster.near = 0;
  });

  it('a keep mesh answers through the override, with the AUTHORED index order', () => {
    const before = (keepMesh.geometry.getIndex()!.array as Uint32Array).slice();
    const origin = new Vector3(8, 0, 10);
    const dir = new Vector3(0, 0, -1);
    const raycaster = new Raycaster(origin.clone(), dir.clone());
    const hits: Intersection<Object3D>[] = [];
    keepMesh.raycast(raycaster, hits);
    expect(hits).toHaveLength(1);
    const oracle = bruteOracle(keepMesh, origin, dir)!;
    expect(hits[0].distance).toBeCloseTo(oracle.distance, 5);
    expect(hits[0].faceIndex).toBe(oracle.triangle);
    // THE keep-mesh contract: nothing permuted the authored index (GLB export,
    // material groups and `drawRange` address it).
    expect([...(keepMesh.geometry.getIndex()!.array as Uint32Array)]).toEqual([...before]);
  });

  it('a collision tick on the chunk builds no tree and changes no pick result (plan-781, §2.4a.10)', () => {
    const raycaster = new Raycaster(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
    const before: Intersection<Object3D>[] = [];
    chunkMesh.raycast(raycaster, before);
    const indexBefore = (chunkMesh.geometry.getIndex()!.array as Uint32Array).slice();

    // Collision READS the pick structure (rule 15 as ruled 2026-11-05): a body
    // over a chunk segment range, a full tick with motion — and no tree, no
    // index rewrite on the shared geometry.
    const manager = new RVCollisionManager();
    manager.setGeometrySource(bakeRegistry);
    manager.register(placed.node('Part'), 'Machine');
    manager.register(placed.node('Far'), 'Robot');
    manager.update(1 / 60);
    placed.node('Far').position.z += 0.5;
    manager.update(1 / 60);
    expect(manager.bodies.every((b) => b.parts.length > 0)).toBe(true);
    expect((chunkMesh.geometry as unknown as { boundsTree?: unknown }).boundsTree).toBeUndefined();
    expect([...(chunkMesh.geometry.getIndex()!.array as Uint32Array)]).toEqual([...indexBefore]);
    const after: Intersection<Object3D>[] = [];
    chunkMesh.raycast(raycaster, after);
    expect(after).toHaveLength(before.length);
    expect(after[0].faceIndex).toBe(before[0].faceIndex);
    expect(after[0].distance).toBeCloseTo(before[0].distance, 10);
    manager.dispose();
  });
});

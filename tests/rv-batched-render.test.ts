// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-batched-render.test.ts — motion-blob BatchedMesh arena builders +
 * per-instance visibility.
 *
 * Covers:
 *   - buildBatchedScene static blob: N uber meshes → ONE arena, unique-
 *     geometry dedup, source contract (visible=true, layers.mask=0, tags),
 *     arena flags, world-space instance placement
 *   - kinematic blobs: dynamic meshes under a Drive → arena parented UNDER
 *     the drive node (moves via parent propagation), nested-drive boundaries
 *   - textured groups per (material × signature), transparent batches with
 *     sortObjects, lone meshes stay individual
 *   - exclusions: TransportSurface/Source subtrees, Pipe/Tank meshes,
 *     sensor viz, multi-material
 *   - canonicalizeForArena: passthrough, uv stripping, defaults, missing
 *     normals, ramp index
 *   - applyUberMaterial clone cache
 *   - BatchVisibilityService reconcile + snapshot/restore
 *   - BatchTable.dispose reverts the source contract
 *   - renderer-level draw-call collapse
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import { RVUberMaterial, bakeMaterialToAttributes, applyUberMaterial } from '../src/core/engine/rv-uber-material';
import { buildBatchedScene } from '../src/core/engine/rv-batched-render';
import { BatchTable } from '../src/core/engine/rv-batch-table';
import { BatchVisibilityService } from '../src/core/engine/rv-batch-visibility';
import { canonicalizeForArena, flipWinding, UBER_ARENA_LAYOUT } from '../src/core/engine/rv-mesh-merge-batch';
import { AdvancedArenaPlanner, arenaPlannerRegistry } from '../src/core/engine/rv-arena-planner';

beforeAll(() => arenaPlannerRegistry.register(new AdvancedArenaPlanner()));
afterAll(() => arenaPlannerRegistry.register(null));

// ─── Helpers ────────────────────────────────────────────────────────────

const NO_DRIVES: ReadonlySet<Object3D> = new Set();

function makeUberMesh(
  sharedUber: RVUberMaterial,
  name: string,
  pos: [number, number, number],
  opts?: { dynamic?: boolean; geometry?: BufferGeometry },
): Mesh {
  const mesh = new Mesh(
    opts?.geometry ?? new BoxGeometry(1, 1, 1),
    new MeshStandardMaterial({ color: 0x808080, roughness: 0.5 }),
  );
  mesh.name = name;
  mesh.position.set(...pos);
  bakeMaterialToAttributes(mesh, sharedUber, mesh.material as MeshStandardMaterial, { shareGeometry: false });
  mesh.matrixAutoUpdate = opts?.dynamic ?? false ? true : false;
  mesh.updateMatrix();
  return mesh;
}

function makeTexturedStatic(name: string, mat: MeshStandardMaterial, pos: [number, number, number]): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), mat);
  mesh.name = name;
  mesh.position.set(...pos);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

function makeScene(): { root: Group; sharedUber: RVUberMaterial } {
  const root = new Group();
  root.name = 'Model';
  return { root, sharedUber: new RVUberMaterial(false) };
}

const isBatched = (o: Object3D): boolean =>
  (o as unknown as { isBatchedMesh?: boolean }).isBatchedMesh === true;

// ─── Static blob ────────────────────────────────────────────────────────

describe('buildBatchedScene — static blob', () => {
  it('collapses N static uber meshes into one arena with geometry dedup', async () => {
    const { root, sharedUber } = makeScene();
    const shared = new BoxGeometry(1, 1, 1);
    const meshes: Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const m = new Mesh(shared, new MeshStandardMaterial({ color: 0x808080 }));
      if (i === 0) bakeMaterialToAttributes(m, sharedUber, m.material as MeshStandardMaterial, { shareGeometry: true });
      else { m.material = sharedUber; m.userData._rvUberBaked = true; }
      m.name = `S${i}`;
      m.position.set(i * 3, 0, 0);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      meshes.push(m);
      root.add(m);
    }
    root.add(makeUberMesh(sharedUber, 'Solo', [0, 5, 0]));
    root.updateMatrixWorld(true);

    const table = new BatchTable();
    const result = await buildBatchedScene(root, sharedUber, NO_DRIVES, table);

    expect(result.staticUber.instanceCount).toBe(4);
    expect(result.staticUber.batchCount).toBe(1);
    expect(result.staticUber.uniqueGeometryCount).toBe(2); // shared box + solo box
    expect(result.kinematic.batchCount).toBe(0);

    const batch = table.batches[0];
    expect(batch.parent).toBe(root);
    expect(batch.castShadow).toBe(true);
    expect(batch.userData._rvSkipBVH).toBe(true);
    expect(batch.userData._rvBatchedRender).toBe(true);

    for (const m of [...meshes, root.getObjectByName('Solo') as Mesh]) {
      expect(m.visible).toBe(true);
      expect(m.layers.mask).toBe(0);
      expect(m.userData._rvBatchSource).toBe(true);
      const ref = table.refFor(m);
      expect(ref?.batch).toBe(batch);
      expect(batch.getVisibleAt(ref!.instanceId)).toBe(true);
    }

    const bounds = table.computeVisibleBounds(new Box3());
    expect(bounds.max.x).toBeGreaterThanOrEqual(6.4);
    expect(bounds.max.y).toBeGreaterThanOrEqual(5.4);
    expect(bounds.min.x).toBeLessThanOrEqual(-0.4);
  });

  it('skips hidden and multi-material meshes, dynamics without a drive anchor', async () => {
    const { root, sharedUber } = makeScene();
    const stat = makeUberMesh(sharedUber, 'stat', [0, 0, 0]);
    const stat2 = makeUberMesh(sharedUber, 'stat2', [1, 0, 0]);
    const dyn = makeUberMesh(sharedUber, 'dyn', [2, 0, 0], { dynamic: true }); // dynamic, NOT under a drive
    const hidden = makeUberMesh(sharedUber, 'hidden', [3, 0, 0]);
    hidden.visible = false;
    const multi = new Mesh(new BoxGeometry(), [new MeshStandardMaterial(), new MeshStandardMaterial()]);
    multi.matrixAutoUpdate = false;
    root.add(stat, stat2, dyn, hidden, multi);
    root.updateMatrixWorld(true);

    const table = new BatchTable();
    const result = await buildBatchedScene(root, sharedUber, NO_DRIVES, table);
    expect(result.staticUber.instanceCount).toBe(2);
    for (const m of [dyn, hidden, multi]) expect(m.layers.mask).not.toBe(0);
  });

  it('dispose() reverts the source contract', async () => {
    const { root, sharedUber } = makeScene();
    const a = makeUberMesh(sharedUber, 'a', [0, 0, 0]);
    const b = makeUberMesh(sharedUber, 'b', [1, 0, 0]);
    root.add(a, b);
    root.updateMatrixWorld(true);

    const table = new BatchTable();
    await buildBatchedScene(root, sharedUber, NO_DRIVES, table);
    expect(root.children.some(isBatched)).toBe(true);

    table.dispose();
    expect(root.children.some(isBatched)).toBe(false);
    for (const m of [a, b]) {
      expect(m.layers.mask).toBe(1);
      expect(m.userData._rvBatchSource).toBeUndefined();
      expect(m.userData._rvBatchInstance).toBeUndefined();
    }
  });
});

// ─── Kinematic blobs ────────────────────────────────────────────────────

describe('buildBatchedScene — kinematic blobs', () => {
  it('parents a drive blob arena under the drive node; nested drives split', async () => {
    const { root, sharedUber } = makeScene();

    const drive = new Object3D();
    drive.name = 'Axis1';
    drive.position.set(0, 0, 5);
    for (let i = 0; i < 3; i++) {
      drive.add(makeUberMesh(sharedUber, `P${i}`, [i, 0, 0], { dynamic: true }));
    }
    // Nested child drive with its own pair.
    const child = new Object3D();
    child.name = 'Axis2';
    child.position.set(0, 1, 0);
    child.add(makeUberMesh(sharedUber, 'C0', [0, 0, 0], { dynamic: true }));
    child.add(makeUberMesh(sharedUber, 'C1', [1, 0, 0], { dynamic: true }));
    drive.add(child);
    root.add(drive);
    // Static pair so the static blob exists too.
    root.add(makeUberMesh(sharedUber, 'S0', [0, 0, 0]), makeUberMesh(sharedUber, 'S1', [1, 0, 0]));
    root.updateMatrixWorld(true);

    const driveNodeSet = new Set<Object3D>([drive, child]);
    const table = new BatchTable();
    const result = await buildBatchedScene(root, sharedUber, driveNodeSet, table);

    expect(result.staticUber.instanceCount).toBe(2);
    expect(result.kinematic.instanceCount).toBe(5);
    expect(result.kinematic.batchCount).toBe(2);   // one arena per drive blob
    expect(result.kinematic.driveGroups).toBe(2);

    const arenaOf = (node: Object3D): Object3D | undefined => node.children.find(isBatched);
    const driveArena = arenaOf(drive)!;
    const childArena = arenaOf(child)!;
    expect(driveArena).toBeTruthy();
    expect(childArena).toBeTruthy();

    // Drive motion moves the arena via parent propagation — no matrix pushes.
    drive.position.x += 2;
    root.updateMatrixWorld(true);
    expect(driveArena.matrixWorld.elements[12]).toBeCloseTo(2, 5);
  });

  it('excludes TransportSurface/Source subtrees and Pipe/Tank meshes', async () => {
    const { root, sharedUber } = makeScene();

    const ts = new Object3D();
    ts.userData.realvirtual = { TransportSurface: {} };
    const belt1 = makeTexturedStatic('belt1', new MeshStandardMaterial(), [0, 0, 0]);
    const belt2 = makeTexturedStatic('belt2', belt1.material as MeshStandardMaterial, [1, 0, 0]);
    ts.add(belt1, belt2);

    const source = new Object3D();
    source.userData.realvirtual = { Source: {} };
    source.add(makeUberMesh(sharedUber, 'template', [0, 0, 0]));

    const pipe = makeTexturedStatic('pipe', new MeshStandardMaterial(), [2, 0, 0]);
    pipe.userData._rvType = 'Pipe';
    const pipe2 = makeTexturedStatic('pipe2', pipe.material as MeshStandardMaterial, [3, 0, 0]);
    pipe2.userData._rvType = 'Pipe';

    root.add(ts, source, pipe, pipe2);
    root.updateMatrixWorld(true);

    const table = new BatchTable();
    const result = await buildBatchedScene(root, sharedUber, NO_DRIVES, table);
    expect(result.staticUber.instanceCount).toBe(0);
    expect(result.staticTextured.instanceCount).toBe(0);
    expect(table.batches.length).toBe(0);
  });
});

// ─── Textured groups ────────────────────────────────────────────────────

describe('buildBatchedScene — textured groups', () => {
  it('batches per material; transparent groups keep sortObjects; lone meshes stay individual', async () => {
    const { root } = makeScene();
    const matA = new MeshStandardMaterial({ color: 0x123456 });
    const matT = new MeshStandardMaterial({ color: 0x654321, transparent: true, opacity: 0.5 });
    const matLone = new MeshStandardMaterial({ color: 0xffffff });
    for (let i = 0; i < 3; i++) root.add(makeTexturedStatic(`A${i}`, matA, [i * 2, 0, 0]));
    for (let i = 0; i < 2; i++) root.add(makeTexturedStatic(`T${i}`, matT, [i * 2, 2, 0]));
    const lone = makeTexturedStatic('lone', matLone, [0, 4, 0]);
    root.add(lone);
    root.updateMatrixWorld(true);

    const table = new BatchTable();
    const result = await buildBatchedScene(root, null, NO_DRIVES, table);

    expect(result.staticTextured.batchCount).toBe(2);
    expect(result.staticTextured.instanceCount).toBe(5);
    expect(result.staticTextured.skippedCount).toBe(1);
    expect(lone.layers.mask).not.toBe(0);

    const opaque = table.batches.find((b) => b.material === matA)!;
    const transparent = table.batches.find((b) => b.material === matT)!;
    expect(opaque.sortObjects).toBe(false);
    expect(transparent.sortObjects).toBe(true);
  });
});

// ─── canonicalizeForArena ───────────────────────────────────────────────

describe('canonicalizeForArena', () => {
  it('returns the source geometry unchanged when already canonical', () => {
    const sharedUber = new RVUberMaterial(false);
    const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    bakeMaterialToAttributes(m, sharedUber, m.material as MeshStandardMaterial, { shareGeometry: true });
    const g = m.geometry;
    g.deleteAttribute('uv');
    expect(canonicalizeForArena(g, UBER_ARENA_LAYOUT)).toBe(g);
  });

  it('strips extra attributes, keeps index, fills color/rm defaults', () => {
    const g = new BoxGeometry(1, 1, 1); // position + normal + uv, indexed
    const out = canonicalizeForArena(g, UBER_ARENA_LAYOUT);
    expect(out).not.toBe(g);
    expect(out.getAttribute('uv')).toBeUndefined();
    expect(out.index).not.toBeNull();
    expect(out.index!.count).toBe(g.index!.count);
    const color = out.getAttribute('color');
    expect(color.itemSize).toBe(3);
    expect((color as BufferAttribute).normalized).toBe(true);
    expect(color.getX(0)).toBeCloseTo(1, 2);
    const rm = out.getAttribute('rmPacked');
    expect(rm.getX(0)).toBeCloseTo(1, 2);
    expect(rm.getY(0)).toBeCloseTo(0, 2);
  });

  it('synthesizes a ramp index for non-indexed sources and computes missing normals', () => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    const out = canonicalizeForArena(g, UBER_ARENA_LAYOUT);
    expect(out.index).not.toBeNull();
    expect(Array.from(out.index!.array as Uint32Array)).toEqual([0, 1, 2]);
    expect(out.getAttribute('normal').getZ(0)).toBeCloseTo(1, 5);
  });
});

// ─── applyUberMaterial clone cache ──────────────────────────────────────

describe('flipWinding', () => {
  it('reverses triangle winding, shares attributes, never mutates the source', () => {
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(new Float32Array(18), 3));
    geom.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 3, 4, 5]), 1));
    const flipped = flipWinding(geom);
    expect(Array.from(flipped.index!.array)).toEqual([0, 2, 1, 3, 5, 4]);
    expect(Array.from(geom.index!.array)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(flipped.getAttribute('position')).toBe(geom.getAttribute('position'));
  });

  it('synthesizes a flipped ramp for non-indexed sources', () => {
    const geom = new BufferGeometry();
    geom.setAttribute('position', new BufferAttribute(new Float32Array(18), 3)); // 6 verts
    const flipped = flipWinding(geom);
    expect(Array.from(flipped.index!.array)).toEqual([0, 2, 1, 3, 5, 4]);
  });
});

describe('buildBatchedScene — mirrored instances', () => {
  it('gives negative-determinant instances a winding-flipped geometry slot', async () => {
    // A mirrored (scale z = -1) instance cannot share the regular index: the
    // GL front-face is per draw call, so it would render inside-out (visible
    // back faces → wrong culling + inward normals in the GTAO/toon gbuffers).
    const { root, sharedUber } = makeScene();
    const shared = new BoxGeometry(1, 1, 1);
    const plain = new Mesh(shared, new MeshStandardMaterial({ color: 0x808080 }));
    bakeMaterialToAttributes(plain, sharedUber, plain.material as MeshStandardMaterial, { shareGeometry: true });
    plain.name = 'Plain';
    const mirroredMesh = new Mesh(shared, sharedUber);
    mirroredMesh.userData._rvUberBaked = true;
    mirroredMesh.name = 'Mirrored';
    mirroredMesh.scale.set(1, 1, -1);
    for (const m of [plain, mirroredMesh]) {
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      root.add(m);
    }
    root.updateMatrixWorld(true);

    const table = new BatchTable();
    const result = await buildBatchedScene(root, sharedUber, NO_DRIVES, table);

    // Same source geometry, but the mirror parity forces a second slot.
    expect(result.staticUber.instanceCount).toBe(2);
    expect(result.staticUber.batchCount).toBe(1);
    expect(result.staticUber.uniqueGeometryCount).toBe(2);

    // The two staged ranges differ exactly by triangle winding (second range
    // is vertex-offset by the first geometry's 24 box vertices).
    const batch = table.batches[0];
    const idx = batch.geometry.index!;
    const srcIndexCount = shared.index!.count; // 36
    const vertexOffset = 24;
    for (let i = 0; i < srcIndexCount; i += 3) {
      const a = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
      const b = [
        idx.getX(srcIndexCount + i),
        idx.getX(srcIndexCount + i + 1),
        idx.getX(srcIndexCount + i + 2),
      ];
      expect(b[0] - vertexOffset).toBe(a[0]);
      expect(b[1] - vertexOffset).toBe(a[2]);
      expect(b[2] - vertexOffset).toBe(a[1]);
    }
  });
});

describe('applyUberMaterial clone cache', () => {
  it('shares one baked clone per (geometry, material) pair', () => {
    const root = new Group();
    const shared = new BoxGeometry(1, 1, 1);
    const matA = new MeshStandardMaterial({ color: 0xff0000, roughness: 0.2 });
    const matB = new MeshStandardMaterial({ color: 0x00ff00, roughness: 0.8 });
    const meshes = [matA, matA, matB, matB].map((mat, i) => {
      const m = new Mesh(shared, mat);
      m.name = `C${i}`;
      root.add(m);
      return m;
    });

    const mats = new Set<import('three').Material>([matA, matB]);
    const result = applyUberMaterial(root, mats, false);

    expect(result.bakedMeshCount).toBe(4);
    expect(result.clonedGeometryCount).toBe(2);
    expect(result.sharedGeometryReuses).toBe(2);
    expect(meshes[0].geometry).toBe(meshes[1].geometry);
    expect(meshes[2].geometry).toBe(meshes[3].geometry);
    expect(meshes[0].geometry).not.toBe(meshes[2].geometry);
  });
});

// ─── BatchVisibilityService ─────────────────────────────────────────────

describe('BatchVisibilityService', () => {
  async function build(): Promise<{
    root: Group; groupA: Object3D; m1: Mesh; m2: Mesh; m3: Mesh;
    table: BatchTable; service: BatchVisibilityService;
  }> {
    const { root, sharedUber } = makeScene();
    const groupA = new Object3D();
    groupA.name = 'GroupA';
    const m1 = makeUberMesh(sharedUber, 'm1', [0, 0, 0]);
    const m2 = makeUberMesh(sharedUber, 'm2', [2, 0, 0]);
    groupA.add(m1, m2);
    const m3 = makeUberMesh(sharedUber, 'm3', [4, 0, 0]);
    root.add(groupA, m3);
    root.updateMatrixWorld(true);
    const table = new BatchTable();
    await buildBatchedScene(root, sharedUber, NO_DRIVES, table);
    const service = new BatchVisibilityService(root, table);
    service.reconcile();
    return { root, groupA, m1, m2, m3, table, service };
  }

  const visibleOf = (table: BatchTable, m: Mesh): boolean => {
    const ref = table.refFor(m)!;
    return ref.batch.getVisibleAt(ref.instanceId);
  };

  it('mirrors ancestor and own visibility into instances', async () => {
    const { groupA, m1, m2, m3, table, service } = await build();

    groupA.visible = false;
    service.markDirty();
    expect(service.reconcile()).toBe(2);
    expect(visibleOf(table, m1)).toBe(false);
    expect(visibleOf(table, m2)).toBe(false);
    expect(visibleOf(table, m3)).toBe(true);

    groupA.visible = true;
    m2.visible = false;
    service.markDirty();
    expect(service.reconcile()).toBe(1);
    expect(visibleOf(table, m1)).toBe(true);
    expect(visibleOf(table, m2)).toBe(false);
  });

  it('reconcile is a no-op when clean; forceReconcile catches unnotified mutations', async () => {
    const { m3, table, service } = await build();
    expect(service.reconcile()).toBe(0);

    m3.visible = false;
    expect(service.reconcile()).toBe(0);
    expect(visibleOf(table, m3)).toBe(true);
    expect(service.forceReconcile()).toBe(1);
    expect(visibleOf(table, m3)).toBe(false);
  });

  it('snapshot/restore round-trips exactly (isolate pass-3 pattern)', async () => {
    const { m1, m2, m3, table, service } = await build();
    m2.visible = false;
    service.markDirty();
    service.reconcile();

    const snap = table.snapshotVisibility();
    for (const m of [m2, m3]) {
      const ref = table.refFor(m)!;
      ref.batch.setVisibleAt(ref.instanceId, false);
    }
    expect(visibleOf(table, m1)).toBe(true);
    expect(visibleOf(table, m3)).toBe(false);

    table.restoreVisibility(snap);
    expect(visibleOf(table, m1)).toBe(true);
    expect(visibleOf(table, m2)).toBe(false);
    expect(visibleOf(table, m3)).toBe(true);
  });
});

// ─── Draw-call collapse (renderer-level sanity) ─────────────────────────

describe('BatchedMesh draw-call collapse', () => {
  it('one arena renders as one (or few) draw calls', async () => {
    const { WebGLRenderer, Scene, PerspectiveCamera } = await import('three');
    let renderer: InstanceType<typeof WebGLRenderer>;
    try {
      renderer = new WebGLRenderer();
    } catch {
      return; // no GL context available — skip silently
    }
    try {
      const scene = new Scene();
      const { root, sharedUber } = makeScene();
      for (let i = 0; i < 20; i++) root.add(makeUberMesh(sharedUber, `M${i}`, [i, 0, 0]));
      root.updateMatrixWorld(true);
      scene.add(root);
      const table = new BatchTable();
      await buildBatchedScene(root, sharedUber, NO_DRIVES, table);

      const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
      camera.position.set(10, 10, 40);
      camera.lookAt(10, 0, 0);
      renderer.setSize(64, 64);
      renderer.render(scene, camera);

      expect(renderer.info.render.calls).toBeLessThanOrEqual(2);
      expect(table.batches[0].instanceCount).toBe(20);
    } finally {
      renderer.dispose();
    }
  });
});

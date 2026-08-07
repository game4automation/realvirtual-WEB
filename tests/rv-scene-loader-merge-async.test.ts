// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-loader-merge-async.test.ts — loader integration of the async
 * BatchedMesh batching phase (10c/10d, motion-blob model).
 *
 * Uses a REAL loadGLB() run over a synthetic GLB (objectToGlb) with the
 * `onArenaBuild` probe (each arena build yields a macrotask right after the
 * probe — a deterministic interleave/abort window):
 *   - statics → one static uber arena; dynamics under the Drive → one
 *     kinematic uber arena parented under the drive node
 *   - clearModel/new-load during in-flight batching → LoadAbortedError,
 *     arenas disposed, root removed from the scene (B3/F7)
 *   - second load during batching discards stale first-load results
 *   - preserveHierarchy=true → no arena is ever built (editor invariant)
 *   - root stays invisible from phase 10c until 10e completed (N5)
 *   - LoadResult.mergeMs is filled (F5)
 */

import { afterAll, describe, it, expect, beforeAll } from 'vitest';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Scene,
} from 'three';
import { loadGLB, LoadAbortedError } from '../src/core/engine/rv-scene-loader';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { AdvancedArenaPlanner, arenaPlannerRegistry } from '../src/core/engine/rv-arena-planner';

// ─── Synthetic GLB fixture ──────────────────────────────────────────────

let glbBytes: ArrayBuffer;

beforeAll(async () => {
  arenaPlannerRegistry.register(new AdvancedArenaPlanner());
  const root = new Group();
  root.name = 'TestCell';

  // 3 untextured static boxes → uber bake + static blob.
  for (let i = 0; i < 3; i++) {
    const mesh = new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ color: [0xff0000, 0x00ff00, 0x0000ff][i], roughness: 0.5 }),
    );
    mesh.name = `Static${i}`;
    mesh.position.set(i * 3, 0, 0);
    root.add(mesh);
  }

  // One Drive with 3 dynamic boxes → kinematic blob (uber arena under the drive).
  const drive = new Object3D();
  drive.name = 'Axis1';
  drive.position.set(0, 0, 5);
  drive.userData.realvirtual = { Drive: { Direction: 'X', Speed: 100 } };
  for (let i = 0; i < 3; i++) {
    const mesh = new Mesh(
      new BoxGeometry(0.5, 0.5, 0.5),
      new MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.4 }),
    );
    mesh.name = `Part${i}`;
    mesh.position.set(i, 0, 0);
    drive.add(mesh);
  }
  root.add(drive);

  glbBytes = await objectToGlb(root);
});

afterAll(() => arenaPlannerRegistry.register(null));

const GLB_URL = 'memory://merge-async-test.glb';

// ─── Tests ──────────────────────────────────────────────────────────────

describe('loadGLB batching phase (async)', () => {
  it('builds static + kinematic arenas and fills LoadResult.mergeMs (F5)', async () => {
    const scene = new Scene();
    let arenaBuilds = 0;
    const result = await loadGLB(GLB_URL, scene, {
      data: glbBytes.slice(0),
      onArenaBuild: () => { arenaBuilds++; },
    });

    // Static blob: 3 boxes → 1 uber arena. Drive blob: 3 dynamic boxes →
    // 1 uber arena PARENTED UNDER the drive node.
    expect(result.uberBatchResult?.instanceCount).toBe(3);
    expect(result.uberBatchResult?.batchCount).toBe(1);
    expect(result.kinBatchResult?.instanceCount).toBe(3);
    expect(result.kinBatchResult?.batchCount).toBe(1);
    expect(result.kinBatchResult?.driveGroups).toBe(1);
    expect(arenaBuilds).toBe(2);

    const driveNode = result.root.getObjectByName('Axis1')!;
    const driveArena = driveNode.children.find(
      (c) => (c as unknown as { isBatchedMesh?: boolean }).isBatchedMesh,
    );
    expect(driveArena).toBeTruthy();

    // Source-mesh contract: batched sources stay visible but layer-masked out.
    let batchSources = 0;
    result.root.traverse((n) => {
      if (n.userData?._rvBatchSource) {
        batchSources++;
        expect((n as { visible: boolean }).visible).toBe(true);
        expect((n as { layers: { mask: number } }).layers.mask).toBe(0);
        expect(n.userData._rvBatchInstance).toBeTruthy();
      }
    });
    expect(batchSources).toBe(6);

    expect(typeof result.mergeMs).toBe('number');
    expect(result.mergeMs!).toBeGreaterThanOrEqual(0);
  });

  it('keeps the root invisible while arenas build, visible after 10e (N5)', async () => {
    const scene = new Scene();
    const rootVisibleDuringBuild: boolean[] = [];
    const result = await loadGLB(GLB_URL, scene, {
      data: glbBytes.slice(0),
      onArenaBuild: () => {
        const root = scene.children[0];
        rootVisibleDuringBuild.push(root?.visible ?? true);
      },
    });

    expect(rootVisibleDuringBuild.length).toBeGreaterThan(0);
    expect(rootVisibleDuringBuild.every((v) => v === false)).toBe(true);
    expect(result.root.visible).toBe(true);
  });

  it('clearModel during in-flight batching discards results and disposes arenas (B3/F7)', async () => {
    const scene = new Scene();
    // Generation harness — mirrors RVViewer.loadModel/clearModel wiring.
    // The generation bump fires from INSIDE the first arena's probe; the
    // builder yields a macrotask right after, then sees shouldAbort()=true.
    let generation = 1;
    const loadGen = generation;
    const loadPromise = loadGLB(GLB_URL, scene, {
      data: glbBytes.slice(0),
      shouldAbort: () => generation !== loadGen,
      onArenaBuild: () => { generation++; },
    });

    await expect(loadPromise).rejects.toBeInstanceOf(LoadAbortedError);
    // The aborted load tore itself down: no model root, no arenas.
    expect(scene.children.length).toBe(0);
  });

  it('second load during batching discards stale first-load results', async () => {
    const scene = new Scene();
    let generation = 1;

    const firstGen = generation;
    let secondLoad: Promise<Awaited<ReturnType<typeof loadGLB>>> | null = null;
    const firstLoad = loadGLB(GLB_URL, scene, {
      data: glbBytes.slice(0),
      shouldAbort: () => generation !== firstGen,
      onArenaBuild: () => {
        if (secondLoad) return;
        // Supersede the first load from inside its first arena build.
        generation++;
        const secondGen = generation;
        secondLoad = loadGLB(GLB_URL, scene, {
          data: glbBytes.slice(0),
          shouldAbort: () => generation !== secondGen,
        });
      },
    });

    await expect(firstLoad).rejects.toBeInstanceOf(LoadAbortedError);
    const second = await secondLoad!;

    // Only the second load's root remains in the scene.
    expect(scene.children).toContain(second.root);
    expect(scene.children.length).toBe(1);
    expect(second.root.visible).toBe(true);
    expect(second.uberBatchResult?.instanceCount).toBeGreaterThan(0);
  });

  it('builds no arenas when preserveHierarchy=true (editor invariant)', async () => {
    const scene = new Scene();
    let arenaBuilds = 0;
    const result = await loadGLB(GLB_URL, scene, {
      data: glbBytes.slice(0),
      preserveHierarchy: true,
      onArenaBuild: () => { arenaBuilds++; },
    });

    expect(arenaBuilds).toBe(0);
    expect(result.uberBatchResult).toBeNull();
    expect(result.kinBatchResult).toBeNull();
    expect(result.batchTable).toBeNull();
    // Every node stays visible & unbatched.
    let batched = 0;
    result.root.traverse((n) => {
      if (n.userData?._rvBatchSource) batched++;
    });
    expect(batched).toBe(0);
    expect(result.root.visible).toBe(true);
  });
});

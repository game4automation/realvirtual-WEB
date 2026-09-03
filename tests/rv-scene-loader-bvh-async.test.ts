// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Async BVH build tests (plan-240 Baustein 3, Sektion 9.4).
 *
 * Validates the deferred BVH pipeline WITHOUT a real worker: a mock
 * `BVHBuildPort` (pattern: websocket-realtime-worker-facade.test.ts) captures
 * `generate()` calls and lets the test resolve each build manually.
 *
 * The `ViewerLoadHarness` below mirrors the exact call pattern of
 * `RVViewer.loadModel()` / `_startAsyncBvhBuild()` / `clearModel()`:
 * generation increment at the START of every load and clear, the build kicked
 * off fire-and-forget through `computeBVHAsync` with a `shouldAbort` closure
 * over the captured generation, and `raycast-ready` only on an un-aborted
 * completed build.
 *
 * Checks (plan 9.4):
 *   - loadModel resolves before all geometries have boundsTree.
 *   - raycast-ready fires after build completes; all eligible meshes have
 *     boundsTree (`_rvSkipBVH` meshes excluded).
 *   - clearModel during build aborts the WHOLE sequential loop.
 *   - second loadModel during running build discards stale results.
 *   - inline budget fallback yields identical boundsTree presence.
 *   - mock port receives geometries in deterministic order (merged/indirect
 *     first, then per-mesh traversal order, shared geometry deduplicated).
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Mesh, BufferGeometry, BufferAttribute, MeshBasicMaterial } from 'three';
import { computeBVHAsync } from '../src/core/engine/rv-scene-loader';
import {
  createBVHPort,
  createInlineBVHPort,
  type BVHBuildPort,
  type BVHBuildOptions,
} from '../src/core/engine/rv-bvh-build-port';

// ── Mock BVHBuildPort ───────────────────────────────────────────────────────

interface PendingBuild {
  geometry: BufferGeometry;
  options: BVHBuildOptions | undefined;
  resolve: (bvh: unknown) => void;
  reject: (e: unknown) => void;
  resolved: boolean;
}

class MockBVHPort implements BVHBuildPort {
  calls: PendingBuild[] = [];
  disposed = false;

  generate(geometry: BufferGeometry, options?: BVHBuildOptions): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.calls.push({ geometry, options, resolve, reject, resolved: false });
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Resolve call #i with a distinguishable token; returns the token. */
  resolveCall(i: number): unknown {
    const call = this.calls[i];
    if (!call) throw new Error(`no generate call #${i} (have ${this.calls.length})`);
    const token = { mockBVH: i, label: labelOf(call.geometry) };
    call.resolved = true;
    call.resolve(token);
    return token;
  }

  labels(): string[] {
    return this.calls.map((c) => labelOf(c.geometry));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function labelOf(geo: BufferGeometry): string {
  return (geo.userData.label as string) ?? '<unlabeled>';
}

async function waitUntil(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error(`waitUntil timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Sequentially resolve `expected` generate calls as the build loop issues them. */
async function drainAll(port: MockBVHPort, expected: number): Promise<void> {
  for (let i = 0; i < expected; i++) {
    await waitUntil(() => port.calls.length > i, `generate call #${i}`);
    port.resolveCall(i);
  }
}

function makeGeometry(label: string, position?: Float32Array): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute(
    'position',
    new BufferAttribute(position ?? new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  geo.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  geo.userData.label = label;
  return geo;
}

function makeMesh(label: string, geometry?: BufferGeometry): Mesh {
  const mesh = new Mesh(geometry ?? makeGeometry(label), new MeshBasicMaterial());
  mesh.name = label;
  return mesh;
}

function makeMeshTree(labels: string[]): { root: Object3D; meshes: Mesh[] } {
  const root = new Object3D();
  const meshes = labels.map((l) => {
    const m = makeMesh(l);
    root.add(m);
    return m;
  });
  return { root, meshes };
}

function hasTree(mesh: Mesh): boolean {
  return !!(mesh.geometry as BufferGeometry).boundsTree;
}

// ── Viewer-load harness ─────────────────────────────────────────────────────

/**
 * Mirrors the RVViewer wiring around `computeBVHAsync` 1:1:
 *   - `loadModel()`: `_loadGeneration++` FIRST (aborts any older build), then
 *     the build is kicked off WITHOUT being awaited — the returned
 *     "model-loaded" moment is reached synchronously (`_startAsyncBvhBuild`).
 *   - `clearModel()`: `_loadGeneration++` (aborts the running build).
 *   - `raycast-ready` is only counted when the build completed AND the
 *     generation still matches (stale completions never fire it).
 */
class ViewerLoadHarness {
  raycastReadyCount = 0;
  private generation = 0;

  constructor(private readonly port: BVHBuildPort) {}

  loadModel(root: Object3D, indirectGeometries: BufferGeometry[] = []): { buildDone: Promise<boolean> } {
    this.generation++; // RVViewer.loadModel() first statement
    const gen = this.generation;
    const buildDone = computeBVHAsync(root, this.port, {
      shouldAbort: () => this.generation !== gen,
      indirectGeometries,
    }).then((completed) => {
      if (completed && this.generation === gen) this.raycastReadyCount++;
      return completed;
    });
    // model-loaded fires here — deliberately NOT awaiting buildDone.
    return { buildDone };
  }

  clearModel(): void {
    this.generation++; // RVViewer.clearModel() first statement
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('async BVH build', () => {
  it('loadModel resolves before all geometries have boundsTree (mock port with delayed resolve)', async () => {
    const port = new MockBVHPort();
    const harness = new ViewerLoadHarness(createBVHPort(() => port)); // factory test seam
    const { root, meshes } = makeMeshTree(['a', 'b', 'c']);

    const { buildDone } = harness.loadModel(root);

    // "model-loaded" moment reached — nothing built, nothing assigned yet.
    expect(meshes.some(hasTree)).toBe(false);

    // The build loop is running (first generate issued) — STILL no boundsTree.
    await waitUntil(() => port.calls.length === 1, 'first generate call');
    expect(meshes.some(hasTree)).toBe(false);

    await drainAll(port, 3);
    expect(await buildDone).toBe(true);
    expect(meshes.every(hasTree)).toBe(true);
  });

  it('raycast-ready fires after build completes; all eligible meshes have boundsTree', async () => {
    const port = new MockBVHPort();
    const harness = new ViewerLoadHarness(port);
    const { root, meshes } = makeMeshTree(['a', 'b']);
    // Ineligible mesh — same skip flag the uber-merge sources set.
    const skipped = makeMesh('skipped');
    skipped.userData._rvSkipBVH = true;
    root.add(skipped);

    const { buildDone } = harness.loadModel(root);
    expect(harness.raycastReadyCount).toBe(0);

    await drainAll(port, 2);
    expect(await buildDone).toBe(true);

    expect(harness.raycastReadyCount).toBe(1);
    expect(meshes.every(hasTree)).toBe(true);
    expect(hasTree(skipped)).toBe(false); // _rvSkipBVH excluded
    expect(port.calls).toHaveLength(2); // no generate call for the skipped mesh
  });

  it('clearModel during build aborts the WHOLE sequential loop (no further generate calls)', async () => {
    const port = new MockBVHPort();
    const harness = new ViewerLoadHarness(port);
    const { root, meshes } = makeMeshTree(['a', 'b', 'c']);

    const { buildDone } = harness.loadModel(root);
    await waitUntil(() => port.calls.length === 1, 'first generate call');

    harness.clearModel();
    // Resolve the in-flight build AFTER the clear — its result must be discarded.
    port.resolveCall(0);

    expect(await buildDone).toBe(false);
    // Give the (aborted) loop a chance to misbehave — it must not issue more work.
    await new Promise((r) => setTimeout(r, 20));
    expect(port.calls).toHaveLength(1); // whole sequence aborted, not just one callback
    expect(meshes.some(hasTree)).toBe(false); // in-flight result discarded, nothing assigned
    expect(harness.raycastReadyCount).toBe(0);
  });

  it('second loadModel during running build: stale generation results are discarded', async () => {
    const port = new MockBVHPort();
    const harness = new ViewerLoadHarness(port);
    const treeA = makeMeshTree(['a1', 'a2']);
    const treeB = makeMeshTree(['b1', 'b2']);

    const loadA = harness.loadModel(treeA.root);
    await waitUntil(() => port.calls.length === 1, 'model A first generate');
    expect(port.calls[0].geometry).toBe(treeA.meshes[0].geometry);

    // Second load while A's first build is still in flight.
    const loadB = harness.loadModel(treeB.root);
    await waitUntil(() => port.calls.length === 2, 'model B first generate');

    // A's in-flight build resolves now — stale, must be discarded.
    port.resolveCall(0);
    expect(await loadA.buildDone).toBe(false);
    expect(treeA.meshes.some(hasTree)).toBe(false);

    // B's build runs to completion untouched.
    port.resolveCall(1);
    await waitUntil(() => port.calls.length === 3, 'model B second generate');
    port.resolveCall(2);
    expect(await loadB.buildDone).toBe(true);
    expect(treeB.meshes.every(hasTree)).toBe(true);

    await new Promise((r) => setTimeout(r, 20));
    expect(port.calls).toHaveLength(3); // A issued exactly 1 call before dying
    expect(treeA.meshes.some(hasTree)).toBe(false);
    expect(harness.raycastReadyCount).toBe(1); // only B
  });

  it('inline budget fallback (no worker) yields identical boundsTree presence', async () => {
    const labels = ['a', 'b', 'c'];

    // Reference run: mock port.
    const mockPort = new MockBVHPort();
    const mockRun = makeMeshTree(labels);
    const mockSkip = makeMesh('skipped');
    mockSkip.userData._rvSkipBVH = true;
    mockRun.root.add(mockSkip);
    const mockMerged = makeGeometry('merged');
    const mockHarness = new ViewerLoadHarness(mockPort);
    const { buildDone: mockDone } = mockHarness.loadModel(mockRun.root, [mockMerged]);
    await drainAll(mockPort, 4); // merged + a + b + c
    expect(await mockDone).toBe(true);

    // Inline run on an identical structure: real MeshBVH builds, no Worker.
    const inlineRun = makeMeshTree(labels);
    const inlineSkip = makeMesh('skipped');
    inlineSkip.userData._rvSkipBVH = true;
    inlineRun.root.add(inlineSkip);
    const inlineMerged = makeGeometry('merged');
    const inlineHarness = new ViewerLoadHarness(createInlineBVHPort());
    const { buildDone: inlineDone } = inlineHarness.loadModel(inlineRun.root, [inlineMerged]);
    expect(await inlineDone).toBe(true);
    expect(inlineHarness.raycastReadyCount).toBe(1);

    // Identical presence pattern, mesh by mesh.
    for (let i = 0; i < labels.length; i++) {
      expect(hasTree(inlineRun.meshes[i])).toBe(hasTree(mockRun.meshes[i]));
      expect(hasTree(inlineRun.meshes[i])).toBe(true);
    }
    expect(hasTree(inlineSkip)).toBe(hasTree(mockSkip));
    expect(hasTree(inlineSkip)).toBe(false);
    expect(!!inlineMerged.boundsTree).toBe(!!mockMerged.boundsTree);
    expect(inlineMerged.boundsTree).toBeTruthy();

    // Inline trees are REAL MeshBVH instances (not tokens).
    const { MeshBVH } = await import('three-mesh-bvh');
    expect(inlineRun.meshes[0].geometry.boundsTree).toBeInstanceOf(MeshBVH);
    expect(inlineMerged.boundsTree).toBeInstanceOf(MeshBVH);
  });

  it('mock port receives geometries in deterministic order (merged first, traversal order, dedup)', async () => {
    const buildScene = (): { root: Object3D; merged: BufferGeometry[]; sharedBufA: Mesh; sharedBufB: Mesh } => {
      const root = new Object3D();
      root.add(makeMesh('m1'));
      root.add(makeMesh('m2'));
      const sharedGeo = makeGeometry('shared');
      root.add(makeMesh('sharedUse1', sharedGeo));
      root.add(makeMesh('m3'));
      root.add(makeMesh('sharedUse2', sharedGeo)); // same geometry — must build ONCE
      // Two DIFFERENT geometries whose position arrays view ONE ArrayBuffer —
      // must be flagged transferable:false so a worker never detaches siblings.
      const buf = new ArrayBuffer(9 * 4 * 2);
      const sharedBufA = makeMesh('sharedBufA', makeGeometry('sharedBufA', new Float32Array(buf, 0, 9)));
      const sharedBufB = makeMesh('sharedBufB', makeGeometry('sharedBufB', new Float32Array(buf, 9 * 4, 9)));
      root.add(sharedBufA);
      root.add(sharedBufB);
      const merged = [makeGeometry('merged1'), makeGeometry('merged2')];
      return { root, merged, sharedBufA, sharedBufB };
    };
    const expectedOrder = ['merged1', 'merged2', 'm1', 'm2', 'shared', 'm3', 'sharedBufA', 'sharedBufB'];

    const runOnce = async (): Promise<MockBVHPort> => {
      const port = new MockBVHPort();
      const harness = new ViewerLoadHarness(port);
      const scene = buildScene();
      const { buildDone } = harness.loadModel(scene.root, scene.merged);
      await drainAll(port, expectedOrder.length);
      expect(await buildDone).toBe(true);
      return port;
    };

    const first = await runOnce();
    expect(first.labels()).toEqual(expectedOrder);

    // Merged geometries build in indirect mode, per-mesh geometries do not.
    for (const call of first.calls) {
      const isMerged = labelOf(call.geometry).startsWith('merged');
      expect(call.options?.indirect ?? false).toBe(isMerged);
    }
    // Cross-geometry shared ArrayBuffer → transferable:false; everything else true.
    for (const call of first.calls) {
      const sharesBuffer = labelOf(call.geometry).startsWith('sharedBuf');
      expect(call.options?.transferable).toBe(!sharesBuffer);
    }

    // Deterministic across runs on an identical structure.
    const second = await runOnce();
    expect(second.labels()).toEqual(first.labels());
  });

  it('transferable:false in the options forces EVERY build off the worker transfer route', async () => {
    // The live-scene path (RVViewer.buildMeshBvhsAsync — CAD import into a
    // rendering scene) must never let a worker detach position/index buffers:
    // a first GPU upload inside the detach window leaves the mesh invisible
    // ("glDrawElements: Insufficient buffer size"). Exclusive-buffer
    // geometries — exactly the ones the worker WOULD transfer — must come out
    // flagged transferable:false.
    const { root } = makeMeshTree(['a', 'b', 'c']);
    const port = new MockBVHPort();
    const done = computeBVHAsync(root, port, { transferable: false });
    await drainAll(port, 3);
    expect(await done).toBe(true);
    for (const call of port.calls) {
      expect(call.options?.transferable).toBe(false);
    }
  });
});

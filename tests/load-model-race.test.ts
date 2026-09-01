// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * load-model-race — overlapping loads leave exactly ONE model in the scene
 * (plan-442, sections 9.1 / 9.4 / 9.5 / 9.8).
 *
 * The bug these tests pin down: `loadGLB` parents its root and hands it back
 * BEFORE `loadModel` tags it `_rvModelRoot`. In that window a second load's
 * `clearModel()` sweep cannot see the first root — so when the first load then
 * carried on and adopted it anyway, the scene ended up drawing two complete
 * models (live case: 87 meshes twice, parts of the machine invisible).
 *
 * ## How the interleaving is made deterministic
 *
 * `loadGLB` is the REAL one — the roots, geometries and materials in these
 * tests are genuinely parsed GLBs, which is the only way the dispose
 * assertions mean anything. Only its RESOLUTION is held: the mock awaits a
 * per-URL gate the test opens and releases by hand. That places the pause
 * exactly in the window under test (parse complete, root parented, tag not yet
 * written) — the window `loadGLB`'s own `shouldAbort` deliberately no longer
 * covers, because at that point it has already returned.
 *
 * A hidden tab stretches that window from milliseconds to tens of seconds
 * (Chrome timer throttling), which is why the live report came from a
 * backgrounded editor session. Nothing here depends on rAF or wall-clock time.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BufferGeometry, Mesh, Object3D, Scene } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetsAvailable } from './fixtures/dev-asset-available';

// plan-395: everything in `DEV_GLB` lives in the private Development project
// and is absent from a public checkout. The suites below must then report
// `skipped` rather than `passed` - a probe-and-return would leave this file
// green while it checked nothing. The probe tests the CONTENT TYPE, not
// `res.ok`: without the private sibling nothing claims `/private-assets/`, so
// the dev server answers it with the SPA fallback, a 200 text/html.
const DEV_ASSETS = await devAssetsAvailable(DEV_GLB.physicsZone, DEV_GLB.mechanismFourbar, DEV_GLB.europalletEmpty);
import { LoadAbortedError } from '../src/core/engine/rv-scene-loader';
import { makeDraftScene } from '../src/core/hmi/scene/rv-scene-types';

// Three small fixtures on purpose: what is under test is the interleaving, and
// every second spent parsing widens the window for a flake instead of the test.
const URL_A = DEV_GLB.physicsZone;
const URL_B = DEV_GLB.mechanismFourbar;
const URL_C = DEV_GLB.europalletEmpty;

interface Gate {
  /** Resolves once the load reached the gate (parse done, root parented). */
  entered: Promise<void>;
  markEntered: () => void;
  /** The mock waits on this; resolve to let the load return, reject to fail it. */
  hold: Promise<void>;
  release: () => void;
  fail: (reason: unknown) => void;
  /** The root the real `loadGLB` produced for this URL. */
  root?: Object3D;
}

const h = vi.hoisted(() => ({ gates: new Map<string, Gate>() }));

vi.mock('../src/core/engine/rv-scene-loader', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/engine/rv-scene-loader')>();
  return {
    ...orig,
    loadGLB: async (url: string, scene: Scene, options?: unknown) => {
      const result = await (orig.loadGLB as (
        u: string, s: Scene, o?: unknown,
      ) => Promise<{ root: Object3D }>)(url, scene, options);
      const gate = h.gates.get(url);
      if (!gate) return result;
      gate.root = result.root;
      gate.markEntered();
      try {
        await gate.hold;
      } catch (e) {
        // Mirror what the real loader does on ANY internal failure: the root it
        // parented never survives. Without this the "winner fails" case would
        // assert against a root no production path could leave behind.
        scene.remove(result.root);
        throw e;
      }
      return result;
    },
  };
});

/** Hold the next load of `url` at the post-parse / pre-adoption point. */
function gateLoad(url: string): Gate {
  let markEntered!: () => void;
  const entered = new Promise<void>((r) => { markEntered = r; });
  let release!: () => void;
  let fail!: (reason: unknown) => void;
  const hold = new Promise<void>((res, rej) => {
    release = () => res();
    fail = (reason) => rej(reason);
  });
  hold.catch(() => { /* the mock is the real consumer; this only silences the tracker */ });
  const gate: Gate = { entered, markEntered, hold, release, fail };
  h.gates.set(url, gate);
  return gate;
}

/** Watch every unique geometry under `root` for its `dispose()` call. */
function watchGeometries(root: Object3D): { all: Set<BufferGeometry>; disposed: Set<BufferGeometry> } {
  const all = new Set<BufferGeometry>();
  root.traverse((n) => {
    const g = (n as Mesh).geometry;
    if (g) all.add(g);
  });
  const disposed = new Set<BufferGeometry>();
  for (const g of all) {
    g.addEventListener('dispose', () => disposed.add(g));
  }
  return { all, disposed };
}

const modelRoots = (viewer: { scene: Scene }): Object3D[] =>
  viewer.scene.children.filter((c) => c.userData?._rvModelRoot === true);

let handle: TestViewerHandle | null = null;

afterEach(() => {
  h.gates.clear();
  handle?.dispose();
  handle = null;
});

async function viewer() {
  handle = await createTestViewer('webgl');
  return handle.viewer;
}

describe.skipIf(!DEV_ASSETS)('overlapping loadModel (plan-442 §9.1)', () => {
  it('discards the superseded root and keeps exactly one _rvModelRoot', async () => {
    const v = await viewer();
    const gateA = gateLoad(URL_A);

    const p1 = v.loadModel(URL_A);
    await gateA.entered;                       // run 1 is inside the blind window
    const watch = watchGeometries(gateA.root!);

    await v.loadModel(URL_B);                  // run 2 starts, wins, finishes
    gateA.release();                           // run 1 comes back too late

    await expect(p1).rejects.toBeInstanceOf(LoadAbortedError);

    const roots = modelRoots(v);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(v.currentModelRoot);
    expect(gateA.root!.parent).toBeNull();     // the loser is out of the scene
    expect(watch.all.size).toBeGreaterThan(0);
    expect(watch.disposed.size).toBe(watch.all.size); // …and actually freed
  });

  it('is correct in the other completion order too (loser returns first)', async () => {
    const v = await viewer();
    const gateA = gateLoad(URL_A);
    const gateB = gateLoad(URL_B);

    const p1 = v.loadModel(URL_A);
    await gateA.entered;
    const p2 = v.loadModel(URL_B);
    await gateB.entered;

    gateA.release();                           // the OLDER run returns first
    await expect(p1).rejects.toBeInstanceOf(LoadAbortedError);
    gateB.release();
    await p2;

    expect(modelRoots(v)).toHaveLength(1);
    expect(modelRoots(v)[0]).toBe(v.currentModelRoot);
  });

  it('leaves NO root when the winner fails after the loser was disposed', async () => {
    const v = await viewer();
    const gateA = gateLoad(URL_A);
    const gateB = gateLoad(URL_B);

    const p1 = v.loadModel(URL_A);
    await gateA.entered;
    const p2 = v.loadModel(URL_B);
    await gateB.entered;

    gateA.release();                           // loser disposes itself
    await expect(p1).rejects.toBeInstanceOf(LoadAbortedError);

    const boom = new Error('winner parse failed');
    gateB.fail(boom);
    await expect(p2).rejects.toBe(boom);       // the ORIGINAL error, not a cancellation

    // F1: an empty scene is the defined outcome. Rolling back to the loser
    // would mean re-adopting a subtree whose GPU buffers are already gone.
    expect(modelRoots(v)).toHaveLength(0);
    expect(v.currentModelRoot).toBeNull();
  });

  it('lets the LAST of three overlapping loads win', async () => {
    const v = await viewer();
    const gateA = gateLoad(URL_A);
    const gateB = gateLoad(URL_B);
    const gateC = gateLoad(URL_C);

    const p1 = v.loadModel(URL_A);
    await gateA.entered;
    const p2 = v.loadModel(URL_B);
    await gateB.entered;
    const p3 = v.loadModel(URL_C);
    await gateC.entered;                       // all three parsed, none adopted

    gateA.release();
    gateB.release();
    gateC.release();
    const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);

    expect(r1.status).toBe('rejected');
    expect(r2.status).toBe('rejected');
    expect(r3.status).toBe('fulfilled');
    expect(modelRoots(v)).toHaveLength(1);
    expect(modelRoots(v)[0]).toBe(v.currentModelRoot);
  });

  it('stops a run that was overtaken in the PRE-load window (loadGate)', async () => {
    const v = await viewer();
    let openGate!: () => void;
    v.loadGate = new Promise<void>((r) => { openGate = r; });

    const p1 = v.loadModel(URL_A);             // parks before loadGLB
    await Promise.resolve();
    await Promise.resolve();

    v.loadGate = null;
    const modelUrlBefore = v.currentModelUrl;
    await v.loadModel(URL_B);                  // run 2 overtakes while run 1 waits

    openGate();                                // run 1 resumes into the gate check
    await expect(p1).rejects.toBeInstanceOf(LoadAbortedError);

    // The point of gating the PRE-load window: run 1 never got as far as
    // parsing, so it cannot have written another viewer-global on its way out.
    expect(v.currentModelUrl).toBe(URL_B);
    expect(modelRoots(v)).toHaveLength(1);
    void modelUrlBefore;
  });
});

describe.skipIf(!DEV_ASSETS)('superseded loads register nothing (plan-442 §9.4 / §9.5)', () => {
  it('emits model-loaded and raycast-ready for the winner only', async () => {
    const v = await viewer();
    const loaded: string[] = [];
    v.on('model-loaded', () => { loaded.push('model-loaded'); });

    const gateA = gateLoad(URL_A);
    const p1 = v.loadModel(URL_A);
    await gateA.entered;
    await v.loadModel(URL_B);
    gateA.release();
    await expect(p1).rejects.toBeInstanceOf(LoadAbortedError);

    // The superseded run never reaches the post-load block at all, so no pick
    // index, no RaycastManager, no async BVH build is ever started against a
    // subtree that is about to be disposed.
    expect(loaded).toEqual(['model-loaded']);
  });

  it('keeps whenLoadingIdle a plain task drain — no superseded semantics', async () => {
    const v = await viewer();
    const gateA = gateLoad(URL_A);
    const p1 = v.loadModel(URL_A);
    await gateA.entered;
    const p2 = v.loadModel(URL_B);

    // Resolves for BOTH loads and carries no value: it drains the global task
    // queue and is deliberately not bound to any one load (rv-viewer.ts).
    await expect(v.whenLoadingIdle()).resolves.toBeUndefined();

    gateA.release();
    await Promise.allSettled([p1, p2]);
    await expect(v.whenLoadingIdle()).resolves.toBeUndefined();
  });
});

describe.skipIf(!DEV_ASSETS)('overlapping loadScene (plan-442 §9.8)', () => {
  it('rejects the overtaken loadScene and emits scene-loaded once', async () => {
    const v = await viewer();
    const seen: string[] = [];
    v.on('scene-loaded', ({ scene }) => { seen.push(scene.name); });

    const gateA = gateLoad(URL_A);
    const sceneA = makeDraftScene({ kind: 'builtin', url: URL_A, label: 'A' }, 'A');
    const sceneB = makeDraftScene({ kind: 'builtin', url: URL_B, label: 'B' }, 'B');

    const p1 = v.loadScene(sceneA);
    await gateA.entered;
    await v.loadScene(sceneB);
    gateA.release();

    await expect(p1).rejects.toBeInstanceOf(LoadAbortedError);
    expect(seen).toEqual(['B']);
    expect(modelRoots(v)).toHaveLength(1);
    expect(v.currentScene?.name).toBe('B');
  });

  it('stops a loadScene overtaken by a plain loadModel AFTER its own load', async () => {
    const v = await viewer();
    const seen: string[] = [];
    v.on('scene-loaded', () => { seen.push('scene-loaded'); });

    // No gate on the scene's own base: the scene load runs its `loadModel` to
    // completion and is overtaken in the FOLLOW-UP phases instead — the window
    // the `await loadModel()` rejection alone does not cover.
    //
    // `whenLoadingIdle` is the hook because it is where phase 5 waits. Call #1
    // is `loadModel`'s own drain and must pass, or the overtake would land back
    // in `_loadModelInner` and test the other guard again; call #2 IS phase 5.
    const sceneA = makeDraftScene({ kind: 'builtin', url: URL_A, label: 'A' }, 'A');
    let resolveDrain!: () => void;
    const drain = new Promise<void>((r) => { resolveDrain = r; });
    let markParked!: () => void;
    const parked = new Promise<void>((r) => { markParked = r; });
    const realIdle = v.whenLoadingIdle.bind(v);
    let calls = 0;
    v.whenLoadingIdle = async (): Promise<void> => {
      await realIdle();
      if (++calls !== 2) return;
      markParked();
      await drain;                              // hold the scene inside phase 5
    };

    const p1 = v.loadScene(sceneA);
    await parked;
    await v.loadModel(URL_B);                   // overtakes the parked scene load
    resolveDrain();

    await expect(p1).rejects.toBeInstanceOf(LoadAbortedError);
    expect(seen).toEqual([]);                   // the overtaken scene never announces itself
    expect(modelRoots(v)).toHaveLength(1);
  });
});

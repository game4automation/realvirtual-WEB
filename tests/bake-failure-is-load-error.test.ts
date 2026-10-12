// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 Phase 3 (§ 9) — a failed bake is a load error.
 *
 * Mental model point 6 / D7: there is no unbaked runtime. Until commit A the
 * loader caught a thrown bake and rendered the unbaked `tmp` instead — a
 * silent fallback nobody could see. Since commit A:
 *  - a bake that THROWS rejects the load with `BakeFailedError`, reports ONE
 *    `bake-failed` problem naming the file and the cause, and leaves no tree
 *    in the scene (no chunk, no authored node);
 *  - re-reporting the same asset replaces (the problems store is keyed);
 *  - an ABORT (`BakeAbortedError` from a superseded load) stays
 *    `LoadAbortedError` and gets NO problem entry.
 * Since commit B there is no override either: a stored
 * `rv-webviewer-static-merge` value is ignored, and a pick build that rejects
 * for ONE chunk is not a bake failure any more — that chunk is published
 * segment-only (`tests/pick-structure-free-mode.test.ts`). The thrown bake
 * here therefore comes from a port that cannot even open an epoch.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, BakeFailedError, LoadAbortedError, type LoadGLBOptions, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry, RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort, type PickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { isSegmentOnly } from '../src/core/engine/rv-pick-structure';
import {
  bakeFailedProblemId, clearBakeFailedProblems, getProblems, resetProblemsForTests,
} from '../src/core/hmi/problems-store';

const material = new MeshStandardMaterial({ color: 0x556677 });

function box(name: string, pos: [number, number, number]): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material.clone());
  m.name = name;
  m.position.set(...pos);
  return m;
}

function buildPlant(): Group {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(box('Frame', [0, 0, 0]));
  const cad = new Group(); cad.name = 'Cad'; cad.add(box('Bolt', [2, 0, 0]));
  plant.add(cad);
  const axis = new Group(); axis.name = 'Axis';
  axis.userData.realvirtual = { Drive: { Direction: 'LinearY' } };
  axis.add(box('Arm', [6, 0, 0]));
  plant.add(axis);
  return plant;
}

const AUTHORED = ['Plant', 'Frame', 'Cad', 'Bolt', 'Axis', 'Arm'];
const URL = 'plant.glb';

/**
 * A pick build port that cannot open an epoch — `bake()` calls `beginEpoch()`
 * synchronously before staging, so the throw reaches the loader as a plain
 * Error (not an abort) without any fixture trickery.
 */
function brokenPickPort(message: string): PickBuildPort {
  const real = createPickBuildPort({ createWorker: () => null });
  return {
    get size() { return real.size; },
    get usesWorker() { return real.usesWorker; },
    get stats() { return real.stats; },
    beginEpoch() { throw new Error(message); },
    build: () => Promise.reject(new Error(message)),
    dispose: () => real.dispose(),
  };
}

/** A port whose epochs open fine but whose every chunk build rejects. */
function rejectingPickPort(message: string): PickBuildPort {
  const real = createPickBuildPort({ createWorker: () => null });
  const reject = (): Promise<never> => Promise.reject(new Error(message));
  return {
    get size() { return real.size; },
    get usesWorker() { return real.usesWorker; },
    get stats() { return real.stats; },
    beginEpoch() {
      const epoch = real.beginEpoch();
      return {
        get id() { return epoch.id; },
        get stale() { return epoch.stale; },
        build: reject,
        abort: () => epoch.abort(),
      };
    },
    build: reject,
    dispose: () => real.dispose(),
  };
}

let bytes: ArrayBuffer;
beforeAll(async () => { bytes = await objectToGlb(buildPlant()); });

beforeEach(() => { resetProblemsForTests(); });

function load(scene: Scene, opts: Partial<LoadGLBOptions> = {}): Promise<LoadResult> {
  return loadGLB(URL, scene, {
    data: bytes.slice(0),
    loadKinematicsSidecar: false,
    bakeRegistry: new BakeRegistry(),
    bakePickPort: createPickBuildPort({ createWorker: () => null }),
    ...opts,
  });
}

function bakeFailedProblems() {
  return getProblems().filter((p) => p.code === 'bake-failed');
}

function namesIn(root: Object3D): string[] {
  const names: string[] = [];
  root.traverse((n) => names.push(n.name));
  return names;
}

function chunksIn(root: Object3D): number {
  let chunks = 0;
  root.traverse((n) => { if (n.userData[RV_BAKE_CHUNK_KEY]) chunks++; });
  return chunks;
}

describe('a failed bake is a load error (plan-757 Phase 3)', () => {
  it('thrown bake → BakeFailedError, ONE bake-failed problem, no tree in the scene', async () => {
    const scene = new Scene();
    const pending = load(scene, { bakePickPort: brokenPickPort('pick port exploded') });
    await expect(pending).rejects.toBeInstanceOf(BakeFailedError);

    const problems = bakeFailedProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0].id).toBe(bakeFailedProblemId(URL));
    expect(problems[0].severity).toBe('error');
    expect(problems[0].title).toContain(URL);
    // F16: the entry says what went wrong, not just that something did.
    expect(problems[0].detail).toContain('pick port exploded');
    expect(problems[0].detail).toContain(URL);

    // No fallback tree: neither an authored node nor a chunk reached the scene.
    for (const n of AUTHORED) expect(namesIn(scene)).not.toContain(n);
    expect(chunksIn(scene)).toBe(0);
  });

  it('the error names the url and carries the thrown cause', async () => {
    let caught: unknown;
    try { await load(new Scene(), { bakePickPort: brokenPickPort('pick port exploded') }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(BakeFailedError);
    const err = caught as BakeFailedError;
    expect(err.name).toBe('BakeFailedError');
    expect(err.message).toContain(URL);
    expect(err.message).toContain('pick port exploded');
    expect(err.reason).toBe('pick port exploded');
    expect(err.inner).toBeInstanceOf(Error);
  });

  it('re-reporting the same asset replaces, never appends', async () => {
    await expect(load(new Scene(), { bakePickPort: brokenPickPort('first') })).rejects.toBeInstanceOf(BakeFailedError);
    await expect(load(new Scene(), { bakePickPort: brokenPickPort('second') })).rejects.toBeInstanceOf(BakeFailedError);
    const problems = bakeFailedProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0].detail).toContain('second');
  });

  it('an abort stays LoadAbortedError and gets NO problem entry', async () => {
    const scene = new Scene();
    await expect(load(scene, { shouldAbort: () => true })).rejects.toBeInstanceOf(LoadAbortedError);
    expect(bakeFailedProblems()).toEqual([]);
    for (const n of AUTHORED) expect(namesIn(scene)).not.toContain(n);
    expect(chunksIn(scene)).toBe(0);
  });

  it('a rejected per-chunk pick build is NOT a load error (commit B): the load resolves baked, chunks segment-only', async () => {
    const result = await load(new Scene(), { bakePickPort: rejectingPickPort('worker exploded') });
    expect(result.bakedAsset).not.toBeNull();
    expect(result.bakeInstance).not.toBeNull();
    expect(bakeFailedProblems()).toEqual([]);
    expect(chunksIn(result.root)).toBeGreaterThan(0);
    for (const c of result.bakedAsset!.chunks) expect(isSegmentOnly(c.pick)).toBe(true);
    // Merged CAD is gone as in every baked load — the bake happened.
    expect(result.registry.getNode('Plant/Cad/Bolt')).toBeNull();
  });

  it('a stored rv-webviewer-static-merge value is ignored (commit B): the load bakes regardless', async () => {
    localStorage.setItem('rv-webviewer-static-merge', '0');
    try {
      const result = await load(new Scene());
      expect(result.bakedAsset).not.toBeNull();
      expect(result.placementBakeAllowed).toBe(true);
      expect(chunksIn(result.root)).toBeGreaterThan(0);
      expect(bakeFailedProblems()).toEqual([]);
    } finally {
      localStorage.removeItem('rv-webviewer-static-merge');
    }
  });

  it('clearBakeFailedProblems drops the entry — what clearModel() runs before the next load', async () => {
    await expect(load(new Scene(), { bakePickPort: brokenPickPort('boom') })).rejects.toBeInstanceOf(BakeFailedError);
    expect(bakeFailedProblems()).toHaveLength(1);
    clearBakeFailedProblems();
    expect(bakeFailedProblems()).toEqual([]);
  });

  it('a healthy bake reports nothing and loads chunks (the control case)', async () => {
    const result = await load(new Scene());
    expect(result.bakedAsset).not.toBeNull();
    expect(chunksIn(result.root)).toBeGreaterThan(0);
    expect(bakeFailedProblems()).toEqual([]);
  });
});

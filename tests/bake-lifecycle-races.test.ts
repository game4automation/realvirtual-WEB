// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.11 — lifecycle races of the chunk bake.
 *
 * (a) `clearDecoded` while a bake is running → no asset published, the bake
 *     rejects with `BakeAbortedError`, already-staged chunks are disposed;
 * (b) a cache invalidation while a chunk's PICK structure is still building →
 *     the bake aborts, nothing is published (plan-756 step 1d: `bake()`
 *     resolving IS the readiness, so there is no "late result" window any more —
 *     the deferred BVH port became a deferred PICK port, §9.4);
 * (c) two `getOrLoadBaked` of the same key → ONE decode, ONE bake, same asset;
 * (d) the same asset id in two ModelCache instances (two documents) → two
 *     independent bakes.
 */
import { describe, it, expect, vi } from 'vitest';
import { Group } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import '../src/core/engine/rv-scene-loader';
import { ModelCache } from '../src/plugins/layout-planner/model-cache';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { BakeAbortedError, bakeEvents, _resetBakeEventsForTesting } from '../src/core/engine/rv-bake-pipeline';
import { chunkMetaOf } from '../src/core/engine/rv-bake-chunk';
import { prepareAndBake } from '../src/core/engine/rv-prepare-and-bake';
import { flush, group, makeDeferredPickPort, uberMesh, waitFor, withComponent } from './fixtures/bake-fixture';

const BLOB_URL = 'blob:rv-test/races.glb';
const uber = new RVUberMaterial(false);

interface Deferred { resolve(): void }

/** Two movers + static → three chunks (two inter-chunk yields inside bake()). */
function makeAsset(): Group {
  const root = group('Machine');
  root.add(uberMesh(uber, 'frame'));
  for (const n of ['Drive-A', 'Drive-B']) {
    const d = withComponent(group(n), 'Drive');
    d.add(uberMesh(uber, 'arm', [1, 0, 0]));
    root.add(d);
  }
  return root;
}

function makeControllableLoader() {
  const pending: Deferred[] = [];
  const loadAsync = vi.fn(() => new Promise<{ scene: Group }>((resolve) => {
    pending.push({ resolve: () => resolve({ scene: makeAsset() }) });
  }));
  return {
    loader: { loadAsync } as unknown as GLTFLoader,
    loadAsync,
    settle(): void { pending.shift()!.resolve(); },
  };
}

function instantLoader(counter?: { n: number }): GLTFLoader {
  return { loadAsync: async (): Promise<{ scene: Group }> => { if (counter) counter.n++; return { scene: makeAsset() }; } } as unknown as GLTFLoader;
}

describe('bake lifecycle races (plan-753 §9.11)', () => {
  it('(a) clearDecoded during the decode of a bake → BakeAbortedError, nothing published', async () => {
    const ctl = makeControllableLoader();
    const cache = new ModelCache(ctl.loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
    _resetBakeEventsForTesting();

    const pending = cache.getOrLoadBaked(BLOB_URL);
    await flush();
    cache.clearDecoded();
    ctl.settle();

    await expect(pending).rejects.toBeInstanceOf(BakeAbortedError);
    expect(cache.peekBaked(BLOB_URL)).toBeUndefined();
    expect(cache.getBakeStats().assets).toBe(0);
    // bake() was never entered — the master's attributes were never read.
    expect(bakeEvents).toHaveLength(0);
  });

  it('(a′) the epoch moving on between chunks aborts the RECIPE and leaves no chunk geometry behind', async () => {
    const root = makeAsset();
    // Stale at the first inter-chunk check (the check runs after the first
    // yield, i.e. after chunk #1 was staged). plan-757 R12: through
    // `prepareAndBake`, the one function both `loadGLB` and `ModelCache._bake`
    // call — an abort surfaces as `BakeAbortedError` and never as a bake error.
    const isEpochCurrent = vi.fn().mockReturnValue(false);
    const disposeSpy = vi.fn();
    const three = await import('three');
    const origDispose = three.BufferGeometry.prototype.dispose;
    three.BufferGeometry.prototype.dispose = function (this: unknown) { disposeSpy(this); return origDispose.call(this as never); };
    // A chunk geometry is the only thing the bake ever registers in `chunkMetaOf`.
    const registered: unknown[] = [];
    const origSet = chunkMetaOf.set.bind(chunkMetaOf);
    chunkMetaOf.set = ((geo: never, meta: never) => { registered.push(geo); return origSet(geo, meta); }) as typeof chunkMetaOf.set;
    try {
      await expect(prepareAndBake(root, {
        assetId: 'races', renamedNodes: new Map(), signatureState: 'none', uber, isWebGPU: false,
        pickPort: createPickBuildPort({ createWorker: () => null }), isEpochCurrent,
      })).rejects.toBeInstanceOf(BakeAbortedError);
    } finally {
      three.BufferGeometry.prototype.dispose = origDispose;
      delete (chunkMetaOf as unknown as { set?: unknown }).set;
    }
    // plan-756 step 1c (§2.4, "buffer ownership window"): staging no longer
    // produces a geometry at all — it produces raw arrays that are handed to the
    // pick build, and the `BufferGeometry` is created only from what comes back.
    // An abort between chunks therefore has nothing to free: no chunk geometry
    // was ever constructed, nothing was registered in `chunkMetaOf`, and the raw
    // arrays are plain garbage. (Before 1c this asserted exactly one dispose of
    // the one staged chunk.)
    expect(registered).toEqual([]);
    expect(disposeSpy).not.toHaveBeenCalled();
  });

  it('(b) a clearDecoded while the pick structures are still building publishes nothing', async () => {
    const port = makeDeferredPickPort();
    const cache = new ModelCache(instantLoader(), { uber: () => uber, pickPort: () => port });
    const pending = cache.getOrLoadBaked(BLOB_URL);
    // Three chunks were staged and their builds submitted — and they hang, so
    // `bake()` has NOT resolved: there is no asset anywhere yet (plan F1).
    await waitFor(() => port.pending === 3);
    expect(cache.peekBaked(BLOB_URL)).toBeUndefined();

    cache.clearDecoded();
    await port.settleAll();

    await expect(pending).rejects.toBeInstanceOf(BakeAbortedError);
    expect(cache.peekBaked(BLOB_URL)).toBeUndefined();
    expect(cache.getBakeStats().assets).toBe(0);
  });

  it('(c) two getOrLoadBaked of one key share one decode and one bake', async () => {
    const counter = { n: 0 };
    const port = createPickBuildPort({ createWorker: () => null });
    const beginEpoch = vi.spyOn(port, 'beginEpoch');
    const cache = new ModelCache(instantLoader(counter), { uber: () => uber, pickPort: () => port });

    const [a, b] = await Promise.all([cache.getOrLoadBaked(BLOB_URL), cache.getOrLoadBaked(BLOB_URL)]);
    expect(a).toBe(b);
    expect(counter.n).toBe(1);
    // ONE bake ⇒ exactly one pick-build epoch, and every chunk carries a structure.
    expect(beginEpoch).toHaveBeenCalledTimes(1);
    for (const c of a.chunks) expect(c.pick.segmentCount).toBeGreaterThan(0);
    expect(cache.getBakeStats()).toMatchObject({ assets: 1, chunks: 3, inflight: 0 });
  });

  it('(d) the same asset id in two caches (two documents) bakes twice, independently', async () => {
    const c1 = new ModelCache(instantLoader(), { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
    const c2 = new ModelCache(instantLoader(), { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
    const [a, b] = await Promise.all([c1.getOrLoadBaked(BLOB_URL), c2.getOrLoadBaked(BLOB_URL)]);
    expect(a).not.toBe(b);
    expect(a.assetId).toBe(b.assetId);
    expect(new Set([...a.chunks, ...b.chunks].map((c) => c.geometry)).size).toBe(6);
    c1.dispose();
    expect(a.disposed).toBe(true);
    expect(b.disposed).toBe(false);
  });
});

/**
 * Phase 3 (I3 / I7): saved `AssetOverrides` on an instance. `byNodeId` patches
 * reach logic nodes; a patch for a node that is no longer a node (a CAD leaf
 * merged into a chunk) is reported as an `override-orphaned` problem (plan-757
 * F9 — never a dropped console line); `trsByNodeId` forces a chunk split at
 * bake time (a DIFFERENT cached bake of the same master) and the saved
 * transform becomes the instance node's transform.
 */
describe('AssetOverrides on a baked instance (plan-753 Phase 3, §9.11 d)', () => {
  const DRIVE_ID = 'nid-drive';
  const PART_ID = 'nid-part';
  const LEAF_ID = 'nid-leaf';

  /** Machine: frame(leaf id) + Drive(id) + Part(id, plain mesh, no component). */
  function makeIdAsset(): Group {
    const root = group('Machine');
    const frame = uberMesh(uber, 'frame');
    frame.userData.realvirtual = { NodeId: LEAF_ID };
    root.add(frame);
    const drive = withComponent(group('Drive-A'), 'Drive');
    (drive.userData.realvirtual as Record<string, unknown>).NodeId = DRIVE_ID;
    drive.add(uberMesh(uber, 'arm', [1, 0, 0]));
    root.add(drive);
    const part = uberMesh(uber, 'Part', [0, 0, 3]);
    part.userData.realvirtual = { NodeId: PART_ID };
    root.add(part);
    return root;
  }
  const idLoader = (): GLTFLoader => ({ loadAsync: async (): Promise<{ scene: Group }> => ({ scene: makeIdAsset() }) } as unknown as GLTFLoader);

  it('byNodeId patches a logic node; a patch on a merged CAD leaf is reported as override-orphaned', async () => {
    const { getProblems, resetProblemsForTests } = await import('../src/core/hmi/problems-store');
    resetProblemsForTests();
    const cache = new ModelCache(idLoader(), { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
    const baked = await cache.getOrLoadBaked(BLOB_URL + '#ids');
    const { BakeRegistry } = await import('../src/core/engine/rv-bake-registry');
    const reg = new BakeRegistry();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const inst = reg.instantiate(baked, new Group(), {
        overrides: { byNodeId: { [DRIVE_ID]: { Drive: { Speed: 42 } }, [LEAF_ID]: { Drive: { Speed: 1 } } } },
      });
      const drive = inst.logicNodes.find((n) => n.name === 'Drive-A')!;
      expect((drive.userData.realvirtual as { Drive: { Speed?: number } }).Drive.Speed).toBe(42);
      // plan-757 F9: the orphan is ONE `override-orphaned` problem naming the leaf — not a console line.
      const orphans = getProblems().filter((p) => p.code === 'override-orphaned');
      expect(orphans).toHaveLength(1);
      expect(orphans[0].id).toBe(`override-orphaned::nodeId:${LEAF_ID}`);
      expect(orphans[0].detail).toContain(LEAF_ID);
      expect(orphans[0].detail).toContain('Drive');
      expect(warn).not.toHaveBeenCalled();
      // The master template is untouched by the patch.
      expect((baked.logicNodes.find((l) => l.path === 'Drive-A')!.template.userData.realvirtual as { Drive: { Speed?: number } }).Drive.Speed).toBeUndefined();
      reg.release(inst);
    } finally {
      warn.mockRestore();
      resetProblemsForTests();
    }
  });

  it('trsByNodeId forces a chunk split and applies the saved TRS to the split node', async () => {
    const cache = new ModelCache(idLoader(), { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
    const key = BLOB_URL + '#trs';
    const plain = await cache.getOrLoadBaked(key);
    expect(plain.chunks.map((c) => c.key).sort()).toEqual(['mover:Drive-A', 'static']);

    const split = await cache.getOrLoadBaked(key, undefined, { forceSplitNodeIds: [PART_ID] });
    expect(split).not.toBe(plain);
    expect(split.chunks.map((c) => c.key).sort()).toEqual(['mover:Drive-A', 'mover:Part', 'static']);
    // Same request → same cached split bake; the plain one is still served too.
    expect(await cache.getOrLoadBaked(key, undefined, { forceSplitNodeIds: [PART_ID] })).toBe(split);
    expect(await cache.getOrLoadBaked(key)).toBe(plain);

    const { BakeRegistry } = await import('../src/core/engine/rv-bake-registry');
    const reg = new BakeRegistry();
    const inst = reg.instantiate(split, new Group(), {
      overrides: { byNodeId: {}, trsByNodeId: { [PART_ID]: { position: [5, 6, 7] } } },
    });
    const part = inst.logicNodes.find((n) => n.name === 'Part')!;
    expect(part.position.toArray()).toEqual([5, 6, 7]);
    expect((part as { isMesh?: boolean }).isMesh).toBeFalsy();
    const partChunk = inst.chunks.find((m) => m.name === 'mover:Part')!;
    expect(partChunk.parent).toBe(part);
    // Both bakes retire together with the base key.
    inst.root; reg.release(inst);
    cache.invalidate(key);
    expect(plain.retired).toBe(true);
    expect(split.retired).toBe(true);
    expect(split.disposed).toBe(true);
  });
});

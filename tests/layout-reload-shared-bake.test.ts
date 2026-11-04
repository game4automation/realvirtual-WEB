// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 — Reload = Planner-Instanzen (2026-09-17).
 *
 * A saved layout is `AssetReference` + `PlacementMeta` nodes. Until this change
 * the loader COMPOSED every occurrence (grafted the asset's full CAD tree under
 * the placement root) and baked the whole document in place: 13 535 masked
 * source meshes stayed in the scene graph of a 25-placement layout, five
 * separate Arburg bakes instead of one shared, 44 s instead of 12.7 s.
 *
 * Now the loader (`deferPlacements`) leaves every planner placement root EMPTY
 * and marked; the layout planner instantiates the asset's shared `BakedAsset`
 * under it — the door a live `placeComponent` takes. This file pins:
 *
 *  (a) one `BakedAsset` per asset, N instances, chunk geometry shared;
 *  (b) no source / masked mesh of an occurrence in the scene graph, no
 *      in-place bake of a mesh-less document, the reference resolver never
 *      fetches a deferred placement;
 *  (c) a reloaded placement has the node tree of a live placement of the
 *      same asset, and the live drop JOINS the reload's bake (same cache key);
 *  (d) `AssetOverrides` on the reference node apply as in
 *      `bake-lifecycle-races` (d): `trsByNodeId` forces the chunk split and
 *      the saved TRS lands on the split node — AFTER the pivot, in the frame
 *      the live tree has;
 *  (e) the records read back from the tree are the records written (save =
 *      reference + transform; the pivot never moves the root);
 *  (f) a monolith without references still takes the in-place bake;
 *  (g) the scene store's second `adoptPlacements` for the same load is a no-op.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Box3, Group, Mesh, MeshStandardMaterial, Object3D, Scene, Vector3 } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { RVViewer } from '../src/core/rv-viewer';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry, RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import {
  getDeferredPlacement, setAssetOverrides, setAssetReference, setPlacementMeta,
} from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { collectPlacementNodes } from '../src/core/hmi/scene/rv-scene-glb-read';
import { ModelCache } from '../src/plugins/layout-planner/model-cache';
import type { LibraryCatalogEntry } from '../src/plugins/layout-planner/rv-layout-store';
import { setupPlanner, internals, type PlannerHarness } from './_layout-planner-async-harness';
import { group, texturedMesh, uberMesh, withComponent } from './fixtures/bake-fixture';

// ─── Fixtures ───────────────────────────────────────────────────────────

const ASSET_URL = 'blob:rv-test/machine.glb';
const CATALOG_ID = 'cat:machine';
const PART_ID = 'nid-part';
const uber = new RVUberMaterial(false);

const ENTRY: LibraryCatalogEntry = {
  id: CATALOG_ID, name: 'Machine', category: 'machine', glbUrl: ASSET_URL, thumbnailUrl: '',
};

/** Machine: frame + Drive-A{arm} + Part(NodeId) → chunks: static, mover:Drive-A. */
function makeAsset(): Group {
  const root = group('Machine');
  root.add(uberMesh(uber, 'frame', [0, 0.5, 0]));
  const drive = withComponent(group('Drive-A'), 'Drive', { Direction: 'LinearX', TargetSpeed: 100 });
  drive.add(uberMesh(uber, 'arm', [1, 0.5, 0]));
  root.add(drive);
  const part = uberMesh(uber, 'Part', [0, 0.5, 3]);
  setNodeId(part, PART_ID);
  root.add(part);
  return root;
}

/** The planner's model cache over an in-memory decode — every load is a fresh master. */
function makeCache(decodes: { n: number }): ModelCache {
  const loader = {
    loadAsync: async (): Promise<{ scene: Group }> => { decodes.n++; return { scene: makeAsset() }; },
  } as unknown as GLTFLoader;
  return new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
}

interface PlacementSpec {
  id: string;
  name: string;
  position: [number, number, number];
  overrides?: Parameters<typeof setAssetOverrides>[1];
  /** The stored record exactly as an older file wrote it (plan-769: e.g. `trsByNodeId`). */
  rawOverrides?: Record<string, unknown>;
}

/** A layout document as the save writes it: reference + meta + transform, no geometry. */
async function documentBytes(specs: PlacementSpec[]): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  for (const s of specs) {
    const node = new Object3D();
    node.name = s.name;
    node.position.set(...s.position);
    setNodeId(node, s.id);
    setAssetReference(node, { assetId: CATALOG_ID, path: ASSET_URL });
    setPlacementMeta(node, {});
    if (s.overrides) setAssetOverrides(node, s.overrides);
    if (s.rawOverrides) (node.userData.realvirtual as Record<string, unknown>).AssetOverrides = s.rawOverrides;
    root.add(node);
  }
  return objectToGlb(root);
}

const SPECS: PlacementSpec[] = [
  { id: 'plc_1', name: 'Machine', position: [0, 0, 0] },
  { id: 'plc_2', name: 'Machine_2', position: [5, 0, 0] },
  { id: 'plc_3', name: 'Machine_3', position: [10, 0, 2] },
];

interface Loaded {
  h: PlannerHarness;
  result: LoadResult;
  registry: BakeRegistry;
  cache: ModelCache;
  decodes: { n: number };
  resolver: ReturnType<typeof vi.fn>;
}

/** Load `bytes` the way RVViewer does with the planner installed, then hand the result to the plugin. */
async function loadLayout(bytes: ArrayBuffer): Promise<Loaded> {
  // The planner's legacy autosave (localStorage) would restore the previous
  // describe's live placement into this plugin — a second, unrelated bake.
  localStorage.clear();
  const h = setupPlanner();
  const decodes = { n: 0 };
  const cache = makeCache(decodes);
  h.plugin.placements.setModelCache(cache);
  const registry = new BakeRegistry();
  const resolver = vi.fn(async () => null);

  const result = await loadGLB('layout.glb', new Scene(), {
    data: bytes.slice(0),
    referenceResolver: resolver as never,
    deferPlacements: true,
    bakeRegistry: registry,
    bakePickPort: createPickBuildPort({ createWorker: () => null }),
    loadKinematicsSidecar: false,
  });

  // What RVViewer does before the plugin hook: the root is the current model,
  // the loader's registry / signal store / transport manager are the viewer's.
  const v = h.viewer as unknown as Record<string, unknown>;
  h.viewer.scene.add(result.root);
  v.currentModel = result.root;
  v.registry = result.registry;
  v.signalStore = result.signalStore;
  v.transportManager = result.transportManager;
  v.bakeRegistry = registry;

  h.plugin.onModelLoaded(result, h.viewer as never);
  await h.plugin.whenPlacementsMaterialized();
  return { h, result, registry, cache, decodes, resolver };
}

function placementNodes(root: Object3D): Object3D[] {
  return collectPlacementNodes(root).map((e) => e.node);
}

function countNodes(node: Object3D): number {
  let n = 0;
  node.traverse(() => { n++; });
  return n;
}

function childNames(node: Object3D): string[] {
  const out: string[] = [];
  node.traverse((c) => { if (c !== node) out.push(c.name); });
  return out.sort();
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('layout reload = planner instances (plan-753)', () => {
  let L: Loaded;
  beforeAll(async () => { L = await loadLayout(await documentBytes(SPECS)); });

  it('(a) three occurrences of one asset: ONE BakedAsset, three instances, shared chunk geometry', () => {
    const stats = L.cache.getBakeStats();
    expect(stats.assets).toBe(1);
    expect(stats.instances).toBe(3);
    expect(L.decodes.n).toBe(1);
    expect(L.registry.stats().instances).toBe(3);
    expect(L.registry.stats().assets).toBe(1);

    const roots = placementNodes(L.result.root);
    expect(roots).toHaveLength(3);
    const instances = roots.map((r) => L.registry.instanceOf(r)!);
    for (const inst of instances) {
      expect(inst).not.toBeNull();
      expect(inst.identity, 'a planner occurrence is a CLONED placement').toBe(false);
      expect(inst.chunks.map((m) => m.name).sort()).toEqual(['mover:Drive-A', 'static']);
    }
    const geometriesOf = (i: typeof instances[number]): Set<unknown> => new Set(i.chunks.map((m) => m.geometry));
    expect(geometriesOf(instances[1])).toEqual(geometriesOf(instances[0]));
    expect(geometriesOf(instances[2])).toEqual(geometriesOf(instances[0]));
    // 2 chunk meshes per placement, and the registry counts exactly those.
    expect(L.registry.stats().chunkMeshes).toBe(6);
  });

  it('(b) no CAD hierarchy, nothing masked, no phantom bake, no resolver fetch', () => {
    expect(L.result.deferredPlacements).toHaveLength(3);
    expect(L.result.composition?.frames ?? []).toHaveLength(0);
    expect(L.resolver).not.toHaveBeenCalled();
    // A mesh-less document is not baked in place — no phantom instance.
    expect(L.result.bakedAsset).toBeNull();
    expect(L.result.bakeInstance).toBeNull();

    let masked = 0; let cadLeaves = 0;
    L.result.root.traverse((n) => {
      const m = n as Mesh;
      if (m.isMesh && m.layers.mask === 0) masked++;
      // 'frame' / 'arm' / 'Part' are merged into chunks: they must not exist as nodes.
      if (n.name === 'frame' || n.name === 'arm' || n.name === 'Part') cadLeaves++;
    });
    expect({ masked, cadLeaves }).toEqual({ masked: 0, cadLeaves: 0 });
    // The deferred mark is consumed.
    for (const r of placementNodes(L.result.root)) expect(getDeferredPlacement(r)).toBeNull();
  });

  it('(c) a reloaded placement has the node tree of a live placement, and the live drop joins the bake', async () => {
    const loaded = placementNodes(L.result.root)[0];
    const liveId = await L.h.plugin.placeComponent(ENTRY, [20, 0, 0]);
    expect(liveId).toBeTruthy();
    const live = internals(L.h.plugin)._objectMap.get(liveId as string)!;
    expect(live).toBeDefined();

    expect(countNodes(loaded)).toBe(countNodes(live));
    expect(childNames(loaded)).toEqual(childNames(live));
    // Same cache key → same BakedAsset, one more instance, no new decode.
    const stats = L.cache.getBakeStats();
    expect(stats.assets).toBe(1);
    expect(stats.instances).toBe(4);
    expect(L.decodes.n).toBe(1);
    expect(L.registry.instanceOf(live)!.baked).toBe(L.registry.instanceOf(loaded)!.baked);
    // Both are FULL placements: registered under their own path, layout-marked,
    // with the drive constructed by processExtras.
    const reg = L.result.registry;
    const loadedPath = reg.getPathForNode(loaded)!;
    const livePath = reg.getPathForNode(live)!;
    expect(loadedPath).toMatch(/\/Machine$/);
    // (`objectToGlb` wraps the document in an `AuxScene`; the live drop lands
    // under the model root itself, so its siblings are not the loaded ones.)
    expect(livePath).toMatch(/\/Machine(_\d+)?$/);
    expect(reg.getNode(livePath)).toBe(live);
    expect(reg.getNode(`${loadedPath}/Drive-A`)).toBeTruthy();
    expect(reg.getNode(`${livePath}/Drive-A`)).toBeTruthy();
    expect(loaded.userData._layoutObject).toBe(true);
    expect((loaded.userData.realvirtual as Record<string, unknown>).LayoutObject).toMatchObject({ CatalogId: CATALOG_ID });
    // Thawed: a placement moves as a unit (the loader froze the empty root).
    expect(loaded.matrixWorldAutoUpdate).toBe(true);
  });

  it('(e) the records read back are the records written; the pivot never moves the root', () => {
    const entries = collectPlacementNodes(L.result.root);
    expect(entries.map((e) => e.placement.id)).toEqual(['plc_1', 'plc_2', 'plc_3']);
    for (let i = 0; i < SPECS.length; i++) {
      const { node, placement } = entries[i];
      expect(placement.catalogId).toBe(CATALOG_ID);
      expect(placement.glbUrl).toBe(ASSET_URL);
      expect(placement.position).toEqual(SPECS[i].position);
      expect(node.position.toArray()).toEqual(SPECS[i].position);
      expect(node.scale.toArray()).toEqual([1, 1, 1]);
    }
    // Pivot normalisation moved the CONTENT to floor-centre, as a live drop
    // does: the placement's world box is centred (x/z) on the root and sits
    // on its floor (min.y) — the root itself did not move.
    const root = entries[0].node;
    root.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(root);
    const centre = box.getCenter(new Vector3());
    expect(Math.abs(centre.x - SPECS[0].position[0])).toBeLessThan(1e-6);
    expect(Math.abs(centre.z - SPECS[0].position[2])).toBeLessThan(1e-6);
    expect(Math.abs(box.min.y - SPECS[0].position[1])).toBeLessThan(1e-6);
  });

  it('(g) the scene store adopting the same load again is a no-op', () => {
    const before = L.cache.getBakeStats().instances;
    const entries = collectPlacementNodes(L.result.root);
    expect(L.h.plugin.adoptPlacements(entries)).toBe(3);
    expect(L.cache.getBakeStats().instances).toBe(before);
    expect(L.h.store.getSnapshot().placed.map((c) => c.id).sort()).toEqual(
      expect.arrayContaining(['plc_1', 'plc_2', 'plc_3']),
    );
  });
});

describe('(d) AssetOverrides on a deferred placement', () => {
  it('an old trsByNodeId neither splits the bake nor moves the part (plan-769 F14) — its count is a problem on the placement', async () => {
    const { getProblems, resetProblemsForTests } = await import('../src/core/hmi/problems-store');
    resetProblemsForTests();
    const L2 = await loadLayout(await documentBytes([
      { id: 'plc_o', name: 'Moved', position: [1, 0, 1],
        rawOverrides: { byNodeId: {}, trsByNodeId: { [PART_ID]: { position: [5, 6, 7] } } } },
    ]));
    const [root] = placementNodes(L2.result.root);
    const inst = L2.registry.instanceOf(root)!;
    expect(inst.chunks.map((m) => m.name)).not.toContain('mover:Part');
    // One bake per asset — no `#split:` derivative any more.
    expect(L2.cache.getBakeStats().assets).toBe(1);
    const dropped = getProblems().filter((p) => p.code === 'override-transforms-dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].title).toContain('1 moved part');
    // The placement node holds the 769 form: nothing left to store → no AssetOverrides at all.
    expect((root.userData.realvirtual as Record<string, unknown>).AssetOverrides).toBeUndefined();
    resetProblemsForTests();
  });
});

describe('(f) monolith without references', () => {
  it('still takes the in-place bake with deferPlacements on', async () => {
    const plant = group('Plant');
    plant.add(uberMesh(uber, 'Frame'));
    const drive = withComponent(group('Axis'), 'Drive', { Direction: 'LinearX', TargetSpeed: 100 });
    drive.add(uberMesh(uber, 'Arm', [2, 0, 0]));
    plant.add(drive);
    const bytes = await objectToGlb(plant);
    const registry = new BakeRegistry();
    const result = await loadGLB('plant.glb', new Scene(), {
      data: bytes, deferPlacements: true, bakeRegistry: registry,
      bakePickPort: createPickBuildPort({ createWorker: () => null }), loadKinematicsSidecar: false,
    });
    expect(result.composition).toBeNull();
    expect(result.deferredPlacements).toEqual([]);
    expect(result.bakedAsset).not.toBeNull();
    expect(result.bakeInstance?.identity).toBe(true);
    let chunks = 0;
    result.root.traverse((n) => { if (n.userData[RV_BAKE_CHUNK_KEY]) chunks++; });
    expect(chunks).toBeGreaterThan(0);
  });
});

// ─── Nachkorrektur (2026-09-17): live/reload bake parity, empty docs, queue ──
//
//  (h) a reloaded placement bakes onto the SESSION's uber material exactly as a
//      live drop does — same chunk count, same chunk keys (static / mover /
//      tex×2 for a conveyor with two textured parts), master uber-baked. The
//      uber material comes through the REAL `RVViewer.placementUberMaterial`
//      getter over the loader's result: a deferred layout has no in-place bake
//      (`bakedAsset === null`), and the getter used to answer null for it —
//      every material then became its own `tex:<uuid>` chunk (10 instead of 4).
//  (i) a document / master without geometry never publishes a BakedAsset.
//  (j) two different assets are staged one after the other (smaller first),
//      occurrences of one asset still join its in-flight bake.

const CONV_URL = 'blob:rv-test/conveyor.glb';
const CONV_ID = 'cat:conveyor';
const CONV_ENTRY: LibraryCatalogEntry = {
  id: CONV_ID, name: 'RollConveyor', category: 'conveyor', glbUrl: CONV_URL, thumbnailUrl: '',
};

function rawMesh(name: string, color: number, pos: [number, number, number]): Mesh {
  return texturedMesh(name, new MeshStandardMaterial({ color }), pos);
}

/** RollConveyor: frame + Transport-Z{belt} + two textured labels, RAW materials
 *  (what a decode yields before `bakeMasterOntoUber`). */
function makeConveyor(): Group {
  const root = group('RollConveyor');
  root.add(rawMesh('frame', 0x336699, [0, 0.5, 0]));
  const transport = group('Transport-Z');
  transport.add(rawMesh('belt', 0x222222, [0, 1, 0]));
  root.add(transport);
  root.add(texturedMesh('label1', undefined, [0, 0.5, 1]));
  root.add(texturedMesh('label2', undefined, [0, 0.5, 2]));
  return root;
}

const placementUberGetter = Object.getOwnPropertyDescriptor(RVViewer.prototype, 'placementUberMaterial')!.get!;

/** The real getter over a fake viewer state — what the planner's cache calls at decode time. */
function uberVia(state: { _lastLoadResult: Partial<LoadResult> | null }, material: RVUberMaterial): RVUberMaterial | null {
  return placementUberGetter.call({ ...state, ensureUberMaterial: () => material }) as RVUberMaterial | null;
}

interface RefSpec extends PlacementSpec {
  assetId?: string;
  path?: string;
  size?: number;
}

/** A layout document of arbitrary references (+ optional bounds), no geometry. */
async function referenceDocument(specs: RefSpec[]): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  for (const s of specs) {
    const node = new Object3D();
    node.name = s.name;
    node.position.set(...s.position);
    setNodeId(node, s.id);
    setAssetReference(node, {
      assetId: s.assetId ?? CONV_ID,
      path: s.path ?? CONV_URL,
      ...(s.size ? { bounds: { min: [0, 0, 0], max: [s.size, s.size, s.size] } } : {}),
    });
    setPlacementMeta(node, {});
    root.add(node);
  }
  return objectToGlb(root);
}

/** `loadLayout` with an injectable cache: loader → viewer wiring → plugin hook. */
async function loadWithCache(bytes: ArrayBuffer, cache: ModelCache): Promise<{ h: PlannerHarness; result: LoadResult; registry: BakeRegistry }> {
  localStorage.clear();
  const h = setupPlanner();
  h.plugin.placements.setModelCache(cache);
  const registry = new BakeRegistry();
  const result = await loadGLB('layout.glb', new Scene(), {
    data: bytes,
    referenceResolver: (async () => null) as never,
    deferPlacements: true,
    bakeRegistry: registry,
    bakePickPort: createPickBuildPort({ createWorker: () => null }),
    loadKinematicsSidecar: false,
  });
  const v = h.viewer as unknown as Record<string, unknown>;
  h.viewer.scene.add(result.root);
  v.currentModel = result.root;
  v.registry = result.registry;
  v.signalStore = result.signalStore;
  v.transportManager = result.transportManager;
  v.bakeRegistry = registry;
  return { h, result, registry };
}

describe('(h) reload bakes onto the session uber material like a live drop', () => {
  it('the real placementUberMaterial getter answers the material for a deferred layout', () => {
    const material = new RVUberMaterial(false);
    // Deferred layout: no in-place bake, but the mode bakes.
    expect(uberVia({ _lastLoadResult: { bakedAsset: null, placementBakeAllowed: true } }, material)).toBe(material);
    // Editor / merging-off load: the loader skipped the bake, so does the placement.
    expect(uberVia({ _lastLoadResult: { bakedAsset: null, placementBakeAllowed: false } }, material)).toBeNull();
    // Older LoadResult mocks without the field fall back to the in-place bake.
    expect(uberVia({ _lastLoadResult: { bakedAsset: null } }, material)).toBeNull();
  });

  it('reloaded and live placements of one asset: same chunk count and keys, master uber-baked', async () => {
    const material = new RVUberMaterial(false);
    const state: { _lastLoadResult: Partial<LoadResult> | null } = { _lastLoadResult: null };
    const loader = { loadAsync: async (): Promise<{ scene: Group }> => ({ scene: makeConveyor() }) } as unknown as GLTFLoader;
    const cache = new ModelCache(loader, {
      uber: () => uberVia(state, material),
      pickPort: () => createPickBuildPort({ createWorker: () => null }),
    });
    const { h, result, registry } = await loadWithCache(await referenceDocument([
      { id: 'cv_1', name: 'RollConveyor', position: [0, 0, 0] },
      { id: 'cv_2', name: 'RollConveyor_2', position: [3, 0, 0] },
    ]), cache);
    expect(result.bakedAsset).toBeNull();
    expect(result.placementBakeAllowed).toBe(true);
    // What RVViewer does before the plugin hook: the result is the last load.
    state._lastLoadResult = result;
    h.plugin.onModelLoaded(result, h.viewer as never);
    await h.plugin.whenPlacementsMaterialized();

    const liveId = await h.plugin.placeComponent(CONV_ENTRY, [10, 0, 0]);
    const live = internals(h.plugin)._objectMap.get(liveId as string)!;
    const [loaded] = placementNodes(result.root);
    const keysOf = (n: Object3D): string[] => registry.instanceOf(n)!.chunks.map((m) => m.name).sort();

    // 4 chunks: static (frame), mover:Transport-Z (belt), tex×2 (labels).
    const loadedKeys = keysOf(loaded);
    expect(loadedKeys).toHaveLength(4);
    expect(loadedKeys).toEqual(keysOf(live));
    expect(loadedKeys.filter((k) => k === 'static')).toHaveLength(1);
    expect(loadedKeys.filter((k) => k === 'mover:Transport-Z')).toHaveLength(1);
    expect(loadedKeys.filter((k) => k.startsWith('tex:'))).toHaveLength(2);
    expect(registry.instanceOf(live)!.baked).toBe(registry.instanceOf(loaded)!.baked);
    expect(cache.getBakeStats()).toMatchObject({ assets: 1, chunks: 4, instances: 3 });

    // The master is uber-baked: its untextured meshes carry the session material.
    const master = cache.peekBaked(CONV_URL)!.template;
    let onUber = 0; let textured = 0;
    master.traverse((n) => {
      const m = n as Mesh;
      if (!m.isMesh) return;
      if (m.material === material) onUber++; else textured++;
    });
    expect({ onUber, textured }).toEqual({ onUber: 2, textured: 2 });
  });
});

describe('(i) a document without geometry publishes no BakedAsset', () => {
  it('the loader does not bake an empty document in place', async () => {
    const empty = new Group();
    empty.name = 'Layout';
    empty.add(new Object3D());
    const registry = new BakeRegistry();
    const result = await loadGLB('empty.glb', new Scene(), {
      data: await objectToGlb(empty), deferPlacements: true, bakeRegistry: registry,
      bakePickPort: createPickBuildPort({ createWorker: () => null }), loadKinematicsSidecar: false,
    });
    expect(result.bakedAsset).toBeNull();
    expect(result.bakeInstance).toBeNull();
    expect(result.placementBakeAllowed).toBe(true);
    expect(registry.stats().assets).toBe(0);
  });

  it('the model cache does not keep a mesh-less master as a baked asset', async () => {
    const loader = { loadAsync: async (): Promise<{ scene: Group }> => ({ scene: group('Nothing') }) } as unknown as GLTFLoader;
    const cache = new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
    const baked = await cache.getOrLoadBaked('blob:rv-test/nothing.glb');
    expect(baked.chunks).toHaveLength(0);
    expect(cache.getBakeStats().assets).toBe(0);
    expect(cache.peekBaked('blob:rv-test/nothing.glb')).toBeUndefined();
  });
});

describe('(j) deferred placements of different assets are staged one asset at a time', () => {
  it('never runs two bakes at once; occurrences of one asset join; smaller asset first', async () => {
    const decodeOrder: string[] = [];
    const inflightAtDecode: number[] = [];
    let cache!: ModelCache;
    const loader = {
      loadAsync: async (url: string): Promise<{ scene: Group }> => {
        decodeOrder.push(url);
        inflightAtDecode.push(cache.getBakeStats().inflight);
        // Yield like a real decode does, so a concurrent bake would show up.
        await new Promise((r) => setTimeout(r, 0));
        return { scene: url === CONV_URL ? makeConveyor() : makeAsset() };
      },
    } as unknown as GLTFLoader;
    cache = new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });

    // Machine (big bounds) ×2 and Conveyor (small bounds) ×2, machine first in the document.
    const { h, result, registry } = await loadWithCache(await referenceDocument([
      { id: 'm_1', name: 'Machine', position: [0, 0, 0], assetId: CATALOG_ID, path: ASSET_URL, size: 5 },
      { id: 'c_1', name: 'RollConveyor', position: [5, 0, 0], size: 1 },
      { id: 'm_2', name: 'Machine_2', position: [10, 0, 0], assetId: CATALOG_ID, path: ASSET_URL, size: 5 },
      { id: 'c_2', name: 'RollConveyor_2', position: [15, 0, 0], size: 1 },
    ]), cache);
    h.plugin.onModelLoaded(result, h.viewer as never);
    await h.plugin.whenPlacementsMaterialized();

    // One decode per asset, conveyor (smaller) first, and at no decode was
    // another asset's bake in flight (`_sharedBake` registers its own job
    // only after `_bake` has issued the decode, so the current one is not
    // counted — without the queue the machine's decode would see 1).
    expect(decodeOrder).toEqual([CONV_URL, ASSET_URL]);
    expect(inflightAtDecode).toEqual([0, 0]);
    expect(cache.getBakeStats()).toMatchObject({ assets: 2, instances: 4, inflight: 0 });
    expect(registry.stats().instances).toBe(4);
    for (const n of placementNodes(result.root)) expect(registry.instanceOf(n)).not.toBeNull();
  });
});

describe('(k) the planner follows late placements incrementally (scene-ready contract)', () => {
  it('a placement whose bake lands late re-schedules the snap pairing and joins the id map by itself', async () => {
    let openMachine!: () => void;
    const machineGate = new Promise<void>((r) => { openMachine = r; });
    const loader = {
      loadAsync: async (url: string): Promise<{ scene: Group }> => {
        if (url === ASSET_URL) await machineGate;
        return { scene: url === CONV_URL ? makeConveyor() : makeAsset() };
      },
    } as unknown as GLTFLoader;
    const cache = new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
    const { h, result } = await loadWithCache(await referenceDocument([
      { id: 'c_1', name: 'RollConveyor', position: [5, 0, 0], size: 1 },
      { id: 'm_1', name: 'Machine', position: [0, 0, 0], assetId: CATALOG_ID, path: ASSET_URL, size: 5 },
    ]), cache);
    const schedule = vi.spyOn(h.plugin as unknown as { _scheduleSnapPairingRebuild(): void }, '_scheduleSnapPairingRebuild');
    h.plugin.onModelLoaded(result, h.viewer as never);

    // The conveyor lands; the machine is still gated.
    await vi.waitFor(() => expect(h.plugin.getPlacedRootById('c_1')).toBeTruthy());
    expect(h.plugin.getPlacedRootById('m_1')).toBeFalsy();
    expect(h.plugin.placements.state).toBe('materializing');
    const callsBeforeLate = schedule.mock.calls.length;

    openMachine();
    await h.plugin.whenPlacementsMaterialized();
    // No consumer had to wait for "all": the late registration pulled the
    // pairing rebuild (and the id map) along — that is why the planner's snap
    // pairing needs no `whenSceneReady()`.
    expect(schedule.mock.calls.length).toBeGreaterThan(callsBeforeLate);
    expect(h.plugin.getPlacedRootById('m_1')).toBeTruthy();
    expect(h.plugin.placements.state).toBe('idle');
  });
});

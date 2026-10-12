// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 structure hardening (2026-09-17) — ONE placement primitive.
 *
 * Every way a placed reference becomes an instance in the scene graph goes
 * through `PlacementInstancer.resolveBaked` + `materialize`
 * (`core/engine/rv-placement-instancer.ts`). This file pins that as ONE
 * parametrised table: each entry — floor drop, snap drop, duplicate, draft
 * swap, restore / undo (`placeFromRecord`), reload (deferred) — must produce,
 * for the same asset, a structurally identical instance of the SAME
 * `BakedAsset`. A new entry that bypasses the primitive fails here at once:
 * add it to `ENTRIES`, and the source guard at the bottom catches a direct
 * `bakeRegistry.instantiate(` in the planner.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Group, Mesh, Object3D, Scene } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry, type PlacementInstance } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { setAssetReference, setPlacementMeta } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { SnapPointRegistry } from '../src/core/engine/rv-snap-point-registry';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import {
  PlacementInstancer, collectDeferredPlacements, recordRootOf, isPlacementRoot, isNestedPlacementRoot, nestedPlacementIdOf,
  type DeferredPlacementEntry, type PlacementInstancerDeps,
} from '../src/core/engine/rv-placement-instancer';
import { MAX_REFERENCE_DEPTH, getAssetReference, getPlacementMeta } from '../src/core/engine/rv-asset-reference';
import { claimsNodeOf } from '../src/core/engine/rv-component-registry';
import { isMissingReferencePlaceholder } from '../src/core/engine/rv-missing-reference-placeholder';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import type { LibraryCatalogEntry, PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';
import { setupPlanner, internals, flush, type PlannerHarness } from './_layout-planner-async-harness';
import { group, uberMesh, withComponent } from './fixtures/bake-fixture';
import {
  INNER_URL, OUTER_URL, OUTER_HAND_URL, SELF_URL, CYC_A_URL, CYC_B_URL, MANY_URL, MANY_REFS, DEPTH_URL, DOC_URL, ROOT_CYCLE_URL,
  CELL_REF_NODE_ID, bootNestedViewer, makeFakeLoader, makeOuter, makeInner, tick, findByName as findNested,
  documentBytes as nestedDocumentBytes, plainBytes as nestedPlainBytes, type Booted,
} from './helpers/nested-placement-fixture';

// ─── Fixture ────────────────────────────────────────────────────────────

const ASSET_URL = 'blob:rv-test/instancer-machine.glb';
const CATALOG_ID = 'cat:instancer-machine';
const PART_ID = 'nid-instancer-part';
const uber = new RVUberMaterial(false);

const ENTRY: LibraryCatalogEntry = {
  id: CATALOG_ID, name: 'Machine', category: 'machine', glbUrl: ASSET_URL, thumbnailUrl: '',
};

/** Asymmetric on purpose (pivot offset ≠ 0): frame + Drive-A{arm} + Part + two snap ports. */
function makeAsset(): Group {
  const root = group('Machine');
  root.add(uberMesh(uber, 'frame', [0, 0.5, 0]));
  const drive = withComponent(group('Drive-A'), 'Drive', { Direction: 'LinearX', TargetSpeed: 100 });
  drive.add(uberMesh(uber, 'arm', [3, 0.5, 0]));
  root.add(drive);
  const part = uberMesh(uber, 'Part', [0, 0.5, 2]);
  setNodeId(part, PART_ID);
  root.add(part);
  for (const [name, x] of [['Snap-XP-conv', 4], ['Snap-XN-conv', -1]] as const) {
    const snap = new Object3D();
    snap.name = name;
    snap.position.set(x, 0.5, 0);
    root.add(snap);
  }
  return root;
}

async function layoutBytes(id: string): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  const node = new Object3D();
  node.name = 'Machine';
  node.position.set(0, 0, 0);
  setNodeId(node, id);
  setAssetReference(node, { assetId: CATALOG_ID, path: ASSET_URL });
  setPlacementMeta(node, {});
  root.add(node);
  return objectToGlb(root);
}

interface World {
  h: PlannerHarness;
  registry: BakeRegistry;
  snaps: SnapPointRegistry;
  decodes: { n: number };
  /** The reloaded (deferred) placement root — the first instance of the asset. */
  reloaded: Object3D;
}

/** A planner over a loaded layout document with ONE deferred occurrence, snap registry wired. */
async function makeWorld(): Promise<World> {
  localStorage.clear();
  const h = setupPlanner();
  const decodes = { n: 0 };
  const loader = {
    loadAsync: async (): Promise<{ scene: Group }> => { decodes.n++; return { scene: makeAsset() }; },
  } as unknown as GLTFLoader;
  h.plugin.placements.setModelCache(new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) }));

  const registry = new BakeRegistry();
  const snaps = new SnapPointRegistry();
  h.viewer.getPlugin.mockImplementation((id?: string) =>
    (id === 'snap-point' ? { getRegistry: () => snaps, getMarkerRenderer: () => null } : undefined) as never);

  const result = await loadGLB('layout.glb', new Scene(), {
    data: await layoutBytes('plc_reload'),
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

  h.plugin.onModelLoaded(result, h.viewer as never);
  await h.plugin.whenPlacementsMaterialized();
  const reloaded = internals(h.plugin)._objectMap.get('plc_reload')!;
  expect(reloaded, 'the deferred occurrence was adopted').toBeDefined();
  return { h, registry, snaps, decodes, reloaded };
}

// ─── The table: every entry that makes an instance ─────────────────────

interface EntryCase {
  name: string;
  /** Produce ONE more placement of the asset; resolve to its root. */
  place(w: World): Promise<Object3D>;
}

function rootOf(w: World, id: string | null | undefined): Object3D {
  expect(id, 'the entry returned a placement id').toBeTruthy();
  const node = internals(w.h.plugin)._objectMap.get(id as string);
  expect(node, `placement ${id} is in the id map`).toBeDefined();
  return node!;
}

const ENTRIES: EntryCase[] = [
  {
    name: 'reload (deferred AssetReference)',
    place: async (w) => w.reloaded,
  },
  {
    name: 'placeComponent (floor drop)',
    place: async (w) => rootOf(w, await w.h.plugin.placeComponent(ENTRY, [10, 0, 0])),
  },
  {
    name: 'placeAtSnap (snap drop)',
    place: async (w) => {
      const target = w.snaps.getAll().find((sp) => sp.ownerRoot === w.reloaded && sp.object3D.name === 'Snap-XP-conv');
      expect(target, 'the reloaded placement published its XP port').toBeDefined();
      return rootOf(w, await w.h.plugin.placeAtSnap(ENTRY, target!, 'Snap-XN-conv'));
    },
  },
  {
    name: 'duplicate / paste (_clonePlacement)',
    place: async (w) => {
      const original = w.h.store.getSnapshot().placed.find((c) => c.id === 'plc_reload')!;
      return rootOf(w, await internals(w.h.plugin)._clonePlacement(original));
    },
  },
  {
    name: 'draft swap (placeholder → _runPendingLoad)',
    place: async (w) => {
      // Force the COLD branch of `_startGlbDraft` (placeholder + pending swap)
      // while the pending load itself resolves from the warm document cache.
      const peek = vi.spyOn(w.h.plugin.placements, 'peekBaked').mockReturnValue(undefined);
      const p = internals(w.h.plugin);
      try {
        await p._startDraft(ENTRY);
        expect(p._draft?.node.userData._rvPendingPlaceholder, 'the draft started as a placeholder').toBeTruthy();
      } finally {
        peek.mockRestore();
      }
      p._moveDraft(20, 0);
      const id = await p._commitDraft(ENTRY, [20, 0]);
      await flush(12);
      const node = rootOf(w, id);
      expect(node.userData._rvPendingPlaceholder, 'the swap happened').toBeFalsy();
      return node;
    },
  },
  {
    name: 'placeFromRecord (restore / undo / op replay)',
    place: async (w) => {
      const rec: PlacedComponent = {
        id: 'plc_record', catalogId: CATALOG_ID, glbUrl: ASSET_URL, label: 'Machine',
        position: [30, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
      };
      await w.h.plugin.placeFromRecord(rec);
      return rootOf(w, rec.id);
    },
  },
];

/** Everything about an instance that must not depend on the entry that made it. */
function signatureOf(registry: BakeRegistry, root: Object3D): {
  instance: PlacementInstance;
  nodes: string[];
  chunkKeys: string[];
  childPositions: Record<string, number[]>;
} {
  const instance = registry.instanceOf(root)!;
  expect(instance, 'the placement root is a bake instance').not.toBeNull();
  const nodes: string[] = [];
  const walk = (node: Object3D, path: string): void => {
    for (const child of node.children) {
      // Host decorations (pending pulse, gizmos) are not part of the instance.
      if (child.userData._rvGizmo || child.userData._highlightOverlay) continue;
      const p = `${path}/${child.name}`;
      nodes.push(`${p}:${child.type}`);
      walk(child, p);
    }
  };
  walk(root, '');
  const childPositions: Record<string, number[]> = {};
  for (const child of root.children) {
    if (child.userData._rvGizmo || child.userData._highlightOverlay) continue;
    childPositions[child.name] = child.position.toArray().map((n) => Math.round(n * 1e6) / 1e6);
  }
  return { instance, nodes: nodes.sort(), chunkKeys: instance.chunks.map((m) => m.name).sort(), childPositions };
}

describe('one placement primitive — every entry makes the same instance (plan-753)', () => {
  let w: World;
  let reference: ReturnType<typeof signatureOf>;
  const made = new Map<string, Object3D>();

  beforeAll(async () => {
    w = await makeWorld();
    reference = signatureOf(w.registry, w.reloaded);
    // Sequentially — each entry adds one more instance to the same document.
    for (const entry of ENTRIES) made.set(entry.name, await entry.place(w));
  });

  it('the reference instance is a real one (chunks, mover split, snap ports, pivot shift)', () => {
    expect(reference.chunkKeys).toEqual(['mover:Drive-A', 'static']);
    expect(reference.nodes).toEqual(expect.arrayContaining([
      '/Drive-A:Group', '/Snap-XN-conv:Group', '/Snap-XP-conv:Group', '/static:Mesh',
    ]));
    // The asset is asymmetric: the floor-centre pivot moved the content.
    expect(reference.childPositions['Snap-XP-conv'][0]).not.toBe(4);
  });

  it.each(ENTRIES.map((e) => e.name))('%s → same BakedAsset, same structure, same pivot, same markers', (name) => {
    const root = made.get(name)!;
    const sig = signatureOf(w.registry, root);

    // The SAME bake — one cache key derivation, one bake per (asset, document).
    expect(sig.instance.baked).toBe(reference.instance.baked);
    expect(sig.instance.identity).toBe(false);
    // Node names + types, chunk keys.
    expect(sig.nodes).toEqual(reference.nodes);
    expect(sig.chunkKeys).toEqual(reference.chunkKeys);
    // Chunk GEOMETRY identity: shared with the asset, never cloned per entry.
    const geometries = (i: PlacementInstance): Set<unknown> => new Set(i.chunks.map((m) => m.geometry));
    expect(geometries(sig.instance)).toEqual(geometries(reference.instance));
    // Pivot offset: the content sits in the same frame under every root.
    expect(sig.childPositions).toEqual(reference.childPositions);

    // Markers + flags the primitive stamps.
    expect(root.userData._layoutObject).toBe(true);
    expect(typeof root.userData._layoutId).toBe('string');
    expect((root.userData.realvirtual as Record<string, { CatalogId?: string }>).LayoutObject.CatalogId).toBe(CATALOG_ID);
    expect(root.userData._originalName).toBe('Machine');
    expect(root.matrixAutoUpdate).toBe(true);
    root.traverse((n) => { expect(n.userData._layoutObject, `${n.name} is layout-marked`).toBe(true); });
    for (const chunk of sig.instance.chunks) {
      expect(chunk.receiveShadow).toBe(true);
      expect((chunk as Mesh).castShadow).toBe((reference.instance.chunks.find((c) => c.name === chunk.name) as Mesh).castShadow);
    }

    // FULL registration, identically: the Drive of the occurrence exists under its path.
    const reg = (w.h.viewer as unknown as { registry: { getPathForNode(n: Object3D): string | null; getNode(p: string): Object3D | null } }).registry;
    const path = reg.getPathForNode(root);
    expect(path, 'registered under its own path').toBeTruthy();
    expect(reg.getNode(`${path}/Drive-A`)).toBeTruthy();
  });

  it('all entries together: ONE decode, ONE BakedAsset, one instance per entry', () => {
    expect(w.decodes.n).toBe(1);
    const stats = w.h.plugin.getBakeStats();
    expect(stats.assets).toBe(1);
    expect(stats.instances).toBe(ENTRIES.length);
    expect(new Set(made.values()).size).toBe(ENTRIES.length);
  });
});

describe('PlacementInstancer — the primitive itself', () => {
  function makeInstancer(): { instancer: PlacementInstancer; registry: BakeRegistry; renderMode: ReturnType<typeof vi.fn> } {
    const registry = new BakeRegistry();
    const renderMode = vi.fn();
    const loader = { loadAsync: async () => ({ scene: makeAsset() }) } as unknown as GLTFLoader;
    const instancer = new PlacementInstancer({
      bakeRegistry: () => registry, loader, uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }), applyRenderMode: renderMode,
    });
    return { instancer, registry, renderMode };
  }

  it('one key derivation: url wins over glbUrl, a bundled library path is re-rooted, no source → null', () => {
    const { instancer } = makeInstancer();
    expect(instancer.sourceOf({ catalogId: 'a', glbUrl: 'https://x.invalid/a.glb' })?.key).toBe('https://x.invalid/a.glb');
    expect(instancer.sourceOf({ catalogId: 'a', glbUrl: 'blob:dead', url: 'blob:fresh' })?.key).toBe('blob:fresh');
    const base = import.meta.env.BASE_URL ?? '/';
    const rooted = (base.endsWith('/') ? base : base + '/') + 'library/conv/Belt.glb';
    expect(instancer.sourceOf({ catalogId: 'a', glbUrl: '/models/library/conv/Belt.glb' })?.key).toBe(rooted);
    expect(instancer.sourceOf({ catalogId: 'a', glbUrl: rooted })?.key).toBe(rooted);
    expect(instancer.sourceOf({ catalogId: 'project:library/Nope.glb', glbUrl: '' })).toBeNull();
    expect(instancer.sourceOf({ catalogId: 'nothing', glbUrl: '' })).toBeNull();
  });

  it('materialize applies overrides AFTER the pivot, and pivot:false keeps the authored frame', async () => {
    const { instancer, renderMode } = makeInstancer();
    const ref = { catalogId: CATALOG_ID, glbUrl: ASSET_URL };
    const trs: [number, number, number] = [5, 6, 7];

    const split = await instancer.resolveBaked(ref, { forceSplitNodeIds: [PART_ID] });
    const moved = instancer.createRoot(split);
    const inst = instancer.materialize(moved, split, {
      id: 'a', label: 'A', catalogId: CATALOG_ID,
      overrides: { byNodeId: {}, trsByNodeId: { [PART_ID]: { position: trs } } },
    });
    expect(inst.logicNodes.find((n) => n.name === 'Part')!.position.toArray()).toEqual(trs);
    expect(renderMode).toHaveBeenCalledWith(moved);

    const baked = await instancer.resolveBaked(ref);
    const raw = instancer.createRoot(baked);
    instancer.materialize(raw, baked, { id: 'b', label: 'B', catalogId: CATALOG_ID, pivot: false });
    expect(raw.children.find((c) => c.name === 'Snap-XP-conv')!.position.x).toBe(4);

    expect(instancer.release(raw)).toBe(true);
    expect(instancer.release(raw)).toBe(false);
  });

  it('whenMaterialized resolves on a document change; the orphaned materialisation writes nothing', async () => {
    const registry = new BakeRegistry();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const loader = { loadAsync: async () => { await gate; return { scene: makeAsset() }; } } as unknown as GLTFLoader;
    const register = vi.fn();
    const instancer = new PlacementInstancer({
      bakeRegistry: () => registry, loader, uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }), registerDefault: register,
    });
    const result = await loadGLB('layout.glb', new Scene(), {
      data: await layoutBytes('plc_orphan'), referenceResolver: (async () => null) as never,
      deferPlacements: true, bakeRegistry: registry, bakePickPort: createPickBuildPort({ createWorker: () => null }), loadKinematicsSidecar: false,
    });
    const entries = collectDeferredPlacements(result.root);
    expect(entries).toHaveLength(1);
    expect(instancer.materializeDeferred(entries)).toBe(1);
    // Claimed once: a second ask for the same load queues nothing.
    expect(instancer.materializeDeferred(collectDeferredPlacements(result.root))).toBe(0);

    const idle = instancer.whenMaterialized();
    instancer.clearDocument();
    await idle; // resolves although the decode is still gated
    release();
    await flush(12);
    expect(register).not.toHaveBeenCalled();
    expect(registry.stats().instances).toBe(0);
    expect(entries[0].node.children).toHaveLength(0);
  });
});

describe('source guard — only the core instantiates', () => {
  it('no `.instantiate(` call in src/plugins/layout-planner/', async () => {
    const sources = import.meta.glob('../src/plugins/layout-planner/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      // Strip comments: the docs may NAME the call, the code must not make it.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/\.instantiate(InPlace)?\s*\(/.test(code)) offenders.push(file);
    }
    expect(offenders, 'placement = resolveBaked + materialize (rv-placement-instancer.ts)').toEqual([]);
  });

  it('no `.instantiate(` call in src/core/engine/perf/ (plan-492)', async () => {
    // The cell-matrix benchmark builds placements too, and a benchmark that
    // reached past `materialize()` would measure a path no customer runs.
    const sources = import.meta.glob('../src/core/engine/perf/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/\.instantiate(InPlace|Template)?\s*\(/.test(code)) offenders.push(file);
    }
    expect(offenders, 'placement = resolveBaked + materialize (rv-placement-instancer.ts)').toEqual([]);
  });

  it('the planner derives no bake key of its own', async () => {
    const planner = (await import('../src/plugins/layout-planner/index.ts?raw')).default as string;
    for (const gone of ['_instantiateBaked', '_bakedForPlacement', '_bakeKeyOf', 'materializeDeferredPlacement', 'getOrLoadBaked(']) {
      expect(planner, `${gone} is gone from the planner`).not.toContain(gone);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// plan-757 Phase 2 — a reference is a placement, always (F8), on every entry
// ═══════════════════════════════════════════════════════════════════════

describe('nested references are placements (plan-757 Phase 2)', () => {
  let booted: Booted | null = null;
  afterEach(() => {
    booted?.h.dispose();
    booted = null;
    resetProblemsForTests();
  });
  beforeEach(() => resetProblemsForTests());

  async function bootNested(opts?: Parameters<typeof bootNestedViewer>[0]): Promise<Booted> {
    booted = await bootNestedViewer(opts);
    return booted;
  }

  it('a reference node inside a placed asset becomes a placement of its own: instance, path, drive, motion (spike S2 finding 1)', async () => {
    const { h, added } = await bootNested();
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([{ id: 'plc-machine', name: 'Machine_1', url: OUTER_URL }]) });
    await h.viewer.whenSceneReady();

    const root = h.viewer.currentModelRoot!;
    const outer = findNested(root, 'Machine_1')!;
    const nested = findNested(root, 'Cell_1')!;
    expect(nested.parent).toBe(outer);

    // The template of the OUTER asset carries the reference node, EMPTY — the
    // recipe keeps it (`AssetReference` claims its node, F15).
    expect(claimsNodeOf('AssetReference')).toBe(true);
    const outerInstance = h.viewer.bakeRegistry.instanceOf(outer)!;
    const templateRef = findNested(outerInstance.baked.template, 'Cell_1')!;
    expect(getPlacementMeta(templateRef)).not.toBeNull();
    expect(getAssetReference(templateRef)?.path).toBe(INNER_URL);
    expect(templateRef.children).toHaveLength(0);
    // F3: the asset knows the url its bytes came from.
    expect(outerInstance.baked.url).toBe(OUTER_URL);

    // The nested reference node IS an instance of the inner asset now.
    const nestedInstance = h.viewer.bakeRegistry.instanceOf(nested);
    expect(nestedInstance).not.toBeNull();
    expect(nestedInstance!.baked.assetId).toBe(INNER_URL);
    expect(nestedInstance!.chunks.length).toBeGreaterThan(0);
    expect(nestedInstance!.chainState).toBe('none');
    expect(h.viewer.bakeRegistry.stats().instances).toBe(2);
    expect(added.map((r) => r.name)).toEqual(['Machine_1', 'Cell_1']);

    // Registered by path, drive known to the viewer, and it MOVES.
    const slide = findNested(nested, 'Slide')!;
    const slidePath = h.viewer.registry!.getPathForNode(slide)!;
    expect(slidePath).toMatch(/Machine_1\/Cell_1\/Slide$/);
    expect(h.viewer.registry!.getComponentTypes(slidePath)).toContain('Drive');
    const x0 = slide.position.x;
    tick(h, 60);
    // 200 mm/s × 1 s; `LinearX` forward is −x in three.js (Unity axis flip), so the magnitude is what counts.
    expect(Math.abs(slide.position.x - x0)).toBeGreaterThan(0.1);
  });

  it('F5: a nested root is CONTENT — `_layoutNestedOf`, never `_layoutId`; recordRootOf climbs to the record, isPlacementRoot sees both', async () => {
    const { h } = await bootNested();
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([{ id: 'plc-machine', name: 'Machine_1', url: OUTER_URL }]) });
    await h.viewer.whenSceneReady();
    const root = h.viewer.currentModelRoot!;
    const outer = findNested(root, 'Machine_1')!;
    const nested = findNested(root, 'Cell_1')!;
    const slide = findNested(nested, 'Slide')!;

    expect(outer.userData._layoutId).toBe('plc-machine');
    expect(outer.userData._layoutNestedOf).toBeUndefined();
    expect(nested.userData._layoutObject).toBe(true);
    expect(nested.userData._layoutNestedOf).toBe('plc-machine');
    expect(nested.userData._layoutId).toBeUndefined();
    expect((nested.userData.realvirtual as Record<string, unknown>).LayoutObject, 'no planner record stamp on content').toBeUndefined();

    expect(recordRootOf(slide)).toBe(outer);
    expect(recordRootOf(nested)).toBe(outer);
    expect(recordRootOf(outer)).toBe(outer);
    expect(recordRootOf(root)).toBeNull();
    expect(isPlacementRoot(outer)).toBe(true);
    expect(isPlacementRoot(nested)).toBe(true);
    expect(isNestedPlacementRoot(nested)).toBe(true);
    expect(isPlacementRoot(slide)).toBe(false);
    // The innermost placement of a picked node stays the nested one (Decision 7).
    expect(h.viewer.bakeRegistry.placementOf(slide)).toBe(nested);
  });

  it('spike S2 finding 3: a nested PLANNER reference is floor-centre pivoted, a HAND-AUTHORED one keeps its child transforms', async () => {
    const { h } = await bootNested();
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([
      { id: 'plc-a', name: 'Machine_1', url: OUTER_URL, pos: [10, 0, 0] },
      { id: 'plc-b', name: 'Machine_2', url: OUTER_HAND_URL, pos: [30, 0, 0] },
    ]) });
    await h.viewer.whenSceneReady();
    const root = h.viewer.currentModelRoot!;
    const planner = findNested(findNested(root, 'Machine_1')!, 'Slide')!;
    // Authored at x = 2; AABB centroid x = 2 → shifted to 0.
    expect(planner.position.x).toBeCloseTo(0, 5);
    expect(planner.position.y).toBeCloseTo(0.5, 5);
    const ref = findNested(root, 'CellRef')!;
    expect(h.viewer.bakeRegistry.instanceOf(ref), 'a hand-authored reference is a placement too').not.toBeNull();
    const hand = findNested(ref, 'Slide')!;
    expect(hand.position.x).toBeCloseTo(2, 5);
    expect(hand.position.y).toBeCloseTo(0.5, 5);
  });

  it('F13: a self-reference under ANOTHER catalog id is a cycle (one key: sourceOf) — placeholder + problem, scene ready', async () => {
    const { h, settled } = await bootNested();
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([{ id: 'plc-self', name: 'Self_0', url: SELF_URL }]) });
    await h.viewer.whenSceneReady();
    expect(h.viewer.bakeRegistry.stats().instances).toBe(1);
    const inner = findNested(h.viewer.currentModelRoot!, 'Self_1')!;
    // F9: the hole you can see — a labelled placeholder, not a bare empty node …
    expect(inner.children).toHaveLength(1);
    expect(isMissingReferencePlaceholder(inner.children[0])).toBe(true);
    expect(inner.children[0].name).toContain('reference cycle');
    // … and still a reference node, nothing else (nothing of it is ever saved).
    expect(getAssetReference(inner)?.assetId).toBe('cat:ouroboros-alias');
    const problems = getProblems().filter((p) => p.code === 'reference-cycle');
    expect(problems).toHaveLength(1);
    expect(problems[0].nodePath).toBe(h.viewer.registry!.getPathForNode(inner));
    // The chain is spelled in the ONE key derivation — the url, not the two catalog ids.
    expect(problems[0].detail).toContain(`${SELF_URL} → ${SELF_URL}`);
    expect(problems[0].detail).not.toContain('cat:ouroboros-alias →');
    expect(settled).toEqual([{ aborted: false, total: 1, materialized: 1, missing: 0 }]);
  });

  it('an indirect cycle A → B → A: two instances, the third refused', async () => {
    const { h } = await bootNested();
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([{ id: 'plc-a', name: 'A_0', url: CYC_A_URL }]) });
    await h.viewer.whenSceneReady();
    expect(h.viewer.bakeRegistry.stats().instances).toBe(2);
    const problems = getProblems().filter((p) => p.code === 'reference-cycle');
    expect(problems).toHaveLength(1);
    expect(problems[0].detail).toContain(`${CYC_A_URL} → ${CYC_B_URL} → ${CYC_A_URL}`);
  });

  it('F13: the document is the first link of the chain — an asset that references the document back is a cycle', async () => {
    const { h } = await bootNested();
    await h.viewer.loadModel(DOC_URL, { data: await nestedDocumentBytes([{ id: 'plc-boom', name: 'Boomerang_1', url: ROOT_CYCLE_URL }]) });
    await h.viewer.whenSceneReady();
    expect(h.viewer.placements.documentKey).toBe(DOC_URL);
    expect(h.viewer.bakeRegistry.stats().instances).toBe(1);
    const problems = getProblems().filter((p) => p.code === 'reference-cycle');
    expect(problems).toHaveLength(1);
    expect(problems[0].detail).toContain(`${DOC_URL} → ${ROOT_CYCLE_URL} → ${DOC_URL}`);
    // The document's own key never leaked into the loader.
    expect(booted!.decodes).not.toContain(DOC_URL);
  });

  it(`nesting deeper than MAX_REFERENCE_DEPTH (${MAX_REFERENCE_DEPTH}) is refused with a depth problem and a placeholder`, async () => {
    const { h } = await bootNested();
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([{ id: 'plc-d1', name: 'Depth1_0', url: DEPTH_URL(1) }]) });
    await h.viewer.whenSceneReady();
    // depth-1 at depth 0 … depth-17 at depth 16 are placed; depth-18 (depth 17) is refused.
    expect(h.viewer.bakeRegistry.stats().instances).toBe(MAX_REFERENCE_DEPTH + 1);
    const problems = getProblems().filter((p) => p.code === 'reference-depth');
    expect(problems).toHaveLength(1);
    expect(problems[0].nodePath).toMatch(/Depth18_1$/);
    const refused = h.viewer.registry!.getNode(problems[0].nodePath!)!;
    expect(refused.children.some(isMissingReferencePlaceholder)).toBe(true);
    expect(getProblems().filter((p) => p.code === 'reference-cycle')).toHaveLength(0);
  });

  it('F9: the cap stops NESTED queueing — ONE aggregated problem (count + first paths), refused nodes stay empty', async () => {
    const { h, settled } = await bootNested({ maxPlacementsPerLoad: 4 });
    expect(h.viewer.placements.maxPlacementsPerLoad).toBe(4);
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([{ id: 'plc-many', name: 'Many_1', url: MANY_URL }]) });
    await h.viewer.whenSceneReady();
    // 1 outer + 3 nested = 4 = cap; MANY_REFS − 3 refused.
    expect(h.viewer.bakeRegistry.stats().instances).toBe(4);
    const problems = getProblems().filter((p) => p.code === 'placement-cap');
    expect(problems).toHaveLength(1);
    expect(problems[0].severity).toBe('warning');
    expect(problems[0].title).toContain(`${MANY_REFS - 3} nested reference(s)`);
    expect(problems[0].detail).toContain('more than 4 placements');
    // Refused reference nodes are named, and stay EMPTY (no placeholder for a cap).
    for (let i = 4; i <= MANY_REFS; i++) {
      const node = findNested(h.viewer.currentModelRoot!, `Cell_${i}`)!;
      expect(h.viewer.bakeRegistry.instanceOf(node)).toBeNull();
      expect(node.children).toHaveLength(0);
      expect(problems[0].detail).toContain(h.viewer.registry!.getPathForNode(node)!);
    }
    expect(settled).toEqual([{ aborted: false, total: 4, materialized: 4, missing: 0 }]);
  });

  it('N outer instances × M nested references: ONE bake per asset, ids qualified per instance', async () => {
    const { h, settled } = await bootNested();
    const N = 3;
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes(
      Array.from({ length: N }, (_, i) => ({ id: `plc-many-${i + 1}`, name: `Many_${i + 1}`, url: MANY_URL, pos: [i * 30, 0, 0] as [number, number, number] })),
    ) });
    await h.viewer.whenSceneReady();
    expect(h.viewer.bakeRegistry.stats().instances).toBe(N + N * MANY_REFS);
    // Two assets baked in total (Many + Cell), whatever N × M is.
    expect(h.viewer.placements.getBakeStats().assets).toBe(2);
    expect(settled).toEqual([{ aborted: false, total: N + N * MANY_REFS, materialized: N + N * MANY_REFS, missing: 0 }]);
    expect(getProblems()).toHaveLength(0);
    // Every nested Slide is its own drive, addressable by its own path.
    const slides: string[] = [];
    h.viewer.currentModelRoot!.traverse((n) => { if (n.name === 'Slide') slides.push(h.viewer.registry!.getPathForNode(n) ?? '?'); });
    expect(new Set(slides).size).toBe(N * MANY_REFS);
    expect(h.viewer.drives.length).toBe(N * MANY_REFS);
  });

  it('F4: release of the outer root takes its nested instances with it — innermost first, nothing left in the registry', async () => {
    const { h } = await bootNested();
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([{ id: 'plc-many', name: 'Many_1', url: MANY_URL }]) });
    await h.viewer.whenSceneReady();
    const registry = h.viewer.bakeRegistry;
    const outer = findNested(h.viewer.currentModelRoot!, 'Many_1')!;
    expect(registry.stats().instances).toBe(1 + MANY_REFS);
    const roots = registry.instanceRootsUnder(outer);
    expect(roots).toHaveLength(1 + MANY_REFS);
    expect(roots[roots.length - 1], 'the outer root comes last').toBe(outer);
    const nestedChunk = registry.instanceOf(roots[0])!.chunks[0];

    expect(h.viewer.placements.release(outer)).toBe(true);
    expect(registry.stats().instances).toBe(0);
    expect(registry.instanceOf(outer)).toBeNull();
    for (const r of roots) expect(registry.instanceOf(r)).toBeNull();
    expect(registry.instanceOfMesh(nestedChunk)).toBeNull();
    expect(registry.pickMeshes).toEqual([]);
    // Idempotent; the document change afterwards has nothing more to release.
    expect(h.viewer.placements.release(outer)).toBe(false);
    h.viewer.clearModel();
    expect(registry.stats().instances).toBe(0);
  });

  it('a document change clears the nested-reference problems', async () => {
    const { h } = await bootNested();
    await h.viewer.loadModel('doc.glb', { data: await nestedDocumentBytes([{ id: 'plc-self', name: 'Self_0', url: SELF_URL }]) });
    await h.viewer.whenSceneReady();
    expect(getProblems().filter((p) => p.code === 'reference-cycle')).toHaveLength(1);
    await h.viewer.loadModel('plain.glb', { data: await nestedPlainBytes() });
    expect(getProblems().filter((p) => p.code === 'reference-cycle')).toHaveLength(0);
  });
});

describe('nested references on EVERY entry — the scan is a step of materialize() (F1)', () => {
  function makeNestedInstancer(deps?: Partial<PlacementInstancerDeps>) {
    const registry = new BakeRegistry();
    const { loader, decodes } = makeFakeLoader();
    const instancer = new PlacementInstancer({
      bakeRegistry: () => registry, loader, uber: () => uber,
      pickPort: () => createPickBuildPort({ createWorker: () => null }),
      ...deps,
    });
    return { instancer, registry, decodes };
  }

  it('a live drop (materialize on a fresh root) queues the nested references: state flips, whenMaterialized joins, chain seeded from the document key', async () => {
    const registered: DeferredPlacementEntry[] = [];
    const { instancer, registry } = makeNestedInstancer({ registerDefault: (entry) => { registered.push(entry); } });
    instancer.setDocumentKey('blob:rv-test/the-doc.glb');
    const baked = await instancer.resolveBaked({ catalogId: 'cat:outer', glbUrl: OUTER_URL });
    const root = instancer.createRoot(baked);
    const scene = new Scene();
    scene.add(root);

    const settled: string[] = [];
    void instancer.whenMaterialized().then(() => settled.push('idle'));
    instancer.materialize(root, baked, { id: 'live-1', label: 'Machine', catalogId: 'cat:outer' });
    // Synchronously after the call: the nested reference is queued, nothing settled.
    expect(instancer.state).toBe('materializing');
    expect(instancer.progress).toMatchObject({ total: 1, materialized: 0, pending: 1 });
    expect(instancer.isMaterializing(`live-1/${CELL_REF_NODE_ID}`)).toBe(true);

    await instancer.whenMaterialized();
    expect(settled).toEqual(['idle']);
    const nested = root.getObjectByName('Cell_1')!;
    expect(registry.instanceOf(nested)).not.toBeNull();
    expect(registry.stats().instances).toBe(2);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      id: `live-1/${CELL_REF_NODE_ID}`, nestedOf: 'live-1', depth: 1, pivot: true,
      chain: ['blob:rv-test/the-doc.glb', OUTER_URL], chainState: 'none',
    });
    expect(registered[0].ref).toEqual({ catalogId: 'cat:p757-inner.glb', glbUrl: INNER_URL });
    expect(nested.userData._layoutNestedOf).toBe('live-1');
    expect(nested.userData._layoutId).toBeUndefined();
    // The content is there and pivoted like a reloaded occurrence.
    expect(nested.getObjectByName('Slide')!.position.x).toBeCloseTo(0, 5);
  });

  it('F11: a throwing register hook loses neither the instance nor its nested references — it is reported', async () => {
    const failed: Array<{ id: string; error: unknown }> = [];
    const { instancer, registry } = makeNestedInstancer({
      onRegisterFailed: (entry, error) => failed.push({ id: entry.id, error }),
    });
    const result = await loadGLB('layout.glb', new Scene(), {
      data: await nestedDocumentBytes([{ id: 'plc-boom', name: 'Machine_1', url: OUTER_URL }]),
      referenceResolver: (async () => null) as never,
      deferPlacements: true, bakeRegistry: registry, bakePickPort: createPickBuildPort({ createWorker: () => null }), loadKinematicsSidecar: false,
    });
    const scene = new Scene();
    scene.add(result.root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const entries = collectDeferredPlacements(result.root);
      expect(instancer.materializeDeferred(entries, {
        register: (entry) => { if (entry.id === 'plc-boom') throw new Error('host registration exploded'); },
      })).toBe(1);
      await instancer.whenMaterialized();
    } finally {
      warn.mockRestore();
    }
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('plc-boom');
    expect((failed[0].error as Error).message).toContain('exploded');
    // The outer instance stands, and its nested reference became a placement anyway.
    const outer = result.root.getObjectByName('Machine_1')!;
    expect(registry.instanceOf(outer)).not.toBeNull();
    expect(registry.instanceOf(outer.getObjectByName('Cell_1')!)).not.toBeNull();
    expect(registry.stats().instances).toBe(2);
    expect(instancer.progress).toMatchObject({ total: 2, materialized: 2, pending: 0 });
  });

  it('F3: a nested RELATIVE path resolves against the url the parent bytes came from — not against the registry key', async () => {
    // A `project:`-style asset: keyed `resolved:…`, bytes from a real url. The
    // real GLTFLoader takes the byte path, so `fetch` serves the two files.
    const OUTER = 'https://rv-test.invalid/p757-f3/lib/machines/outer.glb';
    const INNER = 'https://rv-test.invalid/p757-f3/lib/machines/cell.glb';
    const outerTree = makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: './cell.glb', planner: true, assetId: 'cat:f3-cell' }]);
    const bytesByUrl = new Map<string, ArrayBuffer>([
      [OUTER, await objectToGlb(outerTree)],
      [INNER, await objectToGlb(makeInner())],
    ]);
    const fetched: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      fetched.push(url);
      const bytes = bytesByUrl.get(url);
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(new Blob([bytes], { type: 'model/gltf-binary' }), { status: 200 });
    });
    const registered: DeferredPlacementEntry[] = [];
    const registry = new BakeRegistry();
    const instancer = new PlacementInstancer({
      bakeRegistry: () => registry, loader: gltfLoader as unknown as GLTFLoader, uber: () => uber,
      pickPort: () => createPickBuildPort({ createWorker: () => null }),
      registerDefault: (entry) => { registered.push(entry); },
    });
    try {
      // The registry path: the key is an identity, the transport hands out the url.
      const baked = await instancer.modelCache.getOrLoadBaked('resolved:proj:s1:project:machines/outer.glb', async () => ({ url: OUTER }));
      expect(baked.assetId).toBe('resolved:proj:s1:project:machines/outer.glb');
      expect(baked.url).toBe(OUTER);
      const root = instancer.createRoot(baked);
      new Scene().add(root);
      instancer.materialize(root, baked, { id: 'p1', label: 'Machine', catalogId: 'project:machines/outer.glb' });
      await instancer.whenMaterialized();
      expect(registered).toHaveLength(1);
      expect(registered[0].ref.glbUrl).toBe(INNER);
      expect(registered[0].chain).toEqual(['resolved:proj:s1:project:machines/outer.glb']);
      expect(fetched).toContain(INNER);
      expect(registry.instanceOf(root.getObjectByName('Cell_1')!)).not.toBeNull();
      expect(registry.stats().instances).toBe(2);
    } finally {
      fetchSpy.mockRestore();
      instancer.dispose();
    }
  });

  it('the planner drop path: placeComponent of an asset with a nested reference fills it in and joins it; remove takes both apart', async () => {
    localStorage.clear();
    const h = setupPlanner();
    const { loader } = makeFakeLoader();
    h.plugin.placements.setModelCache(new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) }));
    const registry = new BakeRegistry();
    const result = await loadGLB('layout.glb', new Scene(), {
      data: await nestedDocumentBytes([]),
      referenceResolver: (async () => null) as never,
      deferPlacements: true, bakeRegistry: registry, bakePickPort: createPickBuildPort({ createWorker: () => null }), loadKinematicsSidecar: false,
    });
    const v = h.viewer as unknown as Record<string, unknown>;
    h.viewer.scene.add(result.root);
    v.currentModel = result.root;
    v.registry = result.registry;
    v.signalStore = result.signalStore;
    v.transportManager = result.transportManager;
    v.bakeRegistry = registry;
    h.plugin.onModelLoaded(result, h.viewer as never);
    await h.plugin.whenPlacementsMaterialized();

    const OUTER_ENTRY: LibraryCatalogEntry = { id: 'cat:p757-outer', name: 'Machine', category: 'machine', glbUrl: OUTER_URL, thumbnailUrl: '' };
    const id = await h.plugin.placeComponent(OUTER_ENTRY, [10, 0, 0]);
    // `placeComponent` joined `whenMaterialized` (F1): the nested content is there on return.
    const root = internals(h.plugin)._objectMap.get(id)!;
    const nested = root.getObjectByName('Cell_1')!;
    expect(registry.instanceOf(root)).not.toBeNull();
    expect(registry.instanceOf(nested), 'the live drop filled in its nested reference').not.toBeNull();
    expect(registry.stats().instances).toBe(2);
    expect(nested.userData._layoutNestedOf).toBe(id);
    expect(nested.userData._layoutId).toBeUndefined();
    expect(recordRootOf(nested.getObjectByName('Slide')!)).toBe(root);

    // Remove through the planner's ONE choke point: both instances go (F4).
    const path = result.registry.getPathForNode(root)!;
    await h.plugin.removeByPaths([path]);
    await flush();
    expect(h.plugin.getPlacedRootById(id)).toBeNull();
    expect(registry.stats().instances).toBe(0);
    expect(registry.pickMeshes).toEqual([]);
  });

  it('F18 (Phase 2b): a nested root announces itself with layout-content-added — the planner refreshes the hierarchy and the snap pairing; its key is the stable occurrence id', async () => {
    localStorage.clear();
    const h = setupPlanner();
    const { loader } = makeFakeLoader();
    h.plugin.placements.setModelCache(new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) }));
    const registry = new BakeRegistry();
    const result = await loadGLB('layout.glb', new Scene(), {
      data: await nestedDocumentBytes([{ id: 'plc-machine', name: 'Machine_1', url: OUTER_URL }]),
      referenceResolver: (async () => null) as never,
      deferPlacements: true, bakeRegistry: registry, bakePickPort: createPickBuildPort({ createWorker: () => null }), loadKinematicsSidecar: false,
    });
    const v = h.viewer as unknown as Record<string, unknown>;
    h.viewer.scene.add(result.root);
    v.currentModel = result.root;
    v.registry = result.registry;
    v.signalStore = result.signalStore;
    v.transportManager = result.transportManager;
    v.bakeRegistry = registry;
    const priv = h.plugin as unknown as { _refreshHierarchy(): void; _scheduleSnapPairingRebuild(): void };
    const refresh = vi.spyOn(priv, '_refreshHierarchy');
    const snaps = vi.spyOn(priv, '_scheduleSnapPairingRebuild');
    h.plugin.onModelLoaded(result, h.viewer as never);
    await h.plugin.whenPlacementsMaterialized();
    await flush();

    const outer = internals(h.plugin)._objectMap.get('plc-machine')!;
    const nested = outer.getObjectByName('Cell_1')!;
    expect(isNestedPlacementRoot(nested)).toBe(true);
    // The nested root was ANNOUNCED like any placement (`registerMaterializedPlacement` → `layout-content-added`).
    const emit = h.viewer.emit as unknown as { mock: { calls: unknown[][] } };
    const announced = emit.mock.calls.filter((c) => c[0] === 'layout-content-added').map((c) => (c[1] as { root: Object3D }).root);
    expect(announced).toContain(nested);
    // The planner subscribed on `onModelLoaded` (the mock viewer records the subscription); drive the handler as the
    // real event bus would: a nested root refreshes the hierarchy + snap pairing, a record root is not its business.
    const on = h.viewer.on as unknown as { mock: { calls: unknown[][] } };
    const handler = on.mock.calls.find((c) => c[0] === 'layout-content-added')?.[1] as ((data: unknown) => void) | undefined;
    expect(handler, 'the planner listens to layout-content-added').toBeTypeOf('function');
    refresh.mockClear();
    snaps.mockClear();
    handler!({ root: outer });
    expect(refresh).not.toHaveBeenCalled();
    expect(snaps).not.toHaveBeenCalled();
    handler!({ root: nested });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(snaps).toHaveBeenCalledTimes(1);
    // CONTENT of the record, keyed by the occurrence chain — never a record of its own.
    expect(nestedPlacementIdOf(nested)).toBe(`plc-machine/${CELL_REF_NODE_ID}`);
    expect(nested.userData._layoutId).toBeUndefined();
    expect(h.plugin.getPlacedRootById(`plc-machine/${CELL_REF_NODE_ID}`)).toBeNull();
    expect(recordRootOf(nested)).toBe(outer);
    refresh.mockRestore();
    snaps.mockRestore();
  });
});

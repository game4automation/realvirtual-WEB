// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 Phase 3 (§ 9.7, F6) — baked placed assets survive an authoring reload.
 *
 * Since Phase 2 every reference in an editor document is a placement baked
 * through the session `ModelCache`. A structural undo (undo-by-recompose), a
 * reprojection, a Back from a descend and a test-session stop all RELOAD the
 * document — and without this phase every reload re-baked every placement.
 *
 * The rule pinned here (`ModelCache.releaseDocument` / `retireKept` /
 * `bakeCount`, `PlacementInstancer.clearDocument({ keepBaked, holdKept })`):
 *  - an authoring reload (`loadAuthoringModel(…, { keepBaked: true })`)
 *    re-instantiates its placements from the kept assets: `bakeCount` does not
 *    move, the SAME `BakedAsset` serves, its geometry is never disposed, render
 *    and pick keep working;
 *  - whatever the next load does not claim is retired when it settles — an
 *    empty document, a non-editor load (no `keepBaked`) retire everything;
 *  - a reload while the previous load still materialises abandons the old
 *    bake (it never publishes) and completes without `BakeAbortedError`;
 *  - every other retire path keeps precedence: a changed expected hash, a
 *    saved document (`document-saved` → `PlacementInstancer.invalidateDocument`),
 *    a different uber material;
 *  - a DESCEND holds the window (`holdKept`): the parent's other assets
 *    survive the child's load, so Back after a descend-save bakes exactly the
 *    saved child — once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** When set, `getProjectStore()` answers this in-memory store (the descend-save case). */
  store: null as unknown,
}));

vi.mock('../src/core/project/project-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/project/project-store')>();
  return { ...actual, getProjectStore: () => (h.store ?? actual.getProjectStore()) };
});
// plan-776: the save reaches the renderer only through the thumbnail writer —
// one shared stand-in for it (tests/helpers/mock-thumbnail-write.ts).
vi.mock('../src/core/thumbnails/rv-thumbnail-write', async () =>
  (await import('./helpers/mock-thumbnail-write')).mockThumbnailWriteModule());

import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Raycaster, Vector3 } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { setAssetReference, setPlacementMeta } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { loadAuthoringModel, AUTHORING_LOAD_FLAGS } from '../src/core/editor/rv-authoring-load';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { projectDocumentBase } from '../src/core/editor/active-asset-store';
import { saveDocument, forgetSavedRevisions } from '../src/core/editor/rv-save-document';
import { writeOverride } from '../src/core/ops/rv-reference-guard';
import { registerLibrarySourceProvider, type LibrarySource } from '../src/core/library/library-source-registry';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import { clearAssetHashes, setAssetHash } from '../src/core/library/rv-asset-hash-registry';
import { sha256Hex } from '../src/core/import/rv-cad-glb-cache';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import type { BakedAsset } from '../src/core/engine/rv-bake-chunk';
import {
  CELL_REF_NODE_ID, INNER_URL, SLIDE_NODE_ID,
  bootNestedViewer, bootRealLoaderViewer, dataUrlOf, findByName, makeInner, makeOuter, referenceNode,
  type Booted,
} from './helpers/nested-placement-fixture';
import { group, withComponent } from './fixtures/bake-fixture';
import { disposeModelSubtree } from '../src/core/engine/rv-dispose-subtree';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { InPlaceTestSession } from '@rv-private/plugins/asset-editor/in-place-test-session';

let booted: Booted | null = null;
const cleanups: Array<() => void> = [];
beforeEach(() => {
  forgetSavedRevisions();
});
afterEach(() => {
  for (const c of cleanups.splice(0)) { try { c(); } catch { /* best effort */ } }
  booted?.h.dispose();
  booted = null;
  h.store = null;
  clearAssetHashes();
  resetProblemsForTests();
});

/** The OUTER Machine (own Frame + reference `Cell_1` → INNER) as document bytes. */
async function machineBytes(extra?: (root: Group) => void): Promise<ArrayBuffer> {
  const root = makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: INNER_URL, planner: true }]);
  extra?.(root);
  return objectToGlb(root);
}

/** A document without any reference (an "other" document / the empty GLB of the editor). */
async function plainDocBytes(name: string, withMesh: boolean): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = name;
  if (withMesh) {
    const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x884422 }));
    m.name = 'box';
    root.add(m);
  }
  return objectToGlb(root);
}

function chunkMeshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  root.traverse((n) => { if (n.userData?.[RV_BAKE_CHUNK_KEY] === true) out.push(n as Mesh); });
  return out;
}

function byIdentity(root: Object3D, id: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && identityIdOf(n) === id) hit = n; });
  return hit;
}

async function reloadAuthoring(b: Booted, name: string, bytes: ArrayBuffer, opts?: { keepBaked?: boolean; holdKept?: boolean }) {
  const joined = await loadAuthoringModel(b.h.viewer, name, {
    identity: { label: name }, keepBaked: opts?.keepBaked ?? true, holdKept: opts?.holdKept, data: bytes,
  });
  expect(joined.ok, `${name}: the authoring load was not superseded`).toBe(true);
  return joined;
}

/** A real ray onto the Slide's Tool → the surviving Slide (BakeRegistry.resolveHit). */
function pickSlide(b: Booted): Object3D | 'rv-blocked' | null {
  const v = b.h.viewer;
  const root = v.currentModelRoot!;
  const cell = findByName(root, 'Cell_1')!;
  const slide = byIdentity(cell, SLIDE_NODE_ID)!;
  root.updateMatrixWorld(true);
  const tool = new Vector3();
  slide.getWorldPosition(tool);
  const raycaster = new Raycaster(new Vector3(tool.x, tool.y + 5, tool.z), new Vector3(0, -1, 0));
  const hits = raycaster.intersectObject(cell, true).filter((x) => x.object.userData?.[RV_BAKE_CHUNK_KEY] === true);
  if (hits.length === 0) return null;
  const first = hits[0] as typeof hits[0] & { rvOwner?: number };
  return v.bakeRegistry.resolveHit(first.object, first.rvOwner ?? -1);
}

describe('plan-774 F6 — authoring reloads re-instantiate from the kept bakes', () => {
  it('two reloads (the structural-undo path) → bakeCount unchanged, the SAME BakedAsset serves', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    const bytes = await machineBytes();
    await reloadAuthoring(booted, 'machine.glb', bytes, { keepBaked: false });
    const cache = v.placements.modelCache;
    const baked0 = cache.peekBaked(INNER_URL)!;
    expect(baked0).toBeDefined();
    const count0 = cache.bakeCount;
    expect(count0).toBeGreaterThan(0);
    const decodes0 = booted.decodes.length;

    for (let i = 0; i < 2; i++) {
      await reloadAuthoring(booted, 'machine.glb', bytes);
      expect(cache.bakeCount, `reload ${i + 1}: no bake`).toBe(count0);
      expect(cache.peekBaked(INNER_URL), `reload ${i + 1}: same asset`).toBe(baked0);
      expect(baked0.keptForNextLoad, 'claimed → no longer flagged after the settle').toBeFalsy();
      expect(baked0.instances).toBe(1);
    }
    expect(booted.decodes.length, 'no decode either').toBe(decodes0);
    // The reloaded placement IS an instance of the kept asset.
    const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
    expect(v.bakeRegistry.instanceOf(cell)?.baked).toBe(baked0);
  });

  it('reload ×3 → render + pick ok, geometry never disposed', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    const bytes = await machineBytes();
    await reloadAuthoring(booted, 'machine.glb', bytes, { keepBaked: false });
    const baked = v.placements.modelCache.peekBaked(INNER_URL)!;
    const geometries = baked.chunks.map((c) => c.geometry);
    expect(geometries.length).toBeGreaterThan(0);
    const disposed: string[] = [];
    // Review round 2 (R8): the keep templates' geometries too (shared by every keep clone).
    for (const g of [...geometries, ...baked.keep.map((k) => k.mesh.geometry)]) g.addEventListener('dispose', () => disposed.push(g.uuid));

    for (let i = 0; i < 3; i++) {
      await reloadAuthoring(booted, 'machine.glb', bytes);
      expect(baked.disposed, `reload ${i + 1}`).toBe(false);
      expect(disposed, `reload ${i + 1}: no chunk / keep geometry disposed`).toEqual([]);
      const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
      const chunks = chunkMeshes(cell);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) {
        expect(geometries).toContain(c.geometry);
        expect(c.geometry.getAttribute('position')?.count ?? 0).toBeGreaterThan(0);
      }
      // Render: a real frame through the viewer's renderer.
      expect(() => v.renderer.render(v.scene, v.camera)).not.toThrow();
      // Pick: a chunk hit resolves to the surviving Slide of THIS reload's instance.
      const slide = byIdentity(cell, SLIDE_NODE_ID);
      expect(slide).not.toBeNull();
      expect(pickSlide(booted)).toBe(slide);
    }
  });

  it('a reload WHILE the previous load materialises: the old bake never publishes, the reload completes without BakeAbortedError', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const v = booted.h.viewer;
    const bytes = await machineBytes();
    const errors: string[] = [];
    const onUnhandled = (e: PromiseRejectionEvent): void => { errors.push(String(e.reason?.name ?? e.reason)); };
    window.addEventListener('unhandledrejection', onUnhandled);
    cleanups.push(() => window.removeEventListener('unhandledrejection', onUnhandled));
    const warn = vi.spyOn(console, 'warn');
    cleanups.push(() => warn.mockRestore());

    // Load 1: the INNER decode is held → the placement is in flight.
    await v.loadModel('machine.glb', { data: bytes, ...AUTHORING_LOAD_FLAGS });
    expect(v.placements.state).toBe('materializing');
    const cache = v.placements.modelCache;
    const count0 = cache.bakeCount;
    expect(cache.getBakeStats().inflight).toBe(1);

    // Load 2 (an authoring reload, keepBaked) overtakes it; then the gate opens.
    const reload = loadAuthoringModel(v, 'machine.glb', { identity: { label: 'reload' }, keepBaked: true, data: bytes });
    await Promise.resolve();
    booted.open();
    const joined = await reload;
    expect(joined).toMatchObject({ ok: true, placementsReady: true });

    // Exactly ONE bake published — the reload's; the abandoned job published nothing.
    expect(cache.bakeCount).toBe(count0 + 1);
    const baked = cache.peekBaked(INNER_URL)!;
    expect(baked.disposed).toBe(false);
    const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
    expect(v.bakeRegistry.instanceOf(cell)?.baked).toBe(baked);
    expect(chunkMeshes(cell).length).toBeGreaterThan(0);
    // The reload's placement did not fail into a placeholder / problem.
    const last = booted.settled[booted.settled.length - 1];
    expect(last).toMatchObject({ aborted: false, missing: 0 });
    expect(getProblems().filter((p) => p.code === 'missing-reference')).toEqual([]);
    const bakeAborted = warn.mock.calls.map((c) => c.map(String).join(' ')).filter((s) => /BakeAborted/i.test(s));
    expect(bakeAborted, 'no placement of the reload failed with BakeAbortedError').toEqual([]);
    // Give the abandoned job's continuation a turn — it must still not publish.
    await new Promise((r) => setTimeout(r, 50));
    expect(cache.bakeCount).toBe(count0 + 1);
    expect(cache.peekBaked(INNER_URL)).toBe(baked);
    expect(errors.filter((e) => /BakeAborted/.test(e))).toEqual([]);
  });

  it('a non-editor load after an editor reload retires every kept asset (bake.assets === 0 after the clear)', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    const bytes = await machineBytes();
    await reloadAuthoring(booted, 'machine.glb', bytes, { keepBaked: false });
    await reloadAuthoring(booted, 'machine.glb', bytes);
    const baked = v.placements.modelCache.peekBaked(INNER_URL)!;
    expect(baked.disposed).toBe(false);

    // The clear of a load WITHOUT keepBaked (every non-editor load) retires all.
    v.clearModel();
    expect(v.placements.getBakeStats().assets).toBe(0);
    expect(baked.disposed).toBe(true);
    // …and the load after it starts cold.
    const count = v.placements.modelCache.bakeCount;
    await v.loadModel('machine.glb', { data: bytes });
    await v.whenSceneReady();
    expect(v.placements.modelCache.bakeCount).toBe(count + 1);
  });

  it('review fix E7: a load that FAILS after a kept reload ends the kept window — nothing stays in memory', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    const bytes = await machineBytes();
    await reloadAuthoring(booted, 'machine.glb', bytes, { keepBaked: false });
    await reloadAuthoring(booted, 'machine.glb', bytes);
    const baked = v.placements.modelCache.peekBaked(INNER_URL)!;
    expect(baked.disposed).toBe(false);

    // A load that rejects (not superseded): its clear kept the bakes for it, it never seals.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(loadAuthoringModel(v, 'broken.glb', {
        identity: {}, keepBaked: true, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
      })).rejects.toThrow();
    } finally {
      error.mockRestore();
    }
    expect(v.placements.getBakeStats().assets, 'the failed load claimed nothing → retired').toBe(0);
    expect(baked.disposed).toBe(true);
  });

  it('a non-editor load (default clear) after an editor reload retires the kept assets too', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    await reloadAuthoring(booted, 'machine.glb', await machineBytes(), { keepBaked: false });
    await reloadAuthoring(booted, 'machine.glb', await machineBytes());
    const baked = v.placements.modelCache.peekBaked(INNER_URL)!;
    await v.loadModel('plain.glb', { data: await plainDocBytes('Plain', true) });
    await v.whenSceneReady();
    expect(v.placements.getBakeStats().assets).toBe(0);
    expect(baked.disposed).toBe(true);
  });

  for (const keep of [false, true]) {
    it(`an empty GLB in between (keepBaked ${keep}) → kept assets retired, the next reload bakes again`, async () => {
      booted = await bootNestedViewer();
      const v = booted.h.viewer;
      const bytes = await machineBytes();
      await reloadAuthoring(booted, 'machine.glb', bytes, { keepBaked: false });
      const baked = v.placements.modelCache.peekBaked(INNER_URL)!;
      const count = v.placements.modelCache.bakeCount;

      // The editor's empty-GLB load (authoring flags, nothing referenced).
      await reloadAuthoring(booted, 'empty.glb', await plainDocBytes('Empty', false), { keepBaked: keep });
      expect(v.placements.getBakeStats().assets, 'nothing claimed → retired at the settle').toBe(0);
      expect(baked.disposed).toBe(true);

      await reloadAuthoring(booted, 'machine.glb', bytes);
      expect(v.placements.modelCache.bakeCount).toBe(count + 1);
      expect(v.placements.modelCache.peekBaked(INNER_URL)).not.toBe(baked);
    });
  }

  it('a reload never writes the runtime override base onto the kept template (Phase 1 review)', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    // The open file overrides the Slide → `applyOverrideLayers` records `_rvOverrideBase` on the INSTANCE node.
    const bytes = await machineBytes((root) => {
      writeOverride(findByName(root, 'Cell_1')!, SLIDE_NODE_ID, 'Drive', 'TargetSpeed', 250);
    });
    await reloadAuthoring(booted, 'machine.glb', bytes, { keepBaked: false });
    for (let i = 0; i < 2; i++) await reloadAuthoring(booted, 'machine.glb', bytes);
    const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
    const slide = byIdentity(cell, SLIDE_NODE_ID)!;
    expect(slide.userData._rvOverrideBase, 'proof: the instance carries it').toBeDefined();
    const baked = v.placements.modelCache.peekBaked(INNER_URL)!;
    const carriers: string[] = [];
    baked.template.traverse((n) => { if (n.userData?._rvOverrideBase !== undefined) carriers.push(n.name); });
    for (const l of baked.logicNodes) l.template.traverse((n) => { if (n.userData?._rvOverrideBase !== undefined) carriers.push(`logic:${n.name}`); });
    expect(carriers).toEqual([]);
  });
});

// ─── Phase 3 deviation: the window is any load → the next load ───────────

describe('plan-774 F6 — any load keeps for the next one (planner / HMI → editor)', () => {
  it('a runtime (planner / HMI) load, then the editor opens the same document: 0 bakes', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    const bytes = await machineBytes();
    // The planner / HMI load — a plain runtime load, no option.
    await v.loadModel('machine.glb', { data: bytes });
    await v.whenSceneReady();
    const cache = v.placements.modelCache;
    const baked = cache.peekBaked(INNER_URL)!;
    expect(baked).toBeDefined();
    const count = cache.bakeCount;
    // The editor's open (`_loadBase` → `loadAuthoringModel`, keepBaked by default).
    await reloadAuthoring(booted, 'machine.glb', bytes);
    expect(cache.bakeCount).toBe(count);
    expect(cache.peekBaked(INNER_URL)).toBe(baked);
    // …and back to the runtime view: still the same asset.
    await v.loadModel('machine.glb', { data: bytes });
    await v.whenSceneReady();
    expect(cache.bakeCount).toBe(count);
    expect(cache.peekBaked(INNER_URL)).toBe(baked);
    // A different document in between does not claim it → retired at its settle.
    await v.loadModel('plain.glb', { data: await plainDocBytes('Plain', true) });
    await v.whenSceneReady();
    expect(baked.disposed).toBe(true);
    expect(cache.getBakeStats().assets).toBe(0);
  });

  it('the layout planner leaves the release to the viewer when the viewer owns the instancer', async () => {
    const { LayoutPlannerPlugin } = await import('../src/plugins/layout-planner');
    const { createMockViewer, createGizmoRecorder } = await import('./_layout-planner-async-harness');
    // Viewer-owned instancer: the planner's hook must NOT clear first (it would retire the bakes
    // the viewer's own clear keeps for the next load).
    const viewer = createMockViewer(createGizmoRecorder()) as unknown as Record<string, unknown>;
    const owned = { clearDocument: vi.fn() };
    viewer.placements = owned;
    const plugin = new LayoutPlannerPlugin();
    plugin.onModelLoaded?.({ scene: new Group() } as never, viewer as never);
    plugin.onModelCleared?.(viewer as never);
    expect(owned.clearDocument).not.toHaveBeenCalled();
    // A host without `viewer.placements`: the planner's fallback instancer is cleared by the hook.
    const bare = createMockViewer(createGizmoRecorder());
    const plugin2 = new LayoutPlannerPlugin();
    plugin2.onModelLoaded?.({ scene: new Group() } as never, bare as never);
    const spy = vi.spyOn(plugin2.placements, 'clearDocument');
    plugin2.onModelCleared?.(bare as never);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ─── Instances of the previous document never outlive its clear ─────────

describe('plan-774 — keep = assets, never instances (planner ↔ editor)', () => {
  /** The instance roots NOT under the current model root (= detached / stale). */
  function strayInstances(b: Booted): Object3D[] {
    const v = b.h.viewer;
    const root = v.currentModelRoot;
    const under = (o: Object3D): boolean => { for (let n: Object3D | null = o; n; n = n.parent) if (n === root) return true; return false; };
    return [...v.bakeRegistry.instances].map((i) => i.root).filter((r) => !under(r));
  }

  it('planner → editor → planner → editor: after each settle the registry holds exactly the placements of the current scene', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    // The REAL layout planner: on a load in planner mode it adopts the deferred
    // placements through its own register hook (records, not the instancer's
    // `_ownedRoots`) — the instances the viewer's clear used to leave in the
    // detached tree (2nd and later planner → editor switches, PlannerGate30).
    v.modes.register({ id: 'editor', label: 'Editor', runtime: 'detached' })
      .register({ id: 'planner', label: 'Planner' })
      .register({ id: 'des', label: 'DES' });
    v.modes.setMode('planner');
    const { LayoutPlannerPlugin } = await import('../src/plugins/layout-planner');
    const planner = new LayoutPlannerPlugin();
    v.use(planner);
    const refs = Array.from({ length: 3 }, (_, i) => ({
      name: `Cell_${i + 1}`, id: `nid-leak-${i + 1}`, url: INNER_URL, planner: true, pos: [i * 4, 0, 0] as [number, number, number],
    }));
    const bytes = await objectToGlb(makeOuter('Layout', refs));
    const cache = v.placements.modelCache;

    const check = (step: string, plannerOwned: boolean): void => {
      const insts = [...v.bakeRegistry.instances];
      expect(strayInstances(booted!), `${step}: no instance outside the current model`).toEqual([]);
      // One instance per placement of the current scene, plus at most the
      // document's own in-place bake (its Frame mesh) — never a stale one.
      const placed = insts.filter((i) => i.root.name.startsWith('Cell_'));
      expect(placed.length, `${step}: one instance per placement of the current scene`).toBe(refs.length);
      expect(insts.length - placed.length, `${step}: only the document's own bake besides`).toBeLessThanOrEqual(1);
      for (const r of refs) expect(findByName(v.currentModelRoot!, r.name), `${step}: ${r.name} placed`).not.toBeNull();
      // The planner path really was taken (its register hook, not the core default).
      if (plannerOwned) expect((planner as unknown as { _objectMap: Map<string, Object3D> })._objectMap.size, `${step}: planner records`).toBe(refs.length);
    };

    // planner (a runtime load, the planner adopts) → editor → planner → editor → planner
    await v.loadModel('layout.glb', { data: bytes });
    await v.whenSceneReady();
    check('planner #1', true);
    const baked = cache.peekBaked(INNER_URL)!;
    expect(baked).toBeDefined();
    const bakes = cache.bakeCount;
    for (let round = 1; round <= 2; round++) {
      v.modes.setMode('editor');
      await reloadAuthoring(booted, 'layout.glb', bytes);
      await v.whenSceneReady();
      check(`editor #${round}`, false);
      // Exactly the current scene's instances hold the kept asset — a stale one would
      // make it look claimed to the next load's `retireKept`.
      expect(baked.instances, `editor #${round}: refcount = live placements`).toBe(refs.length);
      v.modes.setMode('planner');
      await v.loadModel('layout.glb', { data: bytes });
      await v.whenSceneReady();
      check(`planner #${round + 1}`, true);
      expect(baked.instances, `planner #${round + 1}: refcount = live placements`).toBe(refs.length);
    }
    // The keep window still works across the switches: no re-bake, the same asset.
    expect(cache.bakeCount).toBe(bakes);
    expect(cache.peekBaked(INNER_URL)).toBe(baked);
    // A document without placements: nothing left, the asset retired at its settle.
    await v.loadModel('plain.glb', { data: await plainDocBytes('Plain', true) });
    await v.whenSceneReady();
    expect([...v.bakeRegistry.instances].filter((i) => i.baked === baked)).toEqual([]);
    expect(baked.disposed).toBe(true);
  });
});

// ─── ModelCache level: the precedence of the other retire paths ─────────

function glbMarker(marker: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(12);
  b.set([0x67, 0x6c, 0x54, 0x46], 0);
  b[4] = 2;
  b[8] = 12;
  b[11] = marker;
  return b;
}

describe('plan-774 F6 — ModelCache.releaseDocument / retireKept', () => {
  let serving = 1;
  beforeEach(() => {
    serving = 1;
    const realFetch = globalThis.fetch.bind(globalThis);
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      if (url.startsWith('blob:')) return realFetch(input as RequestInfo, init);
      if (!/\.glb(\?|#|$)/.test(url)) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      return new Response(glbMarker(serving), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
    });
    cleanups.push(() => spy.mockRestore());
  });

  function makeCache(uber: () => unknown): ModelCache {
    const loader = {
      loadAsync: async (blobUrl: string): Promise<{ scene: Group }> => {
        const marker = new Uint8Array(await (await fetch(blobUrl)).arrayBuffer())[11];
        const root = new Group();
        root.name = `v${marker}`;
        const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
        mesh.name = 'Body';
        root.add(mesh);
        return { scene: root };
      },
    } as unknown as GLTFLoader;
    return new ModelCache(loader, {
      uber: uber as never,
      pickPort: () => createPickBuildPort({ createWorker: () => null }),
    });
  }

  let seq = 0;
  const freshUrl = (name: string): string => `https://example.test/p774/${Date.now()}-${++seq}/${name}.glb`;

  it('keepBaked: false = clearDecoded; keepBaked: true keeps + flags; retireKept retires the unclaimed', async () => {
    const cache = makeCache(() => null);
    const a = freshUrl('a');
    const b = freshUrl('b');
    const bakedA = await cache.getOrLoadBaked(a);
    const bakedB = await cache.getOrLoadBaked(b);
    expect(cache.bakeCount).toBe(2);
    cache.releaseDocument({ keepBaked: true });
    expect(bakedA.keptForNextLoad).toBe(true);
    expect(cache.getBakeStats().assets).toBe(2);
    // The next load claims A only.
    expect(await cache.getOrLoadBaked(a)).toBe(bakedA);
    bakedA.acquire();
    cache.retireKept();
    expect(bakedA.disposed).toBe(false);
    expect(bakedA.keptForNextLoad).toBe(false);
    expect(bakedB.disposed).toBe(true);
    expect(cache.peekBaked(b)).toBeUndefined();
    expect(cache.bakeCount).toBe(2);
    bakedA.release();
    cache.releaseDocument({ keepBaked: false });
    expect(cache.getBakeStats().assets).toBe(0);
    expect(bakedA.disposed).toBe(true);
    cache.dispose();
  });

  it('a kept asset whose expected hash changes is retired by the hash path, not served', async () => {
    const cache = makeCache(() => null);
    const url = freshUrl('belt');
    setAssetHash(url, { sha256: await sha256Hex(glbMarker(1).buffer.slice(0) as ArrayBuffer) });
    const v1 = await cache.getOrLoadBaked(url);
    cache.releaseDocument({ keepBaked: true });
    expect(v1.keptForNextLoad).toBe(true);
    // The catalog moves on while the asset is kept: the registry listener invalidates the key.
    serving = 2;
    setAssetHash(url, { sha256: await sha256Hex(glbMarker(2).buffer.slice(0) as ArrayBuffer) });
    expect(cache.peekBaked(url)).toBeUndefined();
    expect(v1.retired).toBe(true);
    expect(v1.disposed).toBe(true);
    const v2 = await cache.getOrLoadBaked(url);
    expect(v2).not.toBe(v1);
    expect(v2.template.name).toBe('v2');
    expect(cache.bakeCount).toBe(2);
    cache.dispose();
  });

  it('a host that answers a DIFFERENT uber material retires every kept asset before serving', async () => {
    let uber: object = { name: 'uber-A' };
    const cache = makeCache(() => uber);
    const url = freshUrl('a');
    const baked = await cache.getOrLoadBaked(url);
    cache.releaseDocument({ keepBaked: true });
    // Same material → served.
    expect(cache.peekBaked(url)).toBe(baked);
    cache.releaseDocument({ keepBaked: true });
    uber = { name: 'uber-B' };
    expect(cache.peekBaked(url)).toBeUndefined();
    expect(baked.disposed).toBe(true);
    const fresh = await cache.getOrLoadBaked(url);
    expect(fresh).not.toBe(baked);
    expect(cache.bakeCount).toBe(2);
    cache.dispose();
  });

  it('releaseDocument abandons every in-flight bake: it never publishes, the next ask bakes anew', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const loader = {
      loadAsync: async (): Promise<{ scene: Group }> => {
        await gate;
        const root = new Group();
        root.name = 'gated';
        root.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
        return { scene: root };
      },
    } as unknown as GLTFLoader;
    const cache = new ModelCache(loader, { pickPort: () => createPickBuildPort({ createWorker: () => null }) });
    const url = freshUrl('gated');
    const first = cache.getOrLoadBaked(url);
    first.catch(() => { /* asserted below */ });
    await Promise.resolve();
    cache.releaseDocument({ keepBaked: true });
    expect(cache.getBakeStats().inflight).toBe(0);
    const second = cache.getOrLoadBaked(url);
    release();
    await expect(first).rejects.toMatchObject({ name: 'BakeAbortedError' });
    const asset = await second;
    expect(cache.bakeCount).toBe(1);
    expect(cache.peekBaked(url)).toBe(asset);
    cache.dispose();
  });
});

// ─── Descend → edit child → project-store save → Back ───────────────────

describe('plan-774 F6 — descend holds the window; a saved child is re-baked on Back, once', () => {
  const CELL_PATH = 'cells/cell.glb';
  const OTHER_PATH = 'cells/other.glb';
  const PROVIDER = 'p774-project';

  function projectReference(name: string, id: string, relPath: string, pos: [number, number, number]): Object3D {
    const node = new Object3D();
    node.name = name;
    node.position.set(...pos);
    setNodeId(node, id);
    setAssetReference(node, { assetId: `project:${relPath}`, path: relPath });
    setPlacementMeta(node, {});
    return node;
  }

  it('Back after a descend-save shows the new child with exactly one bake; the sibling is reused', async () => {
    // The project: files on an in-memory backend, served to placements through
    // a registered `project` library source and written by the real save path.
    const files = new Map<string, Uint8Array>();
    const enc = (b: ArrayBuffer): Uint8Array => new Uint8Array(b.slice(0));
    files.set(CELL_PATH, enc(await objectToGlb(makeInner())));
    const other = makeInner();
    other.name = 'Other';
    files.set(OTHER_PATH, enc(await objectToGlb(other)));

    const entryOf = (id: string): LibraryCatalogEntry | null => {
      const path = id.startsWith('project:') ? id.slice('project:'.length) : '';
      return files.has(path) ? { id, name: path, category: 'custom', localPath: path } as LibraryCatalogEntry : null;
    };
    const source: LibrarySource = {
      id: 'proj', label: 'Project', kind: 'project', writable: true, loaded: true,
      listEntries: () => [...files.keys()].map((p) => entryOf(`project:${p}`)!),
      getEntry: (id) => entryOf(id),
      resolveAsset: async (id) => {
        const bytes = files.get(id.slice('project:'.length))!;
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'model/gltf-binary' }));
        return { url, revokeUrl: () => URL.revokeObjectURL(url) };
      },
    };
    cleanups.push(registerLibrarySourceProvider({ id: PROVIDER, listSources: () => [source], subscribe: () => () => {} }));

    const backend = {
      kind: 'browser' as const, id: 'p774-backend', writable: true, isActive: true,
      async writeDocument(ref: string | { path: string }, bytes: Uint8Array) {
        files.set(typeof ref === 'string' ? ref : ref.path, new Uint8Array(bytes));
        return { revision: `rev-${files.size}-${Date.now()}` };
      },
      async readDocument(ref: string | { path: string }) {
        const p = typeof ref === 'string' ? ref : ref.path;
        const bytes = files.get(p);
        return bytes ? { bytes, meta: { id: '', name: p, path: p }, revision: 'rev' } : null;
      },
      async readDocumentUrl() { return null; },
      async listDocuments() { return [...files.keys()].map((path, i) => ({ id: `doc-${i}`, name: path, path })); },
      async writeBlob() { /* thumbnails */ },
    };
    h.store = { getBackend: () => backend, getProject: () => ({ id: 'prj_p774', documents: [] }) };

    booted = await bootRealLoaderViewer();
    const v = booted.h.viewer;
    const machine = makeOuter('Machine', []);
    machine.add(projectReference('Cell_1', CELL_REF_NODE_ID, CELL_PATH, [3, 0, 0]));
    machine.add(projectReference('Other_1', 'nid-other', OTHER_PATH, [-3, 0, 0]));
    const parentBytes = await objectToGlb(machine);

    // Open the parent: two placed assets, two bakes.
    await reloadAuthoring(booted, 'machine.glb', parentBytes, { keepBaked: false });
    const cache = v.placements.modelCache;
    const cellKey = v.placements.keyOf({ catalogId: `project:${CELL_PATH}` }, null);
    const otherKey = v.placements.keyOf({ catalogId: `project:${OTHER_PATH}` }, null);
    const cell0 = cache.peekBaked(cellKey)!;
    const other0 = cache.peekBaked(otherKey)!;
    expect(cell0, 'cell placed').toBeDefined();
    expect(other0, 'other placed').toBeDefined();
    const count0 = cache.bakeCount;
    const slide0 = byIdentity(findByName(v.currentModelRoot!, 'Cell_1')!, SLIDE_NODE_ID)!;
    expect((slide0.userData.realvirtual as { Drive: { TargetSpeed: number } }).Drive.TargetSpeed).toBe(200);

    // Descend into the cell: the child from ITS OWN bytes, a HELD keep.
    await reloadAuthoring(booted, 'cell.glb', files.get(CELL_PATH)!.slice().buffer as ArrayBuffer, { holdKept: true });
    expect(cache.bakeCount, 'the child has no placements of its own').toBe(count0);
    expect(other0.disposed, 'held: the parent sibling survives the child load').toBe(false);
    expect(cache.peekBaked(otherKey)).toBe(other0);

    // Edit the child and save it through the project store (real saveDocument).
    const doc = new AssetDocument(v as never, { id: 'asset_p774_child', name: 'cell', base: projectDocumentBase(CELL_PATH, 'cell') });
    cleanups.push(() => doc.dispose());
    const childSlide = byIdentity(v.currentModelRoot!, SLIDE_NODE_ID)!;
    await doc.applyOp({
      kind: 'setField', nodePath: v.registry!.getPathForNode(childSlide)!, componentType: 'Drive', fieldName: 'TargetSpeed', value: 333,
    } as never);
    const saved = await saveDocument(v, doc);
    expect(saved.kind).toBe('saved');
    expect(cell0.disposed, 'document-saved retired the stale child bake').toBe(true);
    expect(cache.peekBaked(cellKey)).toBeUndefined();
    expect(other0.disposed).toBe(false);

    // Back: the parent reloads — the child bakes ONCE from the saved bytes, the sibling is reused.
    await reloadAuthoring(booted, 'machine.glb', parentBytes);
    expect(cache.bakeCount).toBe(count0 + 1);
    expect(cache.peekBaked(otherKey)).toBe(other0);
    const cell1 = cache.peekBaked(cellKey)!;
    expect(cell1).not.toBe(cell0);
    const slide1 = byIdentity(findByName(v.currentModelRoot!, 'Cell_1')!, SLIDE_NODE_ID)!;
    expect((slide1.userData.realvirtual as { Drive: { TargetSpeed: number } }).Drive.TargetSpeed).toBe(333);
    expect(getProblems().filter((p) => p.code === 'missing-reference')).toEqual([]);
  });
});

// ─── Review round 2 (R7 / R8 / R9) ──────────────────────────────────────

describe('plan-774 review round 2 — held windows and the keep geometry', () => {
  it('R9: a held window (descend) ended by a NON-editor (HMI) load → the kept assets are retired at its settle', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    await reloadAuthoring(booted, 'machine.glb', await machineBytes(), { keepBaked: false });
    const baked = v.placements.modelCache.peekBaked(INNER_URL)!;
    // Descend: the child holds the window; the parent's asset survives its settle.
    await reloadAuthoring(booted, 'child.glb', await plainDocBytes('Child', true), { holdKept: true });
    expect(baked.disposed, 'held across the child load').toBe(false);
    // The HMI / planner load (plain `loadModel`, no holdKept) does not claim it.
    await v.loadModel('plain.glb', { data: await plainDocBytes('Plain', true) });
    await v.whenSceneReady();
    expect(baked.disposed, 'retired at the HMI load settle').toBe(true);
    expect(v.placements.getBakeStats().assets).toBe(0);
  });

  for (const descended of [true, false]) {
    it(`R7: descend → test run start/stop → Back: ${descended ? 'bakeCount unchanged (the run holds the window)' : 'without the hold the parent asset is re-baked (the claim)'}`, async () => {
      booted = await bootNestedViewer();
      const v = booted.h.viewer;
      const parentBytes = await machineBytes();
      await reloadAuthoring(booted, 'machine.glb', parentBytes, { keepBaked: false });
      const cache = v.placements.modelCache;
      const baked0 = cache.peekBaked(INNER_URL)!;
      const count0 = cache.bakeCount;

      // Descend into a child (own bytes, held keep).
      await reloadAuthoring(booted, 'child.glb', await plainDocBytes('Child', true), { holdKept: true });
      const doc = new AssetDocument(v as never, { id: 'asset_p774_r7', name: 'Child', base: projectDocumentBase('child.glb', 'Child') });
      cleanups.push(() => doc.dispose());
      // The provenance hand-back maps the export's node order onto the source
      // file's; this harness' data-url child has no source mapping worth
      // restoring (not what is measured here — the loads' keep window is).
      const provenance = vi.spyOn(NodeRegistry.prototype, 'restoreGltfProvenance').mockImplementation(() => {});
      cleanups.push(() => provenance.mockRestore());
      const session = new InPlaceTestSession({ viewer: v, getDocument: () => doc, isDescended: () => descended });
      cleanups.push(() => session.dispose());
      await session.start();
      expect(session.state).toBe('running');
      await v.whenSceneReady();
      await session.stop();
      expect(session.state).toBe('idle');

      // Back: the parent reloads (root frame → no hold).
      await reloadAuthoring(booted, 'machine.glb', parentBytes);
      if (descended) {
        expect(cache.bakeCount, 'Back re-instantiates from the kept bake').toBe(count0);
        expect(cache.peekBaked(INNER_URL)).toBe(baked0);
        expect(baked0.disposed).toBe(false);
      } else {
        expect(baked0.disposed, 'the run load retired the parent asset').toBe(true);
        expect(cache.bakeCount).toBe(count0 + 1);
      }
    });
  }

  it('R8: a placement keep clone SHARES its template geometry — a subtree dispose never frees it, the asset\'s own dispose does', async () => {
    const cellWithLamp = (): Group => {
      const root = group('LampCell');
      const body = new Mesh(new BoxGeometry(1, 0.5, 1), new MeshStandardMaterial({ color: 0x336699 }));
      body.name = 'Body';
      root.add(body);
      const lamp = withComponent(group('Beacon'), 'Lamp', {});
      setNodeId(lamp, 'nid-lamp');
      const bulb = new Mesh(new BoxGeometry(0.3, 0.3, 0.3), new MeshStandardMaterial({ color: 0xffcc00 }));
      bulb.name = 'Bulb';
      lamp.add(bulb);
      lamp.position.set(0, 1, 0);
      root.add(lamp);
      return root;
    };
    booted = await bootRealLoaderViewer();
    const v = booted.h.viewer;
    const machine = makeOuter('Machine', []);
    machine.add(referenceNode('Cell_1', CELL_REF_NODE_ID, dataUrlOf(await objectToGlb(cellWithLamp())), true, [3, 0, 0], 'cat:lampcell'));
    const bytes = await objectToGlb(machine);
    await reloadAuthoring(booted, 'machine.glb', bytes, { keepBaked: false });
    const baked = v.bakeRegistry.instanceOf(findByName(v.currentModelRoot!, 'Cell_1')!)!.baked;
    expect(baked.keep.length, 'the Lamp bulb is a keep mesh').toBeGreaterThan(0);
    const keepGeometries = baked.keep.map((k) => k.mesh.geometry);
    const disposed: string[] = [];
    for (const g of [...keepGeometries, ...baked.chunks.map((c) => c.geometry)]) g.addEventListener('dispose', () => disposed.push(g.uuid));

    for (let i = 0; i < 3; i++) {
      await reloadAuthoring(booted, 'machine.glb', bytes);
      const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
      expect(v.bakeRegistry.instanceOf(cell)?.baked, `reload ${i + 1}: same asset`).toBe(baked);
      const clones = v.bakeRegistry.instanceOf(cell)!.keep;
      for (const c of clones) expect(keepGeometries, 'the clone shares the template geometry').toContain(c.geometry);
      expect(disposed, `reload ${i + 1}: no keep / chunk geometry disposed`).toEqual([]);
    }
    // The ONE dispose walk of a model subtree skips it (like a chunk geometry)…
    disposeModelSubtree(findByName(v.currentModelRoot!, 'Cell_1')!);
    expect(disposed, 'subtree dispose: keep geometry untouched').toEqual([]);
    // …and the asset's own dispose frees it.
    baked.dispose();
    for (const g of keepGeometries) expect(disposed).toContain(g.uuid);
  });
});

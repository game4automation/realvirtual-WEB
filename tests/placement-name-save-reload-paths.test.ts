// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-758 §9.3 — a placement's name survives save and reload unchanged, in
 * any load order, because the RECORD is the truth at both ends:
 *
 *  - the save writes `placement.label` as the reference node's name
 *    (`buildPlacementNode` / `reconcilePlacements` → `placementNodeName`);
 *  - the reload applies that name verbatim (`naming: 'keep'`) — never a
 *    re-uniquify that would depend on the order the instancer settles in.
 *
 * Built from three existing pieces: the op-recorder save of
 * `glb-bake-roundtrip.test.ts` (`materialise` + `bakeIntoGlb` over a real
 * resolver), the reload-into-a-planner of `layout-reload-shared-bake.test.ts`
 * (`loadGLB(deferPlacements)` → `onModelLoaded` → the planner's deferred hooks),
 * and the record fixtures of `layout-planner-placement-parity.test.ts`.
 *
 * Deliberately NOT tested over the GLB path: two reference nodes with the SAME
 * name. three.js' `GLTFLoader.createUniqueName` renames the second at parse
 * time, before any planner code runs (plan-758 R5) — that case is pinned at
 * the adopt level in `layout-planner-scene-mutations.test.ts` instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { collectPlacementNodes } from '../src/core/hmi/scene/rv-scene-glb-read';
import { bakeIntoGlb, makeRegistryBakeResolver } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import { parseGlbChunks, rebuildGlbWithJson } from '../src/core/persistence/rv-glb-chunks';
import { RV_ASSET_REFERENCE_KEY } from '../src/core/engine/rv-asset-reference';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { ModelCache } from '../src/plugins/layout-planner/model-cache';
import type { PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';
import { setupPlanner, internals, type PlannerHarness } from './_layout-planner-async-harness';
import { group, uberMesh } from './fixtures/bake-fixture';

// ─── Fixtures ───────────────────────────────────────────────────────────

// A STABLE library path: the save refuses to persist a `blob:` url as the
// reference path, and the reload resolves the record's saved url first.
const ASSET_URL = 'lib/belt-758.glb';
const CATALOG_ID = 'cat:belt-758';
const uber = new RVUberMaterial(false);

/** The referenced asset: one static mesh is all the bake needs. */
function makeAsset(): Group {
  const root = group('Belt');
  root.add(uberMesh(uber, 'frame', [0, 0.5, 0]));
  return root;
}

/** The planner's model cache over an in-memory decode. */
function makeCache(): ModelCache {
  const loader = {
    loadAsync: async (): Promise<{ scene: Group }> => ({ scene: makeAsset() }),
  } as unknown as GLTFLoader;
  return new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
}

let opCounter = 0;
function op<T extends Omit<RvOp, 'id' | 'ts' | 'schemaV'>>(body: T): RvOp {
  return { id: `op_${++opCounter}`, ts: Date.now(), schemaV: 1, ...body } as unknown as RvOp;
}

function record(id: string, label: string, x: number): PlacedComponent {
  return {
    id, catalogId: CATALOG_ID, glbUrl: ASSET_URL, label,
    position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  };
}

/** An empty layout document — the base the save patches placements into. */
async function emptyLayoutBytes(): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Layout';
  root.add(new Object3D()); // one authored node so the file is not degenerate
  root.children[0].name = 'Floor';
  return objectToGlb(root);
}

/** SAVE: what `SceneStore._writeBodyInner` does — materialise the ops, bake them into the base. */
async function saveWithPlacements(records: PlacedComponent[]): Promise<Uint8Array> {
  const base = await emptyLayoutBytes();
  const loaded = await loadGLB('layout.glb', new Scene(), {
    data: base.slice(0), preserveHierarchy: true, loadKinematicsSidecar: false,
  });
  const resolver = makeRegistryBakeResolver(loaded.registry, loaded.composition?.frames ?? []);
  const edits = materialise(records.map((placement) => op({ kind: 'addPlacement', placement })));
  const baked = await bakeIntoGlb(base, edits, resolver, { expectedNames: loaded.registry.getGltfNodeNames() });
  return baked.glb;
}

type GltfNodeJson = { name?: string; children?: number[]; extras?: Record<string, unknown> };

function isReferenceNode(n: GltfNodeJson | undefined): boolean {
  const rv = n?.extras?.realvirtual as Record<string, unknown> | undefined;
  return !!rv && RV_ASSET_REFERENCE_KEY in rv;
}

/** The reference node names the file carries, in `nodes[]` order. */
function referenceNodeNames(glb: Uint8Array): string[] {
  const { json } = parseGlbChunks(glb);
  const nodes = (json.nodes as GltfNodeJson[]) ?? [];
  return nodes.filter(isReferenceNode).map((n) => n.name ?? '');
}

/** Reverse the order of the document's reference nodes inside the file (load-order independence). */
function reverseReferenceNodes(glb: Uint8Array): Uint8Array {
  const chunks = parseGlbChunks(glb);
  const nodes = chunks.json.nodes as GltfNodeJson[];
  const isRef = (i: number): boolean => isReferenceNode(nodes[i]);
  let touched = 0;
  const reverseIn = (list: number[] | undefined): number[] | undefined => {
    if (!list) return list;
    const refs = list.filter(isRef);
    if (refs.length < 2) return list;
    const reversed = [...refs].reverse();
    let k = 0;
    touched++;
    return list.map((c) => (isRef(c) ? reversed[k++] : c));
  };
  // References sit either under a parent node or directly in the scene's root list.
  for (const n of nodes) n.children = reverseIn(n.children);
  for (const s of (chunks.json.scenes as { nodes?: number[] }[]) ?? []) s.nodes = reverseIn(s.nodes);
  if (touched === 0) throw new Error('test fixture: no parent with two reference children to reverse');
  return rebuildGlbWithJson(chunks);
}

interface Reloaded { h: PlannerHarness; result: LoadResult }

/** RELOAD: the way RVViewer does with the planner installed (`layout-reload-shared-bake.test.ts`). */
async function reloadIntoPlanner(glb: Uint8Array): Promise<Reloaded> {
  localStorage.clear();
  // A placement that could not be restored gets a placeholder that would still
  // carry the name — the test must see REAL instances, so a restore failure fails it.
  const warn = vi.spyOn(console, 'warn');
  try {
    return await reloadIntoPlannerInner(glb);
  } finally {
    const failed = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('Cannot restore'));
    warn.mockRestore();
    if (failed.length) throw new Error(`placements did not materialise:\n${failed.join('\n')}`);
  }
}

async function reloadIntoPlannerInner(glb: Uint8Array): Promise<Reloaded> {
  const h = setupPlanner();
  h.plugin.placements.setModelCache(makeCache());
  const registry = new BakeRegistry();
  const bytes = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
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
  h.plugin.onModelLoaded(result, h.viewer as never);
  await h.plugin.whenPlacementsMaterialized();
  return { h, result };
}

/** `{ id → hierarchy path }` of every placement, from the registry the loader built. */
function pathsOf(r: Reloaded): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, node] of internals(r.h.plugin)._objectMap) {
    const path = r.result.registry.getPathForNode(node);
    if (path) out.set(id, path);
  }
  return out;
}

const RECORDS = [record('p_a', 'Belt', 0), record('p_b', 'Belt_1', 3), record('p_c', 'Belt_2', 6)];

// ─── Tests ──────────────────────────────────────────────────────────────

describe('plan-758 — placement names across save → reload', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetProblemsForTests();
    // The blob cache fetches every non-blob asset url before the (stubbed)
    // loader sees it; a bare `glTF` header is all it needs to accept the bytes.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(new Blob([new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0])]), {
        status: 200, headers: { 'Content-Type': 'model/gltf-binary' },
      })) as ReturnType<typeof vi.spyOn>;
  });
  afterEach(() => { fetchSpy.mockRestore(); });

  it('the save writes each record name as the reference node name, unchanged', async () => {
    const glb = await saveWithPlacements(RECORDS);
    expect(referenceNodeNames(glb)).toEqual(['Belt', 'Belt_1', 'Belt_2']);
  });

  it('paths are identical after reload, and identical again with the file order reversed', async () => {
    const glb = await saveWithPlacements(RECORDS);
    const forward = await reloadIntoPlanner(glb);
    const reversed = await reloadIntoPlanner(reverseReferenceNodes(glb));

    for (const r of [forward, reversed]) {
      const placed = r.h.store.getSnapshot().placed;
      expect(placed.map((p) => p.label).sort()).toEqual(['Belt', 'Belt_1', 'Belt_2']);
      // label === node.name on every reloaded placement (record is the truth).
      for (const p of placed) expect(internals(r.h.plugin)._objectMap.get(p.id)!.name, p.id).toBe(p.label);
      // The path's last segment IS the recorded name.
      for (const [id, path] of pathsOf(r)) {
        expect(path.endsWith('/' + placed.find((p) => p.id === id)!.label), `${id}: ${path}`).toBe(true);
      }
      expect([...pathsOf(r).values()].join()).not.toContain('(copy)');
      expect(getProblems().filter((p) => p.code === 'placement-name-collision')).toHaveLength(0);
    }
    // Load order does not leak into the names: same id → same path both ways.
    expect(pathsOf(reversed)).toEqual(pathsOf(forward));
  });

  it('a second reload of the same file is a fixpoint', async () => {
    const glb = await saveWithPlacements(RECORDS);
    const once = await reloadIntoPlanner(glb);
    const twice = await reloadIntoPlanner(glb);
    expect(pathsOf(twice)).toEqual(pathsOf(once));
  });

  it('a legacy "(copy)" name loads verbatim and is never rewritten', async () => {
    const glb = await saveWithPlacements([record('p_legacy', 'Belt (copy) (copy)', 0)]);
    expect(referenceNodeNames(glb)).toEqual(['Belt (copy) (copy)']);
    const r = await reloadIntoPlanner(glb);
    const rec = r.h.store.getSnapshot().placed.find((p) => p.id === 'p_legacy')!;
    expect(rec.label).toBe('Belt (copy) (copy)');
    expect(internals(r.h.plugin)._objectMap.get('p_legacy')!.name).toBe('Belt (copy) (copy)');
  });

  it('the reloaded records carry exactly the saved names (collectPlacementNodes reads node.name)', async () => {
    const glb = await saveWithPlacements(RECORDS);
    const r = await reloadIntoPlanner(glb);
    const entries = collectPlacementNodes(r.result.root);
    expect(entries.map((e) => e.placement.label).sort()).toEqual(['Belt', 'Belt_1', 'Belt_2']);
    for (const e of entries) expect(e.node.name).toBe(e.placement.label);
  });

  it('a record with an EMPTY name is saved under the fallback — loudly, and the save succeeds', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const glb = await saveWithPlacements([record('p_empty', '   ', 0)]);
    expect(referenceNodeNames(glb)).toEqual(['Placement']);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('placement p_empty has an empty name'));
    const problems = getProblems().filter((p) => p.code === 'placement-name-empty');
    expect(problems.map((p) => p.id)).toEqual(['placement-name-empty:p_empty']);
    error.mockRestore();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-650 Phase 5 — §9.4 parameters per placement (ModelCache / instancer level).
 *
 *  - Same values → ONE BakedAsset; other values → a second one; values at the
 *    baked default → the BASE bake, no generator run.
 *  - `_Parts` never reaches a bake (base or variant).
 *  - Cold restart: a fresh ModelCache with a warm CAD-GLB cache → 0 generator
 *    runs; with the CAD cache cleared → exactly 1.
 *  - Parallel variants of one asset bake from their own trees; `#split:` × `#param:`.
 *  - An invalidation while a variant generates discards it; retiring the base
 *    retires its variants; the LRU never evicts a referenced variant; the scene
 *    budget refuses with `parametric-variant-budget`.
 *  - The standstill probe refuses a generator run, but not a cache hit.
 *  - The placement sequence: two rapid requests → only the last one is applied.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import '../src/core/engine/rv-scene-loader';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { computeCodeHash } from '../src/core/engine/rv-parametric-hash';
import { getGeneratorRunCount } from '../src/core/engine/rv-parametric-generator';
import { resolveFamilyInputs } from '../src/core/engine/rv-parametric-family';
import { parametricRequestsOf, type ParametricRequest } from '../src/core/engine/rv-parametric-component';
import { clearCadGlbCache } from '../src/core/import/rv-cad-glb-cache';
import type { BakedAsset } from '../src/core/engine/rv-bake-chunk';

const URL_KEY = 'blob:rv-test/parametric-placement.glb';
const FAMILY_ID = 'fam-0001';
const uber = new RVUberMaterial(false);

const RULES = `
function generate(v, parts) {
  var inst = [{ part: 'Profile', name: 'Profile', positionMm: [0, 0, 0],
    stretch: [{ axis: 'x', atMm: 50, byMm: v.L - 100 }] }];
  for (var k = 0; k < v.N; k++) inst.push({ part: 'Roll', name: 'Roll_' + k, positionMm: [k * 20, 0, 10] });
  return { instances: inst, nodes: [], messages: [] };
}`;
const PARAMS = [
  { Name: 'L', Type: 'number', Unit: 'mm', Min: 60, Max: 1000, Step: 10, Default: 100 },
  { Name: 'N', Type: 'int', Min: 0, Max: 20, Default: 2 },
];
let codeHash = '';
let bakedHash = '';

/** A fresh asset tree: Conveyor / Fam [ParametricComponent] / _Parts + _Generated (default). */
function makeAsset(withHash = true): Group {
  const root = new Group();
  root.name = 'Conveyor';
  const fam = new Group();
  fam.name = 'Fam';
  const parts = new Group();
  parts.name = '_Parts';
  const mat = new MeshStandardMaterial({ name: 'steel' });
  const profile = new Group();
  profile.name = 'Profile';
  const pm = new Mesh(new BoxGeometry(100, 10, 10).translate(50, 0, 0), mat);
  pm.name = 'ProfileMesh';
  profile.add(pm);
  const roll = new Group();
  roll.name = 'Roll';
  const rm = new Mesh(new BoxGeometry(5, 5, 5), mat);
  rm.name = 'RollMesh';
  roll.add(rm);
  parts.add(profile, roll);
  const generated = new Group();
  generated.name = '_Generated';
  const gm = new Mesh(new BoxGeometry(100, 10, 10), mat);
  gm.name = 'DefaultBody';
  generated.add(gm);
  fam.add(parts, generated);
  fam.userData.realvirtual = {
    ParametricComponent: {
      ApiVersion: 1, Params: PARAMS, Values: { L: 100, N: 2 }, Code: RULES, CodeHash: codeHash,
      ...(withHash ? { BakedInputHash: bakedHash } : {}),
    },
  };
  setNodeId(fam, FAMILY_ID); // after the extras object — the NodeId lives inside it
  root.add(fam);
  return root;
}

function fakeLoader(counter?: { parses: number }): GLTFLoader {
  return {
    loadAsync: async (): Promise<{ scene: Group }> => {
      if (counter) counter.parses++;
      return { scene: makeAsset() };
    },
  } as unknown as GLTFLoader;
}

function makeCache(extra: Record<string, unknown> = {}): ModelCache {
  return new ModelCache(fakeLoader(), {
    uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }), ...extra,
  });
}

const req = (values: Record<string, unknown>): ParametricRequest[] => [{ familyNodeId: FAMILY_ID, values }];

function names(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => out.push(n.name));
  return out;
}

function familyValues(asset: BakedAsset): Record<string, unknown> | undefined {
  let v: Record<string, unknown> | undefined;
  asset.template.traverse((n) => {
    const pc = n.userData?.realvirtual?.ParametricComponent as { Values?: Record<string, unknown> } | undefined;
    if (pc) v = pc.Values;
  });
  return v;
}

beforeAll(async () => {
  codeHash = await computeCodeHash(RULES);
  const probe = makeAsset(false);
  bakedHash = (await resolveFamilyInputs(probe.children[0])).inputHash;
});

beforeEach(async () => { await clearCadGlbCache(); });
afterEach(async () => { await clearCadGlbCache(); });

describe('parametricRequestsOf', () => {
  it('reads byNodeId[*].ParametricComponent.Values, sorted, ignores the rest', () => {
    expect(parametricRequestsOf(null)).toEqual([]);
    expect(parametricRequestsOf({
      byNodeId: {
        b: { ParametricComponent: { Values: { L: 1 } } },
        a: { ParametricComponent: { Values: { L: 2 } }, Drive: { Speed: 1 } },
        c: { Drive: { Speed: 3 } },
      },
    })).toEqual([{ familyNodeId: 'a', values: { L: 2 } }, { familyNodeId: 'b', values: { L: 1 } }]);
  });
});

describe('ModelCache parametric variants (§9.4)', () => {
  it('same values share ONE asset, other values get their own, default = the base bake', async () => {
    const cache = makeCache();
    const base = await cache.getOrLoadBaked(URL_KEY);
    const runs0 = getGeneratorRunCount();

    const atDefault = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ L: 100, N: 2 }) });
    expect(atDefault).toBe(base);
    expect(getGeneratorRunCount() - runs0).toBe(0);

    const a1 = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ L: 400, N: 5 }) });
    const a2 = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ L: 400, N: 5 }) });
    // Normalizes to the same values (Step 10) → still the same variant, from the alias.
    const a3 = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ L: 401, N: 5 }) });
    expect(a2).toBe(a1);
    expect(a3).toBe(a1);
    expect(a1).not.toBe(base);
    expect(getGeneratorRunCount() - runs0).toBe(1);

    const b = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 7 }) });
    expect(b).not.toBe(a1);
    expect(getGeneratorRunCount() - runs0).toBe(2);
    expect(familyValues(a1)).toEqual({ L: 400, N: 5 });
    expect(familyValues(b)).toEqual({ L: 100, N: 7 });
    expect(a1.triangles).not.toBe(b.triangles);
    expect(cache.getParametricStats().variants).toBe(2);
  });

  it('_Parts never reaches a bake (base and variant)', async () => {
    const cache = makeCache();
    const base = await cache.getOrLoadBaked(URL_KEY);
    const v = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 4 }) });
    for (const asset of [base, v]) {
      const n = names(asset.template);
      expect(n).toContain('Fam');
      expect(n).not.toContain('_Parts');
      expect(n).not.toContain('ProfileMesh');
      expect(n).not.toContain('RollMesh');
    }
  });

  it('cold restart: warm CAD-GLB cache → 0 generator runs; cleared → exactly 1 (A3)', async () => {
    const first = makeCache();
    await first.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ L: 300 }) });
    first.dispose();

    const runs0 = getGeneratorRunCount();
    const warm = makeCache();
    const v = await warm.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ L: 300 }) });
    expect(getGeneratorRunCount() - runs0).toBe(0);
    expect(warm.getParametricStats().cacheHits).toBe(1);
    expect(familyValues(v)).toEqual({ L: 300, N: 2 });
    warm.dispose();

    await clearCadGlbCache();
    const cold = makeCache();
    await cold.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ L: 300 }) });
    expect(getGeneratorRunCount() - runs0).toBe(1);
    cold.dispose();
  });

  it('parallel variants bake from their own trees; split × param is its own key', async () => {
    const cache = makeCache();
    const [x, y, z] = await Promise.all([
      cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 3 }) }),
      cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 6 }) }),
      cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 3 }) }),
    ]);
    expect(z).toBe(x);
    expect(y).not.toBe(x);
    expect(familyValues(x)).toEqual({ L: 100, N: 3 });
    expect(familyValues(y)).toEqual({ L: 100, N: 6 });
  });

  it('an invalidation while the variant generates discards it; retiring the base retires its variants', async () => {
    const cache = makeCache();
    const pending = cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 9 }) });
    cache.invalidate(URL_KEY);
    await expect(pending).rejects.toThrow(/aborted/);
    expect(cache.getParametricStats().variants).toBe(0);

    const v = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 9 }) });
    v.acquire(); // a live neighbour instance
    cache.invalidate(URL_KEY);
    expect(v.retired).toBe(true);
    expect(v.disposed).toBe(false); // freed only at refcount 0
    expect(cache.getParametricStats().variants).toBe(0);
  });

  it('LRU per asset never evicts a referenced variant; the budget refuses (F16)', async () => {
    const cache = makeCache({ parametricLimits: { perAsset: 2, budget: 3 } });
    const live = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 1 }) });
    live.acquire();
    await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 3 }) });
    await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 4 }) });
    // perAsset 2: the idle N=3 went, the live N=1 stayed.
    expect(cache.getParametricStats().variants).toBe(2);
    expect(live.disposed).toBe(false);
    const again = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 1 }) });
    expect(again).toBe(live);

    // Budget 3 with every variant referenced → refused by code.
    const v4 = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 4 }) });
    v4.acquire();
    const v5 = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 5 }) });
    v5.acquire();
    await expect(cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 6 }) }))
      .rejects.toMatchObject({ code: 'parametric-variant-budget' });
  });

  it('the standstill probe refuses a generator run, never a cache hit (§2.6a)', async () => {
    let running = true;
    const cache = makeCache({ canRunParametricGenerator: () => !running });
    const runs0 = getGeneratorRunCount();
    await expect(cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 8 }) }))
      .rejects.toMatchObject({ code: 'parametric-deferred' });
    expect(getGeneratorRunCount() - runs0).toBe(0);
    running = false;
    await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 8 }) });
    expect(getGeneratorRunCount() - runs0).toBe(1);

    running = true;
    const other = makeCache({ canRunParametricGenerator: () => !running });
    const hit = await other.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 8 }) });
    expect(familyValues(hit)).toEqual({ L: 100, N: 8 });
    expect(getGeneratorRunCount() - runs0).toBe(1);
  });
});

describe('placement sequence (setPlacementParams)', () => {
  it('two rapid requests → only the last one is applied', async () => {
    const { rematerialize } = await import('../src/plugins/layout-planner/planner-parametric');
    const root = makeAsset();
    root.userData._layoutId = 'p1';
    const applied: string[] = [];
    let resolveFirst!: () => void;
    let calls = 0;
    const planner = {
      getPlacedRootById: (id: string) => (id === 'p1' ? root : null),
      rematerializePlacement: async (_id: string, ov: unknown, isCurrent: () => boolean) => {
        calls++;
        if (calls === 1) await new Promise<void>((r) => { resolveFirst = r; });
        if (!isCurrent()) return false;
        applied.push(JSON.stringify(ov));
        return true;
      },
      placements: { modelCache: makeCache() },
    };
    const host = { planner, viewer: { registry: null } } as never;
    const fam = root.children[0];
    (fam.userData.realvirtual.ParametricComponent as { Values: unknown }).Values = { L: 200, N: 2 };
    const first = rematerialize(host, 'p1');
    await Promise.resolve();
    (fam.userData.realvirtual.ParametricComponent as { Values: unknown }).Values = { L: 300, N: 2 };
    const second = rematerialize(host, 'p1');
    resolveFirst();
    expect(await first).toBe('superseded');
    expect(await second).toBe('applied');
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('"L":300');
  });
});

describe('placement inspector mask (plan-650 Phase 5 UI)', () => {
  it('routes a family node to its placement record and family path', async () => {
    const { placementTargetOf } = await import('../src/core/hmi/rv-parametric-values-field');
    const layout = new Group(); layout.name = 'Layout';
    const rec = new Group(); rec.name = 'Conveyor_1'; rec.userData._layoutId = 'p7';
    const mid = new Group(); mid.name = 'Frame';
    const fam = new Group(); fam.name = 'Family';
    layout.add(rec); rec.add(mid); mid.add(fam);
    expect(placementTargetOf(fam)).toEqual({ id: 'p7', family: 'Frame/Family' });
    expect(placementTargetOf(rec)).toEqual({ id: 'p7', family: '' });
    expect(placementTargetOf(layout)).toBeNull();
    expect(placementTargetOf(null)).toBeNull();
    // The planner's lookup wins over a stale record id.
    const planner = { findPlacedAncestor: (n: Object3D) => (n === fam || n === mid ? { id: 'planner-9', root: mid } : null) };
    expect(placementTargetOf(fam, planner)).toEqual({ id: 'planner-9', family: 'Family' });
  });
});

describe('values listener placement id (plan-650 Phase 5 finding)', () => {
  it('asks the planner (findPlacedAncestor) first, falls back to _layoutId', async () => {
    const { handleValuesChanged, placementIdAbove } = await import('../src/plugins/layout-planner/planner-parametric');
    const root = makeAsset();
    root.userData._layoutId = 'stale-record-id';
    const fam = root.children[0];
    expect(placementIdAbove(fam)).toBe('stale-record-id');
    const asked: string[] = [];
    const planner = {
      findPlacedAncestor: (n: Object3D) => (n === fam ? { id: 'planner-42', root } : null),
      getPlacedRootById: (id: string) => { asked.push(id); return null; },
      rematerializePlacement: async () => true,
      placements: { modelCache: makeCache() },
    };
    expect(placementIdAbove(fam, planner)).toBe('planner-42');
    const viewer = {
      registry: { getNode: (p: string) => (p === 'Fam' ? fam : null) },
      getPlugin: (id: string) => (id === 'layout-planner' ? planner : null),
    };
    handleValuesChanged(viewer as never, 'Fam');
    await Promise.resolve();
    expect(asked).toEqual(['planner-42']);
  });
});

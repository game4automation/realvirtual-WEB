// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-650 Phase 5b — §9.8 nested families (first slice: R2-2 / R2-3).
 *
 *  - R2-3: `Uses` enters the parent `InputHash` (known before the generator);
 *    a family without `Uses` keeps its Phase-5 hash.
 *  - R2-2: a `children[]` entry becomes an EMPTY, non-embedded
 *    `AssetReference` node `_Generated/_Children/<i>` with a stable NodeId and
 *    the child values as `AssetOverrides` — no child content in the parent.
 *    It survives the parent bake and is what the placement instancer queues
 *    as a nested placement (with the overrides → the child's variant).
 *  - Warm load: the cached variant carries the reference nodes (the manifest)
 *    → 0 generator runs, same nested entries.
 *  - A child not declared in `Uses` → `parametric-undeclared-child`.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import '../src/core/engine/rv-scene-loader';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { getNodeId, setNodeId } from '../src/core/engine/rv-node-id';
import { computeCodeHash } from '../src/core/engine/rv-parametric-hash';
import { getGeneratorRunCount } from '../src/core/engine/rv-parametric-generator';
import { buildVariant, resolveFamilyInputs } from '../src/core/engine/rv-parametric-family';
import { getAssetOverrides, getAssetReference } from '../src/core/engine/rv-asset-reference';
import { collectNestedReferences, walkReferenceNodes } from '../src/core/engine/rv-placement-instancer';
import { clearCadGlbCache } from '../src/core/import/rv-cad-glb-cache';

const URL_KEY = 'blob:rv-test/parametric-nested.glb';
const FAMILY_ID = 'fam-parent';
const CHILD_FAMILY_NODE = 'fam-child';
const uber = new RVUberMaterial(false);

const RULES = `
function generate(v, parts) {
  var ch = [];
  for (var k = 0; k < v.N; k++) ch.push({ family: 'lib:roller', values: { D: v.D }, positionMm: [k * 100, 0, 0] });
  return { instances: [{ part: 'Frame', name: 'Frame', positionMm: [0, 0, 0] }], children: ch };
}`;
const PARAMS = [
  { Name: 'N', Type: 'int', Min: 0, Max: 20, Default: 2 },
  { Name: 'D', Type: 'number', Unit: 'mm', Min: 20, Max: 80, Default: 50 },
];
const USES = [{ Family: 'lib:roller', FamilyNodeId: CHILD_FAMILY_NODE, DocHash: 'doc-v1' }];
let codeHash = '';
let bakedHash = '';

function makeAsset(opts: { withHash?: boolean; uses?: unknown } = {}): Group {
  const root = new Group();
  root.name = 'Line';
  const fam = new Group();
  fam.name = 'Fam';
  const parts = new Group();
  parts.name = '_Parts';
  const frame = new Group();
  frame.name = 'Frame';
  const fm = new Mesh(new BoxGeometry(100, 10, 10), new MeshStandardMaterial({ name: 'steel' }));
  fm.name = 'FrameMesh';
  frame.add(fm);
  parts.add(frame);
  const generated = new Group();
  generated.name = '_Generated';
  const gm = new Mesh(new BoxGeometry(100, 10, 10), new MeshStandardMaterial({ name: 'steel' }));
  gm.name = 'DefaultBody';
  generated.add(gm);
  fam.add(parts, generated);
  fam.userData.realvirtual = {
    ParametricComponent: {
      ApiVersion: 1, Params: PARAMS, Values: { N: 2, D: 50 }, Code: RULES, CodeHash: codeHash,
      ...(opts.uses === null ? {} : { Uses: opts.uses ?? USES }),
      ...(opts.withHash !== false ? { BakedInputHash: bakedHash } : {}),
    },
  };
  setNodeId(fam, FAMILY_ID);
  root.add(fam);
  return root;
}

function makeCache(): ModelCache {
  const loader = { loadAsync: async () => ({ scene: makeAsset() }) } as unknown as GLTFLoader;
  return new ModelCache(loader, { uber: () => uber, pickPort: () => createPickBuildPort({ createWorker: () => null }) });
}

const req = (values: Record<string, unknown>) => [{ familyNodeId: FAMILY_ID, values }];

function meshCount(n: Object3D): number {
  let c = 0;
  n.traverse((x) => { if ((x as Mesh).isMesh) c++; });
  return c;
}

beforeAll(async () => {
  codeHash = await computeCodeHash(RULES);
  bakedHash = (await resolveFamilyInputs(makeAsset({ withHash: false }).children[0])).inputHash;
});
beforeEach(async () => { await clearCadGlbCache(); });
afterEach(async () => { await clearCadGlbCache(); });

describe('R2-3: Uses enters the parent InputHash before the generator', () => {
  it('child document change changes the hash; no Uses = the Phase-5 hash', async () => {
    const fam = (o: Parameters<typeof makeAsset>[0]) => makeAsset({ withHash: false, ...o }).children[0];
    const h1 = (await resolveFamilyInputs(fam({}))).inputHash;
    const h2 = (await resolveFamilyInputs(fam({ uses: [{ ...USES[0], DocHash: 'doc-v2' }] }))).inputHash;
    const none = (await resolveFamilyInputs(fam({ uses: null }))).inputHash;
    const empty = (await resolveFamilyInputs(fam({ uses: [] }))).inputHash;
    expect(h2).not.toBe(h1);
    expect(none).not.toBe(h1);
    expect(empty).toBe(none);
  });
});

describe('R2-2: children are empty reference nodes', () => {
  it('buildVariant places _Children/<i> with reference, overrides and a stable NodeId', async () => {
    const fam = makeAsset().children[0];
    const v = await buildVariant(fam, { N: 3, D: 40 });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const holder = v.root.children.find((c) => c.name === '_Children')!;
    expect(holder.children.map((c) => c.name)).toEqual(['0', '1', '2']);
    const c1 = holder.children[1];
    expect(getAssetReference(c1)).toMatchObject({ assetId: 'lib:roller' });
    expect(getAssetReference(c1)?.embedded).toBeUndefined();
    expect(getAssetOverrides(c1)?.byAddress).toEqual({ [`#${CHILD_FAMILY_NODE}`]: { ParametricComponent: { Values: { D: 40 } } } });
    expect(getNodeId(c1)).toBe(`${FAMILY_ID}:_Children:1`);
    expect(c1.position.x).toBe(100);
    expect(meshCount(holder)).toBe(0);
  });

  it('a child not declared in Uses → parametric-undeclared-child', async () => {
    const fam = makeAsset({ uses: [] }).children[0];
    const v = await buildVariant(fam, { N: 1, D: 40 });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error.code).toBe('parametric-undeclared-child');
  });

  it('the variant bake keeps the empty reference nodes; warm load reads them with 0 generator runs', async () => {
    const cache = makeCache();
    const runs0 = getGeneratorRunCount();
    const v = await cache.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 3, D: 30 }) });
    expect(getGeneratorRunCount() - runs0).toBe(1);
    const refs = walkReferenceNodes(v.template);
    expect(refs).toHaveLength(3);
    for (const r of refs) {
      expect(meshCount(r)).toBe(0);
      expect(getAssetOverrides(r)?.byAddress[`#${CHILD_FAMILY_NODE}`]).toEqual({ ParametricComponent: { Values: { D: 30 } } });
    }
    // The instancer's nested scan turns them into nested placements of the parent.
    const { entries, refused } = collectNestedReferences(
      { node: v.template, id: 'p1', occurrence: 'p1', chain: [], depth: 0 },
      { parentKey: URL_KEY, parentUrl: URL_KEY, parentState: undefined as never, keyOf: (r) => r.catalogId, nodes: refs },
    );
    expect(refused).toEqual([]);
    expect(entries.map((e) => e.id)).toEqual([0, 1, 2].map((i) => `p1/${FAMILY_ID}:_Children:${i}`));
    expect(entries.every((e) => e.nestedOf === 'p1' && e.ref.catalogId === 'lib:roller')).toBe(true);
    cache.dispose();

    const warm = makeCache();
    const runs1 = getGeneratorRunCount();
    const w = await warm.getOrLoadBaked(URL_KEY, undefined, { parametric: req({ N: 3, D: 30 }) });
    expect(getGeneratorRunCount() - runs1).toBe(0);
    const warmRefs = walkReferenceNodes(w.template);
    expect(warmRefs.map((r) => getNodeId(r))).toEqual(refs.map((r) => getNodeId(r)));
    expect(getAssetOverrides(warmRefs[2])?.byAddress[`#${CHILD_FAMILY_NODE}`]).toEqual({ ParametricComponent: { Values: { D: 30 } } });
    warm.dispose();
  });
});

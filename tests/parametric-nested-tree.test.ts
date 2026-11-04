// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-650 Phase 5b — §9.8 nested families, second slice:
 *
 *  - 50 parents in 12 value sets, each with ONE child of identical values →
 *    12 + 1 generator runs, 13 variant assets, the child variant shared by 50.
 *  - Child distance only in `positionMm` → same child variant.
 *  - Cycle A→A through a child family → `parametric-cycle`; family depth > 4 →
 *    `parametric-depth`; aggregated child budget (placements / vertices) →
 *    `parametric-budget`.
 *  - Reference from parent content into a child → `parametric-cross-reference`.
 *  - Share export bundles the child families (flat, transitive), the import
 *    unpacks them; a child the export lacks is reported (`missing`), and a
 *    declared child absent in the project is a `parametric-child-missing` candidate.
 *  - `editor.parametricUse`: pure Uses list maintenance + Uses read from a child document.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import '../src/core/engine/rv-scene-loader';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { getGeneratorRunCount } from '../src/core/engine/rv-parametric-generator';
import { assemble, findChildReference } from '../src/core/engine/rv-parametric-assembly';
import { RV_ASSET_OVERRIDES_KEY, RV_ASSET_REFERENCE_KEY } from '../src/core/engine/rv-asset-reference';
import {
  MAX_PARAMETRIC_DEPTH,
  PlacementInstancer,
  collectNestedReferences,
  type NestedReferenceRefusal,
} from '../src/core/engine/rv-placement-instancer';
import { clearCadGlbCache } from '../src/core/import/rv-cad-glb-cache';
import { objectToGlb } from '../src/core/import/rv-import-object';
import {
  bundleChildFamilies, declaredUsesOf, familyUseFromGlb, missingChildFamilies, unpackChildFamilies,
} from '../src/core/engine/rv-parametric-bundle';
import { readGlbJson } from '../src/core/engine/rv-binary-resources';
import { computeCodeHash, sha256HexBytes } from '../src/core/engine/rv-parametric-hash';
import { applyUseChange } from '../src/core/editor/rv-parametric-uses';
import { NESTED_REFERENCE_PROBLEM_CODES } from '../src/core/hmi/problems-store';

const PARENT_URL = 'blob:rv-test/p650-tree-parent.glb';
const CHILD_URL = 'blob:rv-test/p650-tree-child.glb';
const PARENT_FAM = 'fam-parent';
const CHILD_FAM = 'fam-child';
const uber = new RVUberMaterial(false);
let parentCodeHash = '';
let childCodeHash = '';

// Parent: frame + ONE child whose values do NOT depend on the parent values.
const PARENT_RULES = `
function generate(v, parts) {
  return { instances: [{ part: 'Frame', name: 'Frame', positionMm: [0, 0, 0] }],
           children: [{ family: 'lib:sensor', values: { S: 7 }, positionMm: [v.D, 0, 0] }] };
}`;
const CHILD_RULES = `
function generate(v, parts) { return { instances: [{ part: 'Frame', name: 'Body', positionMm: [0, 0, 0] }] }; }`;

function familyAsset(opts: { famId: string; rules: string; params: unknown[]; values: Record<string, unknown>; uses?: unknown[] }): Group {
  const root = new Group();
  root.name = opts.famId === PARENT_FAM ? 'Line' : 'Sensor';
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
      ApiVersion: 1, Params: opts.params, Values: opts.values, Code: opts.rules, CodeHash: opts.rules === PARENT_RULES ? parentCodeHash : childCodeHash,
      ...(opts.uses ? { Uses: opts.uses } : {}),
    },
  };
  setNodeId(fam, opts.famId);
  root.add(fam);
  return root;
}

const parentAsset = () => familyAsset({
  famId: PARENT_FAM, rules: PARENT_RULES,
  params: [{ Name: 'D', Type: 'int', Min: 0, Max: 1000, Default: 100 }], values: { D: 100 },
  uses: [{ Family: 'lib:sensor', FamilyNodeId: CHILD_FAM, DocHash: 'doc-s1' }],
});
const childAsset = () => familyAsset({
  famId: CHILD_FAM, rules: CHILD_RULES,
  params: [{ Name: 'S', Type: 'int', Min: 0, Max: 100, Default: 1 }], values: { S: 1 },
});

function makeInstancer(refused: NestedReferenceRefusal[], registry = new BakeRegistry()) {
  const loader = {
    loadAsync: async (url: string) => ({ scene: url === CHILD_URL ? childAsset() : parentAsset() }),
  } as unknown as GLTFLoader;
  const instancer = new PlacementInstancer({
    bakeRegistry: () => registry, loader, uber: () => uber,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
    onNestedRefused: (r) => { refused.push(r); },
    missingDefault: () => {},
  });
  return { instancer, registry };
}

const hooks = { resolveUrl: async () => CHILD_URL };
// plan-769: placement overrides are `byAddress` (`#<id>`).
const parentOverrides = (D: number) => ({ byAddress: { [`#${PARENT_FAM}`]: { ParametricComponent: { Values: { D } } } } });

async function placeParents(instancer: PlacementInstancer, ds: number[]): Promise<void> {
  const scene = new Scene();
  for (let i = 0; i < ds.length; i++) {
    const overrides = parentOverrides(ds[i]);
    const baked = await instancer.resolveBaked({ catalogId: 'lib:line', glbUrl: PARENT_URL }, { overrides });
    const root = instancer.createRoot(baked);
    scene.add(root);
    instancer.materialize(root, baked, { id: `p${i}`, label: `Line_${i}`, catalogId: 'lib:line', overrides }, hooks);
  }
  await instancer.whenMaterialized();
}

beforeAll(async () => {
  parentCodeHash = await computeCodeHash(PARENT_RULES);
  childCodeHash = await computeCodeHash(CHILD_RULES);
});
beforeEach(async () => { await clearCadGlbCache(); });
afterEach(async () => { await clearCadGlbCache(); });

describe('50 parents share ONE child variant', () => {
  it('12 value sets × 1 equal child → 12 + 1 generator runs, 13 variant assets, child refcount 50', async () => {
    const refused: NestedReferenceRefusal[] = [];
    const { instancer, registry } = makeInstancer(refused);
    const ds = Array.from({ length: 50 }, (_, i) => 100 + (i % 12) * 10);
    const runs0 = getGeneratorRunCount();
    await placeParents(instancer, ds);
    expect(refused).toEqual([]);
    expect(getGeneratorRunCount() - runs0).toBe(13);
    const byAsset = new Map<unknown, number>();
    for (const inst of registry.instances) byAsset.set(inst.baked, (byAsset.get(inst.baked) ?? 0) + 1);
    expect(registry.instances.size).toBe(100);
    expect(byAsset.size).toBe(13);
    // The child distance lives in positionMm only → ONE child variant for all 50.
    const counts = [...byAsset.entries()].filter(([b]) => (b as { url: string }).url === CHILD_URL).map(([, n]) => n);
    expect(counts).toEqual([50]);
    instancer.clearDocument();
  });
});

describe('aggregated child budget per placement tree', () => {
  it('placements over the budget → parametric-budget, the rest stands', async () => {
    const refused: NestedReferenceRefusal[] = [];
    const { instancer, registry } = makeInstancer(refused);
    instancer.maxParametricTreePlacements = 0;
    await placeParents(instancer, [100]);
    expect(refused.map((r) => r.reason)).toEqual(['parametric-budget']);
    expect(registry.instances.size).toBe(1);
    instancer.clearDocument();
  });

  it('vertices over the budget → parametric-budget, the child is not materialised', async () => {
    const refused: NestedReferenceRefusal[] = [];
    const { instancer, registry } = makeInstancer(refused);
    instancer.maxParametricTreeVertices = 1;
    await placeParents(instancer, [100, 110]);
    expect(refused.map((r) => r.reason)).toEqual(['parametric-budget', 'parametric-budget']);
    expect(registry.instances.size).toBe(2);
    instancer.clearDocument();
  });

  it('every refusal reason has its own problem code', () => {
    expect(NESTED_REFERENCE_PROBLEM_CODES['parametric-cycle']).toBe('parametric-cycle');
    expect(NESTED_REFERENCE_PROBLEM_CODES['parametric-depth']).toBe('parametric-depth');
    expect(NESTED_REFERENCE_PROBLEM_CODES['parametric-budget']).toBe('parametric-budget');
  });
});

describe('cycle and depth of child families', () => {
  function childRef(assetId: string): Object3D {
    const n = new Group();
    n.name = '0';
    n.userData.realvirtual = {
      [RV_ASSET_REFERENCE_KEY]: { assetId },
      [RV_ASSET_OVERRIDES_KEY]: { byNodeId: { x: { ParametricComponent: { Values: { S: 1 } } } } },
    };
    setNodeId(n, 'x:_Children:0');
    return n;
  }
  const scan = (node: Object3D, parent: Partial<Parameters<typeof collectNestedReferences>[0]>, parentKey = 'lib:b') =>
    collectNestedReferences(
      { node: new Group(), id: 'p', occurrence: 'p', chain: [], depth: 0, ...parent },
      { parentKey, parentUrl: '', parentState: undefined as never, keyOf: (r) => r.catalogId, nodes: [node] },
    );

  it('A → B → A through child families → parametric-cycle; a plain reference keeps reference-cycle', () => {
    const r = scan(childRef('lib:a'), { chain: ['lib:a'] });
    expect(r.entries).toEqual([]);
    expect(r.refused.map((x) => x.reason)).toEqual(['parametric-cycle']);
    const plain = new Group();
    plain.userData.realvirtual = { [RV_ASSET_REFERENCE_KEY]: { assetId: 'lib:a' } };
    // plan-769 F12: a reference node without identity stays empty (no `@ordinal`).
    setNodeId(plain, 'plain');
    expect(scan(plain, { chain: ['lib:a'] }).refused.map((x) => x.reason)).toEqual(['cycle']);
  });

  it(`family level ${MAX_PARAMETRIC_DEPTH} is allowed, level ${MAX_PARAMETRIC_DEPTH + 1} → parametric-depth`, () => {
    const ok = scan(childRef('lib:c'), { paramDepth: MAX_PARAMETRIC_DEPTH - 1 });
    expect(ok.refused).toEqual([]);
    expect(ok.entries[0]).toMatchObject({ paramDepth: MAX_PARAMETRIC_DEPTH, paramRoot: 'p' });
    const deep = scan(childRef('lib:c'), { paramDepth: MAX_PARAMETRIC_DEPTH });
    expect(deep.entries).toEqual([]);
    expect(deep.refused.map((x) => x.reason)).toEqual(['parametric-depth']);
  });

  it('the paramRoot is inherited down the tree', () => {
    const r = scan(childRef('lib:c'), { paramDepth: 2, paramRoot: 'outer' });
    expect(r.entries[0].paramRoot).toBe('outer');
  });
});

describe('parametric-cross-reference', () => {
  it('findChildReference spots paths through _Children, nested in objects / arrays', () => {
    expect(findChildReference({ Drive: { Path: '_Children/0/Body' } })).toBe('_Children/0/Body');
    expect(findChildReference(['a', 'Line/_Generated/_Children/2'])).toBe('Line/_Generated/_Children/2');
    expect(findChildReference({ Name: 'MyChildren', Path: 'Frame' })).toBeNull();
  });

  it('a component referencing into a child is refused by the assembly', () => {
    const parts = new Group();
    const frame = new Group();
    frame.name = 'Frame';
    frame.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    parts.add(frame);
    const res = assemble(parts, {
      instances: [{ part: 'Frame', name: 'Frame', positionMm: [0, 0, 0] }],
      nodes: [],
      components: [{ node: 'Frame', type: 'Sensor', fields: { Target: { path: '_Children/0/Body' } } }],
      messages: [],
      children: [{ family: 'lib:s', values: {}, positionMm: [0, 0, 0] }],
    }, { uses: [{ Family: 'lib:s', FamilyNodeId: 'fs', DocHash: 'h' }], validateComponent: () => null });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('parametric-cross-reference');
  });
});

describe('share export bundles child families; import unpacks them', () => {
  it('flat + transitive, verbatim bytes (DocHash = SHA of the bytes), missing reported', async () => {
    const grand = new Uint8Array(await objectToGlb(childAsset()));
    const mid = new Uint8Array(await objectToGlb(familyAsset({
      famId: 'fam-mid', rules: CHILD_RULES, params: [], values: {},
      uses: [{ Family: 'lib:grand', FamilyNodeId: CHILD_FAM, DocHash: await sha256HexBytes(grand) }],
    })));
    const parent = new Uint8Array(await objectToGlb(familyAsset({
      famId: PARENT_FAM, rules: PARENT_RULES, params: [], values: {},
      uses: [
        { Family: 'lib:mid', FamilyNodeId: 'fam-mid', DocHash: await sha256HexBytes(mid) },
        { Family: 'lib:gone', FamilyNodeId: 'x', DocHash: 'h' },
      ],
    })));
    expect(declaredUsesOf(readGlbJson(parent)).map((u) => u.Family)).toEqual(['lib:mid', 'lib:gone']);
    const lib = new Map([['lib:mid', mid], ['lib:grand', grand]]);
    const out = bundleChildFamilies(parent, (u) => lib.get(u.Family));
    expect(out.bundled).toEqual(['lib:mid', 'lib:grand']);
    expect(out.missing).toEqual(['lib:gone']);
    // The parent itself is still a readable GLB with its family.
    expect(declaredUsesOf(readGlbJson(out.glb))).toHaveLength(2);

    const unpacked = unpackChildFamilies(out.glb);
    expect(unpacked.map((c) => c.Family)).toEqual(['lib:mid', 'lib:grand']);
    for (const c of unpacked) expect(await sha256HexBytes(c.bytes)).toBe(c.DocHash);
    // In a fresh project only what was unpacked exists: the absent one is a child-missing candidate.
    const project = new Set(unpacked.map((c) => c.Family));
    expect(missingChildFamilies(out.glb, (f) => project.has(f))).toEqual(['lib:gone']);
  });

  it('a GLB without Uses is returned unchanged', async () => {
    const bytes = new Uint8Array(await objectToGlb(childAsset()));
    const out = bundleChildFamilies(bytes, () => null);
    expect(out.glb).toBe(bytes);
    expect(unpackChildFamilies(bytes)).toEqual([]);
  });
});

describe('editor.parametricUse — Uses maintenance', () => {
  it('familyUseFromGlb reads FamilyNodeId and DocHash from the child document', async () => {
    const bytes = new Uint8Array(await objectToGlb(childAsset()));
    const use = await familyUseFromGlb(bytes, 'lib:sensor', 'lib/sensor.glb');
    expect(use).toEqual({ Family: 'lib:sensor', FamilyNodeId: CHILD_FAM, DocHash: await sha256HexBytes(bytes), Path: 'lib/sensor.glb' });
    const plain = new Uint8Array(await objectToGlb(new Group()));
    await expect(familyUseFromGlb(plain, 'lib:x')).rejects.toThrow(/no parametric family/);
  });

  it('applyUseChange adds, replaces in place and removes', () => {
    const a = { Family: 'a', FamilyNodeId: 'na', DocHash: '1' };
    const b = { Family: 'b', FamilyNodeId: 'nb', DocHash: '1' };
    const added = applyUseChange([a], { family: 'b', use: b });
    expect(added.map((u) => u.Family)).toEqual(['a', 'b']);
    const replaced = applyUseChange(added, { family: 'a', use: { ...a, DocHash: '2' } });
    expect(replaced.map((u) => `${u.Family}${u.DocHash}`)).toEqual(['a2', 'b1']);
    expect(applyUseChange(replaced, { family: 'a', remove: true }).map((u) => u.Family)).toEqual(['b']);
    expect(() => applyUseChange([], { family: 'zz', remove: true })).toThrow(/not declared/);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.3 — the Phase-0 removal report.
 *
 * A real `loadGLB` with the loader bake: the report is recorded, lists the
 * removal tops, carries the plugin claims — and NOTHING is removed from the
 * loaded tree. Plus the G1 helper `expectNoClaimedNodeRemoved`, the D6
 * never-merge gates and the `InstancedMesh` expansion with its
 * `instancedTriangles` count.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  BoxGeometry, BufferAttribute, BufferGeometry, Color, Group, InstancedMesh, Line, LineBasicMaterial,
  Matrix4, Mesh, MeshStandardMaterial, Object3D, Scene,
} from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { classifyBakeTree } from '../src/core/engine/rv-bake-pipeline';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import {
  bakeRemovalReport, computeSurvival, lastBakeSurvivalCounts, recordBakeRemovalReport,
  _resetBakeRemovalReportForTesting,
} from '../src/core/engine/rv-bake-survival';
import { bakeTree, chunkByKey, group, uberBakeGeometry, uberMesh, withComponent } from './fixtures/bake-fixture';
import { expectNoClaimedNodeRemoved, pathFromRoot, refTo, registryFor } from './helpers/bake-survival';

// plan-754 Phase 1c: these cases are about the REPORT — what the survival
// model decides and how it is published. The bake acts on that verdict, so the
// loader-level cases assert that the report and the resulting graph AGREE.

const uber = new RVUberMaterial(false);
const material = new MeshStandardMaterial({ color: 0x445566 });

function box(name: string, pos: [number, number, number], extras?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material.clone());
  m.name = name;
  m.position.set(...pos);
  if (extras) m.userData.realvirtual = extras;
  return m;
}

/**
 *   Plant
 *   ├─ Frame                 plain                      → removal top
 *   ├─ Cad                   plain group                → removal top
 *   │   └─ Bolt              plain (the plugin claims it in one test)
 *   ├─ Info {RuntimeMetadata}
 *   │   └─ Panel             plain                      → removal top
 *   ├─ Axis {Drive}
 *   │   └─ Arm               plain                      → removal top
 *   └─ Beacon {Lamp}         keep
 */
function buildPlant(): Group {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(box('Frame', [0, 0, 0]));
  const cad = new Group(); cad.name = 'Cad'; cad.add(box('Bolt', [2, 0, 0]));
  plant.add(cad);
  const info = new Group(); info.name = 'Info';
  info.userData.realvirtual = { RuntimeMetadata: { Content: 'hello' } };
  info.add(box('Panel', [4, 0, 0]));
  plant.add(info);
  const axis = new Group(); axis.name = 'Axis';
  axis.userData.realvirtual = { Drive: { Direction: 'LinearY', TargetSpeed: 250 } };
  axis.add(box('Arm', [8, 0, 0]));
  plant.add(axis);
  plant.add(box('Beacon', [12, 0, 0], { Lamp: { OnColor: { r: 1, g: 0, b: 0, a: 1 } } }));
  return plant;
}

let bytes: ArrayBuffer;
beforeAll(async () => { bytes = await objectToGlb(buildPlant()); });

async function load(opts: { bakeClaims?: Array<{ path: string; role: 'merge' | 'chunk' }>; preserveHierarchy?: boolean } = {}): Promise<{ result: LoadResult; scene: Scene }> {
  const scene = new Scene();
  const result = await loadGLB('plant.glb', scene, {
    data: bytes.slice(0),
    loadKinematicsSidecar: false,
    preserveHierarchy: opts.preserveHierarchy,
    bakeRegistry: new BakeRegistry(),
    bakePickPort: createPickBuildPort({ createWorker: () => null }),
    bakeClaims: opts.bakeClaims,
  });
  return { result, scene };
}

/** Every node of the loaded model — a plain traverse is complete (plan-754). */
function allNodeNames(root: Object3D): string[] {
  const names: string[] = [];
  root.traverse((n) => { if (!n.userData._rvBakeChunk) names.push(n.name); });
  return names.sort();
}

describe('Phase-0 removal report (plan-754 §9.3)', () => {
  beforeEach(() => { _resetBakeRemovalReportForTesting(); });

  it('a baked load records one report and the graph matches its verdict', async () => {
    const { result } = await load();
    expect(result.bakedAsset).toBeTruthy();
    expect(bakeRemovalReport.length).toBe(1);
    const report = bakeRemovalReport[0];
    expect(report.assetId).toBe('plant.glb');
    const tops = report.removalTops.map((p) => p.slice(p.lastIndexOf('/') + 1)).sort();
    expect(tops).toEqual(['Arm', 'Cad', 'Frame', 'Panel']);
    expect(report.removalTopsTotal).toBe(4);
    expect(report.counts.removed).toBe(5);
    expect(report.counts.removedMeshes).toBe(4);
    expect(report.g1Violations).toEqual([]);
    expect(report.unresolvedClaims).toEqual([]);
    // The report is not an opinion: what it named is gone from the graph and
    // from the registry, and what it did not name is still there.
    const names = allNodeNames(result.root);
    for (const n of ['Info', 'Axis', 'Beacon']) expect(names, n).toContain(n);
    for (const n of ['Frame', 'Cad', 'Bolt', 'Panel', 'Arm']) expect(names, n).not.toContain(n);
    for (const p of report.removalTops) expect(result.registry.getNode(p), p).toBeNull();
    // web_status.bake.survival reads the same counts.
    expect(lastBakeSurvivalCounts()).toMatchObject({ assetId: 'plant.glb', removed: 5, g1Violations: 0 });
  });

  it('a plugin claim keeps its bare node (merge) and its ancestors out of the removal set', async () => {
    // `Bolt` is a removal top without a claim, so its path cannot be read back
    // from a loaded model any more — it is the authored path, which is exactly
    // what a plugin's `bakeClaims()` declares (it runs before the bake).
    const boltPath = 'Plant/Cad/Bolt';
    _resetBakeRemovalReportForTesting();
    const { result } = await load({ bakeClaims: [{ path: boltPath, role: 'merge' }, { path: 'Plant/DoesNotExist', role: 'chunk' }] });
    const report = bakeRemovalReport[0];
    const tops = report.removalTops.map((p) => p.slice(p.lastIndexOf('/') + 1)).sort();
    expect(tops).toEqual(['Arm', 'Frame', 'Panel']);
    // The claim really kept it: Bolt and its ancestor Cad survive the bake.
    const names = allNodeNames(result.root);
    expect(names).toContain('Bolt');
    expect(names).toContain('Cad');
    // Unresolved claim: reported, never thrown.
    expect(report.unresolvedClaims).toEqual([{ path: 'Plant/DoesNotExist', role: 'chunk' }]);
    expect(report.counts.unresolvedClaims).toBe(1);
  });

  it('a chunk claim makes the claimed node a chunk boundary of the loader bake', async () => {
    const cadPath = 'Plant/Cad';
    const { result } = await load({ bakeClaims: [{ path: cadPath, role: 'chunk' }] });
    const keys = result.bakedAsset!.chunks.map((c) => c.key);
    expect(keys.some((k) => k.startsWith('mover:') && k.endsWith('/Cad'))).toBe(true);
  });

  it('an authoring load (preserveHierarchy) never computes a report', async () => {
    await load({ preserveHierarchy: true });
    expect(bakeRemovalReport.length).toBe(0);
  });

  it('the report log is capped', () => {
    const root = group('Asset'); root.add(uberMesh(uber, 'a'));
    const registry = registryFor(root);
    for (let i = 0; i < 40; i++) recordBakeRemovalReport('a' + i, root, registry, undefined, (n) => pathFromRoot(n, root));
    expect(bakeRemovalReport.length).toBe(32);
    expect(bakeRemovalReport[bakeRemovalReport.length - 1].assetId).toBe('a39');
  });
});

describe('G1 helper expectNoClaimedNodeRemoved', () => {
  it('passes on a consistent model', () => {
    const root = group('Asset');
    const rod = group('Rod'); rod.add(uberMesh(uber, 'rodMesh'));
    root.add(rod, withComponent(group('J'), 'KinematicJoint', { BodyB: refTo('Asset/Rod') }), uberMesh(uber, 'loose', [3, 0, 0]));
    const model = computeSurvival(root, registryFor(root), [{ path: 'Asset/Rod/rodMesh', role: 'merge' }]);
    expectNoClaimedNodeRemoved(model, root);
    expect(model.reasonOf(rod.children[0])).toBe('plugin-claim');
  });

  it('fails when outside evidence says a removed node is needed', () => {
    const root = group('Asset');
    const loose = uberMesh(uber, 'loose');
    root.add(loose);
    const model = computeSurvival(root, registryFor(root));
    expect(() => expectNoClaimedNodeRemoved(model, root, (n) => n === loose)).toThrow();
  });

  it('fails on an unresolved plugin claim', () => {
    const root = group('Asset');
    const model = computeSurvival(root, registryFor(root), [{ path: 'Asset/Nope', role: 'merge' }]);
    expect(() => expectNoClaimedNodeRemoved(model, root)).toThrow();
  });
});

describe('never-merge detection + InstancedMesh expansion (plan-754 D6)', () => {
  it('skinned flag, skin attributes, morph attributes and non-Mesh drawables are keep', () => {
    const root = group('Asset');
    const skinned = uberMesh(uber, 'skinnedFlag');
    (skinned as unknown as { isSkinnedMesh: boolean }).isSkinnedMesh = true;
    const skinAttr = uberMesh(uber, 'skinAttr', [2, 0, 0]);
    skinAttr.geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(24 * 4), 4));
    const morph = uberMesh(uber, 'morph', [4, 0, 0]);
    morph.geometry.morphAttributes.position = [new BufferAttribute(new Float32Array(24 * 3), 3)];
    const line = new Line(new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(6), 3)), new LineBasicMaterial());
    line.name = 'line';
    const plain = uberMesh(uber, 'plain', [6, 0, 0]);
    root.add(skinned, skinAttr, morph, line, plain);
    const c = classifyBakeTree(root, { uberMaterial: uber });
    expect(c.keep.map((k) => k.name).sort()).toEqual(['line', 'morph', 'skinAttr', 'skinnedFlag']);
    expect(c.staged.map((m) => m.name)).toEqual(['plain']);
  });

  it('every instance is staged with instanceMatrix × node matrix; instancedTriangles counts the expansion', async () => {
    const root = group('Asset');
    const holder = group('Holder'); holder.position.set(10, 0, 0);
    const inst = new InstancedMesh(uberBakeGeometry(new BoxGeometry(1, 1, 1)), uber, 3);
    inst.name = 'bolts';
    inst.userData._rvUberBaked = true;
    for (let i = 0; i < 3; i++) inst.setMatrixAt(i, new Matrix4().makeTranslation(0, i * 5, 0));
    holder.add(inst);
    root.add(holder);

    const model = computeSurvival(root, registryFor(root));
    expect(model.counts.instancedTriangles).toBe(36);

    const staged: Mesh[] = [];
    const asset = await bakeTree(root, { uber, onStaged: (m) => staged.push(m) });
    const chunk = chunkByKey(asset, 'static');
    expect(chunk.triangles).toBe(36);
    expect(chunk.geometry.getAttribute('position').count).toBe(72);
    // One staging pass per instance, all of them the one InstancedMesh (plan-756:
    // read from `onStaged`, the retained `sources[]` table is gone).
    expect(staged.length).toBe(3);
    expect(staged.every((m) => m === inst)).toBe(true);
    // Bounds: x = 10 ± 0.5 (node matrix), y from -0.5 to 10.5 (instance matrices).
    expect(chunk.bounds.min.x).toBeCloseTo(9.5); expect(chunk.bounds.max.x).toBeCloseTo(10.5);
    expect(chunk.bounds.min.y).toBeCloseTo(-0.5); expect(chunk.bounds.max.y).toBeCloseTo(10.5);
  });

  it('an InstancedMesh with per-instance colours stays a keep mesh', () => {
    const root = group('Asset');
    const inst = new InstancedMesh(uberBakeGeometry(new BoxGeometry(1, 1, 1)), uber, 2);
    inst.name = 'coloured';
    inst.setColorAt(0, new Color(1, 0, 0));
    root.add(inst);
    const c = classifyBakeTree(root, { uberMaterial: uber });
    expect(c.keep).toEqual([inst]);
    expect(c.instancedTriangles).toBe(0);
  });
});

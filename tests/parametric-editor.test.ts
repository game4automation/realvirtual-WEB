// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-650 Phase 4 — §9.5 (asset editor) and §9.6 (standstill guard).
 *
 *  - Setting values regenerates `_Generated` as ONE undo step; undo restores the
 *    old subtree and `Values`; redo brings the new one back.
 *  - The variant lands under the family node with the parts root's local
 *    transform, also for a nested, rotated and scaled family — never at the root.
 *  - A component on the family node survives regeneration, undo and redo (A8).
 *  - Draft replay: by cache hash (cache warm) and through the 'parametric' CAD
 *    provider (cache cleared) → the same tree; changed parts → visible miss.
 *  - Unchanged values → no op, no generator run; a cached variant → no generator run.
 *  - A hand-attached component under `_Generated` is refused (parametric-manual-attach).
 *  - A broken rule keeps the old variant and reports the error.
 *  - canRegenerate: running / paused-after-time / DES clock → false; detached,
 *    paused at 0, continuous without DES control → true; a deferred request
 *    runs once at the next standstill, never while running.
 *  - Instance field descriptors carry unit / min / max / step / enum.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { parametricGeneratedNodeId } from '../src/core/engine/rv-parametric-assembly';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { assetOpHeader } from '../src/core/editor/rv-asset-ops';
import { clearCadGlbCache, getCadGlb } from '../src/core/import/rv-cad-glb-cache';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { getGeneratorRunCount } from '../src/core/engine/rv-parametric-generator';
import { computeCodeHash } from '../src/core/engine/rv-parametric-hash';
import { getFieldDescriptor } from '../src/core/engine/rv-component-registry';
import { getCadProvider, hasCadProvider } from '../src/core/editor/rv-cad-provider';
import '../src/core/engine/rv-parametric-component';
import { canRegenerate } from '../src/core/engine/rv-parametric-family';
import {
  PARAMETRIC_CACHE_QUALITY,
  clearDeferredRegenerations,
  flushDeferredRegenerations,
  getDeferredFamilies,
  regenerateParametric,
} from '../src/core/editor/rv-parametric-regenerate';
import { getProblems } from '../src/core/hmi/problems-store';

const RULES = `
function generate(v, parts) {
  var inst = [{ part: 'Profile', name: 'Profile', positionMm: [0, 0, 0],
    stretch: [{ axis: 'x', atMm: 50, byMm: v.L - 100 }] }];
  for (var k = 0; k < v.N; k++) inst.push({ part: 'Roll', name: 'Roll_' + k, positionMm: [k * 20, 0, 10] });
  return {
    instances: inst,
    nodes: [{ name: 'Snap-X-0', positionMm: [v.L, 0, 0] }],
    messages: [],
  };
}`;

const PARAMS = [
  { Name: 'L', Label: 'Length', Type: 'number', Unit: 'mm', Min: 60, Max: 1000, Step: 10, Default: 100 },
  { Name: 'N', Type: 'int', Min: 0, Max: 20, Default: 2 },
  { Name: 'Side', Type: 'enum', Enum: ['L', 'R'], Default: 'L' },
];

function makeViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  const state = { runtime: null as null | { state: string; desControl: { renderClock?: number } | null }, simTime: 0 };
  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    get runtime() { return state.runtime; },
    get simTime() { return state.simTime; },
    drives: [],
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
    rebuildIKPaths() {},
    getPlugin: () => undefined,
    buildMeshBvhsAsync() {},
    selectionManager: { select() {} },
  } as unknown as RVViewer;
  return { viewer, model, registry, state };
}

/** A family (optionally nested / rotated / scaled) with two base parts. */
async function buildFamily(f: ReturnType<typeof makeViewer>, opts: { nested?: boolean; code?: string } = {}) {
  let parent: Object3D = f.model;
  if (opts.nested) {
    const holder = new Group();
    holder.name = 'Holder';
    holder.rotation.set(0.3, 0.7, 0);
    holder.scale.set(2, 2, 2);
    f.model.add(holder);
    parent = holder;
  }
  const fam = new Group();
  fam.name = 'Fam';
  if (opts.nested) { fam.position.set(1, 2, 3); fam.rotation.set(0, 0, 0.5); }
  const parts = new Group();
  parts.name = '_Parts';
  parts.rotation.set(-Math.PI / 2, 0, 0);
  parts.scale.set(0.001, 0.001, 0.001);
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
  fam.add(parts);
  const code = opts.code ?? RULES;
  fam.userData.realvirtual = {
    ParametricComponent: {
      ApiVersion: 1, Params: PARAMS, Values: { L: 100, N: 2, Side: 'L' }, Code: code, CodeHash: await computeCodeHash(code),
    },
    Sensor: { Mode: 'Raycast' },
  };
  setNodeId(fam, 'fam-editor'); // plan-2216: generated nodes are stamped from the family identity
  parent.add(fam);
  f.model.traverse((n) => f.registry.registerNode(NodeRegistry.computeNodePath(n), n));
  f.model.updateMatrixWorld(true);
  return { fam, parts, path: NodeRegistry.computeNodePath(fam) };
}

const gen = (fam: Object3D) => fam.children.find((c) => c.name === '_Generated');
const rollCount = (fam: Object3D) => gen(fam)?.children.filter((c) => c.name.startsWith('Roll_')).length ?? -1;
const values = (fam: Object3D) => (fam.userData.realvirtual.ParametricComponent as { Values: Record<string, unknown> }).Values;
const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
const freshDoc = (viewer: RVViewer, id: string) => new AssetDocument(viewer, {
  id, name: id, base: { kind: 'document', documentId: `doc_${id}`, path: `${id}.glb`, name: id },
});

beforeEach(async () => {
  await __clearDraftStoresForTests();
  await clearCadGlbCache();
  clearDeferredRegenerations();
});
afterEach(() => clearDeferredRegenerations());

describe('regenerateParametric — one undo step (§9.5)', () => {
  it('regenerates, undoes and redoes as ONE entry; the family component survives (A8)', async () => {
    const f = makeViewer();
    const { fam, path } = await buildFamily(f);
    const doc = scratchAssetDocument(f.viewer);

    const first = await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 3 });
    expect(first.status).toBe('applied');
    await doc.whenIdle();
    expect(rollCount(fam)).toBe(3);
    const opsAfterFirst = doc.toDraft().ops.length;

    const second = await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 5, L: 404 });
    expect(second.status).toBe('applied');
    await doc.whenIdle();
    expect(rollCount(fam)).toBe(5);
    expect(values(fam)).toEqual({ L: 400, N: 5, Side: 'L' }); // snapped to the Step grid
    expect(doc.toDraft().ops.length).toBe(opsAfterFirst + 1); // one composite

    await doc.undo();
    await doc.whenIdle();
    expect(rollCount(fam)).toBe(3);
    expect(values(fam)).toEqual({ L: 100, N: 3, Side: 'L' });
    expect(fam.userData.realvirtual.Sensor).toEqual({ Mode: 'Raycast' });

    await doc.redo();
    await doc.whenIdle();
    expect(rollCount(fam)).toBe(5);
    expect(fam.userData.realvirtual.Sensor).toEqual({ Mode: 'Raycast' });
    // exactly one generated root
    expect(fam.children.filter((c) => c.name.startsWith('_Generated')).length).toBe(1);
    doc.dispose();
  });

  it('nested, rotated and scaled family: the variant hangs under the family with the parts frame', async () => {
    const f = makeViewer();
    const { fam, parts, path } = await buildFamily(f, { nested: true });
    const doc = scratchAssetDocument(f.viewer);
    expect((await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 1 })).status).toBe('applied');
    await doc.whenIdle();
    const g = gen(fam)!;
    expect(g).toBeDefined();
    expect(g.parent).toBe(fam);
    expect(close(g.position.toArray(), parts.position.toArray())).toBe(true);
    expect(close(g.quaternion.toArray(), parts.quaternion.toArray())).toBe(true);
    expect(close(g.scale.toArray(), parts.scale.toArray())).toBe(true);
    expect(f.model.children.some((c) => c.name.startsWith('_Generated'))).toBe(false);

    await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 4 });
    await doc.whenIdle();
    await doc.undo();
    await doc.whenIdle();
    expect(gen(fam)?.parent).toBe(fam);
    expect(close(gen(fam)!.scale.toArray(), parts.scale.toArray())).toBe(true);
    doc.dispose();
  });

  it('unchanged values do nothing; a cached variant needs no generator run', async () => {
    const f = makeViewer();
    const { path } = await buildFamily(f);
    const doc = scratchAssetDocument(f.viewer);
    await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 3 });
    await doc.whenIdle();
    const ops = doc.toDraft().ops.length;
    const runs = getGeneratorRunCount();
    const same = await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 3 });
    expect(same.status).toBe('unchanged');
    expect(doc.toDraft().ops.length).toBe(ops);
    expect(getGeneratorRunCount()).toBe(runs);

    // N=3 → N=4 → back to N=3: the N=3 variant is in the cache
    await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 4 });
    const back = await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 3 });
    expect(back.status).toBe('applied');
    expect(back.status === 'applied' && back.cacheHit).toBe(true);
    expect(getGeneratorRunCount()).toBe(runs + 1);
    doc.dispose();
  });

  it('a broken rule keeps the old variant and reports the failure', async () => {
    const f = makeViewer();
    const { fam, path } = await buildFamily(f);
    const doc = scratchAssetDocument(f.viewer);
    await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 2 });
    await doc.whenIdle();
    const before = gen(fam);
    // the rule references an unknown part when N is 7
    (fam.userData.realvirtual.ParametricComponent as { Code: string }).Code =
      'function generate(v){ return { instances: [{ part: v.N === 7 ? "Nope" : "Roll", positionMm: [0,0,0] }] }; }';
    const out = await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 7 });
    expect(out.status).toBe('failed');
    expect(out.status === 'failed' && out.error.code).toMatch(/invalid-plan|unknown-part/);
    expect(gen(fam)).toBe(before);
    expect(values(fam).N).toBe(2);
    expect(getProblems().some((p) => p.code === 'parametric-regenerate-failed' && p.nodePath === path)).toBe(true);
    doc.dispose();
  });
});

describe('draft replay (§9.5)', () => {
  it('replays by cache hash and, after a cache wipe, through the parametric provider', async () => {
    const f = makeViewer();
    const { fam, path } = await buildFamily(f);
    const doc = scratchAssetDocument(f.viewer);
    const out = await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 4, L: 300 });
    await doc.whenIdle();
    expect(out.status).toBe('applied');
    const hash = out.status === 'applied' ? out.inputHash : '';
    expect(await getCadGlb(hash, PARAMETRIC_CACHE_QUALITY, 'parametric')).not.toBeNull();
    const names: string[] = [];
    gen(fam)!.traverse((n) => names.push(n.name));
    const ops = doc.toDraft().ops;
    doc.dispose();

    for (const wipe of [false, true]) {
      if (wipe) await clearCadGlbCache();
      const g = makeViewer();
      const { fam: fam2 } = await buildFamily(g);
      const restored = freshDoc(g.viewer, wipe ? 'wiped' : 'warm');
      const runs = getGeneratorRunCount();
      await restored.replayOps(ops);
      await restored.whenIdle();
      expect(restored.executor.takeMissingCadGeometry()).toEqual([]);
      const replayed: string[] = [];
      gen(fam2)!.traverse((n) => replayed.push(n.name));
      expect(replayed).toEqual(names);
      expect(gen(fam2)!.parent).toBe(fam2);
      expect(getGeneratorRunCount() - runs).toBe(wipe ? 1 : 0);
      restored.dispose();
    }
  });

  it('a changed base part replays with the current parts instead of breaking the draft', async () => {
    const f = makeViewer();
    const { path } = await buildFamily(f);
    const doc = scratchAssetDocument(f.viewer);
    await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 4 });
    await doc.whenIdle();
    const ops = doc.toDraft().ops;
    doc.dispose();
    await clearCadGlbCache();

    const g = makeViewer();
    const { parts } = await buildFamily(g);
    parts.children[1].position.x += 1; // the Roll part moved → other PartsHash
    const restored = freshDoc(g.viewer, 'changed');
    await restored.replayOps(ops);
    await restored.whenIdle();
    expect(restored.executor.takeMissingCadGeometry()).toEqual([]);
    const fam2 = parts.parent!;
    expect(rollCount(fam2)).toBe(4);
    // the stored hash names the recorded variant, the parts say otherwise → not up to date
    const { resolveFamilyInputs } = await import('../src/core/engine/rv-parametric-family');
    const inputs = await resolveFamilyInputs(fam2);
    expect((fam2.userData.realvirtual.ParametricComponent as { BakedInputHash: string }).BakedInputHash)
      .not.toBe(inputs.inputHash);
    restored.dispose();
  });

  it('the parametric provider is derived: it never counts as CAD import', () => {
    expect(getCadProvider('parametric')?.derived).toBe(true);
    expect(hasCadProvider()).toBe(false);
    expect(getCadProvider()).toBeNull();
  });
});

describe('manual attach under _Generated (F10)', () => {
  it('refuses addComponent below the generated root, allows it on the family node', async () => {
    const f = makeViewer();
    const { fam, path } = await buildFamily(f);
    const doc = scratchAssetDocument(f.viewer);
    await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 1 });
    await doc.whenIdle();
    const rollPath = NodeRegistry.computeNodePath(gen(fam)!.children.find((c) => c.name === 'Roll_0')!);
    await expect(doc.applyOp({
      ...assetOpHeader(), kind: 'addComponent', nodePath: rollPath, componentType: 'Sensor', fields: {},
    })).rejects.toThrow(/cannot be attached by hand/);
    expect(getProblems().some((p) => p.code === 'parametric-manual-attach' && p.nodePath === rollPath)).toBe(true);
    await doc.applyOp({ ...assetOpHeader(), kind: 'addComponent', nodePath: path, componentType: 'Group', fields: {} });
    await doc.whenIdle();
    expect(fam.userData.realvirtual.Group).toBeDefined();
    doc.dispose();
  });
});

describe('standstill guard (§9.6)', () => {
  it('canRegenerate follows plan-453', () => {
    const v = (state: string | null, simTime = 0, des?: number | null) => ({
      runtime: state === null ? null : { state, desControl: des === null || des === undefined ? null : { renderClock: des } },
      simTime,
    });
    expect(canRegenerate(null)).toBe(false);
    expect(canRegenerate(v(null))).toBe(true);
    expect(canRegenerate(v('detached', 5))).toBe(true);
    expect(canRegenerate(v('running'))).toBe(false);
    expect(canRegenerate(v('paused', 0.5))).toBe(false);
    expect(canRegenerate(v('paused', 0, 0))).toBe(true);
    expect(canRegenerate(v('paused', 0))).toBe(true); // continuous: no DES clock
    expect(canRegenerate(v('paused', 0, 2))).toBe(false);
  });

  it('defers while running and applies once at the next standstill', async () => {
    const f = makeViewer();
    const { fam, path } = await buildFamily(f);
    const doc = scratchAssetDocument(f.viewer);
    f.state.runtime = { state: 'running', desControl: null };
    const runs = getGeneratorRunCount();
    const out = await regenerateParametric({ viewer: f.viewer, doc }, path, { N: 6 });
    expect(out.status).toBe('deferred');
    expect(getDeferredFamilies()).toEqual([path]);
    expect(await flushDeferredRegenerations()).toEqual([]);
    expect(getGeneratorRunCount()).toBe(runs);
    expect(gen(fam)).toBeUndefined();

    f.state.runtime = { state: 'detached', desControl: null };
    const flushed = await flushDeferredRegenerations();
    expect(flushed.map((o) => o.status)).toEqual(['applied']);
    await doc.whenIdle();
    expect(getGeneratorRunCount()).toBe(runs + 1);
    expect(rollCount(fam)).toBe(6);
    expect(getDeferredFamilies()).toEqual([]);
    doc.dispose();
  });
});

describe('instance field descriptors (§2.7)', () => {
  it('describes Values.<Name> from Params', async () => {
    const f = makeViewer();
    const { fam } = await buildFamily(f);
    const data = fam.userData.realvirtual.ParametricComponent as Record<string, unknown>;
    const l = getFieldDescriptor('ParametricComponent', 'Values.L', data);
    expect(l).toMatchObject({ type: 'number', unit: 'mm', min: 60, max: 1000, step: 10, default: 100, label: 'Length' });
    expect(getFieldDescriptor('ParametricComponent', 'Values.N', data)).toMatchObject({ type: 'number', step: 1 });
    expect(getFieldDescriptor('ParametricComponent', 'Values.Side', data)).toMatchObject({ type: 'enum', enumMap: { L: 'L', R: 'R' } });
    expect(getFieldDescriptor('ParametricComponent', 'Values.Nope', data)).toBeUndefined();
  });
});

describe('editor regeneration keeps the generated identities (plan-2216)', () => {
  const GRIP_RULES = `
function generate(v, parts) {
  return {
    instances: [{ part: 'Roll', name: 'Gripper', positionMm: [v.L, 0, 0] }],
    nodes: [{ name: 'GripSensor', positionMm: [v.L, 0, -20] }, { name: 'AxisX', positionMm: [0, 0, 0] }],
    components: [
      { node: 'GripSensor', type: 'Sensor', fields: { UseRaycast: true, AutoRay: false, RayCastLength: 30 } },
      { node: 'Gripper', type: 'Grip', fields: { PlaceMode: 'Auto', OneBitControl: true, GripRange: 50, PartToGrip: 'GripSensor' } },
    ],
  };
}`;
  const idOf = (fam: Object3D, name: string) => identityIdOf(gen(fam)!.getObjectByName(name)!);
  const gripRef = (fam: Object3D) => (gen(fam)!.getObjectByName('Gripper')!.userData.realvirtual.Grip as { PartToGrip: { address: string } }).PartToGrip;

  it('Grip resolves to its Sensor after regeneration; ids are the same after a second regeneration and a replay', async () => {
    const f = makeViewer();
    const { fam, path } = await buildFamily(f, { code: GRIP_RULES });
    const doc = scratchAssetDocument(f.viewer);
    const want = (n: string) => parametricGeneratedNodeId('fam-editor', n);

    expect((await regenerateParametric({ viewer: f.viewer, doc }, path, { L: 200 })).status).toBe('applied');
    await doc.whenIdle();
    for (const n of ['Gripper', 'GripSensor', 'AxisX']) expect(idOf(fam, n)).toBe(want(n));
    expect(gripRef(fam).address).toBe('#' + idOf(fam, 'GripSensor'));

    expect((await regenerateParametric({ viewer: f.viewer, doc }, path, { L: 400 })).status).toBe('applied');
    await doc.whenIdle();
    for (const n of ['Gripper', 'GripSensor', 'AxisX']) expect(idOf(fam, n)).toBe(want(n));
    expect(gripRef(fam).address).toBe('#' + idOf(fam, 'GripSensor'));

    const ops = doc.toDraft().ops;
    doc.dispose();
    const g = makeViewer();
    const { fam: fam2 } = await buildFamily(g, { code: GRIP_RULES });
    const restored = freshDoc(g.viewer, 'ids-replay');
    await restored.replayOps(ops);
    await restored.whenIdle();
    for (const n of ['Gripper', 'GripSensor', 'AxisX']) expect(idOf(fam2, n)).toBe(want(n));
    expect(gripRef(fam2).address).toBe('#' + idOf(fam2, 'GripSensor'));
    restored.dispose();
  });
});

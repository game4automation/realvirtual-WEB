// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * spike-576-source-coverage.test.ts — plan-576 Phase 1, FRAGE A.
 *
 * Erkenntnis, kein Feature. Plan 2.6 asserts that the three byte producers
 * (`SceneStore._bakeCurrent`, `exportAssetGlb`, `SceneStore._bakeAuthoredTree`)
 * cover DIFFERENT op sets, and plan 6 asks the one question that decides the
 * shape of Phase 2: can a source's coverage be ONE NUMBER (a prefix length), or
 * must it be differentiated by op kind? This file answers that by measuring,
 * per op kind, what actually reaches the bytes.
 *
 * **Every test here passes.** Nothing is stubbed away: the measurements drive
 * the real `materialise()` / `editsBeyondAuthoredTree()` (the sole op-derived
 * input `_bakeCurrent` and `_bakeAuthoredTree` hand to `bakeIntoGlb`) and a real
 * `exportAssetGlb()` GLB round trip. Where the measured answer contradicts the
 * plan, the test pins the contradiction.
 *
 * -- PRAEZISIERT 2026-10-09 (SOL R2-2 / R2-4) -------------------------------
 *
 * **"covered" in this file means KIND-LEVEL: the op kind leaves a trace in the
 * fold.** That is weaker than the binary contract plan 2.5 now rests on
 * ("carried COMPLETELY"), and for three variants it is too weak:
 * `transformNode` with a scale, `unsetField` against a field already in the
 * base bytes, and a `composite` with one uncarried child all leave a trace here
 * and are still not carried completely. `coveredKinds()` below also excludes
 * `composite` by construction. Those cases are measured in
 * `spike-576-partial-coverage.test.ts` (MESSUNG C1-C10); nothing asserted here
 * is wrong, but no assertion here may be read as "this op is contained".
 *
 * -- Measured answer to Frage A ---------------------------------------------
 *
 * **A number does NOT suffice. Coverage must be differentiated by op kind.**
 *
 * | Producer | op-derived input | covered kinds (of 25) |
 * |---|---|---|
 * | `_bakeCurrent` (scene-store.ts:2885) | `materialise(this._ops)` | **14** -- the 11 scene-lineage kinds plus `setField` / `unsetField` / `transformNode`. All 11 asset-lineage kinds hit `applyForwardPure`'s `default` (rv-scene-edits.ts:483) and vanish without a word. |
 * | `exportAssetGlb` (rv-asset-glb-export.ts:479) | the live authored tree | the kinds whose effect IS in the tree -- the 11 asset-lineage kinds plus the 3 shared ones; the 11 scene-lineage kinds are not in a tree (camera / connections / code are file-level). |
 * | `_bakeAuthoredTree` (scene-store.ts:2934) | authored export + `editsBeyondAuthoredTree(materialise(ops))` | the `exportAssetGlb` set PLUS exactly 5 file-level scene kinds (`setCamera`, `addConnection`, `removeConnection`, `setConnectionType`, `removeConnectionType`). |
 *
 * The two sets are **complementary, not nested**: `_bakeCurrent` covers the
 * scene lineage and drops the asset lineage; the authored export does the
 * opposite. So "prefix = N" is not merely imprecise -- for a MIXED log it is
 * wrong in both directions at once (A2/A8), and no single number can be both
 * right about op i and right about op i+1 when their lineages differ.
 */

import { describe, it, expect } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetExecutorContext } from '../src/core/editor/rv-asset-executors';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { materialise, editsBeyondAuthoredTree } from '../src/core/hmi/scene/rv-scene-edits';
import { RV_OP_KINDS, RV_OP_ORIGIN } from '../src/core/ops/rv-unified-ops';
import type { RvOpKind, RvPrimitiveOp } from '../src/core/ops/rv-unified-ops';
import type { RVViewer } from '../src/core/rv-viewer';

// --- Fixtures ----------------------------------------------------------

let opSeq = 0;
const head = () => ({ id: `op_576_${++opSeq}`, ts: 10_000, schemaV: 1 as const });

const IDENTITY = {
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

const PLACEMENT = {
  id: 'plc_1',
  catalogId: 'lib/belt',
  glbUrl: 'library/belt.glb',
  label: 'Belt',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

/**
 * One representative op per kind in the union -- the input side of the
 * measurement.
 *
 * Payloads are minimal but REAL for every kind `applyForwardPure` handles (a
 * truncated payload there would measure the fixture, not the code). For the
 * kinds that reach the `default` branch the payload is irrelevant by
 * construction, which is itself part of the finding.
 */
function opOfKind(kind: RvOpKind): RvPrimitiveOp {
  const base = head();
  const make = (rest: Record<string, unknown>) =>
    ({ ...base, kind, ...rest } as unknown as RvPrimitiveOp);
  switch (kind) {
    // -- handled by applyForwardPure --------------------------------
    case 'setField':
      return make({ nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed', value: 400, prev: 50 });
    case 'unsetField':
      return make({ nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed', prev: 50 });
    case 'transformNode':
      // Scene lineage = `scale === undefined` (rv-unified-ops.ts:249); the fold
      // reads `position`/`quaternion` as arrays (rv-scene-edits.ts:433).
      return make({
        nodePath: 'Asset/Box',
        transform: { position: [1, 0, 0], quaternion: [0, 0, 0, 1] },
        prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      });
    case 'addPlacement':
      // `PlacedComponent` (rv-layout-store.ts:123) -- tuples, not {x,y,z}.
      return make({ placement: PLACEMENT });
    case 'removePlacement':
      return make({ placementId: PLACEMENT.id, placement: PLACEMENT });
    case 'transformPlacement':
      return make({
        placementId: PLACEMENT.id,
        position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        prev: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      });
    case 'setCamera':
      return make({ preset: { position: [1, 2, 3], target: [0, 0, 0] }, prev: null });
    case 'setCode':
      return make({ nodePath: 'Asset/Box', code: 'return 1;', prev: null });
    case 'addNode':
      return make({ nodePath: 'Asset/Lamp', spec: { name: 'Lamp', components: { WebLamp: { Colour: 'red' } } } });
    case 'removeNode':
      return make({ nodePath: 'Asset/Lamp', spec: { name: 'Lamp', components: {} } });
    case 'addConnection':
      return make({ connection: { id: 'cx_1', type: 'signal', from: 'Asset/Box', to: 'Asset/Frame' } });
    case 'removeConnection':
      return make({ connectionId: 'cx_1', connection: { id: 'cx_1', type: 'signal', from: 'Asset/Box', to: 'Asset/Frame' } });
    case 'setConnectionType':
      return make({ connectionType: { type: 'signal', colour: '#4fc3f7' } });
    case 'removeConnectionType':
      return make({ connectionType: { type: 'signal', colour: '#4fc3f7' } });
    // -- asset lineage: all of these reach the `default` branch ------
    case 'createNode':
      return make({ nodePath: 'Asset/Empty', transform: IDENTITY });
    case 'deleteNode':
      return make({ nodePath: 'Asset/Frame' });
    case 'renameNode':
      return make({ nodePath: 'Asset/Box', name: 'Renamed', prevName: 'Box' });
    case 'reparentNode':
      return make({ nodePath: 'Asset/Box', newParentPath: 'Asset/Frame', transform: IDENTITY, prev: { parentPath: 'Asset', transform: IDENTITY } });
    case 'importCad':
      return make({ rootPath: 'Asset/Imported', cadlink: { CADFileName: 'x.stp' }, transform: IDENTITY });
    case 'addComponent':
      return make({ nodePath: 'Asset/Box', componentType: 'Sensor', fields: {} });
    case 'removeComponent':
      return make({ nodePath: 'Asset/Box', componentType: 'Drive', prev: { TargetSpeed: 50 } });
    case 'setMaterial':
      return make({ nodePaths: ['Asset/Box'], material: { colour: '#ff0000' }, prev: [] });
    case 'separateMesh':
      return make({ nodePath: 'Asset/Box', parts: [] });
    case 'mergeMesh':
      return make({ nodePath: 'Asset/Box', sourcePaths: ['Asset/Frame'] });
    case 'setNodeVisible':
      return make({ nodePath: 'Asset/Box', visible: false, prev: true });
    case 'composite':
      return make({ label: 'c', ops: [] });
  }
}

/**
 * The ops a kind needs in front of it to be able to do anything.
 *
 * Without this the probe would conflate "the fold does not carry this kind"
 * with "a removal of something that was never added is a no-op" -- and would
 * report `removePlacement`, `removeNode`, `removeConnection`,
 * `removeConnectionType`, `transformPlacement` and `unsetField` as uncovered
 * for the wrong reason.
 */
function setupFor(kind: RvOpKind): RvPrimitiveOp[] {
  switch (kind) {
    case 'removePlacement':
    case 'transformPlacement':
      return [opOfKind('addPlacement')];
    case 'removeNode':
      return [opOfKind('addNode')];
    case 'removeConnection':
      return [opOfKind('addConnection')];
    case 'removeConnectionType':
      return [opOfKind('setConnectionType')];
    case 'unsetField':
      return [opOfKind('setField')];
    default:
      return [];
  }
}

/** Does this op leave ANY trace in the given fold, given its precondition? */
function leavesTrace(fold: (ops: RvPrimitiveOp[]) => unknown, kind: RvOpKind): boolean {
  const setup = setupFor(kind);
  const without = JSON.stringify(fold(setup));
  const withOp = JSON.stringify(fold([...setup, opOfKind(kind)]));
  return withOp !== without;
}

const bakeCurrentFold = (ops: RvPrimitiveOp[]) => materialise(ops);
const authoredResidueFold = (ops: RvPrimitiveOp[]) => editsBeyondAuthoredTree(materialise(ops));

/** The kinds a fold actually carries, measured rather than read. */
function coveredKinds(fold: (ops: RvPrimitiveOp[]) => unknown): RvOpKind[] {
  return RV_OP_KINDS.filter((k) => k !== 'composite' && leavesTrace(fold, k)).slice().sort();
}

// ======================================================================
// A1-A3 -- _bakeCurrent: what `materialise(this._ops)` carries.
// ======================================================================

describe('A -- _bakeCurrent (scene-store.ts:2885)', () => {
  it('MESSUNG A1: materialise() carries 14 of 25 kinds -- the whole asset lineage is dropped', () => {
    const covered = coveredKinds(bakeCurrentFold);
    expect(covered).toEqual([
      'addConnection', 'addNode', 'addPlacement', 'removeConnection',
      'removeConnectionType', 'removeNode', 'removePlacement', 'setCamera',
      'setCode', 'setConnectionType', 'setField', 'transformNode',
      'transformPlacement', 'unsetField',
    ]);
    expect(covered).toHaveLength(14);

    // The uncovered rest is EXACTLY the asset lineage -- nothing scene-side is
    // missing, and nothing asset-side gets through.
    const uncovered = RV_OP_KINDS.filter((k) => k !== 'composite' && !covered.includes(k));
    expect(uncovered.every((k) => RV_OP_ORIGIN[k] === 'asset')).toBe(true);
    expect(uncovered).toHaveLength(11);
  });

  it('MESSUNG A2: a prefix NUMBER lies about a mixed log -- createNode is claimed as contained', () => {
    // The log the Festo repro produces: the editor creates a node, then edits a
    // field. `doc.opCount` is 2, so `prefix = 2` would declare both contained
    // in the bytes `_bakeCurrent` writes.
    const createNode = opOfKind('createNode');
    const field = opOfKind('setField');

    const mixed = JSON.stringify(materialise([createNode, field]));
    const sceneHalfOnly = JSON.stringify(materialise([field]));

    // Byte-identical: op 0 contributed NOTHING. A coverage of 2 is a lie about
    // op 0 and the truth about op 1 -- the same number cannot be both.
    expect(mixed).toBe(sceneHalfOnly);
  });

  it('MESSUNG A3: the drop is order-independent -- no prefix position is safe', () => {
    // Not an "oldest ops are fine, newest are not" boundary: the asset op
    // disappears wherever it stands, so there is no cut-off index at which a
    // number becomes honest.
    const a = opOfKind('setField');
    const b = opOfKind('createNode');
    const c = opOfKind('addPlacement');
    const reference = JSON.stringify(materialise([a, c]));
    expect(JSON.stringify(materialise([b, a, c]))).toBe(reference);
    expect(JSON.stringify(materialise([a, b, c]))).toBe(reference);
    expect(JSON.stringify(materialise([a, c, b]))).toBe(reference);
  });
});

// ======================================================================
// A4/A5 -- exportAssetGlb: the authored tree, measured through real bytes.
// ======================================================================

function buildTree(): { scene: Scene; root: Group; registry: NodeRegistry } {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  for (const name of ['Box', 'Frame']) {
    const node = new Object3D();
    node.name = name;
    node.userData.realvirtual = { Drive: { TargetSpeed: 50 } };
    root.add(node);
  }
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  return { scene, root, registry };
}

function makeAssetViewer() {
  const tree = buildTree();
  const viewer = {
    get scene() { return tree.scene; },
    get registry() { return tree.registry; },
    get currentModelRoot() { return tree.root; },
    currentModelUrl: 'spike576://asset.glb',
    signalStore: null,
    transportManager: null,
    instancePickIndex: undefined,
    groups: undefined,
    getPlugin: () => undefined,
    markRenderDirty() {},
    markShadowsDirty() {},
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
    rebuildIKPaths() {},
    emit() {},
    on() { return () => {}; },
  };
  return { viewer: viewer as unknown as RVViewer, tree };
}

async function reloadGlb(bytes: ArrayBuffer): Promise<Object3D> {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(bytes, '');
  return gltf.scene;
}

function namesIn(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => { if (n.name) out.push(n.name); });
  return out.sort();
}

describe('A -- exportAssetGlb (rv-asset-glb-export.ts:479)', () => {
  it('MESSUNG A4: an asset op IS in the exported bytes -- the half _bakeCurrent drops', async () => {
    const { viewer, tree } = makeAssetViewer();
    const ctx = new AssetExecutorContext(viewer);

    // The two ops `_bakeCurrent` disagrees about: a structural asset op and a
    // shared one.
    await ctx.applyForward(opOfKind('createNode') as never);
    await ctx.applyForward(opOfKind('setField') as never);
    expect(tree.root.children.some((c) => c.name === 'Empty')).toBe(true);

    const bytes = await exportAssetGlb(tree.root, 'Asset');
    const reloaded = await reloadGlb(bytes);

    // Both survived into real bytes, so the authored export's coverage includes
    // the asset lineage that `materialise` silently discards (A1).
    expect(namesIn(reloaded)).toContain('Empty');
    const box = reloaded.getObjectByName('Box')!;
    expect((box.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed)
      .toBe(400);
  });

  it('MESSUNG A5: a scene-lineage op cannot reach the tree -- the complementary gap', async () => {
    const { viewer, tree } = makeAssetViewer();
    const before = await reloadGlb(await exportAssetGlb(tree.root, 'Asset'));

    // `setCamera` and `addConnection` are file-level: the asset executor has no
    // branch for them at all, so no tree export can carry them and
    // `editsBeyondAuthoredTree` is the only route (A6).
    expect(RV_OP_ORIGIN['setCamera']).toBe('scene');
    expect(RV_OP_ORIGIN['addConnection']).toBe('scene');
    const ctx = new AssetExecutorContext(viewer);
    await expect(ctx.applyForward(opOfKind('setCamera') as never)).resolves.toBeUndefined();

    const after = await reloadGlb(await exportAssetGlb(tree.root, 'Asset'));
    expect(namesIn(after)).toEqual(namesIn(before));
  });
});

// ======================================================================
// A6-A8 -- _bakeAuthoredTree: export + residue, and what falls between.
// ======================================================================

describe('A -- _bakeAuthoredTree (scene-store.ts:2934)', () => {
  it('MESSUNG A6: the residue carries only 5 file-level scene kinds', () => {
    const covered = coveredKinds(authoredResidueFold);
    expect(covered).toEqual([
      'addConnection', 'removeConnection', 'removeConnectionType',
      'setCamera', 'setConnectionType',
    ]);
  });

  it('MESSUNG A7: 6 scene kinds are covered by NEITHER half of the authored bake', () => {
    // The authored export covers the tree (A4/A5), the residue covers 5 kinds
    // (A6). What `_bakeCurrent` would have covered and this path does not:
    const bakeCurrent = coveredKinds(bakeCurrentFold);
    const residue = coveredKinds(authoredResidueFold);
    const shared: RvOpKind[] = ['setField', 'unsetField', 'transformNode'];
    const inTheTree = (k: RvOpKind) => RV_OP_ORIGIN[k] === 'asset' || shared.includes(k);

    const neither = bakeCurrent
      .filter((k) => !residue.includes(k) && !inTheTree(k))
      .sort();
    expect(neither).toEqual([
      'addNode', 'addPlacement', 'removeNode', 'removePlacement', 'setCode',
      'transformPlacement',
    ]);
    // `addNode`/`removeNode` and the placements are node-level BY DESIGN
    // (`editsBeyondAuthoredTree`: "a placement IS its reference node"), so for
    // those the tree is meant to be the carrier. `setCode` is the one that is
    // neither node-level in a tree nor in the residue -- a coverage claim over
    // a `setCode` op on this path would be wrong in the DANGEROUS direction
    // (op declared contained, nothing wrote it).
    expect(neither).toContain('setCode');
  });

  it('MESSUNG A8: the two producers cover COMPLEMENTARY sets, not nested ones', () => {
    const bakeCurrent = new Set(coveredKinds(bakeCurrentFold));
    const assetLineage = RV_OP_KINDS.filter((k) => RV_OP_ORIGIN[k] === 'asset');
    // Neither is a subset of the other: `_bakeCurrent` has 11 scene kinds the
    // authored tree has no business carrying, the authored tree has 11 asset
    // kinds `_bakeCurrent` drops. A single comparable scalar ACROSS the two
    // producers is therefore not just imprecise -- it is undefined.
    expect(assetLineage.some((k) => bakeCurrent.has(k))).toBe(false);
    expect([...bakeCurrent].some((k) => RV_OP_ORIGIN[k] === 'scene')).toBe(true);
  });
});

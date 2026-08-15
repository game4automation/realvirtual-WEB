// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * spike-projection-recompose.test.ts — plan-711 Phase 1, the SPIKE.
 *
 * Erkenntnis, kein Feature. The plan makes ONE capability promise it cannot
 * keep on paper — "a mixed op log can be projected into either view, and the
 * bake of that log loses nothing" — and §2.3 says explicitly that the code, not
 * the text, decides how. This file is that decision, executed, in the shape
 * plan-703 Phase 4 used for the same job (`rv-document-stack-recompose.test.ts`
 * — measurement first, verdict in the header, plan section afterwards).
 *
 * **Every test here passes.** Nothing is skipped and nothing is stubbed: what
 * they pin is what today's production modules DO with a mixed log, including —
 * and especially — where that is not what the plan assumed. Five of the answers
 * are "not the way §2.3 sketched it, and here is why". The verdicts are written
 * up as `## Spike-Ergebnis 2026-08-12` in the plan; this file is the evidence
 * they rest on and stays as the regression net for Phase 2+3.
 *
 * ── The five questions, and the measured answers ────────────────────────────
 *
 * | | measured |
 * |---|---|
 * | **(a) Placements in the editor projection** | NO. `resolveOpTarget` routes by ORIGIN, not by mode, so `addPlacement` reaches the SCENE executor even in the asset projection; there it needs `LayoutPlannerPlugin`, which the editor does not register, and the scene executor's swallow turns the failure into a warning. The op replays "successfully" and materialises NOTHING. Reference nodes are made by the BAKE (`rv-scene-glb-bake`), never by `applyForward` — so §2.3's "Szenen-Ops materialisieren im Editor als das, was der Bake aus ihnen macht" is only reachable through bytes, not through replay. The 4 `'both'` kinds DO carry across, by mode, exactly as designed. |
 * | **(b) Bake rule for the mixed case** | "Projizierter Baum", and it is not a preference: `materialise()` folds the WHOLE primitive union through `applyForwardPure`, whose `default` branch drops all 11 asset-lineage kinds without a word (`rv-scene-edits.ts:353`). The scene bake therefore reads unchanged base bytes plus a scene-only overlay — the editor half is not "at risk", it is already gone before `bakeIntoGlb` is called. An "erweitertes Overlay" would mean teaching `MaterialisedEdits` eleven structural kinds it has no vocabulary for; exporting the live authored tree as the bake SOURCE reuses the exporter that already does it. |
 * | **(c) Undo of a foreign-projected op** | Correct only via recompose, and the failure is SILENT. Undo of `addPlacement` in the asset projection pops the log while the scene executor swallows the inverse — log and tree diverge with no error anywhere. Cost of the mini-recompose is one reload + N `applyForward`, i.e. the price of the switch itself, but it MUST be triggered by kind, not by failure: there is no failure to detect. |
 * | **(d) Executor state across the switch** | Does NOT survive, and it fails WORSE than "nothing happens". `AssetExecutorContext._trash` holds `{node, parent, childIndex}` of the OLD tree and `_trashGroup` hangs in the OLD scene, so undoing a `deleteNode` after a projection change re-attaches the node to a DETACHED parent — and `_restoreFromTrash` then runs `_registerSubtree` against the LIVE registry, so that path resolves to a GHOST which shadows the live node standing at exactly the same path. `_cadPayloads` is the opposite case — an op-id-keyed map of tree-INDEPENDENT parsed subtrees, which survives fine. So `adoptAssetContext` may not simply carry the old context over: the tree-bound state has to be dropped at the switch, and the ops that depend on it have to be re-projected. |
 * | **(e) Error-contract difference** | Smaller than the plan assumes, and asymmetric in the dangerous direction. The scene executor swallows EVERYTHING (documented). The asset executor rejects only where it cannot proceed at all — `importCad` without a root, `reparentNode` with a missing node — while `deleteNode`, `renameNode`, `setNodeVisible`, `setField` and friends silently `if (!node) return`. So "the asset side rejects, therefore the document declines to record" does not hold for foreign replay: the common asset kinds no-op exactly like the scene ones, and the document records an op that did nothing. |
 *
 * Renderer-free: hand-built `three` trees plus a `NodeRegistry`, the same double
 * `document-mode-switch.test.ts` drives an `AssetDocument` with.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RvDocument } from '../src/core/ops/rv-document';
import { RvUnifiedExecutor, resolveOpTarget } from '../src/core/ops/rv-unified-executors';
import { AssetExecutorContext } from '../src/core/editor/rv-asset-executors';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import { RV_OP_ORIGIN, RV_OP_KINDS } from '../src/core/ops/rv-unified-ops';
import type {
  RvOp,
  RvOpKind,
  RvPrimitiveOp,
} from '../src/core/ops/rv-unified-ops';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── Fixtures ───────────────────────────────────────────────────────────

let opSeq = 0;
const head = () => ({ id: `op_spike_${++opSeq}`, ts: 10_000, schemaV: 1 as const });

/**
 * The one tree both projections show, built twice.
 *
 * Built rather than loaded because the spike is about op ROUTING and executor
 * STATE, not about parsing: a GLB round trip would add seconds per case and
 * change no answer. The important property is that the two builds produce
 * DIFFERENT `Object3D`s at the same paths — which is exactly what a projection
 * change does (`viewer.loadModel` replaces the graph).
 */
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

/** Placements the fake planner accepted, so "did it materialise?" is answerable. */
interface FakePlanner {
  placed: string[];
  removed: string[];
  placeFromRecord(record: { id: string }): Promise<void>;
  removePlacementById(id: string): void;
  applyTransformById(): void;
}

function makePlanner(): FakePlanner {
  const planner: FakePlanner = {
    placed: [],
    removed: [],
    placeFromRecord: async (record) => { planner.placed.push(record.id); },
    removePlacementById: (id) => { planner.removed.push(id); },
    applyTransformById: () => {},
  };
  return planner;
}

/**
 * A viewer whose TREE can be swapped under it — the projection change, reduced
 * to the one thing it does to an executor.
 *
 * `plannerRegistered` is the second half of the change: the layout planner is a
 * scene-mode plugin and is simply not there while the editor is up, which is
 * what makes question (a) answerable at all.
 */
function makeProjectionViewer() {
  let tree = buildTree();
  let planner: FakePlanner | null = makePlanner();
  const emitted: string[] = [];

  const viewer = {
    get scene() { return tree.scene; },
    get registry() { return tree.registry; },
    get currentModelRoot() { return tree.root; },
    currentModelUrl: 'spike://asset.glb',
    signalStore: null,
    transportManager: null,
    instancePickIndex: undefined,
    groups: undefined,
    getPlugin: <T,>(id: string): T | undefined =>
      (id === 'layout-planner' ? (planner as unknown as T) ?? undefined : undefined),
    markRenderDirty() {},
    markShadowsDirty() {},
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
    rebuildIKPaths() {},
    emit(event: string) { emitted.push(event); },
    on() { return () => {}; },
  };

  return {
    viewer: viewer as unknown as RVViewer,
    emitted,
    get tree() { return tree; },
    get planner() { return planner; },
    /** What `AssetEditorPlugin._activate` does to the world, in two lines. */
    switchToEditorProjection() {
      tree = buildTree();
      planner = null;
    },
    /** …and the way back. */
    switchToSceneProjection() {
      tree = buildTree();
      planner = makePlanner();
    },
    nodeAt(path: string): Object3D | null { return tree.registry.getNode(path); },
  };
}

type Projection = ReturnType<typeof makeProjectionViewer>;

// ─── Ops ────────────────────────────────────────────────────────────────

const setField = (value: number, nodePath = 'Asset/Box'): RvPrimitiveOp => ({
  ...head(), kind: 'setField',
  nodePath, componentType: 'Drive', fieldName: 'TargetSpeed', value, prev: 50,
});

const addPlacement = (id: string): RvPrimitiveOp => ({
  ...head(), kind: 'addPlacement',
  placement: {
    id,
    assetId: 'lib/belt',
    name: 'Belt',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  },
} as unknown as RvPrimitiveOp);

const deleteNode = (nodePath = 'Asset/Frame'): RvPrimitiveOp => ({
  ...head(), kind: 'deleteNode', nodePath,
} as unknown as RvPrimitiveOp);

const renameNode = (nodePath = 'Asset/Box', name = 'Renamed'): RvPrimitiveOp => ({
  ...head(), kind: 'renameNode', nodePath, name, prevName: 'Box',
} as unknown as RvPrimitiveOp);

const importCad = (): RvPrimitiveOp => ({
  ...head(), kind: 'importCad',
  rootPath: 'Asset/Imported',
  cadlink: { CADFileName: 'x.stp' },
  transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
} as unknown as RvPrimitiveOp);

/** A document over one projection, in the mode that projection means. */
function makeDoc(projection: Projection, mode: 'scene' | 'asset'): {
  doc: RvDocument;
  executor: RvUnifiedExecutor;
} {
  const executor = new RvUnifiedExecutor(projection.viewer, mode);
  const doc = new RvDocument({ id: 'doc_spike', name: 'Spike', mode, executor });
  return { doc, executor };
}

/** The recompose pattern of `rv-document-recompose.ts`, in four lines. */
async function replayWithoutRecording(doc: RvDocument, ops: readonly RvOp[]): Promise<void> {
  await doc.runExclusive(async () => {
    for (const op of ops) {
      try {
        await doc.executor.applyForward(op);
      } catch (e) {
        console.warn('[spike] op did not replay:', e);
      }
    }
  });
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ═════════════════════════════════════════════════════════════════════════
// (a) Do scene ops — placements above all — materialise in the editor
//     projection when replayed with applyForward?
// ═════════════════════════════════════════════════════════════════════════

describe('(a) Szenen-Ops in der Editor-Projektion', () => {
  it('MESSUNG a1: resolveOpTarget routes by ORIGIN — the mode does not reach scene-only kinds', () => {
    // The routing table, read back as the plan needs it: only the 4 `'both'`
    // kinds follow the projection. Everything else is decided before the mode
    // is even consulted, in BOTH directions.
    const followsMode = RV_OP_KINDS.filter((kind: RvOpKind) => RV_OP_ORIGIN[kind] === 'both');
    expect(followsMode.sort()).toEqual(
      ['composite', 'setField', 'transformNode', 'unsetField'],
    );
    expect(resolveOpTarget(addPlacement('p1'), 'asset')).toBe('scene');
    expect(resolveOpTarget(addPlacement('p1'), 'scene')).toBe('scene');
    // …and symmetrically: an asset-lineage op in the SCENE projection is not
    // skipped either — it is aimed at whatever tree the viewer holds.
    expect(resolveOpTarget(deleteNode(), 'scene')).toBe('asset');
  });

  it('MESSUNG a2: addPlacement replays "successfully" into the editor projection and materialises NOTHING', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'scene');
    await doc.applyOp(addPlacement('plc_1'));
    expect(projection.planner!.placed, 'the scene projection places it').toEqual(['plc_1']);

    const history = doc.captureHistory();
    projection.switchToEditorProjection();
    const { doc: editorDoc } = makeDoc(projection, 'asset');

    // The recompose replay, verbatim.
    await replayWithoutRecording(editorDoc, history.ops);

    // The verdict. No planner ⇒ `addPlacementForward` throws ⇒ the SCENE
    // executor's try/catch swallows it into a console warning. The replay
    // reports success, the tree gained nothing, and no reference node exists
    // for the editor to author against.
    expect(projection.nodeAt('Asset/Belt')).toBeNull();
    expect(editorDoc.opCount, 'a replay records nothing, by construction').toBe(0);
    // Nothing rejected — which is precisely the problem: a caller cannot tell
    // this replay from one that worked.
    await expect(editorDoc.executor.applyForward(addPlacement('plc_2'))).resolves.toBeUndefined();
  });

  it('MESSUNG a3: the 4 "both" kinds DO cross — setField lands on the editor tree', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'scene');
    await doc.applyOp(setField(400));
    const boxBefore = projection.nodeAt('Asset/Box')!;
    expect((boxBefore.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed)
      .toBe(400);

    const history = doc.captureHistory();
    projection.switchToEditorProjection();
    const { doc: editorDoc } = makeDoc(projection, 'asset');
    await replayWithoutRecording(editorDoc, history.ops);

    const boxAfter = projection.nodeAt('Asset/Box')!;
    expect(boxAfter, 'a projection change is a NEW tree').not.toBe(boxBefore);
    expect((boxAfter.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed)
      .toBe(400);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// (b) The bake rule in the mixed case.
// ═════════════════════════════════════════════════════════════════════════

describe('(b) Bake-Regel im Misch-Fall', () => {
  it('MESSUNG b1: materialise() drops EVERY asset-lineage kind silently', () => {
    const sceneOps: RvPrimitiveOp[] = [setField(400), addPlacement('plc_1')];
    const assetOps: RvPrimitiveOp[] = [deleteNode(), renameNode(), importCad()];

    const sceneOnly = materialise(sceneOps);
    const mixed = materialise([...sceneOps, ...assetOps]);

    // Byte-identical: the asset half left no trace anywhere in the seven
    // categories a scene bake writes.
    expect(JSON.stringify(mixed)).toBe(JSON.stringify(sceneOnly));
    // And it did not complain — `applyForwardPure`'s `default` is the
    // documented tolerance branch (rv-scene-edits.ts:353).
    expect(mixed.placements).toHaveLength(1);
    expect(mixed.overlay.nodes['Asset/Box']?.Drive?.TargetSpeed).toBe(400);
  });

  it('MESSUNG b2: eleven kinds are affected — the whole asset lineage, not an edge case', () => {
    const assetKinds = RV_OP_KINDS.filter((k: RvOpKind) => RV_OP_ORIGIN[k] === 'asset');
    expect(assetKinds).toHaveLength(11);
    // Structural, all of them: there is no `MaterialisedEdits` category that
    // could express "this node was deleted / renamed / reparented" — which is
    // why "erweitertes Overlay" is a new vocabulary, and "projizierter Baum"
    // is the existing exporter.
    expect(assetKinds).toEqual(expect.arrayContaining([
      'deleteNode', 'renameNode', 'reparentNode', 'createNode', 'importCad',
      'addComponent', 'removeComponent', 'setMaterial', 'separateMesh',
      'mergeMesh', 'setNodeVisible',
    ]));
  });

  it('MESSUNG b3: a composite hides the same loss, so a transaction is no safer', () => {
    const composite: RvOp = {
      ...head(), kind: 'composite', label: 'Mixed batch',
      ops: [setField(400), deleteNode()],
    } as unknown as RvOp;
    const folded = materialise([composite]);
    expect(folded.overlay.nodes['Asset/Box']?.Drive?.TargetSpeed).toBe(400);
    // The delete is gone from the fold exactly as it is when it stands alone —
    // `flattenOps` unwraps the composite and each child meets the same default.
    expect(JSON.stringify(folded)).toBe(JSON.stringify(materialise([setField(400)])));
  });
});

// ═════════════════════════════════════════════════════════════════════════
// (c) Undo of a foreign-projected op.
// ═════════════════════════════════════════════════════════════════════════

describe('(c) Undo eines fremd-projizierten Ops', () => {
  it('MESSUNG c1: undo in the wrong projection pops the log and changes NOTHING — silently', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'scene');
    await doc.applyOp(addPlacement('plc_1'));
    await doc.applyOp(setField(400));
    expect(doc.opCount).toBe(2);

    const history = doc.captureHistory();
    projection.switchToEditorProjection();
    const { doc: editorDoc } = makeDoc(projection, 'asset');
    await replayWithoutRecording(editorDoc, history.ops);
    editorDoc.restoreHistory(history);

    // Undo the newest (setField) — a `'both'` kind, so it inverts properly.
    await editorDoc.undo();
    expect((projection.nodeAt('Asset/Box')!.userData.realvirtual as Record<string, Record<string, unknown>>)
      .Drive.TargetSpeed).toBe(50);

    // Undo the FOREIGN one. The log shrinks; the world does not move, and
    // nothing anywhere reports a problem.
    await editorDoc.undo();
    expect(editorDoc.opCount).toBe(0);
    expect(editorDoc.canRedo()).toBe(true);
    expect(projection.planner).toBeNull();
  });

  it('MESSUNG c2: the mini-recompose costs one reload + N applyForward — and must be kind-triggered', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'scene');
    for (let i = 0; i < 5; i++) await doc.applyOp(setField(100 + i, i % 2 ? 'Asset/Box' : 'Asset/Frame'));
    await doc.applyOp(addPlacement('plc_1'));

    // What a mini-recompose after undoing the placement would replay: the log
    // up to the floor, once. There is no cheaper correct answer for a kind
    // whose inverse the active projection cannot execute…
    const history = doc.captureHistory();
    const toReplay = history.ops.slice(0, -1);
    let applied = 0;
    projection.switchToSceneProjection();
    const { doc: fresh } = makeDoc(projection, 'scene');
    await fresh.runExclusive(async () => {
      for (const op of toReplay) { await fresh.executor.applyForward(op); applied++; }
    });
    expect(applied).toBe(toReplay.length);

    // …and the trigger cannot be "the inverse failed", because it does not
    // fail: `resolveOpTarget` names the projection an op belongs to, and that
    // is the only signal available BEFORE the silent no-op happens.
    expect(resolveOpTarget(history.ops[history.ops.length - 1], 'asset')).toBe('scene');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// (d) Executor state across the projection change.
// ═════════════════════════════════════════════════════════════════════════

describe('(d) AssetExecutorContext ueber den Projektionswechsel', () => {
  it('MESSUNG d1: undo of deleteNode after the switch restores the node to a DETACHED parent', async () => {
    const projection = makeProjectionViewer();
    const ctx = new AssetExecutorContext(projection.viewer);
    const op = deleteNode('Asset/Frame');

    const frameBefore = projection.nodeAt('Asset/Frame')!;
    const oldRoot = projection.tree.root;
    await ctx.applyForward(op as never);
    expect(frameBefore.parent, 'the trash owns it now').not.toBe(oldRoot);

    // The projection changes. The context is carried over — which is exactly
    // what `adoptAssetContext` would do (§2.3).
    projection.switchToEditorProjection();
    const newRoot = projection.tree.root;
    expect(newRoot).not.toBe(oldRoot);

    await ctx.applyInverse(op as never);

    // The verdict, and it is worse than "the undo does nothing".
    //
    // `_trash` stored the `Object3D` PARENT, so the node goes back into the OLD
    // tree — invisible, since nothing renders that scene any more…
    expect(frameBefore.parent).toBe(oldRoot);
    let reachesLiveRoot = false;
    for (let p: Object3D | null = frameBefore; p; p = p.parent) {
      if (p === newRoot) reachesLiveRoot = true;
    }
    expect(reachesLiveRoot, 'the restored node is not in the live tree').toBe(false);

    // …while `_restoreFromTrash` ALSO calls `_registerSubtree`, which writes
    // into the LIVE registry. The path now resolves to a ghost: an object that
    // belongs to a tree nobody is showing, shadowing the live node that sits at
    // exactly that path. Every later op addressed to `Asset/Frame` — including
    // the next save's path lookups — gets the ghost.
    const liveFrame = projection.tree.root.children.find((c) => c.name === 'Frame')!;
    expect(liveFrame).toBeTruthy();
    expect(projection.nodeAt('Asset/Frame')).toBe(frameBefore);
    expect(projection.nodeAt('Asset/Frame')).not.toBe(liveFrame);
  });

  it('MESSUNG d2: the trash GROUP stays in the old scene', async () => {
    const projection = makeProjectionViewer();
    const ctx = new AssetExecutorContext(projection.viewer);
    const oldScene = projection.tree.scene;
    await ctx.applyForward(deleteNode('Asset/Frame') as never);

    const trashInOld = oldScene.children.some((c) => c.name.toLowerCase().includes('trash'));
    expect(trashInOld, '_ensureTrashGroup added it to the scene that was live then').toBe(true);

    projection.switchToEditorProjection();
    // `_trashGroup` is a field, not a lookup: the context keeps pointing at the
    // group in the scene nobody is showing any more, and every later delete
    // parks its node there.
    const trashInNew = projection.tree.scene.children.some(
      (c) => c.name.toLowerCase().includes('trash'),
    );
    expect(trashInNew).toBe(false);
  });

  it('MESSUNG d3: _cadPayloads is the opposite case — tree-independent, so it survives', async () => {
    const projection = makeProjectionViewer();
    const ctx = new AssetExecutorContext(projection.viewer);
    const op = importCad();
    const parsed = new Group();
    parsed.name = 'Imported';
    ctx.provideCadPayload(op.id, parsed);

    projection.switchToEditorProjection();
    // The payload is keyed by op id and holds a parsed subtree that belongs to
    // no tree yet, so the switch cannot invalidate it. `importCad` forward
    // needs only a LIVE root, which the new projection has.
    await expect(ctx.applyForward(op as never)).resolves.toBeUndefined();
    expect(projection.tree.root.children.some((c) => c.name === 'Imported')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// (e) The error-contract difference on foreign replay.
// ═════════════════════════════════════════════════════════════════════════

describe('(e) Fehlerkontrakt: Szene-swallow vs. Asset-reject', () => {
  /** One op per lineage, aimed at a path the live tree does not have. */
  const missingPath = 'Asset/DoesNotExist';

  it('MESSUNG e1: the scene side swallows and the document RECORDS the op anyway', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'scene');
    await expect(doc.applyOp(setField(400, missingPath))).resolves.toBeUndefined();
    expect(doc.opCount, 'recorded — the log now claims something that did not happen').toBe(1);
  });

  it('MESSUNG e2: the asset side rejects only where it CANNOT proceed', async () => {
    const projection = makeProjectionViewer();
    const ctx = new AssetExecutorContext(projection.viewer);

    // Rejects: no node to reparent onto.
    await expect(ctx.applyForward({
      ...head(), kind: 'reparentNode',
      nodePath: missingPath, newParentPath: 'Asset',
      transform: { position: { x: 0, y: 0, z: 0 } }, prev: {},
    } as never)).rejects.toThrow();

    // Does NOT reject: the common structural kinds `if (!node) return`.
    await expect(ctx.applyForward(deleteNode(missingPath) as never)).resolves.toBeUndefined();
    await expect(ctx.applyForward(renameNode(missingPath) as never)).resolves.toBeUndefined();
    await expect(ctx.applyForward({
      ...head(), kind: 'setNodeVisible', nodePath: missingPath, visible: false, prev: true,
    } as never)).resolves.toBeUndefined();
  });

  it('MESSUNG e3: so an asset op in the SCENE projection is recorded as done, too', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'scene');
    // Routed to the asset executor by ORIGIN (a1) — against the SCENE's tree.
    await expect(doc.applyOp(deleteNode('Asset/Frame'))).resolves.toBeUndefined();
    expect(doc.opCount).toBe(1);
    // It really did edit the scene's tree: this is not "skipped", it is
    // "applied to whichever tree the viewer happened to hold".
    expect(projection.tree.root.children.some((c) => c.name === 'Frame')).toBe(false);
  });
});

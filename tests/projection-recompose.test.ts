// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-711 §9.3 — the RECOMPOSE, in both directions.
 *
 * The spike (`spike-projection-recompose.test.ts`) measured what the executor
 * DOES with a mixed log; this file pins what `rv-document-projection.ts` makes
 * of those measurements:
 *
 *  - a recompose replays without recording — the log comes back byte-identical
 *    and `dirty` does not move (the plan-410 R1-2 failure mode);
 *  - the replay is FILTERED by projection. Unfiltered, a scene op reaches the
 *    scene executor in the editor projection and materialises nothing (Spike a),
 *    while an asset op reaches the asset executor in the scene projection and
 *    edits the wrong tree (Spike e3) — the second of which is data loss;
 *  - `replay: 'none'` is the way back, where the bytes already ARE the ops;
 *  - undo of a foreign-projected op goes through a re-projection, is decided by
 *    KIND before anything is applied (Spike c: there is no failure to detect),
 *    and is refused rather than queued while a transaction is open.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RvDocument } from '../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../src/core/ops/rv-unified-executors';
import {
  isProjectedInto,
  needsRecomposeToUndo,
  projectedOps,
  recomposeProjection,
  undoViaRecompose,
} from '../src/core/ops/rv-document-projection';
import type { RvOp, RvPrimitiveOp } from '../src/core/ops/rv-unified-ops';
import type { RVViewer } from '../src/core/rv-viewer';

let opSeq = 0;
const head = () => ({ id: `op_proj_${++opSeq}`, ts: 10_000, schemaV: 1 as const });

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

/** The spike's viewer double: a tree that can be swapped, a planner that vanishes. */
function makeProjectionViewer() {
  let tree = buildTree();
  let planner: { placed: string[] } | null = { placed: [] };
  const viewer = {
    get scene() { return tree.scene; },
    get registry() { return tree.registry; },
    get currentModelRoot() { return tree.root; },
    currentModelUrl: 'proj://asset.glb',
    signalStore: null, transportManager: null,
    instancePickIndex: undefined, groups: undefined,
    getPlugin: <T,>(id: string): T | undefined => (id === 'layout-planner'
      ? ({
          placeFromRecord: async (record: { id: string }) => { planner!.placed.push(record.id); },
          removePlacementById: () => {},
          applyTransformById: () => {},
        } as unknown as T)
      : undefined),
    markRenderDirty() {}, markShadowsDirty() {},
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {}, rebuildIKPaths() {},
    emit() {}, on() { return () => {}; },
  };
  return {
    viewer: viewer as unknown as RVViewer,
    get tree() { return tree; },
    get planner() { return planner; },
    swapTree(withPlanner: boolean) { tree = buildTree(); planner = withPlanner ? { placed: [] } : null; },
    nodeAt(path: string) { return tree.registry.getNode(path); },
  };
}

const setField = (value: number, nodePath = 'Asset/Box'): RvPrimitiveOp => ({
  ...head(), kind: 'setField',
  nodePath, componentType: 'Drive', fieldName: 'TargetSpeed', value, prev: 50,
});

const addPlacement = (id: string): RvPrimitiveOp => ({
  ...head(), kind: 'addPlacement',
  placement: {
    id, assetId: 'lib/belt', name: 'Belt',
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
  },
} as unknown as RvPrimitiveOp);

const deleteNode = (nodePath = 'Asset/Frame'): RvPrimitiveOp => ({
  ...head(), kind: 'deleteNode', nodePath,
} as unknown as RvPrimitiveOp);

function makeDoc(projection: ReturnType<typeof makeProjectionViewer>, mode: 'scene' | 'asset') {
  const executor = new RvUnifiedExecutor(projection.viewer, mode);
  const doc = new RvDocument({ id: 'doc_proj', name: 'Projected', mode, executor });
  return { doc, executor };
}

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

// ─── The filter ─────────────────────────────────────────────────────────

describe('projektions-bewusste Replay-Filterung', () => {
  it('names the projection an op belongs to, in BOTH directions', () => {
    expect(isProjectedInto(addPlacement('p1'), 'scene')).toBe(true);
    expect(isProjectedInto(addPlacement('p1'), 'asset')).toBe(false);
    expect(isProjectedInto(deleteNode(), 'asset')).toBe(true);
    // The one the plan text missed: an asset op in the scene projection is not
    // "skipped", it is aimed at whatever tree the viewer holds (Spike e3).
    expect(isProjectedInto(deleteNode(), 'scene')).toBe(false);
    // A `'both'` kind follows the mode, which is what makes it carry across.
    expect(isProjectedInto(setField(400), 'scene')).toBe(true);
    expect(isProjectedInto(setField(400), 'asset')).toBe(true);
  });

  it('refuses a MIXED composite in either projection — it would half-land', () => {
    const mixed = {
      ...head(), kind: 'composite', label: 'Mixed batch',
      ops: [addPlacement('p1'), deleteNode()],
    } as unknown as RvOp;
    expect(isProjectedInto(mixed, 'scene')).toBe(false);
    expect(isProjectedInto(mixed, 'asset')).toBe(false);
    expect(needsRecomposeToUndo(mixed, 'asset')).toBe(true);
  });

  it('splits a mixed log into the two halves the two projections can rebuild', () => {
    const log: RvOp[] = [addPlacement('p1'), setField(400), deleteNode()];
    expect(projectedOps(log, 'scene').map((o) => o.kind)).toEqual(['addPlacement', 'setField']);
    expect(projectedOps(log, 'asset').map((o) => o.kind)).toEqual(['setField', 'deleteNode']);
  });
});

// ─── The recompose ──────────────────────────────────────────────────────

describe('recomposeProjection', () => {
  it('replays WITHOUT recording: the log is byte-identical and dirty does not move', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'scene');
    await doc.applyOp(setField(400));
    await doc.applyOp(setField(500, 'Asset/Frame'));
    doc.markSaved();
    expect(doc.dirty).toBe(false);
    const logBefore = JSON.stringify(doc.ops);

    await recomposeProjection({
      doc, projection: 'asset',
      reload: async () => { projection.swapTree(false); },
    });

    expect(JSON.stringify(doc.ops)).toBe(logBefore);
    expect(doc.opCount).toBe(2);
    // A CLEAN document may not come back dirty — the failure plan-410 R1-2 named.
    expect(doc.dirty).toBe(false);
    expect(doc.mode).toBe('asset');
  });

  it('carries the `both` kinds onto the NEW tree and leaves the foreign ones to bytes', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'scene');
    await doc.applyOp(addPlacement('plc_1'));
    await doc.applyOp(setField(400));
    const boxBefore = projection.nodeAt('Asset/Box');

    await recomposeProjection({
      doc, projection: 'asset',
      reload: async () => { projection.swapTree(false); },
    });

    const boxAfter = projection.nodeAt('Asset/Box')!;
    expect(boxAfter, 'a projection change is a NEW tree').not.toBe(boxBefore);
    expect((boxAfter.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed)
      .toBe(400);
    // The placement was NOT run against the editor's tree — it reaches this
    // projection through the scene bake, never through `applyForward`.
    expect(projection.nodeAt('Asset/Belt')).toBeNull();
    // …and it is still in the log, so the way back still has it.
    expect(doc.ops.map((o) => o.kind)).toEqual(['addPlacement', 'setField']);
  });

  it('does NOT run an asset op against the scene tree on the way back (Spike e3)', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'asset');
    await doc.applyOp(deleteNode('Asset/Frame'));
    expect(projection.tree.root.children.some((c) => c.name === 'Frame')).toBe(false);

    await recomposeProjection({
      doc, projection: 'scene',
      reload: async () => { projection.swapTree(true); },
    });

    // The scene's tree is untouched by the editor's structural op — an
    // unfiltered replay would have deleted the node out of the SCENE here.
    expect(projection.tree.root.children.some((c) => c.name === 'Frame')).toBe(true);
    expect(doc.opCount).toBe(1);
  });

  it('`replay: none` is the restore-only case — bytes that already are the ops', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'asset');
    await doc.applyOp(setField(400));

    await recomposeProjection({
      doc, projection: 'scene', replay: 'none',
      reload: async () => { projection.swapTree(true); },
    });

    // Nothing was applied: the fresh tree still carries its authored default,
    // which is what "the export already contains both halves" means for a
    // double that does not really export.
    expect((projection.nodeAt('Asset/Box')!.userData.realvirtual as Record<string, Record<string, unknown>>)
      .Drive.TargetSpeed).toBe(50);
    expect(doc.opCount).toBe(1);
    expect(doc.mode).toBe('scene');
  });

  it('holds the queue across the RELOAD, so a racing op cannot land mid-rebuild', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'scene');
    await doc.applyOp(setField(400));

    let releaseReload!: () => void;
    const reloadStarted = new Promise<void>((resolve) => {
      releaseReload = resolve;
    });
    let racedDuringReload = false;

    const running = recomposeProjection({
      doc, projection: 'asset',
      reload: async () => {
        projection.swapTree(false);
        await reloadStarted;
      },
    });
    // Queued while the reload is still in flight. A DIFFERENT target, so the
    // recorder cannot coalesce it into the op already in the log and hide the
    // very arrival this test is about.
    const raced = doc.applyOp(setField(700, 'Asset/Frame')).then(() => { racedDuringReload = true; });
    expect(racedDuringReload).toBe(false);
    releaseReload();
    await running;
    await raced;
    // It landed AFTER the restore, so it is on top of the recomposed log
    // rather than swallowed by it.
    expect(doc.opCount).toBe(2);
    expect(doc.ops[1].kind).toBe('setField');
  });
});

// ─── Undo across the seam ───────────────────────────────────────────────

describe('Undo eines fremd-projizierten Ops (Spike c/d)', () => {
  it('is kind-triggered, not failure-triggered', () => {
    // The op that started it: its inverse does NOT fail in the asset
    // projection, it is swallowed — so the decision has to be made before it.
    expect(needsRecomposeToUndo(addPlacement('p1'), 'asset')).toBe(true);
    expect(needsRecomposeToUndo(setField(400), 'asset')).toBe(false);
  });

  it('re-projects the log WITHOUT the undone op, and offers it back through redo', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'scene');
    await doc.applyOp(setField(400));
    await doc.applyOp(addPlacement('plc_1'));
    // The editor projection, with the placement still in the log.
    await recomposeProjection({
      doc, projection: 'asset',
      reload: async () => { projection.swapTree(false); },
    });
    expect(doc.opCount).toBe(2);

    let reloads = 0;
    const outcome = await undoViaRecompose({
      doc,
      reload: async () => { reloads++; projection.swapTree(false); },
    });

    expect(outcome.ok).toBe(true);
    expect(reloads).toBe(1);
    expect(doc.ops.map((o) => o.kind)).toEqual(['setField']);
    expect(doc.canRedo()).toBe(true);
    // The surviving op was re-applied onto the rebuilt tree — the log and the
    // tree agree, which is exactly what the silent divergence (MESSUNG c1) did
    // not achieve.
    expect((projection.nodeAt('Asset/Box')!.userData.realvirtual as Record<string, Record<string, unknown>>)
      .Drive.TargetSpeed).toBe(400);
  });

  it('is REFUSED inside an open transaction, with a reason', async () => {
    const projection = makeProjectionViewer();
    const { doc } = makeDoc(projection, 'scene');
    await doc.applyOp(addPlacement('plc_1'));
    const token = doc.beginTransaction('Bulk edit');

    const outcome = await undoViaRecompose({ doc, reload: async () => { projection.swapTree(false); } });

    expect(outcome).toEqual({
      ok: false,
      reason: 'in-transaction',
      message: expect.stringContaining('finished'),
    });
    // Nothing happened to the log — a refusal is not a partial undo.
    expect(doc.opCount).toBe(1);
    await doc.abortTransaction(token);
  });

  it('refuses when there is nothing above the undo floor', async () => {
    const projection = makeProjectionViewer();
    const executor = new RvUnifiedExecutor(projection.viewer, 'scene');
    const doc = new RvDocument({
      id: 'doc_floor', name: 'Floored', mode: 'scene', executor, baselineFloor: 1,
    });
    doc.restoreHistory({
      ops: [addPlacement('published')], redoOps: [], baselineIds: [], baselineFloor: 1, metaDirty: false,
    });
    const outcome = await undoViaRecompose({ doc, reload: async () => {} });
    expect(outcome.ok).toBe(false);
    // The scene's published floor holds through a projection change — undo may
    // never reach under what was published (plan-711 R1-A3).
    expect(doc.opCount).toBe(1);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-711 §9.7 (Triage R1-T3) — the two invariants Phase 2+3 could break in
 * silence.
 *
 * 1. **Executor identity.** `AssetDocument` publishes its `AssetExecutorContext`
 *    as `doc.executor` and hands CAD / merge / separate payloads to it by that
 *    handle (`rv-asset-document.ts:130-133`), while the document it drives holds
 *    the same object inside its `RvUnifiedExecutor`. Nothing tested that until
 *    now — the constructor comment was the whole guarantee — and `adoptAssetContext`
 *    is exactly the new API that could break it.
 *
 * 2. **The two `mode` fields.** `RvDocument.mode` decides composite tagging and
 *    the snapshot; `RvUnifiedExecutor.mode` decides `resolveOpTarget`. They are
 *    two fields for one fact, and a state where they disagree records an op as
 *    belonging to one projection while applying it to the other. `setProjection`
 *    is the only transition, and this pins that it moves both.
 */

import { describe, it, expect } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Group, Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RvDocument } from '../src/core/ops/rv-document';
import { RvUnifiedExecutor, resolveOpTarget } from '../src/core/ops/rv-unified-executors';
import { AssetExecutorContext } from '../src/core/editor/rv-asset-executors';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { sceneDocumentBase } from '../src/core/editor/active-asset-store';
import type { RvPrimitiveOp } from '../src/core/ops/rv-unified-ops';
import type { RVViewer } from '../src/core/rv-viewer';

let opSeq = 0;
const head = () => ({ id: `op_pin_${++opSeq}`, ts: 10_000, schemaV: 1 as const });

function makeViewer(): RVViewer {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);
  const box = new Object3D();
  box.name = 'Box';
  box.userData.realvirtual = { Drive: { TargetSpeed: 50 } };
  root.add(box);
  const registry = new NodeRegistry();
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  return {
    scene, registry,
    signalStore: null, transportManager: null,
    get currentModelRoot() { return root; },
    markRenderDirty() {}, markShadowsDirty() {},
    emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {}, rebuildIKPaths() {},
    getPlugin: () => undefined,
  } as unknown as RVViewer;
}

/** The one place both halves of the identity can be read at once. */
function assetSideOf(doc: AssetDocument): AssetExecutorContext {
  return (doc.document.executor as RvUnifiedExecutor).assetExecutor;
}

const setField = (value: number): RvPrimitiveOp => ({
  ...head(), kind: 'setField',
  nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed', value, prev: 50,
});

describe('doc.executor === AssetDocument.executor', () => {
  it('holds for a freshly constructed document', () => {
    const doc = scratchAssetDocument(makeViewer());
    expect(assetSideOf(doc)).toBe(doc.executor);
    doc.dispose();
  });

  it('holds for a BOUND document — adoptAssetContext preserves it', () => {
    const viewer = makeViewer();
    const shared = new RvDocument({
      id: 'scene', name: 'Line 1', mode: 'scene',
      executor: new RvUnifiedExecutor(viewer, 'scene'),
    });
    // The scene document has no asset side until something asks for one — a
    // pure scene document must not pay for a trash group it never uses.
    expect((shared.executor as RvUnifiedExecutor).hasAssetExecutor).toBe(false);

    const bound = new AssetDocument(viewer, {
      id: 'asset_bound', name: 'Line 1',
      base: sceneDocumentBase('scene_1', 'Line 1'),
      adopt: shared,
    });

    expect((shared.executor as RvUnifiedExecutor).hasAssetExecutor).toBe(true);
    expect(assetSideOf(bound)).toBe(bound.executor);
    // The SAME executor object the document drives — not a copy that happens to
    // behave alike, which is what the CAD payload hand-off would silently miss.
    expect(bound.document.executor).toBe(shared.executor);
    bound.dispose();
  });

  it('a FRESH context is adopted, never the previous one (Spike d)', () => {
    const viewer = makeViewer();
    const stale = new AssetExecutorContext(viewer);
    const unified = new RvUnifiedExecutor(viewer, 'scene', stale);
    const shared = new RvDocument({ id: 'scene', name: 'Line 1', mode: 'scene', executor: unified });

    const bound = new AssetDocument(viewer, {
      id: 'asset_bound', name: 'Line 1',
      base: sceneDocumentBase('scene_1', 'Line 1'),
      adopt: shared,
    });

    // The tree-bound state of the OLD tree (`_trash`, `_trashGroup`) does not
    // travel: carrying it over re-attaches undone nodes to a detached parent and
    // registers ghosts over the live ones (MESSUNG d1).
    expect(unified.assetExecutor).not.toBe(stale);
    expect(unified.assetExecutor).toBe(bound.executor);
    bound.dispose();
  });

  it('unbinding releases the asset side instead of leaving a disposed one behind', () => {
    const viewer = makeViewer();
    const unified = new RvUnifiedExecutor(viewer, 'scene');
    const shared = new RvDocument({ id: 'scene', name: 'Line 1', mode: 'scene', executor: unified });
    const bound = new AssetDocument(viewer, {
      id: 'asset_bound', name: 'Line 1',
      base: sceneDocumentBase('scene_1', 'Line 1'),
      adopt: shared,
    });
    expect(unified.hasAssetExecutor).toBe(true);

    bound.dispose();

    // Back to none: the next asset op builds one against whatever tree is live
    // by then, which is the only correct answer after a projection change.
    expect(unified.hasAssetExecutor).toBe(false);
    expect(shared.isDisposed).toBe(false);
  });
});

describe('setProjection haelt BEIDE mode-Felder synchron', () => {
  it('moves the document and its executor together', () => {
    const viewer = makeViewer();
    const executor = new RvUnifiedExecutor(viewer, 'scene');
    const doc = new RvDocument({ id: 'doc', name: 'D', mode: 'scene', executor });
    expect(doc.mode).toBe('scene');
    expect(executor.mode).toBe('scene');

    doc.setProjection('asset');
    expect(doc.mode).toBe('asset');
    expect(executor.mode).toBe('asset');

    doc.setProjection('scene');
    expect(doc.mode).toBe('scene');
    expect(executor.mode).toBe('scene');
  });

  it('so the `both` kinds change target with it — the reason the mode exists', () => {
    const viewer = makeViewer();
    const executor = new RvUnifiedExecutor(viewer, 'scene');
    const doc = new RvDocument({ id: 'doc', name: 'D', mode: 'scene', executor });
    const op = setField(400);
    expect(resolveOpTarget(op, doc.mode)).toBe('scene');
    doc.setProjection('asset');
    expect(resolveOpTarget(op, doc.mode)).toBe('asset');
    expect(resolveOpTarget(op, executor.mode)).toBe('asset');
  });

  it('a document over an executor that does not project still switches its own half', () => {
    // Every document test drives a pair of closures with no routing at all;
    // `setMode` is optional precisely so they do not have to grow one.
    const applied: string[] = [];
    const doc = new RvDocument({
      id: 'doc', name: 'D', mode: 'scene',
      executor: {
        applyForward: async (op) => { applied.push(op.kind); },
        applyInverse: async () => {},
      },
    });
    doc.setProjection('asset');
    expect(doc.mode).toBe('asset');
    expect(applied).toEqual([]);
  });

  it('the snapshot follows the projection', () => {
    const viewer = makeViewer();
    const doc = new RvDocument({
      id: 'doc', name: 'D', mode: 'scene', executor: new RvUnifiedExecutor(viewer, 'scene'),
    });
    expect(doc.getSnapshot().mode).toBe('scene');
    doc.setProjection('asset');
    expect(doc.getSnapshot().mode).toBe('asset');
  });
});

describe('attachCommitHook (R2-Arch-F1)', () => {
  it('fires on the COMMIT channel, beside the constructor hook, and detaches', async () => {
    const viewer = makeViewer();
    const owner: number[] = [];
    const borrower: number[] = [];
    const doc = new RvDocument({
      id: 'doc', name: 'D', mode: 'scene',
      executor: new RvUnifiedExecutor(viewer, 'scene'),
      onChanged: (d) => owner.push(d.opCount),
    });

    const detach = doc.attachCommitHook((d) => borrower.push(d.opCount));
    await doc.applyOp(setField(400));
    expect(owner).toEqual([1]);
    expect(borrower).toEqual([1]);

    detach();
    await doc.applyOp(setField(500));
    // The lender keeps hearing; the borrower does not, because the binding is
    // over. That is the whole reason this is not a constructor option.
    expect(owner).toHaveLength(2);
    expect(borrower).toEqual([1]);
  });

  it('stays quiet inside a transaction and speaks once at the commit', async () => {
    const viewer = makeViewer();
    const seen: number[] = [];
    const doc = new RvDocument({
      id: 'doc', name: 'D', mode: 'scene', executor: new RvUnifiedExecutor(viewer, 'scene'),
    });
    doc.attachCommitHook(() => seen.push(doc.opCount));

    const token = doc.beginTransaction('Bulk');
    await doc.applyOp(setField(400));
    await doc.applyOp(setField(500));
    expect(seen).toEqual([]);
    await doc.endTransaction(token);
    expect(seen).toEqual([1]);
  });

  it('does NOT fire for a restore — the channel is commits, not notifications', () => {
    const viewer = makeViewer();
    const seen: number[] = [];
    const doc = new RvDocument({
      id: 'doc', name: 'D', mode: 'scene', executor: new RvUnifiedExecutor(viewer, 'scene'),
    });
    doc.attachCommitHook(() => seen.push(doc.opCount));
    doc.restoreHistory({
      ops: [setField(400)], redoOps: [], baselineIds: [], baselineFloor: 0, metaDirty: false,
    });
    // A recompose restores the history it froze; waking a draft writer there
    // would write while the log and the tree are mid-rebuild.
    expect(seen).toEqual([]);
  });
});

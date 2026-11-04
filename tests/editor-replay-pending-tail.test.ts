// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 release unit B, review round 1 — what a REPLAY does with ops on
 * placed content that is late, missing or never coming.
 *
 *  - E3: the late-settle draft tail is DOCUMENT state (`RvDocument.pendingReplayOps`):
 *    in the draft (exit flush), kept on a supersede (descend) and re-applied by
 *    the next recompose (Back); its wait is bounded — after the budget the ops
 *    are kept unapplied (draft) and reported, the document queue is free again.
 *  - E4: a missing placed target drops the op from the history only when its
 *    placement IS materialised (baked away); a placeholder keeps it ("not loaded").
 *  - E5: a composite loses only its missing placed children.
 *  - E6: the gate is asked per op during the replay (a rename before the
 *    override counts), and reference prefixes are looked up exactly.
 *
 * Real `RVViewer`, fake gated loader (`bootNestedViewer`), the production
 * authoring join (`loadAuthoringModel`) and gate (`authoringReplayGate`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene, type Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerCadProvider } from '../src/core/editor/rv-cad-provider';
import { clearCadGlbCache } from '../src/core/import/rv-cad-glb-cache';
import { reportAfterPendingReplay, reportDraftReplayAftermath } from '@rv-private/plugins/asset-editor/index';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import {
  AuthoringLoadSupersededError, authoringReplayGate, loadAuthoringModel, opTargetsPlacedContent,
} from '../src/core/editor/rv-authoring-load';
import { recomposeProjection, replayOntoTreeLocked, undoViaRecompose } from '../src/core/ops/rv-document-projection';
import { RvDocumentStack } from '../src/core/ops/rv-document-stack';
import { RvDescendController, type RvRecomposeHost } from '../src/core/ops/rv-document-recompose';
import { createStackTestViewer, TestStackDocument } from './helpers/stack-test-viewer';
import { makeOpFixture } from './helpers/rv-op-fixtures';
import { makeComposite, type RvOp, type RvPrimitiveOp } from '../src/core/ops/rv-unified-ops';
import { __clearDraftStoresForTests, loadDocumentDraft } from '../src/core/ops/rv-document-drafts';
import { getProblems, resetProblemsForTests, REPLAY_OP_SKIPPED_CODE } from '../src/core/hmi/problems-store';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import {
  CELL_REF_NODE_ID, INNER_URL, SLIDE_NODE_ID,
  bootNestedViewer, findByName, makeOuter, plainBytes, sleep, type Booted,
} from './helpers/nested-placement-fixture';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';

let booted: Booted | null = null;
const docs: AssetDocument[] = [];
beforeEach(async () => {
  await __clearDraftStoresForTests();
});
afterEach(async () => {
  for (const d of docs.splice(0)) {
    try { await d.document.whenIdle(); } catch { /* best effort */ }
    try { d.dispose(); } catch { /* best effort */ }
  }
  booted?.h.dispose();
  booted = null;
  resetProblemsForTests();
});

const MISSING_URL = 'blob:rv-test/p774-missing.glb';

async function machineBytes(innerUrl = INNER_URL, opts?: { under?: string }): Promise<ArrayBuffer> {
  return objectToGlb(makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: innerUrl, planner: true }], opts));
}

function byIdentity(root: Object3D, id: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && identityIdOf(n) === id) hit = n; });
  return hit;
}

let seq = 0;
function setField(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): RvOp {
  seq += 1;
  return {
    id: `op-${seq}`, ts: seq, origin: 'asset', kind: 'setField',
    nodePath, componentType, fieldName, value, prev,
  } as unknown as RvOp;
}

function slideSpeed(b: Booted): number | undefined {
  const cell = findByName(b.h.viewer.currentModelRoot!, 'Cell_1')!;
  const slide = byIdentity(cell, SLIDE_NODE_ID);
  return (slide?.userData.realvirtual as { Drive?: { TargetSpeed?: number } } | undefined)?.Drive?.TargetSpeed;
}

function skippedProblems() {
  return getProblems().filter((p) => p.code === REPLAY_OP_SKIPPED_CODE);
}

/** Load `bytes` with the gated inner asset held back past a short join budget. */
async function openNotReady(b: Booted, bytes: ArrayBuffer) {
  const v = b.h.viewer;
  const result = await loadAuthoringModel(v, 'machine.glb', { identity: { label: 'Machine' }, keepBaked: true, budgetMs: 30, data: bytes });
  expect(result.ok && !result.placementsReady, 'the join ran out of budget').toBe(true);
  const gate = authoringReplayGate(v, result);
  expect(gate).toBeDefined();
  const doc = scratchAssetDocument(v, 'Machine');
  docs.push(doc);
  const root = v.currentModelRoot!;
  const frame = findByName(root, 'Frame')!;
  frame.userData.realvirtual = { ...(frame.userData.realvirtual ?? {}), Note: { Text: 'a' } };
  return {
    gate: gate!, doc, root,
    framePath: v.registry!.getPathForNode(frame)!,
    cellPath: v.registry!.getPathForNode(findByName(root, 'Cell_1')!)!,
  };
}

describe('plan-774 review fix E3 — the late-settle draft tail is document state', () => {
  it('pending tail: in toDraft and in the flushed draft (exit guard), applied in log order once the placements arrive', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const { gate, doc, framePath, cellPath } = await openNotReady(booted, await machineBytes());
    const own = setField(framePath, 'Note', 'Text', 'b', 'a');
    const placed = setField(`${cellPath}/Slide`, 'Drive', 'TargetSpeed', 250, 200);
    const own2 = setField(framePath, 'Note', 'Text', 'c', 'b');

    await doc.replayOps([own, placed, own2], { gate, waitBudgetMs: 10_000 });
    expect(doc.document.ops.map((o) => o.id), 'applied now: the ops before the first gated one').toEqual([own.id]);
    expect(doc.document.pendingReplayOps.map((o) => o.id)).toEqual([placed.id, own2.id]);
    expect(doc.hasPendingReplay).toBe(true);
    expect(doc.document.dirty).toBe(true);
    expect(doc.toDraft().ops.map((o) => o.id), 'the draft recipe carries the tail').toEqual([own.id, placed.id, own2.id]);

    // The exit guard's flush writes the tail too.
    await doc.flushDraft();
    const stored = await loadDocumentDraft(doc.draftFrame);
    expect(stored?.ops.map((o) => o.id)).toEqual([own.id, placed.id, own2.id]);

    booted.open();
    await doc.document.whenIdle();
    expect(doc.hasPendingReplay).toBe(false);
    expect(doc.document.ops.map((o) => o.id)).toEqual([own.id, placed.id, own2.id]);
    expect(slideSpeed(booted)).toBe(250);
    const frame = findByName(booted.h.viewer.currentModelRoot!, 'Frame')!;
    expect((frame.userData.realvirtual as { Note: { Text: string } }).Note.Text).toBe('c');
  });

  it('a supersede (descend) keeps the tail; the next recompose (Back) replays it onto the fresh tree', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const bytes = await machineBytes();
    const v = booted.h.viewer;
    const { gate, doc, cellPath } = await openNotReady(booted, bytes);
    const placed = setField(`${cellPath}/Slide`, 'Drive', 'TargetSpeed', 270, 200);
    await doc.replayOps([placed], { gate, waitBudgetMs: 10_000 });
    expect(doc.document.pendingReplayOps).toHaveLength(1);

    // The descend: another document takes the viewer (held keep, like `_openChild`).
    const child = await loadAuthoringModel(v, 'child.glb', { identity: {}, keepBaked: true, holdKept: true, data: await plainBytes() });
    expect(child.ok).toBe(true);
    await doc.document.whenIdle();
    expect(doc.document.pendingReplayOps.map((o) => o.id), 'kept, not dropped').toEqual([placed.id]);
    expect(doc.document.ops).toHaveLength(0);
    expect(doc.toDraft().ops.map((o) => o.id)).toEqual([placed.id]);

    // Back: the parent is rebuilt through the recompose (what `recomposeFrame` runs).
    booted.open();
    const outcome = await recomposeProjection({
      doc: doc.document,
      replay: 'all',
      reload: async () => {
        const joined = await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: true, data: bytes });
        if (!joined.ok) throw new AuthoringLoadSupersededError('machine.glb');
        return { replayGate: authoringReplayGate(v, joined) };
      },
    });
    expect(outcome.status).toBe('ok');
    expect(doc.document.pendingReplayOps).toHaveLength(0);
    expect(doc.document.ops.map((o) => o.id)).toEqual([placed.id]);
    expect(slideSpeed(booted)).toBe(270);
  });

  it('a placement that never settles: after the budget the queue is free, the placed op is KEPT (draft) and reported', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const { gate, doc, framePath, cellPath } = await openNotReady(booted, await machineBytes());
    const own = setField(framePath, 'Note', 'Text', 'b', 'a');
    const placed = setField(`${cellPath}/Slide`, 'Drive', 'TargetSpeed', 280, 200);
    const own2 = setField(framePath, 'Note', 'Text', 'c', 'b');

    await doc.replayOps([own, placed, own2], { gate, waitBudgetMs: 60 });
    expect(doc.document.busy, 'the tail holds the queue while it waits').toBe(true);
    // Never opened: the wait ends by the budget, not by a settle — and the queue is released.
    await doc.document.whenIdle();
    expect(doc.document.busy).toBe(false);
    expect(doc.hasPendingReplay).toBe(false);
    expect(doc.document.ops.map((o) => o.id), 'nothing dropped, the order kept').toEqual([own.id, placed.id, own2.id]);
    expect(doc.toDraft().ops.map((o) => o.id)).toEqual([own.id, placed.id, own2.id]);
    const frame = findByName(booted.h.viewer.currentModelRoot!, 'Frame')!;
    expect((frame.userData.realvirtual as { Note: { Text: string } }).Note.Text, 'own content of the tail applied').toBe('c');
    const problems = skippedProblems();
    expect(problems.map((p) => p.nodePath)).toEqual([`${cellPath}/Slide`]);
    expect(problems[0]!.title).toContain('still loading');
    expect(problems[0]!.detail).toContain('kept');

    // The document is usable: a new edit lands behind the kept ones.
    await doc.setFieldAwaited(framePath, 'Note', 'Text', 'd', 'c');
    expect(doc.document.ops).toHaveLength(4);
    booted.open();
  });
});

describe('plan-774 review fix E4 — baked away (materialised) vs not loaded (placeholder)', () => {
  it('placeholder placement: the draft op is not applied but KEPT; the problem says "not loaded"', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    const joined = await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: true, budgetMs: 20_000, data: await machineBytes(MISSING_URL) });
    expect(joined).toMatchObject({ ok: true, placementsReady: true });
    const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
    expect(v.placements.instanceOf(cell), 'no instance: the placeholder').toBeNull();
    const cellPath = v.registry!.getPathForNode(cell)!;
    const doc = scratchAssetDocument(v, 'Machine');
    docs.push(doc);
    const op = setField(`${cellPath}/Slide`, 'Drive', 'TargetSpeed', 290, 200);

    const skipped = await doc.document.replayOps([op]);
    expect(skipped).toEqual([{ kind: 'setField', nodePath: `${cellPath}/Slide`, reason: 'not-loaded' }]);
    expect(doc.document.ops.map((o) => o.id), 'kept in the history / draft').toEqual([op.id]);
    expect(doc.toDraft().ops.map((o) => o.id)).toEqual([op.id]);
    const p = skippedProblems();
    expect(p).toHaveLength(1);
    expect(p[0]!.title).toContain('not loaded');
    expect(p[0]!.detail).toContain('not loaded');

    // The recompose replay decides the same way.
    resetProblemsForTests();
    const r = await replayOntoTreeLocked(doc.document, [op], 'Machine');
    expect(r).toEqual({ applied: 0, skipped: [{ kind: 'setField', nodePath: `${cellPath}/Slide`, placed: true, reason: 'not-loaded' }] });
    expect(skippedProblems()[0]!.title).toContain('not loaded');
  });

  it('materialised placement, target baked away: the op is dropped and the problem says so', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: true, data: await machineBytes() });
    const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
    expect(v.placements.instanceOf(cell)).not.toBeNull();
    const cellPath = v.registry!.getPathForNode(cell)!;
    const doc = scratchAssetDocument(v, 'Machine');
    docs.push(doc);
    const op = setField(`${cellPath}/Body`, 'Note', 'Text', 'x', '');

    const skipped = await doc.document.replayOps([op]);
    expect(skipped).toEqual([{ kind: 'setField', nodePath: `${cellPath}/Body`, reason: 'baked-away' }]);
    expect(doc.document.ops).toHaveLength(0);
    const p = skippedProblems();
    expect(p[0]!.title).toBe(`Edit not applied: setField on ${cellPath}/Body`);
    expect(p[0]!.detail).toContain('does not exist there');
  });
});

describe('plan-774 review fix E5 — a composite loses only its missing placed children', () => {
  it('own child + placed child on a baked-away node: the own child is applied and kept, the placed one reported', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: true, data: await machineBytes() });
    const root = v.currentModelRoot!;
    const frame = findByName(root, 'Frame')!;
    frame.userData.realvirtual = { ...(frame.userData.realvirtual ?? {}), Note: { Text: 'a' } };
    const framePath = v.registry!.getPathForNode(frame)!;
    const cellPath = v.registry!.getPathForNode(findByName(root, 'Cell_1')!)!;
    const own = setField(framePath, 'Note', 'Text', 'b', 'a') as RvPrimitiveOp;
    const gone = setField(`${cellPath}/Body`, 'Note', 'Text', 'x', '') as RvPrimitiveOp;
    const slide = setField(`${cellPath}/Slide`, 'Drive', 'TargetSpeed', 240, 200) as RvPrimitiveOp;
    const composite = makeComposite('asset', 'Edit three', [own, gone, slide]);

    const doc = scratchAssetDocument(v, 'Machine');
    docs.push(doc);
    const skipped = await doc.document.replayOps([composite]);
    expect(skipped).toEqual([{ kind: 'setField', nodePath: `${cellPath}/Body`, reason: 'baked-away' }]);
    expect((frame.userData.realvirtual as { Note: { Text: string } }).Note.Text, 'own child applied').toBe('b');
    expect(slideSpeed(booted), 'existing placed child applied').toBe(240);
    // History: the composite without its baked-away child.
    expect(doc.document.ops).toHaveLength(1);
    const kept = doc.document.ops[0] as { kind: string; id: string; ops: RvOp[] };
    expect(kept.kind).toBe('composite');
    expect(kept.id).toBe(composite.id);
    expect(kept.ops.map((o) => o.id)).toEqual([own.id, slide.id]);
    expect(skippedProblems().map((p) => p.nodePath)).toEqual([`${cellPath}/Body`]);

    // The recompose replay: one op applied (the filtered composite), one placed skip.
    resetProblemsForTests();
    (frame.userData.realvirtual as { Note: { Text: string } }).Note.Text = 'a';
    const r = await replayOntoTreeLocked(doc.document, [composite], 'Machine');
    expect(r.applied).toBe(1);
    expect(r.skipped).toEqual([{ kind: 'setField', nodePath: `${cellPath}/Body`, placed: true, reason: 'baked-away' }]);
    expect((frame.userData.realvirtual as { Note: { Text: string } }).Note.Text).toBe('b');
  });
});

describe('plan-774 review fix E6 — the gate per op, reference prefixes exact', () => {
  it('a draft that renames the reference node\'s parent before an override on its content still gates the override', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const v = booted.h.viewer;
    const result = await loadAuthoringModel(v, 'machine.glb', {
      identity: {}, keepBaked: true, budgetMs: 30, data: await machineBytes(INNER_URL, { under: 'Mount' }),
    });
    expect(result.ok && !result.placementsReady).toBe(true);
    const gate = authoringReplayGate(v, result)!;
    const root = v.currentModelRoot!;
    const mount = findByName(root, 'Mount')!;
    const mountPath = v.registry!.getPathForNode(mount)!;
    const renamedPath = `${mountPath.slice(0, mountPath.lastIndexOf('/') + 1)}Base`;
    seq += 1;
    const rename = {
      id: `op-${seq}`, ts: seq, origin: 'asset', kind: 'renameNode', nodePath: mountPath, name: 'Base', prevName: 'Mount',
    } as unknown as RvOp;
    const override = setField(`${renamedPath}/Cell_1/Slide`, 'Drive', 'TargetSpeed', 260, 200);
    // Classified on the PRE-replay tree the override would not wait: `…/Base` does not exist yet.
    expect(gate.needsWait(override)).toBe(false);

    const doc = scratchAssetDocument(v, 'Machine');
    docs.push(doc);
    await doc.replayOps([rename, override], { gate, waitBudgetMs: 10_000 });
    expect(doc.document.ops.map((o) => o.id), 'the rename applied at once').toEqual([rename.id]);
    expect(doc.document.pendingReplayOps.map((o) => o.id), 'asked after the rename: the override waits').toEqual([override.id]);
    booted.open();
    await doc.document.whenIdle();
    expect(doc.document.ops.map((o) => o.id)).toEqual([rename.id, override.id]);
    expect(slideSpeed(booted)).toBe(260);
    expect(skippedProblems()).toEqual([]);
  });

  it('a path whose prefix only a GUESSING lookup maps onto a reference node is not classified as placed', async () => {
    booted = await bootNestedViewer();
    const v = booted.h.viewer;
    await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: true, data: await machineBytes() });
    const cell = findByName(v.currentModelRoot!, 'Cell_1')!;
    const registry = v.registry!;
    // The fuzzy lookup resolves the bare name to the reference node (suffix stage)…
    expect(registry.getNode('Cell_1')).toBe(cell);
    // …the exact one does not, so an op addressed that way is not placed content.
    expect(registry.getNodeExact('Cell_1')).toBeNull();
    const op = setField('Cell_1/Note', 'Note', 'Text', 'x', '');
    expect(opTargetsPlacedContent(op, registry)).toBe(false);
    // The canonical path still is.
    const placed = setField(`${registry.getPathForNode(cell)}/Slide`, 'Drive', 'TargetSpeed', 1, 200);
    expect(opTargetsPlacedContent(placed, registry)).toBe(true);
    await sleep(0);
  });
});

// ─── Review round 2 ─────────────────────────────────────────────────────────

/** A gate whose wait ends SUPERSEDED (another document took the viewer). */
const supersededGate = () => ({ needsWait: () => true, wait: async () => false });

describe('plan-774 review round 2, R4 — a superseded replay is never "done"', () => {
  it('recomposeProjection: the gate wait ends superseded mid-replay → { status: "superseded" }, the log kept', async () => {
    const d = new TestStackDocument('doc-r4a', 'Machine');
    await d.document.replayOps([makeOpFixture('setField', { id: 'r4-a' }), makeOpFixture('renameNode', { id: 'r4-b' })]);
    d.executor.forward.length = 0;
    const outcome = await recomposeProjection({
      doc: d.document, replay: 'all', reload: async () => ({ replayGate: supersededGate() }),
    });
    expect(outcome).toEqual({ status: 'superseded' });
    expect(d.executor.forward, 'nothing applied after the superseded wait').toEqual([]);
    expect(d.document.ops.map((o) => o.id)).toEqual(['r4-a', 'r4-b']);
    d.dispose();
  });

  it('undoViaRecompose: superseded mid-replay → refusal "superseded"; the undone op stays, nothing moves to redo', async () => {
    const d = new TestStackDocument('doc-r4b', 'Machine');
    await d.document.applyOp(makeOpFixture('setField', { id: 'r4-c' }));
    await d.document.applyOp(makeOpFixture('renameNode', { id: 'r4-d' }));
    const outcome = await undoViaRecompose({ doc: d.document, reload: async () => ({ replayGate: supersededGate() }) });
    expect(outcome).toMatchObject({ ok: false, reason: 'superseded' });
    expect(d.document.ops.map((o) => o.id)).toEqual(['r4-c', 'r4-d']);
    expect(d.document.canRedo()).toBe(false);
    expect(d.document.busy).toBe(false);
    d.dispose();
  });

  it('Back (RvDescendController.back): the parent replay superseded → { status: "superseded" }, never "ok"', async () => {
    const viewer = createStackTestViewer();
    const stack = new RvDocumentStack({ viewer, projectId: 'p' });
    const parent = new TestStackDocument('doc-parent', 'Plant');
    await parent.document.applyOp(makeOpFixture('setField', { id: 'r4-e' }));
    stack.pushRoot({ doc: parent, assetId: 'plant', name: 'Plant' });
    stack.push({
      doc: new TestStackDocument('doc-child', 'Station'), assetId: 'station', name: 'Station',
      referenceNodeId: 'ref-station', isolatedRoots: [], suppressedOverrides: 0,
    });
    const host: RvRecomposeHost = {
      openChild: async () => { throw new Error('unused'); },
      reloadFrame: async () => ({ isolatedRoots: [], replayGate: supersededGate() }),
    };
    const out = await new RvDescendController(stack, host).back();
    expect(out.status).toBe('superseded');
    expect(parent.document.ops.map((o) => o.id)).toEqual(['r4-e']);
  });
});

describe('plan-774 review round 2, R5 — the recompose gate wait is bounded inside the lock', () => {
  it('a placement that never settles: the recompose returns after the budget, placed op kept unapplied + "still loading", own ops applied, lock released', async () => {
    booted = await bootNestedViewer({ gate: INNER_URL });
    const bytes = await machineBytes();
    const v = booted.h.viewer;
    const { doc, framePath, cellPath } = await openNotReady(booted, bytes);
    const own = setField(framePath, 'Note', 'Text', 'b', 'a');
    const placed = setField(`${cellPath}/Slide`, 'Drive', 'TargetSpeed', 285, 200);
    const own2 = setField(framePath, 'Note', 'Text', 'c', 'b');
    // In the history (the placed op kept unapplied: placement not materialised).
    await doc.document.replayOps([own, placed, own2]);
    expect(doc.document.ops.map((o) => o.id)).toEqual([own.id, placed.id, own2.id]);
    resetProblemsForTests();

    const t0 = performance.now();
    const outcome = await recomposeProjection({
      doc: doc.document,
      replay: 'all',
      waitBudgetMs: 80,
      reload: async () => {
        const joined = await loadAuthoringModel(v, 'machine.glb', { identity: {}, keepBaked: true, budgetMs: 30, data: bytes });
        if (!joined.ok) throw new AuthoringLoadSupersededError('machine.glb');
        const root = v.currentModelRoot!;
        const frame = findByName(root, 'Frame')!;
        frame.userData.realvirtual = { ...(frame.userData.realvirtual ?? {}), Note: { Text: 'a' } };
        return { replayGate: authoringReplayGate(v, joined) };
      },
    });
    expect(performance.now() - t0, 'bounded by the budget, not by the placement').toBeLessThan(10_000);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.replay.timedOut).toBe(true);
    expect(outcome.replay.skipped).toEqual([
      { kind: 'setField', nodePath: `${cellPath}/Slide`, placed: true, reason: 'still-loading' },
    ]);
    expect(doc.document.busy, 'the lock is released').toBe(false);
    expect(doc.document.ops.map((o) => o.id), 'the placed op stays in the log').toEqual([own.id, placed.id, own2.id]);
    const frame = findByName(v.currentModelRoot!, 'Frame')!;
    expect((frame.userData.realvirtual as { Note: { Text: string } }).Note.Text, 'own ops applied').toBe('c');
    expect(skippedProblems().map((p) => p.nodePath)).toEqual([`${cellPath}/Slide`]);
    expect(skippedProblems()[0]!.title).toContain('still loading');
    // The document is usable at once.
    await doc.setFieldAwaited(framePath, 'Note', 'Text', 'd', 'c');
    expect(doc.document.ops).toHaveLength(4);
    booted.open();
  });
});

describe('plan-774 review round 2, R6 — missing CAD geometry of the PENDING tail is reported', () => {
  it('an importCad op in the tail whose geometry is gone → the SolidCraft problem appears once the tail applied', async () => {
    registerCadProvider('step', null); // PUBLIC build: no retessellate fallback
    await clearCadGlbCache();
    const scene = new Scene();
    const model = new Group();
    model.name = 'Asset';
    scene.add(model);
    const registry = new NodeRegistry();
    registry.registerNode(NodeRegistry.computeNodePath(model), model);
    const viewer = {
      scene, registry, signalStore: null, transportManager: null,
      get currentModelRoot() { return model; },
      markRenderDirty() {}, markShadowsDirty() {}, emit() {}, rebuildGroupedBvh() {},
    } as unknown as RVViewer;

    const cadRoot = new Group();
    cadRoot.name = 'Gearbox';
    cadRoot.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    const glb = await objectToGlb(cadRoot);
    const cadlink = { File: 'gearbox.step', Sha256: 'cafe-r6', Quality: 'standard', ImportScaleFactor: 0.001, ZIsUpVector: true, Converter: 'solidcraft' } as const;
    const source = scratchAssetDocument(viewer);
    await source.importCad({ glb, cadlink });
    await source.whenIdle();
    const ops = source.toDraft().ops;
    source.dispose();
    model.clear();
    await clearCadGlbCache();

    // The tail waits for "placed content" (a manual gate) — then applies.
    let release!: (v: boolean) => void;
    const settled = new Promise<boolean>((r) => { release = r; });
    const gate = { needsWait: () => true, wait: () => settled };
    const doc = scratchAssetDocument(viewer);
    docs.push(doc);
    await doc.replayOps(ops, { gate, waitBudgetMs: 10_000 });
    expect(doc.hasPendingReplay).toBe(true);
    reportDraftReplayAftermath(doc);
    reportAfterPendingReplay(doc);
    const scProblems = () => getProblems().filter((p) => p.code === 'solidcraft-geometry-missing');
    expect(scProblems(), 'nothing applied yet, nothing to report').toEqual([]);

    release(true);
    await doc.document.whenIdle();
    for (let i = 0; i < 50 && scProblems().length === 0; i++) await sleep(10);
    expect(doc.hasPendingReplay).toBe(false);
    expect(scProblems()).toHaveLength(1);
    expect(scProblems()[0]!.title).toContain('gearbox.step');
  });
});

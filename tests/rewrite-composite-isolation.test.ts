// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-610 Phase 2 (9.3b) — the executor's deferred, scope-correct reference
 * re-binding, ISOLATED to the reference-rewrite composites (and, inside a
 * flattened transaction entry, to exactly their op RANGES).
 *
 *  1. Characterization (unmarked composites, today's behaviour) + pinning of
 *     `Drive.Offset` + `transformNode` — must never change.
 *  2. Marked composites (taken over from the spike `8edaa08a`, 16/16 there):
 *     forward / undo / redo / JSON replay, references in and out of a moved
 *     subtree, rollback, twin subtrees, foreign referrers in a placed asset.
 *  3. Flatten ranges: a marked composite folded into a transaction next to
 *     unmarked `Drive.Offset` + `transformNode` keeps the end pose.
 *  4. Flush failures: collected per referrer, the rest still bound, the action
 *     rolled back / the undo re-applied.
 *  5. Foreign referrers with a ROOT-INCLUSIVE spelling, a string array and a
 *     working signal consumer (Lamp) on a REAL SignalStore — on the fixture
 *     placement and on the REAL PlacementInstancer / ModelCache chain.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { makeSpikeViewer, op, ref, extrasOf, HOLDER, IDENTITY_T } from './helpers/spike-610-ref-fixture';
import { makeAssetComposite, referenceRewriteRangesOf } from '../src/core/ops/rv-unified-ops';
import type { RvAssetPrimitiveOp } from '../src/core/ops/rv-unified-ops';
import { ReferenceRebindError } from '../src/core/editor/rv-asset-executors';
import { RVLamp } from '../src/core/engine/rv-lamp';
import { applySchema, resolveComponentRefs } from '../src/core/engine/rv-component-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { referenceNode, findByName } from './helpers/nested-placement-fixture';
import '../src/core/engine/rv-transport-surface';

const DRIVE_T = 'realvirtual.Drive';
const SIG_T = 'realvirtual.PLCOutputBool';
const MARK = { referenceRewrite: true as const };

type Doc = ReturnType<typeof scratchAssetDocument>;
const rebindInfo = (doc: Doc) =>
  (doc.executor as unknown as { lastRefRebind: { deferred: number; foreign: number; stalePaths: number; failed: number } | null }).lastRefRebind;

/** Rename + rewritten referrer, the composite shape plan-610 produces. */
function renameWithRewrite(): RvAssetPrimitiveOp[] {
  return [
    op({ kind: 'renameNode', nodePath: 'Asset/Axis', name: 'AxisB', prevName: 'Axis' }),
    op({
      kind: 'setField', nodePath: 'Asset/Belt', componentType: 'TransportSurface',
      fieldName: 'DriveReference', value: ref('AxisB', DRIVE_T), prev: ref('Axis', DRIVE_T),
    }),
  ];
}

function beltFixture() {
  const f = makeSpikeViewer();
  const axis = f.add(f.model, 'Axis');
  const belt = f.add(f.model, 'Belt');
  const slide = f.add(f.model, 'Slide');
  slide.position.set(0.1, 0.2, 0.3);
  f.register();
  const drive = f.drive(axis);
  const slideDrive = f.drive(slide);
  const surface = f.component(belt, 'TransportSurface', { DriveReference: ref('Axis', DRIVE_T) });
  return { ...f, axis, belt, slide, drive, slideDrive, surface };
}

const MOVED = {
  position: [1, 2, 3] as [number, number, number],
  quaternion: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};
const PREV = {
  position: [0.1, 0.2, 0.3] as [number, number, number],
  quaternion: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};
const offsetOp = () => op({
  kind: 'setField', nodePath: 'Asset/Slide', componentType: 'Drive', fieldName: 'Offset', value: 100, prev: undefined,
});
const moveSlideOp = () => op({ kind: 'transformNode', nodePath: 'Asset/Slide', transform: MOVED, prev: PREV });

const pos = (n: { position: { toArray(): number[] } }) => n.position.toArray().map((v) => Math.round(v * 1e6) / 1e6);

// Observed on origin/main 856d4ddd before the executor change (spike, first
// run). A deferred Offset reapply would put afterApply at [1.1, 2, 3].
const PINNED = {
  afterApply: [1, 2, 3],
  afterUndo: [0.1, 0.2, 0.3],
  afterRedo: [1, 2, 3],
  afterReplay: [1, 2, 3],
};

// ─── 1. Characterization + pinning (UNMARKED) ─────────────────────────────

describe('plan-610 characterization — unmarked composites keep today\'s behaviour', () => {
  it('UNMARKED rename+setField composite: undo leaves the referrer holding null (the bug the marker fixes)', async () => {
    const f = beltFixture();
    expect(f.surface.DriveReference).toBe(f.drive);
    const doc = scratchAssetDocument(f.viewer);
    await doc.applyOp(makeAssetComposite('Rename', renameWithRewrite()) as never);
    expect(f.registry.getNode('Asset/AxisB')).toBe(f.axis);
    expect(f.surface.DriveReference).toBe(f.drive);
    await doc.undo();
    expect(f.axis.name).toBe('Axis');
    expect(f.surface.DriveReference).toBeNull();
    doc.dispose();
  });

  it('pinning: unmarked withTransaction(Drive.Offset + transformNode) — apply, undo, redo, draft replay', async () => {
    const f = beltFixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.withTransaction('Offset+Move', async () => {
      await doc.applyOp(offsetOp() as never);
      await doc.applyOp(moveSlideOp() as never);
    });
    const afterApply = pos(f.slide);
    await doc.undo();
    const afterUndo = pos(f.slide);
    await doc.redo();
    const afterRedo = pos(f.slide);
    const g = beltFixture();
    const doc2 = scratchAssetDocument(g.viewer);
    await doc2.replayOps(JSON.parse(JSON.stringify(doc.ops)));
    const afterReplay = pos(g.slide);
    expect({ afterApply, afterUndo, afterRedo, afterReplay }).toEqual(PINNED);
    expect(f.slideDrive.Offset).toBe(100);
    expect(referenceRewriteRangesOf(doc.ops[0] as never)).toEqual([]);
    doc.dispose();
    doc2.dispose();
  });
});

// ─── 2. Marked composites ────────────────────────────────────────────────

describe('plan-610 marked composite — rename → undo → redo keeps the referrer on the SAME instance', () => {
  it('identity across forward, undo, redo', async () => {
    const f = beltFixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.applyOp(makeAssetComposite('Rename', renameWithRewrite(), MARK) as never);
    expect(f.surface.DriveReference).toBe(f.drive);
    expect(rebindInfo(doc)).toMatchObject({ deferred: 1, foreign: 0, failed: 0 });
    await doc.undo();
    expect(f.axis.name).toBe('Axis');
    expect(f.surface.DriveReference).toBe(f.drive);
    expect(extrasOf(f.belt, 'TransportSurface').DriveReference).toEqual(ref('Axis', DRIVE_T));
    await doc.redo();
    expect(f.axis.name).toBe('AxisB');
    expect(f.surface.DriveReference).toBe(f.drive);
    doc.dispose();
  });

  it('the marker survives JSON + draft replay onto a fresh base, and undo after the replay', async () => {
    const f = beltFixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.applyOp(makeAssetComposite('Rename', renameWithRewrite(), MARK) as never);
    const log = JSON.parse(JSON.stringify(doc.ops));
    expect(log[0].meta).toEqual({ referenceRewrite: true });
    const g = beltFixture();
    const doc2 = scratchAssetDocument(g.viewer);
    await doc2.replayOps(log);
    expect(g.surface.DriveReference).toBe(g.drive);
    await doc2.undo();
    expect(g.axis.name).toBe('Axis');
    expect(g.surface.DriveReference).toBe(g.drive);
    doc.dispose();
    doc2.dispose();
  });

  it('folded into a transaction the entry keeps the RANGE of the rewrite group, not a top-level marker', async () => {
    const f = beltFixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.withTransaction('Outer', async () => {
      await doc.applyOp(makeAssetComposite('Rename', renameWithRewrite(), MARK) as never);
      await doc.applyOp(op({
        kind: 'setField', nodePath: 'Asset/Belt', componentType: 'TransportSurface', fieldName: 'Speed', value: 5, prev: undefined,
      }) as never);
    });
    expect(doc.ops).toHaveLength(1);
    const entry = JSON.parse(JSON.stringify(doc.ops[0]));
    expect(entry.meta).toEqual({ referenceRewriteRanges: [[0, 2]] });
    expect(referenceRewriteRangesOf(entry)).toEqual([[0, 2]]);
    await doc.undo();
    expect(f.surface.DriveReference).toBe(f.drive);
    await doc.redo();
    expect(f.surface.DriveReference).toBe(f.drive);
    doc.dispose();
  });

  it('malformed persisted ranges are dropped, never trusted', () => {
    const c = makeAssetComposite('X', renameWithRewrite(), { referenceRewriteRanges: [[1, 9], [-1, 1], [0, 0]] as never });
    expect(referenceRewriteRangesOf(c)).toEqual([]);
    const ok = makeAssetComposite('Y', renameWithRewrite(), { referenceRewriteRanges: [[0, 1], [1, 2]] });
    expect(referenceRewriteRangesOf(ok)).toEqual([[0, 1], [1, 2]]);
  });
});

describe('plan-610 marked reparent — referrer inside the moved subtree, references in and out', () => {
  function cellFixture() {
    const f = makeSpikeViewer();
    const cell = f.add(f.model, 'Cell');
    const axis = f.add(cell, 'Axis');
    const s2 = f.add(cell, 'S2');
    const inner = f.add(cell, 'R');
    const signals = f.add(f.model, 'Signals');
    const s1 = f.add(signals, 'S1');
    const outside = f.add(f.model, 'Outside');
    f.add(f.model, 'Group');
    f.register();
    f.signal(s1, 'S1');
    f.signal(s2, 'S2');
    const drive = f.drive(axis);
    const r = f.component(inner, HOLDER, { DriveA: ref('Cell/Axis', DRIVE_T), Sig: ref('Signals/S1', SIG_T) });
    const o = f.component(outside, HOLDER, { DriveA: ref('Cell/Axis', DRIVE_T), Sig: ref('Cell/S2', SIG_T) });
    return { ...f, cell, axis, drive, r, o };
  }

  const moveOps = (): RvAssetPrimitiveOp[] => [
    op({
      kind: 'reparentNode', nodePath: 'Asset/Cell', newParentPath: 'Asset/Group',
      transform: IDENTITY_T, prevParentPath: 'Asset', prevIndex: 0, prevTransform: IDENTITY_T,
    }),
    op({ kind: 'setField', nodePath: 'Asset/Group/Cell/R', componentType: HOLDER, fieldName: 'DriveA',
      value: ref('Group/Cell/Axis', DRIVE_T), prev: ref('Cell/Axis', DRIVE_T) }),
    op({ kind: 'setField', nodePath: 'Asset/Outside', componentType: HOLDER, fieldName: 'DriveA',
      value: ref('Group/Cell/Axis', DRIVE_T), prev: ref('Cell/Axis', DRIVE_T) }),
    op({ kind: 'setField', nodePath: 'Asset/Outside', componentType: HOLDER, fieldName: 'Sig',
      value: ref('Group/Cell/S2', SIG_T), prev: ref('Cell/S2', SIG_T) }),
  ];

  it('forward, undo, redo', async () => {
    const f = cellFixture();
    expect(f.o.Sig).toBe('Asset/Cell/S2');
    const doc = scratchAssetDocument(f.viewer);
    await doc.applyOp(makeAssetComposite('Move', moveOps(), MARK) as never);
    expect(f.cell.parent?.name).toBe('Group');
    expect(f.r.DriveA).toBe(f.drive);
    expect(f.r.Sig).toBe('Asset/Signals/S1');
    expect(f.o.DriveA).toBe(f.drive);
    expect(f.o.Sig).toBe('Asset/Group/Cell/S2');
    await doc.undo();
    expect(f.cell.parent?.name).toBe('Asset');
    expect(f.r.DriveA).toBe(f.drive);
    expect(f.o.Sig).toBe('Asset/Cell/S2');
    await doc.redo();
    expect(f.o.Sig).toBe('Asset/Group/Cell/S2');
    expect(f.r.DriveA).toBe(f.drive);
    expect(f.o.DriveA).toBe(f.drive);
    doc.dispose();
  });
});

describe('plan-610 marked composite — failure in the middle rolls back with references intact', () => {
  const failingOps = (): RvAssetPrimitiveOp[] => [
    ...renameWithRewrite(),
    op({
      kind: 'reparentNode', nodePath: 'Asset/DoesNotExist', newParentPath: 'Asset',
      transform: IDENTITY_T, prevParentPath: 'Asset', prevIndex: 0, prevTransform: IDENTITY_T,
    }),
  ];

  it('MARKED: rejects, nothing recorded, referrer still on the same drive', async () => {
    const f = beltFixture();
    const doc = scratchAssetDocument(f.viewer);
    await expect(doc.applyOp(makeAssetComposite('Fail', failingOps(), MARK) as never)).rejects.toThrow(/not found/);
    expect(doc.ops).toHaveLength(0);
    expect(f.axis.name).toBe('Axis');
    expect(f.registry.getNode('Asset/Axis')).toBe(f.axis);
    expect(f.surface.DriveReference).toBe(f.drive);
    expect(extrasOf(f.belt, 'TransportSurface').DriveReference).toEqual(ref('Axis', DRIVE_T));
    doc.dispose();
  });

  it('UNMARKED (contrast): the same rollback leaves the referrer on null', async () => {
    const f = beltFixture();
    const doc = scratchAssetDocument(f.viewer);
    await expect(doc.applyOp(makeAssetComposite('Fail', failingOps()) as never)).rejects.toThrow(/not found/);
    expect(f.axis.name).toBe('Axis');
    expect(f.surface.DriveReference).toBeNull();
    doc.dispose();
  });

  it('transaction abort (document rollback) after a marked composite applied', async () => {
    const f = beltFixture();
    const doc = scratchAssetDocument(f.viewer);
    await expect(doc.withTransaction('Abort', async () => {
      await doc.applyOp(makeAssetComposite('Rename', renameWithRewrite(), MARK) as never);
      throw new Error('user abort');
    })).rejects.toThrow('user abort');
    expect(f.axis.name).toBe('Axis');
    expect(f.surface.DriveReference).toBe(f.drive);
    doc.dispose();
  });
});

describe('plan-610 two identical scoped subtrees, several reference fields on one component', () => {
  function twinFixture() {
    const f = makeSpikeViewer();
    const build = (name: string) => {
      const m = f.add(f.model, name);
      return { m, a: f.add(m, 'Axis'), b: f.add(m, 'Axis2'), r: f.add(m, 'R') };
    };
    const m1 = build('M1');
    const m2 = build('M2');
    f.register();
    f.registry.registerScopeNames(m1.m, ['M']);
    f.registry.registerScopeNames(m2.m, ['M']);
    const d1a = f.drive(m1.a); const d1b = f.drive(m1.b);
    const d2a = f.drive(m2.a); const d2b = f.drive(m2.b);
    const extras = {
      DriveA: ref('Axis', DRIVE_T), DriveB: ref('Axis2', DRIVE_T), Tools: [ref('Axis2', DRIVE_T), ref('Axis', DRIVE_T)],
    };
    const r1 = f.component(m1.r, HOLDER, extras);
    const r2 = f.component(m2.r, HOLDER, extras);
    return { ...f, m1, m2, d1a, d1b, d2a, d2b, r1, r2 };
  }

  const ops = () => [
    op({ kind: 'renameNode', nodePath: 'Asset/M2/Axis', name: 'AxisX', prevName: 'Axis' }),
    op({ kind: 'setField', nodePath: 'Asset/M2/R', componentType: HOLDER, fieldName: 'DriveA',
      value: ref('AxisX', DRIVE_T), prev: ref('Axis', DRIVE_T) }),
    op({ kind: 'setField', nodePath: 'Asset/M2/R', componentType: HOLDER, fieldName: 'Tools',
      value: [ref('Axis2', DRIVE_T), ref('AxisX', DRIVE_T)], prev: [ref('Axis2', DRIVE_T), ref('Axis', DRIVE_T)] }),
  ];

  const expectM2Bound = (f: ReturnType<typeof twinFixture>) => {
    expect(f.r2.DriveA).toBe(f.d2a);
    expect(f.r2.DriveB).toBe(f.d2b);
    expect(f.r2.Tools).toEqual([f.d2b, f.d2a]);
    expect(f.r1.DriveA).toBe(f.d1a);
    expect(f.r1.DriveB).toBe(f.d1b);
  };

  it('MARKED: rewrite, undo, redo keep every field on the M2 instances', async () => {
    const f = twinFixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.applyOp(makeAssetComposite('Rename', ops(), MARK) as never);
    expectM2Bound(f);
    await doc.undo();
    expectM2Bound(f);
    await doc.redo();
    expectM2Bound(f);
    doc.dispose();
  });

  it('UNMARKED (contrast): the unscoped re-apply loses the UNCHANGED field', async () => {
    const f = twinFixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.applyOp(makeAssetComposite('Rename', ops()) as never);
    expect(f.r2.DriveB).not.toBe(f.d2b);
    doc.dispose();
  });
});

// ─── 3. Flatten ranges: a mixed transaction entry ────────────────────────

describe('plan-610 mixed transaction entry — marked rename + unmarked Drive.Offset + transformNode', () => {
  for (const order of ['rename-first', 'rename-between'] as const) {
    it(`${order}: identical end pose after apply, undo, redo and JSON draft replay`, async () => {
      const run = async (doc: Doc) => doc.withTransaction('Mixed', async () => {
        if (order === 'rename-first') {
          await doc.applyOp(makeAssetComposite('Rename', renameWithRewrite(), MARK) as never);
          await doc.applyOp(offsetOp() as never);
          await doc.applyOp(moveSlideOp() as never);
        } else {
          await doc.applyOp(offsetOp() as never);
          await doc.applyOp(makeAssetComposite('Rename', renameWithRewrite(), MARK) as never);
          await doc.applyOp(moveSlideOp() as never);
        }
      });
      const f = beltFixture();
      const doc = scratchAssetDocument(f.viewer);
      await run(doc);
      const ranges = referenceRewriteRangesOf(doc.ops[0] as never);
      expect(ranges).toEqual(order === 'rename-first' ? [[0, 2]] : [[1, 3]]);
      const afterApply = pos(f.slide);
      expect(f.surface.DriveReference).toBe(f.drive);
      await doc.undo();
      const afterUndo = pos(f.slide);
      expect(f.axis.name).toBe('Axis');
      expect(f.surface.DriveReference).toBe(f.drive);
      await doc.redo();
      const afterRedo = pos(f.slide);
      expect(f.surface.DriveReference).toBe(f.drive);

      const g = beltFixture();
      const doc2 = scratchAssetDocument(g.viewer);
      await doc2.replayOps(JSON.parse(JSON.stringify(doc.ops)));
      const afterReplay = pos(g.slide);
      expect(g.surface.DriveReference).toBe(g.drive);
      expect({ afterApply, afterUndo, afterRedo, afterReplay }).toEqual(PINNED);
      doc.dispose();
      doc2.dispose();
    });
  }
});

// ─── 4. Flush failures ───────────────────────────────────────────────────

describe('plan-610 flush failures are failures of the action', () => {
  /** Two referrers of Axis: A (whose re-apply can be told to throw), then B. */
  function twoReferrers() {
    const f = makeSpikeViewer();
    const axis = f.add(f.model, 'Axis');
    const aNode = f.add(f.model, 'A_Ref');
    const bNode = f.add(f.model, 'B_Ref');
    f.register();
    const drive = f.drive(axis);
    const a = f.component(aNode, HOLDER, { DriveA: ref('Axis', DRIVE_T) });
    const b = f.component(bNode, HOLDER, { DriveA: ref('Axis', DRIVE_T) });
    const state = { armed: false, bSeen: [] as unknown[] };
    a.reapplyConfig = () => { if (state.armed) throw new Error('reapply boom'); };
    b.reapplyConfig = () => { state.bSeen.push(b.DriveA); };
    return { ...f, axis, aNode, bNode, drive, a, b, state };
  }

  it('forward: the next referrer is still bound, then the action is rejected, rolled back, not recorded', async () => {
    const f = twoReferrers();
    const before = JSON.stringify([f.aNode.userData.realvirtual, f.bNode.userData.realvirtual]);
    f.state.armed = true;
    const doc = scratchAssetDocument(f.viewer);
    const err = await doc.renameNodeAwaited('Asset/Axis', 'AxisB').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReferenceRebindError);
    expect((err as ReferenceRebindError).failures.map((x) => x.path)).toContain('Asset/A_Ref');
    // B was re-applied in the failing flush (bound to the drive under its new name) …
    expect(f.state.bSeen[0]).toBe(f.drive);
    // … and the whole action rolled back.
    expect(doc.ops).toHaveLength(0);
    expect(f.axis.name).toBe('Axis');
    expect(JSON.stringify([f.aNode.userData.realvirtual, f.bNode.userData.realvirtual])).toBe(before);
    expect(f.b.DriveA).toBe(f.drive);
    doc.dispose();
  });

  it('inverse (undo): a failing flush re-applies the entry, which stays on the undo stack', async () => {
    const f = twoReferrers();
    const doc = scratchAssetDocument(f.viewer);
    await doc.renameNodeAwaited('Asset/Axis', 'AxisB');
    f.state.armed = true;
    await expect(doc.undo()).rejects.toBeInstanceOf(ReferenceRebindError);
    expect(doc.ops).toHaveLength(1);
    expect(doc.document.historyHead()).toMatchObject({ undoLen: 1, redoLen: 0 });
    expect(f.axis.name).toBe('AxisB');
    expect(extrasOf(f.bNode, HOLDER).DriveA).toEqual(ref('AxisB', DRIVE_T));
    expect(f.b.DriveA).toBe(f.drive);
    f.state.armed = false;
    await doc.undo();
    expect(f.axis.name).toBe('Axis');
    expect(f.b.DriveA).toBe(f.drive);
    doc.dispose();
  });

  it('inverse (undo): a STRUCTURAL failure inside a marked composite re-applies it; references stay bound', async () => {
    const f = twoReferrers();
    const doc = scratchAssetDocument(f.viewer);
    await doc.renameNodeAwaited('Asset/Axis', 'AxisB');
    const exec = doc.executor as unknown as { _rename: (...a: unknown[]) => void };
    const orig = exec._rename;
    let first = true;
    exec._rename = function (this: unknown, ...a: unknown[]) {
      if (first) { first = false; throw new Error('rename undo boom'); }
      return orig.apply(this, a);
    };
    await expect(doc.undo()).rejects.toThrow(/rename undo boom/);
    exec._rename = orig;
    expect(doc.ops).toHaveLength(1);
    expect(f.axis.name).toBe('AxisB');
    expect(extrasOf(f.aNode, HOLDER).DriveA).toEqual(ref('AxisB', DRIVE_T));
    expect(f.a.DriveA).toBe(f.drive);
    expect(f.b.DriveA).toBe(f.drive);
    await doc.undo();
    expect(f.axis.name).toBe('Axis');
    expect(f.a.DriveA).toBe(f.drive);
    doc.dispose();
  });
});

// ─── 5. Foreign referrers on a REAL SignalStore ──────────────────────────

describe('plan-610 foreign referrers in a placed asset — real SignalStore, Lamp consumer, root-inclusive refs', () => {
  function placedLampFixture() {
    const f = makeSpikeViewer({ signals: true });
    const layout = f.add(f.model, 'Layout');
    f.add(f.model, 'Hall');
    const placement = f.add(layout, 'Machine_1');
    placement.userData.realvirtual = { AssetReference: { assetId: 'machine', path: 'library/Machine.glb' } };
    const signals = f.add(placement, 'Signals');
    const on = f.signalNode(signals, 'On', 'P610.On');
    const go = f.signalNode(signals, 'Go', 'P610.Go');
    const lampNode = f.add(placement, 'Lamp');
    const holderNode = f.add(placement, 'Holder');
    f.register();
    // What the PlacementInstancer leaves behind: the placement root is a scope
    // known by its authored name too.
    f.registry.registerScopeNames(placement, ['Machine']);
    // A Lamp built like the loader builds it, with a ROOT-INCLUSIVE reference.
    const lampExtras = { SignalLampOn: ref('Machine/Signals/On', SIG_T) };
    lampNode.userData.realvirtual = { Lamp: lampExtras };
    const lamp = new RVLamp(lampNode);
    applySchema(lamp as unknown as Record<string, unknown>, RVLamp.schema, lampExtras);
    resolveComponentRefs(lamp as unknown as Record<string, unknown>, f.registry, lampNode);
    f.registry.register('Lamp', NodeRegistry.computeNodePath(lampNode), lamp);
    lamp.init({ registry: f.registry, signalStore: f.store } as never);
    // A string-array consumer mixing both spellings, plus a relative scalar.
    const holder = f.component(holderNode, HOLDER, {
      Sig: ref('Signals/Go', SIG_T),
      Tools: [ref('Machine/Signals/On', SIG_T), ref('Signals/Go', SIG_T)],
    });
    return { ...f, layout, placement, on, go, lampNode, holderNode, lamp, holder };
  }

  const expectBoundUnder = (f: ReturnType<typeof placedLampFixture>, prefix: string) => {
    const on = `${prefix}/Machine_1/Signals/On`;
    const go = `${prefix}/Machine_1/Signals/Go`;
    expect(f.lamp.SignalLampOn).toBe(on);
    expect(f.holder.Sig).toBe(go);
    expect(f.holder.Tools).toEqual([on, go]);
    expect(f.store!.getPath('P610.On')).toBe(on);
    // The consumer WORKS: a value written under the signal reaches the lamp.
    f.store!.set('P610.On', true);
    expect(f.lamp.LampOn).toBe(true);
    f.store!.set('P610.On', false);
    expect(f.lamp.LampOn).toBe(false);
    // The stale path delivers nothing any more.
    for (const stale of ['Asset/Layout', 'Asset/Hall/Layout', 'Asset/Plant']) {
      if (stale === prefix) continue;
      expect(f.store!.getByPath(`${stale}/Machine_1/Signals/On`)).toBeUndefined();
    }
    // The placed asset's own extras are never written.
    expect(extrasOf(f.lampNode, 'Lamp').SignalLampOn).toEqual(ref('Machine/Signals/On', SIG_T));
    expect(extrasOf(f.holderNode, HOLDER).Tools).toEqual([ref('Machine/Signals/On', SIG_T), ref('Signals/Go', SIG_T)]);
  };

  it('loader-built state', () => {
    const f = placedLampFixture();
    expectBoundUnder(f, 'Asset/Layout');
  });

  it('rename of a document-owned ancestor: forward, undo, redo', async () => {
    const f = placedLampFixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.renameNodeAwaited('Asset/Layout', 'Plant');
    expect(rebindInfo(doc)).toMatchObject({ failed: 0 });
    expect(rebindInfo(doc)!.foreign).toBeGreaterThanOrEqual(2);
    expectBoundUnder(f, 'Asset/Plant');
    await doc.undo();
    expectBoundUnder(f, 'Asset/Layout');
    await doc.redo();
    expectBoundUnder(f, 'Asset/Plant');
    doc.dispose();
  });

  it('move of a document-owned ancestor: forward, undo, redo', async () => {
    const f = placedLampFixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.reparentNodes(['Asset/Layout'], 'Asset/Hall');
    expectBoundUnder(f, 'Asset/Hall/Layout');
    await doc.undo();
    expectBoundUnder(f, 'Asset/Layout');
    await doc.redo();
    expectBoundUnder(f, 'Asset/Hall/Layout');
    doc.dispose();
  });
});

// ─── 5b. The REAL PlacementInstancer / ModelCache chain ─────────────────

const LAMP_CELL_URL = 'blob:rv-test/p610-lamp-cell.glb';

/** The placed asset: two signals, a Lamp (root-inclusive ref) and a string-array consumer. */
function lampCell(): Group {
  const root = new Group();
  root.name = 'LampCell';
  const signals = new Object3D();
  signals.name = 'Signals';
  const on = new Object3D();
  on.name = 'On';
  on.userData.realvirtual = { PLCOutputBool: { Name: 'P610.Cell.On', Status: { Value: false } } };
  const go = new Object3D();
  go.name = 'Go';
  go.userData.realvirtual = { PLCOutputBool: { Name: 'P610.Cell.Go', Status: { Value: false } } };
  signals.add(on, go);
  root.add(signals);
  const lamp = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial({ color: 0x777777 }));
  lamp.name = 'Lamp';
  lamp.userData.realvirtual = { Lamp: { SignalLampOn: ref('LampCell/Signals/On', SIG_T) } };
  root.add(lamp);
  const holder = new Object3D();
  holder.name = 'Holder';
  holder.userData.realvirtual = {
    [HOLDER]: { Sig: ref('Signals/Go', SIG_T), Tools: [ref('LampCell/Signals/On', SIG_T), ref('Signals/Go', SIG_T)] },
  };
  root.add(holder);
  return root;
}

describe('plan-610 foreign referrers — REAL PlacementInstancer / ModelCache chain', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; });

  it('rename + move of the document-owned group around a placement: consumers follow, extras untouched', async () => {
    h = await createTestViewer('webgl');
    const loader = { loadAsync: async () => ({ scene: lampCell() }) } as unknown as GLTFLoader;
    h.viewer.placements.setModelCache(new ModelCache(loader, {
      uber: () => h!.viewer.placementUberMaterial,
      isWebGPU: () => h!.viewer.isWebGPU,
      pickPort: () => createPickBuildPort({ createWorker: () => null }),
    }));
    h.viewer.setSimulationPaused('p610', true);
    const doc0 = new Group();
    doc0.name = 'Layout';
    const hall = new Object3D();
    hall.name = 'Hall';
    const yard = new Object3D();
    yard.name = 'Yard';
    hall.add(referenceNode('LampCell_1', 'nid-p610-cell', LAMP_CELL_URL, true, [0, 0, 0]));
    doc0.add(hall, yard);
    await h.viewer.loadModel('p610-doc.glb', { data: await objectToGlb(doc0) });
    await h.viewer.whenSceneReady();

    const viewer = h.viewer;
    const reg = viewer.registry!;
    const store = viewer.signalStore!;
    const root = viewer.currentModelRoot!;
    const hallNode = findByName(root, 'Hall')!;
    const onNode = findByName(root, 'On')!;
    const goNode = findByName(root, 'Go')!;
    const lampNode = findByName(root, 'Lamp')!;
    const holderNode = findByName(root, 'Holder')!;
    expect(hallNode).toBeTruthy();
    const lamp = reg.getByPath<RVLamp>('Lamp', reg.getPathForNode(lampNode)!)!;
    const holder = reg.getByPath<Record<string, unknown>>(HOLDER, reg.getPathForNode(holderNode)!)!;
    expect(lamp, 'the placed Lamp is a live component').toBeTruthy();
    expect(holder, 'the placed holder is a live component').toBeTruthy();

    const check = () => {
      const on = reg.getPathForNode(onNode)!;
      const go = reg.getPathForNode(goNode)!;
      expect(lamp.SignalLampOn).toBe(on);
      expect(holder.Sig).toBe(go);
      expect(holder.Tools).toEqual([on, go]);
      store.set('P610.Cell.On', true);
      expect(lamp.LampOn).toBe(true);
      store.set('P610.Cell.On', false);
      expect(lamp.LampOn).toBe(false);
      expect(extrasOf(lampNode, 'Lamp').SignalLampOn).toEqual(ref('LampCell/Signals/On', SIG_T));
      return on;
    };
    const onBefore = check();

    const doc = scratchAssetDocument(viewer);
    const hallPath = reg.getPathForNode(hallNode)!;
    await doc.renameNodeAwaited(hallPath, 'Hall2');
    const onRenamed = check();
    expect(onRenamed).not.toBe(onBefore);
    expect(store.getByPath(onBefore)).toBeUndefined();

    const yardPath = reg.getPathForNode(findByName(root, 'Yard')!)!;
    await doc.reparentNodes([reg.getPathForNode(hallNode)!], yardPath);
    const onMoved = check();
    expect(onMoved).toContain('/Yard/Hall2/');

    await doc.undo();
    expect(check()).toBe(onRenamed);
    await doc.undo();
    expect(check()).toBe(onBefore);
    await doc.redo();
    expect(check()).toBe(onRenamed);
    doc.dispose();
  });
});

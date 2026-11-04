// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-610 Phase 2 (9.2) — reference-safe rename / reparent / batch / drag&drop
 * through the REAL `AssetDocument` → `RvDocument` → `AssetExecutorContext`.
 *
 * Every structural change rewrites the stored paths that point at the node or
 * into its subtree (ComponentReferences anywhere in the extras, the declared
 * path fields, the declared name fields) in the SAME undo step, in their own
 * spelling, and re-binds the live components at the end of the composite —
 * forward, undo, redo, rollback.
 */
import { describe, it, expect } from 'vitest';
import type { Object3D } from 'three';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { makeSpikeViewer, ref, extrasOf, HOLDER } from './helpers/spike-610-ref-fixture';
import { RenameRefusedError } from '../src/core/editor/rv-asset-document';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';
import '../src/core/engine/rv-transport-surface';

const DRIVE_T = 'realvirtual.Drive';
const SIG_T = 'realvirtual.PLCOutputBool';

type Doc = AssetDocument;
const opsOf = (doc: Doc) => JSON.parse(JSON.stringify(doc.ops)) as Array<Record<string, unknown>>;
const snapshotExtras = (nodes: Object3D[]) => JSON.stringify(nodes.map((n) => n.userData.realvirtual ?? null));

// ─── fixtures ─────────────────────────────────────────────────────────────

/**
 * Asset
 *  ├─ Axis   (Drive)
 *  ├─ Axis2  (Drive)
 *  ├─ Belt   TransportSurface.DriveReference → "Axis"            (asset-relative)
 *  └─ Panel  Holder.DriveA → "Asset/Axis"                        (root-prefixed)
 *            Holder.Tools  → ["Axis", "Asset/Axis2"]              (array, both spellings)
 */
function axisFixture() {
  const f = makeSpikeViewer();
  const axis = f.add(f.model, 'Axis');
  const axis2 = f.add(f.model, 'Axis2');
  const belt = f.add(f.model, 'Belt');
  const panel = f.add(f.model, 'Panel');
  f.register();
  const drive = f.drive(axis);
  const drive2 = f.drive(axis2);
  const surface = f.component(belt, 'TransportSurface', { DriveReference: ref('Axis', DRIVE_T) });
  const holder = f.component(panel, HOLDER, {
    DriveA: ref('Asset/Axis', DRIVE_T),
    Tools: [ref('Axis', DRIVE_T), ref('Asset/Axis2', DRIVE_T)],
  });
  return { ...f, axis, axis2, belt, panel, drive, drive2, surface, holder };
}

function expectAxisBound(f: ReturnType<typeof axisFixture>) {
  expect(f.surface.DriveReference).toBe(f.drive);
  expect(f.holder.DriveA).toBe(f.drive);
  expect((f.holder.Tools as unknown[])[0]).toBe(f.drive);
  expect((f.holder.Tools as unknown[])[1]).toBe(f.drive2);
}

/**
 * Asset
 *  ├─ Cell
 *  │   ├─ Axis (Drive)
 *  │   ├─ S2   (signal)
 *  │   └─ R    Holder: DriveA → "Cell/Axis" (moves with it), Sig → "Signals/S1" (stays)
 *  ├─ Signals/S1 (signal)
 *  ├─ Outside   Holder: DriveA → "Cell/Axis", Sig → "Cell/S2"
 *  └─ Group
 */
function cellFixture() {
  const f = makeSpikeViewer();
  const cell = f.add(f.model, 'Cell');
  const axis = f.add(cell, 'Axis');
  const s2 = f.add(cell, 'S2');
  const inner = f.add(cell, 'R');
  const signals = f.add(f.model, 'Signals');
  const s1 = f.add(signals, 'S1');
  const outside = f.add(f.model, 'Outside');
  const group = f.add(f.model, 'Group');
  f.register();
  f.signal(s1, 'S1');
  f.signal(s2, 'S2');
  const drive = f.drive(axis);
  const r = f.component(inner, HOLDER, { DriveA: ref('Cell/Axis', DRIVE_T), Sig: ref('Signals/S1', SIG_T) });
  const o = f.component(outside, HOLDER, { DriveA: ref('Cell/Axis', DRIVE_T), Sig: ref('Cell/S2', SIG_T) });
  return { ...f, cell, axis, inner, outside, group, drive, r, o };
}

// ─── rename ───────────────────────────────────────────────────────────────

describe('plan-610 rename — references rewritten in their spelling, one undo step', () => {
  it('rewrites scalar, array and both spellings; re-binds; getReferencesTo sees every referrer', async () => {
    const f = axisFixture();
    const doc = scratchAssetDocument(f.viewer);

    const result = await doc.renameNodeAwaited('Asset/Axis', 'AxisB');

    expect(result).toMatchObject({ path: 'Asset/AxisB', referencesRewritten: 3, nameFieldsRewritten: 0 });
    expect(result.warnings).toEqual([]);
    expect(f.axis.name).toBe('AxisB');
    expect(extrasOf(f.belt, 'TransportSurface').DriveReference).toEqual(ref('AxisB', DRIVE_T));
    expect(extrasOf(f.panel, HOLDER).DriveA).toEqual(ref('Asset/AxisB', DRIVE_T));
    expect(extrasOf(f.panel, HOLDER).Tools).toEqual([ref('AxisB', DRIVE_T), ref('Asset/Axis2', DRIVE_T)]);
    expectAxisBound(f);

    // ONE marked composite: the rename and its setField steps.
    const log = opsOf(doc);
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe('composite');
    expect(log[0].meta).toEqual({ referenceRewrite: true });
    expect((log[0].ops as Array<{ kind: string }>).map((o) => o.kind))
      .toEqual(['renameNode', 'setField', 'setField', 'setField']);

    // "referenced by": canonical target, both spellings, the array element with its index.
    const refs = f.registry.getReferencesTo('Asset/AxisB');
    expect(refs).toEqual(expect.arrayContaining([
      { sourcePath: 'Asset/Belt', fieldName: 'DriveReference', componentType: 'TransportSurface' },
      { sourcePath: 'Asset/Panel', fieldName: 'DriveA', componentType: HOLDER },
      { sourcePath: 'Asset/Panel', fieldName: 'Tools', componentType: HOLDER, index: 0 },
    ]));
    expect(refs).toHaveLength(3);
    expect(f.registry.getReferencesTo('Asset/Axis2')).toEqual([
      { sourcePath: 'Asset/Panel', fieldName: 'Tools', componentType: HOLDER, index: 1 },
    ]);
    doc.dispose();
  });

  it('rename → undo (no reload) keeps the SAME drive instances; extras byte-identical; redo again', async () => {
    const f = axisFixture();
    const before = snapshotExtras([f.belt, f.panel]);
    const doc = scratchAssetDocument(f.viewer);
    await doc.renameNodeAwaited('Asset/Axis', 'AxisB');

    await doc.undo();
    expect(f.axis.name).toBe('Axis');
    expect(f.registry.getNode('Asset/Axis')).toBe(f.axis);
    expect(snapshotExtras([f.belt, f.panel])).toBe(before);
    expectAxisBound(f);
    expect(f.registry.getReferencesTo('Asset/Axis')).toHaveLength(3);

    await doc.redo();
    expect(f.axis.name).toBe('AxisB');
    expect(extrasOf(f.belt, 'TransportSurface').DriveReference).toEqual(ref('AxisB', DRIVE_T));
    expectAxisBound(f);
    doc.dispose();
  });

  it('a rename without any referrer stays a plain renameNode op (unchanged shape)', async () => {
    const f = axisFixture();
    const lonely = f.add(f.model, 'Lonely');
    f.registry.registerNode('Asset/Lonely', lonely);
    const doc = scratchAssetDocument(f.viewer);
    const result = await doc.renameNodeAwaited('Asset/Lonely', 'Lonely2');
    expect(result).toEqual({ path: 'Asset/Lonely2', referencesRewritten: 0, nameFieldsRewritten: 0, warnings: [] });
    const log = opsOf(doc);
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe('renameNode');
    doc.dispose();
  });

  it('refuses a name containing "/", an empty name and the model root — nothing mutated', async () => {
    const f = axisFixture();
    const doc = scratchAssetDocument(f.viewer);
    await expect(doc.renameNodeAwaited('Asset/Axis', 'A/B')).rejects.toMatchObject({ reason: 'invalid-name' });
    await expect(doc.renameNodeAwaited('Asset/Axis', '   ')).rejects.toMatchObject({ reason: 'empty-name' });
    await expect(doc.renameNodeAwaited('Asset', 'Other')).rejects.toBeInstanceOf(RenameRefusedError);
    await expect(doc.renameNodeAwaited('Asset/Nope', 'X')).rejects.toMatchObject({ reason: 'not-found' });
    expect(f.axis.name).toBe('Axis');
    expect(doc.ops).toHaveLength(0);
    // The void wrapper logs and does nothing.
    doc.renameNode('Asset/Axis', 'A/B', 'Axis');
    await doc.whenIdle();
    expect(f.axis.name).toBe('Axis');
    expect(doc.ops).toHaveLength(0);
    doc.dispose();
  });

  it('renames a subtree root: references INTO the subtree follow (prefix at the segment boundary)', async () => {
    const f = cellFixture();
    // A sibling whose name merely starts with "Cell" must not be touched.
    const cellar = f.add(f.model, 'Cellar');
    f.registry.registerNode('Asset/Cellar', cellar);
    const c2 = f.component(cellar, HOLDER, { DriveA: ref('Cellar', '') });
    expect(c2.DriveA).toBe(cellar);
    const doc = scratchAssetDocument(f.viewer);
    const r = await doc.renameNodeAwaited('Asset/Cell', 'Station');
    expect(r.referencesRewritten).toBe(3); // R.DriveA, Outside.DriveA, Outside.Sig
    expect(extrasOf(f.inner, HOLDER)).toMatchObject({ DriveA: ref('Station/Axis', DRIVE_T), Sig: ref('Signals/S1', SIG_T) });
    expect(extrasOf(f.outside, HOLDER)).toMatchObject({ DriveA: ref('Station/Axis', DRIVE_T), Sig: ref('Station/S2', SIG_T) });
    expect(extrasOf(cellar, HOLDER).DriveA).toEqual(ref('Cellar', ''));
    expect(f.o.Sig).toBe('Asset/Station/S2');
    expect(f.o.DriveA).toBe(f.drive);
    expect(f.r.DriveA).toBe(f.drive);
    doc.dispose();
  });

  it('warns (never refuses) when the new name is used elsewhere in the document — plan-610 Phase 5b', async () => {
    const f = cellFixture();
    const doc = scratchAssetDocument(f.viewer);

    // `Signals` exists on the top level; `Cell/Signals` would load as `Signals_1` after save + reload.
    const r = await doc.renameNodeAwaited('Asset/Cell/R', 'Signals');
    expect(r.path).toBe('Asset/Cell/Signals');
    expect(f.inner.name).toBe('Signals');
    expect(r.warnings.map((w) => w.code)).toEqual(['name-not-unique-in-file']);
    expect(r.warnings[0].nodePath).toBe('Asset/Cell/Signals');
    expect(r.warnings[0].message).toContain('Asset/Signals');

    // Sanitized comparison: `S.2` loads as `S2`, the name of Cell/S2.
    const r2 = await doc.renameNodeAwaited('Asset/Outside', 'S.2');
    expect(r2.warnings.map((w) => w.code)).toContain('name-not-unique-in-file');

    // A file-unique name carries no notice.
    const r3 = await doc.renameNodeAwaited('Asset/Group', 'Group_Unique');
    expect(r3.warnings).toEqual([]);
    doc.dispose();
  });
});

// ─── reparent / batch / drag&drop ────────────────────────────────────────

describe('plan-610 reparent — references in and out of the moved subtree', () => {
  async function expectMovedCell(f: ReturnType<typeof cellFixture>) {
    expect(f.cell.parent).toBe(f.group);
    expect(extrasOf(f.inner, HOLDER)).toMatchObject({ DriveA: ref('Group/Cell/Axis', DRIVE_T), Sig: ref('Signals/S1', SIG_T) });
    expect(extrasOf(f.outside, HOLDER)).toMatchObject({ DriveA: ref('Group/Cell/Axis', DRIVE_T), Sig: ref('Group/Cell/S2', SIG_T) });
    expect(f.r.DriveA).toBe(f.drive);
    expect(f.r.Sig).toBe('Asset/Signals/S1');
    expect(f.o.DriveA).toBe(f.drive);
    expect(f.o.Sig).toBe('Asset/Group/Cell/S2');
  }

  it('reparentNodesDetailed: rewrites, one entry, undo/redo by identity', async () => {
    const f = cellFixture();
    const before = snapshotExtras([f.inner, f.outside]);
    const doc = scratchAssetDocument(f.viewer);
    const res = await doc.reparentNodesDetailed(['Asset/Cell'], 'Asset/Group');
    expect(res.moved).toEqual(['Asset/Group/Cell']);
    expect(res.referencesRewritten).toBe(3);
    await expectMovedCell(f);
    expect(doc.ops).toHaveLength(1);
    expect(f.registry.getReferencesTo('Asset/Group/Cell/S2')).toEqual([
      { sourcePath: 'Asset/Outside', fieldName: 'Sig', componentType: HOLDER },
    ]);

    await doc.undo();
    expect(f.cell.parent).toBe(f.model);
    expect(snapshotExtras([f.inner, f.outside])).toBe(before);
    expect(f.o.Sig).toBe('Asset/Cell/S2');
    expect(f.o.DriveA).toBe(f.drive);
    expect(f.r.DriveA).toBe(f.drive);

    await doc.redo();
    await expectMovedCell(f);
    doc.dispose();
  });

  it('reparentNodes keeps its string[] contract', async () => {
    const f = cellFixture();
    const doc = scratchAssetDocument(f.viewer);
    const moved = await doc.reparentNodes(['Asset/Cell'], 'Asset/Group');
    expect(moved).toEqual(['Asset/Group/Cell']);
    await expectMovedCell(f);
    doc.dispose();
  });

  it('reparentNodesBatch: one composite, references rewritten, undo restores', async () => {
    const f = cellFixture();
    const doc = scratchAssetDocument(f.viewer);
    const res = await doc.reparentNodesBatchDetailed(['Asset/Cell', 'Asset/Outside'], 'Asset/Group');
    expect(res.moved).toEqual(['Asset/Group/Cell', 'Asset/Group/Outside']);
    expect(doc.ops).toHaveLength(1);
    // The referrer moved too: its setField is addressed at its POST-move path.
    const log = opsOf(doc);
    const fields = (log[0].ops as Array<{ kind: string; nodePath: string }>).filter((o) => o.kind === 'setField');
    expect(fields.map((o) => o.nodePath)).toEqual(expect.arrayContaining(['Asset/Group/Outside', 'Asset/Group/Cell/R']));
    expect(extrasOf(f.outside, HOLDER)).toMatchObject({ DriveA: ref('Group/Cell/Axis', DRIVE_T), Sig: ref('Group/Cell/S2', SIG_T) });
    expect(f.o.Sig).toBe('Asset/Group/Cell/S2');
    expect(f.o.DriveA).toBe(f.drive);
    await doc.undo();
    expect(f.outside.parent).toBe(f.model);
    expect(extrasOf(f.outside, HOLDER).Sig).toEqual(ref('Cell/S2', SIG_T));
    expect(f.o.Sig).toBe('Asset/Cell/S2');
    doc.dispose();
  });

  it('drag & drop path (reparentNodes with an index) is reference-safe too', async () => {
    const f = cellFixture();
    const doc = scratchAssetDocument(f.viewer);
    f.add(f.group, 'First');
    f.registry.registerNode('Asset/Group/First', f.group.children[0]);
    const moved = await doc.reparentNodes(['Asset/Cell'], 'Asset/Group', { index: 0 });
    expect(moved).toEqual(['Asset/Group/Cell']);
    expect(f.group.children[0]).toBe(f.cell);
    await expectMovedCell(f);
    await doc.undo();
    expect(f.model.children.indexOf(f.cell)).toBe(0);
    doc.dispose();
  });

  it('collision auto-rename: references point at the FINAL name, warnings name it', async () => {
    const f = cellFixture();
    const clash = f.add(f.group, 'Cell');
    f.registry.registerNode('Asset/Group/Cell', clash);
    const doc = scratchAssetDocument(f.viewer);
    const res = await doc.reparentNodesDetailed(['Asset/Cell'], 'Asset/Group');
    expect(res.moved).toEqual(['Asset/Group/Cell_1']);
    expect(res.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'auto-renamed', nodePath: 'Asset/Group/Cell_1' }),
    ]));
    expect(extrasOf(f.outside, HOLDER)).toMatchObject({ DriveA: ref('Group/Cell_1/Axis', DRIVE_T), Sig: ref('Group/Cell_1/S2', SIG_T) });
    expect(f.o.Sig).toBe('Asset/Group/Cell_1/S2');
    await doc.undo();
    expect(f.cell.name).toBe('Cell');
    expect(extrasOf(f.outside, HOLDER).Sig).toEqual(ref('Cell/S2', SIG_T));
    doc.dispose();
  });

  it('batch collision auto-rename rewrites onto the final name', async () => {
    const f = cellFixture();
    const clash = f.add(f.group, 'Cell');
    f.registry.registerNode('Asset/Group/Cell', clash);
    const doc = scratchAssetDocument(f.viewer);
    const res = await doc.reparentNodesBatchDetailed(['Asset/Cell'], 'Asset/Group');
    expect(res.moved).toEqual(['Asset/Group/Cell_1']);
    expect(res.warnings.map((w) => w.code)).toContain('auto-renamed');
    expect(extrasOf(f.outside, HOLDER).Sig).toEqual(ref('Group/Cell_1/S2', SIG_T));
    doc.dispose();
  });
});

// ─── failure / rollback ──────────────────────────────────────────────────

describe('plan-610 failed composite — rollback, runtime references intact, document unchanged', () => {
  it('an executor failure in the middle of a batch rolls back everything', async () => {
    const f = cellFixture();
    const before = snapshotExtras([f.inner, f.outside]);
    const doc = scratchAssetDocument(f.viewer);
    const exec = doc.executor as unknown as { _reparent: (...a: unknown[]) => void };
    const orig = exec._reparent;
    let calls = 0;
    exec._reparent = function (this: unknown, ...a: unknown[]) {
      calls++;
      if (calls === 2) throw new Error('boom: second move');
      return orig.apply(this, a);
    };
    await expect(doc.reparentNodesBatchDetailed(['Asset/Cell', 'Asset/Outside'], 'Asset/Group')).rejects.toThrow(/boom/);
    exec._reparent = orig;
    expect(doc.ops).toHaveLength(0);
    expect(f.cell.parent).toBe(f.model);
    expect(f.outside.parent).toBe(f.model);
    expect(snapshotExtras([f.inner, f.outside])).toBe(before);
    expect(f.registry.getNode('Asset/Cell/Axis')).toBe(f.axis);
    expect(f.o.DriveA).toBe(f.drive);
    expect(f.o.Sig).toBe('Asset/Cell/S2');
    expect(f.r.DriveA).toBe(f.drive);
    doc.dispose();
  });
});

// ─── scopes: twin subtrees ───────────────────────────────────────────────

describe('plan-610 twin subtrees with asset-relative references', () => {
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

  const expectBound = (f: ReturnType<typeof twinFixture>) => {
    expect(f.r2.DriveA).toBe(f.d2a);
    expect(f.r2.DriveB).toBe(f.d2b); // the UNCHANGED field keeps its own subtree's instance
    expect(f.r2.Tools).toEqual([f.d2b, f.d2a]);
    expect(f.r1.DriveA).toBe(f.d1a);
    expect(f.r1.DriveB).toBe(f.d1b);
    expect(f.r1.Tools).toEqual([f.d1b, f.d1a]);
  };

  it('only the twin whose target was renamed is rewritten; rewrite, undo, redo keep every instance', async () => {
    const f = twinFixture();
    const doc = scratchAssetDocument(f.viewer);
    const res = await doc.renameNodeAwaited('Asset/M2/Axis', 'AxisX');
    expect(res.referencesRewritten).toBe(2); // R2.DriveA + R2.Tools[1]
    expect(extrasOf(f.m2.r, HOLDER)).toMatchObject({
      DriveA: ref('AxisX', DRIVE_T), DriveB: ref('Axis2', DRIVE_T), Tools: [ref('Axis2', DRIVE_T), ref('AxisX', DRIVE_T)],
    });
    expect(extrasOf(f.m1.r, HOLDER).DriveA).toEqual(ref('Axis', DRIVE_T));
    expectBound(f);
    await doc.undo();
    expect(f.m2.a.name).toBe('Axis');
    expectBound(f);
    await doc.redo();
    expectBound(f);
    doc.dispose();
  });
});

// ─── resolver ────────────────────────────────────────────────────────────

describe('plan-610 resolveWithStage — the reference chain with its stage', () => {
  it('a node WITHOUT the target component is no hit for a typed reference', () => {
    const f = makeSpikeViewer();
    const plain = f.add(f.model, 'Plain');
    const owner = f.add(f.model, 'Owner');
    f.register();
    expect(f.registry.resolveWithStage({ path: 'Plain' }, DRIVE_T, owner)).toBeNull();
    const asNode = f.registry.resolveWithStage({ path: 'Plain' }, '', owner);
    expect(asNode).toMatchObject({ node: plain, stage: 'exact', spelling: 'relative', scopeRootPath: 'Asset' });
  });

  it('spelling and stage are separate: root-prefixed exact, root-prefixed via a space fallback', () => {
    const f = makeSpikeViewer();
    const axis = f.add(f.model, 'My_Axis');
    const owner = f.add(f.model, 'Owner');
    f.register();
    f.drive(axis);
    expect(f.registry.resolveWithStage({ path: 'Asset/My_Axis' }, DRIVE_T, owner))
      .toMatchObject({ node: axis, stage: 'exact', spelling: 'root-prefixed', scopeRootPath: 'Asset' });
    // The internal lookup of the root-stripped spelling hits only by the space rule.
    expect(f.registry.resolveWithStage({ path: 'Asset/My Axis' }, DRIVE_T, owner))
      .toMatchObject({ node: axis, stage: 'space', spelling: 'root-prefixed' });
  });

  it('a stale path found by suffix is a fallback — and a move heals it onto the exact new path', async () => {
    const f = makeSpikeViewer();
    const group = f.add(f.model, 'Group');
    const cell = f.add(group, 'Cell');
    const axis = f.add(cell, 'Axis');
    const holderNode = f.add(f.model, 'Holder');
    f.register();
    const drive = f.drive(axis);
    // Written as if Cell still sat at the root.
    const h = f.component(holderNode, HOLDER, { DriveA: ref('Cell/Axis', DRIVE_T) });
    expect(h.DriveA).toBe(drive);
    expect(f.registry.resolveWithStage({ path: 'Cell/Axis' }, DRIVE_T, holderNode))
      .toMatchObject({ node: axis, stage: 'suffix', scopeRootPath: 'Asset' });
    const doc = scratchAssetDocument(f.viewer);
    await doc.renameNodeAwaited('Asset/Group', 'Hall');
    expect(extrasOf(holderNode, HOLDER).DriveA).toEqual(ref('Hall/Cell/Axis', DRIVE_T));
    expect(h.DriveA).toBe(drive);
    doc.dispose();
  });

  it('resolve() is unchanged: same instances for every reference kind', () => {
    const f = makeSpikeViewer();
    const axis = f.add(f.model, 'Axis');
    const sig = f.add(f.model, 'Sig');
    const plain = f.add(f.model, 'Plain');
    const owner = f.add(f.model, 'Owner');
    f.register();
    const drive = f.drive(axis);
    f.signal(sig, 'Sig');
    expect(f.registry.resolve(ref('Axis', DRIVE_T) as never, owner).drive).toBe(drive);
    expect(f.registry.resolve(ref('Asset/Axis', DRIVE_T) as never, owner).drive).toBe(drive);
    expect(f.registry.resolve(ref('Sig', SIG_T) as never, owner).signalAddress).toBe('Asset/Sig');
    expect(f.registry.resolve(ref('Gone', SIG_T) as never, owner).signalAddress).toBe('Gone');
    expect(f.registry.resolve(ref('Plain', 'UnityEngine.Transform') as never, owner).node).toBe(plain);
    expect(f.registry.resolve(ref('Plain', DRIVE_T) as never, owner).drive).toBeNull();
  });
});

// ─── declared path / name fields ─────────────────────────────────────────

describe('plan-610 declared path and name fields', () => {
  it('Kinematic.Parent and WebPhysicsZone.StaticColliders (string array) follow a rename', async () => {
    const f = makeSpikeViewer();
    const frame = f.add(f.model, 'Frame');
    const wall = f.add(frame, 'Wall');
    const kin = f.add(f.model, 'Kin');
    const zone = f.add(f.model, 'Zone');
    f.register();
    kin.userData.realvirtual = { Kinematic: { Parent: 'Frame/Wall' } };
    zone.userData.realvirtual = { WebPhysicsZone: { StaticColliders: ['Frame/Wall', 'Elsewhere'] } };
    void wall;
    const doc = scratchAssetDocument(f.viewer);
    const res = await doc.renameNodeAwaited('Asset/Frame', 'Rack');
    expect(res.referencesRewritten).toBe(2);
    expect(extrasOf(kin, 'Kinematic').Parent).toBe('Rack/Wall');
    expect(extrasOf(zone, 'WebPhysicsZone').StaticColliders).toEqual(['Rack/Wall', 'Elsewhere']);
    await doc.undo();
    expect(extrasOf(kin, 'Kinematic').Parent).toBe('Frame/Wall');
    expect(extrasOf(zone, 'WebPhysicsZone').StaticColliders).toEqual(['Frame/Wall', 'Elsewhere']);
    doc.dispose();
  });

  it('Source.ThisObjectAsMU follows a rename when unique, warns when ambiguous', async () => {
    const f = makeSpikeViewer();
    const src = f.add(f.model, 'Src');
    const tpl = f.add(src, 'Template');
    const src2 = f.add(f.model, 'Src2');
    f.add(src2, 'Box'); f.add(src2, 'Box');
    f.register();
    src.userData.realvirtual = { Source: { ThisObjectAsMU: 'Template' } };
    src2.userData.realvirtual = { Source: { ThisObjectAsMU: 'Box' } };
    void tpl;
    const doc = scratchAssetDocument(f.viewer);
    const res = await doc.renameNodeAwaited('Asset/Src/Template', 'Part');
    expect(res.nameFieldsRewritten).toBe(1);
    expect(extrasOf(src, 'Source').ThisObjectAsMU).toBe('Part');
    const amb = await doc.renameNodeAwaited('Asset/Src2/Box', 'Crate');
    expect(amb.nameFieldsRewritten).toBe(0);
    expect(amb.warnings.map((w) => w.code)).toContain('name-field-ambiguous');
    expect(extrasOf(src2, 'Source').ThisObjectAsMU).toBe('Box');
    doc.dispose();
  });
});

// ─── replay / foreign content / overrides ────────────────────────────────

describe('plan-610 draft replay, foreign referrers, overrides', () => {
  it('draft replay recomputes nothing: the recorded values land, an unrecorded referrer stays as it is', async () => {
    const f = axisFixture();
    const doc = scratchAssetDocument(f.viewer);
    await doc.renameNodeAwaited('Asset/Axis', 'AxisB');
    const log = JSON.parse(JSON.stringify(doc.ops));

    const g = axisFixture();
    // A referrer the original document never had — a recomputing replay would rewrite it.
    const extra = g.add(g.model, 'Extra');
    g.registry.registerNode('Asset/Extra', extra);
    g.component(extra, HOLDER, { DriveA: ref('Axis', DRIVE_T) });
    const doc2 = scratchAssetDocument(g.viewer);
    await doc2.replayOps(log);
    expect(extrasOf(g.belt, 'TransportSurface').DriveReference).toEqual(ref('AxisB', DRIVE_T));
    expect(extrasOf(g.panel, HOLDER).DriveA).toEqual(ref('Asset/AxisB', DRIVE_T));
    expect(extrasOf(extra, HOLDER).DriveA).toEqual(ref('Axis', DRIVE_T));
    expect(g.surface.DriveReference).toBe(g.drive);
    await doc2.undo();
    expect(g.axis.name).toBe('Axis');
    expect(g.surface.DriveReference).toBe(g.drive);
    doc.dispose();
    doc2.dispose();
  });

  function placementFixture() {
    const f = makeSpikeViewer();
    const layout = f.add(f.model, 'Layout');
    const placement = f.add(layout, 'Machine_1');
    const sig = f.add(placement, 'Sig');
    const consumer = f.add(placement, 'Consumer');
    const panel = f.add(f.model, 'Panel');
    placement.userData.realvirtual = {
      AssetReference: { assetId: 'machine', path: 'library/Machine.glb' },
      // A document-owned override value whose reference points OUT of the asset.
      AssetOverrides: { byPath: { Consumer: { [HOLDER]: { DriveA: ref('Panel', '') } } } },
    };
    f.register();
    f.registry.registerScopeNames(placement, ['Machine']);
    f.signal(sig, 'Sig');
    const c = f.component(consumer, HOLDER, { Sig: ref('Sig', SIG_T) });
    const p = f.component(panel, HOLDER, { Sig: ref('Layout/Machine_1/Sig', SIG_T) });
    return { ...f, layout, placement, consumer, panel, c, p };
  }

  it('a referrer inside a referenced subtree is never rewritten; the document-owned one is', async () => {
    const f = placementFixture();
    const doc = scratchAssetDocument(f.viewer);
    const res = await doc.renameNodeAwaited('Asset/Layout', 'Hall');
    expect(res.referencesRewritten).toBe(1);
    expect(extrasOf(f.panel, HOLDER).Sig).toEqual(ref('Hall/Machine_1/Sig', SIG_T));
    expect(extrasOf(f.consumer, HOLDER).Sig).toEqual(ref('Sig', SIG_T));
    // ...but its live address follows (re-bound, not rewritten).
    expect(f.c.Sig).toBe('Asset/Hall/Machine_1/Sig');
    expect(f.p.Sig).toBe('Asset/Hall/Machine_1/Sig');
    doc.dispose();
  });

  it('a document-owned override value with a reference out of the asset stays unchanged', async () => {
    const f = placementFixture();
    const before = JSON.stringify(f.placement.userData.realvirtual);
    const doc = scratchAssetDocument(f.viewer);
    await doc.renameNodeAwaited('Asset/Panel', 'Board');
    expect(JSON.stringify(f.placement.userData.realvirtual)).toBe(before);
    doc.dispose();
  });
});

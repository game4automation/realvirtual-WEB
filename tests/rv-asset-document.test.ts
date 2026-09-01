// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AssetDocument tests — op application to a live Object3D tree via the asset
 * executors (setField / transform / rename / delete-to-trash), undo/redo,
 * dirty tracking, and the IndexedDB draft round-trip. Uses a minimal mock
 * viewer (real NodeRegistry + three Scene, no renderer).
 */
import { describe, it, expect, beforeEach } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { dedupeSiblingNames } from '../src/core/editor/rv-asset-executors';
import { libraryDocumentBase } from '../src/core/editor/active-asset-store';
import {
  __clearDraftStoresForTests,
  clearDocumentDraft,
  listAllDocumentDrafts,
  listDirtyStack,
  loadDocumentDraft,
  rootFrame,
  type RvDraftFrameKey,
} from '../src/core/ops/rv-document-drafts';

function makeMockViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);

  const box = new Object3D();
  box.name = 'Box';
  box.userData.realvirtual = { Drive: { TargetSpeed: 50 } };
  model.add(box);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  const emitted: Array<{ event: string; data: unknown }> = [];
  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit(event: string, data: unknown) { emitted.push({ event, data }); },
    rebuildGroupedBvh() {},
  } as unknown as RVViewer;

  const boxPath = NodeRegistry.computeNodePath(box);
  return { viewer, scene, model, box, boxPath, registry, emitted };
}

beforeEach(async () => {
  await __clearDraftStoresForTests();
});

describe('AssetDocument ops', () => {
  it('setField writes userData; undo restores prev; redo re-applies', async () => {
    const { viewer, box, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await doc.whenIdle();
    expect((box.userData.realvirtual as any).Drive.TargetSpeed).toBe(200);
    expect(doc.dirty).toBe(true);

    await doc.undo();
    expect((box.userData.realvirtual as any).Drive.TargetSpeed).toBe(50);
    expect(doc.dirty).toBe(false);

    await doc.redo();
    expect((box.userData.realvirtual as any).Drive.TargetSpeed).toBe(200);
    doc.dispose();
  });

  it('transformNode applies TRS and undo restores it', async () => {
    const { viewer, box, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);

    doc.transformNode(
      boxPath,
      { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [2, 2, 2] },
      { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    );
    await doc.whenIdle();
    expect(box.position.toArray()).toEqual([1, 2, 3]);
    expect(box.scale.toArray()).toEqual([2, 2, 2]);

    await doc.undo();
    expect(box.position.toArray()).toEqual([0, 0, 0]);
    expect(box.scale.toArray()).toEqual([1, 1, 1]);
    doc.dispose();
  });

  it('transformNode moves a loader-FROZEN node and its frozen child (matrixWorld follows)', async () => {
    // Editor loads run `freezeStaticMatrices()`: static nodes get
    // matrixWorldAutoUpdate=false, and `updateMatrixWorld(true)` deliberately
    // skips them. Before the fix a transform op landed in the log and the
    // local matrix while the RENDERED pose stayed baked — the Quick-Edit
    // tools "only worked" on a node the gizmo had already unfrozen.
    const { viewer, box, boxPath } = makeMockViewer();
    const child = new Object3D();
    child.name = 'Cap';
    child.position.set(0, 1, 0);
    box.add(child);
    child.updateMatrix();
    box.updateMatrixWorld(true);
    box.matrixWorldAutoUpdate = false;
    child.matrixWorldAutoUpdate = false;

    const doc = scratchAssetDocument(viewer);
    doc.transformNode(
      boxPath,
      { position: [5, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    );
    await doc.whenIdle();

    // The WORLD matrices are what render and pick — both must have followed.
    expect([...box.matrixWorld.elements.slice(12, 15)]).toEqual([5, 0, 0]);
    expect([...child.matrixWorld.elements.slice(12, 15)]).toEqual([5, 1, 0]);
    doc.dispose();
  });

  it('renameNode re-keys the registry; undo restores the old name', async () => {
    const { viewer, box, boxPath, registry } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);

    doc.renameNode(boxPath, 'Crate', 'Box');
    await doc.whenIdle();
    expect(box.name).toBe('Crate');
    const newPath = NodeRegistry.computeNodePath(box);
    expect(registry.getPathForNode(box)).toBe(newPath);

    await doc.undo();
    expect(box.name).toBe('Box');
    expect(registry.getPathForNode(box)).toBe(boxPath);
    doc.dispose();
  });

  it('deleteNode detaches to trash; undo re-attaches at the original index', async () => {
    const { viewer, model, box, boxPath, registry } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);

    doc.deleteNode(boxPath);
    await doc.whenIdle();
    expect(model.children).not.toContain(box);
    expect(registry.getNode(boxPath)).toBeNull();
    // The subtree survives in the hidden trash (undoable, no serialization).
    expect(box.parent?.name).toBe('_rvAssetTrash');
    expect(box.parent?.visible).toBe(false);

    await doc.undo();
    expect(model.children[0]).toBe(box);
    expect(registry.getNode(boxPath)).toBe(box);
    doc.dispose();
  });

  it('setNodeVisible hides the node + stamps rv.Hidden; undo/redo cycle it; no-op when unchanged', async () => {
    const { viewer, box, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);

    // Hiding an already-visible node records an op.
    doc.setNodeVisible(boxPath, false);
    await doc.whenIdle();
    expect(box.visible).toBe(false);
    expect((box.userData.realvirtual as any).Hidden).toBe(true);
    expect(doc.getSnapshot().opCount).toBe(1);
    expect(doc.getSnapshot().undoLabel).toBe('Hide Box');

    await doc.undo();
    expect(box.visible).toBe(true);
    expect((box.userData.realvirtual as any).Hidden).toBeUndefined();
    // The Drive component survives the clone-on-write flag removal.
    expect((box.userData.realvirtual as any).Drive.TargetSpeed).toBe(50);

    await doc.redo();
    expect(box.visible).toBe(false);
    expect((box.userData.realvirtual as any).Hidden).toBe(true);

    // Setting the state it already has records nothing.
    doc.setNodeVisible(boxPath, false);
    await doc.whenIdle();
    expect(doc.getSnapshot().opCount).toBe(1);
    doc.dispose();
  });

  it('setNodeVisible replays hidden state from a draft', async () => {
    const first = makeMockViewer();
    const doc = scratchAssetDocument(first.viewer);
    doc.setNodeVisible(first.boxPath, false);
    await doc.whenIdle();
    const draft = doc.toDraft();
    doc.dispose();

    const second = makeMockViewer();
    const restored = new AssetDocument(second.viewer, { ...draft.shell });
    await restored.replayOps(draft.ops);
    expect(second.box.visible).toBe(false);
    expect((second.box.userData.realvirtual as any).Hidden).toBe(true);
    restored.dispose();
  });

  it('importCad renames duplicate sibling part names so every instance gets its own registry path', async () => {
    const { viewer, model, registry } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);

    // CAD assemblies commonly repeat part names — 3× "Bolt" + a legitimate
    // pre-existing "Bolt_1" that renamed duplicates must not steal.
    const cadRoot = new Group();
    const sub = new Group(); sub.name = 'SubAssy';
    const bolts = [0, 1, 2].map(() => { const b = new Object3D(); b.name = 'Bolt'; return b; });
    const realBolt1 = new Object3D(); realBolt1.name = 'Bolt_1';
    sub.add(bolts[0], bolts[1], realBolt1, bolts[2]);
    cadRoot.add(sub);

    // `opts.root` hands the (normally GLB-parsed) tree straight to the executor.
    // Used here so the assertions below can compare NODE IDENTITY against the
    // exact `bolts[]` objects; the GLB parse is covered by the round-trip test.
    const rootPath = await doc.importCad({
      glb: new ArrayBuffer(0),
      cadlink: { File: 'frame.step', Sha256: 'h1', Quality: 'standard', ImportScaleFactor: 0.001, ZIsUpVector: true },
    }, { root: cadRoot });

    const names = sub.children.map((c) => c.name);
    expect(names).toEqual(['Bolt', 'Bolt_2', 'Bolt_1', 'Bolt_3']);
    // Every instance resolves through the registry as a DISTINCT node.
    const resolved = names.map((n) => registry.getNode(`${rootPath}/SubAssy/${n}`));
    expect(new Set(resolved).size).toBe(4);
    expect(resolved).toEqual([bolts[0], bolts[1], realBolt1, bolts[2]]);
    expect(model.children.map((c) => c.name)).toContain(rootPath.split('/').pop());

    // Idempotent: re-running the dedup (cache replay re-applies it) is a no-op.
    dedupeSiblingNames(cadRoot);
    expect(sub.children.map((c) => c.name)).toEqual(['Bolt', 'Bolt_2', 'Bolt_1', 'Bolt_3']);
    doc.dispose();
  });

  it('structural ops emit editor-structure-changed (forward AND inverse); field ops do not', async () => {
    const { viewer, boxPath, emitted } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);
    const structural = () => emitted.filter((e) => e.event === 'editor-structure-changed').length;

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await doc.whenIdle();
    expect(structural()).toBe(0); // field edits leave the tree unchanged

    doc.deleteNode(boxPath);
    await doc.whenIdle();
    expect(structural()).toBe(1); // forward apply

    await doc.undo();
    expect(structural()).toBe(2); // inverse apply — hierarchy must follow undo too
    doc.dispose();
  });

  it('markSaved re-bases dirty tracking and flushes the trash', async () => {
    const { viewer, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);
    doc.deleteNode(boxPath);
    await doc.whenIdle();
    expect(doc.dirty).toBe(true);

    doc.markSaved(libraryDocumentBase('Custom/Asset.glb'), 'Asset');
    expect(doc.dirty).toBe(false);
    expect(doc.name).toBe('Asset');
    expect(doc.base).toEqual(libraryDocumentBase('Custom/Asset.glb'));
    doc.dispose();
  });

  it('withTransaction folds multiple ops into ONE undo step', async () => {
    const { viewer, box, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);

    await doc.withTransaction('Edit two fields', async () => {
      doc.setField(boxPath, 'Drive', 'TargetSpeed', 300, 50);
      doc.setField(boxPath, 'Drive', 'Acceleration', 9, undefined);
    });
    await doc.whenIdle();
    expect((box.userData.realvirtual as any).Drive.TargetSpeed).toBe(300);
    expect((box.userData.realvirtual as any).Drive.Acceleration).toBe(9);
    expect(doc.getSnapshot().opCount).toBe(1);

    await doc.undo();
    expect((box.userData.realvirtual as any).Drive.TargetSpeed).toBe(50);
    expect((box.userData.realvirtual as any).Drive.Acceleration).toBeUndefined();
    doc.dispose();
  });
});

describe('AssetDocument drafts (IndexedDB)', () => {
  it('draft write/load/clear round-trip preserves shell + ops', async () => {
    const { viewer, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);
    doc.setField(boxPath, 'Drive', 'TargetSpeed', 120, 50);
    await doc.whenIdle();

    await doc.flushDraft();
    const loaded = await loadDocumentDraft(doc.draftFrame);
    expect(loaded).not.toBeNull();
    expect(loaded!.shell.name).toBe('Untitled');
    expect(loaded!.ops).toHaveLength(1);
    expect(loaded!.ops[0].kind).toBe('setField');

    await clearDocumentDraft(doc.draftFrame);
    expect(await loadDocumentDraft(doc.draftFrame)).toBeNull();
    doc.dispose();
  });

  it('replayOps rebuilds the edited state from a draft', async () => {
    const first = makeMockViewer();
    const doc = scratchAssetDocument(first.viewer);
    doc.setField(first.boxPath, 'Drive', 'TargetSpeed', 999, 50);
    await doc.whenIdle();
    const draft = doc.toDraft();
    doc.dispose();

    // Fresh viewer (reload) — replay the draft ops.
    const second = makeMockViewer();
    const restored = new AssetDocument(second.viewer, { ...draft.shell });
    await restored.replayOps(draft.ops);
    expect((second.box.userData.realvirtual as any).Drive.TargetSpeed).toBe(999);
    expect(restored.dirty).toBe(true);
    restored.dispose();
  });
});

/**
 * The per-frame draft keyspace is the ONLY one (plan-710 Phase 2).
 *
 * plan-703 Phase 4 bound a document to a stack frame but left an unbound one on
 * the legacy single slot, so which store received a write depended on whether
 * someone had pushed a frame. That fork is gone: a document with no stack
 * position owns its own ROOT frame, and every write of every document goes
 * through one writer into one keyspace. What is checked here is that split
 * being closed — plus the two properties it existed to protect: sibling frames
 * never overwrite each other, and a clean document leaves nothing behind for
 * recovery to offer back.
 */
describe('AssetDocument draft frame', () => {
  const frameOf = (occurrence: string): RvDraftFrameKey => ({
    projectId: 'proj', rootDocumentId: 'root-doc', occurrence,
  });

  beforeEach(async () => {
    await __clearDraftStoresForTests();
  });

  it('ohne Stack-Frame schreibt das Dokument seinen EIGENEN Root-Frame', async () => {
    const { viewer, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);
    expect(doc.draftFrame).toEqual(rootFrame(null, doc.id));

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 120, 50);
    await doc.whenIdle();
    await doc.flushDraft();

    const all = await listAllDocumentDrafts();
    expect(all).toHaveLength(1);
    expect(all[0].frame).toEqual(rootFrame(null, doc.id));
    doc.dispose();
  });

  it('mit Frame schreibt es genau diesen Slot — und keinen zweiten', async () => {
    const { viewer, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);
    doc.setDraftFrame(frameOf('ref-a/ref-b'));

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 120, 50);
    await doc.whenIdle();
    await doc.flushDraft();

    expect(await listAllDocumentDrafts()).toHaveLength(1);
    const stored = await loadDocumentDraft(frameOf('ref-a/ref-b'));
    expect(stored).not.toBeNull();
    expect(stored!.depth).toBe(2);
    expect(stored!.ops).toHaveLength(1);
    expect(stored!.ops[0].kind).toBe('setField');
    doc.dispose();
  });

  it('zwei Frames schreiben in getrennte Slots — das Kind laesst den Eltern-Draft stehen', async () => {
    const parentEnv = makeMockViewer();
    const parent = scratchAssetDocument(parentEnv.viewer);
    parent.setDraftFrame(frameOf(''));
    parent.setField(parentEnv.boxPath, 'Drive', 'TargetSpeed', 111, 50);
    await parent.whenIdle();
    await parent.flushDraft();

    const childEnv = makeMockViewer();
    const child = scratchAssetDocument(childEnv.viewer);
    child.setDraftFrame(frameOf('ref-child'));
    child.setField(childEnv.boxPath, 'Drive', 'TargetSpeed', 222, 50);
    await child.whenIdle();
    await child.flushDraft();

    const parentDraft = await loadDocumentDraft(frameOf(''));
    const childDraft = await loadDocumentDraft(frameOf('ref-child'));
    expect(parentDraft!.ops[0]).toMatchObject({ kind: 'setField' });
    expect((parentDraft!.ops[0] as { value?: unknown }).value).toBe(111);
    expect((childDraft!.ops[0] as { value?: unknown }).value).toBe(222);

    // Bottom-first recovery order, which is what `planStackRecovery` promises.
    const stack = await listDirtyStack({ projectId: 'proj', rootDocumentId: 'root-doc' });
    expect(stack.map((d) => d.frame.occurrence)).toEqual(['', 'ref-child']);

    parent.dispose();
    child.dispose();
  });

  it('ein sauberes Dokument raeumt seinen Frame-Slot, statt einen Draft zu hinterlassen', async () => {
    const { viewer, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);
    doc.setDraftFrame(frameOf('ref-a'));
    doc.setField(boxPath, 'Drive', 'TargetSpeed', 120, 50);
    await doc.whenIdle();
    await doc.flushDraft();
    expect(await loadDocumentDraft(frameOf('ref-a'))).not.toBeNull();

    await doc.undo();          // back to the baseline — the document is clean
    expect(doc.dirty).toBe(false);
    await doc.flushDraft();

    expect(await loadDocumentDraft(frameOf('ref-a'))).toBeNull();
    doc.dispose();
  });

  it('markSaved raeumt den Frame-Slot — auch fuer eine libraryGlb-Basis', async () => {
    const { viewer, boxPath } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);
    doc.setDraftFrame(frameOf('ref-a'));
    doc.setField(boxPath, 'Drive', 'TargetSpeed', 120, 50);
    await doc.whenIdle();
    await doc.flushDraft();

    await doc.markSaved(libraryDocumentBase('Custom/a.glb'));

    // A library save used to leave a CLEAN record behind so a reload reopened
    // the saved asset. That job belongs to `saveLastEditedAsset`; a draft record
    // for a saved document is only something recovery would offer back as work.
    expect(await loadDocumentDraft(frameOf('ref-a'))).toBeNull();
    expect(await listAllDocumentDrafts()).toHaveLength(0);
    doc.dispose();
  });
});

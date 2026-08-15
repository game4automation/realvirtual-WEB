// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-710 §9.1 — the characterization safety net for the document merge.
 *
 * Feathers' rule, applied literally: this file pins what the two systems DO
 * today, so the merge (Phases 1-5) can be judged against behaviour rather than
 * against intent. Three deliberate design decisions:
 *
 *  1. **Per system, separate promises.** There is no "the two behave the same"
 *     assertion anywhere in here. The systems diverge ON PURPOSE — the scene
 *     lineage has an undo floor and a `hasUnpersistedWork()` that the asset
 *     lineage does not, the asset lineage writes a full TRS where the scene
 *     lineage must never touch `scale`. A shared assertion would pin a fiction
 *     and would have to be deleted the moment the merge made the difference
 *     explicit.
 *
 *  2. **Written in the vocabulary that SURVIVES the merge.** Every op literal
 *     below is an `RvOp`, and every entry point is one the plan keeps
 *     (`RvDocument`, `AssetDocument`, `SceneStore.applyOp`). That is what lets
 *     the file stay byte-identical across Phase 1, where the legacy type names
 *     and the `setNodeTransform` kind are deleted. A test written against the
 *     old names would have to change in the very phase it is supposed to guard.
 *
 *  3. **Deliberately NOT pinned: reading a LEGACY draft.** Phase 2 discards the
 *     `drafts/current` slot by user decision. Pinning today's legacy READ would
 *     manufacture a failure for a change that is the plan's point. What IS
 *     pinned is the WRITE TIMING — 2000 ms, restarted on every edit, nothing
 *     before it — because that timing is the contract `RvDraftAutosave` had to
 *     reproduce.
 *
 *     Phase 2 changed WHERE an unbound document's write lands (its own root
 *     frame, not the shared legacy slot), so the three timing cases below
 *     observe the `frames` keyspace. Their assertions are otherwise untouched:
 *     the point was never which store received it, it was the cadence and the
 *     fact that exactly ONE store did.
 *
 * Renderer-free: real NodeRegistry + real three Scene, fake viewer.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RvDocument } from '../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../src/core/ops/rv-unified-executors';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import {
  __clearDraftStoresForTests,
  loadDocumentDraft,
  rootFrame,
  type RvDraftFrameKey,
} from '../src/core/ops/rv-document-drafts';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene, SceneBase } from '../src/core/hmi/scene/rv-scene-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

let opSeq = 0;
/** Deterministic header. `ts` is explicit so the coalescing window is testable. */
function head(ts = 10_000): { id: string; ts: number; schemaV: 1 } {
  return { id: `op_char_${++opSeq}`, ts, schemaV: 1 };
}

/**
 * A small authored tree with a MIRROR-SCALED node.
 *
 * The mirror node is the whole reason the scene lineage's transform op carries
 * no `scale`: Unity exports IKTarget at `(-1,1,1)`, and a scene-lineage move
 * that wrote an identity scale would silently un-mirror it.
 */
function makeViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);

  const box = new Object3D();
  box.name = 'Box';
  box.userData.realvirtual = { Drive: { TargetSpeed: 50 } };
  model.add(box);

  const mirror = new Object3D();
  mirror.name = 'Mirror';
  mirror.scale.set(-1, 1, 1);
  model.add(mirror);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  scene.updateMatrixWorld(true);

  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    get currentModelUrl() { return undefined; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
    getPlugin: () => undefined,
    createComponentNode(spec: {
      parentPath: string; name: string;
      position: number[]; quaternion: number[]; scale: number[];
    }) {
      const parent = registry.getNode(spec.parentPath) ?? model;
      const node = new Object3D();
      node.name = spec.name;
      node.position.fromArray(spec.position);
      node.quaternion.fromArray(spec.quaternion);
      node.scale.fromArray(spec.scale);
      parent.add(node);
      registry.registerNode(NodeRegistry.computeNodePath(node), node);
    },
    removeComponentNode(path: string) {
      const node = registry.getNode(path);
      if (!node) return;
      registry.unregisterSubtree(node);
      node.removeFromParent();
    },
  } as unknown as RVViewer;

  const boxPath = NodeRegistry.computeNodePath(box);
  const mirrorPath = NodeRegistry.computeNodePath(mirror);
  return { viewer, scene, model, box, mirror, boxPath, mirrorPath, registry };
}

/** A scene-mode document over the real scene executors. */
function sceneDoc(viewer: RVViewer, opts?: { baselineFloor?: number }): RvDocument {
  return new RvDocument({
    id: 'char-scene',
    name: 'Characterization',
    mode: 'scene',
    executor: new RvUnifiedExecutor(viewer, 'scene'),
    baselineFloor: opts?.baselineFloor ?? 0,
  });
}

const rvOf = (n: Object3D) =>
  (n.userData.realvirtual ?? {}) as Record<string, Record<string, unknown>>;

// ─── SYSTEM 1: the SCENE lineage ────────────────────────────────────────

describe('characterization — SCENE lineage (RvDocument in scene mode)', () => {
  describe('golden path + undo/redo roundtrip, per op category', () => {
    it('field edit: forward writes userData, undo restores prev, redo re-applies', async () => {
      const { viewer, box, boxPath } = makeViewer();
      const doc = sceneDoc(viewer);

      await doc.applyOp({
        ...head(), kind: 'setField',
        nodePath: boxPath, componentType: 'Drive', fieldName: 'TargetSpeed',
        value: 200, prev: 50,
      });
      expect(rvOf(box).Drive.TargetSpeed).toBe(200);
      expect(doc.opCount).toBe(1);

      await doc.undo();
      expect(rvOf(box).Drive.TargetSpeed).toBe(50);
      expect(doc.canRedo()).toBe(true);

      await doc.redo();
      expect(rvOf(box).Drive.TargetSpeed).toBe(200);
      doc.dispose();
    });

    it('field reset: unsetField deletes the override, undo puts it back', async () => {
      const { viewer, box, boxPath } = makeViewer();
      const doc = sceneDoc(viewer);

      await doc.applyOp({
        ...head(), kind: 'unsetField',
        nodePath: boxPath, componentType: 'Drive', fieldName: 'TargetSpeed', prev: 50,
      });
      expect(rvOf(box).Drive?.TargetSpeed).toBeUndefined();

      await doc.undo();
      expect(rvOf(box).Drive.TargetSpeed).toBe(50);
      doc.dispose();
    });

    it('node transform WITHOUT scale never writes scale — the mirror survives forward AND undo', async () => {
      const { viewer, mirror, mirrorPath } = makeViewer();
      const doc = sceneDoc(viewer);

      await doc.applyOp({
        ...head(), kind: 'transformNode',
        nodePath: mirrorPath,
        transform: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] },
        prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      });
      expect(mirror.position.toArray()).toEqual([1, 2, 3]);
      expect(mirror.scale.toArray()).toEqual([-1, 1, 1]);

      await doc.undo();
      expect(mirror.position.toArray()).toEqual([0, 0, 0]);
      expect(mirror.scale.toArray()).toEqual([-1, 1, 1]);
      doc.dispose();
    });

    it('structural: addNode creates, undo removes, redo re-creates', async () => {
      const { viewer, model, registry } = makeViewer();
      const doc = sceneDoc(viewer);
      const parentPath = NodeRegistry.computeNodePath(model);

      await doc.applyOp({
        ...head(), kind: 'addNode',
        nodePath: `${parentPath}/Waypoint`,
        spec: {
          parentPath, name: 'Waypoint',
          position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
          components: { IKTarget: {} },
        },
      });
      expect(registry.getNode(`${parentPath}/Waypoint`)).toBeTruthy();

      await doc.undo();
      expect(registry.getNode(`${parentPath}/Waypoint`)).toBeFalsy();

      await doc.redo();
      expect(registry.getNode(`${parentPath}/Waypoint`)).toBeTruthy();
      doc.dispose();
    });

    it('composite: a transaction is ONE undo unit and reverses in child order', async () => {
      const { viewer, box, mirror, boxPath, mirrorPath } = makeViewer();
      const doc = sceneDoc(viewer);

      await doc.withTransaction('Batch', async () => {
        await doc.applyOp({
          ...head(), kind: 'setField',
          nodePath: boxPath, componentType: 'Drive', fieldName: 'TargetSpeed',
          value: 999, prev: 50,
        });
        await doc.applyOp({
          ...head(), kind: 'transformNode',
          nodePath: mirrorPath,
          transform: { position: [5, 0, 0], quaternion: [0, 0, 0, 1] },
          prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
        });
      });

      expect(doc.opCount).toBe(1);
      expect(doc.ops[0].kind).toBe('composite');
      expect(rvOf(box).Drive.TargetSpeed).toBe(999);
      expect(mirror.position.x).toBe(5);

      await doc.undo();
      expect(rvOf(box).Drive.TargetSpeed).toBe(50);
      expect(mirror.position.x).toBe(0);
      expect(mirror.scale.x).toBe(-1);
      doc.dispose();
    });
  });

  describe('coalescing', () => {
    it('two field edits on the same target inside the window collapse to one undo step', async () => {
      const { viewer, box, boxPath } = makeViewer();
      const doc = sceneDoc(viewer);
      const field = (value: number, prev: number, ts: number): RvOp => ({
        ...head(ts), kind: 'setField',
        nodePath: boxPath, componentType: 'Drive', fieldName: 'TargetSpeed', value, prev,
      });

      await doc.applyOp(field(100, 50, 10_000));
      await doc.applyOp(field(150, 100, 10_100));

      expect(doc.opCount).toBe(1);
      expect(rvOf(box).Drive.TargetSpeed).toBe(150);

      // ONE undo reverts to the state before the FIRST op of the run.
      await doc.undo();
      expect(rvOf(box).Drive.TargetSpeed).toBe(50);
      doc.dispose();
    });

    it('a gap beyond the coalescing window keeps two separate undo steps', async () => {
      const { viewer, boxPath } = makeViewer();
      const doc = sceneDoc(viewer);
      const field = (value: number, prev: number, ts: number): RvOp => ({
        ...head(ts), kind: 'setField',
        nodePath: boxPath, componentType: 'Drive', fieldName: 'TargetSpeed', value, prev,
      });

      await doc.applyOp(field(100, 50, 10_000));
      await doc.applyOp(field(150, 100, 20_000));
      expect(doc.opCount).toBe(2);
      doc.dispose();
    });

    it('a different target never coalesces', async () => {
      const { viewer, boxPath, mirrorPath } = makeViewer();
      const doc = sceneDoc(viewer);

      await doc.applyOp({
        ...head(10_000), kind: 'setField',
        nodePath: boxPath, componentType: 'Drive', fieldName: 'TargetSpeed', value: 100, prev: 50,
      });
      await doc.applyOp({
        ...head(10_100), kind: 'setField',
        nodePath: mirrorPath, componentType: 'Drive', fieldName: 'TargetSpeed', value: 100, prev: 50,
      });
      expect(doc.opCount).toBe(2);
      doc.dispose();
    });
  });

  describe('baselineFloor — no undo below the published floor', () => {
    it('undo stops AT the floor, and the ops below it stay in the log', async () => {
      const { viewer, box, boxPath } = makeViewer();
      const doc = sceneDoc(viewer, { baselineFloor: 0 });

      // Two ops, then declare the first one published by re-arming the floor.
      await doc.applyOp({
        ...head(10_000), kind: 'setField',
        nodePath: boxPath, componentType: 'Drive', fieldName: 'TargetSpeed', value: 111, prev: 50,
      });
      doc.markSaved({ floor: 1 });
      await doc.applyOp({
        ...head(30_000), kind: 'setField',
        nodePath: boxPath, componentType: 'Drive', fieldName: 'TargetSpeed', value: 222, prev: 111,
      });

      expect(doc.opCount).toBe(2);
      await doc.undo();
      expect(doc.opCount).toBe(1);
      expect(rvOf(box).Drive.TargetSpeed).toBe(111);

      // The floor is a hard stop: another undo is refused, silently.
      expect(doc.canUndo()).toBe(false);
      await doc.undo();
      expect(doc.opCount).toBe(1);
      expect(rvOf(box).Drive.TargetSpeed).toBe(111);
      doc.dispose();
    });

    it('an op never coalesces INTO a protected baseline op', async () => {
      const { viewer, boxPath } = makeViewer();
      const doc = sceneDoc(viewer);

      await doc.applyOp({
        ...head(10_000), kind: 'setField',
        nodePath: boxPath, componentType: 'Drive', fieldName: 'TargetSpeed', value: 111, prev: 50,
      });
      doc.markSaved({ floor: 1 });
      // Same target, well inside the coalescing window — and still a new entry,
      // because merging would rewrite a `prev` that undo can no longer reach.
      await doc.applyOp({
        ...head(10_050), kind: 'setField',
        nodePath: boxPath, componentType: 'Drive', fieldName: 'TargetSpeed', value: 222, prev: 111,
      });
      expect(doc.opCount).toBe(2);
      doc.dispose();
    });
  });
});

// ─── SYSTEM 2: the ASSET lineage ────────────────────────────────────────

describe('characterization — ASSET lineage (AssetDocument)', () => {
  beforeEach(async () => {
    await __clearDraftStoresForTests();
  });

  describe('golden path + undo/redo roundtrip, per op category', () => {
    it('field edit: forward writes userData, undo restores prev, redo re-applies', async () => {
      const { viewer, box, boxPath } = makeViewer();
      const doc = AssetDocument.newUntitled(viewer);

      doc.setField(boxPath, 'Drive', 'TargetSpeed', 200, 50);
      await doc.whenIdle();
      expect(rvOf(box).Drive.TargetSpeed).toBe(200);
      expect(doc.dirty).toBe(true);

      await doc.undo();
      expect(rvOf(box).Drive.TargetSpeed).toBe(50);
      expect(doc.dirty).toBe(false);

      await doc.redo();
      expect(rvOf(box).Drive.TargetSpeed).toBe(200);
      doc.dispose();
    });

    it('node transform WITH scale writes the full TRS — the asset lineage authors scale', async () => {
      const { viewer, mirror, mirrorPath } = makeViewer();
      const doc = AssetDocument.newUntitled(viewer);

      doc.transformNode(
        mirrorPath,
        { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [2, 2, 2] },
        { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [-1, 1, 1] },
      );
      await doc.whenIdle();
      expect(mirror.position.toArray()).toEqual([1, 2, 3]);
      expect(mirror.scale.toArray()).toEqual([2, 2, 2]);

      await doc.undo();
      expect(mirror.position.toArray()).toEqual([0, 0, 0]);
      expect(mirror.scale.toArray()).toEqual([-1, 1, 1]);
      doc.dispose();
    });

    it('rename: forward renames, undo restores the old name', async () => {
      const { viewer, box, boxPath } = makeViewer();
      const doc = AssetDocument.newUntitled(viewer);

      doc.renameNode(boxPath, 'Crate', 'Box');
      await doc.whenIdle();
      expect(box.name).toBe('Crate');

      await doc.undo();
      expect(box.name).toBe('Box');
      doc.dispose();
    });

    it('structural: deleteNode detaches, undo re-attaches from the trash', async () => {
      const { viewer, box, boxPath, registry } = makeViewer();
      const doc = AssetDocument.newUntitled(viewer);

      doc.deleteNode(boxPath);
      await doc.whenIdle();
      expect(registry.getNode(boxPath)).toBeFalsy();

      await doc.undo();
      expect(registry.getNode(boxPath)).toBe(box);
      doc.dispose();
    });

    it('composite: a transaction is ONE undo unit', async () => {
      const { viewer, box, boxPath } = makeViewer();
      const doc = AssetDocument.newUntitled(viewer);

      await doc.withTransaction('Batch', async () => {
        doc.setField(boxPath, 'Drive', 'TargetSpeed', 900, 50);
        doc.renameNode(boxPath, 'Crate', 'Box');
        await doc.whenIdle();
      });

      expect(doc.getSnapshot().opCount).toBe(1);
      expect(box.name).toBe('Crate');

      await doc.undo();
      expect(box.name).toBe('Box');
      expect(rvOf(box).Drive.TargetSpeed).toBe(50);
      // The whole composite left the log in ONE step and is redoable as one.
      expect(doc.getSnapshot().opCount).toBe(0);
      expect(doc.getSnapshot().canRedo).toBe(true);
      expect(doc.dirty).toBe(false);
      doc.dispose();
    });
  });

  it('coalescing: two field edits on the same target collapse to one undo step', async () => {
    const { viewer, box, boxPath } = makeViewer();
    const doc = AssetDocument.newUntitled(viewer);

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 100, 50);
    doc.setField(boxPath, 'Drive', 'TargetSpeed', 150, 100);
    await doc.whenIdle();

    expect(doc.getSnapshot().opCount).toBe(1);
    expect(rvOf(box).Drive.TargetSpeed).toBe(150);

    await doc.undo();
    expect(rvOf(box).Drive.TargetSpeed).toBe(50);
    doc.dispose();
  });

  it('NO undo floor — the asset lineage undoes all the way to zero', async () => {
    const { viewer, boxPath } = makeViewer();
    const doc = AssetDocument.newUntitled(viewer);

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 111, 50);
    await doc.whenIdle();
    doc.renameNode(boxPath, 'Crate', 'Box');
    await doc.whenIdle();
    expect(doc.getSnapshot().opCount).toBe(2);

    await doc.undo();
    await doc.undo();
    expect(doc.getSnapshot().opCount).toBe(0);
    expect(doc.getSnapshot().canUndo).toBe(false);
    doc.dispose();
  });
});

// ─── The three active draft writers, by timing ──────────────────────────
//
// One spy per KEYSPACE, because that is what the merge redistributes. The
// question each case answers is "which slot received a write, and after how
// long" — not "which function ran".

describe('characterization — autosave timing of the three active writers', () => {
  const frameOf = (occurrence: string): RvDraftFrameKey => ({
    projectId: null, rootDocumentId: 'doc-char', occurrence,
  });

  beforeEach(async () => {
    await __clearDraftStoresForTests();
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('WRITER 1 (an UNBOUND document): writes its OWN root frame after 2000 ms, not before', async () => {
    const { viewer, boxPath } = makeViewer();
    const doc = AssetDocument.newUntitled(viewer);
    // Since Phase 2 an unbound document is not slot-less — it owns a root frame
    // keyed by its own id, which is what retired the shared legacy slot.
    const own = doc.draftFrame;
    expect(own).toEqual(rootFrame(null, doc.id));

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await vi.advanceTimersByTimeAsync(0);
    await doc.whenIdle();

    await vi.advanceTimersByTimeAsync(1999);
    expect(await loadDocumentDraft(own)).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    const written = await loadDocumentDraft(own);
    expect(written).not.toBeNull();
    expect(written!.ops).toHaveLength(1);
    // …and no OTHER frame was touched.
    expect(await loadDocumentDraft(frameOf(''))).toBeNull();
    doc.dispose();
  });

  it('WRITER 2 (a BOUND document): writes the frame it was bound to, and only that one', async () => {
    const { viewer, boxPath } = makeViewer();
    const doc = AssetDocument.newUntitled(viewer);
    const own = doc.draftFrame;
    doc.setDraftFrame(frameOf('ref-a'));

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 200, 50);
    await vi.advanceTimersByTimeAsync(0);
    await doc.whenIdle();

    await vi.advanceTimersByTimeAsync(1999);
    expect(await loadDocumentDraft(frameOf('ref-a'))).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    const framed = await loadDocumentDraft(frameOf('ref-a'));
    expect(framed).not.toBeNull();
    expect(framed!.ops).toHaveLength(1);
    // The frame it was bound AWAY from stays empty — re-pointing drops the
    // pending write rather than redirecting it.
    expect(await loadDocumentDraft(own)).toBeNull();
    doc.dispose();
  });

  it('the debounce RESTARTS on every edit — a typing run writes once, at the end', async () => {
    const { viewer, boxPath } = makeViewer();
    const doc = AssetDocument.newUntitled(viewer);
    const own = doc.draftFrame;

    doc.setField(boxPath, 'Drive', 'TargetSpeed', 100, 50);
    await vi.advanceTimersByTimeAsync(1500);
    doc.setField(boxPath, 'Drive', 'TargetSpeed', 150, 100);
    await vi.advanceTimersByTimeAsync(1500);
    await doc.whenIdle();
    expect(await loadDocumentDraft(own)).toBeNull();

    await vi.advanceTimersByTimeAsync(600);
    expect(await loadDocumentDraft(own)).not.toBeNull();
    doc.dispose();
  });

  it('WRITER 3 (scene GLB-bake slot): a scene edit arms the 2000 ms body autosave', async () => {
    const store = new SceneStore(makeSceneStoreViewer());
    await store.newEmpty();

    expect(store.hasUnpersistedWork()).toBe(false);

    await store.applyOp({
      ...head(), kind: 'setField',
      nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed',
      value: 200, prev: 50,
    });

    // The timer IS the writer's observable state before it fires.
    expect(store.hasUnpersistedWork()).toBe(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(store.hasUnpersistedWork()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(store.hasUnpersistedWork()).toBe(false);
    store.dispose();
  });
});

// ─── hasUnpersistedWork — the SCENE semantics (scene-store.ts:611-630) ───
//
// Pinned as SCENE-ONLY on purpose. The plan gives the asset lineage the same
// (stricter) notion in Phase 4; until then the asymmetry is the behaviour, and
// asserting symmetry here would pin something that is not true today.

describe('characterization — hasUnpersistedWork (scene semantics)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('no workspace ⇒ false', () => {
    const store = new SceneStore(makeSceneStoreViewer());
    expect(store.hasUnpersistedWork()).toBe(false);
    store.dispose();
  });

  it('a normal workspace reports work ONLY while the debounce timer is pending', async () => {
    const store = new SceneStore(makeSceneStoreViewer());
    await store.newEmpty();

    await store.applyOp({
      ...head(), kind: 'setField',
      nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed',
      value: 1, prev: 0,
    });
    expect(store.hasUnpersistedWork()).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);
    // Dirty, but nothing is at risk any more — the body write already ran.
    expect(store.getSnapshot().dirty).toBe(true);
    expect(store.hasUnpersistedWork()).toBe(false);
    store.dispose();
  });

  it('a TRANSIENT workspace reports work whenever it is dirty — it never schedules a timer', async () => {
    const store = new SceneStore(makeSceneStoreViewer());
    await store.openTransient(makeTransientScene());

    expect(store.hasUnpersistedWork()).toBe(false);

    await store.applyOp({
      ...head(), kind: 'setField',
      nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed',
      value: 1, prev: 0,
    });

    expect(store.hasUnpersistedWork()).toBe(true);
    // Time does not rescue a transient workspace: no timer was ever armed.
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.hasUnpersistedWork()).toBe(true);
    store.dispose();
  });
});

// ─── SceneStore fake viewer ─────────────────────────────────────────────

const emptyBase: SceneBase = { kind: 'empty' };

function makeSceneStoreViewer(): RVViewer {
  const v = {
    availableModels: [] as { url: string; label: string }[],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    registry: null,
    loadScene: async (s: RvScene) => { v.currentScene = s; v.currentModelUrl = 'empty:'; },
    loadEmptyScene: async () => { v.currentScene = null; v.currentModelUrl = null; },
    getPlugin: () => undefined,
    markRenderDirty() {},
    emit() {},
  };
  return v as unknown as RVViewer;
}

function makeTransientScene(): RvScene {
  return {
    id: 'transient-char',
    name: 'Shared',
    base: emptyBase,
    createdAt: 0,
    updatedAt: 0,
    edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
  } as unknown as RvScene;
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-710 §9.4 — what a MODE SWITCH does to the open document.
 *
 * Characterization, not aspiration. This file pins TODAY's behaviour so the
 * facade-hollowing of Phase 3 can be judged against it:
 *
 *  - Planner / HMI / DES share ONE `SceneStore` and therefore one document
 *    instance. Switching between them is not a document event at all: the op
 *    log, the dirty flag and the undo stacks are simply still there.
 *  - Scene ↔ Editor is a SAVE/RESTORE pair, not a shared instance. The editor
 *    opens its own `AssetDocument` while the scene's document keeps living
 *    (its background autosave runs the whole time), and leaving the editor
 *    restores the scene workspace it captured on the way in.
 *
 * **The instance-sharing claim arrived in plan-711 Phase 2+3, and it is ADDED
 * rather than substituted.** The `not.toBe` cases below are unchanged: they
 * describe two DIFFERENT documents, where the coexistence they pin is still the
 * behaviour (F7). The `toBe` block at the end describes the SAME document,
 * where the editor now binds to the scene's living instance instead of building
 * a second one — see `shared-instance-transition.test.ts` for the full net.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import {
  __clearDraftStoresForTests,
  listAllDocumentDrafts,
} from '../src/core/ops/rv-document-drafts';
import type { RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';
import {
  sceneDocumentBase,
} from '../src/core/editor/active-asset-store';

// ─── Fixtures ───────────────────────────────────────────────────────────

let opSeq = 0;
const head = () => ({ id: `op_mode_${++opSeq}`, ts: 10_000, schemaV: 1 as const });

/**
 * One scene op per call, with its own TARGET.
 *
 * The field name varies deliberately: two `setField` ops on the same target
 * inside the coalescing window collapse into one undo step (that is the
 * documented behaviour, pinned in the characterization net), and this file
 * wants to count ops across a mode switch, not re-test coalescing.
 */
function sceneOp(value: number): RvScenePrimitiveOp {
  return {
    ...head(), kind: 'setField',
    nodePath: 'Asset/Box', componentType: 'Drive', fieldName: `Field${value}`,
    value, prev: 0,
  };
}

/**
 * A viewer good enough for `SceneStore`, with the ACTIVE MODE as real state.
 *
 * The mode manager is the thing under test here: every mode switch below goes
 * through it, exactly as the UI does.
 */
function makeSceneViewer() {
  let activeMode = 'planner';
  const modeListeners = new Set<() => void>();
  const v = {
    availableModels: [] as { url: string; label: string }[],
    currentScene: null as unknown,
    currentModelUrl: null as string | null,
    registry: null,
    modes: {
      get activeMode() { return activeMode; },
      has: () => true,
      setMode: (m: string) => { activeMode = m; for (const l of modeListeners) l(); },
      subscribe: (l: () => void) => { modeListeners.add(l); return () => modeListeners.delete(l); },
    },
    loadScene: async () => { v.currentModelUrl = 'empty:'; },
    loadEmptyScene: async () => { v.currentModelUrl = null; },
    getPlugin: () => undefined,
    markRenderDirty() {},
    emit() {},
  };
  return v as unknown as RVViewer & { modes: { setMode(m: string): void; activeMode: string } };
}

/** A viewer for an `AssetDocument` — its own tree, as an editor open produces. */
function makeAssetViewer() {
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

  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return root; },
    markRenderDirty() {}, markShadowsDirty() {},
    emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
  } as unknown as RVViewer;

  return { viewer, box, boxPath: NodeRegistry.computeNodePath(box) };
}

beforeEach(async () => {
  await __clearDraftStoresForTests();
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Planner → HMI → DES: one document, untouched ───────────────────────

describe('mode switch within the scene lineage (planner / HMI / DES)', () => {
  it('keeps the SAME document instance, with its op log, dirty flag and undo stack', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();

    const documentAtStart = store.document;
    await store.applyOp(sceneOp(200));
    await store.applyOp(sceneOp(300));

    const before = store.getSnapshot();
    expect(before.dirty).toBe(true);
    expect(before.canUndo).toBe(true);
    expect(store.document.opCount).toBe(2);

    viewer.modes.setMode('hmi');
    viewer.modes.setMode('des');
    viewer.modes.setMode('planner');

    // Identity, not equality: these modes are views onto one workspace, and a
    // switch between them is not a document event at all.
    expect(store.document).toBe(documentAtStart);
    const after = store.getSnapshot();
    expect(after.dirty).toBe(before.dirty);
    expect(after.canUndo).toBe(before.canUndo);
    expect(after.canRedo).toBe(before.canRedo);
    expect(store.document.opCount).toBe(2);

    // …and the history still works from the other side of the switch.
    await store.undo();
    expect(store.document.opCount).toBe(1);
    expect(store.getSnapshot().canRedo).toBe(true);
    store.dispose();
  });

  it('the three intrinsics come from the document, so they cannot drift per mode', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();
    await store.applyOp(sceneOp(1));

    const snap = store.getSnapshot();
    const core = store.document.core;
    // `busy` is the ONE deliberate divergence — see `_buildSnapshot`: the scene
    // layer means "the store is loading or saving", a wider notion than the
    // document's op queue.
    expect({ dirty: snap.dirty, canUndo: snap.canUndo, canRedo: snap.canRedo })
      .toEqual({ dirty: core.dirty, canUndo: core.canUndo, canRedo: core.canRedo });
    store.dispose();
  });
});

// ─── Scene ↔ Editor: two documents, side by side ────────────────────────

describe('scene ↔ editor', () => {
  it('the editor document is INDEPENDENT — editing it leaves the scene document alone', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();
    await store.applyOp(sceneOp(200));
    const sceneOps = store.document.opCount;
    const sceneDirty = store.getSnapshot().dirty;

    // Entering the editor: a mode switch plus an AssetDocument of its own.
    viewer.modes.setMode('editor');
    const asset = makeAssetViewer();
    const doc = scratchAssetDocument(asset.viewer);
    doc.setField(asset.boxPath, 'Drive', 'TargetSpeed', 999, 50);
    await doc.whenIdle();

    expect(doc.getSnapshot().opCount).toBe(1);
    expect(doc.dirty).toBe(true);
    // The scene document is a different object and did not move.
    expect(store.document).not.toBe(doc.document);
    expect(store.document.opCount).toBe(sceneOps);
    expect(store.getSnapshot().dirty).toBe(sceneDirty);

    doc.dispose();
    store.dispose();
  });

  it('both documents live at once and write to SEPARATE draft slots', async () => {
    // This is the property plan-711 must preserve while it collapses the seam:
    // the scene's background autosave runs while the editor holds another
    // document, and neither writer can reach the other's slot.
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();
    await store.applyOp(sceneOp(200));

    viewer.modes.setMode('editor');
    const asset = makeAssetViewer();
    const doc = scratchAssetDocument(asset.viewer);
    doc.setField(asset.boxPath, 'Drive', 'TargetSpeed', 999, 50);
    await doc.whenIdle();

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);

    // The asset wrote exactly its own frame; the scene wrote baked bytes, which
    // are not in this keyspace at all (§2.3).
    const drafts = await listAllDocumentDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].frame.rootDocumentId).toBe(doc.id);

    doc.dispose();
    store.dispose();
  });

  it('leaving the editor restores the scene workspace, ops and dirty state included', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();
    await store.applyOp(sceneOp(200));
    await store.applyOp(sceneOp(300));
    const opsBefore = store.document.opCount;
    const nameBefore = store.getSnapshot().draft?.name;

    // The editor's round trip, as `AssetEditorPlugin` performs it: capture on
    // the way in (`getSnapshot().saved/draft.base`), reopen on the way out.
    viewer.modes.setMode('editor');
    const asset = makeAssetViewer();
    const doc = scratchAssetDocument(asset.viewer);
    doc.setField(asset.boxPath, 'Drive', 'TargetSpeed', 999, 50);
    await doc.whenIdle();
    doc.dispose();
    viewer.modes.setMode('planner');

    // Nothing about the scene document changed while the editor was up.
    expect(store.document.opCount).toBe(opsBefore);
    expect(store.getSnapshot().dirty).toBe(true);
    expect(store.getSnapshot().draft?.name).toBe(nameBefore);
    expect(store.getSnapshot().canUndo).toBe(true);
    store.dispose();
  });
});

// ─── Scene ↔ Editor at the SAME document: one instance (plan-711 §9.2) ──

describe('scene ↔ editor am GLEICHEN Dokument', () => {
  it('the editor BINDS to the scene\'s document — one instance, one history', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();
    await store.applyOp(sceneOp(200));
    const documentAtStart = store.document;

    // What `AssetEditorPlugin._bindSceneDocument` constructs when
    // `sameDocumentBase` says the editor is about to open what the scene is
    // already showing. No second `AssetDocument`, no save/restore pair.
    viewer.modes.setMode('editor');
    const asset = makeAssetViewer();
    const bound = new AssetDocument(asset.viewer, {
      id: 'asset_bound',
      name: 'Line 1',
      base: sceneDocumentBase('scene_1', 'Line 1'),
      adopt: store.document,
    });

    // The complement of the `not.toBe` above, and the whole point of 711.
    expect(bound.document).toBe(documentAtStart);
    bound.setField(asset.boxPath, 'Drive', 'TargetSpeed', 999, 50);
    await bound.whenIdle();

    // The scene sees the editor's op without being told: it is the same log.
    expect(store.document.opCount).toBe(2);
    expect(store.getSnapshot().dirty).toBe(true);

    // Leaving the editor does not take the document with it.
    bound.dispose();
    viewer.modes.setMode('planner');
    expect(store.document).toBe(documentAtStart);
    expect(store.document.isDisposed).toBe(false);
    expect(store.document.opCount).toBe(2);
    store.dispose();
  });
});

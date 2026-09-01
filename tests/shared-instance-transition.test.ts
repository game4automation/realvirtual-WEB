// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-711 §9.2 + §9.8 (discard) — the SHARED document across the mode change.
 *
 * The complement of `document-mode-switch.test.ts`, which pins that scene and
 * editor do NOT share an instance when they hold different documents. This file
 * pins the other half: same document ⇒ same instance, one op log, one undo
 * stack, one dirty state — and a discard that really discards.
 *
 * Renderer-free. `SceneStore` over a viewer double (the same one the mode-switch
 * characterization uses) and an `AssetDocument` that BINDS to its document, which
 * is exactly what `AssetEditorPlugin._bindSceneDocument` constructs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import {
  libraryDocumentBase,
  sameDocumentBase,
  sceneDocumentBase,
} from '../src/core/editor/active-asset-store';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import type { RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';

let opSeq = 0;
const head = () => ({ id: `op_bind_${++opSeq}`, ts: 10_000, schemaV: 1 as const });

/** One scene op per call, each on its own field so nothing coalesces. */
function sceneOp(value: number): RvScenePrimitiveOp {
  return {
    ...head(), kind: 'setField',
    nodePath: 'Asset/Box', componentType: 'Drive', fieldName: `Field${value}`,
    value, prev: 0,
  };
}

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

/** The tree the editor projection authors — a fresh one, as a load produces. */
function makeAssetViewer() {
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

  const viewer = {
    scene, registry,
    signalStore: null, transportManager: null,
    get currentModelRoot() { return root; },
    markRenderDirty() {}, markShadowsDirty() {},
    emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
  } as unknown as RVViewer;

  return { viewer, root, boxPath: 'Asset/Box' };
}

beforeEach(async () => {
  await __clearDraftStoresForTests();
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => { vi.useRealTimers(); });

// ─── The bind (§9.2) ────────────────────────────────────────────────────

describe('gleiches Dokument: EINE Instanz ueber den Moduswechsel', () => {
  it('the bound editor document IS the scene document — one log, one undo stack', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();
    await store.applyOp(sceneOp(200));
    await store.applyOp(sceneOp(300));

    const opsBefore = store.document.opCount;
    const dirtyBefore = store.getSnapshot().dirty;
    const canUndoBefore = store.getSnapshot().canUndo;

    const asset = makeAssetViewer();
    const bound = new AssetDocument(asset.viewer, {
      id: 'asset_bound', name: 'Line 1',
      base: sceneDocumentBase('scene_1', 'Line 1'),
      adopt: store.document,
    });

    // The claim, and it is identity rather than equality — this is the exact
    // complement of `document-mode-switch.test.ts`'s `not.toBe` for the
    // UNEQUAL case, which stays untouched.
    expect(bound.document).toBe(store.document);
    expect(bound.isBound).toBe(true);
    expect(bound.document.opCount).toBe(opsBefore);
    expect(bound.dirty).toBe(dirtyBefore);
    expect(bound.getSnapshot().canUndo).toBe(canUndoBefore);
    // The projection moved with the binding; the log did not.
    expect(store.document.mode).toBe('asset');
    expect(bound.bindFloor).toBe(opsBefore);

    bound.dispose();
    store.dispose();
  });

  it('an editor op lands in the SCENE document\'s log, and undo reaches across', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();
    await store.applyOp(sceneOp(200));

    const asset = makeAssetViewer();
    const bound = new AssetDocument(asset.viewer, {
      id: 'asset_bound', name: 'Line 1',
      base: sceneDocumentBase('scene_1', 'Line 1'),
      adopt: store.document,
    });

    bound.setField(asset.boxPath, 'Drive', 'TargetSpeed', 999, 50);
    await bound.whenIdle();

    // ONE log: the store sees the editor's op without being told about it.
    expect(store.document.opCount).toBe(2);
    expect(store.getSnapshot().canUndo).toBe(true);

    // …and ONE undo stack: undoing through the editor moves the scene's redo.
    await bound.undo();
    expect(store.document.opCount).toBe(1);
    expect(store.getSnapshot().canRedo).toBe(true);

    bound.dispose();
    store.dispose();
  });

  it('disposing the bound facade does NOT dispose the shared document', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();
    await store.applyOp(sceneOp(200));

    const asset = makeAssetViewer();
    const bound = new AssetDocument(asset.viewer, {
      id: 'asset_bound', name: 'Line 1',
      base: sceneDocumentBase('scene_1', 'Line 1'),
      adopt: store.document,
    });
    bound.dispose();

    // The scene is still showing it — a facade that disposed its lender would
    // leave the other projection holding a dead document.
    expect(store.document.isDisposed).toBe(false);
    expect(store.document.opCount).toBe(1);
    await store.applyOp(sceneOp(300));
    expect(store.document.opCount).toBe(2);

    store.dispose();
  });
});

// ─── The unequal case stays exactly as it was (F7) ──────────────────────

describe('ungleiches Dokument: Koexistenz unveraendert', () => {
  it('an UNBOUND editor document is a second instance and the scene does not move', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();
    await store.applyOp(sceneOp(200));
    const sceneOps = store.document.opCount;

    const asset = makeAssetViewer();
    const doc = scratchAssetDocument(asset.viewer);
    doc.setField(asset.boxPath, 'Drive', 'TargetSpeed', 999, 50);
    await doc.whenIdle();

    expect(doc.document).not.toBe(store.document);
    expect(doc.isBound).toBe(false);
    expect(store.document.opCount).toBe(sceneOps);
    expect(store.document.mode).toBe('scene');

    doc.dispose();
    store.dispose();
  });

  it('the identity gate refuses everything but an exact match', () => {
    const line1 = sceneDocumentBase('scene_1', 'Line 1');
    expect(sameDocumentBase(line1, sceneDocumentBase('scene_1', 'Line 1 (renamed)'))).toBe(true);
    expect(sameDocumentBase(line1, sceneDocumentBase('scene_2', 'Line 1'))).toBe(false);
    expect(sameDocumentBase(line1, libraryDocumentBase('scene_1')))
      .toBe(false);
    expect(sameDocumentBase(line1, null)).toBe(false);
  });

  it('a workspace with no SAVED scene hands nothing over', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();
    // An unsaved draft has no comparable identity, so there is nothing to bind
    // to — conservative by construction (risk 8), not an oversight.
    expect(store.documentIdentity()).toBeNull();
    expect(store.beginProjectionHandover()).toBeNull();
    expect(store.projectionSuspended).toBe(false);
    store.dispose();
  });

  it('an UNSAVED builtin scene hands over — the demo scene binds too', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.openBuiltin('/models/Demo.glb', 'Demo');

    // The stable URL is the identity `_loadIntoWorkspace` publishes for this
    // very workspace, so the two sides of the editor's comparison agree.
    // Before this branch the mode switch reopened the base FILE from bytes and
    // the scene's placements were missing in the editor (the plan-711 /fix).
    expect(store.documentIdentity()).toEqual(
      { kind: 'builtinModel', url: '/models/Demo.glb', name: 'Demo' },
    );

    const handover = store.beginProjectionHandover();
    expect(handover).not.toBeNull();
    expect(handover!.document).toBe(store.document);
    expect(store.projectionSuspended).toBe(true);
    handover!.release();
    expect(store.projectionSuspended).toBe(false);
    store.dispose();
  });
});

// ─── The handback race (dashboard double-click during recompose) ────────

describe('Handback nach Dokumentwechsel: adoptiert NICHT (stale recompose)', () => {
  it('release() with authored bytes adopts them only for the document it was bound to', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.openBuiltin('/models/Demo.glb', 'Demo');

    const handover = store.beginProjectionHandover();
    expect(handover).not.toBeNull();

    // The race: while the editor's async export runs, a dashboard double-click
    // opens ANOTHER document. The workspace has moved on by the time the
    // handback releases.
    await store.openBuiltin('/models/Other.glb', 'Other');

    const adopt = vi.spyOn(store, 'adoptProjectedBaseBytes');
    handover!.release({ authoredBytes: new ArrayBuffer(8) });

    // The old document's authored tree must NOT become the new document's
    // bake source — that was the "new name, old content" defect.
    expect(adopt).not.toHaveBeenCalled();
    expect(store.projectionSuspended).toBe(false);
    store.dispose();
  });

  it('release() with authored bytes still adopts them when nothing changed', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.openBuiltin('/models/Demo.glb', 'Demo');

    const handover = store.beginProjectionHandover();
    expect(handover).not.toBeNull();

    const adopt = vi.spyOn(store, 'adoptProjectedBaseBytes');
    handover!.release({ authoredBytes: new ArrayBuffer(8) });

    // The guard must never dull the normal way back: same document, adopted.
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(store.projectionSuspended).toBe(false);
    store.dispose();
  });
});

// ─── Discard (§9.8) ─────────────────────────────────────────────────────

describe('Discard am gebundenen Dokument (R1-S1)', () => {
  it('rolls the ops above the bind floor back for REAL and cuts the log', async () => {
    const viewer = makeSceneViewer();
    const store = new SceneStore(viewer);
    await store.newEmpty();
    await store.applyOp(sceneOp(200));
    await store.applyOp(sceneOp(300));

    const asset = makeAssetViewer();
    const bound = new AssetDocument(asset.viewer, {
      id: 'asset_bound', name: 'Line 1',
      base: sceneDocumentBase('scene_1', 'Line 1'),
      adopt: store.document,
    });

    bound.setField(asset.boxPath, 'Drive', 'TargetSpeed', 999, 50);
    bound.setField(asset.boxPath, 'Drive', 'Acceleration', 111, 10);
    await bound.whenIdle();
    expect(store.document.opCount).toBe(4);

    const undone = await bound.discardBoundEdits();

    // The scene does NOT see them: the log is back at the floor, the tree was
    // driven back through the inverses, and nothing was rebased into a "clean"
    // state the way `markSaved({floor})` would have done.
    expect(undone).toBe(2);
    expect(store.document.opCount).toBe(2);
    expect(store.document.opCount).toBe(bound.bindFloor);
    const box = asset.viewer.registry!.getNode(asset.boxPath)!;
    const drive = (box.userData.realvirtual as Record<string, Record<string, unknown>>).Drive;
    expect(drive.TargetSpeed).toBe(50);
    // A discard is not undo-able work — the redo branch goes with it.
    expect(store.document.canRedo()).toBe(false);
    // The SCENE's own two ops survived, and are still dirty against the base.
    expect(store.getSnapshot().dirty).toBe(true);

    bound.dispose();
    store.dispose();
  });

  it('is a no-op at an unbound document, which discards by dying instead', async () => {
    const asset = makeAssetViewer();
    const doc = scratchAssetDocument(asset.viewer);
    doc.setField(asset.boxPath, 'Drive', 'TargetSpeed', 999, 50);
    await doc.whenIdle();
    expect(await doc.discardBoundEdits()).toBe(0);
    expect(doc.document.opCount).toBe(1);
    doc.dispose();
  });
});

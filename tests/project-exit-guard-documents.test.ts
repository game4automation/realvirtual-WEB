// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The project-level exit guard spans the whole document stack
 * (plan-703 §2.7.3, Phase 4).
 *
 * Two halves, tested separately because they live in two modules:
 *
 *  - `RvDocumentStack.dirtyDocuments()` — the projection, bottom frame first;
 *  - `ProjectStore.hasUnsavedWork()` / the guard context — the consumer that
 *    was missing. Before this, a project switch asked only about the scene, so
 *    a dirty editor document was discarded without a question.
 *
 * Renderer-free: the stack takes a two-method viewer, and the store is driven
 * through its public probe seam.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { RvDocumentStack, type RvStackDocument } from '../src/core/ops/rv-document-stack';
import { getProjectStore, resetProjectStore } from '../src/core/project/project-store';

// ─── A document double: only what the stack reads ───────────────────────

function doc(id: string, dirty: boolean): RvStackDocument {
  return {
    id,
    document: { dirty, ops: [], subscribe: () => () => {} } as unknown as
      RvStackDocument['document'],
    dispose: () => {},
  };
}

const noopViewer = { isolateNodes: () => {}, exitIsolate: () => {} };

function stackOfThree(dirty: [boolean, boolean, boolean]): RvDocumentStack {
  const stack = new RvDocumentStack({ viewer: noopViewer, projectId: 'p1' });
  stack.pushRoot({ doc: doc('d0', dirty[0]), assetId: 'a0', name: 'Plant' });
  const ref1 = new Object3D();
  ref1.userData.realvirtual = { NodeId: 'ref1' };
  stack.push({
    doc: doc('d1', dirty[1]), assetId: 'a1', name: 'Filler',
    referenceNodeId: 'ref1', isolatedRoots: [], suppressedOverrides: 0,
  });
  stack.push({
    doc: doc('d2', dirty[2]), assetId: 'a2', name: 'Gripper',
    referenceNodeId: 'ref2', isolatedRoots: [], suppressedOverrides: 0,
  });
  return stack;
}

describe('RvDocumentStack.dirtyDocuments — the guard’s input', () => {
  it('is empty when every frame is clean', () => {
    expect(stackOfThree([false, false, false]).dirtyDocuments()).toEqual([]);
  });

  it('reports EVERY dirty frame, not just the top one', () => {
    // The whole point of §2.7.3: three levels deep, two of them dirty.
    expect(stackOfThree([true, false, true]).dirtyDocuments()).toEqual([
      { name: 'Plant', depth: 0 },
      { name: 'Gripper', depth: 2 },
    ]);
  });

  it('reports bottom frame first — the order the user descended in', () => {
    const names = stackOfThree([true, true, true]).dirtyDocuments().map(d => d.name);
    expect(names).toEqual(['Plant', 'Filler', 'Gripper']);
  });

  it('agrees with anyDirty in both directions', () => {
    const clean = stackOfThree([false, false, false]);
    expect(clean.anyDirty).toBe(false);
    expect(clean.dirtyDocuments()).toHaveLength(0);

    const deepOnly = stackOfThree([false, false, true]);
    expect(deepOnly.anyDirty).toBe(true);
    expect(deepOnly.dirtyDocuments()).toHaveLength(1);
  });
});

describe('ProjectStore — the caller that was missing', () => {
  beforeEach(() => { resetProjectStore(); });

  it('reports no unsaved work with no probe installed', () => {
    expect(getProjectStore().hasUnsavedWork()).toBe(false);
  });

  it('counts an unsaved open document as unsaved work', () => {
    const store = getProjectStore();
    store.setDirtyDocumentsProbe(() => [{ name: 'Filler', depth: 0 }]);
    expect(store.hasUnsavedWork()).toBe(true);
  });

  it('counts every frame of the stack, through the stack’s own projection', () => {
    const store = getProjectStore();
    const stack = stackOfThree([true, false, true]);
    store.setDirtyDocumentsProbe(() => stack.dirtyDocuments());
    expect(store.hasUnsavedWork()).toBe(true);
  });

  it('goes quiet again when the probe is removed', () => {
    const store = getProjectStore();
    store.setDirtyDocumentsProbe(() => [{ name: 'Filler', depth: 0 }]);
    store.setDirtyDocumentsProbe(null);
    expect(store.hasUnsavedWork()).toBe(false);
  });

  it('a throwing probe must not block a switch', () => {
    const store = getProjectStore();
    store.setDirtyDocumentsProbe(() => { throw new Error('probe exploded'); });
    expect(store.hasUnsavedWork()).toBe(false);
  });

  it('with no project open the gate does not fire at all', async () => {
    // The guard is about LEAVING a project; with none open there is nothing to
    // leave, and `requestCloseProject` short-circuits before the guard. Pinned
    // so that adding the document term to `hasUnsavedWork()` cannot turn a
    // no-op close into a dialog.
    const store = getProjectStore();
    const stack = stackOfThree([true, true, false]);
    store.setDirtyDocumentsProbe(() => stack.dirtyDocuments());

    let asked = false;
    store.setDirtyGuard(() => { asked = true; return 'cancel'; });

    expect(await store.requestCloseProject()).toBe(true);
    expect(asked).toBe(false);
    // The probe still reports, so the gate WILL fire once a project is open.
    expect(store.hasUnsavedWork()).toBe(true);
  });

  it('does not read the probe more than the guard needs to', () => {
    const store = getProjectStore();
    let calls = 0;
    store.setDirtyDocumentsProbe(() => { calls++; return []; });
    store.hasUnsavedWork();
    expect(calls).toBe(1);
  });
});

/**
 * `hasUnpersistedWork()` — the page-level unload guard's question.
 *
 * The store answers two different questions and they must not collapse into
 * one. "Unsaved" is about the named save and is a routine state; "unpersisted"
 * is about what a reload destroys, and is the only one worth interrupting
 * someone for. The scene half of the distinction is pinned in
 * `rv-scene-transient.test.ts`; here it is the aggregation.
 */
describe('ProjectStore.hasUnpersistedWork — the unload guard', () => {
  beforeEach(() => { resetProjectStore(); });

  /** The narrow seam ProjectStore uses — only the two methods it calls. */
  function attachScene(store: ReturnType<typeof getProjectStore>, opts: {
    dirty: boolean; atRisk: boolean;
  }) {
    store.attachToSceneStore({
      setSceneHydrator: () => {},
      getSnapshot: () => ({ dirty: opts.dirty, draft: { name: 'Shared cell' } }),
      hasUnpersistedWork: () => opts.atRisk,
    });
  }

  it('says nothing is at risk with no scene and no documents', () => {
    expect(getProjectStore().hasUnpersistedWork()).toBe(false);
  });

  it('a dirty-but-autosaved scene is unsaved, yet nothing is at risk', () => {
    // THE case that separates the two questions. Warning here would train the
    // user to click the dialog away, and then it stops protecting anything.
    const store = getProjectStore();
    attachScene(store, { dirty: true, atRisk: false });
    expect(store.hasUnsavedWork()).toBe(true);
    expect(store.hasUnpersistedWork()).toBe(false);
  });

  it('a transient scene with edits is at risk', () => {
    const store = getProjectStore();
    attachScene(store, { dirty: true, atRisk: true });
    expect(store.hasUnpersistedWork()).toBe(true);
  });

  it('an unsaved open document is at risk even with a clean scene', () => {
    // What the asset editor's own `beforeunload` used to cover — in editor mode
    // only. Through the probe it now counts in every mode.
    const store = getProjectStore();
    attachScene(store, { dirty: false, atRisk: false });
    store.setDirtyDocumentsProbe(() => [{ name: 'Gripper', depth: 1 }]);
    expect(store.hasUnpersistedWork()).toBe(true);
  });

  it('counts every frame of a stack, not just the top one', () => {
    const store = getProjectStore();
    const stack = stackOfThree([true, false, false]);
    store.setDirtyDocumentsProbe(() => stack.dirtyDocuments());
    expect(store.hasUnpersistedWork()).toBe(true);
  });

  it('a throwing probe must not wedge the page shut', () => {
    // Mirrors the switch guard's rule: a broken probe fails open. A guard that
    // throws on every unload would make the tab impossible to close.
    const store = getProjectStore();
    store.setDirtyDocumentsProbe(() => { throw new Error('probe exploded'); });
    expect(store.hasUnpersistedWork()).toBe(false);
  });

  it('a scene store from before this contract simply does not answer', () => {
    // `hasUnpersistedWork` is optional on the seam; an older/partial store must
    // degrade to "nothing at risk", not throw.
    const store = getProjectStore();
    store.attachToSceneStore({ setSceneHydrator: () => {} });
    expect(store.hasUnpersistedWork()).toBe(false);
  });
});

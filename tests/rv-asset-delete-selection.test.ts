// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Editor delete-selection tests — the shared delete path behind the viewport
 * toolbar button and the Delete/Backspace key: descendant dedupe, one
 * composite undo unit for multi-delete, root/unresolvable guards, and
 * selection clearing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { pruneDescendantPaths, deleteSelectedNodes } from '@rv-private/plugins/asset-editor/delete-selection';

function makeMockViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);

  // Asset
  // ├─ Conv          (parent with a child)
  // │   └─ Belt
  // ├─ Conv2         (name-prefix sibling — NOT a descendant of Conv)
  // └─ Box
  const conv = new Object3D(); conv.name = 'Conv';
  const belt = new Object3D(); belt.name = 'Belt';
  conv.add(belt);
  const conv2 = new Object3D(); conv2.name = 'Conv2';
  const box = new Object3D(); box.name = 'Box';
  model.add(conv, conv2, box);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  let selected: string[] = [];
  const selectionManager = {
    get selectedPaths(): ReadonlyArray<string> { return selected; },
    clear(): void { selected = []; },
    set(paths: string[]): void { selected = paths; },
  };

  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    selectionManager,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    rebuildGroupedBvh() {},
  } as unknown as RVViewer;

  const path = (n: Object3D) => NodeRegistry.computeNodePath(n);
  return { viewer, model, conv, belt, conv2, box, registry, selectionManager, path };
}

beforeEach(async () => {
  await __clearDraftStoresForTests();
});

describe('pruneDescendantPaths', () => {
  it('drops descendants of selected ancestors, keeps siblings', () => {
    expect(pruneDescendantPaths(['Asset/Conv', 'Asset/Conv/Belt', 'Asset/Box']))
      .toEqual(['Asset/Conv', 'Asset/Box']);
  });

  it('is segment-aware: a name prefix is not an ancestor', () => {
    expect(pruneDescendantPaths(['Asset/Conv', 'Asset/Conv2']))
      .toEqual(['Asset/Conv', 'Asset/Conv2']);
  });

  it('dedupes exact duplicates and preserves selection order', () => {
    expect(pruneDescendantPaths(['Asset/Box', 'Asset/Conv', 'Asset/Box']))
      .toEqual(['Asset/Box', 'Asset/Conv']);
  });

  it('handles deep chains regardless of input order', () => {
    expect(pruneDescendantPaths(['A/B/C/D', 'A/B', 'A/B/C']))
      .toEqual(['A/B']);
  });
});

describe('deleteSelectedNodes', () => {
  it('deletes parent subtree + unrelated node as ONE undo unit; clears selection', async () => {
    const { viewer, model, conv, belt, box, conv2, selectionManager, path } = makeMockViewer();
    const doc = AssetDocument.newUntitled(viewer);

    // Parent + its child + an unrelated node — child must be deduped away.
    selectionManager.set([path(conv), path(belt), path(box)]);
    await deleteSelectedNodes(viewer, doc);

    expect(model.children).toEqual([conv2]);
    expect(selectionManager.selectedPaths.length).toBe(0);
    expect(doc.getSnapshot().opCount).toBe(1); // one composite op
    expect(doc.getSnapshot().undoLabel).toBe('Delete 2 objects');

    // One undo restores everything at the original sibling positions.
    await doc.undo();
    expect(model.children).toEqual([conv, conv2, box]);
    expect(conv.children).toEqual([belt]);
    doc.dispose();
  });

  it('single selection uses the plain deleteNode label', async () => {
    const { viewer, model, box, conv, conv2, selectionManager, path } = makeMockViewer();
    const doc = AssetDocument.newUntitled(viewer);

    selectionManager.set([path(box)]);
    await deleteSelectedNodes(viewer, doc);
    expect(model.children).toEqual([conv, conv2]);
    expect(doc.getSnapshot().undoLabel).toBe('Delete Box');
    doc.dispose();
  });

  it('skips the asset root and unresolvable paths; empty result records nothing', async () => {
    const { viewer, model, selectionManager } = makeMockViewer();
    const doc = AssetDocument.newUntitled(viewer);

    selectionManager.set(['Asset', 'Asset/DoesNotExist']);
    await deleteSelectedNodes(viewer, doc);
    expect(model.children.length).toBe(3);
    expect(doc.getSnapshot().opCount).toBe(0);
    // Nothing deleted → selection stays (no surprise deselect).
    expect(selectionManager.selectedPaths.length).toBe(2);
    doc.dispose();
  });
});

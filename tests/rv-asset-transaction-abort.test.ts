// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The transaction failure contract (plan-359 §9.6, Phase 3).
 *
 * The state this rules out: a bulk edit that dies half-way and leaves the scene
 * rebuilt with nothing to undo. Four things used to conspire to produce it —
 * `_forwardAny` swallowed every error, `applyOp` recorded the op regardless,
 * `_reparent` reported a missing path as a console warning, and `undo()` popped
 * its stack BEFORE the inverse applied. Each of those is asserted here.
 *
 * The contract: an op either applies or rejects; a transaction is all-or-nothing;
 * a failure reaches the caller.
 */
import { describe, it, expect, vi } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { assetOpHeader } from '../src/core/editor/rv-asset-ops';

function makeMockViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {}, markShadowsDirty() {},
    emit() {}, on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
    selectionManager: { select() {} },
  } as unknown as RVViewer;
  const register = () => {
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  };
  return { viewer, scene, model, registry, register };
}

function addChild(parent: Object3D, name: string, x = 0): Object3D {
  const n = new Group();
  n.name = name;
  n.position.set(x, 0, 0);
  parent.add(n);
  return n;
}

/** Snapshot of the graph shape, so "the scene is unchanged" is a real assertion. */
function shapeOf(root: Object3D): string {
  const parts: string[] = [];
  root.traverse((n) => {
    parts.push(`${NodeRegistry.computeNodePath(n)}@${n.position.toArray().join(',')}`);
  });
  return parts.join('|');
}

describe('a failing op rejects instead of being recorded', () => {
  it('rejects and records nothing when the executor throws', async () => {
    const { viewer, model, register } = makeMockViewer();
    addChild(model, 'A');
    register();
    const doc = scratchAssetDocument(viewer);
    const boom = new Error('executor exploded');
    vi.spyOn(doc.executor, 'applyForward').mockRejectedValueOnce(boom);

    await expect(doc.applyOp({
      ...assetOpHeader(), kind: 'renameNode', nodePath: 'Asset/A', name: 'B', prevName: 'A',
    })).rejects.toBe(boom);
    expect(doc.getSnapshot().opCount).toBe(0);
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });

  it('rejects on a missing reparent target instead of warning and moving on', async () => {
    const { viewer, model, register } = makeMockViewer();
    addChild(model, 'A');
    register();
    const doc = scratchAssetDocument(viewer);

    await expect(doc.applyOp({
      ...assetOpHeader(), kind: 'reparentNode',
      nodePath: 'Asset/A', newParentPath: 'Asset/DoesNotExist',
      transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      prevParentPath: 'Asset', prevIndex: 0,
      prevTransform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    })).rejects.toThrow(/not found/);
    expect(doc.getSnapshot().opCount).toBe(0);
    doc.dispose();
  });

  it('keeps the queue usable after a failure', async () => {
    const { viewer, model, register } = makeMockViewer();
    const a = addChild(model, 'A');
    register();
    const doc = scratchAssetDocument(viewer);

    await expect(doc.applyOp({
      ...assetOpHeader(), kind: 'reparentNode',
      nodePath: 'Asset/A', newParentPath: 'Asset/Nope',
      transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      prevParentPath: 'Asset', prevIndex: 0,
      prevTransform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    })).rejects.toThrow();

    // The rejected tail must not poison later ops.
    doc.renameNode('Asset/A', 'Renamed', 'A');
    await doc.whenIdle();
    expect(a.name).toBe('Renamed');
    expect(doc.getSnapshot().opCount).toBe(1);
    doc.dispose();
  });
});

describe('a failing transaction leaves nothing behind', () => {
  it('rolls back ops already applied when a later one throws', async () => {
    const { viewer, model, register } = makeMockViewer();
    addChild(model, 'A', 1);
    addChild(model, 'B', 2);
    const target = addChild(model, 'Link', 5);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);
    const before = shapeOf(model);

    await expect(doc.withTransaction('bulk', async () => {
      await doc.reparentNodesBatch(['Asset/A'], 'Asset/Link');
      // Second move targets a parent that does not exist → throws mid-transaction,
      // AFTER the first move already landed.
      await doc.reparentNodesBatch(['Asset/B'], 'Asset/Link');
      throw new Error('caller aborted');
    })).rejects.toThrow('caller aborted');

    model.updateMatrixWorld(true);
    expect(target.children).toHaveLength(0);
    expect(shapeOf(model)).toBe(before);
    expect(doc.getSnapshot().opCount).toBe(0);
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });

  it('rolls back a composite that fails part-way through its own moves', async () => {
    const { viewer, model, register, registry } = makeMockViewer();
    const parts = [addChild(model, 'P0', 1), addChild(model, 'P1', 2), addChild(model, 'P2', 3)];
    const target = addChild(model, 'Link', 9);
    register();
    model.updateMatrixWorld(true);
    const doc = scratchAssetDocument(viewer);
    const before = shapeOf(model);

    // Pull the third node out of the registry between resolve and apply — the
    // composite's own third move then cannot find it.
    const original = registry.getNode.bind(registry);
    let seenP2 = 0;
    vi.spyOn(registry, 'getNode').mockImplementation((path: string) => {
      if (path === 'Asset/P2' && ++seenP2 > 1) return null;
      return original(path);
    });

    await expect(
      doc.reparentNodesBatch(parts.map((p) => `Asset/${p.name}`), 'Asset/Link'),
    ).rejects.toThrow(/not found/);

    vi.restoreAllMocks();
    model.updateMatrixWorld(true);
    // All-or-nothing: the two moves that DID land were undone.
    expect(target.children).toHaveLength(0);
    expect(shapeOf(model)).toBe(before);
    expect(doc.getSnapshot().opCount).toBe(0);
    doc.dispose();
  });

  it('surfaces a failure from a fire-and-forget mutator inside a transaction', async () => {
    const { viewer, model, register } = makeMockViewer();
    addChild(model, 'A');
    register();
    const doc = scratchAssetDocument(viewer);
    const boom = new Error('component construction failed');
    const forward = vi.spyOn(doc.executor, 'applyForward');
    forward.mockRejectedValueOnce(boom);

    // `addComponent` returns void — its promise is nobody's. The transaction must
    // still learn that it failed.
    await expect(doc.withTransaction('add', async () => {
      doc.addComponent('Asset/A', 'Sensor', { Length: 1 });
      await doc.whenIdle();
    })).rejects.toBe(boom);
    expect(doc.getSnapshot().opCount).toBe(0);
    doc.dispose();
  });
});

describe('undo/redo stacks survive a failed apply', () => {
  it('keeps the op on the undo stack when the inverse throws', async () => {
    const { viewer, model, register } = makeMockViewer();
    const a = addChild(model, 'A');
    register();
    const doc = scratchAssetDocument(viewer);

    doc.renameNode('Asset/A', 'Renamed', 'A');
    await doc.whenIdle();
    expect(doc.getSnapshot().canUndo).toBe(true);

    vi.spyOn(doc.executor, 'applyInverse').mockRejectedValueOnce(new Error('inverse failed'));
    await expect(doc.undo()).rejects.toThrow('inverse failed');

    // The entry is still there — a failed undo must stay retryable, not vanish.
    expect(doc.getSnapshot().canUndo).toBe(true);
    expect(doc.getSnapshot().canRedo).toBe(false);
    expect(doc.getSnapshot().opCount).toBe(1);

    vi.restoreAllMocks();
    await doc.undo();
    expect(a.name).toBe('A');
    expect(doc.getSnapshot().canUndo).toBe(false);
    expect(doc.getSnapshot().canRedo).toBe(true);
    doc.dispose();
  });

  it('keeps the op on the redo stack when the redo apply throws', async () => {
    const { viewer, model, register } = makeMockViewer();
    addChild(model, 'A');
    register();
    const doc = scratchAssetDocument(viewer);

    doc.renameNode('Asset/A', 'Renamed', 'A');
    await doc.whenIdle();
    await doc.undo();
    expect(doc.getSnapshot().canRedo).toBe(true);

    vi.spyOn(doc.executor, 'applyForward').mockRejectedValueOnce(new Error('redo failed'));
    await expect(doc.redo()).rejects.toThrow('redo failed');
    expect(doc.getSnapshot().canRedo).toBe(true);
    expect(doc.getSnapshot().opCount).toBe(0);
    vi.restoreAllMocks();
    doc.dispose();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * createNode + reparentNode op tests — the two structural ops added for the
 * Kinematics window (empty creation, group-into-empty, signal/LogicStep
 * child nodes). Uses the same minimal mock viewer as rv-asset-document.test.ts
 * (real NodeRegistry + three Scene, no renderer).
 */
import { describe, it, expect } from 'vitest';
import { Scene, Group, Object3D, Vector3, Quaternion, Euler } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { groupIntoEmpty } from '@rv-private/plugins/asset-editor/kinematics/create-actions';

function makeMockViewer(rootName = 'Asset') {
  const scene = new Scene();
  const model = new Group();
  model.name = rootName;
  scene.add(model);

  const registry = new NodeRegistry();
  const register = () => {
    model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  };

  const selected: string[] = [];
  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    selectionManager: { select(path: string) { selected.push(path); } },
  } as unknown as RVViewer;

  return { viewer, scene, model, registry, register, selected };
}

function addChild(parent: Object3D, name: string, pos: [number, number, number] = [0, 0, 0]): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(...pos);
  parent.add(node);
  return node;
}

describe('createNode op', () => {
  it('creates an empty under the parent, undo trashes it, redo restores with later components', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    register();
    const doc = AssetDocument.newUntitled(viewer);

    const path = await doc.createEmptyNode(null, 'Empty');
    expect(path).toBe('Asset/Empty');
    const node = registry.getNode(path)!;
    expect(node).not.toBeNull();
    expect(node.parent).toBe(model);
    expect((node.userData as Record<string, unknown>)['__rvAdded']).toBe(true);

    // A component added AFTER creation must survive undo → redo of the create.
    doc.addComponent(path, 'Sensor', { Length: 100 });
    await doc.whenIdle();

    await doc.undo(); // remove component
    await doc.undo(); // trash the node
    expect(registry.getNode(path)).toBeNull();
    expect(node.parent?.name).toBe('_rvAssetTrash');

    await doc.redo(); // restore node (same object)
    expect(registry.getNode(path)).toBe(node);
    expect(node.parent).toBe(model);
    await doc.redo(); // re-add component
    expect((node.userData.realvirtual as Record<string, unknown>)['Sensor']).toEqual({ Length: 100 });
    doc.dispose();
  });

  it('dedupes the name against existing siblings and honors the sibling index', async () => {
    const { viewer, model, register } = makeMockViewer();
    addChild(model, 'Empty');
    addChild(model, 'Tail');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    const path = await doc.createEmptyNode(null, 'Empty', { index: 1 });
    expect(path).toBe('Asset/Empty_1');
    expect(model.children.map(c => c.name)).toEqual(['Empty', 'Empty_1', 'Tail']);
    doc.dispose();
  });
});

describe('reparentNode op', () => {
  it('preserves the world transform and undo restores parent, index and local TRS', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    const a = addChild(model, 'A', [1, 0, 0]);
    const b = addChild(model, 'B', [0, 0, 5]);
    b.quaternion.setFromEuler(new Euler(0, Math.PI / 2, 0));
    const box = addChild(a, 'Box', [2, 3, 4]);
    register();
    model.updateMatrixWorld(true);
    const doc = AssetDocument.newUntitled(viewer);

    const worldBefore = box.getWorldPosition(new Vector3()).clone();
    const quatBefore = box.getWorldQuaternion(new Quaternion()).clone();
    const localBefore = box.position.clone();

    const moved = await doc.reparentNodes(['Asset/A/Box'], 'Asset/B');
    expect(moved).toEqual(['Asset/B/Box']);
    expect(box.parent).toBe(b);
    expect(registry.getNode('Asset/B/Box')).toBe(box);
    expect(registry.getNode('Asset/A/Box')).toBeNull();

    box.updateMatrixWorld(true);
    expect(box.getWorldPosition(new Vector3()).distanceTo(worldBefore)).toBeLessThan(1e-6);
    expect(Math.abs(box.getWorldQuaternion(new Quaternion()).dot(quatBefore))).toBeCloseTo(1, 6);

    await doc.undo();
    expect(box.parent).toBe(a);
    expect(a.children.indexOf(box)).toBe(0);
    expect(box.position.distanceTo(localBefore)).toBeLessThan(1e-9);
    expect(registry.getNode('Asset/A/Box')).toBe(box);
    doc.dispose();
  });

  it('skips cycles and already-under-target moves', async () => {
    const { viewer, model, register } = makeMockViewer();
    const a = addChild(model, 'A');
    const inner = addChild(a, 'Inner');
    addChild(model, 'C');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    // A under its own descendant → cycle → skipped.
    expect(await doc.reparentNodes(['Asset/A'], 'Asset/A/Inner')).toEqual([]);
    expect(a.parent).toBe(model);
    // Already a child of the target → skipped.
    expect(await doc.reparentNodes(['Asset/A/Inner'], 'Asset/A')).toEqual([]);
    expect(inner.parent).toBe(a);
    doc.dispose();
  });

  it('pre-renames on a name collision under the target parent', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    const a = addChild(model, 'A');
    const target = addChild(model, 'Target');
    addChild(target, 'Box');
    const movedBox = addChild(a, 'Box');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    const moved = await doc.reparentNodes(['Asset/A/Box'], 'Asset/Target');
    expect(moved).toEqual(['Asset/Target/Box_1']);
    expect(movedBox.name).toBe('Box_1');
    expect(movedBox.parent).toBe(target);
    expect(registry.getNode('Asset/Target/Box_1')).toBe(movedBox);

    // Undo the whole move (rename + reparent were one transaction).
    await doc.undo();
    expect(movedBox.name).toBe('Box');
    expect(movedBox.parent).toBe(a);
    expect(registry.getNode('Asset/A/Box')).toBe(movedBox);
    doc.dispose();
  });
});

describe('unnamed asset root (regression: Kinematics actions on created empties)', () => {
  // The empty GLB / loaded-scene root has name === '' (see empty-glb.ts). Under
  // such a root NodeRegistry.computeNodePath yields a LEADING-slash path
  // ('/Empty'), which every getNode()/op lookup uses. The node-path helpers must
  // register created nodes at that SAME path — otherwise add-component /
  // add-child / reparent on a freshly created empty silently no-op because the
  // lookup ('/Empty') misses the registered key ('Empty').

  it('registers a root-level empty at the path computeNodePath re-derives', async () => {
    const { viewer, model, registry, register } = makeMockViewer('');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    const path = await doc.createEmptyNode(null, 'Empty');
    const node = registry.getNode(path)!;
    expect(node).not.toBeNull();
    expect(node.parent).toBe(model);
    // Registered path === computeNodePath === the returned path (all consistent).
    expect(path).toBe('/Empty');
    expect(registry.getPathForNode(node)).toBe(NodeRegistry.computeNodePath(node));
    expect(registry.getNode(NodeRegistry.computeNodePath(node))).toBe(node);
    doc.dispose();
  });

  it('can add a component and an empty child to a created root-level empty', async () => {
    const { viewer, registry, register } = makeMockViewer('');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    const emptyPath = await doc.createEmptyNode(null, 'Empty');
    const empty = registry.getNode(emptyPath)!;

    // Add component (mirrors the Kinematics "Drive"/"Sensor" buttons).
    doc.addComponent(emptyPath, 'Sensor', { Length: 100 });
    await doc.whenIdle();
    expect((empty.userData.realvirtual as Record<string, unknown>)['Sensor']).toEqual({ Length: 100 });

    // Add an empty child (mirrors the "Empty Child" button) — must nest under it.
    const childPath = await doc.createEmptyNode(emptyPath, 'Empty');
    const child = registry.getNode(childPath)!;
    expect(child).not.toBeNull();
    expect(child.parent).toBe(empty);
    expect(childPath).toBe('/Empty/Empty');
    expect(registry.getPathForNode(child)).toBe(NodeRegistry.computeNodePath(child));
    doc.dispose();
  });
});

describe('groupIntoEmpty (Kinematics window action)', () => {
  it('creates one empty, moves the pruned selection into it, one undo reverts all', async () => {
    const { viewer, model, registry, register, selected } = makeMockViewer();
    const a = addChild(model, 'A', [1, 2, 3]);
    const b = addChild(model, 'B', [4, 5, 6]);
    const aChild = addChild(a, 'AChild', [0.5, 0, 0]);
    register();
    model.updateMatrixWorld(true);
    const doc = AssetDocument.newUntitled(viewer);

    const aWorld = a.getWorldPosition(new Vector3()).clone();
    const bWorld = b.getWorldPosition(new Vector3()).clone();

    // AChild is a descendant of A → pruned; only A and B move.
    await groupIntoEmpty(viewer, doc, ['Asset/A', 'Asset/B', 'Asset/A/AChild']);

    const empty = registry.getNode('Asset/Group')!;
    expect(empty).not.toBeNull();
    expect(a.parent).toBe(empty);
    expect(b.parent).toBe(empty);
    expect(aChild.parent).toBe(a);
    expect(selected[selected.length - 1]).toBe('Asset/Group');

    a.updateMatrixWorld(true); b.updateMatrixWorld(true);
    expect(a.getWorldPosition(new Vector3()).distanceTo(aWorld)).toBeLessThan(1e-6);
    expect(b.getWorldPosition(new Vector3()).distanceTo(bWorld)).toBeLessThan(1e-6);

    // ONE undo reverts the whole grouping (create + 2 reparents).
    await doc.undo();
    expect(registry.getNode('Asset/Group')).toBeNull();
    expect(a.parent).toBe(model);
    expect(b.parent).toBe(model);
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });
});

describe('reparentNode reorder (sibling index — drag & drop)', () => {
  it('reorders a sibling within its parent to the given index; undo restores order', async () => {
    const { viewer, model, register } = makeMockViewer();
    addChild(model, 'A');
    addChild(model, 'B');
    addChild(model, 'C');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    // Move A to the last slot (index 2 = "after C" in the excluded array).
    const moved = await doc.reparentNodes(['Asset/A'], 'Asset', { index: 2 });
    expect(moved).toEqual(['Asset/A']);
    expect(model.children.map((c) => c.name)).toEqual(['B', 'C', 'A']);

    await doc.undo();
    expect(model.children.map((c) => c.name)).toEqual(['A', 'B', 'C']);
    doc.dispose();
  });

  it('same-parent reorder is one undo unit (no transaction wrapper for a single node)', async () => {
    const { viewer, model, register } = makeMockViewer();
    addChild(model, 'A');
    addChild(model, 'B');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    await doc.reparentNodes(['Asset/B'], 'Asset', { index: 0 });
    expect(model.children.map((c) => c.name)).toEqual(['B', 'A']);
    // A single undo (not two) puts it back — proves it emitted exactly one op.
    await doc.undo();
    expect(model.children.map((c) => c.name)).toEqual(['A', 'B']);
    doc.dispose();
  });

  it('reparents into a target at an explicit sibling index (drop between rows)', async () => {
    const { viewer, model, registry, register } = makeMockViewer();
    const a = addChild(model, 'A');
    const b = addChild(model, 'B');
    addChild(b, 'X');
    addChild(b, 'Y');
    addChild(a, 'Box');
    register();
    model.updateMatrixWorld(true);
    const doc = AssetDocument.newUntitled(viewer);

    await doc.reparentNodes(['Asset/A/Box'], 'Asset/B', { index: 0 });
    expect(b.children.map((c) => c.name)).toEqual(['Box', 'X', 'Y']);
    expect(registry.getNode('Asset/B/Box')).toBe(registry.getNode('Asset/B/Box'));
    expect(registry.getNode('Asset/A/Box')).toBeNull();
    doc.dispose();
  });

  it('moves a multi-node selection to an index as one undo unit, kept contiguous', async () => {
    const { viewer, model, register } = makeMockViewer();
    addChild(model, 'A');
    addChild(model, 'B');
    addChild(model, 'C');
    addChild(model, 'D');
    register();
    const doc = AssetDocument.newUntitled(viewer);

    // Drop B and D before A (index 0). Block lands contiguous at the front.
    await doc.reparentNodes(['Asset/B', 'Asset/D'], 'Asset', { index: 0 });
    expect(model.children.map((c) => c.name)).toEqual(['B', 'D', 'A', 'C']);

    await doc.undo();
    expect(model.children.map((c) => c.name)).toEqual(['A', 'B', 'C', 'D']);
    doc.dispose();
  });

  it('remaps signal-store paths for a moved subtree (name↔path stays consistent)', async () => {
    const { viewer, model, register } = makeMockViewer();
    const a = addChild(model, 'A');
    addChild(model, 'B');
    addChild(a, 'Box');
    register();
    model.updateMatrixWorld(true);
    let captured: Map<string, string> | null = null;
    (viewer as unknown as { signalStore: unknown }).signalStore = {
      remapPaths: (m: Map<string, string>) => { captured = m; return m.size; },
    };
    const doc = AssetDocument.newUntitled(viewer);

    await doc.reparentNodes(['Asset/A/Box'], 'Asset/B');
    expect(captured).not.toBeNull();
    expect(captured!.get('Asset/A/Box')).toBe('Asset/B/Box');
    doc.dispose();
  });
});

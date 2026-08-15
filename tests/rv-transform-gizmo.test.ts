// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Object3D, PerspectiveCamera, Scene } from 'three';
import { TransformGizmo, type TransformGizmoHost } from '../src/core/engine/rv-transform-gizmo';
import { HIGHLIGHT_OVERLAY_LAYER } from '../src/core/engine/rv-group-registry';
import { EditorTransformTool } from '@rv-private/plugins/asset-editor/EditorTransformTool';
import type { RVViewer } from '../src/core/rv-viewer';
import type { AssetDocument } from '../src/core/editor/rv-asset-document';

function makeHost(): { host: TransformGizmoHost; scene: Scene } {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.set(0, 0, 10);
  const host: TransformGizmoHost = {
    camera,
    renderer: { domElement: document.createElement('canvas') },
    scene,
    controls: { enabled: true },
    markRenderDirty: vi.fn(),
    markShadowsDirty: vi.fn(),
  };
  return { host, scene };
}

function gizmoRoot(scene: Scene): Object3D | null {
  return scene.getObjectByName('__rvTransformGizmo') ?? null;
}

function nodeAt(x: number, y: number, z: number, parent?: Object3D): Object3D {
  const n = new Object3D();
  n.position.set(x, y, z);
  (parent ?? new Scene()).add(n);
  n.updateMatrixWorld(true);
  return n;
}

const disposers: (() => void)[] = [];
afterEach(() => { for (const d of disposers.splice(0)) d(); });

describe('TransformGizmo', () => {
  it('attach(single) aligns the pivot to the node local frame', () => {
    const { host, scene } = makeHost();
    const g = new TransformGizmo(host);
    disposers.push(() => g.dispose());
    const node = nodeAt(1, 2, 3);
    node.rotateY(Math.PI / 2);
    node.updateMatrixWorld(true);
    g.attach([node]);
    const root = gizmoRoot(scene)!;
    expect(root.visible).toBe(true);
    expect(root.position.toArray()).toEqual([1, 2, 3]);
    expect(root.quaternion.angleTo(node.quaternion)).toBeCloseTo(0, 6);
  });

  it('attach(multi) pivots at the world centroid with world axes', () => {
    const { host, scene } = makeHost();
    const g = new TransformGizmo(host);
    disposers.push(() => g.dispose());
    const a = nodeAt(0, 0, 0);
    a.rotateZ(1); a.updateMatrixWorld(true);
    const b = nodeAt(2, 4, 6);
    g.attach([a, b]);
    const root = gizmoRoot(scene)!;
    expect(root.position.toArray()).toEqual([1, 2, 3]);
    expect(root.quaternion.toArray()).toEqual([0, 0, 0, 1]); // identity — world axes
  });

  it('detach hides the gizmo; re-attach shows it again', () => {
    const { host, scene } = makeHost();
    const g = new TransformGizmo(host);
    disposers.push(() => g.dispose());
    const node = nodeAt(0, 0, 0);
    g.attach([node]);
    expect(gizmoRoot(scene)!.visible).toBe(true);
    g.detach();
    expect(gizmoRoot(scene)!.visible).toBe(false);
    g.attach([node]);
    expect(gizmoRoot(scene)!.visible).toBe(true);
  });

  it('all gizmo objects live on HIGHLIGHT_OVERLAY_LAYER and carry _highlightOverlay', () => {
    const { host, scene } = makeHost();
    const g = new TransformGizmo(host);
    disposers.push(() => g.dispose());
    g.attach([nodeAt(0, 0, 0)]);
    const root = gizmoRoot(scene)!;
    let count = 0;
    root.traverse((o) => {
      count++;
      expect(o.layers.mask).toBe(1 << HIGHLIGHT_OVERLAY_LAYER);
      expect(o.userData._highlightOverlay).toBe(true);
    });
    expect(count).toBeGreaterThan(10); // arrows + rings + pickers + center
  });

  it('update() applies screen-constant scale and follows external node moves', () => {
    const { host, scene } = makeHost();
    const g = new TransformGizmo(host);
    disposers.push(() => g.dispose());
    const node = nodeAt(0, 0, 0);
    g.attach([node]);
    g.update();
    const root = gizmoRoot(scene)!;
    expect(root.scale.x).toBeCloseTo(10 * 0.115, 5); // camera at z=10
    // External move (undo/redo/inspector) — pivot follows on next update.
    node.position.set(5, 0, 0);
    node.updateMatrixWorld(true);
    g.update();
    expect(root.position.x).toBe(5);
  });

  it('dispose removes the gizmo from the scene', () => {
    const { host, scene } = makeHost();
    const g = new TransformGizmo(host);
    g.attach([nodeAt(0, 0, 0)]);
    g.dispose();
    expect(gizmoRoot(scene)).toBeNull();
  });
});

// ── EditorTransformTool selection sync (fake viewer/doc) ──────────────

interface FakeSelection {
  selectedPaths: string[];
  listeners: Set<() => void>;
}

function makeToolFixture() {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.set(0, 0, 10);
  const assetRoot = new Object3D();
  assetRoot.name = 'Asset';
  scene.add(assetRoot);

  const nodes = new Map<string, Object3D>();
  const addNode = (path: string, x: number, parent?: Object3D) => {
    const n = new Object3D();
    n.name = path.split('/').pop()!;
    n.position.set(x, 0, 0);
    (parent ?? assetRoot).add(n);
    n.updateMatrixWorld(true);
    nodes.set(path, n);
    return n;
  };

  const sel: FakeSelection = { selectedPaths: [], listeners: new Set() };
  const viewer = {
    camera,
    renderer: { domElement: document.createElement('canvas') },
    scene,
    controls: { enabled: true },
    markRenderDirty: vi.fn(),
    markShadowsDirty: vi.fn(),
    currentModelRoot: assetRoot,
    registry: {
      getNode: (p: string) => (p === 'Asset' ? assetRoot : nodes.get(p) ?? null),
      getPathForNode: (n: Object3D) => {
        if (n === assetRoot) return 'Asset';
        for (const [p, node] of nodes) if (node === n) return p;
        return null;
      },
    },
    selectionManager: {
      get selectedPaths() { return sel.selectedPaths; },
      subscribe: (fn: () => void) => { sel.listeners.add(fn); return () => sel.listeners.delete(fn); },
    },
  } as unknown as RVViewer;

  const select = (paths: string[]) => {
    sel.selectedPaths = paths;
    for (const fn of sel.listeners) fn();
  };

  const doc = { transformNode: vi.fn(), withTransaction: vi.fn(), applyOp: vi.fn() } as unknown as AssetDocument;
  return { viewer, scene, addNode, select, doc };
}

describe('EditorTransformTool selection sync', () => {
  it('attaches on single select, pivots multi-select at the centroid', () => {
    const { viewer, scene, addNode, select, doc } = makeToolFixture();
    addNode('Asset/A', 0);
    addNode('Asset/B', 4);
    const tool = new EditorTransformTool(viewer, doc);
    tool.install();
    disposers.push(() => tool.uninstall());

    select(['Asset/A']);
    const root = gizmoRoot(scene)!;
    expect(root.visible).toBe(true);
    expect(root.position.x).toBe(0);

    select(['Asset/A', 'Asset/B']);
    expect(root.visible).toBe(true);
    expect(root.position.x).toBe(2); // centroid

    select([]);
    expect(root.visible).toBe(false);
  });

  it('excludes the asset root and prunes descendants of selected ancestors', () => {
    const { viewer, scene, addNode, select, doc } = makeToolFixture();
    const parent = addNode('Asset/P', 6);
    addNode('Asset/P/C', 2, parent); // child world x = 8
    const tool = new EditorTransformTool(viewer, doc);
    tool.install();
    disposers.push(() => tool.uninstall());

    // Root alone → nothing to attach.
    select(['Asset']);
    expect(gizmoRoot(scene)?.visible ?? false).toBe(false);

    // Parent + child → child pruned, single-node pivot at the parent.
    select(['Asset/P', 'Asset/P/C']);
    const root = gizmoRoot(scene)!;
    expect(root.visible).toBe(true);
    expect(root.position.x).toBe(6);
  });
});

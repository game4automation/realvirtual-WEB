// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Plan-191: LayoutObject expand & Behavior Properties — integration tests.
 *
 * Validates that placed LayoutObjects become expandable in the hierarchy
 * panel, their internal drives/sensors/meshes are discoverable in
 * NodeRegistry, mesh-only children render as selectable rows, the
 * ancestor-resolution differentiates viewport vs tree clicks, the
 * Locked flag blocks sub-edits, and overlay sub-paths are purged on
 * deletion.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Object3D } from 'three';
import { flattenSceneRows, type SceneRowContext, type SceneTreeNode } from '../src/core/hmi/hierarchy-rows';
import { RvExtrasEditorPlugin } from '../src/core/hmi/rv-extras-editor';
import {
  makeLayoutTestViewer,
  makeMockLayoutGLB,
  placeLayoutObject,
  registerSubtreePaths,
  unplaceLayoutObject,
  type LayoutTestViewer,
} from './helpers/test-layout-object';

/**
 * Build the `editableNodes` array the way the rv-extras-editor plugin would
 * produce it, by walking the scene's userData.realvirtual entries.
 */
function collectEditableNodes(viewer: LayoutTestViewer) {
  const nodes: { path: string; types: string[] }[] = [];
  viewer.scene.traverse((node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    const types: string[] = [];
    for (const [k, v] of Object.entries(rv)) {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) types.push(k);
    }
    if (types.length === 0) return;
    const path = viewer.registry.getPathForNode(node);
    if (!path) return;
    nodes.push({ path, types });
  });
  nodes.sort((a, b) => a.path.localeCompare(b.path));
  return nodes;
}

/**
 * The hierarchy rows the panel would render (plan-754): the scene graph itself,
 * walked only into what is expanded. Replaces `buildTree` + lazy injection —
 * there is nothing to inject, the children were always there.
 */
function sceneRows(viewer: LayoutTestViewer, expanded: Iterable<string> = []) {
  const scene = viewer.scene as unknown as Object3D;
  const ctx: SceneRowContext = {
    getPathForNode: (n: Object3D) => viewer.registry.getPathForNode(n) ?? null,
    overlay: null,
    modelRoot: (viewer as { currentModelRoot?: Object3D | null }).currentModelRoot ?? null,
    hideRuntime: false,
  };
  // The scene root itself is never registered, so it has no path key — expand it
  // by uuid, the way the panel's "root starts open" default does.
  return flattenSceneRows(scene, new Set([scene.uuid, ...expanded]), ctx)
    .map((r) => r.node as SceneTreeNode);
}

/** Rows strictly below `path` (its subtree, as currently rendered). */
function rowsUnder(rows: SceneTreeNode[], path: string): SceneTreeNode[] {
  return rows.filter((r) => !!r.path && r.path.startsWith(path + '/'));
}

describe('plan-191: LayoutObject expand', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // §9.1 — expanding a placed LayoutObject (plan-754: the scene graph) ──

  describe('LayoutObject expansion', () => {
    it('shows no descendants while collapsed, but advertises the caret', () => {
      // A placed layout object has BOTH rv_extras children (Drive, Sensor) and
      // mesh-only children (Mesh1/Mesh2). Collapsed, none of them is a row;
      // the parent row still reports `hasChildren` so the caret renders.
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RollConveyor2m', 'cat:rc');

      const collapsed = sceneRows(viewer, ['modelRoot']);
      const layoutRow = collapsed.find((r) => r.types.includes('LayoutObject'));
      expect(layoutRow).toBeDefined();
      expect(layoutRow!.hasChildren).toBe(true);
      expect(rowsUnder(collapsed, 'modelRoot/RollConveyor2m')).toHaveLength(0);

      // Expanded: the real children — components AND bare meshes — are rows.
      const expanded = sceneRows(viewer, ['modelRoot', 'modelRoot/RollConveyor2m']);
      const children = rowsUnder(expanded, 'modelRoot/RollConveyor2m');
      expect(children.filter((c) => c.types.length === 0).length).toBeGreaterThan(0);
    });

    it('surfaces the inner Drive and Sensor when expanded', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RollConveyor2m', 'cat:rc');

      const rows = rowsUnder(
        sceneRows(viewer, ['modelRoot', 'modelRoot/RollConveyor2m']),
        'modelRoot/RollConveyor2m',
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((c) => c.types.includes('Drive'))).toBe(true);
      expect(rows.some((c) => c.types.includes('Sensor'))).toBe(true);
    });

    it('renders mesh-only children with types=[] under an expanded LayoutObject (§9.4)', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');

      const children = rowsUnder(sceneRows(viewer, ['modelRoot', 'modelRoot/RC']), 'modelRoot/RC');
      const meshOnly = children.filter((c) => c.types.length === 0);
      expect(meshOnly.length).toBeGreaterThanOrEqual(1);
    });
  });

  // §9.3 — Layout-Planner NodeRegistry registration ─────────────────────

  describe('Layout-Planner NodeRegistry registration', () => {
    it('exposes inner rv_extras nodes after place (§9.3)', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const root = viewer.registry.getNode('modelRoot/RC');
      expect(root).toBeDefined();
      const drive = viewer.registry.getNode('modelRoot/RC/Drive-Lin-X');
      expect(drive).not.toBeNull();
    });

    it('registers mesh-only descendants too (so tree-injection finds them via dedup)', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      // Mesh1 / Mesh2 are mesh-only — also indexed by registerSubtreePaths
      expect(viewer.registry.getNode('modelRoot/RC/Mesh1')).not.toBeNull();
    });
  });

  // §9.2 — Sub-Drive overlay editing ────────────────────────────────────

  describe('Sub-component overlay editing', () => {
    it('updates sub-drive speed via updateOverlayField (§9.2)', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const subPath = 'modelRoot/RC/Drive-Lin-X';
      const ok = viewer.rvExtrasEditor.updateOverlayField(subPath, 'Drive', 'TargetSpeed', 250);
      expect(ok).toBe(true);
      const node = viewer.registry.getNode(subPath);
      const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      expect(rv?.Drive?.TargetSpeed).toBe(250);
    });
  });

  // §9.7 — Locked-Flag blocks sub-edits ─────────────────────────────────

  describe('Locked LayoutObject blocks sub-edits (§9.7)', () => {
    it('updateOverlayField returns false when ancestor is Locked', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const root = viewer.registry.getNode('modelRoot/RC');
      const rv = root!.userData.realvirtual as Record<string, Record<string, unknown>>;
      rv.LayoutObject.Locked = true;

      const subPath = 'modelRoot/RC/Drive-Lin-X';
      const before = (viewer.registry.getNode(subPath)!.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed;
      const ok = viewer.rvExtrasEditor.updateOverlayField(subPath, 'Drive', 'TargetSpeed', 999);
      expect(ok).toBe(false);
      const after = (viewer.registry.getNode(subPath)!.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed;
      expect(after).toBe(before);
    });

    it('still allows editing the LayoutObject root itself when Locked=true', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const root = viewer.registry.getNode('modelRoot/RC');
      const rv = root!.userData.realvirtual as Record<string, Record<string, unknown>>;
      rv.LayoutObject.Locked = true;
      const ok = viewer.rvExtrasEditor.updateOverlayField('modelRoot/RC', 'LayoutObject', 'Locked', false);
      expect(ok).toBe(true);
      // The planner hears the lock change directly (no live component behind LayoutObject).
      expect(viewer._emitted).toContainEqual({ event: 'layout-lock-changed', payload: { path: 'modelRoot/RC', locked: false } });
    });
  });

  // §9.8 — selectNode source differentiation ────────────────────────────

  describe('selectNode source differentiation (§9.8)', () => {
    it("source='viewport' resolves a sub-path up to the LayoutObject ancestor", () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      viewer.rvExtrasEditor.selectNode('modelRoot/RC/Drive-Lin-X', false, 'viewport');
      expect(viewer.rvExtrasEditor.getSelectedPath()).toBe('modelRoot/RC');
    });

    it("source='tree' keeps the explicit sub-path", () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      viewer.rvExtrasEditor.selectNode('modelRoot/RC/Drive-Lin-X', false, 'tree');
      expect(viewer.rvExtrasEditor.getSelectedPath()).toBe('modelRoot/RC/Drive-Lin-X');
    });

    it("source='api' (default) keeps the explicit sub-path", () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      viewer.rvExtrasEditor.selectNode('modelRoot/RC/Drive-Lin-X');
      expect(viewer.rvExtrasEditor.getSelectedPath()).toBe('modelRoot/RC/Drive-Lin-X');
    });

    it("legacy two-arg form selectNode(path, true) still works", () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      viewer.rvExtrasEditor.selectNode('modelRoot/RC/Drive-Lin-X', true);
      const snap = viewer.rvExtrasEditor.getSnapshot();
      expect(snap.selectedNodePath).toBe('modelRoot/RC/Drive-Lin-X');
      expect(snap.showInspector).toBe(true);
    });
  });

  // §9.9 — Op-log cleanup on delete ─────────────────────────────────────

  describe('Sub-overlay cleanup on LayoutObject delete (§9.9)', () => {
    it('purgeOverlaysForSubtree removes prefix and sub-path entries', () => {
      const editor = new RvExtrasEditorPlugin();
      // Seed the legacy in-memory overlay directly via the public mutator
      // (no scene store wired → legacy path).
      // We can't easily hit the boot path without a glbName so we
      // simulate by calling updateOverlayField on a stub viewer.
      const stub = {
        registry: {
          getNode: () => ({ userData: { realvirtual: { Drive: { Speed: 0 } } } }),
          getPathForNode: () => null,
        },
      } as unknown as { registry: unknown };
      (editor as unknown as { _viewer: unknown })._viewer = stub;

      // No SceneStore: legacy path writes into _overlay directly
      editor.updateOverlayField('RC', 'LayoutObject', 'Label', 'X');
      editor.updateOverlayField('RC/Drive-Lin-X', 'Drive', 'TargetSpeed', 250);
      editor.updateOverlayField('Other', 'Drive', 'TargetSpeed', 999);

      const removed = editor.purgeOverlaysForSubtree('RC');
      expect(removed).toBeGreaterThanOrEqual(2);
      const snap = editor.getSnapshot();
      // 'Other' must remain
      expect(snap.overlay?.nodes['Other']).toBeDefined();
      expect(snap.overlay?.nodes['RC']).toBeUndefined();
      expect(snap.overlay?.nodes['RC/Drive-Lin-X']).toBeUndefined();
    });

    it('removePlacedFromScene triggers overlay purge via editor plugin hook', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      viewer.rvExtrasEditor.updateOverlayField('modelRoot/RC/Drive-Lin-X', 'Drive', 'TargetSpeed', 250);
      // Snapshot the editor's view of the overlay
      const before = viewer.rvExtrasEditor.getSnapshot();
      expect(before.overlay?.nodes['modelRoot/RC/Drive-Lin-X']).toBeDefined();

      unplaceLayoutObject(viewer, 'id1');

      const after = viewer.rvExtrasEditor.getSnapshot();
      expect(after.overlay?.nodes?.['modelRoot/RC/Drive-Lin-X']).toBeUndefined();
    });
  });

  // §9.10 — Path sanitization ───────────────────────────────────────────

  describe('Node names containing "/" (§9.10)', () => {
    it('shows a child whose NAME contains a slash, addressed by the registry', () => {
      // The projection used to invent a path per injected child and sanitize
      // `Door/Frame` into `Door_Frame` on the way. There is no invented path any
      // more (plan-754): the row IS the object, and whatever path the registry
      // holds for it is the row's path — one rule instead of two.
      const viewer = makeLayoutTestViewer();
      const glb = makeMockLayoutGLB({
        rootName: 'Item',
        children: [{ name: 'Door/Frame' }],
      });
      placeLayoutObject(viewer, 'id1', 'Item', 'cat:item', glb);

      const children = rowsUnder(sceneRows(viewer, ['modelRoot', 'modelRoot/Item']), 'modelRoot/Item');
      const child = children.find((c) => c.object.name === 'Door/Frame');
      expect(child).toBeDefined();
      expect(child!.path).toBe(viewer.registry.getPathForNode(child!.object));
    });
  });

  // §9.11 — Performance: the walk is bounded by what is OPEN ────────────

  describe('Performance', () => {
    it('flattens a large expanded LayoutObject (50+ mesh children) under 50ms', () => {
      const viewer = makeLayoutTestViewer();
      const glb = makeMockLayoutGLB({ rootName: 'Big', meshes: 50 });
      placeLayoutObject(viewer, 'id1', 'Big', 'cat:big', glb);
      const t0 = performance.now();
      sceneRows(viewer, ['modelRoot', 'modelRoot/Big']);
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(50);
    });

    it('collapsed, the walk never enters the closed subtree at all', () => {
      const viewer = makeLayoutTestViewer();
      const glb = makeMockLayoutGLB({ rootName: 'Big', meshes: 100 });
      placeLayoutObject(viewer, 'id1', 'Big', 'cat:big', glb);

      const collapsed = sceneRows(viewer, ['modelRoot']);
      // 100 meshes are in the graph; none of them costs a row while closed.
      expect(rowsUnder(collapsed, 'modelRoot/Big')).toHaveLength(0);
      const expanded = sceneRows(viewer, ['modelRoot', 'modelRoot/Big']);
      expect(expanded.length).toBeGreaterThan(collapsed.length + 50);
    });
  });

  // §9.6 — Expand state persistence (direct LS) ─────────────────────────

  describe('Expand state persistence (§9.6)', () => {
    it('serialises a LayoutObject path through rv-hierarchy-expanded LS key', () => {
      const key = 'rv-hierarchy-expanded';
      const expanded = new Set(['modelRoot/RC']);
      localStorage.setItem(key, JSON.stringify([...expanded]));
      const loaded = new Set<string>(JSON.parse(localStorage.getItem(key) ?? '[]') as string[]);
      expect(loaded.has('modelRoot/RC')).toBe(true);
    });
  });

  // §9.5 — Filter behaviour with sub-drives ─────────────────────────────

  describe('Filter behaviour (§9.5)', () => {
    it('flat editableNodes view includes sub-drives once processExtras-registered', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const nodes = collectEditableNodes(viewer);
      const hasSubDrive = nodes.some(
        (n) => n.types.includes('Drive') && n.path.startsWith('modelRoot/RC/'),
      );
      expect(hasSubDrive).toBe(true);
    });

    it('tree-expanded view of an "all"-filter tree surfaces sub-drives', () => {
      const viewer = makeLayoutTestViewer();
      placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
      const types = new Set(sceneRows(viewer, ['modelRoot', 'modelRoot/RC']).flatMap((r) => r.types));
      expect(types).toContain('Drive');
      expect(types).toContain('Sensor');
    });
  });
});

// ─── findLayoutObjectAncestor ─────────────────────────────────────────────

describe('findLayoutObjectAncestor', () => {
  it('returns the LayoutObject root for a mesh-only sub-path', () => {
    const viewer = makeLayoutTestViewer();
    placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
    const ancestor = viewer.rvExtrasEditor.findLayoutObjectAncestor('modelRoot/RC/Mesh1');
    expect(ancestor).toBe('modelRoot/RC');
  });

  it('returns the path itself when called on a LayoutObject root', () => {
    const viewer = makeLayoutTestViewer();
    placeLayoutObject(viewer, 'id1', 'RC', 'cat:rc');
    const ancestor = viewer.rvExtrasEditor.findLayoutObjectAncestor('modelRoot/RC');
    expect(ancestor).toBe('modelRoot/RC');
  });

  it('returns null when no LayoutObject is in the ancestry', () => {
    const viewer = makeLayoutTestViewer();
    // modelRoot is not a LayoutObject
    const ancestor = viewer.rvExtrasEditor.findLayoutObjectAncestor('modelRoot');
    expect(ancestor).toBeNull();
  });
});

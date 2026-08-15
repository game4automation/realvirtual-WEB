// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for RvExtrasEditorPlugin
 *
 * Validates plugin lifecycle: onModelLoaded collects nodes,
 * selectNode/clearSelection state updates, and onModelCleared reset.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RvExtrasEditorPlugin, type EditableNodeInfo } from '../src/core/hmi/rv-extras-editor';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';

// ─── Minimal mocks ──────────────────────────────────────────────────────

/** Create a mock Object3D-like node with userData.realvirtual */
function makeNode(name: string, parent: any, rvData?: Record<string, unknown>) {
  const node: any = {
    name,
    parent,
    children: [],
    userData: {} as Record<string, unknown>,
  };
  if (rvData) {
    node.userData.realvirtual = rvData;
  }
  if (parent) {
    parent.children.push(node);
  }
  return node;
}

/** Create a mock scene with nodes and a registry */
function makeScene() {
  // Build a small hierarchy:
  //   scene
  //     DemoCell
  //       Conveyor1  (Drive, TransportSurface)
  //       Conveyor2  (Drive)
  //       Sensor1    (Sensor)
  //       Source1    (Source)
  const scene: any = { name: 'Scene', parent: null, children: [], userData: {} };

  const demoCell = makeNode('DemoCell', scene);
  const conv1 = makeNode('Conveyor1', demoCell, {
    Drive: { TargetSpeed: 100, Acceleration: 50 },
    TransportSurface: { TransportDirection: 'X' },
  });
  const conv2 = makeNode('Conveyor2', demoCell, {
    Drive: { TargetSpeed: 200 },
  });
  const sensor1 = makeNode('Sensor1', demoCell, {
    Sensor: { UseRaycast: true },
  });
  const source1 = makeNode('Source1', demoCell, {
    Source: { AutomaticGeneration: true, Interval: 5 },
  });

  // Collect all nodes for scene.traverse
  const allNodes = [scene, demoCell, conv1, conv2, sensor1, source1];
  scene.traverse = (fn: (node: any) => void) => {
    for (const n of allNodes) fn(n);
  };

  // Build a simple registry
  const nodePaths = new Map<any, string>();
  nodePaths.set(demoCell, 'DemoCell');
  nodePaths.set(conv1, 'DemoCell/Conveyor1');
  nodePaths.set(conv2, 'DemoCell/Conveyor2');
  nodePaths.set(sensor1, 'DemoCell/Sensor1');
  nodePaths.set(source1, 'DemoCell/Source1');

  const registry = {
    getPathForNode: (node: any) => nodePaths.get(node) ?? null,
  };

  return { scene, registry, allNodes };
}

/** Create a mock viewer */
function makeMockViewer(scene: any, registry: any) {
  const plugins = new Map<string, any>();
  return {
    scene,
    currentModelUrl: './models/demo.glb',
    getPlugin: <T>(id: string): T | undefined => plugins.get(id) as T | undefined,
    _registerPlugin: (p: any) => plugins.set(p.id, p),
    on: (_event: string, _handler: (...args: any[]) => void) => () => {},
    leftPanelManager: new LeftPanelManager(),
    contextMenu: { register: vi.fn() },
    selectionManager: { selectedPaths: [], count: 0, isSelected: () => false },
  };
}

/** Create a mock LoadResult */
function makeLoadResult(registry: any) {
  return {
    registry,
    drives: [],
    transportManager: null,
    signalStore: null,
    playback: null,
    replayRecordings: [],
    recorderSettings: null,
    logicEngine: null,
    boundingBox: null,
    triangleCount: 0,
  };
}

describe('RvExtrasEditorPlugin', () => {
  let plugin: RvExtrasEditorPlugin;

  beforeEach(() => {
    localStorage.clear();
    plugin = new RvExtrasEditorPlugin();
  });

  it('has correct plugin id', () => {
    expect(plugin.id).toBe('rv-extras-editor');
  });

  it('has no UI slots (UI is in TopBar)', () => {
    // The hierarchy button now lives in TopBar, not in a slot
    expect((plugin as unknown as Record<string, unknown>).slots).toBeUndefined();
  });

  it('onModelLoaded collects editable nodes correctly', () => {
    const { scene, registry } = makeScene();
    const viewer = makeMockViewer(scene, registry);
    const result = makeLoadResult(registry);

    plugin.onModelLoaded(result as any, viewer as any);

    const state = plugin.getSnapshot();
    expect(state.editableNodes.length).toBe(4); // Conveyor1, Conveyor2, Sensor1, Source1

    // Check paths are sorted
    const paths = state.editableNodes.map((n: EditableNodeInfo) => n.path);
    expect(paths).toEqual([
      'DemoCell/Conveyor1',
      'DemoCell/Conveyor2',
      'DemoCell/Sensor1',
      'DemoCell/Source1',
    ]);

    // Check types
    const conv1 = state.editableNodes.find((n: EditableNodeInfo) => n.path === 'DemoCell/Conveyor1');
    expect(conv1).toBeDefined();
    expect(conv1!.types).toContain('Drive');
    expect(conv1!.types).toContain('TransportSurface');

    const sensor = state.editableNodes.find((n: EditableNodeInfo) => n.path === 'DemoCell/Sensor1');
    expect(sensor).toBeDefined();
    expect(sensor!.types).toEqual(['Sensor']);
  });

  it('lists editor-created empty nodes (__rvAdded) with no rv_extras', () => {
    // Reproduces the "Empty at Root" hierarchy bug: a freshly created empty
    // carries only the __rvAdded marker (no userData.realvirtual), so the
    // component-only scan used to drop it and it never appeared in the tree.
    const scene: any = { name: 'Scene', parent: null, children: [], userData: {} };
    const demoCell = makeNode('DemoCell', scene);
    const conv1 = makeNode('Conveyor1', demoCell, { Drive: { TargetSpeed: 100 } });
    const empty = makeNode('Empty', demoCell); // no rv extras
    empty.userData.__rvAdded = true;
    const plainStructural = makeNode('PlainGroup', demoCell); // neither extras nor __rvAdded

    const allNodes = [scene, demoCell, conv1, empty, plainStructural];
    scene.traverse = (fn: (n: any) => void) => { for (const n of allNodes) fn(n); };

    const nodePaths = new Map<any, string>([
      [demoCell, 'DemoCell'],
      [conv1, 'DemoCell/Conveyor1'],
      [empty, 'DemoCell/Empty'],
      [plainStructural, 'DemoCell/PlainGroup'],
    ]);
    const registry = { getPathForNode: (n: any) => nodePaths.get(n) ?? null };

    const viewer = makeMockViewer(scene, registry);
    plugin.onModelLoaded(makeLoadResult(registry) as any, viewer as any);

    const nodes = plugin.getSnapshot().editableNodes;
    const emptyInfo = nodes.find((n: EditableNodeInfo) => n.path === 'DemoCell/Empty');
    expect(emptyInfo).toBeDefined();
    expect(emptyInfo!.types).toEqual([]); // structural node — no component types
    // The real component node is still listed…
    expect(nodes.some((n: EditableNodeInfo) => n.path === 'DemoCell/Conveyor1')).toBe(true);
    // …but a plain structural node without the __rvAdded marker is NOT.
    expect(nodes.some((n: EditableNodeInfo) => n.path === 'DemoCell/PlainGroup')).toBe(false);
  });

  it('selectNode updates selectedNodePath', () => {
    expect(plugin.getSnapshot().selectedNodePath).toBeNull();

    plugin.selectNode('DemoCell/Conveyor1');
    expect(plugin.getSnapshot().selectedNodePath).toBe('DemoCell/Conveyor1');
  });

  it('clearSelection resets selectedNodePath', () => {
    plugin.selectNode('DemoCell/Conveyor1');
    expect(plugin.getSnapshot().selectedNodePath).toBe('DemoCell/Conveyor1');

    plugin.clearSelection();
    expect(plugin.getSnapshot().selectedNodePath).toBeNull();
  });

  it('togglePanel toggles panelOpen', () => {
    expect(plugin.getSnapshot().panelOpen).toBe(false);

    plugin.togglePanel();
    expect(plugin.getSnapshot().panelOpen).toBe(true);

    plugin.togglePanel();
    expect(plugin.getSnapshot().panelOpen).toBe(false);
  });

  it('onModelCleared resets all state', () => {
    const { scene, registry } = makeScene();
    const viewer = makeMockViewer(scene, registry);
    const result = makeLoadResult(registry);

    plugin.onModelLoaded(result as any, viewer as any);
    plugin.selectNode('DemoCell/Conveyor1');

    expect(plugin.getSnapshot().editableNodes.length).toBe(4);
    expect(plugin.getSnapshot().selectedNodePath).toBe('DemoCell/Conveyor1');

    plugin.onModelCleared();

    const state = plugin.getSnapshot();
    expect(state.editableNodes.length).toBe(0);
    expect(state.selectedNodePath).toBeNull();
    expect(state.overlay).toBeNull();
  });

  it('subscribe/notify triggers listeners', () => {
    let callCount = 0;
    const unsub = plugin.subscribe(() => { callCount++; });

    plugin.togglePanel();
    expect(callCount).toBe(1);

    plugin.selectNode('test');
    expect(callCount).toBe(2);

    unsub();
    plugin.togglePanel();
    expect(callCount).toBe(2); // Should not increment after unsubscribe
  });

  it('loads overlay from localStorage when model has matching key', () => {
    // Pre-save an overlay
    const overlay = {
      $schema: 'rv-extras-overlay/1.0',
      $source: 'test',
      nodes: {
        'DemoCell/Conveyor1': {
          Drive: { TargetSpeed: 999 },
        },
      },
    };
    localStorage.setItem('rv-extras-overlay:demo.glb', JSON.stringify(overlay));

    const { scene, registry } = makeScene();
    const viewer = makeMockViewer(scene, registry);
    const result = makeLoadResult(registry);

    plugin.onModelLoaded(result as any, viewer as any);

    const state = plugin.getSnapshot();
    expect(state.overlay).not.toBeNull();
    expect(state.overlay!.nodes['DemoCell/Conveyor1']['Drive']['TargetSpeed']).toBe(999);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The optimistic overlay has to shrink as well as grow (plan-703, Lauf 12).
//
// `updateOverlayField` writes the entry synchronously so the inspector marks
// the field immediately; the op it queues is deferred. On the SceneStore path a
// later subscription re-materialises the truth, but inside the asset editor the
// document is an `AssetDocument` and nothing re-materialises — so before this,
// the cache only ever GREW: a reverted field stayed marked as overridden until
// the next model load, and the descend hint (which now counts the same entries)
// announced suppressions that were no longer there.
// ─────────────────────────────────────────────────────────────────────────

describe('RvExtrasEditorPlugin — optimistischer Overlay-Eintrag verschwindet beim Revert', () => {
  /** One node with a Drive, plus a registry that can resolve it by path. */
  function makeEditableViewer() {
    const node: any = { name: 'Widget', parent: null, children: [], userData: {} };
    node.userData.realvirtual = { Drive: { TargetSpeed: 100, Acceleration: 50 } };
    const registry = { getNode: (p: string) => (p === 'Cell/Widget' ? node : null) };
    return { viewer: { registry, scene: { children: [node] } }, node };
  }

  /** An EditTarget that only records — the op queue is not what is under test. */
  function recordingTarget(): { target: EditTarget; unset: string[] } {
    const unset: string[] = [];
    return {
      unset,
      target: {
        available: true,
        setField: () => {},
        unsetField: (nodePath, componentType, fieldName) => {
          unset.push(`${nodePath}/${componentType}/${fieldName}`);
        },
        async withTransaction(_label, fn) { await fn(); },
      },
    };
  }

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    setActiveEditTarget(null);
  });

  it('resetField loescht den Eintrag, den updateOverlayField optimistisch schrieb', () => {
    const plugin = new RvExtrasEditorPlugin();
    const { viewer } = makeEditableViewer();
    (plugin as unknown as { _viewer: unknown })._viewer = viewer;
    const { target, unset } = recordingTarget();
    setActiveEditTarget(target);

    plugin.updateOverlayField('Cell/Widget', 'Drive', 'TargetSpeed', 999);
    expect(plugin.getSnapshot().overlay!.nodes['Cell/Widget'].Drive.TargetSpeed).toBe(999);

    plugin.resetField('Cell/Widget', 'Drive', 'TargetSpeed');

    // The op still goes out — the prune is a cache correction, not a substitute.
    expect(unset).toEqual(['Cell/Widget/Drive/TargetSpeed']);
    expect(plugin.getSnapshot().overlay!.nodes['Cell/Widget']).toBeUndefined();
  });

  it('ein zweites ueberschriebenes Feld derselben Komponente bleibt stehen', () => {
    const plugin = new RvExtrasEditorPlugin();
    const { viewer } = makeEditableViewer();
    (plugin as unknown as { _viewer: unknown })._viewer = viewer;
    setActiveEditTarget(recordingTarget().target);

    plugin.updateOverlayField('Cell/Widget', 'Drive', 'TargetSpeed', 999);
    plugin.updateOverlayField('Cell/Widget', 'Drive', 'Acceleration', 7);
    plugin.resetField('Cell/Widget', 'Drive', 'TargetSpeed');

    const drive = plugin.getSnapshot().overlay!.nodes['Cell/Widget'].Drive;
    expect(drive.TargetSpeed).toBeUndefined();
    expect(drive.Acceleration).toBe(7);
  });

  it('resetComponent raeumt die ganze Komponente ab', () => {
    const plugin = new RvExtrasEditorPlugin();
    const { viewer } = makeEditableViewer();
    (plugin as unknown as { _viewer: unknown })._viewer = viewer;
    const { target, unset } = recordingTarget();
    setActiveEditTarget(target);

    plugin.updateOverlayField('Cell/Widget', 'Drive', 'TargetSpeed', 999);
    plugin.updateOverlayField('Cell/Widget', 'Drive', 'Acceleration', 7);
    plugin.resetComponent('Cell/Widget', 'Drive');

    expect(unset).toHaveLength(2);
    expect(plugin.getSnapshot().overlay!.nodes['Cell/Widget']).toBeUndefined();
  });

  it('resetNode raeumt den ganzen Knoten ab', () => {
    const plugin = new RvExtrasEditorPlugin();
    const { viewer } = makeEditableViewer();
    (plugin as unknown as { _viewer: unknown })._viewer = viewer;
    setActiveEditTarget(recordingTarget().target);

    plugin.updateOverlayField('Cell/Widget', 'Drive', 'TargetSpeed', 999);
    plugin.resetNode('Cell/Widget');

    expect(plugin.getSnapshot().overlay!.nodes['Cell/Widget']).toBeUndefined();
  });
});

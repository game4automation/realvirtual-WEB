// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for LayoutPlannerPlugin Lifecycle — verify _layoutRoot survives model changes.
 *
 * Uses a minimal viewer mock following rv-plugin-lifecycle.test.ts pattern.
 */
import { describe, test, expect, vi } from 'vitest';
import { Group, PerspectiveCamera } from 'three';
import { LayoutPlannerPlugin } from '../../realvirtual-WebViewer-Private~/src/plugins/layout-planner';

// Minimal viewer mock
function createMockViewer() {
  const scene = new Group();
  const sceneFixtures = new Set<any>();
  return {
    scene,
    sceneFixtures,
    camera: new PerspectiveCamera(),
    controls: { enabled: true },
    raycastManager: {
      addExcludeFilter: vi.fn(),
      addAncestorOverride: vi.fn(),
      removeAncestorOverride: vi.fn(),
      updateTargets: vi.fn(),
    },
    leftPanelManager: { open: vi.fn(), close: vi.fn() },
    markRenderDirty: vi.fn(),
    fitToNodes: vi.fn(),
    highlighter: { highlight: vi.fn(), clear: vi.fn() },
    renderer: { domElement: document.createElement('canvas') },
    on: vi.fn(() => vi.fn()),
    getPlugin: vi.fn(),
    currentModel: null,
    signalStore: null,
    transportManager: null,
    registry: null,
    drives: [],
  };
}

describe('LayoutPlannerPlugin Lifecycle', () => {
  test('onModelLoaded adds _layoutRoot to scene and sceneFixtures', () => {
    const viewer = createMockViewer();
    const plugin = new LayoutPlannerPlugin();
    plugin.onModelLoaded?.({ scene: new Group() } as any, viewer as any);
    // _layoutRoot should be in the scene
    const layoutRoot = viewer.scene.children.find(c => c.userData._isLayoutRoot);
    expect(layoutRoot).toBeDefined();
    expect(viewer.sceneFixtures.has(layoutRoot)).toBe(true);
  });

  test('onModelLoaded called twice does not duplicate _layoutRoot', () => {
    const viewer = createMockViewer();
    const plugin = new LayoutPlannerPlugin();
    plugin.onModelLoaded?.({ scene: new Group() } as any, viewer as any);
    plugin.onModelLoaded?.({ scene: new Group() } as any, viewer as any);
    const layoutRoots = viewer.scene.children.filter(c => c.userData._isLayoutRoot);
    expect(layoutRoots).toHaveLength(1);
  });

  test('placed objects survive onModelCleared', () => {
    const viewer = createMockViewer();
    const plugin = new LayoutPlannerPlugin();
    plugin.onModelLoaded?.({ scene: new Group() } as any, viewer as any);
    // Add a placed component
    plugin.store.addComponent({ id: '1', catalogId: 'belt', glbUrl: 'https://example.com/belt.glb', label: 'Belt', position: [0,0,0], rotation: [0,0,0], scale: [1,1,1] });
    // Simulate model clear
    plugin.onModelCleared?.(viewer as any);
    // Layout state should be preserved
    expect(plugin.store.getSnapshot().placed).toHaveLength(1);
    // _layoutRoot should still be in scene (sceneFixtures protects it)
    const layoutRoot = viewer.scene.children.find(c => c.userData._isLayoutRoot);
    expect(layoutRoot).toBeDefined();
  });

  test('dispose removes _layoutRoot from scene', () => {
    const viewer = createMockViewer();
    const plugin = new LayoutPlannerPlugin();
    plugin.onModelLoaded?.({ scene: new Group() } as any, viewer as any);
    plugin.dispose?.();
    const layoutRoot = viewer.scene.children.find(c => c.userData._isLayoutRoot);
    expect(layoutRoot).toBeUndefined();
  });

  test('plugin has correct id and order', () => {
    const plugin = new LayoutPlannerPlugin();
    expect(plugin.id).toBe('layout-planner');
    expect(plugin.order).toBe(250);
  });

  test('store is accessible on plugin instance', () => {
    const plugin = new LayoutPlannerPlugin();
    expect(plugin.store).toBeDefined();
    expect(typeof plugin.store.subscribe).toBe('function');
    expect(typeof plugin.store.getSnapshot).toBe('function');
  });

  test('onModelLoaded registers ancestor override', () => {
    const viewer = createMockViewer();
    const plugin = new LayoutPlannerPlugin();
    plugin.onModelLoaded?.({ scene: new Group() } as any, viewer as any);
    expect(viewer.raycastManager.addAncestorOverride).toHaveBeenCalledTimes(1);
  });

  test('dispose removes ancestor override', () => {
    const viewer = createMockViewer();
    const plugin = new LayoutPlannerPlugin();
    plugin.onModelLoaded?.({ scene: new Group() } as any, viewer as any);
    plugin.dispose?.();
    expect(viewer.raycastManager.removeAncestorOverride).toHaveBeenCalledTimes(1);
  });
});

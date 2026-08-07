// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for LayoutPlannerPlugin Lifecycle — verify _layoutRoot survives model changes.
 *
 * Uses a minimal viewer mock following rv-plugin-lifecycle.test.ts pattern.
 */
import { describe, test, expect, vi } from 'vitest';
import { Group, PerspectiveCamera } from 'three';
import { LayoutPlannerPlugin } from '../src/plugins/layout-planner';

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
    highlighter: { highlight: vi.fn(), clear: vi.fn(), setAuxEmphasis: vi.fn() },
    outlineManager: {
      available: false,
      hasOutlines: false,
      setStyle: vi.fn(),
      setOutlined: vi.fn(),
      clear: vi.fn(),
      setSize: vi.fn(),
    },
    selectionManager: {
      getSnapshot: vi.fn(() => ({ selectedPaths: [], primaryPath: null })),
      clear: vi.fn(),
      select: vi.fn(),
    },
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

describe('LayoutPlannerPlugin — re-activation across scene load', () => {
  // The plugin auto-(re)enters planner mode at the END of every scene load
  // (the `scene-loaded` event), so the planner re-binds to the freshly-loaded
  // scene. Regression guard for: discarding changes / loading a different scene
  // left the planner `_active` from the previous scene, so its edit bindings +
  // toolbar context stayed attached to the disposed scene and never rebuilt.
  function setup(opts: { panelOpen: boolean }) {
    const viewer = createMockViewer() as any;
    const handlers: Record<string, Array<(arg: unknown) => void>> = {};
    viewer.on = vi.fn((evt: string, cb: (arg: unknown) => void) => {
      (handlers[evt] ??= []).push(cb);
      return vi.fn();
    });
    viewer.leftPanelManager = {
      open: vi.fn(),
      close: vi.fn(),
      isOpen: vi.fn(() => opts.panelOpen),
      restore: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    };

    const plugin = new LayoutPlannerPlugin();
    plugin.onModelLoaded?.({ scene: new Group() } as any, viewer);

    // Stub setActive so we exercise the scene-loaded HANDLER logic without
    // running the heavy activation body (which touches many viewer subsystems).
    const setActive = vi
      .spyOn(plugin as unknown as { setActive(a: boolean): void }, 'setActive')
      .mockImplementation((a: boolean) => { (plugin as unknown as { _active: boolean })._active = a; });

    const fireSceneLoaded = () => {
      for (const cb of handlers['scene-loaded'] ?? []) cb({ scene: new Group() });
    };
    return { plugin, setActive, fireSceneLoaded };
  }

  test('first load: activates when the panel is open and not yet active', () => {
    const { setActive, fireSceneLoaded } = setup({ panelOpen: true });
    fireSceneLoaded();
    expect(setActive.mock.calls.map(c => c[0])).toEqual([true]);
  });

  test('scene switch / discard: re-cycles (deactivate then activate) when already active', () => {
    const { plugin, setActive, fireSceneLoaded } = setup({ panelOpen: true });
    (plugin as unknown as { _active: boolean })._active = true; // active from the previous scene
    fireSceneLoaded();
    expect(setActive.mock.calls.map(c => c[0])).toEqual([false, true]);
  });

  test('panel closed: scene-loaded does not force the planner on', () => {
    const { setActive, fireSceneLoaded } = setup({ panelOpen: false });
    fireSceneLoaded();
    expect(setActive).not.toHaveBeenCalled();
  });
});

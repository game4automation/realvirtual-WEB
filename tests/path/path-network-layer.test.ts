// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.4 (Phase 1 part) — the path network as ONE layer.
 *
 * Pins:
 *  - lines, handles and markers hang under `__pathNetworkLayer`, the single
 *    member of the synthetic group `Path Network`;
 *  - the group is registered once the network has a path (also after a model
 *    switch replaced `viewer.groups`, and for paths that arrive after the load),
 *    idempotently, with `groups-changed` only for a NEW membership (R1 #1);
 *  - a hidden layer is inert: no hover, no pointer claim, no handles and so no
 *    aux raycast targets (M4: a plain three.js raycast hits hidden meshes);
 *  - the persisted hidden state applies to a late registration;
 *  - every authoring mode shows handles, including the mode active at init (B9);
 *  - dispose leaves no layer, no group membership and no GPU resources.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Mesh, Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import { RVPathComponent, type PathSegmentSpec } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { setComponentInstance } from '../../src/core/engine/rv-component-registry';
import { GroupRegistry } from '../../src/core/engine/rv-group-registry';
import { cloneSegmentSpecs } from '../../src/core/engine/rv-path-edit';
import { PATH_NETWORK_GROUP, PathVisualizerPlugin } from '../../src/plugins/path-visualizer-plugin';
import {
  loadGroupVisibilitySettings,
  saveGroupVisibilitySettings,
  type GroupVisibilitySettings,
} from '../../src/core/hmi/group-visibility-store';
import type { RVViewer } from '../../src/core/rv-viewer';

const L1: PathSegmentSpec = { kind: 'line', from: [0, 0, 0], to: [4, 0, 0] };

interface AuxSpy {
  targets: Set<Object3D>;
  addAuxRaycastTarget(mesh: Object3D): void;
  removeAuxRaycastTarget(mesh: Object3D): void;
}

interface Stub {
  scene: Scene;
  camera: PerspectiveCamera;
  controls: { enabled: boolean };
  renderer: WebGLRenderer | null;
  raycastManager: AuxSpy;
  registry: null;
  groups: GroupRegistry | null;
  modes: { activeMode: string | null };
  on: EventEmitter['on'];
  emit(event: string, data?: unknown): void;
  markRenderDirty(): void;
  groupsChanged: unknown[];
}

function makeStub(opts: { renderer?: boolean; mode?: string | null } = {}): Stub {
  const events = new EventEmitter();
  const camera = new PerspectiveCamera(50, 320 / 240, 0.1, 1000);
  camera.position.set(0, 20, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.layers.enableAll();
  let renderer: WebGLRenderer | null = null;
  if (opts.renderer) {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:240px;';
    document.body.appendChild(canvas);
    renderer = new WebGLRenderer({ canvas, antialias: false });
    renderer.setSize(320, 240, false);
  }
  const targets = new Set<Object3D>();
  const stub: Stub = {
    scene: new Scene(),
    camera,
    controls: { enabled: true },
    renderer,
    raycastManager: {
      targets,
      addAuxRaycastTarget: (m) => { targets.add(m); },
      removeAuxRaycastTarget: (m) => { targets.delete(m); },
    },
    registry: null,
    groups: null,
    modes: { activeMode: opts.mode ?? null },
    on: events.on.bind(events) as EventEmitter['on'],
    emit: (event, data) => {
      if (event === 'groups-changed') stub.groupsChanged.push(data);
      events.emit(event as never, data as never);
    },
    markRenderDirty: () => {},
    groupsChanged: [],
  };
  return stub;
}

function addPath(scene: Scene, id: string, segments: PathSegmentSpec[]): RVPathComponent {
  const node = new Object3D();
  node.name = id;
  node.userData.realvirtual = { Path: { segments: cloneSegmentSpecs(segments) } };
  scene.add(node);
  const comp = new RVPathComponent(node);
  comp.init({} as never);
  setComponentInstance(node, comp);
  return comp;
}

function effectivelyVisible(o: Object3D): boolean {
  for (let c: Object3D | null = o; c; c = c.parent) if (!c.visible) return false;
  return true;
}

let stub: Stub;
let plugin: PathVisualizerPlugin;
let savedSettings: GroupVisibilitySettings;

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  savedSettings = loadGroupVisibilitySettings();
  saveGroupVisibilitySettings({ ...savedSettings, hiddenGroups: [], isolatedGroup: null });
});

afterEach(() => {
  plugin?.dispose();
  const canvas = stub?.renderer?.domElement;
  stub?.renderer?.dispose();
  canvas?.remove();
  saveGroupVisibilitySettings(savedSettings);
});

function boot(opts: { renderer?: boolean; mode?: string | null } = {}): void {
  stub = makeStub(opts);
  plugin = new PathVisualizerPlugin();
  plugin.init(stub as unknown as RVViewer);
}

describe('layer structure', () => {
  it('lines, handles and markers hang under the one layer root', () => {
    boot();
    const layer = stub.scene.getObjectByName('__pathNetworkLayer')!;
    expect(layer).toBe(plugin.layer);
    expect(layer.parent).toBe(stub.scene);
    expect(layer.children.map((c) => c.name).sort()).toEqual(['__pathHandles', '__pathMarkers', '__pathVisualizer']);
    // Nothing else of the visualizer at scene level.
    expect(stub.scene.children.filter((c) => c.name.startsWith('__path'))).toEqual([layer]);
  });
});

describe('group registration (R1 #1)', () => {
  it('registers exactly the layer once the network has a path; creates the registry when the model had none', () => {
    boot();
    plugin.onModelLoaded();
    expect(stub.groups).toBeNull(); // no path → no group
    expect(stub.groupsChanged).toEqual([]);

    addPath(stub.scene, 'A', [L1]);
    plugin.onModelLoaded();
    expect(stub.groups).toBeInstanceOf(GroupRegistry);
    expect(stub.groups!.get(PATH_NETWORK_GROUP)!.nodes).toEqual([plugin.layer]);
    expect(stub.groupsChanged).toEqual([{ source: 'path-network' }]);
  });

  it('ten groups-changed in a row: no recursion, one registration, no further emits', () => {
    boot();
    addPath(stub.scene, 'A', [L1]);
    plugin.onModelLoaded();
    for (let i = 0; i < 10; i++) stub.emit('groups-changed', { source: 'editor' });
    plugin.onModelLoaded();
    plugin.refresh();
    expect(stub.groups!.get(PATH_NETWORK_GROUP)!.nodes.length).toBe(1);
    expect(stub.groupsChanged.filter((d) => (d as { source: string }).source === 'path-network').length).toBe(1);
  });

  it('a model switch (new registry) registers again; a path arriving after the load is caught by the poll', () => {
    boot();
    addPath(stub.scene, 'A', [L1]);
    plugin.onModelLoaded();
    const first = stub.groups!;

    plugin.onModelCleared();
    getDefaultPathNetwork().clear();
    stub.groups = new GroupRegistry(); // the load hands over a fresh registry
    plugin.onModelLoaded(); // stored addNode paths do not exist yet
    expect(stub.groups.get(PATH_NETWORK_GROUP)).toBeUndefined();

    addPath(stub.scene, 'B', [L1]);
    plugin.onRender(); // first poll after a clear runs at once
    expect(stub.groups.get(PATH_NETWORK_GROUP)!.nodes).toEqual([plugin.layer]);
    expect(first).not.toBe(stub.groups);
    expect(stub.groupsChanged.length).toBe(2);
  });

  it('a late registration applies the persisted hidden state itself', () => {
    saveGroupVisibilitySettings({ ...loadGroupVisibilitySettings(), hiddenGroups: [PATH_NETWORK_GROUP], isolatedGroup: null });
    boot({ mode: 'planner' });
    addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.onModelLoaded();
    expect(stub.groups!.get(PATH_NETWORK_GROUP)!.visible).toBe(false);
    expect(plugin.layer!.visible).toBe(false);
    expect(plugin.getHandleObjects().size).toBe(0);
  });
});

describe('hidden layer is inert', () => {
  it('setVisible(false) hides lines, handles and markers; hover ignored; no handles, no aux targets', () => {
    boot({ mode: 'planner' });
    addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.onModelLoaded();
    plugin.setSelectedPath('A');
    expect(plugin.getHandleObjects().size).toBeGreaterThan(0);
    expect(stub.raycastManager.targets.size).toBeGreaterThan(0);

    stub.groups!.setVisible(PATH_NETWORK_GROUP, false);
    plugin.onRender();
    expect(effectivelyVisible(plugin.getLineObjects().get('A')!)).toBe(false);
    expect(effectivelyVisible(stub.scene.getObjectByName('__pathMarkers')!)).toBe(false);
    expect(plugin.getHandleObjects().size).toBe(0);
    expect(plugin.getChromeObjects().size).toBe(0);
    expect(stub.raycastManager.targets.size).toBe(0);
    plugin.setHoveredPath('A');
    expect(plugin.hoveredPath).toBeNull();

    stub.groups!.setVisible(PATH_NETWORK_GROUP, true);
    plugin.onRender();
    expect(effectivelyVisible(plugin.getLineObjects().get('A')!)).toBe(true);
    expect(plugin.getHandleObjects().size).toBeGreaterThan(0);
    expect(stub.raycastManager.targets.size).toBeGreaterThan(0);
    plugin.setHoveredPath('A');
    expect(plugin.hoveredPath).toBe('A');
  });

  it('hiding clears an active hover', () => {
    boot();
    addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.onModelLoaded();
    plugin.setHoveredPath('A');
    stub.groups!.setVisible(PATH_NETWORK_GROUP, false);
    plugin.onRender();
    expect(plugin.hoveredPath).toBeNull();
  });

  it('pointerdown on a handle is claimed while shown and not while hidden (even before the next frame)', () => {
    boot({ renderer: true, mode: 'planner' });
    addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.onModelLoaded();
    const canvas = stub.renderer!.domElement;
    let reachedOthers = 0;
    const sentinel = (): void => { reachedOthers++; };
    canvas.addEventListener('pointerdown', sentinel);
    const handle = plugin.getHandleObjects().get('A|v0') as Mesh;
    stub.scene.updateMatrixWorld(true);
    const press = (): void => {
      const p = handle.getWorldPosition(new Vector3()).project(stub.camera);
      const r = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left + ((p.x + 1) / 2) * r.width,
        clientY: r.top + ((1 - p.y) / 2) * r.height,
        button: 0,
        bubbles: true,
      }));
    };

    // Also pins the overlay-layer fix: handles sit on HIGHLIGHT_OVERLAY_LAYER only,
    // a default (layer-0) ray never hit them.
    press();
    expect(plugin.isDragging).toBe(true);
    expect(reachedOthers).toBe(0);
    plugin.cancelDrag();

    stub.groups!.setVisible(PATH_NETWORK_GROUP, false); // no onRender: the handler itself gates
    press();
    expect(plugin.isDragging).toBe(false);
    expect(reachedOthers).toBe(1);
    canvas.removeEventListener('pointerdown', sentinel);
  });
});

describe('authoring modes (B9)', () => {
  it('a boot in mode des shows handles without a mode switch', () => {
    boot({ mode: 'des' });
    expect(plugin.isPlannerMode).toBe(true);
    addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.onRender();
    expect(plugin.getHandleObjects().size).toBeGreaterThan(0);
  });

  it('mode-changed follows the authoring set', () => {
    boot();
    expect(plugin.isPlannerMode).toBe(false);
    stub.emit('mode-changed', { from: null, to: 'des' });
    expect(plugin.isPlannerMode).toBe(true);
    stub.emit('mode-changed', { from: 'des', to: 'viewer' });
    expect(plugin.isPlannerMode).toBe(false);
    stub.emit('mode-changed', { from: 'viewer', to: 'planner' });
    expect(plugin.isPlannerMode).toBe(true);
  });
});

describe('dispose', () => {
  it('removes the layer, leaves the group, and a re-init registers the new layer', () => {
    boot();
    addPath(stub.scene, 'A', [L1]);
    plugin.onModelLoaded();
    const oldLayer = plugin.layer!;
    plugin.dispose();
    expect(stub.scene.getObjectByName('__pathNetworkLayer')).toBeUndefined();
    expect(stub.groups!.get(PATH_NETWORK_GROUP)).toBeUndefined();

    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    plugin.onModelLoaded();
    expect(stub.groups!.get(PATH_NETWORK_GROUP)!.nodes).toEqual([plugin.layer]);
    expect(plugin.layer).not.toBe(oldLayer);
  });

  it('renderer.info returns to its baseline', () => {
    boot({ renderer: true, mode: 'planner' });
    plugin.dispose();
    const renderer = stub.renderer!;
    renderer.render(stub.scene, stub.camera);
    const baseGeometries = renderer.info.memory.geometries;
    const baseTextures = renderer.info.memory.textures;

    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.onModelLoaded();
    renderer.render(stub.scene, stub.camera);
    expect(renderer.info.memory.geometries).toBeGreaterThan(baseGeometries);

    plugin.dispose();
    renderer.render(stub.scene, stub.camera);
    expect(renderer.info.memory.geometries).toBe(baseGeometries);
    expect(renderer.info.memory.textures).toBe(baseTextures);
  });
});

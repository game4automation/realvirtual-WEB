// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-447 §9.5 — the EXTENDED path visualizer (no parallel build).
 *
 * Pins:
 *  - EXACTLY one line renderer per path (the plan's "zwei Linien-Renderer"
 *    risk): the plugin owns a `pathId → LineSegments2` map, a live edit
 *    replaces the geometry of that one object, never adds a second;
 *  - planner mode switches emphasis + drag handles on, leaving tidies them up;
 *  - the drag flow (begin/update/end) commits through the ordinary segment
 *    field and re-derives the engine path;
 *  - `dispose()` is leak-free — checked against `renderer.info`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Object3D,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import { RVPathComponent } from '../../src/core/engine/rv-path';
import type { PathSegmentSpec } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import { setComponentInstance } from '../../src/core/engine/rv-component-registry';
import { PathVisualizerPlugin } from '../../src/plugins/path-visualizer-plugin';
import type { RVViewer } from '../../src/core/rv-viewer';
import { cloneSegmentSpecs, readSegmentSpecs } from '../../src/core/engine/rv-path-edit';

const L1: PathSegmentSpec = { kind: 'line', from: [0, 0, 0], to: [0, 0, 5] };
const L2: PathSegmentSpec = { kind: 'line', from: [0, 0, 5], to: [10, 0, 5] };

interface StubViewer {
  scene: Scene;
  camera: PerspectiveCamera;
  controls: { enabled: boolean };
  renderer: WebGLRenderer | null;
  raycastManager: null;
  registry: null;
  events: EventEmitter;
  on: EventEmitter['on'];
  emit(event: string, data: unknown): void;
  markRenderDirty(): void;
  dirtyCount: number;
}

function makeStubViewer(withRenderer = false): StubViewer {
  const events = new EventEmitter();
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1.333, 0.1, 1000);
  camera.position.set(0, 20, 20);
  camera.lookAt(0, 0, 0);
  camera.layers.enableAll(); // overlay-tagged path lines must render for info counts
  let renderer: WebGLRenderer | null = null;
  if (withRenderer) {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    renderer = new WebGLRenderer({ canvas, antialias: false });
    renderer.setSize(320, 240, false);
  }
  const stub: StubViewer = {
    scene,
    camera,
    controls: { enabled: true },
    renderer,
    raycastManager: null,
    registry: null,
    events,
    on: events.on.bind(events) as EventEmitter['on'],
    emit: (event, data) => events.emit(event as never, data as never),
    markRenderDirty: () => {
      stub.dirtyCount++;
    },
    dirtyCount: 0,
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

let stub: StubViewer;
let plugin: PathVisualizerPlugin;

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultSpacingController().clear();
});

afterEach(() => {
  plugin?.dispose();
  stub?.renderer?.dispose();
});

describe('one line renderer per path (no parallel build)', () => {
  it('creates exactly one LineSegments2 per registered path', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    addPath(stub.scene, 'A', [L1, L2]);
    addPath(stub.scene, 'B', [L1]);
    plugin.refresh();

    const lines = plugin.getLineObjects();
    expect(lines.size).toBe(2);
    expect([...lines.keys()].sort()).toEqual(['A', 'B']);
    // The scene carries exactly one drawing root with exactly those children.
    const root = stub.scene.getObjectByName('__pathVisualizer')!;
    expect(root.children.length).toBe(2);
  });

  it('a live edit REPLACES the geometry of the existing object — no second renderer', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    const comp = addPath(stub.scene, 'A', [L1, L2]);
    plugin.refresh();
    const before = plugin.getLineObjects().get('A')!;

    (comp.node.userData.realvirtual as Record<string, Record<string, unknown>>).Path.segments = [
      { kind: 'line', from: [0, 0, 0], to: [0, 0, 25] },
    ];
    comp.reapplyConfig(); // fires the network change event

    expect(plugin.getLineObjects().size).toBe(1);
    expect(plugin.getLineObjects().get('A')).toBe(before); // same object, new positions
    expect(stub.scene.getObjectByName('__pathVisualizer')!.children.length).toBe(1);
  });

  it('an unregistered path loses its renderer', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    const comp = addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    expect(plugin.getLineObjects().size).toBe(1);

    comp.dispose();
    plugin.refresh();
    expect(plugin.getLineObjects().size).toBe(0);
    expect(stub.scene.getObjectByName('__pathVisualizer')!.children.length).toBe(0);
  });

  it('a zero-length path draws nothing', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    addPath(stub.scene, 'Empty', []);
    plugin.refresh();
    expect(plugin.getLineObjects().size).toBe(0);
  });
});

describe('planner mode — emphasis and handles', () => {
  it('entering planner mode adds handles, leaving removes them', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    addPath(stub.scene, 'A', [L1, L2]);
    plugin.refresh();
    expect(plugin.getHandleObjects().size).toBe(0);
    expect(stub.scene.getObjectByName('__pathHandles')!.visible).toBe(false);

    plugin.setPlannerMode(true);
    // Three chain vertices (two of them free ends) for a two-line chain.
    expect([...plugin.getHandleObjects().keys()].sort()).toEqual(['A|v0', 'A|v1', 'A|v2']);
    expect(stub.scene.getObjectByName('__pathHandles')!.visible).toBe(true);

    plugin.setPlannerMode(false);
    expect(plugin.getHandleObjects().size).toBe(0);
    expect(stub.scene.getObjectByName('__pathHandles')!.children.length).toBe(0);
    expect(stub.scene.getObjectByName('__pathHandles')!.visible).toBe(false);
  });

  it('the mode-changed event drives planner mode', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    addPath(stub.scene, 'A', [L1]);
    plugin.refresh();

    stub.emit('mode-changed', { from: 'hmi', to: 'planner' });
    expect(plugin.isPlannerMode).toBe(true);
    expect(plugin.getHandleObjects().size).toBeGreaterThan(0);

    stub.emit('mode-changed', { from: 'planner', to: 'hmi' });
    expect(plugin.isPlannerMode).toBe(false);
    expect(plugin.getHandleObjects().size).toBe(0);
  });

  it('planner mode raises the line width, hover raises it further on THAT path only', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    addPath(stub.scene, 'A', [L1]);
    addPath(stub.scene, 'B', [L2]);
    plugin.refresh();

    const widthOf = (id: string): number =>
      (plugin.getLineObjects().get(id)!.material as { linewidth: number }).linewidth;
    const idle = widthOf('A');

    plugin.setPlannerMode(true);
    const planner = widthOf('A');
    expect(planner).toBeGreaterThan(idle);

    plugin.setHoveredPath('A');
    expect(widthOf('A')).toBeGreaterThan(planner);
    expect(widthOf('B')).toBe(planner);
    expect(plugin.hoveredPath).toBe('A');

    plugin.setHoveredPath(null);
    expect(widthOf('A')).toBe(planner);
  });

  it('handles refresh after a live geometry edit while planner mode is on', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    const comp = addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.setPlannerMode(true);
    expect(plugin.getHandleObjects().get('A|v1')!.position.z).toBeCloseTo(5, 6);

    (comp.node.userData.realvirtual as Record<string, Record<string, unknown>>).Path.segments = [
      { kind: 'line', from: [0, 0, 0], to: [0, 0, 9] },
    ];
    comp.reapplyConfig();

    expect(plugin.getHandleObjects().get('A|v1')!.position.z).toBeCloseTo(9, 6);
  });
});

describe('handle drag — preview then commit', () => {
  it('begin/update/end commits the new segment list and re-derives the path', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    const comp = addPath(stub.scene, 'A', [L1, L2]);
    plugin.refresh();
    plugin.setPlannerMode(true);
    const lengthBefore = comp.path!.length;

    expect(plugin.beginHandleDrag('A', 'v1')).toBe(true);
    expect(plugin.isDragging).toBe(true);
    expect(stub.controls.enabled).toBe(false);

    plugin.updateHandleDrag([0, 0, 9]);
    // The preview does NOT touch the engine.
    expect(comp.path!.length).toBeCloseTo(lengthBefore, 12);

    const committed = plugin.endHandleDrag()!;
    expect(plugin.isDragging).toBe(false);
    expect(stub.controls.enabled).toBe(true);
    expect((committed[0] as { to: number[] }).to).toEqual([0, 0, 9]);
    expect((committed[1] as { from: number[] }).from).toEqual([0, 0, 9]);
    expect(comp.path!.length).toBeCloseTo(9 + Math.hypot(10, 4), 10);
    expect(
      readSegmentSpecs(comp.node as unknown as { userData: Record<string, unknown> }),
    ).toEqual(committed);
  });

  it('an endpoint drag rasts onto a nearby foreign path end (F4)', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    const a = addPath(stub.scene, 'A', [{ kind: 'line', from: [0, 0, 0], to: [0, 0, 5] }]);
    addPath(stub.scene, 'B', [{ kind: 'line', from: [0, 0, 8], to: [0, 0, 12] }]);
    plugin.refresh();
    plugin.setPlannerMode(true);

    expect(plugin.beginHandleDrag('A', 'v1')).toBe(true);
    plugin.updateHandleDrag([0.05, 0, 7.9]); // within the rastung radius of B's start
    const committed = plugin.endHandleDrag()!;
    expect((committed[0] as { to: number[] }).to).toEqual([0, 0, 8]);
    expect(a.path!.length).toBeCloseTo(8, 10);
  });

  it('a registered candidate source contributes FOREIGN rastung targets (F4 stations)', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    const a = addPath(stub.scene, 'A', [{ kind: 'line', from: [0, 0, 0], to: [0, 0, 5] }]);
    plugin.refresh();
    plugin.setPlannerMode(true);

    const seen: { pathId: string; handleId: string }[] = [];
    const un = plugin.addSnapCandidateSource((q) => {
      seen.push(q);
      // A "station" port 20 cm away from the raw drag target.
      return [{ id: 'Station:in', position: [0, 0, 7] as [number, number, number] }];
    });

    plugin.beginHandleDrag('A', 'v1');
    plugin.updateHandleDrag([0, 0, 7.2]); // inside the rastung radius of the station
    const committed = plugin.endHandleDrag()!;

    expect(seen).toEqual([{ pathId: 'A', handleId: 'v1' }]);
    expect((committed[0] as { to: number[] }).to).toEqual([0, 0, 7]);
    expect(a.path!.length).toBeCloseTo(7, 10);

    // Unregistering takes the target away again.
    un();
    plugin.beginHandleDrag('A', 'v1');
    plugin.updateHandleDrag([0, 0, 9.2]);
    const second = plugin.endHandleDrag()!;
    expect((second[0] as { to: number[] }).to).toEqual([0, 0, 9.2]);
  });

  it('a throwing candidate source is contained — the drag still commits', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    addPath(stub.scene, 'A', [{ kind: 'line', from: [0, 0, 0], to: [0, 0, 5] }]);
    plugin.refresh();
    plugin.setPlannerMode(true);
    plugin.addSnapCandidateSource(() => {
      throw new Error('bad source');
    });

    plugin.beginHandleDrag('A', 'v1');
    plugin.updateHandleDrag([0, 0, 11]);
    const committed = plugin.endHandleDrag()!;
    expect((committed[0] as { to: number[] }).to).toEqual([0, 0, 11]);
  });

  it('a drag without movement commits nothing', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    const comp = addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.setPlannerMode(true);
    const before = comp.path;

    plugin.beginHandleDrag('A', 'v1');
    expect(plugin.endHandleDrag()).toBeNull();
    expect(comp.path).toBe(before);
  });

  it('cancelDrag restores the pre-drag drawing and releases the camera controls', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    const comp = addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.setPlannerMode(true);
    const before = comp.path;

    plugin.beginHandleDrag('A', 'v1');
    plugin.updateHandleDrag([0, 0, 40]);
    plugin.cancelDrag();

    expect(plugin.isDragging).toBe(false);
    expect(stub.controls.enabled).toBe(true);
    expect(comp.path).toBe(before); // engine untouched
    expect(plugin.getLineObjects().size).toBe(1);
  });

  it('leaving planner mode cancels an in-flight drag', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    const comp = addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.setPlannerMode(true);
    const before = comp.path;

    plugin.beginHandleDrag('A', 'v1');
    plugin.updateHandleDrag([0, 0, 40]);
    plugin.setPlannerMode(false);

    expect(plugin.isDragging).toBe(false);
    expect(comp.path).toBe(before);
  });

  it('an unknown path or handle refuses the drag', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.setPlannerMode(true);
    expect(plugin.beginHandleDrag('nope', 'v0')).toBe(false);
    expect(plugin.beginHandleDrag('A', 'v9')).toBe(false);
  });
});

describe('lifecycle — dispose is leak-free', () => {
  it('onModelCleared drops every renderer and handle', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    addPath(stub.scene, 'A', [L1, L2]);
    plugin.refresh();
    plugin.setPlannerMode(true);
    expect(plugin.getLineObjects().size).toBe(1);
    expect(plugin.getHandleObjects().size).toBeGreaterThan(0);

    plugin.onModelCleared();
    expect(plugin.getLineObjects().size).toBe(0);
    expect(plugin.getHandleObjects().size).toBe(0);
  });

  it('dispose returns renderer.info to its baseline (no GPU leak)', () => {
    stub = makeStubViewer(true);
    const renderer = stub.renderer!;
    renderer.render(stub.scene, stub.camera);
    const baseGeometries = renderer.info.memory.geometries;
    const baseTextures = renderer.info.memory.textures;

    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    addPath(stub.scene, 'A', [L1, L2]);
    addPath(stub.scene, 'B', [L2]);
    plugin.refresh();
    plugin.setPlannerMode(true);
    renderer.render(stub.scene, stub.camera);
    expect(renderer.info.memory.geometries).toBeGreaterThan(baseGeometries);

    plugin.dispose();
    renderer.render(stub.scene, stub.camera);

    expect(renderer.info.memory.geometries).toBe(baseGeometries);
    expect(renderer.info.memory.textures).toBe(baseTextures);
    // Both roots removed from the scene.
    expect(stub.scene.getObjectByName('__pathVisualizer')).toBeUndefined();
    expect(stub.scene.getObjectByName('__pathHandles')).toBeUndefined();
  });

  it('dispose unsubscribes from the network change channel', () => {
    stub = makeStubViewer();
    plugin = new PathVisualizerPlugin();
    plugin.init(stub as unknown as RVViewer);
    const comp = addPath(stub.scene, 'A', [L1]);
    plugin.refresh();
    plugin.dispose();

    // Must not throw and must not resurrect any renderer.
    comp.reapplyConfig();
    expect(plugin.getLineObjects().size).toBe(0);
  });
});

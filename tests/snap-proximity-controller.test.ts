// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Group, Object3D, PerspectiveCamera, Scene } from 'three';
import {
  SnapPointRegistry,
  type SnapPoint,
} from '../src/core/engine/rv-snap-point-registry';
import {
  SnapPointController,
  DEFAULT_PIXEL_THRESHOLD,
  DEFAULT_CLICK_RADIUS_PX,
} from '../src/plugins/snap-point/snap-point-controller';
import { SnapMarkerRenderer } from '../src/plugins/snap-point/snap-marker-renderer';
import { snapHoverStore } from '../src/plugins/snap-point/snap-hover-store';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';

interface RaycastStub {
  filters: Array<(o: Object3D) => boolean>;
  addExcludeFilter(f: (o: Object3D) => boolean): void;
}

function makeRaycastStub(): RaycastStub {
  return {
    filters: [],
    addExcludeFilter(f) { this.filters.push(f); },
  };
}

function makeViewerStub(canvas: HTMLCanvasElement, scene: Scene, camera: PerspectiveCamera) {
  return {
    scene,
    camera,
    renderer: { domElement: canvas },
    raycastManager: makeRaycastStub(),
    gizmoManager: new GizmoOverlayManager(scene, () => null),
    markRenderDirty: () => { /* noop */ },
  };
}

function makeCanvas(width = 800, height = 600): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.style.width = `${width}px`;
  c.style.height = `${height}px`;
  document.body.appendChild(c);
  return c;
}

function registerSnapAtWorld(
  reg: SnapPointRegistry,
  scene: Scene,
  id: string,
  worldPos: [number, number, number],
): SnapPoint {
  const node = new Object3D();
  node.name = `Snap-ZN-foo`;
  node.position.set(...worldPos);
  scene.add(node);
  node.updateMatrixWorld(true);
  const sp: SnapPoint = {
    id,
    object3D: node,
    dir: { axis: 'Z', sign: 'N', code: 'ZN' },
    typeId: 'foo',
    ownerRoot: node,
    scenePath: id,
    occupied: false,
  };
  reg.register(sp);
  return sp;
}

describe('SnapPointController proximity detection', () => {
  let registry: SnapPointRegistry;
  let scene: Scene;
  let camera: PerspectiveCamera;
  let canvas: HTMLCanvasElement;
  let controller: SnapPointController;
  let renderer: SnapMarkerRenderer;

  beforeEach(() => {
    snapHoverStore.reset();
    registry = new SnapPointRegistry();
    scene = new Scene();
    camera = new PerspectiveCamera(60, 800 / 600, 0.01, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    canvas = makeCanvas();
    const viewer = makeViewerStub(canvas, scene, camera);
    renderer = new SnapMarkerRenderer(viewer as never, registry);
    renderer.setEnabled(true);
    renderer.rebuild(0); // no snaps yet
    controller = new SnapPointController(viewer as never, registry, renderer);
  });

  it('finds the nearest snap within pixel threshold', () => {
    const a = registerSnapAtWorld(registry, scene, 'a', [0, 0, 0]);
    registerSnapAtWorld(registry, scene, 'b', [2, 0, 0]);
    renderer.rebuild(registry.size);
    controller.activate();

    // Mouse near snap A's screen position (canvas center)
    const r = controller.tick(400, 300);
    expect(r.snap?.id).toBe(a.id);
    expect(r.dist).toBeLessThan(DEFAULT_PIXEL_THRESHOLD);
  });

  it('returns null when nothing is within the threshold', () => {
    registerSnapAtWorld(registry, scene, 'a', [0, 0, 0]);
    renderer.rebuild(registry.size);
    controller.activate();
    // Far away
    const r = controller.tick(0, 0);
    expect(r.snap).toBeNull();
  });

  it('skips dangling snaps whose owner is detached', () => {
    const a = registerSnapAtWorld(registry, scene, 'a', [0, 0, 0]);
    renderer.rebuild(registry.size);
    controller.activate();
    // Detach the snap from the scene
    scene.remove(a.object3D);
    expect(a.object3D.parent).toBeNull();

    const r = controller.tick(400, 300);
    expect(r.snap).toBeNull();
  });

  it('respects frustum culling (snap behind camera)', () => {
    // Snap behind camera (positive Z when camera is at +Z looking toward -Z)
    registerSnapAtWorld(registry, scene, 'behind', [0, 0, 10]);
    renderer.rebuild(registry.size);
    controller.activate();
    const r = controller.tick(400, 300);
    expect(r.snap).toBeNull();
  });

  it('proximity tick budget is acceptable for ~50 snaps', () => {
    for (let i = 0; i < 50; i++) {
      registerSnapAtWorld(registry, scene, `s${i}`, [(i % 10) * 0.2 - 1, 0, 0]);
    }
    renderer.rebuild(registry.size);
    controller.activate();

    const ITER = 50;
    const t0 = performance.now();
    for (let i = 0; i < ITER; i++) controller.tick(400, 300);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(200); // generous CI margin
  });

  // ── The picker opens on a CLICK, never on a drag (2026-09-25) ─────────
  //
  // Field finding: grabbing a conveyor within the marker radius both moved it
  // (the planner arms its drag on the same press) and opened the picker, which
  // then swallowed the next press — "the conveyor cannot be moved".

  // Canvas-relative like `tick()`: every test appends its own canvas to the
  // body, so the client offset of THIS canvas is not zero.
  function pressAt(x: number, y: number): void {
    const r = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + x, clientY: r.top + y, button: 0, bubbles: true }));
  }
  function releaseAt(x: number, y: number): void {
    const r = canvas.getBoundingClientRect();
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: r.left + x, clientY: r.top + y, button: 0, bubbles: true }));
  }

  it('a press on a marker does not open the picker by itself', () => {
    registerSnapAtWorld(registry, scene, 'a', [0, 0, 0]);
    renderer.rebuild(registry.size);
    controller.activate();
    controller.tick(400, 300);
    expect(snapHoverStore.getState().hovered).not.toBeNull();

    pressAt(400, 300);
    expect(snapHoverStore.getState().pickerOpen).toBe(false);
  });

  it('press + release in place opens the picker for the hovered snap', () => {
    const a = registerSnapAtWorld(registry, scene, 'a', [0, 0, 0]);
    renderer.rebuild(registry.size);
    controller.activate();
    controller.tick(400, 300);

    pressAt(400, 300);
    releaseAt(402, 301);                       // a click has jitter; still a click
    const st = snapHoverStore.getState();
    expect(st.pickerOpen).toBe(true);
    expect(st.pickerAnchor?.id).toBe(a.id);
  });

  it('a press on the PART near a marker, outside the click radius, opens nothing', () => {
    registerSnapAtWorld(registry, scene, 'a', [0, 0, 0]);
    renderer.rebuild(registry.size);
    controller.activate();
    controller.tick(400 + 25, 300);            // hovered: inside the 36 px hover radius
    expect(snapHoverStore.getState().hovered).not.toBeNull();

    expect(25).toBeGreaterThan(DEFAULT_CLICK_RADIUS_PX);
    expect(25).toBeLessThan(DEFAULT_PIXEL_THRESHOLD);
    pressAt(400 + 25, 300);                    // …but outside DEFAULT_CLICK_RADIUS_PX
    releaseAt(400 + 25, 300);
    expect(snapHoverStore.getState().pickerOpen).toBe(false);
  });

  it('a press that turns into a drag never opens the picker', () => {
    registerSnapAtWorld(registry, scene, 'a', [0, 0, 0]);
    renderer.rebuild(registry.size);
    controller.activate();
    controller.tick(400, 300);

    pressAt(400, 300);
    releaseAt(400 + 60, 300);                  // well past DRAG_THRESHOLD_PX
    expect(snapHoverStore.getState().pickerOpen).toBe(false);

    // The candidate is consumed: a later release out of nowhere opens nothing.
    releaseAt(400, 300);
    expect(snapHoverStore.getState().pickerOpen).toBe(false);
  });

  it('a snap paired during the press does not get a picker', () => {
    const a = registerSnapAtWorld(registry, scene, 'a', [0, 0, 0]);
    renderer.rebuild(registry.size);
    controller.activate();
    controller.tick(400, 300);

    pressAt(400, 300);
    a.occupied = true;
    releaseAt(400, 300);
    expect(snapHoverStore.getState().pickerOpen).toBe(false);
  });

  it('deactivate clears DOM listeners + hover state without crashing', () => {
    registerSnapAtWorld(registry, scene, 'a', [0, 0, 0]);
    renderer.rebuild(registry.size);
    controller.activate();
    controller.tick(400, 300);
    expect(snapHoverStore.getState().hovered).not.toBeNull();
    controller.deactivate();
    expect(snapHoverStore.getState().hovered).toBeNull();
  });
});

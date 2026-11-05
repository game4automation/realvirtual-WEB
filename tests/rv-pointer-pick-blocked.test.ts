// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2215 2.6 — no pointer pick with `viewer.camera` while a render strategy
 * draws other cameras. ONE question (`viewer.pointerPickBlocked`), asked by the
 * hover / pick APIs of the RaycastManager and by every plugin that raycasts
 * from client coordinates (here: the measurement tool as the representative).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RenderStrategy, RenderStrategyContext } from '../src/core/engine/rv-render-strategy';
import { RaycastManager } from '../src/core/engine/rv-raycast-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { RVHighlightManager } from '../src/core/engine/rv-highlight-manager';
import { MeasurementPlugin } from '../src/plugins/measurement-plugin';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

class MonoStrategy implements RenderStrategy {
  active = true;
  renderFrame(ctx: RenderStrategyContext): void {
    ctx.renderViewport({ x: 0, y: 0, w: ctx.canvasWidth, h: ctx.canvasHeight }, ctx.monoCamera);
  }
  onFailed(): void { /* not expected */ }
}

let handle: TestViewerHandle | undefined;

afterEach(() => {
  handle?.dispose();
  handle = undefined;
  localStorage.clear();
});

function pointer(type: string, canvas: HTMLCanvasElement, dx = 0): void {
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(new PointerEvent(type, {
    clientX: r.left + r.width / 2 + dx,
    clientY: r.top + r.height / 2,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    isPrimary: true,
    pointerType: 'mouse',
    bubbles: true,
  }));
}

describe('viewer.pointerPickBlocked (plan-2215 2.6)', () => {
  it('follows the active strategy, not an installed inactive one', async () => {
    handle = await createTestViewer('webgl', { width: 320, height: 240 });
    const viewer = handle.viewer;
    expect(viewer.pointerPickBlocked).toBe(false);
    const s = new MonoStrategy();
    viewer.setRenderStrategy(s);
    expect(viewer.pointerPickBlocked).toBe(true);
    s.active = false;
    expect(viewer.pointerPickBlocked).toBe(false);
    s.active = true;
    viewer.setRenderStrategy(null);
    expect(viewer.pointerPickBlocked).toBe(false);
  });

  it('measurement tool: no points and no cursor under an active strategy, a running tap is dropped', async () => {
    handle = await createTestViewer('webgl', { width: 320, height: 240 });
    const viewer = handle.viewer;
    // A real (baked) model: the measurement tool picks through the pick
    // pipeline (`raycastSurface`), which a raw mesh in the scene never reaches.
    const root = new Group();
    root.name = 'PickBlocked';
    const box = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    box.name = 'Box';
    root.add(box);
    await viewer.loadModel('pick-blocked.glb', { data: await objectToGlb(root) });
    viewer.loop.stop();
    const cam = viewer.camera as PerspectiveCamera;
    cam.position.set(0, 0, 5);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const m = new MeasurementPlugin();
    m.onModelLoaded({ drives: [] } as unknown as LoadResult, viewer);
    m.measurementMode = true;
    const canvas = viewer.renderer.domElement as HTMLCanvasElement;
    const priv = m as unknown as { _pendingPointA: unknown; _state: string; _lastMoveTime: number };

    // Control: without a strategy the tap places the first point.
    pointer('pointerdown', canvas);
    pointer('pointerup', canvas);
    expect(priv._pendingPointA).not.toBeNull();
    expect(priv._state).toBe('waitingSecond');
    m.measurementMode = false;
    m.measurementMode = true;
    expect(priv._pendingPointA).toBeNull();

    viewer.setRenderStrategy(new MonoStrategy());
    const showCursor = vi.spyOn(
      (m as unknown as { _renderer: { showCursorDot(...a: unknown[]): void } })._renderer, 'showCursorDot');
    pointer('pointerdown', canvas);
    priv._lastMoveTime = 0;
    pointer('pointermove', canvas, 1);
    pointer('pointerup', canvas);
    expect(priv._pendingPointA).toBeNull();
    expect(priv._state).toBe('waitingFirst');
    expect(showCursor).not.toHaveBeenCalled();
    expect(m.getMeasurements()).toHaveLength(0);

    // A tap begun in mono and released under the strategy places nothing.
    viewer.setRenderStrategy(null);
    pointer('pointerdown', canvas);
    viewer.setRenderStrategy(new MonoStrategy());
    pointer('pointerup', canvas);
    expect(priv._pendingPointA).toBeNull();
    viewer.setRenderStrategy(null);
    m.dispose();
  });
});

describe('RaycastManager.pickBlocked (plan-2215 2.6)', () => {
  function makeManager(): { rm: RaycastManager; canvas: HTMLCanvasElement } {
    const canvas = document.createElement('canvas');
    const camera = new PerspectiveCamera();
    const rm = new RaycastManager(
      { domElement: canvas }, () => camera, new Scene(), new NodeRegistry(),
      { highlight() { }, highlightInstancedMU() { }, clear() { } } as unknown as RVHighlightManager,
      { emit() { } },
    );
    (rm as unknown as { _targets: unknown[] })._targets.push(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    return { rm, canvas };
  }

  it('pointer pick APIs and hover cast no ray while blocked', () => {
    const { rm, canvas } = makeManager();
    const raycaster = (rm as unknown as { raycaster: { setFromCamera(...a: unknown[]): void } }).raycaster;
    const cast = vi.spyOn(raycaster, 'setFromCamera');
    let blocked = true;
    rm.pickBlocked = () => blocked;
    expect(rm.raycastForRVNodeDetailed({ clientX: 1, clientY: 1 })).toBeNull();
    expect(rm.pickDetailed({ clientX: 1, clientY: 1 })).toBeNull();
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 2, clientY: 2 }));
    expect(cast).not.toHaveBeenCalled();
    blocked = false;
    rm.raycastForRVNodeDetailed({ clientX: 1, clientY: 1 });
    expect(cast).toHaveBeenCalled();
    rm.dispose();
  });
});

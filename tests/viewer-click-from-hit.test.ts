// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2215 §9.18 — the click logic extracted from the canvas `pointerup` into
 * `viewer.clickFromHit(hit, modifiers)` (Phase 7, pure refactor).
 *
 * For each case the SAME scene is clicked twice: once with a real mouse click
 * (pointerdown + pointerup on the canvas) and once with `clickFromHit` and the
 * hit of `raycastForRVNodeDetailed` at the same pixel — the way the flystick
 * bridge calls it with a ray hit. Both must leave the same selection and emit
 * the same `object-clicked` payload: select, shift-toggle, empty space (clear +
 * clearFocus) and a `pick:'action'` component (click event, no selection).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Vector3, type PerspectiveCamera } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { objectToGlb } from '../src/core/import/rv-import-object';
// Registers the `PushButton3D` capabilities (`pick:'action'`).
import '../src/core/engine/rv-push-button3d';

const W = 640;
const H = 480;
let handle: TestViewerHandle | null = null;
const paths: Record<string, string> = {};

interface Clicked { path: string; node: unknown; hitPoint?: [number, number, number] }

beforeAll(async () => {
  handle = await createTestViewer('webgl', { width: W, height: H });
  handle.viewer.loop.stop();
  const root = new Group(); root.name = 'ClickScene';
  const mat = new MeshStandardMaterial();
  // Drives are hover-enabled by default, so the shared pick pipeline resolves them.
  const a = new Mesh(new BoxGeometry(1, 1, 1), mat); a.name = 'A';
  a.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 0 } };
  root.add(a);
  const act = new Mesh(new BoxGeometry(0.6, 0.6, 0.6), mat); act.name = 'Act'; act.position.set(1.6, 0, 0);
  act.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 0 } };
  root.add(act);
  await handle.viewer.loadModel('click.glb', { data: await objectToGlb(root) });
  handle.viewer.scene.traverse((o) => {
    const p = handle!.viewer.registry!.getPathForNode(o);
    if (p) paths[o.name] = p;
  });
  const cam = handle.viewer.camera as PerspectiveCamera;
  cam.position.set(0, 0, 6);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  handle.viewer.controls.target.set(0, 0, 0);
}, 60_000);

afterAll(() => { handle?.dispose(); handle = null; });

beforeEach(() => {
  vi.restoreAllMocks();
  handle?.viewer.selectionManager.clear();
});

/** Client position of a world point. */
function screenOf(world: Vector3): { clientX: number; clientY: number } {
  const v = handle!.viewer;
  const r = v.renderer.domElement.getBoundingClientRect();
  const p = world.clone().project(v.camera);
  return { clientX: r.left + (p.x + 1) / 2 * r.width, clientY: r.top + (1 - p.y) / 2 * r.height };
}

function mouseClick(at: { clientX: number; clientY: number }, shiftKey = false): void {
  const cv = handle!.viewer.renderer.domElement;
  const init = { ...at, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true, shiftKey };
  cv.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
  cv.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
}

function rayClick(at: { clientX: number; clientY: number }, shiftKey = false): void {
  const v = handle!.viewer;
  const detailed = v.raycastManager!.raycastForRVNodeDetailed(at);
  v.clickFromHit(detailed ? { path: detailed.path, hitPoint: detailed.hitPoint } : null, { shiftKey });
}

/** Runs `click`, returns the selection and the object-clicked payloads it produced. */
function record(click: () => void): { selected: string[]; clicked: Clicked[] } {
  const v = handle!.viewer;
  const clicked: Clicked[] = [];
  const off = v.on('object-clicked', (d) => { clicked.push({ path: d.path, node: d.node, hitPoint: d.hitPoint }); });
  click();
  off();
  return { selected: [...v.selectionManager.getSnapshot().selectedPaths], clicked };
}

describe('viewer.clickFromHit equals the mouse click (plan-2215 9.18)', () => {
  it('the fixture resolves both boxes', () => {
    expect(paths.A).toBeTruthy();
    expect(paths.Act).toBeTruthy();
    expect(handle!.viewer.raycastManager!.raycastForRVNodeDetailed(screenOf(new Vector3()))?.path).toBe(paths.A);
  });

  it('select: same selection and same object-clicked payload (path, node, hitPoint)', () => {
    const at = screenOf(new Vector3(0, 0, 0));
    const mouse = record(() => mouseClick(at));
    handle!.viewer.selectionManager.clear();
    const ray = record(() => rayClick(at));
    expect(mouse.selected).toEqual([paths.A]);
    expect(mouse.clicked).toHaveLength(1);
    expect(mouse.clicked[0].hitPoint).toBeDefined();
    expect(ray).toEqual(mouse);
  });

  it('shift toggles the node in both ways', () => {
    const v = handle!.viewer;
    const at = screenOf(new Vector3(0, 0, 0));
    v.selectionManager.select(paths.Act);
    const mouse = record(() => mouseClick(at, true));
    v.selectionManager.select(paths.Act);
    const ray = record(() => rayClick(at, true));
    expect([...mouse.selected].sort()).toEqual([paths.A, paths.Act].sort());
    expect(ray).toEqual(mouse);
  });

  it('empty space clears the selection and the focus in both ways', () => {
    const v = handle!.viewer;
    const at = screenOf(new Vector3(0, 2.5, 0));
    const focus = vi.spyOn(v, 'clearFocus');
    v.selectionManager.select(paths.A);
    const mouse = record(() => mouseClick(at));
    v.selectionManager.select(paths.A);
    const ray = record(() => rayClick(at));
    expect(mouse).toEqual({ selected: [], clicked: [] });
    expect(ray).toEqual(mouse);
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it("pick:'action' fires object-clicked and never selects, in both ways", () => {
    const v = handle!.viewer;
    const registry = v.registry!;
    const types = registry.getComponentTypes.bind(registry);
    vi.spyOn(registry, 'getComponentTypes').mockImplementation((p: string) =>
      p === paths.Act ? ['PushButton3D'] : types(p));
    const at = screenOf(new Vector3(1.6, 0, 0));
    v.selectionManager.select(paths.A);
    const mouse = record(() => mouseClick(at));
    const ray = record(() => rayClick(at));
    expect(mouse.selected).toEqual([paths.A]);
    expect(mouse.clicked.map((c) => c.path)).toEqual([paths.Act]);
    expect(ray).toEqual(mouse);
  });

  it('an open drive chart filters on the ray hit, not on the canvas hover', () => {
    const v = handle!.viewer;
    const rm = v.raycastManager!;
    const filter = vi.spyOn(v, 'filterDrives').mockImplementation(() => {});
    vi.spyOn(v, 'driveChartOpen', 'get').mockReturnValue(true);
    // The mouse last hovered drive A; the ray clicks drive Act.
    vi.spyOn(rm, 'hoveredNode', 'get').mockReturnValue(v.registry!.getNode(paths.A)!);
    vi.spyOn(rm, 'hoveredNodeType', 'get').mockReturnValue('Drive');
    const ray = record(() => rayClick(screenOf(new Vector3(1.6, 0, 0))));
    expect(filter).toHaveBeenCalledTimes(1);
    expect(filter).toHaveBeenCalledWith('Act');
    expect(ray).toEqual({ selected: [], clicked: [] });
  });

  it('a ray click without a screen position never asks for a WebLabel', () => {
    const v = handle!.viewer;
    const labelAt = vi.spyOn(v.webLabelManager, 'labelAt');
    rayClick(screenOf(new Vector3(0, 0, 0)));
    expect(labelAt).not.toHaveBeenCalled();
    mouseClick(screenOf(new Vector3(0, 0, 0)));
    expect(labelAt).toHaveBeenCalledTimes(1);
  });
});

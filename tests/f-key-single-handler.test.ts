// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-515 §9.4 — exactly ONE F handler (F1), the 1 mm framing floor (F2) and
 * the per-viewer keyboard scope (R3-2), in the REAL viewer.
 *
 * Phase 0 baseline (measured on 85e952ba before the duplicate window handler
 * was removed, with this test's first case): one KeyF with a selection →
 * `fitToNodes` 2×, `animateCameraTo` 2× (rv-selection-manager document
 * listener + rv-viewer window listener; the second overwrote the first's
 * animation). After Phase 1a: 1× / 1×.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { objectToGlb } from '../src/core/import/rv-import-object';
import {
  SelectionManager, registerKeyboardScope, unregisterKeyboardScope,
} from '../src/core/engine/rv-selection-manager';
import { fitFloor } from '../src/core/engine/rv-navigation-math';

const W = 640;
const H = 480;
let handle: TestViewerHandle | null = null;
const paths: Record<string, string> = {};

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame();
}

function key(target: EventTarget, k: string, extra: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key: k, code: k === 'Escape' ? 'Escape' : `Key${k.toUpperCase()}`, bubbles: true, cancelable: true, ...extra,
  });
  target.dispatchEvent(ev);
  return ev;
}

beforeAll(async () => {
  handle = await createTestViewer('webgl', { width: W, height: H });
  const root = new Group(); root.name = 'FScene';
  const mat = new MeshStandardMaterial();
  // A kinematic axis: an empty that collects the group 'KG'.
  const axis = new Object3D(); axis.name = 'Axis';
  axis.userData.realvirtual = { Kinematic: { GroupName: 'KG' } };
  root.add(axis);
  const a = new Mesh(new BoxGeometry(0.4, 0.4, 0.4), mat); a.name = 'A';
  a.userData.realvirtual = { Group: { GroupName: 'KG' } };
  a.position.set(1, 0, 0);
  root.add(a);
  const b = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), mat); b.name = 'B'; b.position.set(-2, 0, 0);
  // A Drive (the default hover-enabled type), so a double-click resolves to it.
  b.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 0 } };
  root.add(b);
  // A 5 mm part (F2: a 5 mm part fills >= 60 % of the smaller image edge after F).
  const tiny = new Mesh(new BoxGeometry(0.005, 0.005, 0.005), mat); tiny.name = 'Tiny'; tiny.position.set(0, 0, 2);
  tiny.userData.realvirtual = { Kinematic: { GroupName: '' } };
  root.add(tiny);
  await handle.viewer.loadModel('fkey.glb', { data: await objectToGlb(root) });
  handle.viewer.scene.traverse((o) => {
    const p = handle!.viewer.registry!.getPathForNode(o);
    if (p) paths[o.name] = p;
  });
}, 60_000);

afterAll(() => { handle?.dispose(); handle = null; });

/** Close the double-F window: a second F within 350 ms frames the whole scene (FF),
 *  and the cases here press F back to back — each press must count as a first one. */
function freshF(): void {
  if (handle) (handle.viewer.selectionManager as unknown as { _lastFPressMs: number })._lastFPressMs = -Infinity;
}

beforeEach(() => {
  vi.restoreAllMocks();
  handle?.viewer.selectionManager.clear();
  freshF();
});

describe('F: exactly one handler (plan-515 F1)', () => {
  it('the fixture has paths for the selectable nodes', () => {
    expect(paths.B).toBeTruthy();
    expect(paths.Axis).toBeTruthy();
    expect(paths.Tiny).toBeTruthy();
  });

  it('one KeyF with a selection → fitToNodes 1× and animateCameraTo 1× (Phase 0 baseline: 2× / 2×)', () => {
    const v = handle!.viewer;
    v.selectionManager.select(paths.B);
    const fit = vi.spyOn(v, 'fitToNodes');
    const anim = vi.spyOn(v, 'animateCameraTo');
    const ev = key(document.body, 'f');
    console.log(`[plan-515] one KeyF: fitToNodes=${fit.mock.calls.length} animateCameraTo=${anim.mock.calls.length}`);
    expect(fit).toHaveBeenCalledTimes(1);
    expect(anim).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('KeyF inside the viewer container is handled once too (container listener, no document double)', () => {
    const v = handle!.viewer;
    v.selectionManager.select(paths.B);
    const fit = vi.spyOn(v, 'fitToNodes');
    key(handle!.container, 'f');
    freshF();
    key(v.renderer.domElement, 'f');
    expect(fit).toHaveBeenCalledTimes(2);
  });

  it('FF (second F within the double-press window) frames the whole scene, not the selection', () => {
    const v = handle!.viewer;
    v.selectionManager.select(paths.B);
    const fit = vi.spyOn(v, 'fitToNodes');
    const scene = vi.spyOn(v, 'frameSceneContent');
    key(document.body, 'f');
    key(document.body, 'f');
    expect(fit).toHaveBeenCalledTimes(1);
    expect(scene).toHaveBeenCalledTimes(1);
  });

  it('F announces the primary node as object-focus without re-opening the inspector', () => {
    const v = handle!.viewer;
    v.selectionManager.select(paths.B);
    const seen: Array<{ path: string; openInspector?: boolean }> = [];
    const off = v.on('object-focus', (d) => { seen.push({ path: d.path, openInspector: d.openInspector }); });
    key(document.body, 'f');
    off();
    expect(seen).toEqual([{ path: paths.B, openInspector: false }]);
  });

  it('Shift+F with a selection frames the WHOLE scene', () => {
    const v = handle!.viewer;
    v.selectionManager.select(paths.B);
    const fit = vi.spyOn(v, 'fitToNodes');
    const scene = vi.spyOn(v, 'frameSceneContent');
    key(document.body, 'F', { shiftKey: true });
    expect(fit).not.toHaveBeenCalled();
    expect(scene).toHaveBeenCalledTimes(1);
  });

  it('F without a selection frames the scene; Ctrl/Cmd/Alt+F are left to the browser', () => {
    const v = handle!.viewer;
    const scene = vi.spyOn(v, 'frameSceneContent');
    key(document.body, 'f');
    expect(scene).toHaveBeenCalledTimes(1);
    const ev = key(document.body, 'f', { ctrlKey: true });
    expect(ev.defaultPrevented).toBe(false);
    expect(scene).toHaveBeenCalledTimes(1);
  });

  it('a selected kinematic axis frames its whole collected group (moved from the old window handler)', () => {
    const v = handle!.viewer;
    v.selectionManager.select(paths.Axis);
    const fit = vi.spyOn(v, 'fitToNodes');
    key(document.body, 'f');
    expect(fit).toHaveBeenCalledTimes(1);
    const nodes = fit.mock.calls[0][0] as Object3D[];
    const members = v.groups!.get('KG')!.nodes;
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) expect(nodes).toContain(m);
  });

  it('F in a text field does nothing', () => {
    const v = handle!.viewer;
    v.selectionManager.select(paths.B);
    const fit = vi.spyOn(v, 'fitToNodes');
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      key(input, 'f');
      expect(fit).not.toHaveBeenCalled();
    } finally { input.remove(); }
  });

  it('double-click focus is unchanged (one fitToNodes at most, object-focus emitted)', async () => {
    const v = handle!.viewer;
    const bNode = v.registry!.getNode(paths.B)!;
    v.fitToNodes([bNode], undefined, { duration: 0.01 });
    await frames(6);
    const fit = vi.spyOn(v, 'fitToNodes');
    const focus: string[] = [];
    const off = v.on('object-focus', (d) => { focus.push(d.path); });
    const r = v.renderer.domElement.getBoundingClientRect();
    v.renderer.domElement.dispatchEvent(new MouseEvent('dblclick', {
      clientX: r.left + W / 2, clientY: r.top + H / 2, bubbles: true, cancelable: true,
    }));
    off();
    console.log(`[plan-515] dblclick: object-focus ${JSON.stringify(focus)}, fitToNodes ${fit.mock.calls.length}, innerWidth ${window.innerWidth}`);
    expect(focus).toEqual([paths.B]);
    // Unchanged rule: the compact (< 900 px) layout opens the sheet without zooming.
    expect(fit.mock.calls.length).toBe(window.innerWidth >= 900 ? 1 : 0);
  });
});

describe('Escape keeps working on the keyboard scope', () => {
  it('Escape clears the selection — from the container and from outside every viewer', () => {
    const v = handle!.viewer;
    v.selectionManager.select(paths.B);
    key(handle!.container, 'Escape');
    expect(v.selectionManager.count).toBe(0);
    v.selectionManager.select(paths.B);
    key(document.body, 'Escape');
    expect(v.selectionManager.count).toBe(0);
  });

  it('Escape with a selection isolate exits the isolate first and keeps the selection', () => {
    const v = handle!.viewer;
    v.selectionManager.select(paths.B);
    v.isolateNodes([v.registry!.getNode(paths.B)!], false);
    expect(v.isSelectionIsolateActive).toBe(true);
    key(document.body, 'Escape');
    expect(v.isSelectionIsolateActive).toBe(false);
    expect(v.selectionManager.count).toBe(1);
    key(document.body, 'Escape');
    expect(v.selectionManager.count).toBe(0);
  });
});

describe('keyboard scope per viewer (plan-515 R3-2)', () => {
  it('the container is focusable and holds the focus after a load and on a canvas press', () => {
    const v = handle!.viewer;
    expect(handle!.container.tabIndex).toBe(0);
    expect(v.keyboardScope).toBe(handle!.container);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const cv = v.renderer.domElement;
    const cap = cv.setPointerCapture;
    const rel = cv.releasePointerCapture;
    cv.setPointerCapture = () => {}; // OrbitControls captures; a synthetic pointer cannot be captured
    cv.releasePointerCapture = () => {};
    try {
      cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7 }));
      cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 7 }));
    } finally { cv.setPointerCapture = cap; cv.releasePointerCapture = rel; }
    expect(document.activeElement).toBe(handle!.container);
  });

  it('keys inside ANOTHER viewer scope do not reach the main viewer; that viewer reacts alone', () => {
    const v = handle!.viewer;
    v.selectionManager.select(paths.B);
    const fit = vi.spyOn(v, 'fitToNodes');
    const scene = vi.spyOn(v, 'frameSceneContent');

    // A second viewer on the page (embed stand-in): its own container + SelectionManager.
    const other = document.createElement('div');
    other.tabIndex = 0;
    document.body.appendChild(other);
    const otherFits: Object3D[][] = [];
    let otherScene = 0;
    const node = new Object3D();
    const host = {
      on: () => () => {}, emit: () => {},
      registry: { getNode: () => node, getPathForNode: () => 'X' },
      highlighter: { clearSelection() {}, highlightSelection() {} },
      fitToNodes: (n: Object3D[]) => { otherFits.push(n); },
      frameSceneContent: () => { otherScene++; },
      keyboardScope: other,
    };
    const sm = new SelectionManager();
    sm.init(host as never);
    try {
      key(other, 'f');                      // nothing selected there → its scene
      key(other, 'F', { shiftKey: true });
      expect(otherScene).toBe(2);
      sm.select('X');
      key(other, 'f');
      expect(otherFits.length).toBe(1);
      // … and the main viewer saw none of it.
      expect(fit).not.toHaveBeenCalled();
      expect(scene).not.toHaveBeenCalled();
      expect(v.selectionManager.count).toBe(1);
      key(other, 'Escape');
      expect(sm.count).toBe(0);
      expect(v.selectionManager.count).toBe(1);
      // Keys in the main viewer do not reach the other one.
      key(handle!.container, 'f');
      expect(fit).toHaveBeenCalledTimes(1);
      expect(otherFits.length).toBe(1);
    } finally {
      sm.dispose();
      other.remove();
    }
  });

  it('scope registration is refcounted and removed on dispose', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const v = handle!.viewer;
    v.selectionManager.select(paths.B);
    const fit = vi.spyOn(v, 'fitToNodes');
    registerKeyboardScope(el);
    registerKeyboardScope(el);
    unregisterKeyboardScope(el);
    key(el, 'f');                             // still a scope → the main viewer ignores it
    expect(fit).not.toHaveBeenCalled();
    unregisterKeyboardScope(el);
    freshF();
    key(el, 'f');                             // no longer a scope → primary viewer handles it
    expect(fit).toHaveBeenCalledTimes(1);
    el.remove();
  });
});

describe('framing floor 1 mm (plan-515 F2)', () => {
  it('fitFloor(5 mm) = 5 mm (was 10 cm)', () => {
    expect(fitFloor(0.005)).toBe(0.005);
    expect(fitFloor(0)).toBe(0.001);
  });

  it('F on a 5 mm part fills >= 60 % of the smaller image edge', async () => {
    const v = handle!.viewer;
    const tiny = v.registry!.getNode(paths.Tiny)!;
    v.selectionManager.select(paths.Tiny);
    key(document.body, 'f');
    for (let i = 0; i < 120 && (v as unknown as { _cameraManager: { isCameraAnimating: boolean } })._cameraManager.isCameraAnimating; i++) await frame();
    await frames(2);
    const cam = (v as unknown as { _activeCamera: PerspectiveCamera })._activeCamera;
    cam.updateMatrixWorld();
    const box = new Box3().setFromObject(tiny);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new Vector3(x, y, z).project(cam);
      const px = (p.x + 1) / 2 * W, py = (1 - p.y) / 2 * H;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
    const extent = Math.max(maxX - minX, maxY - minY) / Math.min(W, H);
    console.log(`[plan-515] F on 5 mm: screen extent ${(extent * 100).toFixed(1)} % of the smaller edge, camera distance ${cam.position.distanceTo(v.controls.target).toFixed(4)} m, near ${cam.near.toExponential(2)}`);
    expect(extent).toBeGreaterThanOrEqual(0.6);
    expect(cam.near).toBeLessThan(cam.position.distanceTo(box.getCenter(new Vector3())) - 0.0025);
  });

  it('focusByPath uses the 1 mm floor; an opt-in minDistance keeps its floor', () => {
    const v = handle!.viewer;
    const anim = vi.spyOn(v, 'animateCameraTo');
    v.focusByPath(paths.Tiny);
    const [pos, tgt] = anim.mock.calls[0] as [Vector3, Vector3];
    const cm = (v as unknown as { _cameraManager: { fitDistance(m: number, k: number): number } })._cameraManager;
    expect(pos.distanceTo(tgt)).toBeCloseTo(cm.fitDistance(0.005, 2.5), 6);
    expect(pos.distanceTo(tgt)).toBeLessThan(cm.fitDistance(0.1, 2.5) / 5);

    anim.mockClear();
    v.fitToNodes([v.registry!.getNode(paths.Tiny)!], undefined, { minDistance: 0.5 });
    const [pos2, tgt2] = anim.mock.calls[0] as [Vector3, Vector3];
    expect(pos2.distanceTo(tgt2)).toBeCloseTo(0.5, 6);
  });
});

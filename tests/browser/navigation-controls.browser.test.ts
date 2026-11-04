// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-515 Phase 1a — surface-relative wheel navigation in the REAL viewer
 * with REAL OrbitControls (the NavigationController is always on).
 *
 *  (a)  R2-3: rotate / pan drag released → immediate off-centre wheel → no view
 *       swing from pending damping; the hit stays under the cursor.
 *  (a2) toward the surface, never through it; saturates at 0.5 mm.
 *  (a3) zoom-out is CLAMPED at the cap, not refused.
 *  (a4) the Zoom slider scales the controller step.
 *  (b)  R2-1: a clipping change during a running projection animation refreshes
 *       the stored endpoint matrices.
 *  (b2) R3-3: an off-centre wheel during a projection tween completes the tween
 *       first — both directions, incl. animated ortho → perspective after an
 *       ortho zoom; the picked point stays <= 1 px under the cursor.
 *  (b3) a pointer-down on the canvas completes the tween too.
 *  (c)  R2-2: ortho wheel zoom → perspective → ortho keeps the visible height.
 *  (d)  20 wheel events in one frame → exactly one raycastSurface.
 *  (f)  spike finding 1: a trackpad two-finger vertical drag orbits and does
 *       NOT also dolly.
 *  (g)  touch pinch zooms (Phase 2: through the controller).
 *  (h)  'start' / 'end' once per wheel GESTURE, not per notch.
 *  (i)  HMI elements inside the container keep their wheel.
 *  (j)  wheel anchor: the cursor by default (decision 2026-09-29), the canvas
 *       centre with `wheelZoomToCursor = false`; a trackpad pinch (ctrl+wheel)
 *       anchors under the pointer in both modes; both navigation settings reach
 *       the controller through `applyVisualSettings` and `setControlsConfig`.
 *
 * The cases (a)–(i) measure the hit UNDER THE CURSOR — the default anchor.
 *
 * Default navigation (o1–o4, the pre-515 OrbitControls feel): right-drag and
 * one finger orbit about the FIXED `controls.target` (no pick), middle-drag pan
 * keeps the cursor's point on the plane through the target, the wheel anchors
 * at the cursor and never passes through a surface.
 *
 * Phase 2 (§9.5) — run with `navigateAroundCursorPoint = true` (the option that
 * keeps the surface-pivot behaviour): (p1) right-drag orbit about the surface point under the
 * cursor without a view jump; (p2) surface grab → orbit → background grab →
 * orbit about the SAME world point; (p3) middle-drag pan keeps the point <= 1 px
 * (perspective + ortho); (p4) touch orbit / pinch / two-finger pan; (p5)
 * pointercancel / lostpointercapture → no residual motion; (p6) FPV → inactive;
 * (p7) orbit-Follow → orbit about the carried target, pan inert, agent eye lets go;
 * (p7b) Sit-On → no gesture; (p8) animateCameraTo (bookmark flight) stops the
 * inertia + resets the pivot; (p9) view-state restore / projection switch reset
 * the pivot; (p10) multiuser broadcast + remote take-over.
 *
 * The R3-5 allocation assertion lives in navigation-allocations.browser.test.ts
 * (own page state: JIT feedback of the cases above must not leak into it).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Box3, BoxGeometry, Euler, Group, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera, Plane, Quaternion, Raycaster,
  SphereGeometry, Vector2, Vector3,
} from 'three';
import type { OrthographicCamera } from 'three';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import type { SurfaceHit } from '../../src/core/engine/rv-raycast-manager';
import { nearFarFor, orthoNearFarFor, type NearFar } from '../../src/core/engine/rv-navigation-math';
import { MAX_OUT_RADII, GESTURE_IDLE_MS } from '../../src/core/engine/rv-navigation-controller';
import type { ProjectionAnimation, CameraManager } from '../../src/core/rv-camera-manager';
import { restoreViewState } from '../../src/core/rv-view-state';
import { MultiuserPlugin } from '../../src/plugins/multiuser-plugin';
import { getDefaultVisualSettings } from '../../src/core/hmi/visual-settings-store';

const W = 640;
const H = 480;

let handle: TestViewerHandle | null = null;

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame();
}

/** A small machine: floor, boxes and spheres — a few thousand triangles, all opaque. */
function makeScene(): Group {
  const root = new Group();
  root.name = 'NavScene';
  const mat = new MeshStandardMaterial({ color: 0x8899aa });
  const floor = new Mesh(new BoxGeometry(4, 0.1, 4), mat);
  floor.name = 'Floor';
  floor.position.set(0, -0.05, 0);
  root.add(floor);
  for (let i = 0; i < 9; i++) {
    const b = new Mesh(new BoxGeometry(0.4, 0.6, 0.4), mat);
    b.name = `Box${i}`;
    b.position.set((i % 3) - 1, 0.3, Math.floor(i / 3) - 1);
    root.add(b);
    const s = new Mesh(new SphereGeometry(0.15, 24, 12), mat);
    s.name = `Ball${i}`;
    s.position.set((i % 3) - 1, 0.75, Math.floor(i / 3) - 1);
    root.add(s);
  }
  return root;
}

interface Internals {
  _cameraManager: CameraManager;
  perspCamera: PerspectiveCamera;
  orthoCamera: OrthographicCamera;
  _activeCamera: PerspectiveCamera | OrthographicCamera;
}

function internals(): Internals {
  return handle!.viewer as unknown as Internals;
}

function canvas(): HTMLCanvasElement {
  return handle!.viewer.renderer.domElement as HTMLCanvasElement;
}

function wheel(x: number, y: number, deltaY: number, extra: Partial<WheelEventInit> = {}): WheelEvent {
  const r = canvas().getBoundingClientRect();
  const ev = new WheelEvent('wheel', {
    clientX: r.left + x, clientY: r.top + y, deltaY, deltaMode: 0, bubbles: true, cancelable: true, ...extra,
  });
  canvas().dispatchEvent(ev);
  return ev;
}

function pointer(type: string, x: number, y: number, buttons: number, button: number, pointerId = 1, pointerType = 'mouse'): void {
  const r = canvas().getBoundingClientRect();
  canvas().dispatchEvent(new PointerEvent(type, {
    clientX: r.left + x, clientY: r.top + y, pointerId, pointerType,
    button, buttons, bubbles: true, cancelable: true, isPrimary: pointerId === 1,
  }));
}

/** OrbitControls captures the pointer; a synthetic pointerId cannot be captured. */
async function withoutPointerCapture(fn: () => Promise<void>): Promise<void> {
  const cv = canvas();
  const origCapture = cv.setPointerCapture;
  const origRelease = cv.releasePointerCapture;
  cv.setPointerCapture = () => {};
  cv.releasePointerCapture = () => {};
  try { await fn(); } finally {
    cv.setPointerCapture = origCapture;
    cv.releasePointerCapture = origRelease;
  }
}

function forward(): Vector3 {
  const cam = internals()._activeCamera;
  cam.updateMatrixWorld();
  return new Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
}

/** Screen pixel (relative to the canvas) of a world point. */
function toPixel(p: Vector3): { x: number; y: number } {
  const cam = internals()._activeCamera;
  cam.updateMatrixWorld();
  const v = p.clone().project(cam);
  return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H };
}

function newHit(): SurfaceHit {
  return { point: new Vector3(), distance: 0, blocked: false, path: null };
}

/** An off-centre canvas pixel (>= minR px from the centre) whose ray hits geometry. */
function offCentreHit(minR = 120): { x: number; y: number } {
  const v = handle!.viewer;
  const r = canvas().getBoundingClientRect();
  const out = newHit();
  for (let y = 40; y < H - 40; y += 20) {
    for (let x = W - 60; x > 40; x -= 20) {
      if (Math.hypot(x - W / 2, y - H / 2) < minR) continue;
      if (v.raycastManager!.raycastSurface(r.left + x, r.top + y, out)) return { x, y };
    }
  }
  throw new Error('no off-centre pixel over geometry');
}

async function setPose(pos: [number, number, number], tgt: [number, number, number]): Promise<void> {
  const v = handle!.viewer;
  internals()._cameraManager.cancelCameraAnimation();
  internals()._activeCamera.position.set(...pos);
  v.controls.target.set(...tgt);
  v.controls.update();
  // Let any inertia settle completely.
  await frames(4);
}

/** Record the points `raycastSurface` answers (the pick the controller acts on). */
function recordSurfacePicks(): { points: Vector3[]; restore: () => void } {
  const rm = handle!.viewer.raycastManager!;
  const orig = rm.raycastSurface.bind(rm);
  const points: Vector3[] = [];
  const spy = vi.spyOn(rm, 'raycastSurface').mockImplementation((x: number, y: number, out: SurfaceHit) => {
    const hit = orig(x, y, out);
    if (hit) points.push(out.point.clone());
    return hit;
  });
  return { points, restore: () => spy.mockRestore() };
}

beforeAll(async () => {
  handle = await createTestViewer('webgl', { width: W, height: H });
  const bytes = await objectToGlb(makeScene());
  await handle.viewer.loadModel('nav-515.glb', { data: bytes });
  // Defaults (decision 2026-09-29): the wheel anchors at the cursor, orbit /
  // pan about controls.target. (a)–(i) measure the hit under the cursor.
  expect(handle.viewer.navController!.wheelZoomToCursor).toBe(true);
  expect(handle.viewer.navController!.navigateAroundCursorPoint).toBe(false);
  await frames(3);
}, 60_000);

afterAll(() => {
  handle?.dispose();
  handle = null;
});

afterEach(async () => {
  const v = handle?.viewer;
  if (!v) return;
  const cm = internals()._cameraManager;
  cm.cancelProjectionAnimation();
  if (v.projection !== 'perspective') v.projection = 'perspective';
  v.controls.zoomSpeed = 1;
  if (v.navController) v.navController.wheelZoomToCursor = true;
  await new Promise((r) => setTimeout(r, GESTURE_IDLE_MS + 50));
  await frames(2); // let a wheel gesture end ('end' after GESTURE_IDLE_MS)
});

describe('plan-515 Phase 1a — wheel zoom toward the surface (real OrbitControls)', () => {
  it('is always wired: controller, pick backend, scene scale', () => {
    const v = handle!.viewer;
    expect(v.navController).not.toBeNull();
    expect(v.raycastManager).not.toBeNull();
    const sc = v.sceneScale.get();
    expect(sc.empty).toBe(false);
    expect(sc.radius).toBeGreaterThan(2); // 4 m floor diagonal / 2
    // OrbitControls' own zoom flag stays ON (harmless: it gets no input), the controller owns the wheel.
    expect(v.controls.enableZoom).toBe(true);
  });

  // ─── (a) R2-3 ────────────────────────────────────────────────────
  for (const drag of ['rotate', 'pan'] as const) {
    it(`(a) ${drag} drag released → immediate off-centre wheel: no swing, hit under the cursor`, async () => {
      const v = handle!.viewer;
      const nav = v.navController!;
      await setPose([3, 2.5, 4], [0, 0.3, 0]);
      await withoutPointerCapture(async () => {
        const btn = drag === 'rotate' ? 2 : 1;
        const btns = drag === 'rotate' ? 2 : 4;
        pointer('pointerdown', 320, 240, btns, btn);
        for (let i = 1; i <= 6; i++) {
          pointer('pointermove', 320 + i * 20, 240 + i * 4, btns, -1);
          await frame();
        }
        pointer('pointerup', 440, 264, 0, btn);
      });
      // Immediately (same task, no frame in between): off-centre wheel.
      const { x: cx, y: cy } = offCentreHit();
      const out = newHit();
      const r = canvas().getBoundingClientRect();
      expect(v.raycastManager!.raycastSurface(r.left + cx, r.top + cy, out), 'cursor is over geometry').toBe(true);
      const hitPoint = out.point.clone();
      const fwd0 = forward();
      const zoomsBefore = nav.stats.zooms;
      wheel(cx, cy, -100);
      let maxDeg = 0;
      for (let i = 0; i < 10; i++) {
        await frame();
        maxDeg = Math.max(maxDeg, fwd0.angleTo(forward()) * 180 / Math.PI);
      }
      const px = toPixel(hitPoint);
      const pxErr = Math.hypot(px.x - cx, px.y - cy);
      console.log(`[plan-515] (a) ${drag}: max view change ${maxDeg.toFixed(4)}°, hit pixel error ${pxErr.toFixed(3)} px`);
      expect(nav.stats.zooms).toBe(zoomsBefore + 1);
      expect(maxDeg).toBeLessThan(0.1);
      expect(pxErr).toBeLessThanOrEqual(1);
    });
  }

  it('(a2) the zoom moves toward the surface and never through it', async () => {
    const v = handle!.viewer;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const { x: cx, y: cy } = offCentreHit();
    const out = newHit();
    const r = canvas().getBoundingClientRect();
    expect(v.raycastManager!.raycastSurface(r.left + cx, r.top + cy, out)).toBe(true);
    const H0 = out.point.clone();
    const fwd0 = forward();
    let last = internals()._activeCamera.position.distanceTo(H0);
    for (let k = 0; k < 60; k++) {
      wheel(cx, cy, -100);
      await frame();
      const d = internals()._activeCamera.position.distanceTo(H0);
      expect(d).toBeLessThanOrEqual(last + 1e-9);
      expect(d).toBeGreaterThanOrEqual(0.0005 - 1e-9);
      last = d;
    }
    await frames(3);
    const px = toPixel(H0);
    console.log(`[plan-515] (a2) after 60 notches: distance ${last.toExponential(3)} m, ` +
      `view change ${(fwd0.angleTo(forward()) * 180 / Math.PI).toFixed(5)}°, ` +
      `pixel error ${Math.hypot(px.x - cx, px.y - cy).toFixed(3)} px, near ${internals().perspCamera.near.toExponential(3)}`);
    expect(last).toBeLessThan(0.001);
    expect(fwd0.angleTo(forward()) * 180 / Math.PI).toBeLessThan(0.1);
    expect(internals().perspCamera.near).toBeLessThan(last);
  });

  it('(a3) zooming out is CLAMPED at the cap sphere, not refused', async () => {
    const v = handle!.viewer;
    const sc = v.sceneScale.get();
    const cap = MAX_OUT_RADII * sc.radius;
    // Just inside the cap: one outward notch (×1.25 of the distance) would overshoot.
    const dir = new Vector3(3, 2.5, 4).normalize();
    const start = sc.center.clone().addScaledVector(dir, cap * 0.97);
    await setPose([start.x, start.y, start.z], [sc.center.x, sc.center.y, sc.center.z]);
    const before = internals()._activeCamera.position.distanceTo(sc.center);
    wheel(W / 2, H / 2, 100);
    await frames(2);
    const after = internals()._activeCamera.position.distanceTo(sc.center);
    console.log(`[plan-515] (a3) cap ${cap.toFixed(3)} m: ${before.toFixed(3)} → ${after.toFixed(3)} m`);
    expect(after).toBeGreaterThan(before + 1e-6);     // it moved (not refused)
    expect(after).toBeLessThanOrEqual(cap + 1e-6);    // but not past the cap
    expect(after).toBeCloseTo(cap, 3);
    // A further zoom-out at the cap stays there.
    wheel(W / 2, H / 2, 100);
    await frames(2);
    expect(internals()._activeCamera.position.distanceTo(sc.center)).toBeLessThanOrEqual(cap + 1e-6);
  });

  it('(a4) the Zoom slider scales the controller step', async () => {
    const v = handle!.viewer;
    const ratio = async (zoomSpeed: number): Promise<number> => {
      await setPose([3, 2.5, 4], [0, 0.3, 0]);
      v.controls.zoomSpeed = zoomSpeed;
      const out = newHit();
      const r = canvas().getBoundingClientRect();
      expect(v.raycastManager!.raycastSurface(r.left + W / 2, r.top + H / 2, out)).toBe(true);
      const d0 = internals()._activeCamera.position.distanceTo(out.point);
      wheel(W / 2, H / 2, -100);
      await frames(2);
      return internals()._activeCamera.position.distanceTo(out.point) / d0;
    };
    expect(await ratio(1)).toBeCloseTo(0.8, 3);
    expect(await ratio(2)).toBeCloseTo(0.6, 3);
  });

  // ─── (b) R2-1 ────────────────────────────────────────────────────
  it('(b) a clipping change during a projection animation refreshes the stored endpoints', async () => {
    const v = handle!.viewer;
    const cm = internals()._cameraManager;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    v.animateProjectionTo('orthographic', 1.5);
    const anim0 = cm.projectionAnim as ProjectionAnimation;
    const staleFrom = anim0.fromMatrix.clone();
    await frames(3);
    const nearBefore = internals().perspCamera.near;
    // No navigation input (that would complete the tween, R3-3): move the pose
    // programmatically much closer — the per-frame clipping follows.
    internals()._activeCamera.position.set(0.3, 0.9, 0.4);
    v.controls.target.set(0, 0.75, 0);
    await frames(2);
    expect(cm.isProjectionAnimating, 'animation still running').toBe(true);
    const anim = cm.projectionAnim as ProjectionAnimation;
    const p = internals().perspCamera;
    const o = internals().orthoCamera;
    const expFrom = p.clone(); expFrom.updateProjectionMatrix();
    const expTo = o.clone(); expTo.updateProjectionMatrix();
    const maxDiff = (a: Matrix4, b: Matrix4) => Math.max(...a.elements.map((x, i) => Math.abs(x - b.elements[i])));
    const fromErr = maxDiff(anim.fromMatrix, expFrom.projectionMatrix);
    const toErr = maxDiff(anim.toMatrix, expTo.projectionMatrix);
    const t = Math.min(anim.elapsed / anim.duration, 1);
    const e = 1 - Math.pow(1 - t, 3);
    const live = anim.driveCam.projectionMatrix.elements;
    let lerpErr = 0;
    for (let i = 0; i < 16; i++) {
      lerpErr = Math.max(lerpErr, Math.abs(live[i] - (anim.fromMatrix.elements[i] + (anim.toMatrix.elements[i] - anim.fromMatrix.elements[i]) * e)));
    }
    const nf: NearFar = { near: 0, far: 0 };
    const cam = internals()._activeCamera;
    nearFarFor(cam.position.distanceTo(v.controls.target), cam.position, v.sceneScale.get(), nf);
    console.log(`[plan-515] (b) near ${nearBefore.toExponential(3)} → ${p.near.toExponential(3)}; |from−exp| ${fromErr.toExponential(2)}, ` +
      `|to−exp| ${toErr.toExponential(2)}, |live−lerp| ${lerpErr.toExponential(2)}`);
    expect(Math.abs(p.near - nf.near) / nf.near).toBeLessThan(0.0101);
    expect(fromErr).toBeLessThan(1e-9);
    expect(toErr).toBeLessThan(1e-9);
    expect(lerpErr).toBeLessThan(1e-6);
    expect(Math.abs(anim.fromMatrix.elements[14] - staleFrom.elements[14])).toBeGreaterThan(1e-6);

    for (let i = 0; i < 200 && cm.isProjectionAnimating; i++) await frame();
    await frames(2);
    expect(v.projection).toBe('orthographic');
    const oc = internals().orthoCamera;
    const onf: NearFar = { near: 0, far: 0 };
    orthoNearFarFor(oc.position, v.sceneScale.get(), onf, oc.position.distanceTo(v.controls.target));
    const clean = oc.clone(); clean.updateProjectionMatrix();
    expect(Math.abs(oc.far - onf.far) / onf.far).toBeLessThan(0.0101);
    expect(maxDiff(oc.projectionMatrix, clean.projectionMatrix)).toBeLessThan(1e-9);
  });

  // ─── (b2) R3-3 ───────────────────────────────────────────────────
  for (const dirCase of ['persp→ortho', 'ortho→persp after ortho zoom'] as const) {
    it(`(b2) off-centre wheel during a ${dirCase} tween completes the tween first; hit <= 1 px`, async () => {
      const v = handle!.viewer;
      const cm = internals()._cameraManager;
      await setPose([3, 2.5, 4], [0, 0.3, 0]);
      let to: 'orthographic' | 'perspective' = 'orthographic';
      if (dirCase !== 'persp→ortho') {
        v.projection = 'orthographic';
        await frames(2);
        const a = offCentreHit();
        for (let i = 0; i < 4; i++) { wheel(a.x, a.y, -100); await frame(); }
        await frames(2);
        expect(internals().orthoCamera.zoom).toBeGreaterThan(1.5);
        to = 'perspective';
      }
      v.animateProjectionTo(to, 1.5);
      await frames(4);
      expect(cm.isProjectionAnimating).toBe(true);
      // Candidate pixel through the tween's TARGET camera (what the pick will use
      // once the input completed the tween): an off-centre ball centre.
      const endCam = to === 'orthographic' ? internals().orthoCamera : internals().perspCamera;
      endCam.updateMatrixWorld();
      let cx = -1, cy = -1;
      for (let i = 0; i < 9 && cx < 0; i++) {
        const q = new Vector3((i % 3) - 1, 0.75, Math.floor(i / 3) - 1).project(endCam);
        const px = { x: Math.round((q.x + 1) / 2 * W), y: Math.round((1 - q.y) / 2 * H) };
        if (px.x < 60 || px.x > W - 60 || px.y < 60 || px.y > H - 60) continue;
        if (Math.hypot(px.x - W / 2, px.y - H / 2) < 100) continue;
        cx = px.x; cy = px.y;
      }
      expect(cx, 'an off-centre ball is in view of the end camera').toBeGreaterThanOrEqual(0);
      const rec = recordSurfacePicks();
      try {
        const done0 = v.navController!.stats.tweensCompleted;
        wheel(cx, cy, -100);
        // The tween is completed by the INPUT itself, before any frame.
        expect(cm.isProjectionAnimating).toBe(false);
        expect(v.projection).toBe(to);
        expect(v.navController!.stats.tweensCompleted).toBe(done0 + 1);
        await frames(2);
        expect(rec.points.length).toBe(1);
        const px = toPixel(rec.points[0]);
        const pxErr = Math.hypot(px.x - cx, px.y - cy);
        console.log(`[plan-515] (b2) ${dirCase}: hit pixel error after zoom ${pxErr.toFixed(3)} px`);
        expect(pxErr).toBeLessThanOrEqual(1);
      } finally {
        rec.restore();
      }
    });
  }

  it('(b3) a pointer-down on the canvas completes a running projection tween', async () => {
    const v = handle!.viewer;
    const cm = internals()._cameraManager;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    v.animateProjectionTo('orthographic', 1.5);
    await frames(2);
    await withoutPointerCapture(async () => {
      pointer('pointerdown', 320, 240, 2, 2);
      expect(cm.isProjectionAnimating).toBe(false);
      expect(v.projection).toBe('orthographic');
      pointer('pointerup', 320, 240, 0, 2);
    });
  });

  // ─── (c) R2-2 ────────────────────────────────────────────────────
  it('(c) ortho zoom → perspective → ortho keeps the visible height', async () => {
    const v = handle!.viewer;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    v.projection = 'orthographic';
    await frames(2);
    const o = internals().orthoCamera;
    const { x: cx, y: cy } = offCentreHit();
    const out = newHit();
    const r = canvas().getBoundingClientRect();
    expect(v.raycastManager!.raycastSurface(r.left + cx, r.top + cy, out)).toBe(true);
    const anchor = out.point.clone();
    for (let i = 0; i < 4; i++) { wheel(cx, cy, -100); await frame(); }
    await frames(2);
    const pa = toPixel(anchor);
    const anchorErr = Math.hypot(pa.x - cx, pa.y - cy);
    const visOrtho = () => (o.top - o.bottom) / o.zoom;
    const p = internals().perspCamera;
    const visPersp = () => 2 * p.position.distanceTo(v.controls.target) * Math.tan(p.fov * Math.PI / 360);
    const h0 = visOrtho();
    const ratios: number[] = [];
    for (let k = 0; k < 2; k++) {
      v.projection = 'perspective';
      await frames(2);
      ratios.push(visPersp() / h0);
      v.projection = 'orthographic';
      await frames(2);
      ratios.push(visOrtho() / h0);
    }
    console.log(`[plan-515] (c) anchor pixel error ${anchorErr.toFixed(3)} px, visible-height ratios ${ratios.map((x) => x.toFixed(4)).join(' / ')}`);
    expect(anchorErr).toBeLessThanOrEqual(1);
    for (const q of ratios) expect(Math.abs(q - 1)).toBeLessThan(0.01);
  });

  // ─── (d) one pick per frame ──────────────────────────────────────
  it('(d) 20 wheel events within one frame → exactly one raycastSurface', async () => {
    const v = handle!.viewer;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const spy = vi.spyOn(v.raycastManager!, 'raycastSurface');
    const picks0 = v.navController!.stats.picks;
    for (let i = 0; i < 20; i++) wheel(400, 260, -100);
    expect(spy).toHaveBeenCalledTimes(0); // nothing in the handler itself
    await frames(3);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(v.navController!.stats.picks - picks0).toBe(1);
    spy.mockRestore();
  });

  // ─── (f) spike finding 1 ─────────────────────────────────────────
  it('(f) a trackpad two-finger vertical drag orbits and does NOT also dolly', async () => {
    const v = handle!.viewer;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const cam = internals()._activeCamera;
    const d0 = cam.position.distanceTo(v.controls.target);
    const polar = () => new Vector3().subVectors(cam.position, v.controls.target).angleTo(new Vector3(0, 1, 0));
    const p0 = polar();
    const orbits0 = v.navController!.stats.trackpadOrbits;
    const zooms0 = v.navController!.stats.zooms;
    const events: WheelEvent[] = [];
    for (let i = 0; i < 10; i++) { events.push(wheel(320, 240, 8)); await frame(); }
    await frames(12);
    const d1 = cam.position.distanceTo(v.controls.target);
    console.log(`[plan-515] (f) trackpad drag: distance ${d0.toFixed(6)} → ${d1.toFixed(6)}, polar ${(p0 * 180 / Math.PI).toFixed(3)}° → ${(polar() * 180 / Math.PI).toFixed(3)}°`);
    expect(v.navController!.stats.trackpadOrbits - orbits0).toBe(10);
    expect(v.navController!.stats.zooms).toBe(zooms0);
    expect(Math.abs(d1 - d0) / d0).toBeLessThan(1e-6);          // no dolly (OrbitControls never saw the wheel)
    expect(Math.abs(polar() - p0)).toBeGreaterThan(0.1);        // but it orbited (10 × 8 px × 0.003 rad)
    for (const e of events) expect(e.defaultPrevented).toBe(true);
  });

  // ─── (g) touch pinch unchanged ──────────────────────────────────
  it('(g) touch pinch zooms (through the controller since Phase 2)', async () => {
    const v = handle!.viewer;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const cam = internals()._activeCamera;
    const d0 = cam.position.distanceTo(v.controls.target);
    await withoutPointerCapture(async () => {
      pointer('pointerdown', 300, 240, 1, 0, 11, 'touch');
      pointer('pointerdown', 340, 240, 1, 0, 12, 'touch');
      for (let i = 1; i <= 6; i++) {
        pointer('pointermove', 300 - i * 15, 240, 1, -1, 11, 'touch');
        pointer('pointermove', 340 + i * 15, 240, 1, -1, 12, 'touch');
        await frame();
      }
      pointer('pointerup', 210, 240, 0, 0, 11, 'touch');
      pointer('pointerup', 430, 240, 0, 0, 12, 'touch');
    });
    await frames(20);
    const d1 = cam.position.distanceTo(v.controls.target);
    console.log(`[plan-515] (g) touch pinch: distance ${d0.toFixed(4)} → ${d1.toFixed(4)}`);
    expect(d1).toBeLessThan(d0 * 0.95);
  });

  // ─── (h) start/end per gesture ──────────────────────────────────
  it(`(h) 'start' / 'end' once per wheel gesture, not per notch`, async () => {
    const v = handle!.viewer;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    let starts = 0, ends = 0, changes = 0;
    const onStart = () => { starts++; };
    const onEnd = () => { ends++; };
    const onChange = () => { changes++; };
    v.controls.addEventListener('start', onStart);
    v.controls.addEventListener('end', onEnd);
    v.controls.addEventListener('change', onChange);
    try {
      // Keep the burst synchronous so a delayed frame cannot expire the gesture.
      for (let i = 0; i < 6; i++) {
        const ev = wheel(320, 240, -100);
        v.navController!.tick(ev.timeStamp);
        v.controls.update();
      }
      expect(starts).toBe(1);
      expect(ends).toBe(0);
      expect(changes).toBeGreaterThanOrEqual(6);
      await new Promise((r) => setTimeout(r, GESTURE_IDLE_MS + 50));
      await frames(2);
      expect(ends).toBe(1);
      expect(starts).toBe(1);
    } finally {
      v.controls.removeEventListener('start', onStart);
      v.controls.removeEventListener('end', onEnd);
      v.controls.removeEventListener('change', onChange);
    }
  });

  // ─── (i) HMI inside the container keeps its wheel ───────────────
  it('(i) a wheel on an HMI element inside the viewer container is not taken', async () => {
    const v = handle!.viewer;
    const panel = document.createElement('div');
    handle!.container.appendChild(panel);
    try {
      const w0 = v.navController!.stats.wheelEvents;
      const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
      panel.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(v.navController!.stats.wheelEvents).toBe(w0);
    } finally {
      panel.remove();
    }
  });

  // ─── (j) wheel anchor: cursor (default) / centre (option) / pinch ─
  describe('(j) wheel zoom anchor', () => {
    /** Wheel once at (x, y) and return the client pixel the controller picked at. */
    async function pickedAt(x: number, y: number, deltaY: number, extra: Partial<WheelEventInit> = {}): Promise<{ x: number; y: number }> {
      const rm = handle!.viewer.raycastManager!;
      const spy = vi.spyOn(rm, 'raycastSurface');
      try {
        wheel(x, y, deltaY, extra);
        await frames(2);
        expect(spy).toHaveBeenCalledTimes(1);
        const [cx, cy] = spy.mock.calls[0];
        return { x: cx, y: cy };
      } finally {
        spy.mockRestore();
      }
    }

    it('wheelZoomToCursor = false: the mouse wheel anchors at the canvas centre, not at the cursor', async () => {
      const v = handle!.viewer;
      v.navController!.wheelZoomToCursor = false;
      await setPose([3, 2.5, 4], [0, 0.3, 0]);
      const { x: cx, y: cy } = offCentreHit();
      const r = canvas().getBoundingClientRect();
      const p = await pickedAt(cx, cy, -100);
      expect(Math.abs(p.x - (r.left + W / 2))).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y - (r.top + H / 2))).toBeLessThanOrEqual(1);
      // …and the surface point at the centre stays at the centre (pure dolly along the centre ray).
      await setPose([3, 2.5, 4], [0, 0.3, 0]);
      const out = newHit();
      expect(v.raycastManager!.raycastSurface(r.left + W / 2, r.top + H / 2, out), 'centre is over geometry').toBe(true);
      const centreHit = out.point.clone();
      wheel(cx, cy, -100);
      await frames(3);
      const px = toPixel(centreHit);
      expect(Math.hypot(px.x - W / 2, px.y - H / 2)).toBeLessThanOrEqual(1);
    });

    it('default (wheelZoomToCursor = true): the mouse wheel anchors at the cursor', async () => {
      const v = handle!.viewer;
      expect(getDefaultVisualSettings().wheelZoomToCursor).toBe(true);
      v.navController!.wheelZoomToCursor = true;
      await setPose([3, 2.5, 4], [0, 0.3, 0]);
      const { x: cx, y: cy } = offCentreHit();
      const r = canvas().getBoundingClientRect();
      const p = await pickedAt(cx, cy, -100);
      expect(Math.abs(p.x - (r.left + cx))).toBeLessThanOrEqual(1);
      expect(Math.abs(p.y - (r.top + cy))).toBeLessThanOrEqual(1);
    });

    for (const toCursor of [false, true]) {
      it(`trackpad pinch (ctrl+wheel) anchors under the pointer (wheelZoomToCursor = ${toCursor})`, async () => {
        const v = handle!.viewer;
        v.navController!.wheelZoomToCursor = toCursor;
        await setPose([3, 2.5, 4], [0, 0.3, 0]);
        const { x: cx, y: cy } = offCentreHit();
        const r = canvas().getBoundingClientRect();
        const p = await pickedAt(cx, cy, -3, { ctrlKey: true });
        expect(Math.abs(p.x - (r.left + cx))).toBeLessThanOrEqual(1);
        expect(Math.abs(p.y - (r.top + cy))).toBeLessThanOrEqual(1);
      });
    }
  });
});

// ═══ plan-515 Phase 2 — orbit / pan about the point under the cursor + touch ═══

/** Wait until a released drag no longer coasts (and the pose is quiet). */
async function settle(max = 400): Promise<void> {
  const nav = handle!.viewer.navController!;
  for (let i = 0; i < max && (nav.inertiaActive || nav.dragActive); i++) await frame();
  await frames(2);
}

/** A canvas pixel whose ray hits nothing (empty background). */
function backgroundPixel(): { x: number; y: number } {
  const v = handle!.viewer;
  const r = canvas().getBoundingClientRect();
  const out = newHit();
  for (let y = 8; y < H - 8; y += 12) {
    for (let x = 8; x < W - 8; x += 12) {
      if (!v.raycastManager!.raycastSurface(r.left + x, r.top + y, out)) return { x, y };
    }
  }
  throw new Error('no background pixel');
}

function hitAt(x: number, y: number): Vector3 {
  const out = newHit();
  const r = canvas().getBoundingClientRect();
  expect(handle!.viewer.raycastManager!.raycastSurface(r.left + x, r.top + y, out), `(${x},${y}) is over geometry`).toBe(true);
  return out.point.clone();
}

function pxErr(p: Vector3, x: number, y: number): number {
  const q = toPixel(p);
  return Math.hypot(q.x - x, q.y - y);
}

/** Distance of a point from the camera's view axis. */
function offAxis(p: Vector3): number {
  const cam = internals()._activeCamera;
  const f = forward();
  const v = p.clone().sub(cam.position);
  return v.sub(f.multiplyScalar(v.dot(f))).length();
}

function countEvents(): { starts: number; ends: number; off: () => void } {
  const c = { starts: 0, ends: 0, off: () => {} };
  const v = handle!.viewer;
  const s = () => { c.starts++; };
  const e = () => { c.ends++; };
  v.controls.addEventListener('start', s);
  v.controls.addEventListener('end', e);
  c.off = () => { v.controls.removeEventListener('start', s); v.controls.removeEventListener('end', e); };
  return c;
}

/** Right-drag from (x, y) by n steps of (dx, dy), one frame per step; returns max pivot pixel error / distance drift. */
async function rightDrag(x: number, y: number, n: number, dx: number, dy: number, pivot: Vector3 | null, release = true): Promise<{ px: number; dd: number }> {
  const cam = internals()._activeCamera;
  const pivot0 = pivot ? toPixel(pivot) : null;
  const d0 = pivot ? cam.position.distanceTo(pivot) : 0;
  let px = 0, dd = 0;
  pointer('pointerdown', x, y, 2, 2);
  await frames(2);
  for (let i = 1; i <= n; i++) {
    pointer('pointermove', x + i * dx, y + i * dy, 2, -1);
    await frame();
    if (pivot && pivot0) {
      const q = toPixel(pivot);
      px = Math.max(px, Math.hypot(q.x - pivot0.x, q.y - pivot0.y));
      dd = Math.max(dd, Math.abs(cam.position.distanceTo(pivot) - d0));
    }
  }
  if (release) pointer('pointerup', x + n * dx, y + n * dy, 0, 2);
  return { px, dd };
}

describe('plan-515 Phase 2 — orbit / pan about the point under the cursor, touch (real viewer)', () => {
  // These cases assert the surface-pivot behaviour, which is the OPTION since
  // the decision of 2026-09-29 (default: orbit about controls.target).
  beforeAll(() => { handle!.viewer.navController!.navigateAroundCursorPoint = true; });
  afterAll(() => { handle!.viewer.navController!.navigateAroundCursorPoint = false; });

  it('OrbitControls is a pure state holder: no mouse / touch mapping, no DOM input of its own', () => {
    const v = handle!.viewer;
    expect(v.controls.mouseButtons).toEqual({ LEFT: -1, MIDDLE: -1, RIGHT: -1 });
    expect(v.controls.touches).toEqual({ ONE: -1, TWO: -1 });
    expect(canvas().style.touchAction).toBe('none');
  });

  it('(p1) right-drag orbits about the SURFACE point under the cursor: no view jump, pivot keeps its pixel, start/end once', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const { x, y } = offCentreHit();
    const H0 = hitAt(x, y);
    expect(offAxis(H0), 'the grabbed point is off the view axis').toBeGreaterThan(0.2);
    const fwd0 = forward();
    const ev = countEvents();
    try {
      await withoutPointerCapture(async () => {
        pointer('pointerdown', x, y, 2, 2);
        expect(nav.pivot.distanceTo(H0), 'pivot = surface point at mouse-down').toBeLessThan(1e-9);
        expect(nav.dragActive).toBe(true);
        await frames(3);
        const jumpDeg = fwd0.angleTo(forward()) * 180 / Math.PI;
        expect(jumpDeg, 'grab without movement: the view does not move').toBeLessThan(1e-6);
        pointer('pointerup', x, y, 0, 2);
        await settle();
        const r = await rightDrag(x, y, 8, 7, 3, H0);
        const turned = fwd0.angleTo(forward()) * 180 / Math.PI;
        console.log(`[plan-515 P2] (p1) orbit about the surface point: pivot pixel drift ${r.px.toFixed(4)} px, ` +
          `distance drift ${r.dd.toExponential(2)} m, view turned ${turned.toFixed(2)}°`);
        expect(turned, 'it orbited').toBeGreaterThan(3);
        expect(r.px, 'no view jump: the pivot stays under the grab pixel').toBeLessThanOrEqual(1);
        expect(r.dd).toBeLessThan(1e-6);
      });
      await settle();
      // The camera invariant held through controls.update(): target on the view axis.
      expect(offAxis(v.controls.target)).toBeLessThan(1e-6);
      // The orbit writes the quaternion without its change callback (R3-5); the
      // same frame's controls.update() re-syncs the Euler rotation.
      const cam = internals()._activeCamera;
      const euler = new Euler().setFromQuaternion(cam.quaternion, cam.rotation.order);
      expect(Math.abs(euler.x - cam.rotation.x) + Math.abs(euler.y - cam.rotation.y) + Math.abs(euler.z - cam.rotation.z)).toBeLessThan(1e-9);
      expect(ev.starts).toBe(2); // the grab-only gesture + the orbit
      expect(ev.ends).toBe(2);
    } finally {
      ev.off();
    }
  });

  it('(p2) surface grab → orbit → BACKGROUND grab → orbit about the SAME world point', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const { x, y } = offCentreHit();
    const HA = hitAt(x, y);
    await withoutPointerCapture(async () => {
      await rightDrag(x, y, 5, -6, 2, HA);
    });
    await settle();
    expect(nav.pivot.distanceTo(HA)).toBeLessThan(1e-9);
    const bg = backgroundPixel();
    let r = { px: 0, dd: 0 };
    await withoutPointerCapture(async () => {
      const cam = internals()._activeCamera;
      pointer('pointerdown', bg.x, bg.y, 2, 2);
      expect(nav.pivot.distanceTo(HA), 'background keeps the pivot').toBeLessThan(1e-9);
      pointer('pointerup', bg.x, bg.y, 0, 2);
      await settle();
      const dA = cam.position.distanceTo(HA);
      r = await rightDrag(bg.x, bg.y, 6, 5, -4, HA);
      expect(Math.abs(cam.position.distanceTo(HA) - dA)).toBeLessThan(1e-6);
    });
    await settle();
    console.log(`[plan-515 P2] (p2) background grab at (${bg.x},${bg.y}): orbit about the SAME point, ` +
      `its pixel drift ${r.px.toFixed(4)} px, distance drift ${r.dd.toExponential(2)} m`);
    expect(nav.pivot.distanceTo(HA)).toBeLessThan(1e-9);
    expect(r.px).toBeLessThanOrEqual(1);
    expect(r.dd).toBeLessThan(1e-6);
  });

  for (const proj of ['perspective', 'orthographic'] as const) {
    it(`(p3) ${proj}: middle-drag pan keeps the grabbed point <= 1 px under the cursor`, async () => {
      const v = handle!.viewer;
      await setPose([3, 2.5, 4], [0, 0.3, 0]);
      if (proj === 'orthographic') { v.projection = 'orthographic'; await frames(3); }
      const { x, y } = offCentreHit();
      const G = hitAt(x, y);
      const fwd0 = forward();
      let maxErr = 0;
      await withoutPointerCapture(async () => {
        pointer('pointerdown', x, y, 4, 1);
        await frame();
        for (let i = 1; i <= 10; i++) {
          const cx = x - i * 11, cy = y + i * 6;
          pointer('pointermove', cx, cy, 4, -1);
          await frame();
          maxErr = Math.max(maxErr, pxErr(G, cx, cy));
        }
        pointer('pointerup', x - 110, y + 60, 0, 1);
      });
      await settle();
      console.log(`[plan-515 P2] (p3) ${proj} pan: max pixel error of the grabbed point ${maxErr.toFixed(4)} px`);
      expect(maxErr).toBeLessThanOrEqual(1);
      expect(fwd0.angleTo(forward())).toBeLessThan(1e-6); // a pan never rotates
      expect(offAxis(v.controls.target)).toBeLessThan(1e-6);
    });
  }

  it('(p4) touch: one-finger orbit about the touch point; pinch toward the surface under the midpoint; two-finger pan keeps it', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    const cam = internals()._activeCamera;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const { x, y } = offCentreHit();
    const T = hitAt(x, y);
    let orbitPx = 0, orbitDd = 0;
    await withoutPointerCapture(async () => {
      // One finger: orbit about the touched surface point.
      pointer('pointerdown', x, y, 1, 0, 21, 'touch');
      expect(nav.pivot.distanceTo(T)).toBeLessThan(1e-9);
      const p0 = toPixel(T);
      const d0 = cam.position.distanceTo(T);
      for (let i = 1; i <= 6; i++) {
        pointer('pointermove', x + i * 8, y - i * 2, 1, -1, 21, 'touch');
        await frame();
        const q = toPixel(T);
        orbitPx = Math.max(orbitPx, Math.hypot(q.x - p0.x, q.y - p0.y));
        orbitDd = Math.max(orbitDd, Math.abs(cam.position.distanceTo(T) - d0));
      }
      pointer('pointerup', x + 48, y - 12, 0, 0, 21, 'touch');
    });
    await settle();
    expect(nav.stats.orbits).toBeGreaterThan(0);
    expect(orbitPx).toBeLessThanOrEqual(1);
    expect(orbitDd).toBeLessThan(1e-6);

    // Two fingers: pinch (spread) about a surface midpoint, then pan both fingers.
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const m = offCentreHit(80);
    const A = hitAt(m.x, m.y);
    const fwd0 = forward();
    const dA0 = cam.position.distanceTo(A);
    let pinchErr = 0, panErr = 0, dA1 = 0;
    const pinches0 = nav.stats.pinches;
    await withoutPointerCapture(async () => {
      pointer('pointerdown', m.x - 20, m.y, 1, 0, 31, 'touch');
      pointer('pointerdown', m.x + 20, m.y, 1, 0, 32, 'touch');
      await frame();
      for (let i = 1; i <= 6; i++) {
        pointer('pointermove', m.x - 20 - i * 12, m.y, 1, -1, 31, 'touch');
        pointer('pointermove', m.x + 20 + i * 12, m.y, 1, -1, 32, 'touch');
        await frame();
        pinchErr = Math.max(pinchErr, pxErr(A, m.x, m.y));
      }
      dA1 = cam.position.distanceTo(A);
      const halfW = 20 + 6 * 12;
      for (let i = 1; i <= 6; i++) {
        const cx = m.x - i * 9, cy = m.y + i * 5;
        pointer('pointermove', cx - halfW, cy, 1, -1, 31, 'touch');
        pointer('pointermove', cx + halfW, cy, 1, -1, 32, 'touch');
        await frame();
        panErr = Math.max(panErr, pxErr(A, cx, cy));
      }
      pointer('pointerup', m.x - 54 - halfW, m.y + 30, 0, 0, 31, 'touch');
      pointer('pointerup', m.x - 54 + halfW, m.y + 30, 0, 0, 32, 'touch');
    });
    await settle();
    console.log(`[plan-515 P2] (p4) touch: orbit pivot drift ${orbitPx.toFixed(4)} px; pinch ${dA0.toFixed(4)} → ${dA1.toFixed(4)} m, ` +
      `anchor error ${pinchErr.toFixed(4)} px; two-finger pan anchor error ${panErr.toFixed(4)} px`);
    expect(nav.stats.pinches - pinches0).toBeGreaterThan(0);
    expect(dA1, 'spreading the fingers zooms toward the surface').toBeLessThan(dA0 * 0.7);
    expect(pinchErr).toBeLessThanOrEqual(1);
    expect(panErr).toBeLessThanOrEqual(1);
    expect(fwd0.angleTo(forward())).toBeLessThan(1e-6);
    expect(nav.dragActive).toBe(false);
  });

  for (const how of ['pointercancel', 'lostpointercapture'] as const) {
    it(`(p5) ${how} mid-drag ends the gesture WITHOUT residual motion`, async () => {
      const v = handle!.viewer;
      const nav = v.navController!;
      const cam = internals()._activeCamera;
      await setPose([3, 2.5, 4], [0, 0.3, 0]);
      const ev = countEvents();
      try {
        await withoutPointerCapture(async () => {
          await rightDrag(320, 240, 5, 15, 4, null, false); // fast drag: a release would coast
          canvas().dispatchEvent(new PointerEvent(how, { pointerId: 1, pointerType: 'mouse', bubbles: true }));
        });
        expect(nav.dragActive).toBe(false);
        expect(nav.inertiaActive).toBe(false);
        const pos = cam.position.clone();
        const f = forward();
        await frames(20);
        expect(cam.position.distanceTo(pos)).toBeLessThan(1e-12);
        expect(f.angleTo(forward())).toBeLessThan(1e-9);
        expect(ev.starts).toBe(1);
        expect(ev.ends).toBe(1);
      } finally {
        ev.off();
      }
    });
  }

  it('(p5b) a normal release coasts (own inertia) and stops by itself', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const inertia0 = nav.stats.inertiaFrames;
    await withoutPointerCapture(async () => { await rightDrag(320, 240, 5, 15, 4, null); });
    const f = forward();
    await frame();
    expect(nav.inertiaActive).toBe(true);
    await settle();
    expect(nav.inertiaActive).toBe(false);
    expect(nav.stats.inertiaFrames - inertia0).toBeGreaterThan(3);
    expect(f.angleTo(forward())).toBeGreaterThan(1e-4); // it coasted
  });

  it('(p6) FPV / XR (controls.enabled = false): the controller is inactive — no drag, no wheel, no touch', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    const cam = internals()._activeCamera;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const ev = countEvents();
    v.controls.enabled = false;
    try {
      const pos = cam.position.clone();
      const g0 = nav.stats.gestures;
      await withoutPointerCapture(async () => {
        await rightDrag(320, 240, 5, 15, 4, null);
        pointer('pointerdown', 300, 240, 4, 1);
        pointer('pointermove', 360, 250, 4, -1);
        await frame();
        pointer('pointerup', 360, 250, 0, 1);
        pointer('pointerdown', 320, 240, 1, 0, 41, 'touch');
        pointer('pointermove', 380, 240, 1, -1, 41, 'touch');
        await frame();
        pointer('pointerup', 380, 240, 0, 0, 41, 'touch');
      });
      const w = wheel(320, 240, -100);
      await frames(3);
      expect(w.defaultPrevented).toBe(false);
      expect(nav.stats.gestures).toBe(g0);
      expect(nav.dragActive).toBe(false);
      expect(ev.starts).toBe(0);
      expect(cam.position.distanceTo(pos)).toBeLessThan(1e-12);
    } finally {
      v.controls.enabled = true;
      ev.off();
    }
  });

  it('(p6b) controls disabled MID-drag (a gizmo / FPV takes over) cancels the drag without coasting', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    const cam = internals()._activeCamera;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    try {
      await withoutPointerCapture(async () => {
        await rightDrag(320, 240, 4, 15, 4, null, false);
        v.controls.enabled = false;
        await frame();
        expect(nav.dragActive).toBe(false);
        const pos = cam.position.clone();
        pointer('pointermove', 420, 280, 2, -1);
        await frames(5);
        expect(cam.position.distanceTo(pos)).toBeLessThan(1e-12);
        pointer('pointerup', 420, 280, 0, 2);
      });
    } finally {
      v.controls.enabled = true;
    }
    expect(nav.inertiaActive).toBe(false);
  });

  it('(p7) orbit-Follow: right-drag orbits about the CARRIED target of a moving node, no snap back; pan is inert; an agent-eye follow still lets go', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    const cam = internals()._activeCamera;
    await setPose([3, 2.5, 4], [0, 0.75, 0]);
    // A node driven along +X at 0.24 m/s (one step per rendered frame).
    const nodePos = new Vector3(0, 0.75, 0);
    let driving = true;
    const drive = (): void => {
      if (!driving) return;
      nodePos.x += 0.004;
      v.markRenderDirty();
      requestAnimationFrame(drive);
    };
    const src = {
      label: 'nav-515 moving follow probe',
      getWorldPosition: (out: Vector3) => { out.copy(nodePos); },
      getWorldQuaternion: (out: Quaternion) => { out.identity(); },
      getBounds: (out: Box3) => { out.setFromCenterAndSize(nodePos, new Vector3(0.3, 0.3, 0.3)); },
      isAlive: () => true,
    };
    requestAnimationFrame(drive);
    v.startCameraFollow(src);
    await frames(40); // the follow reaches its steady lag behind the moving node
    const orbits0 = nav.stats.orbits;
    const pans0 = nav.stats.pans;
    const refused0 = nav.stats.refusedGestures;
    const offset = (): Vector3 => cam.position.clone().sub(v.controls.target);
    const ev = countEvents();
    try {
      const off0 = offset();
      const fwd0 = forward();
      await withoutPointerCapture(async () => {
        pointer('pointerdown', 320, 240, 2, 2);
        expect(nav.dragActive, 'the drag runs during Follow').toBe(true);
        expect(nav.pivot.distanceTo(v.controls.target), 'pivot = carried follow target, not the surface').toBeLessThan(1e-9);
        await frames(3);
        const jumpDeg = fwd0.angleTo(forward()) * 180 / Math.PI;
        expect(jumpDeg, 'view direction continuous at gesture start').toBeLessThan(0.1);
        let distDrift = 0;
        for (let i = 1; i <= 8; i++) {
          pointer('pointermove', 320 + i * 9, 240 + i * 3, 2, -1);
          await frame();
          distDrift = Math.max(distDrift, Math.abs(offset().length() - off0.length()));
        }
        pointer('pointerup', 320 + 72, 240 + 24, 0, 2);
        await settle();
        const off1 = offset();
        const turned = off0.angleTo(off1) * 180 / Math.PI;
        const x1 = nodePos.x;
        const nodeDist1 = cam.position.distanceTo(nodePos);
        // The node keeps moving; the follow must keep the NEW offset (no snap back).
        await frames(40);
        const off2 = offset();
        const drift = off1.angleTo(off2) * 180 / Math.PI;
        const nodeDist2 = cam.position.distanceTo(nodePos);
        console.log(`[plan-515 P2] (p7) orbit-follow: turned ${turned.toFixed(2)}° about the carried target, ` +
          `distance drift ${distDrift.toExponential(2)} m during the drag, offset drift over 40 frames ` +
          `${drift.toExponential(2)}°, node moved ${(nodePos.x - x1).toFixed(3)} m, camera-node ${nodeDist1.toFixed(4)} → ${nodeDist2.toFixed(4)} m`);
        expect(turned, 'it orbited about the followed node').toBeGreaterThan(3);
        expect(distDrift, 'distance to the carried target constant').toBeLessThan(1e-6);
        expect(Math.abs(off2.length() - off0.length())).toBeLessThan(1e-6);
        expect(nodePos.x - x1, 'the node kept moving').toBeGreaterThan(0.1);
        expect(drift, 'no snap back while the node moves on').toBeLessThan(0.1);
        // Constant up to the follow's damping lag (~2 cm at this speed, frame-time dependent).
        expect(Math.abs(nodeDist2 - nodeDist1), 'distance to the followed node constant').toBeLessThan(0.01);
        expect(offAxis(v.controls.target)).toBeLessThan(1e-6);
      });
      expect(nav.stats.orbits).toBeGreaterThan(orbits0);
      expect(nav.stats.refusedGestures).toBe(refused0);
      expect(v.cameraFollowMode).toBe('follow');
      expect(ev.starts).toBe(1);
      expect(ev.ends).toBe(1);

      // Middle-drag pan during Follow: an inert gesture ('start' … 'end', no motion).
      const offP = offset();
      await withoutPointerCapture(async () => {
        pointer('pointerdown', 320, 240, 4, 1);
        expect(nav.dragActive).toBe(true);
        await frames(2);
        for (let i = 1; i <= 6; i++) { pointer('pointermove', 320 + i * 10, 240 + i * 4, 4, -1); await frame(); }
        expect(ev.ends, 'no start/end flicker: the pan holds its gesture').toBe(1);
        pointer('pointerup', 380, 264, 0, 1);
      });
      await settle();
      expect(ev.starts).toBe(2);
      expect(ev.ends).toBe(2);
      expect(nav.stats.pans).toBe(pans0);
      expect(offP.angleTo(offset()) * 180 / Math.PI).toBeLessThan(0.1);
      expect(Math.abs(offset().length() - offP.length())).toBeLessThan(1e-6);
      expect(v.cameraFollowMode).toBe('follow');

      // A follow that yields to the human on 'start' (agent-eye, plan-740): the drag is an ordinary one.
      const letGo = () => { v.stopCameraFollow(false); };
      v.controls.addEventListener('start', letGo);
      const orbits1 = nav.stats.orbits;
      try {
        await withoutPointerCapture(async () => { await rightDrag(320, 240, 5, 15, 4, null); });
      } finally {
        v.controls.removeEventListener('start', letGo);
      }
      expect(v.cameraFollowMode).toBe('off');
      expect(nav.stats.orbits).toBeGreaterThan(orbits1);
    } finally {
      driving = false;
      ev.off();
      if (v.cameraFollowMode !== 'off') v.stopCameraFollow(false);
      await settle();
    }
  });

  it('(p7b) Sit-On: no navigation gesture (controls disabled, look-around stays with the camera-follow plugin)', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const src = {
      label: 'nav-515 sit-on probe',
      getWorldPosition: (out: Vector3) => { out.set(0, 0.3, 0); },
      getWorldQuaternion: (out: Quaternion) => { out.identity(); },
      getBounds: (out: Box3) => { out.set(new Vector3(-0.1, 0.2, -0.1), new Vector3(0.1, 0.4, 0.1)); },
      isAlive: () => true,
    };
    v.startCameraSitOn(src);
    await frames(2);
    const orbits0 = nav.stats.orbits;
    const ev = countEvents();
    try {
      await withoutPointerCapture(async () => { await rightDrag(320, 240, 5, 15, 4, null); });
      expect(nav.stats.orbits).toBe(orbits0);
      expect(nav.dragActive).toBe(false);
      expect(ev.starts).toBe(0); // as before plan-515: disabled OrbitControls announced nothing
      expect(v.cameraFollowMode).toBe('siton');
    } finally {
      ev.off();
      if (v.cameraFollowMode !== 'off') v.stopCameraFollow(false);
      await settle();
    }
  });

  it('(p8) animateCameraTo (fitToNodes / F / bookmark flight) stops the inertia and resets the pivot', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    const cam = internals()._activeCamera;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const { x, y } = offCentreHit();
    const H0 = hitAt(x, y);
    await withoutPointerCapture(async () => { await rightDrag(x, y, 5, 15, 4, H0); });
    await frame();
    expect(nav.inertiaActive, 'the release coasts').toBe(true);
    expect(nav.pivot.distanceTo(H0)).toBeLessThan(1e-9);
    // Exactly what CameraBookmarks.restore does (CameraBar.tsx).
    const endPos = new Vector3(2.2, 1.9, 3.1);
    const endTgt = new Vector3(0.2, 0.45, -0.1);
    v.animateCameraTo(endPos, endTgt, 0.25);
    await frame();
    expect(nav.inertiaActive, 'the flight stops the inertia at once').toBe(false);
    for (let i = 0; i < 120 && v.isCameraAnimating; i++) await frame();
    await frames(3);
    console.log(`[plan-515 P2] (p8) after the flight: camera error ${cam.position.distanceTo(endPos).toExponential(2)} m, ` +
      `pivot → target error ${nav.pivot.distanceTo(endTgt).toExponential(2)} m`);
    expect(cam.position.distanceTo(endPos)).toBeLessThan(1e-9);
    expect(v.controls.target.distanceTo(endTgt)).toBeLessThan(1e-9);
    expect(nav.pivot.distanceTo(endTgt)).toBeLessThan(1e-9);
    // A background grab now orbits about the flight's target, not the old surface point.
    const bg = backgroundPixel();
    await withoutPointerCapture(async () => {
      const d0 = cam.position.distanceTo(endTgt);
      await rightDrag(bg.x, bg.y, 4, 6, 2, null);
      expect(Math.abs(cam.position.distanceTo(endTgt) - d0)).toBeLessThan(1e-6);
    });
    await settle();
  });

  it('(p9) a view-state restore and a projection switch reset the pivot', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const { x, y } = offCentreHit();
    const H0 = hitAt(x, y);
    await withoutPointerCapture(async () => { await rightDrag(x, y, 3, 6, 2, H0); });
    await settle();
    expect(nav.pivot.distanceTo(H0)).toBeLessThan(1e-9);
    const probe = new PerspectiveCamera();
    probe.position.set(-2.5, 2, 3.5);
    probe.lookAt(0.4, 0.2, 0.3);
    restoreViewState(v, {
      projection: 'perspective',
      position: [-2.5, 2, 3.5],
      quaternion: [probe.quaternion.x, probe.quaternion.y, probe.quaternion.z, probe.quaternion.w],
      target: [0.4, 0.2, 0.3],
      zoom: 1,
    });
    await frame();
    expect(nav.pivot.distanceTo(new Vector3(0.4, 0.2, 0.3))).toBeLessThan(1e-9);
    // Projection switch: pivot back to the (unchanged) target as well.
    await withoutPointerCapture(async () => {
      const h = hitAt(offCentreHit().x, offCentreHit().y);
      await rightDrag(offCentreHit().x, offCentreHit().y, 1, 0, 0, null);
      expect(nav.pivot.distanceTo(h)).toBeLessThan(1e-9);
    });
    await settle();
    const resets0 = nav.stats.pivotResets;
    v.projection = 'orthographic';
    await frame();
    expect(nav.stats.pivotResets).toBeGreaterThan(resets0);
    expect(nav.pivot.distanceTo(v.controls.target)).toBeLessThan(1e-9);
  });

  it('(p10) multiuser: a pivot grab without movement broadcasts no change; an orbit is broadcast; a remote take-over resets the pivot', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const plugin = new MultiuserPlugin();
    const sent: Array<Record<string, number[]>> = [];
    const mp = plugin as unknown as Record<string, unknown> & { _sendAvatarUpdate(): void; _handleAvatarBroadcast(m: Record<string, unknown>): void };
    mp.viewer = v;
    mp._ws = { readyState: 1, send: (s: string) => { sent.push(JSON.parse(s)); }, close: () => {} };
    mp._inRoom = true;
    const snapshot = (): Record<string, number[]> => { mp._sendAvatarUpdate(); return sent[sent.length - 1]; };
    const same = (a: Record<string, number[]>, b: Record<string, number[]>): number => Math.max(
      ...(['headPos', 'headRot', 'cameraTarget'] as const).flatMap((k) => a[k].map((x, i) => Math.abs(x - b[k][i]))),
    );
    const before = snapshot();
    const { x, y } = offCentreHit();
    const H0 = hitAt(x, y);
    await withoutPointerCapture(async () => {
      pointer('pointerdown', x, y, 2, 2);
      await frames(3);
      pointer('pointerup', x, y, 0, 2);
    });
    await settle();
    expect(nav.pivot.distanceTo(H0), 'the grab moved the pivot …').toBeLessThan(1e-9);
    const afterGrab = snapshot();
    expect(same(before, afterGrab), '… but nothing the broadcast carries').toBeLessThan(1e-9);
    await withoutPointerCapture(async () => { await rightDrag(x, y, 4, 10, 3, H0); });
    await settle();
    const afterOrbit = snapshot();
    expect(same(afterGrab, afterOrbit), 'the orbit is broadcast').toBeGreaterThan(1e-3);
    const t = afterOrbit.cameraTarget;
    expect(offAxis(new Vector3(t[0], t[1], t[2])), 'broadcast target on the view axis').toBeLessThan(1e-6);

    // Remote take-over (shared view): the operator's pose arrives, the pivot follows the new target.
    mp._sharedViewFollowing = true;
    mp._sharedViewOperatorId = 'op';
    mp._avatarManager = { updateAvatar: () => {} };
    v.setSharedViewMode(true);
    try {
      const q = internals()._activeCamera.quaternion;
      for (let i = 0; i < 30; i++) {
        mp._handleAvatarBroadcast({ id: 'op', headPos: [2, 3, 2], headRot: [q.x, q.y, q.z, q.w], cameraTarget: [0.5, 0.1, -0.5] });
        await frame();
      }
    } finally {
      v.setSharedViewMode(false);
      mp._sharedViewFollowing = false;
    }
    await frame();
    expect(nav.pivot.distanceTo(v.controls.target)).toBeLessThan(1e-9);
    expect(nav.pivot.distanceTo(H0)).toBeGreaterThan(0.1);
  });
});

// ═══ Default navigation — the pre-515 OrbitControls feel (decision 2026-09-29) ═══

/** Cursor point (canvas px) on the plane through controls.target ⟂ the view axis. */
function targetPlanePoint(x: number, y: number): Vector3 {
  const cam = internals()._activeCamera;
  cam.updateMatrixWorld();
  const rc = new Raycaster();
  rc.setFromCamera(new Vector2(x / W * 2 - 1, -(y / H) * 2 + 1), cam);
  const plane = new Plane().setFromNormalAndCoplanarPoint(forward(), handle!.viewer.controls.target);
  const p = rc.ray.intersectPlane(plane, new Vector3());
  expect(p, 'the cursor ray meets the target plane').not.toBeNull();
  return p!;
}

describe('default navigation — orbit about controls.target, pan in the target plane, wheel at the cursor', () => {
  it('(o1) right-drag over a surface orbits about the FIXED controls.target: no pick, target unchanged, distance constant', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    expect(nav.navigateAroundCursorPoint).toBe(false);
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const T0 = v.controls.target.clone();
    const cam = internals()._activeCamera;
    const d0 = cam.position.distanceTo(T0);
    const { x, y } = offCentreHit();
    const H0 = hitAt(x, y);
    expect(H0.distanceTo(T0), 'the surface point is not the target').toBeGreaterThan(0.2);
    const fwd0 = forward();
    const picks0 = nav.stats.picks;
    let r = { px: 0, dd: 0 };
    await withoutPointerCapture(async () => {
      pointer('pointerdown', x, y, 2, 2);
      expect(nav.pivot.distanceTo(T0), 'pivot = controls.target, not the surface').toBeLessThan(1e-9);
      expect(nav.stats.picks, 'no surface pick at mouse-down').toBe(picks0);
      pointer('pointerup', x, y, 0, 2);
      await settle();
      r = await rightDrag(x, y, 8, 7, 3, T0);
    });
    await settle();
    const turned = fwd0.angleTo(forward()) * 180 / Math.PI;
    console.log(`[plan-515 default] (o1) orbit about controls.target: target drift ${v.controls.target.distanceTo(T0).toExponential(2)} m, ` +
      `distance drift ${Math.abs(cam.position.distanceTo(T0) - d0).toExponential(2)} m, view turned ${turned.toFixed(2)}°`);
    expect(turned, 'it orbited').toBeGreaterThan(3);
    expect(v.controls.target.distanceTo(T0), 'controls.target unchanged').toBeLessThan(1e-6);
    expect(Math.abs(cam.position.distanceTo(T0) - d0), 'camera distance to the target constant').toBeLessThan(1e-6);
    expect(r.px, 'the target keeps its pixel').toBeLessThanOrEqual(1);
    expect(nav.stats.picks, 'no pick during the whole orbit').toBe(picks0);
    expect(offAxis(v.controls.target)).toBeLessThan(1e-6);
  });

  for (const proj of ['perspective', 'orthographic'] as const) {
    it(`(o2) ${proj}: default middle-drag pan keeps the cursor's point on the TARGET PLANE <= 1 px under the cursor, no pick`, async () => {
      const v = handle!.viewer;
      const nav = v.navController!;
      // Target at half the depth of the machine: the surface under the cursor
      // lies well behind the target plane, so keeping one vs. the other differs.
      await setPose([3, 2.5, 4], [1.5, 1.4, 2]);
      if (proj === 'orthographic') { v.projection = 'orthographic'; await frames(3); }
      const { x, y } = offCentreHit();
      const G = targetPlanePoint(x, y);
      const S = hitAt(x, y);
      const fwd0 = forward();
      const picks0 = nav.stats.picks;
      let maxErr = 0, surfErr = 0;
      await withoutPointerCapture(async () => {
        pointer('pointerdown', x, y, 4, 1);
        await frame();
        for (let i = 1; i <= 10; i++) {
          const cx = x - i * 11, cy = y + i * 6;
          pointer('pointermove', cx, cy, 4, -1);
          await frame();
          maxErr = Math.max(maxErr, pxErr(G, cx, cy));
          surfErr = pxErr(S, cx, cy); // before the release (no inertia yet)
        }
        pointer('pointerup', x - 110, y + 60, 0, 1);
      });
      await settle();
      console.log(`[plan-515 default] (o2) ${proj} pan: target-plane point error ${maxErr.toFixed(4)} px, ` +
        `surface point off by ${surfErr.toFixed(2)} px`);
      expect(maxErr).toBeLessThanOrEqual(1);
      expect(nav.stats.picks, 'no surface pick at pan start').toBe(picks0);
      expect(fwd0.angleTo(forward())).toBeLessThan(1e-6);
      expect(offAxis(v.controls.target)).toBeLessThan(1e-6);
      if (proj === 'perspective') {
        // The surface point (nearer than the target plane) is NOT what was kept.
        expect(surfErr).toBeGreaterThan(10);
      }
    });
  }

  it('(o3) touch: one finger orbits about controls.target (no pick); the pinch still zooms toward the surface under the midpoint', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    const cam = internals()._activeCamera;
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const T0 = v.controls.target.clone();
    const d0 = cam.position.distanceTo(T0);
    const fwd0 = forward();
    const { x, y } = offCentreHit();
    const picks0 = nav.stats.picks;
    await withoutPointerCapture(async () => {
      pointer('pointerdown', x, y, 1, 0, 41, 'touch');
      expect(nav.pivot.distanceTo(T0)).toBeLessThan(1e-9);
      for (let i = 1; i <= 6; i++) {
        pointer('pointermove', x + i * 8, y - i * 2, 1, -1, 41, 'touch');
        await frame();
      }
      pointer('pointerup', x + 48, y - 12, 0, 0, 41, 'touch');
    });
    await settle();
    expect(nav.stats.picks).toBe(picks0);
    expect(fwd0.angleTo(forward()) * 180 / Math.PI).toBeGreaterThan(1);
    expect(v.controls.target.distanceTo(T0)).toBeLessThan(1e-6);
    expect(Math.abs(cam.position.distanceTo(T0) - d0)).toBeLessThan(1e-6);

    // Pinch: surface-anchored in the default mode too (the scale fix).
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const m = offCentreHit(80);
    const A = hitAt(m.x, m.y);
    const dA0 = cam.position.distanceTo(A);
    let pinchErr = 0;
    await withoutPointerCapture(async () => {
      pointer('pointerdown', m.x - 20, m.y, 1, 0, 51, 'touch');
      pointer('pointerdown', m.x + 20, m.y, 1, 0, 52, 'touch');
      await frame();
      for (let i = 1; i <= 6; i++) {
        pointer('pointermove', m.x - 20 - i * 12, m.y, 1, -1, 51, 'touch');
        pointer('pointermove', m.x + 20 + i * 12, m.y, 1, -1, 52, 'touch');
        await frame();
        pinchErr = Math.max(pinchErr, pxErr(A, m.x, m.y));
      }
      // One finger lifts: the remaining one orbits about the (pinch-moved) target.
      pointer('pointerup', m.x - 92, m.y, 0, 0, 51, 'touch');
      await frame();
      expect(nav.pivot.distanceTo(v.controls.target)).toBeLessThan(1e-9);
      pointer('pointerup', m.x + 92, m.y, 0, 0, 52, 'touch');
    });
    await settle();
    expect(cam.position.distanceTo(A)).toBeLessThan(dA0 * 0.7);
    expect(pinchErr).toBeLessThanOrEqual(1);
  });

  it('(o4) default wheel anchors at the cursor and never passes through the surface', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    expect(nav.wheelZoomToCursor).toBe(true);
    await setPose([3, 2.5, 4], [0, 0.3, 0]);
    const { x: cx, y: cy } = offCentreHit();
    const H0 = hitAt(cx, cy);
    const cam = internals()._activeCamera;
    let last = cam.position.distanceTo(H0);
    let maxPx = 0;
    for (let k = 0; k < 40; k++) {
      wheel(cx, cy, -100);
      await frame();
      const d = cam.position.distanceTo(H0);
      expect(d).toBeLessThanOrEqual(last + 1e-9);
      expect(d).toBeGreaterThanOrEqual(0.0005 - 1e-9);
      // Still in front of the camera (not passed through).
      expect(H0.clone().sub(cam.position).dot(forward())).toBeGreaterThan(0);
      maxPx = Math.max(maxPx, pxErr(H0, cx, cy));
      last = d;
    }
    expect(maxPx, 'the surface point stays under the cursor').toBeLessThanOrEqual(1);
    expect(last).toBeLessThan(0.01);
  });

  it('(o5) option ON reproduces the surface pivot: right-drag orbits about the surface point under the cursor', async () => {
    const v = handle!.viewer;
    const nav = v.navController!;
    nav.navigateAroundCursorPoint = true;
    try {
      await setPose([3, 2.5, 4], [0, 0.3, 0]);
      const { x, y } = offCentreHit();
      const H0 = hitAt(x, y);
      let r = { px: 0, dd: 0 };
      await withoutPointerCapture(async () => { r = await rightDrag(x, y, 8, 7, 3, H0); });
      await settle();
      expect(nav.pivot.distanceTo(H0)).toBeLessThan(1e-9);
      expect(r.px).toBeLessThanOrEqual(1);
      expect(r.dd).toBeLessThan(1e-6);
    } finally {
      nav.navigateAroundCursorPoint = false;
    }
  });
});

// Runs LAST: `applyVisualSettings` also switches render mode, shadows, ground
// etc. on the shared viewer, which would change the cases above.
describe('(j) navigation settings — plumbing', () => {
  it('wheelZoomToCursor reaches the controller: applyVisualSettings (startup) and setControlsConfig (live)', () => {
    const v = handle!.viewer;
    const s = getDefaultVisualSettings();
    expect(s.wheelZoomToCursor).toBe(true);
    v.navController!.wheelZoomToCursor = false;
    v.applyVisualSettings(s);
    expect(v.navController!.wheelZoomToCursor).toBe(true);
    v.applyVisualSettings({ ...s, wheelZoomToCursor: false });
    expect(v.navController!.wheelZoomToCursor).toBe(false);
    v.setControlsConfig({ wheelZoomToCursor: true });
    expect(v.navController!.wheelZoomToCursor).toBe(true);
    v.setControlsConfig({ zoomSpeed: 1 }); // other fields leave it alone
    expect(v.navController!.wheelZoomToCursor).toBe(true);
    v.setControlsConfig({ wheelZoomToCursor: false });
    expect(v.navController!.wheelZoomToCursor).toBe(false);
    v.setControlsConfig({ wheelZoomToCursor: true });
  });

  it('navigateAroundCursorPoint reaches the controller: applyVisualSettings (startup) and setControlsConfig (live)', () => {
    const v = handle!.viewer;
    const s = getDefaultVisualSettings();
    expect(s.navigateAroundCursorPoint).toBe(false);
    v.navController!.navigateAroundCursorPoint = true;
    v.applyVisualSettings(s);
    expect(v.navController!.navigateAroundCursorPoint).toBe(false);
    v.applyVisualSettings({ ...s, navigateAroundCursorPoint: true });
    expect(v.navController!.navigateAroundCursorPoint).toBe(true);
    v.setControlsConfig({ navigateAroundCursorPoint: false });
    expect(v.navController!.navigateAroundCursorPoint).toBe(false);
    v.setControlsConfig({ zoomSpeed: 1 }); // other fields leave it alone
    expect(v.navController!.navigateAroundCursorPoint).toBe(false);
    v.setControlsConfig({ navigateAroundCursorPoint: true });
    expect(v.navController!.navigateAroundCursorPoint).toBe(true);
    v.setControlsConfig({ navigateAroundCursorPoint: false });
  });
});

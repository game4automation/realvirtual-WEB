// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-515 §9.1 — pure navigation mathematics (Phase 1a wheel/clipping, Phase 2
 * orbit about a pivot and the point-keeping pan).
 */
import { describe, it, expect } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Plane, Quaternion, Vector2, Vector3 } from 'three';
import {
  dollyStep, nearFarFor, orthoNearFarFor, fitFloor, zoomOrthoAtCursor, maxBackoffInside,
  orbitAboutPivot, orbitAboutPivotIO, panKeepPoint, panKeepPointIO, cursorRayIO, createNavScalarIO,
  MAX_FAR_NEAR_RATIO, FAR_FOCUS_FALLBACK, MIN_ORBIT_POLAR,
  type NearFar,
} from '../src/core/engine/rv-navigation-math';

describe('dollyStep', () => {
  it('shrinks strictly while above the minimum, then saturates at it', () => {
    let d = 300;
    for (let i = 0; i < 1000; i++) {
      const n = dollyStep(d, 1, 0.2, 0.0005);
      if (d > 0.0005) expect(n).toBeLessThan(d); else expect(n).toBe(0.0005);
      expect(n).toBeGreaterThanOrEqual(0.0005);
      d = n;
    }
  });
  it('gets from 300 m to under 5 cm within 40 notches', () => {
    let d = 300, n = 0;
    while (d >= 0.05) { d = dollyStep(d, 1, 0.2, 0.0005); n++; }
    expect(n).toBeLessThanOrEqual(40);
  });
  it('starting below the minimum returns the minimum', () => expect(dollyStep(0.0001, 1, 0.2, 0.0005)).toBe(0.0005));
  it('zero notches is identity', () => expect(dollyStep(3, 0, 0.2, 0.0005)).toBe(3));
  it('zooming out grows', () => expect(dollyStep(3, -1, 0.2, 0.0005)).toBeGreaterThan(3));
  it('fractional notches are continuous (trackpad pinch)', () => {
    const a = dollyStep(1, 0.5, 0.2, 0.0005);
    expect(a).toBeLessThan(1);
    expect(a).toBeGreaterThan(dollyStep(1, 1, 0.2, 0.0005));
  });
});

describe('nearFarFor', () => {
  const out: NearFar = { near: 0, far: 0 };
  it('keeps a 5 mm part at 3 cm in front of the near plane', () => {
    const scale = { center: new Vector3(0, 0, 0), radius: 0.0025 };
    nearFarFor(0.03, new Vector3(0, 0, 0.03), scale, out);
    expect(out.near).toBeLessThan(0.03 - 0.0025);
    expect(out.far).toBeGreaterThan(0.03 + 0.0025);
  });
  it('keeps a 500 m scene inside far from its initial fit camera', () => {
    const scale = { center: new Vector3(0, 0, 0), radius: 354 }; // 500 m square plant
    const cam = new Vector3(0, 400, 700);
    nearFarFor(cam.length(), cam, scale, out);
    expect(out.far).toBeGreaterThan(cam.length() + 354);
    expect(out.near).toBeLessThan(cam.length() - 354);
  });
  it('keeps far/near <= 1e7 by RAISING near — far is never capped (R3-4)', () => {
    const scale = { center: new Vector3(0, 0, 0), radius: 354 };
    const cam = new Vector3(250, 0, 0);
    nearFarFor(1e-9, cam, scale, out);
    expect(out.far).toBeCloseTo((cam.length() + 354) * 1.1, 9);
    expect(out.far / out.near).toBeLessThanOrEqual(MAX_FAR_NEAR_RATIO * (1 + 1e-9));
  });
  it('near and far at once: 0.5 mm before a 5 mm cube, an object 500 m away stays inside (R3-4)', () => {
    // 500 m plant, centre at the origin; the 5 mm cube sits at its edge (x = 250 m),
    // the far object at the opposite edge (x = -250 m), 500 m from the camera.
    const scale = { center: new Vector3(0, 0, 0), radius: Math.hypot(250, 250) };
    const cubeFace = new Vector3(250, 0.0025, 0);
    const cam = new Vector3(250, 0.0025, 0.0025 + 0.0005); // 0.5 mm in front of the cube face (+z)
    const farObject = new Vector3(-250, 0, 0);
    nearFarFor(0.0005, cam, scale, out);
    expect(out.near).toBeLessThan(0.0005);                       // the cube is not clipped by near
    expect(out.far).toBeGreaterThan(cam.distanceTo(farObject));  // the 500 m object is not clipped by far
    expect(cam.distanceTo(cubeFace)).toBeGreaterThan(out.near);
    expect(out.far / out.near).toBeLessThanOrEqual(MAX_FAR_NEAR_RATIO * (1 + 1e-9));
  });
  it('far covers FAR_FOCUS_FALLBACK focus distances (moving content, R3-1)', () => {
    const scale = { center: new Vector3(0, 0, 0), radius: 1 };
    nearFarFor(100, new Vector3(0, 0, 2), scale, out);
    expect(out.far).toBeGreaterThanOrEqual(100 * FAR_FOCUS_FALLBACK);
    orthoNearFarFor(new Vector3(0, 0, 2), scale, out, 100);
    expect(out.far).toBeGreaterThanOrEqual(100 * FAR_FOCUS_FALLBACK);
  });
  it('rejects a non-finite focus distance without NaN', () => {
    const scale = { center: new Vector3(0, 0, 0), radius: 1 };
    nearFarFor(Number.NaN, new Vector3(0, 0, 5), scale, out);
    expect(Number.isFinite(out.near) && Number.isFinite(out.far)).toBe(true);
    expect(out.near).toBeGreaterThan(0);
  });
  it('ortho slab contains the scene sphere', () => {
    const scale = { center: new Vector3(0, 0, 0), radius: 1 };
    orthoNearFarFor(new Vector3(0, 0, 10), scale, out);
    expect(out.near).toBeLessThan(9);
    expect(out.far).toBeGreaterThan(11);
  });
});

describe('zoomOrthoAtCursor', () => {
  function cam(): OrthographicCamera {
    const c = new OrthographicCamera(-2, 2, 1, -1, 0.1, 100);
    c.position.set(0, 0, 10);
    c.lookAt(0, 0, 0);
    c.updateMatrixWorld(true);
    c.updateProjectionMatrix();
    return c;
  }
  it('keeps the anchor under the cursor', () => {
    const c = cam();
    const anchor = new Vector3(1.2, -0.4, 0);
    const before = anchor.clone().project(c);
    const shift = new Vector3();
    const z = zoomOrthoAtCursor(c, 1.25, anchor, shift);
    c.zoom = z;
    c.updateProjectionMatrix();
    c.position.add(shift);
    c.updateMatrixWorld(true);
    const after = anchor.clone().project(c);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(z).toBeCloseTo(1.25, 12);
  });
  it('clamps to 1 mm visible height', () => {
    const c = cam();
    const shift = new Vector3();
    const z = zoomOrthoAtCursor(c, 1e9, new Vector3(), shift, 0.001);
    expect((c.top - c.bottom) / z).toBeCloseTo(0.001, 12);
  });
});

describe('maxBackoffInside (zoom-out clamp)', () => {
  const c = new Vector3(0, 0, 0);
  it('backs off exactly to the cap sphere', () => {
    const cam = new Vector3(0, 0, 5);
    const dir = new Vector3(0, 0, -1); // looking at the centre; backing off = +z
    const t = maxBackoffInside(cam, dir, c, 20);
    expect(t).toBeCloseTo(15, 12);
    expect(cam.clone().addScaledVector(dir, -t).length()).toBeCloseTo(20, 12);
  });
  it('an off-axis ray also ends ON the sphere', () => {
    const cam = new Vector3(3, 1, 4);
    const dir = new Vector3(-1, -0.2, -0.7).normalize();
    const t = maxBackoffInside(cam, dir, c, 10);
    expect(t).toBeGreaterThan(0);
    expect(cam.clone().addScaledVector(dir, -t).length()).toBeCloseTo(10, 9);
  });
  it('outside the sphere: no back-off at all', () => {
    expect(maxBackoffInside(new Vector3(0, 0, 30), new Vector3(0, 0, -1), c, 20)).toBe(0);
  });
  it('no cap: unlimited', () => {
    expect(maxBackoffInside(new Vector3(0, 0, 5), new Vector3(0, 0, -1), c, Infinity)).toBe(Infinity);
  });
});

describe('fitFloor', () => {
  it('uses 1 mm, not 10 cm', () => expect(fitFloor(0.005)).toBe(0.005));
  it('never below 1 mm', () => expect(fitFloor(0.0001)).toBe(0.001));
});

// ─── Phase 2: orbit about a pivot, point-keeping pan ─────────────────

const W2 = 800;
const H2 = 600;

function perspAt(pos: [number, number, number], look: [number, number, number]): PerspectiveCamera {
  const c = new PerspectiveCamera(50, W2 / H2, 0.01, 1000);
  c.position.set(...pos);
  c.lookAt(new Vector3(...look));
  c.updateMatrixWorld();
  return c;
}

function orthoAt(pos: [number, number, number], look: [number, number, number]): OrthographicCamera {
  const c = new OrthographicCamera(-4, 4, 3, -3, 0.01, 1000);
  c.zoom = 1.7;
  c.updateProjectionMatrix();
  c.position.set(...pos);
  c.lookAt(new Vector3(...look));
  c.updateMatrixWorld();
  return c;
}

function fwdOf(q: Quaternion): Vector3 {
  return new Vector3(0, 0, -1).applyQuaternion(q);
}

/** Pixel of a world point (camera matrices must be current). */
function pixelOf(cam: PerspectiveCamera | OrthographicCamera, p: Vector3): { x: number; y: number } {
  const v = p.clone().project(cam);
  return { x: (v.x + 1) / 2 * W2, y: (1 - v.y) / 2 * H2 };
}

describe('orbitAboutPivot (Phase 2)', () => {
  const pivot = new Vector3(0.7, 0.2, -0.4); // deliberately OFF the view axis
  it('keeps the camera–pivot distance constant', () => {
    const cam = perspAt([3, 2.5, 4], [0, 0.3, 0]);
    const d0 = cam.position.distanceTo(pivot);
    const pos = cam.position.clone();
    const q = cam.quaternion.clone();
    for (let i = 0; i < 200; i++) {
      orbitAboutPivot({ position: pos, quaternion: q }, pivot, 0.031, (i % 7 - 3) * 0.013, pos, q);
      expect(Math.abs(pos.distanceTo(pivot) - d0)).toBeLessThan(1e-9);
    }
  });
  it('the view direction does not jump at orbit start (< 0.1°) — nothing is re-aimed at the pivot', () => {
    const cam = perspAt([3, 2.5, 4], [0, 0.3, 0]);
    const f0 = fwdOf(cam.quaternion);
    // The pivot is ~20° off the view axis: a lookAt(pivot) would swing ~20°.
    const toPivot = pivot.clone().sub(cam.position).normalize();
    expect(f0.angleTo(toPivot) * 180 / Math.PI).toBeGreaterThan(5);
    const pos = new Vector3();
    const q = new Quaternion();
    const tiny = 1e-4; // one small mouse step
    orbitAboutPivot(cam, pivot, tiny, tiny, pos, q);
    const deg = f0.angleTo(fwdOf(q)) * 180 / Math.PI;
    expect(deg).toBeLessThan(0.1);
    expect(deg).toBeLessThan(2 * tiny * 180 / Math.PI + 1e-9);
    // Zero input is the identity.
    orbitAboutPivot(cam, pivot, 0, 0, pos, q);
    expect(pos.distanceTo(cam.position)).toBeLessThan(1e-12);
    expect(fwdOf(q).angleTo(f0)).toBeLessThan(1e-9);
  });
  it('stays roll-free and yaw turns about world +Y', () => {
    const cam = perspAt([3, 2.5, 4], [0, 0.3, 0]);
    const pos = new Vector3();
    const q = new Quaternion();
    orbitAboutPivot(cam, pivot, 0.8, -0.3, pos, q);
    const right = new Vector3(1, 0, 0).applyQuaternion(q);
    expect(Math.abs(right.y)).toBeLessThan(1e-9);
    // Pure yaw keeps the pivot-relative height and the view elevation.
    orbitAboutPivot(cam, pivot, 1.1, 0, pos, q);
    expect(pos.y - pivot.y).toBeCloseTo(cam.position.y - pivot.y, 9);
    expect(fwdOf(q).y).toBeCloseTo(fwdOf(cam.quaternion).y, 9);
  });
  it('a pivot ON the view axis stays on it (rigid rotation keeps its screen position)', () => {
    const cam = perspAt([3, 2.5, 4], [0, 0.3, 0]);
    const onAxis = cam.position.clone().addScaledVector(fwdOf(cam.quaternion), 4);
    const px0 = pixelOf(cam, pivot);
    const moved = cam.clone();
    orbitAboutPivot(cam, onAxis, 0.4, 0.2, moved.position, moved.quaternion);
    moved.updateMatrixWorld();
    const axisPt = moved.position.clone().addScaledVector(fwdOf(moved.quaternion), 4);
    expect(axisPt.distanceTo(onAxis)).toBeLessThan(1e-9);
    // And an off-axis pivot keeps ITS pixel, too (the whole view turns rigidly about it).
    const moved2 = cam.clone();
    orbitAboutPivot(cam, pivot, 0.4, 0.2, moved2.position, moved2.quaternion);
    moved2.updateMatrixWorld();
    const px1 = pixelOf(moved2, pivot);
    expect(Math.hypot(px1.x - px0.x, px1.y - px0.y)).toBeLessThan(1e-6);
  });
  it('clamps the pitch away from the poles', () => {
    const cam = perspAt([3, 2.5, 4], [0, 0.3, 0]);
    const pos = new Vector3();
    const q = new Quaternion();
    const applied = orbitAboutPivot(cam, pivot, 0, 10, pos, q); // way past straight up
    const f = fwdOf(q);
    expect(Math.acos(f.y)).toBeCloseTo(MIN_ORBIT_POLAR, 9);
    expect(applied).toBeLessThan(10);
    orbitAboutPivot(cam, pivot, 0, -10, pos, q); // way past straight down
    expect(Math.acos(fwdOf(q).y)).toBeCloseTo(Math.PI - MIN_ORBIT_POLAR, 9);
    // Distance preserved even when clamped.
    expect(pos.distanceTo(pivot)).toBeCloseTo(cam.position.distanceTo(pivot), 9);
  });
  it('allocates nothing observable: the IO form aliases in/out', () => {
    const cam = perspAt([3, 2.5, 4], [0, 0.3, 0]);
    const ref = cam.clone();
    const io = createNavScalarIO();
    io.yaw = 0.2; io.pitch = 0.1; io.minPolar = MIN_ORBIT_POLAR;
    const outP = new Vector3(); const outQ = new Quaternion();
    orbitAboutPivotIO(ref.position, ref.quaternion, pivot, outP, outQ, io);
    orbitAboutPivotIO(cam.position, cam.quaternion, pivot, cam.position, cam.quaternion, io);
    expect(cam.position.distanceTo(outP)).toBeLessThan(1e-12);
    expect(Math.abs(cam.quaternion.dot(outQ))).toBeCloseTo(1, 12);
  });
  it('works on an orthographic camera pose alike', () => {
    const cam = orthoAt([3, 2.5, 4], [0, 0.3, 0]);
    const d0 = cam.position.distanceTo(pivot);
    const f0 = fwdOf(cam.quaternion);
    const moved = cam.clone();
    orbitAboutPivot(cam, pivot, 1e-4, 0, moved.position, moved.quaternion);
    expect(moved.position.distanceTo(pivot)).toBeCloseTo(d0, 9);
    expect(f0.angleTo(fwdOf(moved.quaternion)) * 180 / Math.PI).toBeLessThan(0.1);
  });
});

describe('panKeepPoint (Phase 2)', () => {
  const grabbedAt = (cam: PerspectiveCamera | OrthographicCamera, px: number, py: number, depth: number): Vector3 => {
    const io = createNavScalarIO();
    io.ndcX = px / W2 * 2 - 1; io.ndcY = -(py / H2) * 2 + 1;
    const o = new Vector3(); const d = new Vector3();
    cursorRayIO(cam, io, o, d);
    return o.addScaledVector(d, depth);
  };
  for (const kind of ['perspective', 'orthographic'] as const) {
    it(`${kind}: keeps the grabbed point <= 1 px under the cursor over a whole drag`, () => {
      const cam = kind === 'perspective' ? perspAt([3, 2.5, 4], [0, 0.3, 0]) : orthoAt([3, 2.5, 4], [0, 0.3, 0]);
      const G = grabbedAt(cam, 520, 180, 4.2);
      const f0 = fwdOf(cam.quaternion);
      const plane = new Plane().setFromNormalAndCoplanarPoint(f0, G);
      const delta = new Vector3();
      const ndc = new Vector2();
      let maxErr = 0;
      for (let i = 1; i <= 40; i++) {
        const cx = 520 - i * 9.5, cy = 180 + i * 6.25;
        ndc.set(cx / W2 * 2 - 1, -(cy / H2) * 2 + 1);
        expect(panKeepPoint(cam, G, plane, ndc, delta)).toBe(true);
        cam.position.add(delta);
        cam.updateMatrixWorld();
        const p = pixelOf(cam, G);
        maxErr = Math.max(maxErr, Math.hypot(p.x - cx, p.y - cy));
      }
      expect(maxErr).toBeLessThanOrEqual(1);
      expect(maxErr).toBeLessThan(1e-6); // exact up to float noise
      // Pure translation: the orientation never changed.
      expect(fwdOf(cam.quaternion).angleTo(f0)).toBe(0);
    });
  }
  it('the ray-plane step moves only parallel to the plane (camera depth to the point is kept)', () => {
    const cam = perspAt([3, 2.5, 4], [0, 0.3, 0]);
    const G = grabbedAt(cam, 300, 400, 3);
    const n = fwdOf(cam.quaternion);
    const io = createNavScalarIO();
    io.ndcX = 0.3; io.ndcY = -0.2;
    const o = new Vector3(); const d = new Vector3(); const delta = new Vector3();
    cursorRayIO(cam, io, o, d);
    expect(panKeepPointIO(o, d, G, n, delta)).toBe(true);
    expect(Math.abs(delta.dot(n))).toBeLessThan(1e-12);
  });
  it('a ray parallel to the plane yields no motion', () => {
    const delta = new Vector3(9, 9, 9);
    expect(panKeepPointIO(new Vector3(), new Vector3(1, 0, 0), new Vector3(0, 0, -5), new Vector3(0, 0, -1), delta)).toBe(false);
    expect(delta.length()).toBe(0);
  });
  it('cursorRayIO: the centre ray is the view axis (perspective and ortho)', () => {
    for (const cam of [perspAt([3, 2.5, 4], [0, 0.3, 0]), orthoAt([3, 2.5, 4], [0, 0.3, 0])]) {
      const io = createNavScalarIO();
      io.ndcX = 0; io.ndcY = 0;
      const o = new Vector3(); const d = new Vector3();
      cursorRayIO(cam, io, o, d);
      expect(d.angleTo(fwdOf(cam.quaternion))).toBeLessThan(1e-7);
      // origin on the camera axis at the near plane
      expect(o.clone().sub(cam.position).cross(d).length()).toBeLessThan(1e-7);
    }
  });
});

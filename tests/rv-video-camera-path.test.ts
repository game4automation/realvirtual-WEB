// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-537 F5 — camera paths of the deterministic video capture, as pure math:
 * orbit (closed after 360°, radius / height, monotonic easing), presets (hold /
 * transition timing, interpolation endpoints) and fixed.
 */

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { resolveCameraPath, resolveExplicitCameraSpec } from '../src/core/engine/rv-video-capture';
import {
  createCameraPathPose,
  createFixedPath,
  createOrbitPath,
  createPresetPath,
  easeInOut,
  azimuthDeg,
  fitDistanceForSphere,
  presetPathDuration,
} from '../src/core/engine/rv-video-camera-path';

const C = new Vector3(1, 2, 3);

describe('orbit path', () => {
  const orbit = (easing: 'none' | 'inOut' = 'none', sweepDeg = 360) => createOrbitPath({
    center: C, radius: 5, height: 2, startDeg: 30, sweepDeg, duration: 10, easing, fov: null,
  });

  it('start and end pose are equal after a 360° sweep', () => {
    const p = orbit();
    const a = p.pose(0, createCameraPathPose());
    const b = p.pose(10, createCameraPathPose());
    expect(a.position.distanceTo(b.position)).toBeLessThan(1e-9);
    expect(a.target.equals(C)).toBe(true);
  });

  it('keeps radius and height at every t and looks at the centre', () => {
    const p = orbit();
    const pose = createCameraPathPose();
    for (let t = 0; t <= 10; t += 0.37) {
      p.pose(t, pose);
      const dx = pose.position.x - C.x;
      const dz = pose.position.z - C.z;
      expect(Math.hypot(dx, dz)).toBeCloseTo(5, 9);
      expect(pose.position.y - C.y).toBeCloseTo(2, 9);
      expect(pose.target.equals(C)).toBe(true);
    }
  });

  it('starts at startDeg (0° = +Z, 90° = +X) and sweeps half way at t = duration/2', () => {
    const p = createOrbitPath({ center: C, radius: 5, height: 0, startDeg: 0, sweepDeg: 180, duration: 4, easing: 'none', fov: 40 });
    const pose = p.pose(0, createCameraPathPose());
    expect(pose.position.z - C.z).toBeCloseTo(5, 9);
    expect(pose.fov).toBe(40);
    p.pose(2, pose);
    expect(azimuthDeg(pose.position, C)).toBeCloseTo(90, 6);
  });

  it('easing in/out is monotonic and hits both endpoints', () => {
    let prev = -1;
    for (let u = 0; u <= 1.0000001; u += 0.01) {
      const e = easeInOut(u);
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    // An eased orbit advances its azimuth monotonically too.
    const p = orbit('inOut', 270);
    const pose = createCameraPathPose();
    let last = -Infinity;
    for (let t = 0; t <= 10; t += 0.25) {
      p.pose(t, pose);
      let a = azimuthDeg(pose.position, C) - 30;
      while (a < last - 1e-6) a += 360;
      expect(a).toBeGreaterThanOrEqual(last - 1e-6);
      last = a;
    }
  });
});

describe('presets path', () => {
  const A = { position: new Vector3(0, 0, 10), target: new Vector3(0, 0, 0) };
  const B = { position: new Vector3(10, 0, 0), target: new Vector3(1, 0, 0) };
  const D = { position: new Vector3(0, 10, 0), target: new Vector3(0, 1, 0) };
  const frames = [
    { ...A, transition: 0, hold: 1 },
    { ...B, transition: 2, hold: 1 },
    { ...D, transition: 3, hold: 0.5 },
  ];

  it('duration = first hold + every transition + hold', () => {
    expect(presetPathDuration(frames)).toBeCloseTo(1 + 2 + 1 + 3 + 0.5, 9);
  });

  it('holds, then interpolates between the endpoints, then holds the next view', () => {
    const p = createPresetPath({ keyframes: frames, fov: null });
    const pose = createCameraPathPose();
    p.pose(0, pose); expect(pose.position.equals(A.position)).toBe(true);
    p.pose(0.99, pose); expect(pose.position.equals(A.position)).toBe(true);
    // transition A→B over [1, 3): eased midpoint at t = 2
    p.pose(1, pose); expect(pose.position.distanceTo(A.position)).toBeLessThan(1e-9);
    p.pose(2, pose);
    expect(pose.position.x).toBeCloseTo(5, 9);
    expect(pose.position.z).toBeCloseTo(5, 9);
    expect(pose.target.x).toBeCloseTo(0.5, 9);
    p.pose(3, pose); expect(pose.position.equals(B.position)).toBe(true);
    p.pose(3.9, pose); expect(pose.position.equals(B.position)).toBe(true);
    // B→D over [4, 7), then hold D and stay there.
    p.pose(7, pose); expect(pose.position.equals(D.position)).toBe(true);
    p.pose(100, pose); expect(pose.position.equals(D.position)).toBe(true);
    expect(pose.target.equals(D.target)).toBe(true);
  });

  it('a transition moves monotonically from one endpoint to the other', () => {
    const p = createPresetPath({ keyframes: frames, fov: 35 });
    const pose = createCameraPathPose();
    let lastX = -Infinity;
    for (let t = 1; t <= 3; t += 0.1) {
      p.pose(t, pose);
      expect(pose.position.x).toBeGreaterThanOrEqual(lastX - 1e-9);
      lastX = pose.position.x;
      expect(pose.fov).toBe(35);
    }
  });

  it('refuses an empty list', () => {
    expect(() => createPresetPath({ keyframes: [], fov: null })).toThrow(/at least one view/);
  });
});

describe('fixed path', () => {
  it('returns the same pose at every time', () => {
    const p = createFixedPath(new Vector3(1, 2, 3), new Vector3(0, 0, 0));
    const a = p.pose(0, createCameraPathPose());
    const pa = a.position.clone();
    const b = p.pose(42, createCameraPathPose());
    expect(b.position.equals(pa)).toBe(true);
    expect(b.target.equals(new Vector3())).toBe(true);
    expect(b.fov).toBeNull();
  });
});

describe('fit distance', () => {
  it('a sphere fills the tighter axis', () => {
    // 90° vertical fov, square: d = r / sin(45°)
    expect(fitDistanceForSphere(1, 90, 1, 1)).toBeCloseTo(Math.SQRT2, 9);
    // a narrow (portrait) frame needs MORE distance than a wide one
    expect(fitDistanceForSphere(1, 45, 0.5, 1)).toBeGreaterThan(fitDistanceForSphere(1, 45, 2, 1));
  });
});

// ─── plan-551 F3 / F14 / F20 — orbit from the current view, explicit specs ─────

describe('orbit from the current view (plan-551 F3)', () => {
  type Host = Parameters<typeof resolveCameraPath>[0];

  /** Minimal capture host: a 2 m box at the origin, a camera at `pos` looking at `target`. */
  function host(pos: Vector3, target: Vector3, ortho = false): Host {
    const root = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    root.updateMatrixWorld(true);
    const camera = ortho ? new OrthographicCamera(-5, 5, 5, -5, 0.1, 100) : new PerspectiveCamera(50, 16 / 9, 0.1, 100);
    if (ortho) camera.zoom = 2.5;
    camera.position.copy(pos);
    return {
      camera,
      currentModelRoot: root,
      registry: null,
      getCameraState: () => ({ position: camera.position.clone(), target: target.clone() }),
    } as unknown as Host;
  }

  it('first pose equals the current camera pose; radius and height come from the view; 360° closes', () => {
    const pos = new Vector3(4, 3, -2);
    const tgt = new Vector3(1, 0.5, 1);
    const path = resolveCameraPath(host(pos, tgt), { kind: 'orbit', fromCurrentView: true }, 16 / 9, 10);
    const a = path.pose(0, createCameraPathPose());
    expect(a.position.distanceTo(pos)).toBeLessThan(1e-9);
    expect(a.target.distanceTo(tgt)).toBeLessThan(1e-12);
    const mid = path.pose(3.3, createCameraPathPose());
    expect(Math.hypot(mid.position.x - tgt.x, mid.position.z - tgt.z)).toBeCloseTo(Math.hypot(3, -3), 9);
    expect(mid.position.y - tgt.y).toBeCloseTo(2.5, 9);
    const end = path.pose(10, createCameraPathPose());
    expect(end.position.distanceTo(pos)).toBeLessThan(1e-9);
  });

  it('a top-down view falls back to the fit radius (no spin in place)', () => {
    const tgt = new Vector3(0, 0, 0);
    const pos = new Vector3(0.0001, 20, 0);
    const path = resolveCameraPath(host(pos, tgt), { kind: 'orbit', fromCurrentView: true }, 16 / 9, 10);
    const p = path.pose(0, createCameraPathPose());
    const r = Math.hypot(p.position.x, p.position.z);
    expect(r).toBeGreaterThan(1); // the fit radius of a 2 m box, not 0.1 mm
    expect(p.position.y).toBeCloseTo(20, 9); // height still from the view
  });

  it('orthographic view: the orbit uses the camera↔target distance (zoom is left to the capture)', () => {
    const h = host(new Vector3(0, 5, 8), new Vector3(0, 0, 0), true);
    const path = resolveCameraPath(h, { kind: 'orbit', fromCurrentView: true }, 1, 4);
    const p = path.pose(1, createCameraPathPose());
    expect(Math.hypot(p.position.x, p.position.z)).toBeCloseTo(8, 9);
    expect((h.camera as OrthographicCamera).zoom).toBe(2.5);
  });

  it('Fixed = the current pose; an explicit fixed spec replays its own pose', () => {
    const pos = new Vector3(3, 2, 1);
    const tgt = new Vector3(0, 1, 0);
    const p = resolveCameraPath(host(pos, tgt), { kind: 'fixed' }, 1, 5).pose(2, createCameraPathPose());
    expect(p.position.equals(pos)).toBe(true);
    expect(p.target.equals(tgt)).toBe(true);
    const q = resolveCameraPath(host(new Vector3(9, 9, 9), new Vector3()), { kind: 'fixed', position: [3, 2, 1], target: [0, 1, 0], fov: 40 }, 1, 5)
      .pose(2, createCameraPathPose());
    expect(q.position.equals(pos)).toBe(true);
    expect(q.fov).toBe(40);
  });

  it('resolveExplicitCameraSpec freezes the current view into absolute numbers (F20)', () => {
    const pos = new Vector3(4, 3, -2);
    const tgt = new Vector3(1, 0.5, 1);
    const spec = resolveExplicitCameraSpec(host(pos, tgt), { kind: 'orbit', fromCurrentView: true }, 16 / 9);
    expect(spec).toMatchObject({ kind: 'orbit', center: [1, 0.5, 1], height: 2.5, sweepDeg: 360, fov: 50 });
    // Replayed against a DIFFERENT current view, the explicit spec gives the same path.
    const replay = resolveCameraPath(host(new Vector3(-7, 1, 3), new Vector3(5, 5, 5)), spec, 16 / 9, 10);
    expect(replay.pose(0, createCameraPathPose()).position.distanceTo(pos)).toBeLessThan(1e-5);
    const fixed = resolveExplicitCameraSpec(host(pos, tgt), { kind: 'fixed' }, 1);
    expect(fixed).toEqual({ kind: 'fixed', position: [4, 3, -2], target: [1, 0.5, 1], fov: 50 });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { PerspectiveCamera, Vector3, Euler } from 'three';
import { RVSpaceMouseNav, deadZone, defaultSpaceMouseSettings } from '../src/core/engine/rv-spacemouse-nav';
const sample = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
function rig(distance = 10) {
  const nav = new RVSpaceMouseNav();
  const camera = new PerspectiveCamera();
  camera.position.z = distance;
  return { nav, camera, target: new Vector3() };
}
describe('six degree navigation', () => {
  it('rescales the dead zone continuously', () => {
    expect(deadZone(0.07, 0.08)).toBe(0);
    expect(deadZone(0.08, 0.08)).toBe(0);
    expect(deadZone(1, 0.08)).toBe(1);
    expect(deadZone(-0.54, 0.08)).toBeCloseTo(-0.5);
  });
  it('integrates exponential smoothing independently of frame rate', () => {
    const poses = [30, 60, 120].map(hz => {
      const r = rig();
      r.nav.feed({ ...sample, tx: 0.7 }, 'spacemouse');
      for (let i = 0; i < hz; i++)
        r.nav.step(1 / hz, r.camera, r.target);
      return r.camera.position.x;
    });
    expect(poses[0]).toBeCloseTo(poses[1], 8);
    expect(poses[1]).toBeCloseTo(poses[2], 8);
  });
  it('treats external identically and keeps independent source smoothing with clamped sum', () => {
    const a = rig(), b = rig();
    a.nav.feed({ ...sample, tx: 1 }, 'spacemouse');
    b.nav.feed({ ...sample, tx: 1 }, 'external');
    a.nav.step(1 / 60, a.camera, a.target);
    b.nav.step(1 / 60, b.camera, b.target);
    expect(a.camera.position.toArray()).toEqual(b.camera.position.toArray());
    a.nav.feed({ ...sample, tx: -1 }, 'external');
    a.nav.step(1 / 60, a.camera, a.target);
    expect(a.nav.axes[0]).toBeCloseTo(0.24);
    a.nav.feed({ ...sample, tx: 1 }, 'external');
    for (let i = 0; i < 60; i++)
      a.nav.step(1 / 60, a.camera, a.target);
    expect(a.nav.axes[0]).toBe(1);
  });
  it('supports dominant axis, inversion and distance scaling', () => {
    const a = rig(), b = rig(20);
    for (const r of [a, b]) {
      r.nav.settings.Smoothing = 0;
      r.nav.settings.DominantAxis = true;
      r.nav.settings.InvertTranslation[0] = true;
      r.nav.feed({ ...sample, tx: 1, ty: 0.5 }, 'external');
      r.nav.step(0.1, r.camera, r.target);
    }
    expect(a.camera.position.x).toBeCloseTo(-1);
    expect(a.camera.position.y).toBe(0);
    expect(b.camera.position.x).toBeCloseTo(-2);
  });
  it('orbits around the pivot, zooms toward it and locks the horizon', () => {
    const r = rig();
    r.nav.settings.Smoothing = 0;
    r.nav.feed({ ...sample, ry: 1, rz: 1 }, 'spacemouse');
    r.nav.step(0.1, r.camera, r.target);
    expect(r.camera.position.length()).toBeCloseTo(10);
    expect(r.target.length()).toBeCloseTo(0, 9);
    expect(new Euler().setFromQuaternion(r.camera.quaternion, 'YXZ').z).toBeCloseTo(0);
    r.nav.feed({ ...sample, tz: -1 }, 'spacemouse');
    r.nav.step(0.1, r.camera, r.target);
    expect(r.camera.position.length()).toBeLessThan(10);
    expect(r.target.length()).toBeCloseTo(0, 9);
    r.nav.reset();
    expect(r.nav.step(0.1, r.camera, r.target)).toBe(false);
    expect(defaultSpaceMouseSettings().EyeHeight).toBe(1700);
  });
  it('rolls only in Fly without Lock Horizon; Orbit never rolls', () => {
    const rollAfter = (mode: 'Orbit' | 'Fly', lockHorizon: boolean) => {
      const r = rig();
      r.nav.settings.Smoothing = 0;
      r.nav.settings.Mode = mode;
      r.nav.settings.LockHorizon = lockHorizon;
      r.nav.feed({ ...sample, rz: 1 }, 'spacemouse');
      r.nav.step(0.1, r.camera, r.target);
      return new Euler().setFromQuaternion(r.camera.quaternion, 'YXZ').z;
    };
    expect(rollAfter('Orbit', false)).toBeCloseTo(0, 9);
    expect(rollAfter('Orbit', true)).toBeCloseTo(0, 9);
    expect(rollAfter('Fly', true)).toBeCloseTo(0, 9);
    expect(rollAfter('Fly', false)).toBeCloseTo(0.1, 6);
  });
  it('keeps a pivot beside the view axis and rebuilds the target on the new view axis', () => {
    const r = rig();
    r.nav.settings.Smoothing = 0;
    const pivot = new Vector3(3, 1, 0);
    const radius = r.camera.position.distanceTo(pivot);
    r.nav.feed({ ...sample, ry: 1 }, 'spacemouse');
    r.nav.step(0.1, r.camera, r.target, pivot);
    expect(pivot.toArray()).toEqual([3, 1, 0]);
    expect(r.camera.position.distanceTo(pivot)).toBeCloseTo(radius, 9);
    const forward = new Vector3(0, 0, -1).applyQuaternion(r.camera.quaternion);
    const toTarget = r.target.clone().sub(r.camera.position);
    expect(toTarget.clone().normalize().distanceTo(forward)).toBeLessThan(1e-9);
    expect(toTarget.length()).toBeCloseTo(pivot.clone().sub(r.camera.position).dot(forward), 9);
    r.nav.feed({ ...sample, tx: 1 }, 'spacemouse');
    const before = r.camera.position.clone();
    r.nav.step(0.1, r.camera, r.target, pivot);
    const pan = r.camera.position.clone().sub(before);
    expect(pivot.clone().sub(new Vector3(3, 1, 0)).distanceTo(pan)).toBeLessThan(1e-9);
  });
});

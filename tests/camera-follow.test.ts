// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CameraManager Follow / Sit-On tracking tests (plan-221 §9.1–9.4).
 *
 * Pure math against a real Three.js camera + fake OrbitControls — no DOM/WebGL.
 * controls.update() is a no-op in the harness, so these isolate the tickFollow
 * math (the live render loop additionally re-applies user orbit after the tick).
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Euler, Quaternion } from 'three';
import { makeTestCameraManager, makeFakeSource } from './helpers/camera-test-harness';
import { resolveFollowSource } from '../src/core/engine/rv-follow-source';
import type { ViewerHost } from '../src/core/engine/rv-viewer-host';

describe('CameraManager — Follow mode', () => {
  it('keeps the relative offset and follows the target (delta-pattern)', () => {
    const cm = makeTestCameraManager();
    const part = new Object3D();
    part.position.set(0, 0, 0); part.updateWorldMatrix(true, false);
    cm.camera.position.set(0, 5, 10);
    cm.controls.target.set(0, 0, 0);
    cm.startFollow(makeFakeSource(part));

    part.position.set(100, 0, 0); part.updateWorldMatrix(true, false);
    for (let i = 0; i < 240; i++) cm.tickFollow(1 / 60);   // converge

    expect(cm.controls.target.x).toBeCloseTo(100, 1);
    const offset = cm.camera.position.clone().sub(cm.controls.target);
    expect(offset.x).toBeCloseTo(0, 1);
    expect(offset.y).toBeCloseTo(5, 1);
    expect(offset.z).toBeCloseTo(10, 1);
    expect(cm.renderDirty).toBe(true);
  });
});

describe('CameraManager — Sit-On mode', () => {
  it.each([
    { label: 'path vehicle', metadata: { AgvBehavior: { Path: 'route' } }, forward: 1 },
    { label: 'plain part', metadata: {}, forward: -1 },
    { label: 'AGV without a resolved path', metadata: { AgvBehavior: {} }, forward: -1 },
  ])('9.5: looks along the local forward axis of a $label', ({ metadata, forward }) => {
    const cm = makeTestCameraManager();
    const parent = new Object3D();
    parent.rotation.set(0.2, 0.7, -0.1);
    const part = new Object3D();
    part.userData.realvirtual = metadata;
    parent.add(part);
    const viewer = { registry: { getNode: () => part } } as unknown as ViewerHost;
    const source = resolveFollowSource(viewer, 'part')!;
    expect(source.seatForward).toBe(forward === 1 ? 'posZ' : 'negZ');
    cm.startSitOn(source);
    for (const yaw of [0, Math.PI / 2]) {
      part.rotation.set(0.1, yaw, 0.3);
      cm.tickFollow(1 / 60);
      const expected = new Vector3(0, 0, forward).applyQuaternion(part.getWorldQuaternion(new Quaternion()));
      expect(cm.camera.getWorldDirection(new Vector3()).distanceTo(expected)).toBeLessThan(1e-6);
    }
  });

  it('keeps the seat in the part frame and applies mouse-look after the +Z correction', () => {
    const cm = makeTestCameraManager();
    const part = new Object3D();
    part.position.set(10, 2, 3);
    part.rotation.set(0.2, 0.7, -0.1);
    const seat = new Vector3(1, 4, 2);
    cm.startSitOn(makeFakeSource(part, { seatForward: 'posZ', seatHeight: 0 }), seat);
    cm.tickFollow(1 / 60);
    const expectedPosition = new Vector3(1, 0, 2).applyQuaternion(part.quaternion).add(part.position);
    expect(cm.camera.position.distanceTo(expectedPosition)).toBeLessThan(1e-6);
    expect(seat.y).toBe(4);
    const initial = cm.camera.quaternion.clone();
    cm.applyLookDelta(0, 100);
    cm.tickFollow(1 / 60);
    const localLook = initial.clone().invert().multiply(cm.camera.quaternion);
    expect(new Euler().setFromQuaternion(localLook, 'YXZ').x).toBeLessThan(0);
    expect(cm.camera.position.distanceTo(expectedPosition)).toBeLessThan(1e-6);
  });

  it('uses the source seat height instead of the default bounding-box height', () => {
    const cm = makeTestCameraManager();
    cm.startSitOn(makeFakeSource(new Object3D(), { seatHeight: 2.5 }));
    cm.tickFollow(1 / 60);
    expect(cm.camera.position.y).toBe(2.5);
  });

  it('attaches position and rotates the view with the part', () => {
    const cm = makeTestCameraManager();
    const part = new Object3D();
    part.position.set(10, 0, 0); part.updateWorldMatrix(true, false);
    cm.startSitOn(makeFakeSource(part), new Vector3(0, 1, 0));   // seat 1 m above
    cm.tickFollow(1 / 60);
    expect(cm.camera.position.x).toBeCloseTo(10, 3);
    expect(cm.camera.position.y).toBeCloseTo(1, 3);

    // Part rotates 90° about Y → the look direction must change accordingly.
    const fwdBefore = new Vector3(0, 0, -1).applyQuaternion(cm.camera.quaternion).clone();
    part.rotation.set(0, Math.PI / 2, 0); part.updateWorldMatrix(true, false);
    cm.tickFollow(1 / 60);
    const fwdAfter = new Vector3(0, 0, -1).applyQuaternion(cm.camera.quaternion);
    expect(fwdAfter.angleTo(fwdBefore)).toBeGreaterThan(1.0);    // ~90° swing

    // Mouse look adds a measurable yaw offset.
    const yawBefore = new Euler().setFromQuaternion(cm.camera.quaternion, 'YXZ').y;
    cm.applyLookDelta(200, 0);
    cm.tickFollow(1 / 60);
    const yawAfter = new Euler().setFromQuaternion(cm.camera.quaternion, 'YXZ').y;
    expect(yawAfter).not.toBeCloseTo(yawBefore, 4);
  });

  it('disables OrbitControls on entry', () => {
    const cm = makeTestCameraManager();
    const part = new Object3D(); part.updateWorldMatrix(true, false);
    cm.startSitOn(makeFakeSource(part));
    expect(cm.controls.enabled).toBe(false);
  });
});

describe('CameraManager — mode switch / restore', () => {
  it('re-enables orbit controls and restores the entry view on exit', () => {
    const cm = makeTestCameraManager();
    cm.camera.position.set(3, 4, 5);
    cm.controls.target.set(0, 0, 0);
    const part = new Object3D(); part.position.set(0, 0, 0); part.updateWorldMatrix(true, false);

    cm.startSitOn(makeFakeSource(part), new Vector3(0, 1, 0));
    cm.tickFollow(1 / 60);                          // camera moved onto the part
    expect(cm.controls.enabled).toBe(false);

    cm.stopFollowMode(true);                        // restore animation
    expect(cm.controls.enabled).toBe(true);
    expect(cm.isCameraAnimating).toBe(true);
    for (let i = 0; i < 120; i++) cm.tickCameraAnimation(1 / 60);
    expect(cm.camera.position.x).toBeCloseTo(3, 1); // back to entry view
    expect(cm.camera.position.y).toBeCloseTo(4, 1);
  });
});

describe('CameraManager — guards / edge cases', () => {
  it('is a no-op when no follow source is set', () => {
    const cm = makeTestCameraManager();
    const before = cm.camera.position.clone();
    cm.tickFollow(1 / 60);
    expect(cm.camera.position.equals(before)).toBe(true);
    expect(cm.followMode).toBe('off');
  });

  it('clamps sit-on pitch (verified via camera quaternion)', () => {
    const cm = makeTestCameraManager();
    const part = new Object3D(); part.updateWorldMatrix(true, false);
    cm.startSitOn(makeFakeSource(part));
    cm.applyLookDelta(0, 100000);                   // extreme downward look
    cm.tickFollow(1 / 60);
    const pitch = new Euler().setFromQuaternion(cm.camera.quaternion, 'YXZ').x;
    expect(Math.abs(pitch)).toBeLessThan(Math.PI / 2);
  });

  it('exits when the follow source dies (MU consumed)', () => {
    const cm = makeTestCameraManager();
    const src = makeFakeSource(new Object3D());
    cm.startFollow(src);
    expect(cm.followMode).toBe('follow');
    src.aliveRef.alive = false;                     // MU consumed / node removed
    cm.tickFollow(1 / 60);
    expect(cm.followMode).toBe('off');
  });
});

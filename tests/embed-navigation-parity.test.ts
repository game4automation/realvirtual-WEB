// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, MOUSE, TOUCH, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import { NavigationController } from '../src/core/engine/rv-navigation-controller';
import { nearFarFor, type NearFar } from '../src/core/engine/rv-navigation-math';
import { SceneScale } from '../src/core/engine/rv-scene-scale';
import { objectToGlb } from '../src/core/import/rv-import-object';
import {
  configureOrbitControls,
  DEFAULT_ORBIT_NAVIGATION_SETTINGS,
} from '../src/core/engine/rv-orbit-controls-config';
import { getDefaultVisualSettings } from '../src/core/hmi/visual-settings-store';
import { RVEmbedViewer } from '../src/embed/rv-embed-viewer';

let viewer: RVEmbedViewer | null = null;

afterEach(() => {
  viewer?.dispose();
  viewer = null;
});

describe('rv-embed navigation parity', () => {
  it('matches the realvirtual WEB mouse, touch, damping and speed defaults', () => {
    const appDefaults = getDefaultVisualSettings();
    expect(DEFAULT_ORBIT_NAVIGATION_SETTINGS).toMatchObject({
      orbitRotateSpeed: appDefaults.orbitRotateSpeed,
      orbitPanSpeed: appDefaults.orbitPanSpeed,
      orbitZoomSpeed: appDefaults.orbitZoomSpeed,
      orbitDampingFactor: appDefaults.orbitDampingFactor,
    });
    expect(DEFAULT_ORBIT_NAVIGATION_SETTINGS).not.toHaveProperty('distanceAdaptiveNav');
    expect(appDefaults).not.toHaveProperty('distanceAdaptiveNav');

    viewer = new RVEmbedViewer({ width: 320, height: 200 });
    const expected = {
      enableDamping: false,
      dampingFactor: 0,
      zoomToCursor: false,
      mouseButtons: { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN },
      touches: { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN },
      rotateSpeed: 0,
      panSpeed: 0,
      zoomSpeed: 0,
    };
    configureOrbitControls(expected as never, {
      orbitRotateSpeed: appDefaults.orbitRotateSpeed,
      orbitPanSpeed: appDefaults.orbitPanSpeed,
      orbitZoomSpeed: appDefaults.orbitZoomSpeed,
      orbitDampingFactor: appDefaults.orbitDampingFactor,
    });

    expect(navigationSnapshot(viewer.controls)).toEqual(navigationSnapshot(expected));
    // plan-515 Phase 2: every button and touch gesture belongs to the
    // NavigationController; OrbitControls is only the state holder.
    expect(viewer.controls.mouseButtons).toEqual({ LEFT: -1, MIDDLE: -1, RIGHT: -1 });
    expect(viewer.controls.touches).toEqual({ ONE: -1, TWO: -1 });
    expect(viewer.controls.enableDamping).toBe(true);
    expect(viewer.controls.dampingFactor).toBe(0.2);
    expect(viewer.controls.zoomToCursor).toBe(true);
    expect(viewer.controls.rotateSpeed).toBe(1);
    expect(viewer.controls.panSpeed).toBe(1);
    expect(viewer.controls.zoomSpeed).toBe(1);
  });

  it('updates damping every rendered frame and restores parity after context recycling', () => {
    viewer = new RVEmbedViewer({ width: 320, height: 200 });
    const update = vi.spyOn(viewer.controls, 'update');
    viewer.step(1 / 60);
    expect(update).toHaveBeenCalled();

    viewer.suspendContext();
    viewer.resumeContext();
    expect(navigationSnapshot(viewer.controls)).toMatchObject({
      enableDamping: true,
      dampingFactor: 0.2,
      zoomToCursor: true,
      mouseButtons: { LEFT: -1, MIDDLE: -1, RIGHT: -1 },
      touches: { ONE: -1, TWO: -1 },
      rotateSpeed: 1,
      panSpeed: 1,
      zoomSpeed: 1,
    });
  });
});

describe('rv-embed navigation parity (plan-515 Phase 1b)', () => {
  it('installs the main viewer NavigationController, picker and SceneScale', async () => {
    viewer = new RVEmbedViewer({ width: 320, height: 200 });
    expect(viewer.navController).toBeInstanceOf(NavigationController);
    expect(viewer.sceneScale).toBeInstanceOf(SceneScale);
    expect(viewer.raycastManager).toBeNull(); // no model yet
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(2, 1, 0.5), new MeshStandardMaterial()));
    await viewer.loadModel('parity-515.glb', await objectToGlb(root));
    expect(viewer.raycastManager).not.toBeNull();
    const scale = viewer.sceneScale.get();
    expect(scale.empty).toBe(false);
    expect(scale.radius).toBeCloseTo(Math.hypot(2, 1, 0.5) / 2, 6);

    // suspend / resume: a NEW controller on the NEW controls, picker rebuilt.
    const before = viewer.navController;
    viewer.suspendContext();
    expect(viewer.navController).toBeNull();
    expect(viewer.raycastManager).toBeNull();
    viewer.resumeContext();
    expect(viewer.navController).toBeInstanceOf(NavigationController);
    expect(viewer.navController).not.toBe(before);
    expect(viewer.raycastManager).not.toBeNull();

    viewer.dispose();
    expect(viewer.navController).toBeNull();
    expect(viewer.raycastManager).toBeNull();
  });

  it('sets near/far every frame with the main viewer function (nearFarFor)', async () => {
    viewer = new RVEmbedViewer({ width: 320, height: 200 });
    const root = new Group();
    root.add(new Mesh(new BoxGeometry(2, 1, 0.5), new MeshStandardMaterial()));
    await viewer.loadModel('parity-515.glb', await objectToGlb(root));
    const cam = (viewer as unknown as { sceneCamera: PerspectiveCamera }).sceneCamera;
    for (const pos of [[3, 2, 3], [0.2, 0.1, 0.4], [40, 30, 40]] as Array<[number, number, number]>) {
      viewer.cameraManager.cancelCameraAnimation();
      cam.position.set(...pos);
      viewer.controls.target.set(0, 0, 0);
      viewer.controls.update();
      viewer.step(1 / 60);
      const expected: NearFar = { near: 0, far: 0 };
      nearFarFor(cam.position.distanceTo(viewer.controls.target), cam.position, viewer.sceneScale.get(), expected);
      // 1 % hysteresis of CameraManager.applyClipping.
      expect(Math.abs(cam.near - expected.near)).toBeLessThanOrEqual(0.01 * expected.near + 1e-12);
      expect(Math.abs(cam.far - expected.far)).toBeLessThanOrEqual(0.01 * expected.far + 1e-9);
      expect(cam.far).toBeGreaterThan(cam.position.distanceTo(new Vector3()));
    }
  });
});

function navigationSnapshot(controls: {
  enableDamping: boolean;
  dampingFactor: number;
  zoomToCursor: boolean;
  mouseButtons: unknown;
  touches: unknown;
  rotateSpeed: number;
  panSpeed: number;
  zoomSpeed: number;
}) {
  return {
    enableDamping: controls.enableDamping,
    dampingFactor: controls.dampingFactor,
    zoomToCursor: controls.zoomToCursor,
    mouseButtons: controls.mouseButtons,
    touches: controls.touches,
    rotateSpeed: controls.rotateSpeed,
    panSpeed: controls.panSpeed,
    zoomSpeed: controls.zoomSpeed,
  };
}

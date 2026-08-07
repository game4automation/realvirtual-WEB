// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOUSE, TOUCH } from 'three';
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
      distanceAdaptiveNav: false,
    });

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
      distanceAdaptiveNav: false,
    });

    expect(navigationSnapshot(viewer.controls)).toEqual(navigationSnapshot(expected));
    expect(viewer.controls.mouseButtons).toEqual({
      LEFT: -1,
      MIDDLE: MOUSE.PAN,
      RIGHT: MOUSE.ROTATE,
    });
    expect(viewer.controls.touches).toEqual({
      ONE: TOUCH.ROTATE,
      TWO: TOUCH.DOLLY_PAN,
    });
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
      mouseButtons: {
        LEFT: -1,
        MIDDLE: MOUSE.PAN,
        RIGHT: MOUSE.ROTATE,
      },
      touches: {
        ONE: TOUCH.ROTATE,
        TWO: TOUCH.DOLLY_PAN,
      },
      rotateSpeed: 1,
      panSpeed: 1,
      zoomSpeed: 1,
    });
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

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-520 §9.4 — a user gesture (controls 'start') cancels the MCP
 * "Follow agent" flight and ONLY that one; untagged flights (bookmarks, focus)
 * keep the behaviour they always had. Uses the real CameraManager with the
 * shared harness controls and the same binding the viewer installs.
 */

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { makeTestCameraManager } from './helpers/camera-test-harness';
import {
  UserActivity,
  bindViewportGestureActivity,
  FOLLOW_AGENT_CAMERA_TAG,
} from '../src/core/rv-user-activity';
import type { CameraManager } from '../src/core/rv-camera-manager';

function setup() {
  const cm = makeTestCameraManager();
  cm.camera.position.set(0, 0, 10);
  const activity = new UserActivity();
  let t = 1000;
  activity._setClockForTest(() => t);
  const real = cm as unknown as CameraManager;
  const off = bindViewportGestureActivity(cm.controls, real, activity);
  return { cm, real, activity, off, setTime: (v: number) => { t = v; } };
}

describe('camera follow-agent cancel', () => {
  it('a controls start gesture cancels a tagged follow flight and marks user input', () => {
    const { cm, real, activity } = setup();
    real.animateCameraTo(new Vector3(5, 5, 5), new Vector3(1, 0, 0), 0.7, 'easeInOut', FOLLOW_AGENT_CAMERA_TAG);
    expect(cm.isCameraAnimating).toBe(true);
    expect(activity.isIdle(3000)).toBe(true);
    cm.controls.dispatchEvent({ type: 'start' });
    expect(cm.isCameraAnimating).toBe(false);
    expect(activity.isIdle(3000)).toBe(false);
  });

  it('an untagged flight (bookmark) is NOT cancelled by start', () => {
    const { cm, real } = setup();
    real.animateCameraTo(new Vector3(5, 5, 5), new Vector3(1, 0, 0), 0.6);
    cm.controls.dispatchEvent({ type: 'start' });
    expect(cm.isCameraAnimating).toBe(true);
  });

  it('cancelCameraAnimation() without a tag still cancels any flight', () => {
    const { cm, real } = setup();
    real.animateCameraTo(new Vector3(5, 5, 5), new Vector3(1, 0, 0), 0.7, 'easeInOut', FOLLOW_AGENT_CAMERA_TAG);
    real.cancelCameraAnimation();
    expect(cm.isCameraAnimating).toBe(false);
    real.animateCameraTo(new Vector3(5, 5, 5), new Vector3(1, 0, 0), 0.6);
    real.cancelCameraAnimation();
    expect(cm.isCameraAnimating).toBe(false);
  });

  it('a zero-duration flight (reduced motion) jumps without NaN, even on a zero-dt frame', () => {
    const { cm, real } = setup();
    real.animateCameraTo(new Vector3(5, 5, 5), new Vector3(1, 0, 0), 0, 'easeInOut', FOLLOW_AGENT_CAMERA_TAG);
    cm.tickCameraAnimation(0);
    expect(cm.isCameraAnimating).toBe(false);
    expect(cm.camera.position.x).toBeCloseTo(5, 6);
    expect(cm.controls.target.x).toBeCloseTo(1, 6);
  });

  it('unbinding removes the start listener', () => {
    const { cm, real, off } = setup();
    off();
    real.animateCameraTo(new Vector3(5, 5, 5), new Vector3(1, 0, 0), 0.7, 'easeInOut', FOLLOW_AGENT_CAMERA_TAG);
    cm.controls.dispatchEvent({ type: 'start' });
    expect(cm.isCameraAnimating).toBe(true);
  });
});

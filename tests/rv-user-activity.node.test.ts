// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** plan-520 §9.2 — the per-viewer idle clock and the gesture binding. */

import { describe, it, expect, vi } from 'vitest';
import {
  UserActivity,
  bindViewportGestureActivity,
  FOLLOW_AGENT_CAMERA_TAG,
} from '../src/core/rv-user-activity';

describe('UserActivity', () => {
  it('is idle initially', () => {
    const a = new UserActivity();
    a._setClockForTest(() => 0);
    expect(a.isIdle(3000)).toBe(true);
  });

  it('is not idle right after input and idle again after 3000 ms', () => {
    let t = 1000;
    const a = new UserActivity();
    a._setClockForTest(() => t);
    a.markUserInput();
    expect(a.isIdle(3000)).toBe(false);
    t = 3999;
    expect(a.isIdle(3000)).toBe(false);
    t = 4000;
    expect(a.isIdle(3000)).toBe(true);
  });
});

describe('UserActivity.inputEpoch', () => {
  it('starts at 0 and rises by one per markUserInput', () => {
    const a = new UserActivity();
    a._setClockForTest(() => 0);
    expect(a.inputEpoch).toBe(0);
    a.markUserInput();
    expect(a.inputEpoch).toBe(1);
    a.markUserInput(50);
    expect(a.inputEpoch).toBe(2);
  });
});

describe('bindViewportGestureActivity', () => {
  it('marks input and cancels only the follow-agent flight on a controls start; unbind detaches', () => {
    let startFn: (() => void) | null = null;
    const controls = {
      addEventListener: vi.fn((_t: 'start', fn: () => void) => { startFn = fn; }),
      removeEventListener: vi.fn((_t: 'start', fn: () => void) => { if (startFn === fn) startFn = null; }),
    };
    const camera = { cancelCameraAnimation: vi.fn() };
    const a = new UserActivity();
    a._setClockForTest(() => 500);
    const off = bindViewportGestureActivity(controls, camera, a);
    startFn!();
    expect(a.lastUserInputAt).toBe(500);
    expect(camera.cancelCameraAnimation).toHaveBeenCalledWith(FOLLOW_AGENT_CAMERA_TAG);
    off();
    expect(startFn).toBeNull();
  });
});

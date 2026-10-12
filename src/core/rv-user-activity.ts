// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * UserActivity — when did the user last touch THIS viewer's viewport (plan-520)?
 *
 * One instance per RVViewer. It is fed ONLY by real viewport input: an
 * OrbitControls `'start'` (dispatched by the NavigationController for a drag,
 * pinch or wheel gesture — never by a programmatic camera move), a pointerdown
 * on the canvas, a wheel event on the canvas and a key press inside the
 * viewer's keyboard scope. Clicks and typing in HMI panels do not count, so a
 * user can watch the AI agent while working in the Inspector.
 *
 * Consumers (the MCP "Follow agent" policy) ask {@link UserActivity.isIdle}
 * once per call. Feeding is a single timestamp write — no per-frame work.
 */

/** Tag of the camera flight the MCP "Follow agent" feedback starts; a user gesture cancels only this one. */
export const FOLLOW_AGENT_CAMERA_TAG = 'follow-agent';

const defaultClock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class UserActivity {
  /** Clock time (ms) of the last real viewport input; -Infinity = never (idle from the start). */
  lastUserInputAt = -Infinity;
  /** Monotonic count of real viewport inputs (starts at 0); lets a consumer tell "the user touched the view since X". */
  inputEpoch = 0;
  private _clock: () => number = defaultClock;

  /** Record a real user input at the viewport. */
  markUserInput(now: number = this._clock()): void {
    this.lastUserInputAt = now;
    this.inputEpoch++;
  }

  /** True when the user has not touched the viewport for at least `ms` milliseconds. */
  isIdle(ms: number, now: number = this._clock()): boolean {
    return now - this.lastUserInputAt >= ms;
  }

  /** Test hook: inject a clock (omit to restore the default). */
  _setClockForTest(clock?: () => number): void {
    this._clock = clock ?? defaultClock;
  }
}

/** The OrbitControls event surface {@link bindViewportGestureActivity} needs. */
export interface GestureEventSource {
  addEventListener(type: 'start', fn: () => void): void;
  removeEventListener(type: 'start', fn: () => void): void;
}

/** The camera surface {@link bindViewportGestureActivity} needs (CameraManager satisfies it). */
export interface TaggedAnimationHost {
  cancelCameraAnimation(tag?: string): void;
}

/**
 * Wire a viewer's controls `'start'` gesture into `activity`: every gesture
 * marks user input and cancels a running "Follow agent" flight (only that one —
 * a bookmark or focus flight keeps the behaviour it always had). Returns the
 * unbind function.
 */
export function bindViewportGestureActivity(
  controls: GestureEventSource,
  camera: TaggedAnimationHost,
  activity: UserActivity,
): () => void {
  const onStart = (): void => {
    activity.markUserInput();
    camera.cancelCameraAnimation(FOLLOW_AGENT_CAMERA_TAG);
  };
  controls.addEventListener('start', onStart);
  return () => controls.removeEventListener('start', onStart);
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Per-model camera start position types.
 *
 * Persisted in localStorage under key `rv-camera-start:{modelKey}`.
 * Optionally provided as GLB rv_extras `rv_camera_start` (Unity LHS — X is negated on read).
 */

export interface ModelCameraStart {
  /** Camera position (REQUIRED, finite). */
  px: number;
  py: number;
  pz: number;
  /** OrbitControls target (REQUIRED, finite). */
  tx: number;
  ty: number;
  tz: number;
  /** Tween duration in seconds; clamped to [0.05, 60]. Default 1.0. */
  duration?: number;
  /** Wall-clock timestamp (Date.now()) for UI display. */
  savedAt?: number;
  /** Origin of the preset — `user` (LocalStorage) or `author` (GLB rv_extras). */
  source?: 'user' | 'author';
}

/** Custom event name for same-tab save/clear notifications. */
export const CAMERA_START_CHANGED_EVENT = 'rv-camera-start-changed';

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-agent-eye-follow-source.ts — "attach my viewport to the agent".
 *
 * A {@link FollowSource} over the agent's camera body, so the double-click
 * attach is the EXISTING camera-follow machinery rather than a second tracking
 * loop: `CameraManager.startFollow` already has frame-rate-independent damping
 * and, in `'follow'` mode, leaves OrbitControls enabled — which is what lets the
 * human's first drag detach again (D-A6).
 *
 * The followed point is the agent's LOOK-AT TARGET, not its eye: follow mode
 * carries `controls.target` onto the source and shifts the camera by the same
 * delta, so following the target means "show me what the agent is looking at"
 * while the human keeps their own orbit angle. Following the eye position would
 * aim the viewport at the camera body itself.
 *
 * Every accessor writes into the caller's temp — the follow tick must not
 * allocate.
 */

import { Vector3, Quaternion, Box3, Matrix4 } from 'three';
import type { FollowSource } from './rv-follow-source';
import type { AgentEye } from './rv-agent-eye';

/** Half-extent of the synthetic bounds around the agent's target, metres. */
const AGENT_EYE_BOUNDS_HALF = 0.05;

const _lookMat = new Matrix4();
const _up = new Vector3(0, 1, 0);
const _eyePos = new Vector3();
const _tgtPos = new Vector3();

/** FollowSource over an {@link AgentEye}. */
export class AgentEyeFollowSource implements FollowSource {
  readonly label = 'AI agent eye';
  private readonly eye: AgentEye;
  private readonly onStopped?: () => void;

  /**
   * @param onStopped Called when the follow mode this source drives ends —
   *   including when `CameraManager.animateCameraTo` releases it on its own
   *   (D-A6b). Without it the plugin's `attached` flag and the hidden cone
   *   would survive a bookmark flight.
   */
  constructor(eye: AgentEye, onStopped?: () => void) {
    this.eye = eye;
    this.onStopped = onStopped;
  }

  /** IMPLEMENTS FollowSource::onFollowStopped */
  onFollowStopped(): void {
    this.onStopped?.();
  }

  getWorldPosition(out: Vector3): void {
    const p = this.eye.pose;
    out.set(p.tx, p.ty, p.tz);
  }

  getWorldQuaternion(out: Quaternion): void {
    const p = this.eye.pose;
    _eyePos.set(p.px, p.py, p.pz);
    _tgtPos.set(p.tx, p.ty, p.tz);
    if (_eyePos.distanceToSquared(_tgtPos) < 1e-12) _tgtPos.set(p.px, p.py, p.pz - 1);
    _lookMat.lookAt(_eyePos, _tgtPos, _up);
    out.setFromRotationMatrix(_lookMat);
  }

  /**
   * A 0.1 m cube around the target. Only Sit-On reads this (for its seat
   * offset) and the agent eye is never a Sit-On source, but `FollowSource`
   * requires it and an empty box would make the seat maths fall back silently.
   */
  getBounds(out: Box3): void {
    const p = this.eye.pose;
    out.setFromCenterAndSize(
      _tgtPos.set(p.tx, p.ty, p.tz),
      _eyePos.set(AGENT_EYE_BOUNDS_HALF * 2, AGENT_EYE_BOUNDS_HALF * 2, AGENT_EYE_BOUNDS_HALF * 2),
    );
  }

  /** False once the body is gone (model cleared / reset) — the tick then ends the mode. */
  isAlive(): boolean {
    return this.eye.exists;
  }
}

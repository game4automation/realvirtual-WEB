// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-camera-fly-math — pure relative camera movement (plan-705 Phase 1).
 *
 * The maths behind `web_camera_fly`: "three metres forward, thirty degrees to
 * the left" turned into an absolute camera pose. Deliberately free of any
 * Three.js scene graph, viewer or canvas so it is testable without WebGL —
 * only `Vector3` in, `Vector3` out.
 *
 * Two conventions are inherited on purpose, so an agent flight and a manual FPV
 * walk behave identically:
 *  - `right = (-fz, 0, fx)` and the XZ projection of `forward` when walking,
 *    from `FpvPlugin.onFixedUpdatePre`;
 *  - `+yaw = counter-clockwise seen from above`, from `web_camera_orbit`.
 *
 * NOTE the deliberate divergence (plan-705 D-A13): only the DIRECTION logic is
 * shared with the FPV plugin. The ground SOURCE is not — `web_camera_fly` probes
 * the pick BVH through `RaycastManager.raycastRay`, while the FPV plugin uses its
 * curated `_groundTargets` fixture whitelist. That is a decision, not an oversight.
 */

import { Vector3 } from 'three';

/** Gimbal guard, equivalent to the phi clamp in `web_camera_orbit`. */
export const MAX_PITCH_DEG = 85;

/** World up — every horizontal projection and the yaw axis refer to this. */
const WORLD_UP = new Vector3(0, 1, 0);

const DEG = Math.PI / 180;

export interface CameraPose {
  position: Vector3;
  target: Vector3;
}

export interface FlyInput {
  /** Metres along the view direction (projected onto XZ when `ground`). */
  forward?: number;
  /** Metres to the right (always horizontal, `(-fz, 0, fx)`). */
  right?: number;
  /** Metres along world +Y. */
  up?: number;
  /** Degrees, + = to the LEFT (the `web_camera_orbit` convention). */
  yawDeg?: number;
  /** Degrees, + = upwards. The resulting pitch is clamped to ±MAX_PITCH_DEG. */
  pitchDeg?: number;
  /** true = project forward/right onto XZ (walking instead of flying). */
  ground?: boolean;
}

const num = (n: number | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) ? n : 0;

/**
 * View/right basis of a pose. With `ground` both are projected onto the XZ
 * plane, so "3 m forward" does not drive into the floor just because the camera
 * happens to look 20° down (plan-705 D-A4).
 */
export function flyBasis(
  current: CameraPose,
  ground: boolean,
): { forward: Vector3; right: Vector3 } {
  const forward = current.target.clone().sub(current.position);
  if (forward.lengthSq() === 0) forward.set(0, 0, -1);
  forward.normalize();
  if (ground) {
    forward.y = 0;
    // Looking straight down/up leaves nothing to project — keep a usable
    // heading instead of returning a zero vector.
    if (forward.lengthSq() < 1e-12) forward.set(0, 0, -1);
    forward.normalize();
  }
  const right = new Vector3(-forward.z, 0, forward.x);
  if (right.lengthSq() < 1e-12) right.set(1, 0, 0);
  right.normalize();
  return { forward, right };
}

/**
 * New pose from the old pose plus a relative command. Pure: same input, same
 * output, no side effects, no scene graph.
 *
 * Order is translate-then-rotate: the translation uses the basis the camera had
 * when the command was issued, which is what "forward" means to the caller.
 * The distance |target − position| is preserved (plan-705 D-A3) so a following
 * `web_camera_orbit` still turns around something in front of the camera.
 */
export function computeFlyPose(current: CameraPose, input: FlyInput): CameraPose {
  const ground = input.ground === true;
  const { forward, right } = flyBasis(current, ground);

  // Orbit distance to keep (D-A3).
  const dist = current.position.distanceTo(current.target) || 1;

  const position = current.position.clone()
    .addScaledVector(forward, num(input.forward))
    .addScaledVector(right, num(input.right))
    .addScaledVector(WORLD_UP, num(input.up));

  // Rotation always starts from the TRUE view direction, never the projected
  // one — otherwise `ground` would silently flatten the operator's view.
  const dir = current.target.clone().sub(current.position);
  if (dir.lengthSq() === 0) dir.set(0, 0, -1);
  dir.normalize();

  const yaw = num(input.yawDeg);
  if (yaw !== 0) dir.applyAxisAngle(WORLD_UP, yaw * DEG);

  const pitchDelta = num(input.pitchDeg);
  const currentPitchDeg = Math.asin(Math.min(Math.max(dir.y, -1), 1)) / DEG;
  const wantedPitchDeg = currentPitchDeg + pitchDelta;
  const clampedPitchDeg = Math.min(Math.max(wantedPitchDeg, -MAX_PITCH_DEG), MAX_PITCH_DEG);
  if (clampedPitchDeg !== currentPitchDeg) {
    const horizontal = new Vector3(dir.x, 0, dir.z);
    // Straight up/down carries no heading to re-elevate from; fall back to the
    // pre-rotation horizontal so the camera does not snap to an arbitrary axis.
    if (horizontal.lengthSq() < 1e-12) {
      const base = flyBasis(current, true).forward;
      horizontal.set(base.x, 0, base.z);
    }
    horizontal.normalize();
    const p = clampedPitchDeg * DEG;
    dir.set(
      horizontal.x * Math.cos(p),
      Math.sin(p),
      horizontal.z * Math.cos(p),
    );
    dir.normalize();
  }

  const target = position.clone().addScaledVector(dir, dist);
  return { position, target };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-robot-coord.ts — the whole mathematics of the robot program export
 * (plan-773 Phase 4, F15). Port of `RobotCoordConverter.cs`, 95 lines.
 *
 * No iteration, no convergence, no numerical sensitivity beyond one clamp. That
 * is the measurement plan-773 E1 rests on: for 95 lines, a second Rust artifact
 * with string marshalling across an FFI boundary would buy risk, not safety.
 *
 * ## The input frame is UNITY's, and that is not a detail
 *
 * Every function below is a verbatim port, so every function below expects what
 * its C# original expects: a pose in **Unity's left-handed frame**. The web does
 * not have that frame — the glTF scene graph is right-handed, and the bridge
 * between the two is `mirrorPositionGltfUnity` / `mirrorQuaternionGltfUnity`
 * (`rv-coordinate-utils.ts`), measured in plan-772 on 18 demo targets.
 *
 * Getting the pose into the Unity frame is therefore the CALLER's job, and
 * `rv-ik-path-to-program.ts` does it in one place by asking
 * `targetPoseInBase(..., 'unity')`. Note that the two mirrors are different
 * reflections and must not be confused:
 *
 * | | reflection | where |
 * |---|---|---|
 * | glTF ⇄ Unity | negate **X** | UnityGLTF's export convention |
 * | Unity → vendor RH | negate **Y** | {@link positionToRightHanded} below |
 *
 * Composing them is a 180° turn about Z: a robot-local +X in the glTF tree is
 * −X in the exported program. Anyone who applies only one of the two gets a
 * program that is plausible, mirrored and wrong.
 *
 * ## Two arithmetic traps that C# and JavaScript do not share
 *
 * 1. **`Mathf.RoundToInt` rounds half to EVEN**, JavaScript's `Math.round`
 *    rounds half UP. {@link fanucTurn} divides by 360, so a joint at exactly
 *    ±180° lands on the midpoint and the two languages would disagree by a
 *    whole turn. {@link roundToIntUnity} is why they do not.
 * 2. **C# does this in `float`, here it is `double`.** The difference is far
 *    below the 0.1° the parity test asserts, but it is the reason the port is
 *    pinned by vectors and not by bit equality.
 *
 * Pinned by `tests/robot-program-model.node.test.ts` against the SAME fixed
 * vectors as the Unity feature tests `TestRobotExportEulerZYX.cs` and
 * `TestRobotExportConfigDerivation.cs` — that identity is the entire defence
 * against plan-773 R4 (the mathematics diverging in silence).
 */

import type { RobotConfigFlags } from './rv-robot-program';

/** A position or direction, `[x, y, z]`. */
export type Vec3 = [number, number, number];
/** A quaternion in Unity/Three component order, `[x, y, z, w]`. */
export type Quat = [number, number, number, number];

const RAD2DEG = 180 / Math.PI;

/**
 * `Mathf.RoundToInt` — round half to EVEN, which is what `System.Math.Round`
 * does by default and what JavaScript's `Math.round` does not. See trap 1 in
 * the module header.
 */
export function roundToIntUnity(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  // Exactly halfway: take whichever neighbour is even.
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Unity left-handed position -> right-handed (mirror Y). Multiply by the scene
 * scale for mm — see `scaleToMm` in `rv-ik-path-to-program.ts`.
 */
export function positionToRightHanded(unityPos: Readonly<Vec3>): Vec3 {
  return [unityPos[0], -unityPos[1], unityPos[2]];
}

/** Unity left-handed quaternion -> right-handed (mirror the Y component). */
export function convertToRightHanded(q: Readonly<Quat>): Quat {
  return [q[0], -q[1], q[2], q[3]];
}

/** What {@link quaternionToEulerZYX} answers. */
export interface EulerZYXResult {
  /** `[C, B, A]` = `[W, P, R]` in degrees — the component order Unity returns. */
  euler: Vec3;
  /** True when |B| > 89°, where A and C become coupled / undefined. */
  gimbalLock: boolean;
}

/**
 * Intrinsic ZYX Euler from a quaternion `q = (x, y, z, w)`, in DEGREES.
 * Identical mathematics for KUKA A/B/C and Fanuc R/P/W.
 *
 * ```
 *   A (=R, Z) = atan2( 2(wz + xy), 1 - 2(y^2 + z^2) )
 *   B (=P, Y) = asin ( 2(wy - zx) )           [clamped to handle rounding]
 *   C (=W, X) = atan2( 2(wx + yz), 1 - 2(x^2 + y^2) )
 * ```
 */
export function quaternionToEulerZYX(q: Readonly<Quat>): EulerZYXResult {
  const [x, y, z, w] = q;

  const a = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * RAD2DEG; // R / Z
  const sinB = Math.min(1, Math.max(-1, 2 * (w * y - z * x)));
  const b = Math.asin(sinB) * RAD2DEG; // P / Y
  const c = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * RAD2DEG; // W / X

  // |B|>89deg -> A/C undefined; the caller raises a warning + a comment.
  return { euler: [c, b, a], gimbalLock: Math.abs(b) > 89 };
}

/**
 * Right-handed quaternion -> rotation vector (axis-angle), components in
 * RADIANS. Magnitude = angle, direction = axis. Wandelbots NOVA poses (rx,ry,rz).
 */
export function quaternionToRotationVector(q: Readonly<Quat>): Vec3 {
  let [x, y, z, w] = q;
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; } // shortest rotation, angle in [0, pi]
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-6) return [0, 0, 0]; // identity rotation
  const angle = 2 * Math.atan2(s, w);
  const k = angle / s;
  return [x * k, y * k, z * k];
}

/** ABB-style per-axis configuration number: `cf = floor(axisDeg / 90)`. */
export function abbConfNumber(axisDeg: number): number {
  return Math.floor(axisDeg / 90);
}

/** Fanuc-style per-axis turn count: `round(axisDeg / 360)`, Unity's rounding. */
export function fanucTurn(axisDeg: number): number {
  return roundToIntUnity(axisDeg / 360);
}

/** KUKA Turn bitfield: bit i set if `jointDeg[i] < 0`. */
export function kukaTurnBits(jointDeg: readonly number[]): number {
  let t = 0;
  for (let i = 0; i < 6 && i < jointDeg.length; i++) {
    if (jointDeg[i] < 0) t |= (1 << i);
  }
  return t;
}

/** Fills the vendor-neutral configuration flags from joint angles, in place. */
export function fillConfigFlags(joints: readonly number[], cfg: RobotConfigFlags): void {
  for (let i = 0; i < 6 && i < joints.length; i++) {
    cfg.AbbConf[i] = abbConfNumber(joints[i]);   // ABB cf1/cf4/cf6 (floor/90)
    cfg.FanucTurns[i] = fanucTurn(joints[i]);    // Fanuc per-axis turn (round/360)
  }

  // Fanuc-style flip/elbow heuristics (each vendor reinterprets as needed).
  cfg.Flip = (joints.length > 4 && joints[4] >= 0) ? 0 : 1;  // J5>=0 -> N(0) else F(1)
  cfg.Lower = (joints.length > 2 && joints[2] >= 0) ? 0 : 1; // J3>=0 -> U(0) else D(1)
  cfg.Rear = 0; // needs arm geometry; default front

  cfg.KukaTurn = kukaTurnBits(joints);
  cfg.KukaStatus = 2; // model-dependent -> configurable default
  if (joints.length > 4 && joints[4] < 0) cfg.KukaStatus |= 4; // A5<0 -> set bit2
}

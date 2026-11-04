// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-robot-fk.ts — forward kinematics of a derived joint chain (plan-773 Phase 1).
 *
 * `web_robot_verify_fk` is the web pendant of Unity's `ik_verify_fk`
 * (`Packages/io.realvirtual.professional/Runtime/IK/IKTools.cs`), and it needs
 * the ONE thing that was so far only written down inside a test: forward
 * kinematics over a {@link JointChainParams}.
 *
 * ## The convention is not a choice
 *
 * This is the same composition the Rust solver's `compute_fk` performs and the
 * same one `tests/ik-cobot-glb-chain.test.ts` has been asserting against the
 * real export since plan-233: per axis, the HOME local transform of the axis
 * node followed by the joint rotation about the axis' own local direction,
 * accumulated down the chain, with the TCP offset applied last in the final
 * frame.
 *
 *     g₀ = home₀ · R(dir₀, q₀)
 *     gᵢ = gᵢ₋₁ · homeᵢ · R(dirᵢ, qᵢ)
 *     tcp = g₅ · tcpLocal
 *
 * It is written here, in production code, rather than copied into each caller,
 * because the two existing copies (the Rust core and the test) cannot check
 * each other and a third hand-rolled copy in an MCP tool would be a third
 * convention to keep in step.
 *
 * ## Frame
 *
 * The chain lives in the glTF/three frame — `IKSolveFrame` `'chain'` of the
 * frame contract in `rv-ik-solver.ts`. So does everything this module returns.
 * A caller comparing against a Unity-frame pose mirrors explicitly through
 * `mirrorPositionGltfUnity` / `mirrorQuaternionGltfUnity`; this module never
 * guesses a frame, and `targetPoseInBase(..., 'chain')` is what produces the
 * pose to compare with.
 *
 * Pure arithmetic on plain tuples: no three.js objects, no allocation beyond
 * the returned pose, and therefore testable in a `*.node.test.ts`.
 */

import type { JointChainParams } from './rv-ik-solver';

/** Quaternion as the house writes it: `[x, y, z, w]` (see `OpwParams.toolOffset`). */
export type Quat = [number, number, number, number];
/** A vector / position triple in meters. */
export type Vec3 = [number, number, number];

/** A pose in the chain's base (robot-local) frame, meters + quaternion. */
export interface RobotPose {
  pos: Vec3;
  quat: Quat;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Hamilton product `a · b`, both `[x, y, z, w]`. */
export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** Rotation of `rad` about the (unit) `axis`. */
export function quatAxisAngle(axis: Vec3, rad: number): Quat {
  const h = rad * 0.5;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

/** `q · v · q⁻¹` — rotate a vector by a quaternion. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Euclidean distance between two positions, in MILLIMETERS (the unit every report uses). */
export function positionErrorMm(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * 1000;
}

/**
 * Angle between two orientations in degrees, tolerant of the quaternion double
 * cover (`q` and `-q` are the same rotation, and a solver may return either).
 */
export function orientationErrorDeg(a: Quat, b: Quat): number {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, dot)) * RAD2DEG;
}

/** Per-axis frame of an FK evaluation: where that joint sits and how it is turned. */
export interface ChainFkFrame {
  /** Axis index 0..5. */
  axis: number;
  /** Origin of the axis frame, robot-local meters. */
  pos: Vec3;
  /** Orientation of the axis frame. */
  quat: Quat;
}

/** What one FK evaluation produced. */
export interface ChainFkResult {
  /** The TCP pose (tool offset + tool rotation applied). */
  tcp: RobotPose;
  /** The axis-6 flange pose, BEFORE the TCP offset — Unity's `fkFlangePos` pendant. */
  flange: RobotPose;
  /** One entry per axis, in order — the pendant of `ik_verify_fk`'s `framePositionsDH`. */
  frames: ChainFkFrame[];
}

/**
 * Forward kinematics of `chain` at `anglesDeg` (degrees, 6 entries).
 *
 * A missing or non-finite angle is treated as 0 rather than producing `NaN`
 * silently: a caller that hands in an unsolved `AxisPos` gets the home pose and
 * can see it, which is the behaviour the replay has.
 */
export function chainFk(chain: JointChainParams, anglesDeg: readonly number[]): ChainFkResult {
  const homePos = (i: number): Vec3 => [
    chain.axisHomePos[i * 3], chain.axisHomePos[i * 3 + 1], chain.axisHomePos[i * 3 + 2],
  ];
  const homeRot = (i: number): Quat => [
    chain.axisHomeRot[i * 4], chain.axisHomeRot[i * 4 + 1],
    chain.axisHomeRot[i * 4 + 2], chain.axisHomeRot[i * 4 + 3],
  ];
  const dir = (i: number): Vec3 => [
    chain.axisDir[i * 3], chain.axisDir[i * 3 + 1], chain.axisDir[i * 3 + 2],
  ];
  const angle = (i: number): number => {
    const a = anglesDeg[i];
    return Number.isFinite(a) ? (a as number) * DEG2RAD : 0;
  };

  const frames: ChainFkFrame[] = [];
  let gPos = homePos(0);
  let gRot = quatMul(homeRot(0), quatAxisAngle(dir(0), angle(0)));
  frames.push({ axis: 0, pos: gPos, quat: gRot });
  for (let i = 1; i < 6; i++) {
    const off = quatRotate(gRot, homePos(i));
    gPos = [gPos[0] + off[0], gPos[1] + off[1], gPos[2] + off[2]];
    gRot = quatMul(gRot, quatMul(homeRot(i), quatAxisAngle(dir(i), angle(i))));
    frames.push({ axis: i, pos: gPos, quat: gRot });
  }

  const flange: RobotPose = { pos: gPos, quat: gRot };
  const toff = quatRotate(gRot, chain.tcpLocalOffset as Vec3);
  return {
    flange,
    frames,
    tcp: {
      pos: [gPos[0] + toff[0], gPos[1] + toff[1], gPos[2] + toff[2]],
      quat: quatMul(gRot, chain.tcpLocalRot as Quat),
    },
  };
}

/** Length of a vector. */
export function vecLength(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

/** `a - b`. */
export function vecSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** Dot product. */
export function vecDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Cross product. */
export function vecCross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** `v` scaled to unit length, or `[0,0,0]` when it has none. */
export function vecNormalize(v: Vec3): Vec3 {
  const l = vecLength(v);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
}

/** The part of `v` perpendicular to the unit vector `axis`. */
export function vecRejectFrom(v: Vec3, axis: Vec3): Vec3 {
  const d = vecDot(v, axis);
  return [v[0] - d * axis[0], v[1] - d * axis[1], v[2] - d * axis[2]];
}

/** Angle between two directions in degrees (0..180). */
export function angleBetweenDeg(a: Vec3, b: Vec3): number {
  const na = vecNormalize(a);
  const nb = vecNormalize(b);
  const d = Math.min(1, Math.max(-1, vecDot(na, nb)));
  return Math.acos(d) * RAD2DEG;
}

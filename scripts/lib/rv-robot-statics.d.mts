// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for rv-robot-statics.mjs (plan-673 Phase 4b). */

export const G: number;

export interface StaticsAxis {
  name: string;
  /** Local translation of the axis node, metres, glTF frame. */
  pos: readonly [number, number, number];
  /** Local rotation, glTF (x, y, z, w); `null` = identity. */
  quat: readonly [number, number, number, number] | null;
  /** Rotation axis in the axis node's LOCAL frame. */
  axis: readonly [number, number, number];
  /** Symmetric joint limit, degrees. */
  limitDeg: number;
  /** Grid step when this joint is swept, degrees (default 10). */
  sweepStepDeg?: number;
}

export interface StaticsBody {
  axisIndex: number;
  massKg: number;
  /** Centre of mass in that axis node's local frame, millimetres. */
  comMm: readonly [number, number, number];
  /** Static frames between the axis node and the mass, applied in order. */
  frames?: ReadonlyArray<{
    t: readonly [number, number, number];
    q?: readonly [number, number, number, number];
  }>;
}

/** Gravity torque per joint at one pose, N*m, in MuJoCo's `qfrc_bias` sign. */
export function torquesAtPose(
  axes: readonly StaticsAxis[],
  bodies: readonly StaticsBody[],
  qRad: readonly number[],
): number[];

/** Worst-case |gravity torque| per joint over the whole admissible joint space. */
export function worstCaseGravityTorque(
  axes: readonly StaticsAxis[],
  bodies: readonly StaticsBody[],
): { worstNm: number[]; posesPerAxis: number[] };

/** `safety * worst`, never below `floorNm`, rounded up to `roundNm`. */
export function forceLimitNm(
  worstNm: number,
  opts?: { safety?: number; floorNm?: number; roundNm?: number },
): number;

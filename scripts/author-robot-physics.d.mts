// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for author-robot-physics.mjs (plan-673 Phase 4b). */

import type { BodyMeasurement } from './lib/rv-robot-link-geometry.d.mts';

/** The GENERIC half of the preset: no number belongs to one robot. */
export interface RobotPhysicsRole {
  linkProfile: string;
  jawProfile: string;
  mainAxisKp: number;
  wristAxisKp: number;
  mainAxisKv: number;
  wristAxisKv: number;
  armature: number;
  damping: readonly number[];
  followingErrorLimitDeg: number;
  followingErrorTimeMs: number;
  forceLimit: { safety: number; floorNm: number; roundNm: number };
  removeBehaviours: readonly string[];
}

export const ROBOT_PHYSICS_ROLE: RobotPhysicsRole;

export interface RobotPhysicsAxisSpec {
  node: string;
  /** `directionToGltfAxis(Direction)` with `ReverseDirection` applied. */
  axis: readonly [number, number, number];
  /** Measured structural following error at the working point, in DEGREES. */
  baseFollowingErrorDeg: number;
  sweepStepDeg?: number;
}

export interface RobotPhysicsSpec {
  file: string;
  catalogId: string;
  root: string;
  datasheet: {
    massKg: number;
    payloadKg: number;
    reachMm: number;
    repeatabilityMm: number;
    motionRangeDeg: readonly number[];
    permissibleWristMomentNm: readonly number[];
  };
  axes: readonly RobotPhysicsAxisSpec[];
  gripper: {
    node: string;
    jaws: readonly string[];
    strokeMm: number;
    gripForceTotalN: number;
    gripForcePerJawN: number;
    kp: number;
    kv: number;
    slipLimitMm: number;
  };
  expectedRig: { WristType: string; unrepresentableOffsetMm: number };
}

export const CRX_SPEC: RobotPhysicsSpec;

/** Every body of the chain, as an asset-relative path, in MJCF body order. */
export function bodyPaths(spec: RobotPhysicsSpec): string[];

export interface RobotPhysicsDerivation {
  measured: BodyMeasurement[];
  mass: { densityKgM3: number; totalVolumeMm3: number; massKg: number[] };
  worstNm: number[];
  posesPerAxis: number[];
  forceRangeNm: number[];
  paths: string[];
  /** The chain as the statics saw it — local frames READ from the file. */
  staticsAxes: Array<{
    name: string;
    pos: [number, number, number];
    quat: [number, number, number, number] | null;
    axis: readonly [number, number, number];
    limitDeg: number;
    sweepStepDeg?: number;
  }>;
  /** Static frames between the last axis and the gripper, read from the file. */
  toolFrames: Array<{ t: [number, number, number]; q?: [number, number, number, number] }>;
  /** Where a gripped payload hangs, in the gripper's frame, mm. */
  payloadComMm: number[];
}

/** Measure the asset and derive every authored number from it. */
export function deriveRobotPhysics(
  spec: RobotPhysicsSpec,
  role?: RobotPhysicsRole,
  file?: string,
): Promise<RobotPhysicsDerivation>;

/** Write every authored component into the glTF JSON; returns a change log. */
export function applyRobotPhysics(
  json: unknown,
  spec: RobotPhysicsSpec,
  derived: RobotPhysicsDerivation,
  role?: RobotPhysicsRole,
): string[];

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for author-robot-ik.mjs (library CRX rig + demo path, 2026-10-25). */

import type { Object3D, Quaternion, Vector3 } from 'three';

/** The slice of `RVDrive` the rig derivation reads, over an authored node. */
export interface DriveView {
  node: Object3D;
  Direction: string;
  ReverseDirection: boolean;
  UseLimits: boolean;
  LowerLimit: number;
  UpperLimit: number;
  getHomeLocalPosition(out?: Vector3): Vector3;
  getHomeLocalQuaternion(out?: Quaternion): Quaternion;
}

export function driveView(node: Object3D): DriveView;

export interface DemoTargetSpec {
  name: string;
  pos: readonly [number, number, number];
  interpolation: 'PointToPoint' | 'Linear';
  speed: number;
  wait: number;
}

export const DEMO_TARGETS: readonly DemoTargetSpec[];
export const TOOL_YAW_DEG: number;

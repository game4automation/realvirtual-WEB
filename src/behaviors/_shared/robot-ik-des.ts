// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVDrive } from '../../core/engine/rv-drive';
import type { RVMovingUnit } from '../../core/engine/rv-mu';
import type { RVRobotIK } from '../../core/engine/rv-robot-ik';
import {
  axisTargetPosition,
  validateAxisPos,
} from '../../core/engine/rv-axis-angle-utils';
import type { TweenSpec } from '../../core/material-flow/material-flow-self';

export interface RobotAxesPhase {
  readonly at0: number;
  readonly at1: number;
  readonly targetAxisPos: readonly number[];
}

export interface BuildAxesTweenOptions {
  readonly phases?: readonly RobotAxesPhase[];
  readonly ease?: 'linear' | 'scurve';
  readonly anchorRef?: string;
  readonly driveRefs?: readonly string[];
}

/** Event data plus the caller-owned duration, preserved verbatim. */
export interface AxesTweenPlan extends TweenSpec {
  readonly duration: number;
}

export type RobotIkAnchor = Pick<RVRobotIK, 'node' | 'getAxisDrives' | 'getTcpNode'>;

function nodePath(node: Object3D): string {
  const parts: string[] = [];
  let current: Object3D | null = node;
  while (current) {
    if (current.name) parts.push(current.name);
    current = current.parent;
  }
  return parts.reverse().join('/');
}

/**
 * Build a JSON-only axes tween. The duration is supplied by the caller and is
 * never derived from drive speed or distance.
 */
export function buildAxesTween(
  anchor: RobotIkAnchor,
  targetAxisPos: readonly number[],
  duration: number,
  options: BuildAxesTweenOptions = {},
): AxesTweenPlan {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`robot-ik-des: duration must be finite and > 0 (received ${duration})`);
  }
  const drives = anchor.getAxisDrives();
  if (drives.length === 0) throw new Error('robot-ik-des: RobotIK anchor has no axis drives');
  if (!validateAxisPos(targetAxisPos, drives.length)) {
    throw new Error(`robot-ik-des: target AxisPos must contain ${drives.length} finite values`);
  }

  const inputs = options.phases?.length
    ? options.phases
    : [{ at0: 0, at1: 1, targetAxisPos }];
  const previous = drives.map((drive) => drive.currentPosition);
  const driveRefs = options.driveRefs ?? drives.map((drive) => nodePath(drive.node));
  if (driveRefs.length !== drives.length) {
    throw new Error(`robot-ik-des: driveRefs must contain ${drives.length} paths`);
  }

  const phases: Extract<TweenSpec['tween'], { kind: 'axes' }>['phases'] = inputs.map((phase) => {
    if (!validateAxisPos(phase.targetAxisPos, drives.length)) {
      throw new Error(`robot-ik-des: phase AxisPos must contain ${drives.length} finite values`);
    }
    if (!Number.isFinite(phase.at0) || !Number.isFinite(phase.at1) || phase.at0 < 0 || phase.at1 > 1 || phase.at1 < phase.at0) {
      throw new Error('robot-ik-des: phase windows must satisfy 0 <= at0 <= at1 <= 1');
    }
    const axes = drives.map((drive, index) => {
      const from = previous[index];
      const to = axisTargetPosition(phase.targetAxisPos[index], drive, from);
      previous[index] = to;
      return { driveRef: driveRefs[index], from, to };
    });
    return { at0: phase.at0, at1: phase.at1, axes };
  });

  return {
    duration,
    tween: {
      kind: 'axes',
      anchorRef: options.anchorRef ?? nodePath(anchor.node),
      phases,
      ease: options.ease ?? 'scurve',
    },
  };
}

/** Atomically validate, unwrap and write one complete robot pose. */
export function snapToPose(anchor: Pick<RVRobotIK, 'getAxisDrives'>, axisPos: unknown): boolean {
  const drives = anchor.getAxisDrives();
  if (!validateAxisPos(axisPos, drives.length)) return false;
  const resolved = drives.map((drive, index) => axisTargetPosition(axisPos[index], drive));
  for (let i = 0; i < drives.length; i++) {
    const drive = drives[i];
    drive.positionOverwrite = true;
    drive.currentPosition = resolved[i];
    drive.applyToNode();
  }
  return true;
}

export interface TcpAttachment {
  readonly visual: RVMovingUnit;
  readonly previousParent: Object3D | null;
}

/** Attach a non-instanced MU to the robot TCP while preserving world pose. */
export function attachMuToTcp(anchor: Pick<RVRobotIK, 'getTcpNode'>, visual: RVMovingUnit): TcpAttachment | null {
  const tcp = anchor.getTcpNode();
  if (!tcp || visual.isInstanced) return null;
  const previousParent = visual.node.parent;
  tcp.attach(visual.node);
  return { visual, previousParent };
}

/** Detach an attached MU to a target (or its previous parent), preserving world pose. */
export function detachMuFromTcp(attachment: TcpAttachment, targetParent?: Object3D | null): void {
  const node = attachment.visual.node;
  const parent = targetParent === undefined ? attachment.previousParent : targetParent;
  if (parent) {
    parent.attach(node);
    return;
  }
  const worldPosition = node.getWorldPosition(node.position.clone());
  const worldQuaternion = node.getWorldQuaternion(node.quaternion.clone());
  const worldScale = node.getWorldScale(node.scale.clone());
  node.removeFromParent();
  node.position.copy(worldPosition);
  node.quaternion.copy(worldQuaternion);
  node.scale.copy(worldScale);
}

/** Structural drive type exported for focused scheduler tests. */
export type RobotAxisDrive = RVDrive;

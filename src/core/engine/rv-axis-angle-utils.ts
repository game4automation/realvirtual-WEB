// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVDrive } from './rv-drive';
import { isRotation } from './rv-coordinate-utils';

/** Drive fields needed by the shared axis-angle conversion. */
export type AxisAngleDrive = Pick<
  RVDrive,
  'Direction' | 'UseLimits' | 'LowerLimit' | 'UpperLimit' | 'currentPosition'
>;

/** Return the whole-turn representation nearest to `reference` within limits. */
export function unwrapAngleToReference(
  angle: number,
  reference: number,
  drive: Pick<AxisAngleDrive, 'UseLimits' | 'LowerLimit' | 'UpperLimit'>,
): number {
  const unwrapped = angle - 360 * Math.round((angle - reference) / 360);
  if (drive.UseLimits && (unwrapped < drive.LowerLimit || unwrapped > drive.UpperLimit)) {
    let best = angle;
    let bestDist = Infinity;
    let found = false;
    for (let k = -2; k <= 2; k++) {
      const candidate = unwrapped + k * 360;
      if (candidate >= drive.LowerLimit && candidate <= drive.UpperLimit) {
        const distance = Math.abs(candidate - reference);
        if (distance < bestDist) {
          bestDist = distance;
          best = candidate;
          found = true;
        }
      }
    }
    return found ? best : angle;
  }
  return unwrapped;
}

/** Convert one baked axis value to the command representation for a drive. */
export function axisTargetPosition(
  angle: number,
  drive: AxisAngleDrive,
  reference = drive.currentPosition,
): number {
  return isRotation(drive.Direction)
    ? unwrapAngleToReference(angle, reference, drive)
    : angle;
}

/** Validate exact axis count and finite values. An explicit all-zero pose is valid. */
export function validateAxisPos(axisPos: unknown, axisCount: number): axisPos is readonly number[] {
  return Number.isInteger(axisCount)
    && axisCount >= 0
    && Array.isArray(axisPos)
    && axisPos.length === axisCount
    && axisPos.every((value) => typeof value === 'number' && Number.isFinite(value));
}

/** Validate and convert a complete pose into `out` (reusable by hot callers). */
export function resolveAxisPositions(
  axisPos: unknown,
  drives: readonly AxisAngleDrive[],
  out: number[] = [],
): number[] | null {
  if (!validateAxisPos(axisPos, drives.length)) return null;
  out.length = drives.length;
  for (let i = 0; i < drives.length; i++) out[i] = axisTargetPosition(axisPos[i], drives[i]);
  return out;
}

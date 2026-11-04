// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-axis-angle-utils.ts — one axis value, one drive, one answer: may the axis
 * stand there, and in which representation?
 *
 * A rotational axis has infinitely many representations of the same physical
 * pose (`angle + k·360`). Everything downstream of a solver therefore asks two
 * different questions that used to be one:
 *
 * - *Which representation keeps the motion continuous?* — {@link axisTargetPosition},
 *   the replay's question: pick the turn nearest to where the axis already is.
 * - *Is ANY representation inside the joint limits?* — {@link limitRespectingAxisPosition},
 *   the authoring question (plan-772 Phase 5). `null` is a genuine joint-limit
 *   violation, not a rounding problem, and a caller that writes a drive through
 *   `positionOverwrite` (every IK preview and the LIN replay) bypasses the
 *   drive's own limit clamp (`rv-drive.ts` — the `positionOverwrite` branch
 *   returns long before `UseLimits` is applied), so it has to ask.
 *
 * {@link limitFeasibleAngle} is the single search both are built on, so the
 * selection filter and the replay unwrap can never disagree about which
 * representations exist.
 */

import type { RVDrive } from './rv-drive';
import { isRotation } from './rv-coordinate-utils';

/** Drive fields needed by the shared axis-angle conversion. */
export type AxisAngleDrive = Pick<
  RVDrive,
  'Direction' | 'UseLimits' | 'LowerLimit' | 'UpperLimit' | 'currentPosition'
>;

/** Just the limit window of a drive — all {@link limitFeasibleAngle} needs. */
export type AxisLimits = Pick<AxisAngleDrive, 'UseLimits' | 'LowerLimit' | 'UpperLimit'>;

/** How many whole turns either side of the reference are searched for a fit. */
const TURN_SEARCH = 2;

/** Is this exact value inside the limit window (no representation shift)? */
function withinLimits(value: number, limits: AxisLimits): boolean {
  return !limits.UseLimits || (value >= limits.LowerLimit && value <= limits.UpperLimit);
}

/**
 * The whole-turn representation of `angle` nearest to `reference` that the
 * limits allow — or `null` when no representation within ±{@link TURN_SEARCH}
 * turns fits.
 *
 * This is the ONE search. {@link unwrapAngleToReference} adds the replay's
 * "take it anyway" fallback on top; the solution filters read the `null`.
 */
export function limitFeasibleAngle(
  angle: number,
  reference: number,
  limits: AxisLimits,
): number | null {
  const unwrapped = angle - 360 * Math.round((angle - reference) / 360);
  if (withinLimits(unwrapped, limits)) return unwrapped;
  let best: number | null = null;
  let bestDist = Infinity;
  for (let k = -TURN_SEARCH; k <= TURN_SEARCH; k++) {
    const candidate = unwrapped + k * 360;
    if (candidate < limits.LowerLimit || candidate > limits.UpperLimit) continue;
    const distance = Math.abs(candidate - reference);
    if (distance < bestDist) {
      bestDist = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Return the whole-turn representation nearest to `reference` within limits.
 *
 * The `?? angle` is a KNOWN leak and the reason plan-772 Phase 5 exists: when
 * the limits refuse every representation this hands back the original angle
 * UNCHECKED, so a limit-violating solver result used to reach the drive here.
 * It stays as the replay's last line of defence (a baked `AxisPos` from Unity
 * may legitimately sit outside the web rig's limits, and refusing to move at
 * all would be worse than moving), but the SELECTION in front of it now drops
 * limit-violating configurations — see {@link limitRespectingAxisPosition} and
 * `rv-ik-solution-utils.ts`.
 */
export function unwrapAngleToReference(
  angle: number,
  reference: number,
  drive: AxisLimits,
): number {
  return limitFeasibleAngle(angle, reference, drive) ?? angle;
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

/**
 * The value an authoring caller may command for this axis, or `null` when the
 * drive's limits refuse the pose outright.
 *
 * Deliberately narrower than {@link axisTargetPosition}: a value the limits
 * already accept is returned UNCHANGED, so the solver's own branch identity
 * survives the preview and nothing that passes today starts moving a turn. Only
 * a value the limits refuse is shifted to the nearest representation they do
 * accept — and a `null` means no representation fits at all.
 */
export function limitRespectingAxisPosition(
  angle: number,
  drive: AxisAngleDrive,
  reference = drive.currentPosition,
): number | null {
  if (withinLimits(angle, drive)) return angle;
  // A linear axis has exactly one representation — out of limits is out.
  if (!isRotation(drive.Direction)) return null;
  return limitFeasibleAngle(angle, reference, drive);
}

/**
 * Index of the first axis whose drive limits refuse `angles[i]` in every
 * representation, or -1 when the whole configuration is admissible.
 *
 * Fewer drives than angles is not a violation — the extra angles have no axis
 * to constrain them (a rig with fewer than six drives is reported elsewhere).
 */
export function firstLimitViolation(
  angles: readonly number[],
  drives: readonly AxisAngleDrive[],
  reference?: readonly number[],
): number {
  const n = Math.min(angles.length, drives.length);
  for (let i = 0; i < n; i++) {
    const drive = drives[i];
    const ref = reference?.[i] ?? drive.currentPosition;
    if (limitRespectingAxisPosition(angles[i] ?? 0, drive, ref) === null) return i;
  }
  return -1;
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

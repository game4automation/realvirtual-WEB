// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-axis-contract.ts — the axis contract of plan-673 Phase 4.
 *
 * ── The problem it solves ──────────────────────────────────────────────────
 * `rv-ik-path.ts` moves a robot by writing the axis drive's ACTUAL position
 * (`d.currentPosition = a`), i.e. the IK is a kinematic setter, not a setpoint
 * giver. A dynamic axis writes `currentPosition` too — from the physics. Without
 * a rule the last writer of the tick wins, silently, and the robot either
 * teleports through its own contact or stands still for no visible reason.
 *
 * ── The rule (2.4) ────────────────────────────────────────────────────────
 * The IK is NOT switched off, it is REDIRECTED. Three roles, and only the role
 * decides:
 *
 * | role        | who moves the axis           | setpoint        | claim |
 * |-------------|------------------------------|-----------------|-------|
 * | `kinematic` | the drive's own integration  | PLC / jog / step| no    |
 * | `planned`   | a path planner that claimed  | the planner     | yes   |
 * | `dynamic`   | a force-limited actuator     | unchanged source| **no**|
 *
 * `dynamic` deliberately does NOT claim: `claimAxes()` additionally pauses
 * every registered participant, and those participants are exactly the path
 * planners (`rv-ik-path.ts`, `rv-kinematic-mechanism.ts`, `rv-mechanism-path.ts`)
 * — a claim would switch off the very thing the demo is meant to show. The one
 * exception is `SetpointSource: 'policy'`: there is no planner to keep alive,
 * so {@link RVDynamicAxis.claimsAxis} is true for it and the physics runtime
 * may claim.
 *
 * ── The cascade ───────────────────────────────────────────────────────────
 * {@link commandAxisPosition} is the ONE call site all three roles go through.
 * On a dynamic axis it writes the SETPOINT (`drive.commandPosition`) and leaves
 * the position to the physics; otherwise it does exactly what the callers did
 * before. That is why the change in `rv-ik-path.ts` is three lines and not a
 * second motion path.
 *
 * ── What this module does NOT do ──────────────────────────────────────────
 * It does not trip. A following error that leaves its window raises a signal
 * and a Problems entry (`rv-axis-diagnostics.ts`) and the path keeps running —
 * the conservative half of the open decision in 2.4, chosen on 2026-10-24. A
 * trip would attach in `rv-axis-diagnostics.ts` where the overload verdict is
 * produced, by calling `RVIKPath.cancel()` on the path that owns the axis; see
 * the note there.
 */

import type { Object3D } from 'three';
import type { RVDrive } from './rv-drive';
import { DEFAULT_ARRIVAL_TOLERANCE } from './rv-drive';
import type { RVDynamicAxis } from './rv-dynamic-axis';
import { axisOwner } from './rv-axis-ownership';
import { reportProblem, clearProblemsOfCode } from '../hmi/problems-store';

/** Who moves an axis, and therefore what its position MEANS. */
export type AxisRole = 'kinematic' | 'planned' | 'dynamic';

/** Problems code for a declaration that contradicts the rest of the model. */
export const AXIS_ROLE_CONFLICT = 'axis-role-conflict';

/**
 * Declare `drive` dynamic and apply the axis's arrival tolerance to it.
 *
 * The binding is a FIELD on the drive (`drive.dynamicAxis`), not a side table
 * here. Two reasons, and the second is the load-bearing one: a field shows up
 * wherever a drive is inspected or logged, and `rv-drive.ts` can read its own
 * role without importing this module — which it must not do at runtime, since
 * this module imports `rv-drive.ts` for the kinematic tolerance.
 */
export function bindDynamicAxis(drive: RVDrive, axis: RVDynamicAxis): void {
  drive.dynamicAxis = axis;
  drive.arrivalTolerance = arrivalToleranceOf(axis);
}

/** Undo {@link bindDynamicAxis} — the axis component was disposed. */
export function unbindDynamicAxis(drive: RVDrive, axis: RVDynamicAxis): void {
  if (drive.dynamicAxis !== axis) return;
  drive.dynamicAxis = null;
  drive.arrivalTolerance = DEFAULT_ARRIVAL_TOLERANCE;
}

/** The `DynamicAxis` declaring this drive dynamic, or null. */
export function dynamicAxisOf(drive: RVDrive): RVDynamicAxis | null {
  return drive.dynamicAxis ?? null;
}

/**
 * Arrival tolerance an axis declaration implies, in drive units.
 *
 * `ArrivalTolerance` wins when authored. Otherwise the tolerance is the
 * declared base sag plus the monitoring window — the band the axis is allowed
 * to sit in without being called overloaded is exactly the band in which it
 * must count as arrived. Never below the kinematic default, so a dynamic axis
 * is never STRICTER than a kinematic one.
 */
export function arrivalToleranceOf(axis: RVDynamicAxis): number {
  const declared = axis.ArrivalTolerance > 0
    ? axis.ArrivalTolerance
    : axis.BaseFollowingError + axis.FollowingErrorLimit;
  return Math.max(DEFAULT_ARRIVAL_TOLERANCE, declared);
}

/**
 * The role of one axis.
 *
 * `dynamic` outranks `planned`: a claimed dynamic axis (a policy axis) is still
 * dynamic — the claim says who writes the setpoint, not who integrates.
 */
export function axisRoleOf(drive: RVDrive): AxisRole {
  if (drive.dynamicAxis) return 'dynamic';
  return axisOwner(drive) !== null ? 'planned' : 'kinematic';
}

/**
 * Shorthand for `axisRoleOf(drive) === 'dynamic'`.
 *
 * Truthiness, not `!== null`: a partial stand-in drive (the MCP bridge tests,
 * the ribbon fixtures) carries only the members its consumer reads, so the
 * field is `undefined` there — and `undefined !== null` would declare every
 * such fake a dynamic axis and then read quantities it does not have.
 */
export function isDynamicAxis(drive: RVDrive): boolean {
  return !!drive.dynamicAxis;
}

/**
 * Write the axis SETPOINT — the cascade of rule 2.
 *
 * - `dynamic`: the setpoint goes to the actuator; the position stays the
 *   physics' answer, so the following error is a real number.
 * - `kinematic` / `planned`: the historical write — position AND target, i.e.
 *   the axis is where it was told to be.
 *
 * `snap` is for the kinematic branch only and mirrors what the IK replay used
 * to do at the END of a segment: stop the axis and park its target so the
 * arrival poll fires. It has no meaning on a dynamic axis, where stopping is
 * the actuator's business.
 */
export function commandAxisPosition(drive: RVDrive, value: number, snap = false): void {
  if (drive.dynamicAxis) {
    drive.commandPosition(value);
    return;
  }
  drive.currentPosition = value;
  drive.targetPosition = value;
  if (snap) {
    drive.currentSpeed = 0;
    drive.applyToNode();
  }
}

/** One contradiction between an axis declaration and the rest of the model. */
export interface AxisRoleConflict {
  readonly nodePath: string;
  readonly label: string;
  readonly reason: 'no-drive' | 'follow-position' | 'policy-claims-planner';
  readonly detail: string;
}

/** A node path for a component node, without depending on the registry. */
function labelOf(node: Object3D): string {
  return node.name || '(unnamed node)';
}

/**
 * Audit every dynamic axis of the loaded model and publish the contradictions.
 *
 * Deviation from 2.4 worth knowing: the plan says "at load". This runs at the
 * first fixed step after a load instead, because that is the first moment at
 * which EVERY participant is resolved — an `RVIKPath` resolves its axis drives
 * in `init()`, and a `DynamicAxis` that initialises first would audit against
 * an empty planner list and report nothing. One audit per model; `reset()` on
 * the diagnostics manager arms the next one.
 *
 * `plannerAxes` is the set of drives a path planner moves (the union of every
 * `RVIKPath`'s axis drives). It is passed in rather than imported so this
 * module does not depend on the IK layer.
 */
export function auditAxisRoles(
  axes: readonly RVDynamicAxis[],
  plannerAxes: ReadonlySet<RVDrive>,
): AxisRoleConflict[] {
  const conflicts: AxisRoleConflict[] = [];
  clearProblemsOfCode(AXIS_ROLE_CONFLICT);

  for (const axis of axes) {
    const path = axis.nodePath;
    const label = labelOf(axis.node);
    const drive = axis.drive;

    if (!drive) {
      conflicts.push({
        nodePath: path,
        label,
        reason: 'no-drive',
        detail: 'DynamicAxis declares the drive on this node dynamic, but the node carries no Drive. '
          + 'The declaration has no axis to act on and no actuator will be written for it.',
      });
      continue;
    }

    // 2.4, read off the code: a `Drive_FollowPosition` from the GLB writes
    // neither setpoint nor feedback once the axis is dynamic (its update() is
    // never called and it guards itself). Whoever relies on it loses exactly
    // the quantities the dynamic mode produces — so it is a load-time finding,
    // not a runtime surprise.
    for (const behavior of drive.driveBehaviors) {
      const type = (behavior as { constructor?: { name?: string } }).constructor?.name ?? '';
      if (type === 'RVDriveFollowPosition') {
        conflicts.push({
          nodePath: path,
          label,
          reason: 'follow-position',
          detail: 'The Drive on this node carries a Drive_FollowPosition. On a dynamic axis that behavior is '
            + 'mute: the drive takes the position-overwrite branch before the behavior pass, so it writes '
            + 'neither the setpoint nor the feedback. Bind the setpoint to the axis itself, or leave the axis '
            + 'kinematic.',
        });
        break;
      }
    }

    // A policy axis claims, and a claim pauses every registered participant —
    // including the path planner that is supposed to keep running.
    if (axis.claimsAxis && plannerAxes.has(drive)) {
      conflicts.push({
        nodePath: path,
        label,
        reason: 'policy-claims-planner',
        detail: "SetpointSource 'policy' claims the axis, but a path planner (IKPath / MechanismPath) moves this "
          + 'same drive. The claim pauses that planner, so the path would never advance. Use '
          + "SetpointSource 'planner' for an axis a path commands.",
      });
    }
  }

  for (const c of conflicts) {
    reportProblem({
      id: `${AXIS_ROLE_CONFLICT}:${c.nodePath}:${c.reason}`,
      code: AXIS_ROLE_CONFLICT,
      severity: 'warning',
      title: `Axis role conflict on ${c.label}`,
      detail: c.detail,
      nodePath: c.nodePath,
    });
  }
  return conflicts;
}

/** Drop the audit findings (model change). */
export function clearAxisRoleProblems(): void {
  clearProblemsOfCode(AXIS_ROLE_CONFLICT);
}

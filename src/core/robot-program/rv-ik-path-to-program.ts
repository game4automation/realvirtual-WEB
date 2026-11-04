// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-path-to-program.ts — builds a vendor-neutral {@link RobotProgram} from
 * an IKPath chain (plan-773 Phase 4, F16). Port of `IKPathToProgram.cs`.
 *
 * Its Doxygen header names three insights that were paid for once and must not
 * be paid for again. All three are carried over here:
 *
 * 1. **Every waypoint is re-solved.** `AxisPos` is stale or zero otherwise
 *    (`IKPathToProgram.cs:83-84`). The re-solve goes through
 *    {@link solveRobotToWorldPose}, so frame and solver are chosen by the ONE
 *    expression `solveFrameFor` and never guessed — which is what plan-772's
 *    two corrections bought and what gates this phase.
 * 2. **The Cartesian pose comes from the waypoint's TRANSFORM**, never from a
 *    stored pose field. Unity is blunt about why: `IKTarget.PosRH/RotRH` are
 *    *"unreliable — never written by the solver"*.
 * 3. **Scene units are scaled to millimetres**, once, at this boundary.
 *
 * Plus the three properties that make it a contract rather than a routine: one
 * instruction per waypoint and **no sampling or interpolation of the path**;
 * `includeLinkedPaths` follows the `StartNextPath` chain with a cycle guard;
 * and reference angles are carried from waypoint to waypoint like the path
 * player, so a joint does not take a 360° detour between two instructions.
 *
 * ## The scale factor, and why it is not `realvirtualController.Scale`
 *
 * Unity multiplies by `realvirtualController.Scale` (default 1000) and warns in
 * the same breath *"Do NOT additionally multiply by 1000"*. The web has no such
 * controller: the glTF scene graph IS metres, so the factor is
 * {@link MM_TO_METERS} — the same number, for the same reason, read from the
 * house constant instead of from a scene object.
 *
 * ## The frame: the export frame is NOT the solve frame
 *
 * The solve frame is whatever this robot's wrist and solver need (`'chain'` for
 * a cobot on a pro solver, `'unity'` otherwise). The EXPORT frame is always
 * `'unity'`, because {@link positionToRightHanded} and
 * {@link convertToRightHanded} are verbatim ports of functions defined on
 * Unity-frame input. Mixing the two would produce a program that is plausible
 * and mirrored — see the table in `rv-robot-coord.ts`.
 *
 * ## What this port does NOT do: write to the scene
 *
 * Unity's `Convert` mutates — `SolveIK` writes `AxisPos` and `Reachable` onto
 * every target, which is why the editor window has to wrap the whole call in an
 * Undo group and roll it back (`RobotProgramExportWindow.cs:318`). Here nothing
 * is written: {@link solveRobotToWorldPose} is documented as moving nothing and
 * writing nothing, so the export is read-only by construction and Phase 5 needs
 * no undo machinery. Deliberate deviation, same end state, one fewer way to
 * dirty a document.
 *
 * ## Known field gaps against Unity (plan-773 §C.1, R5) — reported, not hidden
 *
 * - `IKPath.TCP` does not exist in the web, so the tool name cannot be switched
 *   per path. A file that carries one gets a WARNING naming the difference,
 *   never a silently different program.
 * - `AxisCorrection` (Unity `IKTarget.cs`) is NOT applied: the web dropped the
 *   field on 2026-11-02 (the web replay never applied it either), so
 *   `JointAngles[i] = AxisPos[i]`. Unity's export adds it. A file that still
 *   carries a non-zero correction makes the export warn ONCE on the console
 *   ({@link warnIgnoredAxisCorrection}); with all zeros (the only value found in
 *   any shipped GLB) both exports are identical.
 */

import { MM_TO_METERS } from '../engine/rv-constants';
import { identityIdOf } from '../engine/rv-decode-identity';
import { targetPoseInBase } from '../engine/rv-ik-solver';
import {
  IK_AXIS_COUNT, currentDriveAngles, solveRobotToWorldPose,
} from '../engine/rv-ik-authoring';
import type { RVIKPath } from '../engine/rv-ik-path';
import type { RVIKTarget } from '../engine/rv-ik-target';
import type { RVRobotIK } from '../engine/rv-robot-ik';
import { chainFk, orientationErrorDeg, positionErrorMm } from '../engine/rv-robot-fk';
import {
  convertToRightHanded, fillConfigFlags, positionToRightHanded, quaternionToEulerZYX,
  type Quat, type Vec3,
} from './rv-robot-coord';
import { robotProgramExportGate, type RobotProgramGateVerdict } from './rv-robot-program-gate';
import {
  newRobotMoveInstruction, newRobotProgram,
  type RobotAnglesSource, type RobotFkCheck, type RobotMoveType, type RobotProgram,
} from './rv-robot-program';

/**
 * Position tolerance of the F21 runtime check, in millimetres — the same 1 mm
 * plan-773 §8 T3 fixes for the gate test, so the production guard and the test
 * agree on what "correct" means.
 */
export const FK_TOLERANCE_MM = 1;

/**
 * Orientation tolerance of the F21 runtime check, in degrees.
 *
 * Ten times looser than T3's 0.1°, deliberately: 0.1° is inside the numeric
 * noise of a quaternion that has been composed, inverted and differenced, so a
 * 0.1° production gate would refuse correct exports. The failure this guard
 * exists for measured 180.00° (plan-772), and 1° separates the two by more than
 * two orders of magnitude.
 */
export const FK_TOLERANCE_DEG = 1;

/** Options of {@link ikPathToProgram} — parity with `Convert`'s one argument. */
export interface IkPathToProgramOptions {
  /**
   * Follow the `StartNextPath` chain into one continuous program. Default
   * false: only the selected path's own waypoints are exported.
   */
  includeLinkedPaths?: boolean;
}

let axisCorrectionWarned = false;

/**
 * Warn once per session when a waypoint still carries a non-zero Unity
 * `AxisCorrection`. The web ignores the field; Unity's export would add it to the
 * joint angles, so the two programs differ by exactly that vector. Reads the raw
 * node extras — the web component no longer has the field.
 */
function warnIgnoredAxisCorrection(t: RVIKTarget): void {
  if (axisCorrectionWarned) return;
  const raw = (t.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)
    ?.['IKTarget']?.['AxisCorrection'];
  if (!Array.isArray(raw)) return;
  if (!raw.some((v) => { const n = Number(v); return Number.isFinite(n) && n !== 0; })) return;
  axisCorrectionWarned = true;
  console.warn(
    `[robot-program] Target '${t.node.name}' carries a non-zero AxisCorrection (${JSON.stringify(raw)}). `
    + 'realvirtual WEB ignores AxisCorrection: the exported joint angles are the bare AxisPos, '
    + "while Unity's export would add the correction. Fold the correction into the waypoints if it matters.",
  );
}

/** Test seam: re-arm the one-time AxisCorrection warning. */
export function resetAxisCorrectionWarningForTests(): void {
  axisCorrectionWarned = false;
}

/** `StartNextPath` chain guard — the same bound as `IKPathToProgram.cs:67`. */
const CHAIN_GUARD = 256;

/**
 * Convert an IKPath into a {@link RobotProgram}.
 *
 * Read-only: no drive moves, no extras are written, no document is touched.
 * Returns a program whose `refusal` is set and whose `Instructions` are empty
 * when the licence gate (plan-773 E3) declines — a refusal is never a warning
 * and never a partial program.
 */
export function ikPathToProgram(
  rootPath: RVIKPath | null,
  options: IkPathToProgramOptions = {},
): RobotProgram {
  const prog = newRobotProgram();

  if (!rootPath) {
    prog.Warnings.push('No IKPath provided.');
    return prog;
  }

  prog.Name = rootPath.node.name;
  prog.sourcePathNodeId = identityIdOf(rootPath.node);

  // The gate BEFORE any waypoint is read, but AFTER the program is named, so a
  // refusal still says which program was refused (plan-773 E3).
  const gate: RobotProgramGateVerdict = robotProgramExportGate();
  if (!gate.allowed) {
    prog.refusal = gate.refusal;
    return prog;
  }

  const robot: RVRobotIK | null = rootPath.robot;
  prog.SourceRobotName = robot ? robot.node.name : '(none)';

  // Early-out: without a robot nothing can be solved or transformed.
  if (!robot) {
    prog.Warnings.push('No RobotIK found on the IKPath or its parents - cannot export.');
    return prog;
  }

  // Warn (do not fail) when the kinematic parameters were never computed.
  // Unity tests `a1 == 0 && a2 == 0 && …`; here `getOpwParams()` already
  // returns null for a rig without a finite `a1`, which is the same state one
  // step earlier, so both spellings are covered.
  const opw = robot.getOpwParams();
  if (!opw || (opw.a1 === 0 && opw.a2 === 0 && opw.b === 0
    && opw.c1 === 0 && opw.c2 === 0 && opw.c3 === 0 && opw.c4 === 0)) {
    prog.Warnings.push(
      'Kinematic parameters (a1..c4) are all zero or absent - rig the robot '
      + '(ik.robot.rig / web_query("ik.robot.rigDiagnose", {path})) before exporting.',
    );
  }

  // The tool chain is what plan-772 found collapsed (239.90 mm / 180.00°), and
  // a Cartesian instruction is only as good as it. Unity has no such check
  // because its TCP cannot be removed by a bake; the web's can.
  if (!robot.getTcpNode()) {
    prog.Warnings.push(
      'This robot has no resolved TCP node, so every Cartesian pose below is the A6 flange pose, '
      + 'not the tool pose. The joint angles are unaffected - prefer an axis-based export here '
      + '(plan-773 E9).',
    );
  }

  // Scene units -> mm. See the module header: MM_TO_METERS is the web's
  // realvirtualController.Scale. Do NOT additionally multiply by 1000.
  const scale = MM_TO_METERS;

  // `IKPath.TCP` has no web counterpart (plan-773 §C.1) — so the tool name is
  // always Unity's default, and a file that WOULD have switched it says so.
  prog.ToolName = 'tool0';
  if (pathDeclaresOwnTcp(rootPath)) {
    prog.Warnings.push(
      `IKPath "${rootPath.node.name}" declares its own TCP (SetNewTCP). The WebViewer has no IKPath.TCP `
      + 'field, so the tool is NOT switched for this path and the program is emitted against "tool0". '
      + 'Unity would have named and switched it - check the tool frame on the controller.',
    );
  }
  prog.ToolOffsetMm = scaleVec(robot.getToolOffset(), scale);

  // The reference the FIRST waypoint of every path is solved against — Unity's
  // SetReferenceAnglesToCurrentPosition(). Constant across the whole export,
  // because nothing here moves a drive.
  const homeReference = currentDriveAngles(robot);

  // Reusable out-tuples for the Cartesian pose (one conversion at a time).
  const pos: Vec3 = [0, 0, 0];
  const quat: Quat = [0, 0, 0, 1];

  let path: RVIKPath | null = rootPath;
  let guard = 0;
  const seenPaths = new Set<RVIKPath>();
  while (path && guard++ < CHAIN_GUARD && !seenPaths.has(path)) {
    seenPaths.add(path);
    if (path !== rootPath && pathDeclaresOwnTcp(path)) {
      prog.Warnings.push(
        `Linked IKPath "${path.node.name}" declares its own TCP (SetNewTCP); the WebViewer cannot switch `
        + 'the tool mid-program, so its waypoints are emitted against the same tool as the first path.',
      );
    }

    const targets = path.targets;
    // Reference angles like the path player (joint continuity / no 360° flips).
    // Unity reads the PREVIOUS waypoint's AxisPos, which its own re-solve has
    // just written; here the previous solve's result is carried directly.
    let previousAxisPos: number[] | null = null;

    for (let n = 0; n < targets.length; n++) {
      const t = targets[n];
      if (!t) continue;

      const seed = n > 0 && previousAxisPos ? previousAxisPos : homeReference;

      t.node.updateWorldMatrix(true, false);
      const solved = solveRobotToWorldPose(robot, t.node.matrixWorld, seed);

      // The joint half. `AxisPos` is the SOLVER's output (the reference for the
      // next waypoint); `JointAngles` adds the correction, like Unity.
      let axisPos: number[];
      let anglesSource: RobotAnglesSource;
      if (solved.reachable && solved.angles) {
        axisPos = solved.angles;
        anglesSource = 'solved';
      } else if (t.hasReplayAngles(IK_AXIS_COUNT)) {
        axisPos = t.AxisPos.slice(0, IK_AXIS_COUNT);
        anglesSource = 'baked';
        prog.Warnings.push(
          `Target '${t.node.name}' not reachable: ${solved.refusal ?? 'no configuration found.'} `
          + 'The instruction carries the joint angles baked into the file instead of a fresh solve - '
          + 'they describe a pose this rig does not reproduce today.',
        );
      } else {
        axisPos = new Array<number>(IK_AXIS_COUNT).fill(0);
        anglesSource = 'none';
        prog.Warnings.push(
          `Target '${t.node.name}' not reachable and carries no baked joint angles: `
          + `${solved.refusal ?? 'no configuration found.'} Its instruction has NO usable joint vector.`,
        );
      }
      previousAxisPos = axisPos;

      // ── F21: the runtime FK check, on the FIRST waypoint of the program ──
      // Same measurement web_robot_verify_fk makes; see measureFirstTargetFk.
      // A breach aborts: a tool chain that is demonstrably not the robot's
      // would be written into every Cartesian pose of the file (plan-772
      // measured 239.90 mm / 180.00° for exactly this state).
      if (prog.FkCheck === null) {
        prog.FkCheck = measureFirstTargetFk(robot, t, axisPos, anglesSource);
        if (prog.FkCheck.status === 'breached') {
          prog.refusal = {
            code: 'fk',
            message: 'The forward-kinematics check on the first waypoint failed: '
              + `${prog.FkCheck.reason} The joint angles this export would write do not put the tool where `
              + 'the waypoint is, so no program is produced. Re-rig the robot (ik.robot.rig) '
              + 'and check web_query("ik.robot.verifyFk", {path}) before exporting again.',
          };
          prog.Instructions = [];
          return prog;
        }
      }

      const m = newRobotMoveInstruction();
      m.MoveType = moveTypeOf(t);
      m.AnglesSource = anglesSource;
      for (let i = 0; i < IK_AXIS_COUNT; i++) {
        m.JointAngles[i] = axisPos[i] ?? 0;
      }
      warnIgnoredAxisCorrection(t);

      // The Cartesian half: computed HERE from the waypoint transform, in the
      // Unity frame, because that is the frame RobotCoordConverter is defined on.
      robot.node.updateWorldMatrix(true, false);
      targetPoseInBase(robot.node.matrixWorld, t.node.matrixWorld, pos, quat, 'unity');
      m.PositionMm = scaleVec(positionToRightHanded(pos), scale);
      m.RotationQuat = convertToRightHanded(quat);
      const zyx = quaternionToEulerZYX(m.RotationQuat);
      m.EulerZYXDeg = zyx.euler;
      if (zyx.gimbalLock) {
        prog.Warnings.push(`Target '${t.node.name}': gimbal lock (|B|>89 deg), A/C undefined.`);
      }

      m.JointSpeedPct = clamp01(t.SpeedToTarget * path.SpeedOverride) * 100;
      m.LinSpeedMmS = t.LinearSpeedToTarget;
      m.LinAccelMmS2 = t.LinearAcceleration;
      m.EnableBlending = t.EnableBlending;
      m.BlendRadiusMm = t.EnableBlending ? t.BlendRadius : 0;

      m.DwellSec = t.WaitForSeconds;
      m.SetSignalName = t.setSignalAddr;
      m.SetSignalValue = true;
      m.WaitSignalName = t.waitForSignalAddr;
      m.WaitSignalValue = true;

      if (t.PickAndPlace && (t.Pick || t.Place)) {
        m.PickPlaceSignalName = `GRIPPER_${prog.ToolName}`;
        m.PickPlaceSignalValue = t.Pick; // Pick => true (close), Place => false (open)
      }

      fillConfigFlags(m.JointAngles, m.Config);

      m.Comment = t.node.name + (anglesSource === 'solved' ? '' : ' [UNREACHABLE]');
      prog.Instructions.push(m);
    }

    if (!options.includeLinkedPaths) break; // only the selected path unless chaining is asked for
    path = path.LoopPath ? null : path.nextPath; // LoopPath emitted once, no infinite chain
  }

  // Only when the guard is what STOPPED the walk: a chain that ended on its own
  // leaves `path` null, and the `break` above leaves `guard` at 1.
  if (path !== null && guard >= CHAIN_GUARD) {
    prog.Warnings.push(
      `The StartNextPath chain hit the guard of ${CHAIN_GUARD} paths and was cut off here; `
      + 'the program is incomplete.',
    );
  }

  return prog;
}

/**
 * The F21 measurement: forward kinematics of the angles this export is about to
 * write, against the waypoint the robot is supposed to stand on.
 *
 * Measured in the CHAIN frame, because `chainFk` is defined there and
 * `targetPoseInBase(..., 'chain')` is the matching reader — the same pairing
 * `web_robot_verify_fk` and `ik.target.solve` use. (This is a different
 * frame from the EXPORT frame, which is always `'unity'`; see the module
 * header. The two never meet: this function compares two chain-frame poses with
 * each other and hands nothing to the converter.)
 *
 * It answers `'unavailable'` rather than `'ok'` whenever it could not measure.
 * That distinction is load-bearing: `'unavailable'` lets the axis-based export
 * through and stops the Cartesian one (plan-773 E9), while an optimistic `'ok'`
 * would vouch for a tool chain nobody looked at.
 */
function measureFirstTargetFk(
  robot: RVRobotIK,
  target: RVIKTarget,
  axisPos: readonly number[],
  anglesSource: RobotAnglesSource,
): RobotFkCheck {
  const name = target.node.name;
  const none = (reason: string): RobotFkCheck => ({
    status: 'unavailable', reason, positionErrorMm: null, orientationErrorDeg: null, targetName: name,
  });

  if (!robot.getTcpNode()) {
    return none('this robot has no resolved TCP node, so there is no tool pose to verify.');
  }
  if (anglesSource !== 'solved') {
    return none(`waypoint '${name}' did not solve, so there are no fresh angles to verify.`);
  }
  const chain = robot.getJointChain();
  if (!chain) {
    return none('this robot has no derived joint chain, so forward kinematics cannot be computed.');
  }

  const fk = chainFk(chain, axisPos);
  const refPos: Vec3 = [0, 0, 0];
  const refQuat: Quat = [0, 0, 0, 1];
  robot.node.updateWorldMatrix(true, false);
  targetPoseInBase(robot.node.matrixWorld, target.node.matrixWorld, refPos, refQuat, 'chain');

  const dPos = positionErrorMm(fk.tcp.pos, refPos);
  const dRot = orientationErrorDeg(fk.tcp.quat, refQuat);
  const breached = dPos > FK_TOLERANCE_MM || dRot > FK_TOLERANCE_DEG;
  return {
    status: breached ? 'breached' : 'ok',
    reason: breached
      ? `waypoint '${name}' is off by ${round2(dPos)} mm / ${round2(dRot)} deg `
        + `(tolerance ${FK_TOLERANCE_MM} mm / ${FK_TOLERANCE_DEG} deg).`
      : `waypoint '${name}' verified to ${round2(dPos)} mm / ${round2(dRot)} deg.`,
    positionErrorMm: round2(dPos),
    orientationErrorDeg: round2(dRot),
    targetName: name,
  };
}

/** Two decimals — the precision the robot tools report an error with. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** `Mathf.Clamp01`. */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Multiply a vector by a scalar, as a fresh tuple. */
function scaleVec(v: Readonly<Vec3>, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

/** The move type of one waypoint — the switch of `IKPathToProgram.cs:89-100`. */
function moveTypeOf(t: RVIKTarget): RobotMoveType {
  switch (t.InterpolationToTarget) {
    case 'Linear': return 'LIN';
    case 'PointToPointUnsynced': return 'PTPUnsynced';
    default: return 'PTP';
  }
}

/**
 * Does this path's FILE declare a tool of its own? `SetNewTCP` exists on the web
 * component; the `TCP` reference it points at does not, so the raw extras are
 * the only place the difference is visible.
 */
function pathDeclaresOwnTcp(path: RVIKPath): boolean {
  if (!path.SetNewTCP) return false;
  const raw = (path.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.['IKPath'];
  const tcp = raw?.['TCP'];
  return tcp !== undefined && tcp !== null;
}

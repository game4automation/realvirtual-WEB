// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-authoring.ts — the solve an AUTHORING caller needs (plan-773 Phase 3).
 *
 * Phase 3 adds verbs that create and move robot waypoints (`ik.path.create`,
 * `ik.target.add` / `_set` / `_remove` / `_reorder`, `ik.target.solve`).
 * Each of them has to answer the same question the interactive gizmo answers —
 * *can this robot reach this pose, and with which joint configuration* — and the
 * one way to get that wrong is to pick a frame or a solver by hand.
 *
 * ## The one thing that must not drift
 *
 * There are TWO solve frames (`rv-ik-solver.ts` header): `solveCobot` reads the
 * glTF chain frame, `solvePieper` reads Unity's mirrored frame, because the OPW
 * parameters it works from are serialized Unity values. Choosing the frame and
 * choosing the solver is ONE decision, and {@link solveFrameFor} exists so the
 * two cannot be made separately. {@link solveRobotToWorldPose} makes that
 * decision exactly once, with the same condition the two existing callers use:
 *
 * - `ik-target-edit-plugin.ts` (`solveFor` / `resolve`) — the gizmo drag;
 * - `rv-ik-path.ts` (`tryStartLinear` / the per-step LIN solve) — the replay.
 *
 * Those two are deliberately NOT rewritten to call this function: both run in a
 * per-frame hot path and are allocation-free by construction (reused tuples, a
 * reused `CobotSolveOpts`, a reused warm-start buffer), while an authoring call
 * happens once per MCP request and returns plain arrays. What this function
 * guarantees instead is that the ROUTING is the same expression, so a change to
 * the frame contract cannot reach one caller and miss another —
 * `tests/robot-path-mcp-tools.test.ts` pins the agreement on the shipped robot.
 *
 * ## Why a refusal is a sentence and a code
 *
 * "Unreachable" has five different causes and only one of them is geometry: no
 * solver at all, a free tier whose single live-solve slot is taken, no joint
 * chain, no usable OPW parameters, or a pose genuinely outside the workspace.
 * They need different answers from the caller, so {@link IkSolveOutcome} carries
 * the reason as a sentence plus — where one exists — the matching
 * `IK_PROBLEM_CODES` entry. No new code is invented here: the six that plan-772
 * wired up ARE the vocabulary.
 */

import type { Matrix4 } from 'three';
import type { RVRobotIK } from './rv-robot-ik';
import type { RVDrive } from './rv-drive';
import {
  ikSolverRegistry, solveFrameFor, targetPoseInBase,
  type CobotSolveOpts, type IKSolution, type IKSolveFrame, type IKTier,
} from './rv-ik-solver';
import { closestSolutionIndex, reachableSolutions, solutionsWithinLimits } from './rv-ik-solution-utils';
import { limitRespectingAxisPosition } from './rv-axis-angle-utils';
import type { RVIKTarget } from './rv-ik-target';
import type { RVIKPath } from './rv-ik-path';
import {
  IK_PROBLEM_CODES, clearRobotIkProblems, reportIkTargetNoAngles,
} from '../hmi/problems-store';

/** The number of axes the solvers model. Not configurable — both are 6-DOF. */
export const IK_AXIS_COUNT = 6;

/** What one authoring solve produced. */
export interface IkSolveOutcome {
  /** True only when a joint configuration came out that the caller may store. */
  reachable: boolean;
  /** Which frame the pose was expressed in — reported, never implied. */
  solveFrame: IKSolveFrame;
  /** Tier of the solver that answered (or `'none'` when none did). */
  tier: IKTier;
  /** Which solver was asked. `null` when the refusal happened before that. */
  solver: 'cobot' | 'pieper' | null;
  /** The reachable configurations, deduped, in solver branch order. */
  solutions: number[][];
  /** Index into {@link solutions} of the selected configuration, or -1. */
  selectedIndex: number;
  /** The selected configuration (degrees per axis), or null when unreachable. */
  angles: number[] | null;
  /** Why there is no configuration — a sentence, null when reachable. */
  refusal: string | null;
  /** The `IK_PROBLEM_CODES` entry for the refusal, when one applies. */
  refusalCode: string | null;
  /**
   * How many geometrically reachable configurations the JOINT LIMITS refused
   * (plan-772 Phase 5). Non-zero with `reachable: true` means the selection had
   * fewer branches to choose from than the solver offered; non-zero with
   * `reachable: false` names the cause — the pose is inside the workspace but
   * outside the rig's limits. Never silent: the report prints it either way.
   */
  limitRejected: number;
  /** Axis indices (0-based) whose limits caused a rejection, ascending. */
  limitRejectedAxes: number[];
}

/** The pose handed to the solver, for the answer (robot-local, in `solveFrame`). */
export interface IkSolvePose {
  pos: [number, number, number];
  quat: [number, number, number, number];
}

/** Reused inputs — one authoring solve at a time, like every other solve site. */
const _p3: [number, number, number] = [0, 0, 0];
const _q4: [number, number, number, number] = [0, 0, 0, 1];
const _warm = new Float64Array(IK_AXIS_COUNT);
const _cobotOpts: CobotSolveOpts = {};

/**
 * Solve `robot` to a target pose given as a WORLD matrix, and pick one
 * configuration.
 *
 * `seed` is both the warm start of the numerical cobot solve and the reference
 * the closest-selection measures against — hand in the target's stored
 * `AxisPos` when there is one (so the answer keeps the configuration the replay
 * would drive) and the current drive angles otherwise (so an interactive edit
 * stays continuous). `wantIndex`, when given, selects that branch of the
 * reachable set instead of the closest one.
 *
 * `opts.claim: false` inspects the live budget without reserving a slot, so
 * a diagnostic query cannot take the next robot's solve permission.
 *
 * Nothing is moved and nothing is written: the robot's drives are untouched and
 * so are the target's extras. Applying the result is the caller's separate,
 * deliberate step ({@link applyAnglesToDrives}).
 */
export function solveRobotToWorldPose(
  robot: RVRobotIK,
  targetMatrixWorld: Matrix4,
  seed: readonly number[] | null,
  wantIndex?: number,
  opts?: { claim?: boolean },
): IkSolveOutcome {
  const chain = robot.getJointChain();
  // ONE decision for frame AND solver (see the module header).
  const solveFrame = solveFrameFor(robot.WristType, chain);
  const tier = ikSolverRegistry.tier;
  const base: Omit<IkSolveOutcome, 'reachable' | 'refusal' | 'refusalCode'> = {
    solveFrame, tier, solver: null, solutions: [], selectedIndex: -1, angles: null,
    limitRejected: 0, limitRejectedAxes: [],
  };

  if (tier === 'none') {
    return {
      ...base,
      reachable: false,
      refusal: 'No IK solver is loaded (open-source or unlicensed build), so no pose can be solved. '
        + 'A waypoint can still be authored, but it carries no joint angles and the replay skips it.',
      refusalCode: null,
    };
  }
  // The same per-robot gate the gizmo and the LIN replay use (plan-233 §11-A3):
  // the first `maxRobots` robots get live solving, the rest replay.
  if (!(opts?.claim === false ? ikSolverRegistry.wouldGrantLiveSolve(robot.node.uuid) : ikSolverRegistry.claimLiveSolve(robot.node.uuid))) {
    return {
      ...base,
      reachable: false,
      refusal: `Tier "${tier}" allows ${ikSolverRegistry.maxRobots} live-solving robot(s) and that budget is `
        + 'already claimed by another robot in this scene. This robot can only replay baked joint angles.',
      refusalCode: null,
    };
  }

  const useCobot = robot.WristType === 'NonSpherical' && ikSolverRegistry.canSolveCobot && chain !== null;
  const opw = robot.getOpwParams();
  if (!useCobot && !opw) {
    return {
      ...base,
      reachable: false,
      refusal: 'The robot has no usable OPW parameters (no finite `a1`), so the analytic solver has no model to '
        + 'work from. ik.robot.rig derives them from the geometry; web_query("ik.robot.rigDiagnose", {path}) shows them.',
      refusalCode: IK_PROBLEM_CODES.opwUnusable,
    };
  }
  if (robot.WristType === 'NonSpherical' && !useCobot) {
    // A cobot WITHOUT the pro solver: Pieper answers, but for a wrist its model
    // cannot express. That is a weaker answer, not a refusal — say which.
    // (The chain being null is the second way in here, and it is reported by
    // the robot's own `robot-ik-chain-unresolved` entry.)
    _cobotOpts.warmStart = undefined;
  }

  // The pose, in the frame the chosen solver reads.
  robot.node.updateWorldMatrix(true, false);
  targetPoseInBase(robot.node.matrixWorld, targetMatrixWorld, _p3, _q4, solveFrame);

  const reference: number[] = [];
  for (let i = 0; i < IK_AXIS_COUNT; i++) reference.push(seed?.[i] ?? 0);

  let raw: IKSolution[] | null;
  if (useCobot) {
    for (let i = 0; i < IK_AXIS_COUNT; i++) _warm[i] = reference[i];
    _cobotOpts.opw = opw ?? undefined;
    _cobotOpts.warmStart = seed ? _warm : undefined;
    raw = ikSolverRegistry.solveCobot(chain!, _p3, _q4, _cobotOpts);
  } else {
    raw = ikSolverRegistry.solvePieper(opw!, _p3, _q4);
  }
  const solver: 'cobot' | 'pieper' = useCobot ? 'cobot' : 'pieper';

  const geometric = raw ? reachableSolutions(raw) : [];
  if (geometric.length === 0) {
    return {
      ...base,
      solver,
      reachable: false,
      refusal: 'The pose is outside this robot\'s workspace: the solver returned no reachable configuration. '
        + 'Move the waypoint closer to the robot, or check its joint limits with web_query("ik.robot.chain", {path}).',
      refusalCode: null,
    };
  }

  // Joint limits, applied BEFORE a selection happens (plan-772 Phase 5). The
  // solvers never saw the limits, so a geometrically reachable branch may still
  // be one the rig cannot hold; `reference` makes the representation search the
  // same one the replay's unwrap performs.
  const limited = solutionsWithinLimits(geometric, robot.getAxisDrives(), reference);
  const solutions = limited.kept;
  const limitRejected = limited.rejected;
  const limitRejectedAxes = limited.rejectedAxes;
  if (solutions.length === 0) {
    return {
      ...base,
      solver,
      limitRejected,
      limitRejectedAxes,
      reachable: false,
      refusal: `The pose is inside the workspace but outside this rig's joint limits: all ${limitRejected} `
        + `reachable configuration(s) violate a limit (first offending axis: A${limitRejectedAxes[0] + 1}). `
        + 'web_query("ik.robot.chain", {path}) lists the limits. Note that the analytic solver is not given the limits, so this is '
        + 'a rejection, not a search: a limit-aware solver might still find an admissible configuration here.',
      refusalCode: null,
    };
  }

  const index = wantIndex === undefined
    ? closestSolutionIndex(solutions, reference)
    : wantIndex;
  if (index < 0 || index >= solutions.length) {
    return {
      ...base,
      solver,
      solutions,
      limitRejected,
      limitRejectedAxes,
      reachable: false,
      refusal: `solutionIndex ${wantIndex} is out of range: this pose has ${solutions.length} reachable `
        + `configuration(s) within the joint limits, indices 0..${solutions.length - 1}`
        + (limitRejected > 0 ? ` (${limitRejected} further configuration(s) were refused by the limits).` : '.'),
      refusalCode: null,
    };
  }

  return {
    solveFrame, tier, solver, solutions,
    selectedIndex: index,
    angles: [...solutions[index]],
    reachable: true,
    refusal: null,
    refusalCode: null,
    limitRejected,
    limitRejectedAxes,
  };
}

/** The pose the last {@link solveRobotToWorldPose} call handed to the solver. */
export function lastSolvePose(): IkSolvePose {
  return { pos: [_p3[0], _p3[1], _p3[2]], quat: [_q4[0], _q4[1], _q4[2], _q4[3]] };
}

/**
 * Drive all axes to `angles` and show it — the gizmo's `applyAngles`, in one
 * place. `positionOverwrite` is what takes the axes out of their own motion
 * profile while an authoring pose is being previewed; the replay clears it when
 * a path starts.
 *
 * `positionOverwrite` also bypasses the drive's own `UseLimits` clamp (the
 * overwrite branch in `rv-drive.ts` returns before the clamp runs), so the
 * written value is the limit-respecting representation, not the raw solver
 * output — {@link limitRespectingAxisPosition} leaves a value the limits accept
 * untouched, so this changes nothing for an admissible configuration. A value
 * no representation can satisfy is written as-is: refusing to move at all would
 * hide the pose instead of showing it, and the selection in front of this has
 * already dropped such configurations (plan-772 Phase 5).
 */
export function applyAnglesToDrives(robot: RVRobotIK, angles: readonly number[]): void {
  const drives = robot.getAxisDrives();
  for (let i = 0; i < drives.length; i++) {
    const d: RVDrive = drives[i];
    const raw = angles[i] ?? 0;
    d.positionOverwrite = true;
    d.currentPosition = limitRespectingAxisPosition(raw, d) ?? raw;
    d.applyToNode();
  }
  robot.node.updateWorldMatrix(true, true);
}

/**
 * The live half of the pose-and-angles pair — ONE place, for every writer.
 *
 * `AxisPos` is a RAW extras field, not a schema field (`rv-ik-target.ts` reads
 * it in `init()` because the schema mapper has no number-array type), so no
 * `setField` executor and no schema re-apply ever puts it back on the instance.
 * Without this assignment the instance keeps the angles of the PREVIOUS pose
 * while the file carries the new ones — the same silent drift as a stale
 * `AxisPos` in the file, only in the other direction. It therefore belongs next
 * to EVERY AxisPos write: the MCP waypoint tools and the gizmo both call this.
 *
 * `null` angles mean "no replay for this waypoint" and write an EMPTY array,
 * never a stale one — plan-773's pose-and-angles-together rule.
 */
export function writeLiveAxisPos(target: RVIKTarget, angles: readonly number[] | null): void {
  target.AxisPos = angles ? [...angles] : [];
}

/**
 * Say out loud whether this waypoint carries usable angles — the existing
 * `robot-ik-target-no-angles` entry (`IK_PROBLEM_CODES.targetNoAngles`), reused
 * rather than respelled.
 *
 * Reusing it is the point: the Problems panel, the gizmo and the MCP answer must
 * describe the same state with the same words, and an entry whose detail says
 * "the waypoint is skipped" is exactly what an emptied `AxisPos` means.
 */
export function reportTargetReplayAngles(
  target: RVIKTarget,
  ikPath: RVIKPath,
  nodePath: string,
): void {
  clearRobotIkProblems(nodePath);
  if (target.hasReplayAngles(IK_AXIS_COUNT)) return;
  reportIkTargetNoAngles({
    nodePath,
    label: target.node.name || nodePath,
    pathLabel: ikPath.node.name,
    axisCount: IK_AXIS_COUNT,
  });
}

/** The robot's current joint vector, padded to six — the default solve seed. */
export function currentDriveAngles(robot: RVRobotIK): number[] {
  const out = robot.getAxisDrives().map((d: RVDrive) => d.currentPosition);
  while (out.length < IK_AXIS_COUNT) out.push(0);
  return out.slice(0, IK_AXIS_COUNT);
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { Quaternion, Vector3 } from 'three';
import { chainFk, positionErrorMm, orientationErrorDeg, type Vec3, type Quat } from '../../core/engine/rv-robot-fk';
import { ikSolverRegistry, solveFrameFor, targetPoseInBase, type JointChainParams, type CobotSolveOpts } from '../../core/engine/rv-ik-solver';
import { solveRobotToWorldPose, currentDriveAngles } from '../../core/engine/rv-ik-authoring';
import { linAvailable, linStartCheck, linSolveStep, linProfileStep, linMaxJump, LIN_MAX_STEP_JUMP_DEG, type RVIKPath } from '../../core/engine/rv-ik-path';
import { getDriveSpeedOverride } from '../../core/engine/rv-speed-override';
import { axisTargetPosition } from '../../core/engine/rv-axis-angle-utils';

/** One-sided Jacobi SVD avoids squaring the condition number through J^T J.
 * Columns are orthogonalized in place; no dependency or fixed robot geometry. */
export function singularValues6(matrix: number[][]): number[] {
  const a = matrix.map(row => [...row]);
  for (let sweep = 0; sweep < 60; sweep++) {
    let changed = false;
    for (let p = 0; p < 5; p++) for (let q = p + 1; q < 6; q++) {
      let aa = 0, bb = 0, ab = 0;
      for (let r = 0; r < 6; r++) { aa += a[r][p] ** 2; bb += a[r][q] ** 2; ab += a[r][p] * a[r][q]; }
      if (Math.abs(ab) <= 1e-14 * Math.sqrt(aa * bb)) continue;
      changed = true;
      const tau = (bb - aa) / (2 * ab);
      const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
      const c = 1 / Math.sqrt(1 + t * t), s = c * t;
      for (let r = 0; r < 6; r++) { const x = a[r][p], y = a[r][q]; a[r][p] = c * x - s * y; a[r][q] = s * x + c * y; }
    }
    if (!changed) break;
  }
  return Array.from({ length: 6 }, (_, c) => Math.hypot(...a.map(row => row[c]))).sort((a, b) => a - b);
}

/** Central differences: translational rows m/rad, rotational rows rad/rad.
 * Quaternion logarithm uses the shortest relative rotation in the base frame.
 * Near labels are diagnostics: wrist |q5| modulo 180 <5deg; otherwise sigmaMin
 * <1e-3, shoulder if the TCP is within 5cm of A1's line, elbow otherwise.
 * The latter names are geometric heuristics, not OPW-specific proofs. */
export function singularity(chain: JointChainParams, angles: readonly number[]) {
  const h = 1e-5, jac = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  for (let c = 0; c < 6; c++) {
    const plus = [...angles], minus = [...angles]; plus[c] += h * 180 / Math.PI; minus[c] -= h * 180 / Math.PI;
    const a = chainFk(chain, plus).tcp, b = chainFk(chain, minus).tcp;
    for (let r = 0; r < 3; r++) jac[r][c] = (a.pos[r] - b.pos[r]) / (2 * h);
    const dq = new Quaternion(...a.quat).multiply(new Quaternion(...b.quat).invert()).normalize();
    if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
    const n = Math.hypot(dq.x, dq.y, dq.z), k = n > 1e-15 ? 2 * Math.atan2(n, dq.w) / n / (2 * h) : 1 / h;
    jac[3][c] = dq.x * k; jac[4][c] = dq.y * k; jac[5][c] = dq.z * k;
  }
  const values = singularValues6(jac), wristAngleDeg = Math.abs(((angles[4] + 180) % 360 + 360) % 360 - 180);
  const fk = chainFk(chain, angles);
  const dir = new Vector3(...Array.from(chain.axisDir.slice(0, 3)) as Vec3).applyQuaternion(new Quaternion(...fk.frames[0].quat));
  const radius = new Vector3(...fk.tcp.pos).sub(new Vector3(...fk.frames[0].pos)).cross(dir).length();
  return { minSingularValue: values[0], manipulability: values.reduce((a, b) => a * b, 1), wristAngleDeg,
    near: Math.min(wristAngleDeg, 180 - wristAngleDeg) < 5 ? 'wrist' : values[0] < 1e-3 ? (radius < 0.05 ? 'shoulder' : 'elbow') : null };
}

/** Runs the exact replay profile and solver without applying any result or
 * claiming a live slot. Predecessor angles model the PTP arrival state. */
export function predictLinear(path: RVIKPath, index: number, dt: number, predecessorAngles: readonly number[]) {
  const started = performance.now();
  const unknown = (reason: string, steps = 0) => ({ mode: "unknown" as const, reason, steps, dt, speedOverride: path.SpeedOverride });
  try {
    const robot = path.robot!, target = path.targets[index], previous = path.targets[index - 1];
    const base = { steps: 0, dt, speedOverride: path.SpeedOverride, globalSpeedOverride: getDriveSpeedOverride() };
    const fallback = (reason: string, steps = 0, atFraction?: number) => ({ ...base, mode: 'ptp-fallback' as const, reason, steps, ...(atFraction === undefined ? {} : { atFraction }) });
    if (!previous || !linAvailable(robot, robot.getAxisDrives().length)) return fallback('unavailable');
    const frame = solveFrameFor(robot.WristType, robot.getJointChain());
    const p: Vec3 = [0, 0, 0], q: Quat = [0, 0, 0, 1];
    targetPoseInBase(robot.node.matrixWorld, previous.node.matrixWorld, p, q, frame);
    const startP = new Vector3(...p), startQ = new Quaternion(...q);
    targetPoseInBase(robot.node.matrixWorld, target.node.matrixWorld, p, q, frame);
    const endP = new Vector3(...p), endQ = new Quaternion(...q);
    let seed = [...predecessorAngles];
    const warm = new Float64Array(6), opts: CobotSolveOpts = {};
    const solve = (pos: Vector3, quat: Quaternion) => {
      pos.toArray(p); quat.toArray(q);
      return linSolveStep(robot, p, q, seed, warm, opts);
    };
    const reason = linStartCheck(true, solve(startP, startQ), seed);
    if (reason) return fallback(reason);
    if (!solve(endP, endQ)) return fallback('end-unreachable');
    if (!(dt > 0) || !Number.isFinite(dt) || base.globalSpeedOverride === 0) {
      return unknown('prediction-not-advancing');
    }
    const state = { distance: startP.distanceTo(endP), position: 0, speed: 0, decel: false };
    const pos = new Vector3(), quat = new Quaternion();
    for (let steps = 1; steps <= 20_000; steps++) {
      if (performance.now() - started >= 300) return unknown('prediction-budget', steps - 1);
      const fraction = linProfileStep(state, target.LinearSpeedToTarget, target.LinearAcceleration, dt, path.SpeedOverride, base.globalSpeedOverride, state);
      const angles = solve(pos.lerpVectors(startP, endP, fraction), quat.slerpQuaternions(startQ, endQ, fraction));
      if (!angles || linMaxJump(angles, seed) > LIN_MAX_STEP_JUMP_DEG) return fallback(angles ? 'step-jump' : 'step-unreachable', steps, fraction);
      seed = angles.map((a, i) => axisTargetPosition(a, { ...robot.getAxisDrives()[i], currentPosition: seed[i] }));
      if (fraction >= 1) return { ...base, mode: 'lin' as const, steps, endAngles: seed };
    }
    // A query budget is not a runtime fallback: never claim replay would switch
    // to PTP merely because a diagnostic could not finish within its work bound.
    return unknown('prediction-budget', 20_000);
  } catch {
    // A diagnostic failure in one segment must not hide the remaining targets.
    return unknown('prediction-error');
  }
}

export function checkPath(path: RVIKPath, dt: number) {
  const robot = path.robot;
  if (!robot) return { ok: false, error: 'No robot resolves for this path. Repair it with ik.robot.rigDiagnose before checking.' };
  const chain = robot.getJointChain(), drives = robot.getAxisDrives();
  const issues: { index: number; code: string; refusal: string }[] = [];
  const notes: { index: number; reason: string }[] = [];
  let predecessor = currentDriveAngles(robot);
  const targets = path.targets.map((target, index) => {
    const hasAngles = target.hasReplayAngles(6);
    const solved = solveRobotToWorldPose(robot, target.node.matrixWorld, hasAngles ? target.AxisPos : predecessor, undefined, { claim: false });
    const noSolver = solved.solver === null;
    if (noSolver) notes.push({ index, reason: solved.refusal! });
    if (!noSolver && !solved.reachable) issues.push({ index, code: solved.refusalCode ?? (solved.limitRejected ? 'joint-limits' : noSolver ? 'solver-unavailable' : 'unreachable'), refusal: solved.refusal! });
    if (!hasAngles) issues.push({ index, code: 'no-angles', refusal: 'This waypoint has no replay angles. Solve it with ik.target.solve before running the path.' });
    const angles = hasAngles ? target.AxisPos : solved.angles;
    const fk = chain && hasAngles ? chainFk(chain, target.AxisPos).tcp : null;
    const p: Vec3 = [0, 0, 0], q: Quat = [0, 0, 0, 1];
    targetPoseInBase(robot.node.matrixWorld, target.node.matrixWorld, p, q, 'chain');
    const prediction = index > 0 && target.InterpolationToTarget === 'Linear' ? predictLinear(path, index, dt, predecessor) : null;
    if (prediction?.mode === 'ptp-fallback') issues.push({ index, code: 'lin-fallback', refusal: `LIN falls back to PTP (${prediction.reason}). Adjust the waypoint or speed and check again.` });
    if (hasAngles) predecessor = prediction?.mode === 'lin' && 'endAngles' in prediction ? prediction.endAngles as number[] : [...target.AxisPos];
    return { index, name: target.node.name, hasAngles, reachable: noSolver ? null : solved.reachable,
      refusal: solved.refusal, code: solved.refusalCode ?? (solved.reachable ? null : solved.limitRejected ? 'joint-limits' : 'unreachable'),
      storedDriftMm: fk ? positionErrorMm(fk.pos, p) : null, storedDriftDeg: fk ? orientationErrorDeg(fk.quat, q) : null,
      singularity: chain && angles ? singularity(chain, angles) : null,
      nearLimit: angles ? drives.flatMap((d, i) => { const marginDeg = Math.min(angles[i] - d.LowerLimit, d.UpperLimit - angles[i]); return d.UseLimits && marginDeg < 5 ? [{ axis: i + 1, marginDeg }] : []; }) : [],
      ...(prediction ? { linSegment: { runtimePrediction: prediction.mode === 'lin'
        ? { mode: prediction.mode, steps: prediction.steps, dt: prediction.dt, speedOverride: prediction.speedOverride, globalSpeedOverride: prediction.globalSpeedOverride }
        : prediction } } : {}) };
  });
  const key = robot.node.uuid;
  return { ok: issues.length === 0, targets, issues, notes,
    liveSolve: ikSolverRegistry.hasLiveSolveClaim(key) ? 'claimed' : ikSolverRegistry.wouldGrantLiveSolve(key) ? 'available' : 'budget-exhausted',
    collision: { checked: false, reason: 'Motion sweep collision checking is not implemented; inspect the workcell before running the path.' } };
}

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVViewer } from '../../core/rv-viewer';
import type { RVIKPath } from '../../core/engine/rv-ik-path';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { RVRobotIK } from '../../core/engine/rv-robot-ik';
import { applyAnglesToDrives, currentDriveAngles, solveRobotToWorldPose } from '../../core/engine/rv-ik-authoring';
import { chainFk, positionErrorMm, orientationErrorDeg, type Vec3, type Quat } from '../../core/engine/rv-robot-fk';
import { targetPoseInBase } from '../../core/engine/rv-ik-solver';

export interface PathRunResult {
  finished: boolean;
  reachedTargets: { index: number; name: string; path: string }[];
  skipped: { index: number; name: string; reason: string }[];
  linFallbacks: { index: number; name: string; reason: string }[];
  error?: 'timeout' | 'cancelled' | 'stopped' | 'reset' | 'model-unloaded';
  waitingFor?: string;
  durationS: number;
  continues?: 'loop' | 'next-path';
}

/** Observe the replay engine rather than infer completion from polled flags.
 * In particular, LoopPath may start another run in the very same fixed step.
 */
export async function runPath(
  viewer: RVViewer, ikPath: RVIKPath, options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PathRunResult> {
  const result: PathRunResult = { finished: false, reachedTargets: [], skipped: [], linFallbacks: [], durationS: 0 };
  const startedAt = performance.now();
  const ownSeq = ikPath.runSeq + 1;
  const cleanup: (() => void)[] = [];
  let settled = false;
  try {
    return await new Promise<PathRunResult>((resolve) => {
      const finish = (error?: PathRunResult['error'], cancel = false) => {
        if (settled) return;
        settled = true;
        const waiting = ikPath.waitingFor;
        if (waiting) result.waitingFor = waiting;
        if (error) result.error = error;
        else {
          result.finished = true;
          if (ikPath.nextPath) result.continues = 'next-path';
          else if (ikPath.LoopPath) result.continues = 'loop';
        }
        // Mark settled FIRST: cancel synchronously emits the runtime event.
        if (cancel) ikPath.cancel();
        result.durationS = (performance.now() - startedAt) / 1000;
        resolve(result);
      };
      cleanup.push(ikPath.addRunListener((event) => {
        if (settled) return;
        if (event.type === 'started' && event.runSeq !== ownSeq) { finish('stopped'); return; }
        if (event.runSeq !== ownSeq) return;
        if (event.type === 'finished') { finish(); return; }
        if (event.type === 'cancelled') { finish('stopped'); return; }
        if (event.index === undefined) return;
        const target = ikPath.targets[event.index];
        const item = { index: event.index, name: target.node.name };
        if (event.type === 'target-reached') result.reachedTargets.push({
          ...item, path: viewer.registry?.getPathForNode(target.node) ?? NodeRegistry.computeNodePath(target.node),
        });
        if (event.type === 'target-skipped') result.skipped.push({ ...item, reason: event.reason! });
        if (event.type === 'lin-fallback') result.linFallbacks.push({ ...item, reason: event.reason! });
      }));
      cleanup.push(viewer.on('simulation-reset', () => finish('reset', true)));
      cleanup.push(viewer.on('model-cleared', () => finish('model-unloaded', true)));
      cleanup.push(viewer.on('model-loaded', () => finish('model-unloaded', true)));
      const abort = () => finish('cancelled', true);
      options.signal?.addEventListener('abort', abort, { once: true });
      cleanup.push(() => options.signal?.removeEventListener('abort', abort));
      const timer = setTimeout(() => finish('timeout', true), options.timeoutMs ?? 120_000);
      cleanup.push(() => clearTimeout(timer));
      if (options.signal?.aborted) finish('cancelled');
      else ikPath.startPath();
    });
  } finally {
    for (const off of cleanup.reverse()) off();
  }
}
export interface MoveTcpArgs {
  path?: string; positionJson?: string; rotationJson?: string; deltaJson?: string;
  frame?: string; solutionIndex?: number;
}

/** Transient jog uses FK as its starting pose so stale scene transforms cannot
 * change the meaning of a tool-relative displacement. Nothing is persisted. */
export function moveTcp(robot: RVRobotIK, args: MoveTcpArgs): Record<string, unknown> {
  const refuse = () => ({ reachable: false, applied: false,
    error: 'Pass either positionJson and/or rotationJson for an absolute world pose, or deltaJson with position/rotation triples and frame world/tool. Use finite meters and XYZ degrees.' });
  const absolute = args.positionJson !== undefined || args.rotationJson !== undefined;
  if (absolute === (args.deltaJson !== undefined) || (args.frame !== undefined && !['world', 'tool'].includes(args.frame))
    || (absolute && args.frame === 'tool') || (args.solutionIndex !== undefined && !Number.isInteger(args.solutionIndex))) return refuse();
  const chain = robot.getJointChain();
  if (!chain) return { applied: false, error: 'No joint chain is available. Repair the rig with ik.robot.rigDiagnose before moving the TCP.' };
  const seed = currentDriveAngles(robot);
  robot.node.updateWorldMatrix(true, false);
  const fk = chainFk(chain, seed).tcp;
  const world = new Matrix4().compose(new Vector3(...fk.pos), new Quaternion(...fk.quat), new Vector3(1, 1, 1)).premultiply(robot.node.matrixWorld);
  const p = new Vector3(), q = new Quaternion(); world.decompose(p, q, new Vector3());
  const triple = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
  const rotation = (v: Vec3) => new Quaternion().setFromEuler(new Euler(...v.map(n => n * Math.PI / 180) as Vec3, 'XYZ'));
  try {
    if (absolute) {
      if (args.positionJson !== undefined) { const v = JSON.parse(args.positionJson); if (!triple(v)) return refuse(); p.set(...v); }
      if (args.rotationJson !== undefined) { const v = JSON.parse(args.rotationJson); if (!triple(v)) return refuse(); q.copy(rotation(v)); }
    } else {
      const delta = JSON.parse(args.deltaJson!);
      if (!delta || typeof delta !== 'object' || (!('position' in delta) && !('rotation' in delta))
        || Object.keys(delta).some(k => !['position', 'rotation'].includes(k))) return refuse();
      const dp = delta.position ?? [0, 0, 0], dr = delta.rotation ?? [0, 0, 0];
      if (!triple(dp) || !triple(dr)) return refuse();
      const offset = new Vector3(...dp);
      if (args.frame === 'tool') { offset.applyQuaternion(q); q.multiply(rotation(dr)); }
      else q.premultiply(rotation(dr));
      p.add(offset);
    }
  } catch { return refuse(); }
  world.compose(p, q, new Vector3(1, 1, 1));
  const solved = solveRobotToWorldPose(robot, world, seed, args.solutionIndex);
  const result = { reachable: solved.reachable, applied: solved.reachable, axisPos: solved.angles,
    solutionCount: solved.solutions.length, solveFrame: solved.solveFrame, solver: solved.solver,
    refusal: solved.refusal, code: solved.refusalCode ?? (solved.reachable ? null : solved.limitRejected ? 'joint-limits' : 'unreachable'), tier: solved.tier };
  if (!solved.angles) return solved.solver === null ? { ...result, error: solved.refusal } : result;
  applyAnglesToDrives(robot, solved.angles);
  const actual = chainFk(chain, currentDriveAngles(robot)).tcp;
  const ref: Vec3 = [0, 0, 0], refQ: Quat = [0, 0, 0, 1];
  targetPoseInBase(robot.node.matrixWorld, world, ref, refQ, 'chain');
  return { ...result, verify: { positionErrorMm: positionErrorMm(actual.pos, ref), orientationErrorDeg: orientationErrorDeg(actual.quat, refQ) } };
}

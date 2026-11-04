// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { WasmIKSolver } from '@rv-private/ik-solver/rv-ik-solver-provider';
import { robotRunHarness } from './helpers/robot-run-harness';
import { executeDelegateValue } from './helpers/execute-value';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { McpMacroTools } from '../src/plugins/mcp-bridge/rv-mcp-macro-tools';
import { queryValue } from './helpers/query-value';
import { McpRobotTools } from '../src/plugins/mcp-bridge/rv-mcp-robot-tools';
import { checkPath, predictLinear, singularity, singularValues6 } from '../src/plugins/mcp-bridge/rv-mcp-robot-check';
import { ikSolverRegistry } from '../src/core/engine/rv-ik-solver';
import { applyAnglesToDrives, currentDriveAngles } from '../src/core/engine/rv-ik-authoring';
import { chainFk } from '../src/core/engine/rv-robot-fk';
let h: Awaited<ReturnType<typeof robotRunHarness>>;
const solver = new WasmIKSolver();
beforeAll(async () => { await solver.load(); });
afterEach(() => h?.dispose());
async function setup() {
  h = await robotRunHarness(); ikSolverRegistry.register(solver); ikSolverRegistry.resetLiveSolveClaims(); new McpRobotTools(() => h.viewer);
  for (const t of h.path.targets) t.InterpolationToTarget = 'PointToPoint';
}
function setPose(index: number, angles: number[]) {
  const robot = h.path.robot!, t = h.path.targets[index], fk = chainFk(robot.getJointChain()!, angles).tcp;
  t.AxisPos = [...angles];
  const world = new Matrix4().compose(new Vector3(...fk.pos), new Quaternion(...fk.quat), new Vector3(1, 1, 1)).premultiply(robot.node.matrixWorld);
  t.node.matrix.copy(new Matrix4().copy(t.node.parent!.matrixWorld).invert().multiply(world));
  t.node.matrix.decompose(t.node.position, t.node.quaternion, t.node.scale);
  t.node.matrixWorld.copy(world);
}
describe('read-only path check with the real CRX solver', () => {
  it('checks reachable targets, drift and failures without changing drives or claims', async () => {
    await setup();
    const normal = [25, 35, -30, 40, 45, -20];
    for (let i = 0; i < h.path.targets.length; i++) setPose(i, normal.map((a, j) => a + (j === 0 ? i : 0)));
    const before = currentDriveAngles(h.path.robot!);
    const result = JSON.parse(await queryValue(h.viewer, 'ik.path.check'));
    expect(result.ok).toBe(true); expect(result.targets.length).toBeGreaterThanOrEqual(3);
    expect(result.targets.every((t: any) => t.reachable && t.storedDriftMm < 0.001)).toBe(true);
    expect(result.collision.checked).toBe(false);
    expect(currentDriveAngles(h.path.robot!)).toEqual(before);
    expect(ikSolverRegistry.hasLiveSolveClaim(h.path.robot!.node.uuid)).toBe(false);
    h.path.targets[1].node.matrixWorld.setPosition(100, 100, 100);
    const bad = checkPath(h.path, 0.02); expect(bad.ok).toBe(false); expect(bad.issues!.some(i => i.index === 1 && i.code === 'unreachable')).toBe(true);
    expect(currentDriveAngles(h.path.robot!)).toEqual(before);
  });
  it('reports joint-limit and near-limit diagnostics without writing angles', async () => {
    await setup();
    const seed = [25, 35, -30, 40, 45, -20]; setPose(0, seed);
    const d = h.drives[0]; const saved = { UseLimits: d.UseLimits, LowerLimit: d.LowerLimit, UpperLimit: d.UpperLimit };
    try {
      d.UseLimits = true; d.LowerLimit = 24; d.UpperLimit = 27;
      expect(checkPath(h.path, 0.02).targets![0].nearLimit).toContainEqual({ axis: 1, marginDeg: 1 });
      for (const drive of h.drives) { drive.UseLimits = true; drive.LowerLimit = 0; drive.UpperLimit = 0; }
      const before = currentDriveAngles(h.path.robot!); const r = checkPath(h.path, 0.02);
      expect(r.issues!.some(i => i.code === 'joint-limits')).toBe(true);
      expect(currentDriveAngles(h.path.robot!)).toEqual(before);
    } finally { Object.assign(d, saved); }
  });
  it('does not consume a single-robot budget and reports no-solver metrics', async () => {
    await setup();
    // Registry cap can be lower than the numerical provider tier: preserve the
    // real solver while pinning the licensing budget to one slot.
    Object.defineProperty(ikSolverRegistry, 'maxRobots', { configurable: true, get: () => 1 });
    try {
      const a = h.path.robot!.node.uuid;
      expect(ikSolverRegistry.wouldGrantLiveSolve(a)).toBe(true); checkPath(h.path, 0.02);
      expect(ikSolverRegistry.claimLiveSolve('robot-B')).toBe(true);
      expect(ikSolverRegistry.wouldGrantLiveSolve(a)).toBe(false); checkPath(h.path, 0.02);
      expect(ikSolverRegistry.hasLiveSolveClaim(a)).toBe(false);
      expect(ikSolverRegistry.wouldGrantLiveSolve('robot-B')).toBe(true);
    } finally { delete (ikSolverRegistry as any).maxRobots; }
    ikSolverRegistry.register(null);
    const r = checkPath(h.path, 0.02); expect(r.targets![0].reachable).toBeNull(); expect(r.ok).toBe(true); expect(r.notes!.length).toBeGreaterThan(0); expect(r.targets![0].singularity).not.toBeNull();
  });
  it('bounds each LIN prediction and continues checking later segments', async () => {
    await setup();
    const seed = [25, 35, -30, 40, 45, -20];
    for (let i = 0; i < h.path.targets.length; i++) setPose(i, seed.map((a, j) => a + (j === 0 ? i : 0)));
    h.path.targets[1].InterpolationToTarget = 'Linear';
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(301);
    try {
      expect(predictLinear(h.path, 1, 0.02, seed)).toMatchObject({ mode: 'unknown', reason: 'prediction-budget', steps: 0 });
      clock.mockImplementationOnce(() => 0);
      const checked = checkPath(h.path, 0.02);
      expect(checked.targets).toHaveLength(h.path.targets.length);
      expect(checked.targets![1].linSegment!.runtimePrediction).toMatchObject({ mode: 'unknown', reason: 'prediction-budget' });
      clock.mockReturnValue(0);
      expect(predictLinear(h.path, 1, 1e-10, seed)).toMatchObject({ mode: 'unknown', reason: 'prediction-budget', steps: 20_000 });
      clock.mockReturnValueOnce(0).mockImplementation(() => { throw new Error('segment solver failed'); });
      expect(checkPath(h.path, 0.02).targets).toHaveLength(h.path.targets.length);
    } finally { clock.mockRestore(); }
  });
  it('detects wrist singularity and keeps a normal pose clear; SVD has known scales', async () => {
    await setup(); const chain = h.path.robot!.getJointChain()!;
    expect(singularity(chain, [25, 35, -30, 40, 0, -20]).near).toBe('wrist');
    expect(singularity(chain, [25, 35, -30, 40, 45, -20]).near).toBeNull();
    expect(singularValues6(Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => i === j ? i + 1 : 0)))).toEqual([1, 2, 3, 4, 5, 6]);
  });
  for (const speed of [0.5, 2]) it(`predicts unreachable LIN zone at speed ${speed}`, async () => {
    await setup(); const seed = [0, 0, 0, 0, 90, 0];
    setPose(0, seed); setPose(1, [180, 0, 0, 0, 90, 0]);
    const target = h.path.targets[1]; target.InterpolationToTarget = 'Linear'; target.LinearSpeedToTarget = 500;
    h.path.SpeedOverride = speed;
    const prediction = predictLinear(h.path, 1, 0.02, seed);
    expect(prediction).toMatchObject({ mode: 'ptp-fallback', reason: 'step-unreachable' });
    expect('atFraction' in prediction && prediction.atFraction).toBeGreaterThan(0);
    expect('atFraction' in prediction && prediction.atFraction).toBeLessThan(1);
    applyAnglesToDrives(h.path.robot!, seed);
    const path = h.path as any; path.NumTarget = 1;
    const fallbacks: string[] = []; const off = h.path.addRunListener(e => { if (e.type === 'lin-fallback') fallbacks.push(e.reason!); });
    expect(path.tryStartLinear(target)).toBe(true);
    let steps = 0; while (path._linActive && steps < 10000) { path.stepLinear(0.02); steps++; }
    off(); expect(steps).toBe(prediction.steps); expect(fallbacks).toEqual(['step-unreachable']);
    expect(path._linPos / path._linDist).toBeCloseTo('atFraction' in prediction ? prediction.atFraction! : -1, 12);
  });
  for (const speed of [0.5, 2]) it(`predicts the runtime LIN steps and start-jump at speed ${speed}`, async () => {
    await setup(); const seed = [25, 35, -30, 40, 45, -20];
    setPose(0, seed); setPose(1, seed.map((a, i) => a + (i === 0 ? 1 : 0)));
    const t = h.path.targets[1]; t.InterpolationToTarget = 'Linear'; h.path.SpeedOverride = speed;
    applyAnglesToDrives(h.path.robot!, seed);
    const prediction = predictLinear(h.path, 1, 0.02, seed); expect(prediction.mode).toBe('lin');
    const path = h.path as any; path.NumTarget = 1;
    expect(path.tryStartLinear(t)).toBe(true);
    let steps = 0; while (path._linActive && steps < 10000) { path.stepLinear(0.02); steps++; }
    expect(steps).toBe(prediction.steps);
    expect(predictLinear(h.path, 1, 0.02, seed.map((a, i) => a + (i === 0 ? 90 : 0)))).toMatchObject({ mode: 'ptp-fallback', reason: 'start-jump' });
  });
});


it('E1: authors three targets, checks, runs, jogs 50mm and exports with the real solver', async () => {
  await setup();
  const robot = h.path.robot!, registry = h.result.registry;
  const tools = new McpRobotTools(() => h.viewer);
  const execute = async (id: string, args: Record<string, unknown>) => {
    const r = JSON.parse(await executeDelegateValue(tools, id, args));
    expect(r.error, JSON.stringify(r)).toBeUndefined(); expect(r.ok, JSON.stringify(r)).not.toBe(false); return r;
  };
  const created = await execute('ik.path.create', { robotPath: registry.getPathForNode(robot.node), name: 'E1' });
  const pathPath = created.path;
  const path = robot.getPaths().find(p => p.node.name === 'E1')!;
  const seed = [25, 35, -30, 40, 45, -20];
  applyAnglesToDrives(robot, seed);
  for (let i = 0; i < 3; i++) {
    const fk = chainFk(robot.getJointChain()!, seed.map((a, j) => a + (j === 0 ? i : 0))).tcp;
    const world = new Matrix4().compose(new Vector3(...fk.pos), new Quaternion(...fk.quat), new Vector3(1,1,1)).premultiply(robot.node.matrixWorld);
    const position = new Vector3(), q = new Quaternion(); world.decompose(position, q, new Vector3());
    const e = new Euler().setFromQuaternion(q, 'XYZ');
    const added = await execute('ik.target.add', { pathPath, name: `E1_${i}`, positionJson: JSON.stringify(position.toArray()), rotationJson: JSON.stringify([e.x,e.y,e.z].map(v => v * 180 / Math.PI)) });
    expect(added.reachable).toBe(true);
  }
  const checked = JSON.parse(await queryValue(h.viewer, 'ik.path.check', { pathPath })); expect(checked.ok).toBe(true);
  const command = new McpCommandTools(() => h.viewer), macros = new McpMacroTools(() => h.viewer);
  const job = JSON.parse(await command.webExecute('ik.path.run', JSON.stringify({ pathPath })));
  expect(job.jobId).toBeTypeOf('string');
  await expect.poll(() => path.PathIsActive).toBe(true);
  for (let n = 0; n < 20000 && path.PathIsActive; n++) {
    path.fixedUpdate(0.02); for (const drive of h.drives) drive.update(0.02);
  }
  await expect.poll(async () => JSON.parse(await macros.webMacroStatus(job.jobId)).state).not.toBe('running');
  const status = JSON.parse(await macros.webMacroStatus(job.jobId));
  expect(status.report[0].value).toMatchObject({ finished: true, reachedTargets: expect.any(Array) });
  expect(status.report[0].value.reachedTargets).toHaveLength(3);
  const jog = await execute('ik.robot.moveTcp', { path: registry.getPathForNode(robot.node), deltaJson: '{"position":[0,0,0.05]}', frame: 'world' });
  expect(jog.applied).toBe(true);
  const exported = await execute('ik.program.export', { pathPath, vendor: 'abb-rapid', download: false });
  expect(exported.files.length).toBeGreaterThan(0);
  expect(JSON.stringify(exported.files)).toContain('MODULE');
}, 180000);

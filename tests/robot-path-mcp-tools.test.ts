// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { executeDelegateValue } from './helpers/execute-value';
import { queryValue } from './helpers/query-value';

/**
 * robot-path-mcp-tools.test.ts — plan-773 Phase 3 on the BAKED tree of the robot
 * the library actually ships.
 *
 * ## The fixture and the bake
 *
 * `public/library/Robots/FanucCRX-10iA-L.glb` is committed and public, so this
 * suite runs in every checkout — a test against `DemoRobotIK.glb` would be green
 * by absence in exactly the environment where it has to bite (plan-773 R3). It
 * loads through {@link loadBakedGLB}, which passes a `BakeRegistry` and proves
 * from the RESULT that the destructive bake ran: a waypoint authored against the
 * authoring tree would sit at a pose production never shows (plan-772 B2).
 *
 * ## The solver double, and what it is honestly worth
 *
 * {@link fkOracleProvider} and {@link robotToolsViewer} live in
 * `tests/helpers/robot-fk-oracle.ts` — they were inline here until plan-773
 * Phase 4 needed the same two pieces for the program export, and a second copy
 * of a solver double is a second thing that can drift. That file's header is
 * the explanation of what the double proves and what it does not.
 *
 * ## What this suite proves
 *
 * 1. A path and its waypoints can be built from nothing, in order, by MCP alone.
 * 2. The pose and the joint angles are written TOGETHER or not at all, in either
 *    direction. plan-773 Phase 4 pulled the gizmo onto the same rule — its drag
 *    commit used to persist the transform and keep the OLD `AxisPos` for an
 *    unreachable pose — and the two now share the write (`writeLiveAxisPos` /
 *    `reportTargetReplayAngles`, asserted at the bottom of this file).
 * 3. Unreachability is a sentence, a code and a Problems entry — never a silent
 *    `reachable: false`. Since plan-772 Phase 5 "outside the joint limits" is a
 *    sentence of its own, distinct from "outside the workspace".
 * 4. The frame is the one `solveFrameFor` picks, not one chosen by hand.
 *
 * ## The fixture since 2026-10-25
 *
 * The library robot now SHIPS rigged (RobotIK + a demo IKPath, Thomas lifted
 * plan-773 E5 for it). This suite is about rigging and authoring a robot that
 * has none of that, so it loads the same file with the shipped definition
 * stripped again (`tests/helpers/unrigged-library-crx.ts`) — same geometry,
 * same drives, no RobotIK / IKPath / IKTarget.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Euler, Matrix4, Quaternion, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { fetchUnriggedLibraryCrx } from './helpers/unrigged-library-crx';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import { McpRobotTools } from '../src/plugins/mcp-bridge/rv-mcp-robot-tools';
import type { RVRobotIK } from '../src/core/engine/rv-robot-ik';
import { ikSolverRegistry, solveFrameFor } from '../src/core/engine/rv-ik-solver';
import { chainFk, type Vec3 } from '../src/core/engine/rv-robot-fk';
import { fkOracleProvider, robotToolsViewer, type FkOracle } from './helpers/robot-fk-oracle';
import {
  applyAnglesToDrives, reportTargetReplayAngles, writeLiveAxisPos,
} from '../src/core/engine/rv-ik-authoring';
import { getProblems, resetProblemsForTests, IK_PROBLEM_CODES } from '../src/core/hmi/problems-store';

const GLB_URL = '/library/Robots/FanucCRX-10iA-L.glb';
const ROBOT_ROOT = 'FanucCRX-10iA-L';

let baked: LoadResult | null = null;
let tools: McpRobotTools;
let scene: Scene;
let robot: RVRobotIK;
let oracle: FkOracle;

beforeAll(async () => {
  resetProblemsForTests();
  const bytes = await fetchUnriggedLibraryCrx();
  scene = new Scene();
  baked = await loadBakedGLB(GLB_URL, scene, { data: bytes });
  tools = new McpRobotTools(() => robotToolsViewer(baked!, scene));

  // Phase 2 in one call — the starting point Phase 3 builds on.
  const rigged = JSON.parse(await executeDelegateValue(tools, 'ik.robot.rig', { path: ROBOT_ROOT })) as Record<string, unknown>;
  expect(rigged['ok'], `rigging failed: ${JSON.stringify(rigged['error'] ?? rigged)}`).toBe(true);
  robot = baked!.registry.getAll<RVRobotIK>('RobotIK')[0].instance;

  oracle = fkOracleProvider(robot.getJointChain()!);
  ikSolverRegistry.register(oracle);
  ikSolverRegistry.resetLiveSolveClaims();
}, 180_000);

afterAll(() => {
  ikSolverRegistry.register(null);
  ikSolverRegistry.resetLiveSolveClaims();
  resetProblemsForTests();
});

/** Parse a tool answer, failing loudly on the `{error}` shape. */
function ok(json: string): Record<string, unknown> {
  const v = JSON.parse(json) as Record<string, unknown>;
  expect(v['error'], `tool answered with an error: ${String(v['error'])}`).toBeUndefined();
  return v;
}

/** The WORLD pose a joint vector puts the TCP at — what a caller would type. */
function worldPoseOfAngles(angles: readonly number[]): { positionJson: string; rotationJson: string } {
  const chain = robot.getJointChain()!;
  const fk = chainFk(chain, angles);
  // The chain works robot-locally in the glTF frame; a caller types WORLD.
  robot.node.updateWorldMatrix(true, false);
  const local = new Matrix4().compose(
    new Vector3(fk.tcp.pos[0], fk.tcp.pos[1], fk.tcp.pos[2]),
    new Quaternion(fk.tcp.quat[0], fk.tcp.quat[1], fk.tcp.quat[2], fk.tcp.quat[3]),
    new Vector3(1, 1, 1),
  );
  const world = new Matrix4().copy(robot.node.matrixWorld).multiply(local);
  const p = new Vector3();
  const q = new Quaternion();
  const s = new Vector3();
  world.decompose(p, q, s);
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  const r = 180 / Math.PI;
  return {
    positionJson: JSON.stringify([p.x, p.y, p.z]),
    rotationJson: JSON.stringify([e.x * r, e.y * r, e.z * r]),
  };
}

/** The live world position of a node, in meters. */
function worldPosOf(path: string): Vec3 {
  const n = baked!.registry.getNode(path)!;
  const m = n.matrixWorld.elements;
  return [m[12], m[13], m[14]];
}

let ikPathPath = '';

describe('web_robot_path_create puts the path where the robot can see it (F8)', () => {
  it('creates the IKPath UNDER the robot and reads it back off the scene', async () => {
    const r = ok(await executeDelegateValue(tools, 'ik.path.create', { robotPath: ROBOT_ROOT, name: 'Program1' }));
    expect(r['ok']).toBe(true);
    expect(r['boundToRobot']).toBe(true);
    expect(r['name']).toBe('Program1');
    expect(r['targets']).toBe(0);
    expect(r['axesAvailable']).toBe(6);
    ikPathPath = String(r['path']);
    expect(ikPathPath.endsWith('/Program1')).toBe(true);
    // The robot's own view is the authority, not the answer.
    expect(robot.getPaths().map((p) => p.node.name)).toContain('Program1');
  });

  it('says where the write landed instead of implying it is saved', async () => {
    const r = ok(await queryValue(robotToolsViewer(baked!, scene), 'ik.path.inspect', { pathPath: 'Program1' }));
    expect(r['targetCount']).toBe(0);
    // No scene document in this suite: the answer must SAY live-only.
    const created = ok(await executeDelegateValue(tools, 'ik.path.create', { robotPath: ROBOT_ROOT, name: 'Scratch' }));
    expect(created['persistence']).toBe('none');
    expect(String(created['persistenceNote'])).toMatch(/lost on reload|Nothing was persisted/);
  });

  it('refuses an unknown robot and names the ones it has', async () => {
    const bad = JSON.parse(await executeDelegateValue(tools, 'ik.path.create', { robotPath: 'NoSuchRobot' })) as Record<string, unknown>;
    expect(String(bad['error'])).toContain('NoSuchRobot');
  });
});

describe('web_robot_target_add solves at once and reports reachability (F9, F13)', () => {
  it('adds the first waypoint at the robot\'s current TCP, with angles', async () => {
    // The robot stands at its home pose, so its own TCP pose is reachable by
    // construction — the default of this tool is never a guess.
    const home = robot.getAxisDrives().map((d) => d.currentPosition);
    oracle.teach(home);
    const r = ok(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1' }));
    expect(r['created']).toBe(true);
    expect(r['reachable']).toBe(true);
    expect(r['index']).toBe(0);
    // The frame is the one solveFrameFor picks — reported, not implied.
    expect(r['solveFrame']).toBe(solveFrameFor(robot.WristType, robot.getJointChain()));
    expect(r['solveFrame']).toBe('chain');
    expect(r['solver']).toBe('cobot');
    const axis = r['axisPos'] as number[];
    expect(axis.length).toBe(6);
    // …and the stored angles ARE the ones the double answered with.
    for (let i = 0; i < 6; i++) expect(axis[i]).toBeCloseTo(home[i], 1);
  });

  it('places a second waypoint at a pose typed in world meters and degrees', async () => {
    const angles = [20, -25, 15, 10, 40, -30];
    oracle.teach(angles);
    const pose = worldPoseOfAngles(angles);
    const r = ok(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: pose.positionJson, rotationJson: pose.rotationJson }));
    expect(r['reachable']).toBe(true);
    expect(r['index']).toBe(1);
    const axis = r['axisPos'] as number[];
    for (let i = 0; i < 6; i++) expect(axis[i]).toBeCloseTo(angles[i], 1);
    // The node really sits where the caller asked.
    const want = JSON.parse(pose.positionJson) as number[];
    const got = worldPosOf(String(r['path']));
    expect(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2])).toBeLessThan(1e-4);
  });

  it('creates NOTHING for an unreachable pose, and says why', async () => {
    const before = robot.getPaths()[0].targets.length;
    const r = JSON.parse(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: '[9,9,9]' })) as Record<string, unknown>;
    expect(r['ok']).toBe(false);
    expect(r['created']).toBe(false);
    expect(r['reachable']).toBe(false);
    expect(String(r['refusal'])).toMatch(/workspace|reachable configuration/i);
    expect(String(r['hint'])).toMatch(/written together or not at all/);
    expect(robot.getPaths()[0].targets.length).toBe(before);
  });

  it('stores an unreachable waypoint with EMPTY AxisPos and a visible problem', async () => {
    const r = ok(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: '[8,8,8]', rotationJson: undefined, index: undefined, name: 'Unreachable1', fieldsJson: undefined, allowUnreachable: true }));
    expect(r['created']).toBe(true);
    expect(r['reachable']).toBe(false);
    expect(r['axisPos']).toEqual([]);
    expect(String(r['warning'])).toMatch(/WITHOUT joint angles/);
    // The existing code, not a seventh spelling (plan-772 vocabulary).
    const problems = r['problems'] as Array<{ code: string }>;
    expect(problems.map((p) => p.code)).toContain(IK_PROBLEM_CODES.targetNoAngles);
    const panel = getProblems().filter((p) => p.code === IK_PROBLEM_CODES.targetNoAngles);
    expect(panel.length).toBeGreaterThan(0);
    // Clean up so the later order assertions read simply.
    ok(await executeDelegateValue(tools, 'ik.target.remove', { targetPath: 'Unreachable1' }));
  });

  it('validates field names instead of writing a typo into the GLB', async () => {
    const bad = JSON.parse(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: undefined, rotationJson: undefined, index: undefined, name: undefined, fieldsJson: '{"Interpolation":"Linear"}' })) as Record<string, unknown>;
    expect(String(bad['error'])).toContain('not an IKTarget field');
    const axisPos = JSON.parse(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: undefined, rotationJson: undefined, index: undefined, name: undefined, fieldsJson: '{"AxisPos":[1,2,3,4,5,6]}' })) as Record<string, unknown>;
    expect(String(axisPos['error'])).toContain('solved, not typed');
  });

  it('takes the fields it does know', async () => {
    const angles = [5, -10, 5, 0, 20, 0];
    oracle.teach(angles);
    const pose = worldPoseOfAngles(angles);
    const r = ok(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: pose.positionJson, rotationJson: pose.rotationJson, index: undefined, name: 'Linear1', fieldsJson: '{"InterpolationToTarget":"Linear","BlendRadius":40,"EnableBlending":true}' }));
    expect(r['reachable']).toBe(true);
    const row = (ok(await queryValue(robotToolsViewer(baked!, scene), 'ik.path.inspect', { pathPath: 'Program1' }))['targets'] as Array<Record<string, unknown>>)
      .find((t) => t['name'] === 'Linear1')!;
    expect(row['interpolation']).toBe('Linear');
    expect(row['blendRadius']).toBe(40);
    expect(row['enableBlending']).toBe(true);
  });
});

describe('web_robot_target_set never leaves a pose next to foreign angles (F10)', () => {
  it('writes NOTHING — not even the transform — for an unreachable pose', async () => {
    const path = `${ikPathPath}/Target_1`;
    const poseBefore = worldPosOf(path);
    const target = robot.getPaths()[0].targets[0];
    const axisBefore = [...target.AxisPos];

    const r = JSON.parse(await executeDelegateValue(tools, 'ik.target.set', { targetPath: path, positionJson: '[7,7,7]' })) as Record<string, unknown>;
    expect(r['ok']).toBe(false);
    expect(r['changed']).toBe(false);
    expect(String(r['hint'])).toMatch(/NOTHING was written/);
    // THE assertion of this file: the gizmo's `afterDragCommit` persists the
    // transform here and keeps the old AxisPos (ik-target-edit-plugin.ts).
    const poseAfter = worldPosOf(path);
    expect(poseAfter[0]).toBeCloseTo(poseBefore[0], 9);
    expect(poseAfter[1]).toBeCloseTo(poseBefore[1], 9);
    expect(poseAfter[2]).toBeCloseTo(poseBefore[2], 9);
    expect(target.AxisPos).toEqual(axisBefore);
  });

  it('moves the pose AND the angles together when the new pose solves', async () => {
    const path = `${ikPathPath}/Target_1`;
    const angles = [-15, -30, 20, 5, 35, 15];
    oracle.teach(angles);
    const pose = worldPoseOfAngles(angles);
    const r = ok(await executeDelegateValue(tools, 'ik.target.set', { targetPath: path, positionJson: pose.positionJson, rotationJson: pose.rotationJson }));
    expect(r['changed']).toBe(true);
    expect(r['reachable']).toBe(true);
    expect(r['movedPose']).toBe(true);
    const stored = r['axisPos'] as number[];
    for (let i = 0; i < 6; i++) expect(stored[i]).toBeCloseTo(angles[i], 1);
    const want = JSON.parse(pose.positionJson) as number[];
    const got = worldPosOf(path);
    expect(Math.hypot(got[0] - want[0], got[1] - want[1], got[2] - want[2])).toBeLessThan(1e-4);
  });

  it('with allowUnreachable moves the pose and EMPTIES the angles', async () => {
    const path = `${ikPathPath}/Target_1`;
    const r = ok(await executeDelegateValue(tools, 'ik.target.set', { targetPath: path, positionJson: '[6,6,6]', rotationJson: undefined, fieldsJson: undefined, allowUnreachable: true }));
    expect(r['changed']).toBe(true);
    expect(r['reachable']).toBe(false);
    expect(r['axisPos']).toEqual([]);
    expect(String(r['warning'])).toMatch(/EMPTIED/);
    const got = worldPosOf(path);
    expect(got[0]).toBeCloseTo(6, 6);
    // The waypoint is now visibly angle-less, with the existing code.
    const problems = r['problems'] as Array<{ code: string }>;
    expect(problems.map((p) => p.code)).toContain(IK_PROBLEM_CODES.targetNoAngles);
  });

  it('changes fields alone without touching the pose', async () => {
    const path = `${ikPathPath}/Target_2`;
    const before = worldPosOf(path);
    const r = ok(await executeDelegateValue(tools, 'ik.target.set', { targetPath: path, positionJson: undefined, rotationJson: undefined, fieldsJson: '{"WaitForSeconds":2.5}' }));
    expect(r['movedPose']).toBe(false);
    expect(r['fieldsWritten']).toEqual(['WaitForSeconds']);
    const after = worldPosOf(path);
    expect(after[0]).toBeCloseTo(before[0], 9);
  });

  it('refuses a call that asks for nothing', async () => {
    const r = JSON.parse(await executeDelegateValue(tools, 'ik.target.set', { targetPath: `${ikPathPath}/Target_2` })) as Record<string, unknown>;
    expect(String(r['error'])).toContain('Nothing to change');
  });
});

describe('web_robot_solve_target lists, selects, applies (F12)', () => {
  it('drives the robot to a waypoint and proves it with forward kinematics', async () => {
    const angles = [10, -40, 30, 0, 25, 5];
    oracle.teach(angles);
    const pose = worldPoseOfAngles(angles);
    const added = ok(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: pose.positionJson, rotationJson: pose.rotationJson, index: undefined, name: 'Solve1' }));
    const path = String(added['path']);

    const r = ok(await executeDelegateValue(tools, 'ik.target.solve', { targetPath: path }));
    expect(r['applied']).toBe(true);
    expect(r['reachable']).toBe(true);
    expect(r['selectedSolution']).toBe(0);
    const verify = r['verify'] as Record<string, number>;
    expect(verify['positionErrorMm']).toBeLessThan(1);
    expect(verify['orientationErrorDeg']).toBeLessThan(0.1);
    // The axes really moved there.
    const live = robot.getAxisDrives().map((d) => d.currentPosition);
    for (let i = 0; i < 6; i++) expect(live[i]).toBeCloseTo(angles[i], 1);
  });

  it('applies the configuration a caller names, and refuses one that is not there', async () => {
    const angles = [0, -20, 25, 0, 15, 0];
    const alternative = [0, -20, 25, 180, -15, 180];
    oracle.teach(angles, alternative);
    const pose = worldPoseOfAngles(angles);
    const added = ok(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: pose.positionJson, rotationJson: pose.rotationJson, index: undefined, name: 'Solve2' }));
    const path = String(added['path']);

    const listed = ok(await executeDelegateValue(tools, 'ik.target.solve', { targetPath: path }));
    expect(listed['solutionCount']).toBe(2);
    const second = ok(await executeDelegateValue(tools, 'ik.target.solve', { targetPath: path, solutionIndex: 1 }));
    expect(second['selectedSolution']).toBe(1);
    // The double's second branch is synthetic (see the module header), so only
    // the bookkeeping is asserted here: the named configuration is the one
    // stored and the one the axes hold.
    const stored = second['axisPos'] as number[];
    for (let i = 0; i < 6; i++) expect(stored[i]).toBeCloseTo(alternative[i], 1);

    const bad = JSON.parse(await executeDelegateValue(tools, 'ik.target.solve', { targetPath: path, solutionIndex: 7 })) as Record<string, unknown>;
    expect(bad['applied']).toBe(false);
    expect(String(bad['refusal'])).toContain('out of range');
  });

  it('leaves the stored angles alone when the pose does not solve', async () => {
    const added = ok(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: '[5,5,5]', rotationJson: undefined, index: undefined, name: 'Hopeless', fieldsJson: undefined, allowUnreachable: true }));
    const path = String(added['path']);
    const angles = [1, 2, 3, 4, 5, 6];
    // Put a known AxisPos there by hand, so "unchanged" is observable.
    const t = robot.getPaths()[0].targets.find((x) => x.node.name === 'Hopeless')!;
    t.AxisPos = [...angles];
    const r = JSON.parse(await executeDelegateValue(tools, 'ik.target.solve', { targetPath: path })) as Record<string, unknown>;
    expect(r['applied']).toBe(false);
    expect(String(r['hint'])).toMatch(/was not moved and AxisPos was left as it is/);
    expect(t.AxisPos).toEqual(angles);
    ok(await executeDelegateValue(tools, 'ik.target.remove', { targetPath: 'Hopeless' }));
  });
});

describe('web_robot_target_reorder and _remove keep the order honest (F11)', () => {
  it('lists the waypoints in path order with the index the other tools take', async () => {
    const r = ok(await queryValue(robotToolsViewer(baked!, scene), 'ik.path.inspect', { pathPath: 'Program1' }));
    const rows = r['targets'] as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.map((t) => t['index'])).toEqual(rows.map((_t, i) => i));
    // Every reference resolves — that is the precondition reorder checks.
    expect(r['storedRefs']).toBe(r['targetCount']);
    // The stored angles are measured against the node pose, not assumed.
    const first = rows.find((t) => t['replayable'] === true)!;
    const reach = first['storedAnglesReach'] as Record<string, number>;
    expect(reach['positionErrorMm']).toBeLessThan(1);
  });

  it('moves a waypoint and the order follows in the live path', async () => {
    const before = (ok(await queryValue(robotToolsViewer(baked!, scene), 'ik.path.inspect', { pathPath: 'Program1' }))['targets'] as Array<Record<string, unknown>>)
      .map((t) => String(t['name']));
    const r = ok(await executeDelegateValue(tools, 'ik.target.reorder', { fromIndex: 0, toIndex: 2, pathPath: 'Program1' }));
    expect(r['moved']).toBe(true);
    const after = (r['order'] as Array<Record<string, unknown>>).map((t) => String(t['name']));
    const expected = [...before];
    const [m] = expected.splice(0, 1);
    expected.splice(2, 0, m);
    expect(after).toEqual(expected);
    expect(robot.getPaths()[0].targets.map((t) => t.node.name)).toEqual(expected);
  });

  it('refuses an index outside the list', async () => {
    const r = JSON.parse(await executeDelegateValue(tools, 'ik.target.reorder', { fromIndex: 0, toIndex: 99, pathPath: 'Program1' })) as Record<string, unknown>;
    expect(String(r['error'])).toMatch(/must lie in 0\.\./);
  });

  it('removes a waypoint it created, node and reference', async () => {
    const path = `${ikPathPath}/Solve2`;
    const before = robot.getPaths()[0].targets.length;
    const r = ok(await executeDelegateValue(tools, 'ik.target.remove', { targetPath: path }));
    expect(r['nodeDeleted']).toBe(true);
    expect(robot.getPaths()[0].targets.length).toBe(before - 1);
    expect(baked!.registry.getNode(path)).toBeNull();
    expect(robot.getPaths()[0].targets.map((t) => t.node.name)).not.toContain('Solve2');
  });

  it('refuses to remove something that is not a waypoint of this model', async () => {
    const r = JSON.parse(await executeDelegateValue(tools, 'ik.target.remove', { targetPath: 'NoSuchTarget' })) as Record<string, unknown>;
    expect(String(r['error'])).toContain('NoSuchTarget');
  });
});

describe('the tier is answered, never worked around (F7)', () => {
  it('refuses to solve without a solver and still allows the waypoint', async () => {
    ikSolverRegistry.register(null);
    try {
      const r = JSON.parse(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: undefined, rotationJson: undefined, index: undefined, name: 'NoSolver' })) as Record<string, unknown>;
      expect(r['ok']).toBe(false);
      expect(String(r['refusal'])).toMatch(/No IK solver is loaded/);
      expect(r['tier']).toBe('none');
      // …and with allowUnreachable the waypoint is authored anyway, angle-less.
      const forced = ok(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: undefined, rotationJson: undefined, index: undefined, name: 'NoSolver', fieldsJson: undefined, allowUnreachable: true }));
      expect(forced['created']).toBe(true);
      expect(forced['axisPos']).toEqual([]);
      ok(await executeDelegateValue(tools, 'ik.target.remove', { targetPath: 'NoSolver' }));
    } finally {
      ikSolverRegistry.register(oracle);
      ikSolverRegistry.resetLiveSolveClaims();
    }
  });
});

/**
 * plan-772 Phase 5 on the real rig: the SHIPPED robot's axes are wide, so the
 * limits are tightened here to the shape that actually bites (the IRB has A3 at
 * −60…+65). `tests/ik-joint-limit-selection.test.ts` pins the selection logic
 * itself; what this proves is that the limits of the LIVE drives are the ones
 * consulted, and that the MCP answer says what was discarded.
 */
describe('joint limits gate the authoring solve (plan-772 Phase 5)', () => {
  /** Narrow one axis of the live rig, restore it afterwards. */
  async function withTightAxis<T>(
    index: number, lower: number, upper: number, body: () => Promise<T>,
  ): Promise<T> {
    const d = robot.getAxisDrives()[index];
    const saved = { use: d.UseLimits, lo: d.LowerLimit, hi: d.UpperLimit };
    d.UseLimits = true; d.LowerLimit = lower; d.UpperLimit = upper;
    try { return await body(); } finally {
      d.UseLimits = saved.use; d.LowerLimit = saved.lo; d.UpperLimit = saved.hi;
    }
  }

  it('refuses a pose whose ONLY configuration violates a limit, and names the axis', async () => {
    const angles = [0, -20, 120, 0, 30, 0]; // A3 = 120°
    oracle.teach(angles);
    const pose = worldPoseOfAngles(angles);
    const before = robot.getPaths()[0].targets.length;
    const r = await withTightAxis(2, -60, 65, async () =>
      JSON.parse(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: pose.positionJson, rotationJson: pose.rotationJson, index: undefined, name: 'LimitRefused' })) as Record<string, unknown>);
    expect(r['ok']).toBe(false);
    expect(r['created']).toBe(false);
    expect(r['reachable']).toBe(false);
    // Not "outside the workspace" — the distinction is the whole point.
    expect(String(r['refusal'])).toMatch(/outside this rig's joint limits/);
    expect(String(r['refusal'])).toContain('A3');
    expect(String(r['refusal'])).toMatch(/rejection, not a search/);
    expect(robot.getPaths()[0].targets.length).toBe(before);
  });

  it('accepts the SAME pose once the limit allows it', async () => {
    const angles = [0, -20, 120, 0, 30, 0];
    const pose = worldPoseOfAngles(angles);
    const r = ok(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: pose.positionJson, rotationJson: pose.rotationJson, index: undefined, name: 'LimitOk' }));
    expect(r['reachable']).toBe(true);
    expect(r['limitRejectedSolutions']).toBeUndefined(); // nothing was discarded
    ok(await executeDelegateValue(tools, 'ik.target.remove', { targetPath: 'LimitOk' }));
  });

  it('reports the configurations it discarded when an admissible one remains', async () => {
    // Two branches for one pose; only the alternative survives a tight A3. The
    // joint vector is fresh: the oracle answers from its FIRST matching sample,
    // so reusing a pose taught above would hand back its single-branch answer.
    const angles = [0, -25, 125, 0, 35, 0];
    const alternative = [0, -25, 45, 0, 35, 0];
    oracle.teach(angles, alternative);
    const pose = worldPoseOfAngles(angles);
    const r = await withTightAxis(2, -60, 65, async () =>
      ok(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: pose.positionJson, rotationJson: pose.rotationJson, index: undefined, name: 'LimitPicked' })));
    expect(r['reachable']).toBe(true);
    expect(r['solutionCount']).toBe(1);               // what SURVIVED the limits
    expect(r['limitRejectedSolutions']).toBe(1);      // and what did not
    expect(r['limitRejectedAxes']).toEqual(['A3']);
    expect(String(r['limitNote'])).toMatch(/joint limit refuses them/);
    const axis = r['axisPos'] as number[];
    expect(axis[2]).toBeCloseTo(45, 1);               // the admissible branch
    ok(await executeDelegateValue(tools, 'ik.target.remove', { targetPath: 'LimitPicked' }));
  });

  it('keeps the drives inside their limits even though positionOverwrite skips the clamp', async () => {
    // A 350° solver result is physically −10°, which a −60…+65 axis allows.
    // `applyAnglesToDrives` writes through `positionOverwrite`, which returns
    // before the drive's own UseLimits clamp — so the conversion has to happen
    // on the way in, or the axis would sit at 350° outside its window.
    const d = robot.getAxisDrives()[2];
    await withTightAxis(2, -60, 65, async () => {
      applyAnglesToDrives(robot, [0, 0, 350, 0, 0, 0]);
      expect(d.currentPosition).toBeCloseTo(-10, 6);
      // A value the limits already accept is written UNCHANGED (no re-centering).
      applyAnglesToDrives(robot, [0, 0, 40, 0, 0, 0]);
      expect(d.currentPosition).toBeCloseTo(40, 6);
    });
  });
});

/**
 * plan-773 Phase 4: the two writes the GIZMO now shares with this route.
 *
 * The plugin's drag commit (`ik-target-edit-plugin.ts`, `commitMovedPose`) calls
 * exactly these, so a second implementation of the raw-field instance write
 * cannot drift away from the one the MCP tools use.
 */
describe('writeLiveAxisPos / reportTargetReplayAngles are the shared pair', () => {
  it('empties the LIVE instance for an unreachable pose instead of keeping stale angles', async () => {
    const angles = [0, -15, 20, 0, 25, 0];
    oracle.teach(angles);
    const pose = worldPoseOfAngles(angles);
    const added = ok(await executeDelegateValue(tools, 'ik.target.add', { pathPath: 'Program1', positionJson: pose.positionJson, rotationJson: pose.rotationJson, index: undefined, name: 'SharedPair' }));
    const nodePath = String(added['path']);
    const ikPath = robot.getPaths()[0];
    const target = ikPath.targets.find((t) => t.node.name === 'SharedPair')!;
    expect(target.AxisPos.length).toBe(6);
    expect(target.hasReplayAngles(6)).toBe(true);

    writeLiveAxisPos(target, null);
    expect(target.AxisPos).toEqual([]);
    expect(target.hasReplayAngles(6)).toBe(false);

    reportTargetReplayAngles(target, ikPath, nodePath);
    const raised = getProblems().filter(
      (p) => p.code === IK_PROBLEM_CODES.targetNoAngles && p.id.includes(nodePath),
    );
    expect(raised.length).toBe(1);

    // …and it clears again once angles are back.
    writeLiveAxisPos(target, angles);
    reportTargetReplayAngles(target, ikPath, nodePath);
    expect(getProblems().filter(
      (p) => p.code === IK_PROBLEM_CODES.targetNoAngles && p.id.includes(nodePath),
    ).length).toBe(0);
    ok(await executeDelegateValue(tools, 'ik.target.remove', { targetPath: 'SharedPair' }));
  });
});


describe('raw reference removal (plan-2214 T10)', () => {
  it('removes unresolved raw entries and rebuilds the filtered runtime list', async () => {
    const path = robot.getPaths()[0];
    const raw = path.node.userData.realvirtual.IKPath;
    const saved = [...raw.Path];
    const names = path.targets.map(t => t.node.name);
    raw.Path = [saved[0], { type: 'ComponentReference', path: 'Missing', componentType: 'IKTarget' }, ...saved.slice(1)];
    path.rebuildTargets(baked!.registry);
    expect(path.targets.map(t => t.node.name)).toEqual(names);
    const r = ok(await executeDelegateValue(tools, 'ik.target.remove', { pathPath: 'Program1', index: 1 }));
    expect(r.removedIndex).toBe(1);
    expect(rawPath()).toEqual(saved);
    expect(path.targets.map(t => t.node.name)).toEqual(names);
    function rawPath() { return path.node.userData.realvirtual.IKPath.Path; }
  });
  it('refuses mixed, incomplete and fractional index forms without changing the list', async () => {
    const before = JSON.stringify(robot.getPaths()[0].node.userData.realvirtual.IKPath.Path);
    for (const args of [{ targetPath: 'Target_1', pathPath: 'Program1', index: 0 }, { pathPath: 'Program1' }, { pathPath: 'Program1', index: 0.5 }, {}]) {
      const r = JSON.parse(await executeDelegateValue(tools, 'ik.target.remove', args));
      expect(r.error).toBeTruthy();
      expect(JSON.stringify(robot.getPaths()[0].node.userData.realvirtual.IKPath.Path)).toBe(before);
    }
  });
});

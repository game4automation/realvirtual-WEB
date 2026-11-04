// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * robot-export-baked-pose.test.ts — plan-773 Phase 4: the converter, on the
 * BAKED tree of the robot the library actually ships.
 *
 * ## What this suite is, and what it is not
 *
 * plan-773 §8 T3 describes this file as a comparison against
 * `tests/fixtures/robot-ik-export.reference.json` — Unity reference poses next
 * to a committed `robot-ik-export.glb`. **That fixture was never built**, and
 * deliberately: Phase 0 decided (and recorded) that the committed, public
 * `FanucCRX-10iA-L.glb` is the fixture, because a second synthetic rig next to
 * the one robot everybody gets would be ballast, and because a test against the
 * private `DemoRobotIK.glb` is green by absence in exactly the checkout where it
 * has to bite (R3).
 *
 * The consequence has to be said plainly: that robot carries **no** `RobotIK`,
 * no baked `AxisPos` and no `IKPath`, so there is no Unity-exported reference
 * pose to compare against, and this suite cannot be the Unity parity proof.
 *
 * **The Unity parity proof is `tests/robot-program-model.node.test.ts`** — the
 * same fixed vectors as the four Unity feature tests, which is the assurance
 * plan-773 §2.3 and §8 T1 name against R4. This suite proves the other half,
 * which no vector test can: that the converter, run through the real baked
 * tree, reads the waypoint TRANSFORM, converts the frame the one documented
 * way, scales once, emits one instruction per waypoint and refuses when the
 * licence gate says so.
 *
 * ## The independent recomputation
 *
 * Every Cartesian assertion below recomputes the expected pose in the test
 * from the scene's own world matrices, by a different route than the converter
 * takes (`Matrix4` composition here, `targetPoseInBase` there). A shared helper
 * would make both sides agree on a shared mistake; two routes to the same
 * number do not.
 *
 * The negative probe matters as much as the positive one: an export that
 * skipped the glTF→Unity mirror would still produce plausible millimetres, just
 * mirrored. `does NOT emit the unmirrored glTF position` is the assertion that
 * would go red for it.
 *
 * ## The fixture since 2026-10-25
 *
 * The library robot now SHIPS rigged (RobotIK + a demo IKPath, Thomas lifted
 * plan-773 E5 for it). This suite is about rigging and authoring a robot that
 * has none of that, so it loads the same file with the shipped definition
 * stripped again (`tests/helpers/unrigged-library-crx.ts`) — same geometry,
 * same drives, no RobotIK / IKPath / IKTarget.
 */

import { executeDelegateValue } from './helpers/execute-value';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Matrix4, Quaternion, Scene, Vector3, Euler } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { fetchUnriggedLibraryCrx } from './helpers/unrigged-library-crx';
import { fkOracleProvider, robotToolsViewer, type FkOracle } from './helpers/robot-fk-oracle';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import {
  McpRobotTools, ensureIkCommandsRegistered, IK_PROGRAM_EXPORT_COMMAND,
} from '../src/plugins/mcp-bridge/rv-mcp-robot-tools';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import type { RVRobotIK } from '../src/core/engine/rv-robot-ik';
import type { RVIKPath } from '../src/core/engine/rv-ik-path';
import type { RVIKTarget } from '../src/core/engine/rv-ik-target';
import { ikSolverRegistry } from '../src/core/engine/rv-ik-solver';
import { chainFk } from '../src/core/engine/rv-robot-fk';
import { getAppConfig, setAppConfig, type RVAppConfig } from '../src/core/rv-app-config';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';
import {
  ikPathToProgram, FK_TOLERANCE_DEG, FK_TOLERANCE_MM, resetAxisCorrectionWarningForTests,
} from '../src/core/robot-program/rv-ik-path-to-program';
import { robotProgramDelivery, robotProgramExportGate } from '../src/core/robot-program/rv-robot-program-gate';
import { ROBOT_PROGRAM_DISCLAIMER, type RobotProgram } from '../src/core/robot-program/rv-robot-program';
import { loadRobotPostProcessor } from '../src/core/robot-program/rv-robot-vendors';

const GLB_URL = '/library/Robots/FanucCRX-10iA-L.glb';
const ROBOT_ROOT = 'FanucCRX-10iA-L';
const PATH_NAME = 'ExportProgram';

/** The three waypoints of the program, as joint vectors the double is taught. */
const WAYPOINTS = [
  [0, -20, 10, 0, 30, 0],
  [25, -35, 20, 12, 45, -18],
  [-15, -10, 5, -8, 20, 40],
];

let baked: LoadResult | null = null;
let tools: McpRobotTools;
let scene: Scene;
let robot: RVRobotIK;
let oracle: FkOracle;
let ikPath: RVIKPath;
let appConfigBefore: RVAppConfig;

beforeAll(async () => {
  resetProblemsForTests();
  appConfigBefore = getAppConfig();
  // plan-773 E3: the export runs in a hosted delivery only. A browser test is
  // served by Vite and would already count as `'dev'`; saying `hosted` here
  // makes the suite independent of how it happens to be served.
  setAppConfig({ ...appConfigBefore, hostedDeploy: true });

  const bytes = await fetchUnriggedLibraryCrx();
  scene = new Scene();
  baked = await loadBakedGLB(GLB_URL, scene, { data: bytes });
  tools = new McpRobotTools(() => robotToolsViewer(baked!, scene));

  const rigged = JSON.parse(await executeDelegateValue(tools, 'ik.robot.rig', { path: ROBOT_ROOT })) as Record<string, unknown>;
  expect(rigged['ok'], `rigging failed: ${JSON.stringify(rigged['error'] ?? rigged)}`).toBe(true);
  robot = baked!.registry.getAll<RVRobotIK>('RobotIK')[0].instance;

  oracle = fkOracleProvider(robot.getJointChain()!);
  ikSolverRegistry.register(oracle);
  ikSolverRegistry.resetLiveSolveClaims();

  const created = JSON.parse(await executeDelegateValue(tools, 'ik.path.create', { robotPath: ROBOT_ROOT, name: PATH_NAME })) as Record<string, unknown>;
  expect(created['ok'], `path create failed: ${JSON.stringify(created['error'] ?? created)}`).toBe(true);

  for (const angles of WAYPOINTS) {
    oracle.teach(angles);
    const pose = worldPoseOfAngles(angles);
    const added = JSON.parse(
      await executeDelegateValue(tools, 'ik.target.add', { pathPath: PATH_NAME, positionJson: pose.positionJson, rotationJson: pose.rotationJson }),
    ) as Record<string, unknown>;
    expect(added['reachable'], `waypoint not reachable: ${JSON.stringify(added)}`).toBe(true);
  }

  ikPath = robot.getPaths().find((p) => p.node.name === PATH_NAME)!;
  expect(ikPath.targets).toHaveLength(WAYPOINTS.length);
}, 180_000);

afterAll(() => {
  ikSolverRegistry.register(null);
  ikSolverRegistry.resetLiveSolveClaims();
  setAppConfig(appConfigBefore);
  resetProblemsForTests();
});

/** The WORLD pose a joint vector puts the TCP at — what a caller would type. */
function worldPoseOfAngles(angles: readonly number[]): { positionJson: string; rotationJson: string } {
  const fk = chainFk(robot.getJointChain()!, angles);
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

/**
 * The robot-local pose of a waypoint in the glTF frame, computed HERE by
 * matrix composition — the second route mentioned in the header.
 */
function localPoseOf(target: RVIKTarget): { pos: Vector3; quat: Quaternion } {
  robot.node.updateWorldMatrix(true, false);
  target.node.updateWorldMatrix(true, false);
  const m = new Matrix4().copy(robot.node.matrixWorld).invert().multiply(target.node.matrixWorld);
  const pos = new Vector3();
  const quat = new Quaternion();
  const scl = new Vector3();
  m.decompose(pos, quat, scl);
  return { pos, quat };
}

/** Convert the program once per `it`, so no test depends on another's object. */
function convert(path: RVIKPath = ikPath, includeLinkedPaths = false): RobotProgram {
  return ikPathToProgram(path, { includeLinkedPaths });
}

describe('plan-773 E3 — the gate sits in front of the converter, not in the tool', () => {
  it('produces a program when the tier is pro and the delivery is hosted', () => {
    expect(robotProgramDelivery()).toBe('hosted');
    const v = robotProgramExportGate();
    expect(v.allowed).toBe(true);
    expect(v.tier).toBe('pro');
    expect(convert().refusal).toBeNull();
  });

  it('refuses the CONVERTER itself below pro — no half program, no instructions', () => {
    ikSolverRegistry.register(null);
    try {
      const prog = convert();
      expect(prog.refusal?.code).toBe('tier');
      expect(prog.Instructions).toHaveLength(0);
      // The refusal is not a warning: a caller filtering warnings must not
      // mistake an empty program for a path with no waypoints.
      expect(prog.Warnings).toHaveLength(0);
      // …and it still says WHICH program was refused.
      expect(prog.Name).toBe(PATH_NAME);
    } finally {
      ikSolverRegistry.register(oracle);
      ikSolverRegistry.resetLiveSolveClaims();
    }
  });

  it('refuses a LOCAL delivery even at pro tier (ADR-022/023)', () => {
    setAppConfig({ ...getAppConfig(), hostedDeploy: false });
    try {
      // Vite serves this suite, so the delivery here is `'dev'`, which IS
      // allowed — the point of the assertion is that the gate reads the
      // delivery at all and reports which one it found.
      const v = robotProgramExportGate();
      expect(['dev', 'local']).toContain(v.delivery);
      if (v.delivery === 'local') {
        expect(v.allowed).toBe(false);
        expect(v.refusal?.code).toBe('delivery');
      }
    } finally {
      setAppConfig({ ...getAppConfig(), hostedDeploy: true });
    }
  });
});

describe('plan-773 F16 — one instruction per waypoint, never a sampled path', () => {
  it('emits exactly as many instructions as there are waypoints', () => {
    const prog = convert();
    expect(prog.Instructions).toHaveLength(WAYPOINTS.length);
  });

  it('names the program after the path and the robot after the rig', () => {
    const prog = convert();
    expect(prog.Name).toBe(PATH_NAME);
    expect(prog.SourceRobotName).toBe(robot.node.name);
  });

  it('keeps the waypoint order of IKPath.Path', () => {
    const prog = convert();
    const names = prog.Instructions.map((m) => m.Comment);
    const want = ikPath.targets.map((t) => t.node.name);
    expect(names).toEqual(want);
  });

  it('re-solves every waypoint instead of trusting the stored AxisPos', () => {
    const prog = convert();
    for (let i = 0; i < WAYPOINTS.length; i++) {
      expect(prog.Instructions[i].AnglesSource).toBe('solved');
      for (let a = 0; a < 6; a++) {
        expect(prog.Instructions[i].JointAngles[a]).toBeCloseTo(WAYPOINTS[i][a], 1);
      }
    }
  });

  it('emits a LoopPath once when the chain is followed, not forever', () => {
    const was = ikPath.LoopPath;
    ikPath.LoopPath = true;
    try {
      const prog = convert(ikPath, true);
      expect(prog.Instructions).toHaveLength(WAYPOINTS.length);
    } finally {
      ikPath.LoopPath = was;
    }
  });
});

describe('plan-773 F16 — the Cartesian pose comes from the TRANSFORM', () => {
  it('matches an independently composed robot-local pose, mirrored and scaled', () => {
    const prog = convert();
    for (let i = 0; i < prog.Instructions.length; i++) {
      const m = prog.Instructions[i];
      const { pos, quat } = localPoseOf(ikPath.targets[i]);
      // glTF → Unity (negate X) → vendor RH (negate Y)  ==  negate X and Y.
      expect(m.PositionMm[0]).toBeCloseTo(-pos.x * 1000, 6);
      expect(m.PositionMm[1]).toBeCloseTo(-pos.y * 1000, 6);
      expect(m.PositionMm[2]).toBeCloseTo(pos.z * 1000, 6);
      // glTF → Unity (negate Y and Z) → vendor RH (negate Y)  ==  negate Z.
      expect(m.RotationQuat[0]).toBeCloseTo(quat.x, 9);
      expect(m.RotationQuat[1]).toBeCloseTo(quat.y, 9);
      expect(m.RotationQuat[2]).toBeCloseTo(-quat.z, 9);
      expect(m.RotationQuat[3]).toBeCloseTo(quat.w, 9);
    }
  });

  it('does NOT emit the unmirrored glTF position — the negative probe', () => {
    const prog = convert();
    // A waypoint whose local X and Y are both far from zero, so dropping the
    // mirror would be a real, measurable difference rather than a rounding one.
    let probed = 0;
    for (let i = 0; i < prog.Instructions.length; i++) {
      const { pos } = localPoseOf(ikPath.targets[i]);
      if (Math.abs(pos.x) < 0.05 && Math.abs(pos.y) < 0.05) continue;
      probed++;
      const unmirrored = [pos.x * 1000, pos.y * 1000, pos.z * 1000];
      const got = prog.Instructions[i].PositionMm;
      const delta = Math.hypot(got[0] - unmirrored[0], got[1] - unmirrored[1], got[2] - unmirrored[2]);
      expect(delta).toBeGreaterThan(1); // more than a millimetre apart
    }
    expect(probed, 'no waypoint was far enough off-axis to probe the mirror').toBeGreaterThan(0);
  });

  it('scales scene metres to millimetres exactly once', () => {
    const prog = convert();
    const m = prog.Instructions[1];
    const { pos } = localPoseOf(ikPath.targets[1]);
    const metres = pos.length();
    const mm = Math.hypot(m.PositionMm[0], m.PositionMm[1], m.PositionMm[2]);
    expect(mm).toBeCloseTo(metres * 1000, 5);
    // A double scaling would land at 1e6 — the trap IKPathToProgram.cs:51-58
    // warns about in so many words.
    expect(mm).toBeLessThan(metres * 1000 * 10);
  });

  it('reports the ZYX Euler triple alongside the quaternion', () => {
    const prog = convert();
    for (const m of prog.Instructions) {
      expect(m.EulerZYXDeg).toHaveLength(3);
      for (const v of m.EulerZYXDeg) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('AxisCorrection removed from WEB (2026-11-02) — a Unity export that still carries it', () => {
  /** Put `AxisCorrection` into the raw extras of every target, as a Unity export has it. */
  function withRawCorrection<T>(values: number[], run: () => T): T {
    const raws = ikPath.targets.map((t) => {
      const rv = (t.node.userData.realvirtual ??= {}) as Record<string, Record<string, unknown>>;
      return (rv['IKTarget'] ??= {});
    });
    for (const raw of raws) raw['AxisCorrection'] = values.slice();
    try {
      return run();
    } finally {
      for (const raw of raws) delete raw['AxisCorrection'];
    }
  }

  it('exports exactly the same program with an all-zero AxisCorrection as without one', () => {
    resetAxisCorrectionWarningForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const without = convert();
      const withZeros = withRawCorrection([0, 0, 0, 0, 0, 0], () => convert());
      expect(JSON.stringify(withZeros.Instructions)).toBe(JSON.stringify(without.Instructions));
      expect(withZeros.Warnings).toEqual(without.Warnings);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('AxisCorrection'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores a non-zero AxisCorrection in the joint angles and warns once on the console', () => {
    resetAxisCorrectionWarningForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const without = convert();
      const first = withRawCorrection([1, 2, 3, 4, 5, 6], () => convert());
      const second = withRawCorrection([1, 2, 3, 4, 5, 6], () => convert());
      for (const prog of [first, second]) {
        for (let i = 0; i < prog.Instructions.length; i++) {
          expect(prog.Instructions[i].JointAngles).toEqual(without.Instructions[i].JointAngles);
        }
      }
      const hits = warn.mock.calls.filter((c) => String(c[0]).includes('AxisCorrection'));
      expect(hits).toHaveLength(1);
    } finally {
      warn.mockRestore();
      resetAxisCorrectionWarningForTests();
    }
  });
});

describe('plan-773 F13 — an unreachable waypoint is never a silent zero', () => {
  it('falls back to the BAKED angles and says so, per waypoint', () => {
    const t = ikPath.targets[2];
    const wasX = t.node.position.x;
    t.node.position.x = wasX + 7; // a pose the double was never taught
    try {
      const prog = convert();
      const m = prog.Instructions[2];
      expect(m.AnglesSource).toBe('baked');
      expect(m.Comment).toContain('[UNREACHABLE]');
      expect(prog.Warnings.some((w) => w.includes(t.node.name))).toBe(true);
      // The baked angles are the ones the file carries, not zeros.
      for (let a = 0; a < 6; a++) expect(m.JointAngles[a]).toBeCloseTo(WAYPOINTS[2][a], 1);
    } finally {
      t.node.position.x = wasX;
      t.node.updateWorldMatrix(true, false);
    }
  });

  it('marks a waypoint with no angles at all as `none`, not as data', () => {
    const t = ikPath.targets[2];
    const wasX = t.node.position.x;
    const wasAxis = t.AxisPos;
    t.node.position.x = wasX + 7;
    t.AxisPos = [];
    try {
      const prog = convert();
      const m = prog.Instructions[2];
      expect(m.AnglesSource).toBe('none');
      expect(m.JointAngles).toEqual([0, 0, 0, 0, 0, 0]);
      expect(prog.Warnings.some((w) => w.includes('NO usable joint vector'))).toBe(true);
    } finally {
      t.AxisPos = wasAxis;
      t.node.position.x = wasX;
      t.node.updateWorldMatrix(true, false);
    }
  });

  it('leaves the scene untouched — the export writes nothing', () => {
    const t = ikPath.targets[0];
    const axisBefore = [...t.AxisPos];
    const drivesBefore = robot.getAxisDrives().map((d) => d.currentPosition);
    convert();
    expect(t.AxisPos).toEqual(axisBefore);
    expect(robot.getAxisDrives().map((d) => d.currentPosition)).toEqual(drivesBefore);
  });
});

describe('plan-773 F16 — per-waypoint parameters and side effects', () => {
  it('maps the interpolation mode onto the move type', () => {
    const t = ikPath.targets[1];
    const was = t.InterpolationToTarget;
    try {
      t.InterpolationToTarget = 'Linear';
      expect(convert().Instructions[1].MoveType).toBe('LIN');
      t.InterpolationToTarget = 'PointToPointUnsynced';
      expect(convert().Instructions[1].MoveType).toBe('PTPUnsynced');
      t.InterpolationToTarget = 'PointToPoint';
      expect(convert().Instructions[1].MoveType).toBe('PTP');
    } finally {
      t.InterpolationToTarget = was;
    }
  });

  it('multiplies the waypoint speed by the path override and clamps at 100 %', () => {
    const t = ikPath.targets[0];
    const wasSpeed = t.SpeedToTarget;
    const wasOverride = ikPath.SpeedOverride;
    try {
      t.SpeedToTarget = 0.5;
      ikPath.SpeedOverride = 0.5;
      expect(convert().Instructions[0].JointSpeedPct).toBeCloseTo(25, 6);
      t.SpeedToTarget = 2;
      ikPath.SpeedOverride = 2;
      expect(convert().Instructions[0].JointSpeedPct).toBe(100);
    } finally {
      t.SpeedToTarget = wasSpeed;
      ikPath.SpeedOverride = wasOverride;
    }
  });

  it('zeroes the blend radius while blending is off', () => {
    const t = ikPath.targets[0];
    const wasEnabled = t.EnableBlending;
    const wasRadius = t.BlendRadius;
    try {
      t.EnableBlending = false;
      t.BlendRadius = 40;
      expect(convert().Instructions[0].BlendRadiusMm).toBe(0);
      t.EnableBlending = true;
      expect(convert().Instructions[0].BlendRadiusMm).toBe(40);
    } finally {
      t.EnableBlending = wasEnabled;
      t.BlendRadius = wasRadius;
    }
  });

  it('emits the gripper signal only for a pick-or-place waypoint', () => {
    const t = ikPath.targets[0];
    const wasPnP = t.PickAndPlace;
    const wasPick = t.Pick;
    try {
      t.PickAndPlace = true;
      t.Pick = false;
      t.Place = false;
      expect(convert().Instructions[0].PickPlaceSignalName).toBeNull();
      t.Pick = true;
      const m = convert().Instructions[0];
      expect(m.PickPlaceSignalName).toBe('GRIPPER_tool0');
      expect(m.PickPlaceSignalValue).toBe(true);
    } finally {
      t.PickAndPlace = wasPnP;
      t.Pick = wasPick;
      t.Place = false;
    }
  });

  it('carries the dwell time through unchanged', () => {
    const t = ikPath.targets[0];
    const was = t.WaitForSeconds;
    try {
      t.WaitForSeconds = 2.5;
      expect(convert().Instructions[0].DwellSec).toBe(2.5);
    } finally {
      t.WaitForSeconds = was;
    }
  });
});

describe('plan-773 F16 — the StartNextPath chain', () => {
  /**
   * A structural stand-in for the chain TOPOLOGY only. Everything the converter
   * reads from a path is here and real except `nextPath`, which cannot be set
   * on a live `RVIKPath` (it is resolved from the file in `init()`), and whose
   * walk is exactly what needs covering.
   */
  function linked(name: string, next: RVIKPath | null, loop = false): RVIKPath {
    return {
      node: { ...ikPath.node, name } as unknown as RVIKPath['node'],
      targets: ikPath.targets,
      robot,
      nextPath: next,
      LoopPath: loop,
      SetNewTCP: false,
      SpeedOverride: 1,
    } as unknown as RVIKPath;
  }

  it('exports only the selected path by default', () => {
    const b = linked('B', null);
    const a = linked('A', b);
    expect(ikPathToProgram(a).Instructions).toHaveLength(WAYPOINTS.length);
  });

  it('follows the chain into one continuous program when asked', () => {
    const b = linked('B', null);
    const a = linked('A', b);
    const prog = ikPathToProgram(a, { includeLinkedPaths: true });
    expect(prog.Instructions).toHaveLength(WAYPOINTS.length * 2);
    expect(prog.Name).toBe('A');
  });

  it('terminates on a cycle instead of exporting forever', () => {
    const b = linked('B', null);
    const a = linked('A', b);
    (b as { nextPath: RVIKPath | null }).nextPath = a; // A → B → A
    const prog = ikPathToProgram(a, { includeLinkedPaths: true });
    // Each path contributes exactly once; the seen-set stops the second visit.
    expect(prog.Instructions).toHaveLength(WAYPOINTS.length * 2);
  });

  it('stops at a LoopPath instead of walking its successor', () => {
    const b = linked('B', null);
    const a = linked('A', b, true);
    expect(ikPathToProgram(a, { includeLinkedPaths: true }).Instructions)
      .toHaveLength(WAYPOINTS.length);
  });
});

describe('plan-773 R5 — the field gaps are reported, never silently different', () => {
  it('always emits tool0, and warns when the file would have switched the tool', () => {
    const prog = convert();
    expect(prog.ToolName).toBe('tool0');

    const raw = ikPath.node.userData.realvirtual as Record<string, Record<string, unknown>>;
    const bag = raw['IKPath'] ?? (raw['IKPath'] = {});
    const wasFlag = ikPath.SetNewTCP;
    const wasTcp = bag['TCP'];
    try {
      ikPath.SetNewTCP = true;
      bag['TCP'] = '#some-tcp-node';
      const warned = convert();
      expect(warned.ToolName).toBe('tool0');
      expect(warned.Warnings.some((w) => w.includes('IKPath.TCP'))).toBe(true);
    } finally {
      ikPath.SetNewTCP = wasFlag;
      if (wasTcp === undefined) delete bag['TCP']; else bag['TCP'] = wasTcp;
    }
  });

  it('carries the robot tool offset through in millimetres', () => {
    const prog = convert();
    const raw = robot.getToolOffset();
    expect(prog.ToolOffsetMm[0]).toBeCloseTo(raw[0] * 1000, 6);
    expect(prog.ToolOffsetMm[1]).toBeCloseTo(raw[1] * 1000, 6);
    expect(prog.ToolOffsetMm[2]).toBeCloseTo(raw[2] * 1000, 6);
  });

  it('refuses nothing for a missing path — it warns, like Unity', () => {
    const prog = ikPathToProgram(null);
    expect(prog.refusal).toBeNull();
    expect(prog.Warnings).toContain('No IKPath provided.');
    expect(prog.Instructions).toHaveLength(0);
  });
});

// ── plan-773 Phase 5 (F17 / F18 / F21), on the same baked rig ────────────

describe('plan-773 F21 — the runtime forward-kinematics check', () => {
  it('measures the FIRST waypoint and vouches for the tool chain', () => {
    const prog = convert();
    expect(prog.FkCheck).not.toBeNull();
    expect(prog.FkCheck!.status).toBe('ok');
    expect(prog.FkCheck!.targetName).toBe(ikPath.targets[0].node.name);
    expect(prog.FkCheck!.positionErrorMm!).toBeLessThanOrEqual(FK_TOLERANCE_MM);
    expect(prog.FkCheck!.orientationErrorDeg!).toBeLessThanOrEqual(FK_TOLERANCE_DEG);
    expect(prog.refusal).toBeNull();
  });

  it('says "unavailable" rather than "ok" when there is no TCP to verify', () => {
    // The plan-772 state, reproduced: a bake that claims no TCP node. The joint
    // half is still exportable (E9), so this must NOT be a refusal.
    const spy = vi.spyOn(robot, 'getTcpNode').mockReturnValue(null);
    try {
      const prog = convert();
      expect(prog.refusal).toBeNull();
      expect(prog.FkCheck!.status).toBe('unavailable');
      expect(prog.FkCheck!.reason).toContain('no resolved TCP node');
      expect(prog.Instructions).toHaveLength(WAYPOINTS.length);
    } finally {
      spy.mockRestore();
    }
  });

  it('a BREACH refuses and clears the instructions — nothing half-written', () => {
    // plan-772's defect, in its exact shape: the chain the VIEWER replays and
    // verifies with carries a different tool than the model the pose was solved
    // against, so the solver answers "reachable" and forward kinematics of those
    // angles lands 240 mm away. (Moving the robot root would NOT reproduce it —
    // the waypoints are its descendants, so the robot-relative pose, which is
    // what both the solver and the check read, does not change.)
    const real = robot.getJointChain()!;
    const off = real.tcpLocalOffset as number[];
    const spy = vi.spyOn(robot, 'getJointChain').mockReturnValue({
      ...real, tcpLocalOffset: [off[0] + 0.24, off[1], off[2]],
    } as ReturnType<typeof robot.getJointChain>);
    try {
      const prog = convert();
      expect(prog.FkCheck!.status).toBe('breached');
      expect(prog.FkCheck!.positionErrorMm!).toBeGreaterThan(FK_TOLERANCE_MM);
      expect(prog.refusal?.code).toBe('fk');
      expect(prog.refusal?.message).toContain('web_query("ik.robot.verifyFk", {path})');
      expect(prog.Instructions).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('plan-773 F17/F18 — the vendors on the real rig', () => {
  const exportWith = async (vendor: 'abb-rapid' | 'sew-srlprg', axisBased = true) => {
    const pp = await loadRobotPostProcessor(vendor, {
      axisBased, uuid: 'fixed', generatedAt: new Date(2026, 0, 1),
    });
    return pp.emit(convert());
  };

  it('ABB emits one MoveAbsJ per waypoint, with the SOLVED angles of this rig', async () => {
    const r = await exportWith('abb-rapid');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = r.files[0].content;
    // Anchored to the indented body line: the module header mentions MoveAbsJ
    // in its "! Mode:" comment, and a bare search would count that too.
    expect(text.match(/^ {8}MoveAbsJ /gm) ?? []).toHaveLength(WAYPOINTS.length);
    // The oracle answers with the joint vectors it was taught, so the file has
    // to carry exactly those numbers — the end-to-end proof that nothing in
    // between re-interpreted them.
    for (const angles of WAYPOINTS) {
      const joint = angles.map((a) => String(Math.round(a * 1000) / 1000)).join(', ');
      expect(text, joint).toContain(`[[${joint}]`);
    }
  });

  it('SEW emits one PTP_J per waypoint on the same program', async () => {
    const r = await exportWith('sew-srlprg');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].content.match(/^PTP_J /gm) ?? []).toHaveLength(WAYPOINTS.length);
    expect(r.files[0].fileName).toBe(`${PATH_NAME}.srlprg`);
  });

  it('the Cartesian export is allowed here, because the FK check vouches for the chain', async () => {
    const r = await exportWith('abb-rapid', false);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files[0].content).toContain('CONST robtarget p_p0');
  });

  it('but is REFUSED on the same program once the tool chain is unverified (E9)', async () => {
    const spy = vi.spyOn(robot, 'getTcpNode').mockReturnValue(null);
    try {
      const cart = await exportWith('abb-rapid', false);
      expect(cart.ok).toBe(false);
      if (!cart.ok) expect(cart.refusal.code).toBe('toolchain');
      // The axis-based half of the very same program still goes out.
      expect((await exportWith('abb-rapid', true)).ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a licence refusal reaches the vendor and comes back out unchanged', async () => {
    // The TIER, not the delivery: a browser test is served by Vite and counts
    // as `'dev'` whatever `hostedDeploy` says, so clearing the hosted flag would
    // prove nothing here (see the suite header). Dropping the solver is the
    // half of E3 this environment can actually exercise.
    ikSolverRegistry.register(null);
    try {
      expect(ikSolverRegistry.tier).not.toBe('pro');
      const r = await exportWith('abb-rapid');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.refusal.code).toBe('tier');
        // Passed through verbatim — the vendor does not reword the gate.
        expect(r.refusal.message).toContain('Rigging, solving and authoring waypoints stay available');
      }
    } finally {
      ikSolverRegistry.register(oracle);
      ikSolverRegistry.resetLiveSolveClaims();
    }
  });
});

describe('plan-773 F18 — web_robot_program_export over the tool', () => {
  const callExport = async (args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    JSON.parse(await executeDelegateValue(tools, 'ik.program.export', { vendor: (args['vendor'] as string) ?? 'abb-rapid', pathPath: (args['pathPath'] as string) ?? PATH_NAME, axisBased: args['axisBased'] as boolean | undefined, includeLinkedPaths: args['includeLinkedPaths'] as boolean | undefined, download: args['download'] as boolean | undefined })) as Record<string, unknown>;

  it('answers with the files inline, the warnings and the disclaimer verbatim', async () => {
    const r = await callExport();
    expect(r['ok'], JSON.stringify(r['error'] ?? r['refusal'] ?? '')).toBe(true);
    expect(r['vendorId']).toBe('abb-rapid');
    expect(r['vendor']).toBe('ABB RAPID');
    expect(r['waypoints']).toBe(WAYPOINTS.length);
    const files = r['files'] as { fileName: string; content: string }[];
    expect(files).toHaveLength(1);
    expect(files[0].fileName).toBe(`${PATH_NAME}.mod`);
    expect(files[0].content).toContain('ENDMODULE');
    expect(r['disclaimer']).toBe(ROBOT_PROGRAM_DISCLAIMER);
    expect(Array.isArray(r['warnings'])).toBe(true);
  });

  it('reports where the angles came from, so a reader need not guess', async () => {
    const r = await callExport();
    expect(r['anglesSources']).toEqual({ solved: WAYPOINTS.length, baked: 0, none: 0 });
    expect((r['fkCheck'] as { status: string }).status).toBe('ok');
  });

  it('is read-only: it leaves the robot and the waypoints exactly as it found them', async () => {
    const before = ikPath.targets.map((t) => [...t.AxisPos]);
    const pose = ikPath.targets[0].node.position.clone();
    await callExport();
    expect(ikPath.targets.map((t) => [...t.AxisPos])).toEqual(before);
    expect(ikPath.targets[0].node.position.equals(pose)).toBe(true);
  });

  it('lists the vendors instead of guessing when the id is unknown', async () => {
    const r = await callExport({ vendor: 'kuka-krl' });
    expect(String(r['error'])).toContain('kuka-krl');
    const vendors = r['vendors'] as { id: string }[];
    expect(vendors.map((v) => v.id).sort()).toEqual(['abb-rapid', 'sew-srlprg']);
  });

  it('names the problem instead of picking a path when the path is unknown', async () => {
    const r = await callExport({ pathPath: 'NoSuchPath' });
    expect(String(r['error'])).toContain('NoSuchPath');
  });

  it('switches the vendor and the mode from the wire', async () => {
    const sew = await callExport({ vendor: 'sew-srlprg' });
    expect((sew['files'] as { fileName: string }[])[0].fileName).toBe(`${PATH_NAME}.srlprg`);
    const cart = await callExport({ axisBased: false });
    expect(cart['axisBased']).toBe(false);
    expect((cart['files'] as { content: string }[])[0].content).toContain('MoveJ p_p0');
  });

  it('carries a refusal as a REFUSAL, with its code and sentence, and no files', async () => {
    ikSolverRegistry.register(null);
    try {
      const r = await callExport();
      expect(r['ok']).toBe(false);
      const refusal = r['refusal'] as { code: string; message: string };
      expect(refusal.code).toBe('tier');
      expect(refusal.message.length).toBeGreaterThan(40); // a sentence, not a code
      expect(r['files']).toBeUndefined();
      // A refusal still says WHICH program was refused (plan-773 E3).
      expect(r['program']).toBe(PATH_NAME);
    } finally {
      ikSolverRegistry.register(oracle);
      ikSolverRegistry.resetLiveSolveClaims();
    }
  });

  it('is a view of ik.program.export — the command runs the same body (F18/F19)', async () => {
    ensureIkCommandsRegistered();
    const desc = commandRegistry.get(IK_PROGRAM_EXPORT_COMMAND);
    expect(desc, 'ik.program.export is not registered').toBeDefined();
    expect(desc!.readOnly).toBe(true);
    expect(desc!.mcp?.tool).toBe('web_robot_program_export');
    const res = await commandRegistry.execute<Record<string, unknown>>(
      IK_PROGRAM_EXPORT_COMMAND,
      { vendor: 'abb-rapid', pathPath: PATH_NAME },
      { origin: 'ui', viewer: robotToolsViewer(baked!, scene) },
    );
    expect(res.ok, res.ok ? '' : res.reason).toBe(true);
    if (!res.ok) return;
    const direct = await callExport();
    expect((res.value['files'] as { content: string }[])[0].content)
      .toBe((direct['files'] as { content: string }[])[0].content);
  });
});

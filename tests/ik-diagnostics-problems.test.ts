// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-diagnostics-problems.test.ts — the robot IK says what it cannot do.
 *
 * Every case here used to be silent: `getJointChain()` returned null, the TCP
 * collapsed onto the axis-6 flange, `getOpwParams()` returned null, the wrist
 * type defaulted to `Spherical` — and the robot kept replaying its baked joint
 * angles, so from the outside nothing was wrong. The one thing these tests
 * assert is that each case now reaches the Problems panel, and that a sound rig
 * reports nothing.
 *
 * The rigs are built HERE, from `Object3D` + `RVDrive` + a real `NodeRegistry`
 * (the idiom of `rv-ik-path.test.ts`) rather than loaded from a project file:
 * the flat-axis shape in particular is a structural property of the hierarchy,
 * and a synthetic rig states it directly and stays available on every checkout.
 *
 * Also covered: a failed chain derivation is NOT frozen for the lifetime of the
 * robot (it was — `_jointChainComputed` was set before the computation), and the
 * path visualizer's reachability markers report `'unknown'` instead of claiming
 * everything is reachable when nothing could be checked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BufferGeometry, Object3D, Scene } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { RVRobotIK } from '../src/core/engine/rv-robot-ik';
import { IK_PROBLEM_CODES, getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { IKPathVisualizerPlugin } from '../src/plugins/ik-path-visualizer-plugin';

const driveRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.Drive' });

/** The problem of one code, or undefined — the assertions read `detail`, not just the code. */
function problemOf(code: string) {
  return getProblems().find((p) => p.code === code);
}

const codes = () => getProblems().map((p) => p.code).sort();

interface RigOptions {
  /** Axis nodes nested inside one another (a serial chain) or flat siblings. */
  nested: boolean;
  axisCount?: number;
  direction?: DriveDirection;
  /** `'ok'` registers the TCP node, `'dangling'` writes a path to nothing, `'none'` writes no TCP. */
  tcp?: 'ok' | 'dangling' | 'none';
  /** Write finite OPW parameters (a1 …) into the extras. */
  opw?: boolean;
  /** Omitted ⇒ no WristType key in the extras at all. */
  wristType?: 'Spherical' | 'NonSpherical';
}

interface Rig {
  robot: RVRobotIK;
  robotNode: Object3D;
  axisNodes: Object3D[];
  registry: NodeRegistry;
  root: Object3D;
}

/**
 * One robot rig, assembled exactly the way the loader hands one over: the Axis
 * references and every other raw field live on `userData.realvirtual`, the
 * drives are registered in the registry, and `init()` + `onSceneReady()` run in
 * that order.
 */
function buildRig(opts: RigOptions): Rig {
  const axisCount = opts.axisCount ?? 6;
  const registry = new NodeRegistry();
  const root = new Object3D();
  root.name = 'Root';
  const robotNode = new Object3D();
  robotNode.name = 'Robot';
  root.add(robotNode);
  registry.registerNode('Robot', robotNode);

  const axisNodes: Object3D[] = [];
  const axisRefs: ComponentRef[] = [];
  let chainTip: Object3D = robotNode;
  for (let i = 0; i < axisCount; i++) {
    const node = new Object3D();
    node.name = `J${i + 1}`;
    node.position.set(0, 0.2, 0);
    // The whole point of the flat variant: the axes are SIBLINGS under the robot
    // instead of each one living inside its predecessor.
    (opts.nested ? chainTip : robotNode).add(node);
    chainTip = node;
    const path = opts.nested ? `Robot/${axisNodes.map((n) => n.name).concat(node.name).join('/')}` : `Robot/${node.name}`;
    const drive = new RVDrive(node);
    drive.Direction = opts.direction ?? DriveDirection.RotationY;
    drive.StartPosition = 0;
    drive.TargetSpeed = 100;
    drive.UseAcceleration = false;
    drive.UseLimits = false;
    drive.initDrive();
    registry.register('Drive', path, drive);
    registry.registerNode(path, node);
    axisNodes.push(node);
    axisRefs.push(driveRef(path));
  }

  const extras: Record<string, unknown> = { Axis: axisRefs };
  if (opts.wristType !== undefined) extras['WristType'] = opts.wristType;
  if (opts.opw) {
    Object.assign(extras, { a1: 0.1, a2: 0, b: 0, c1: 0.3, c2: 0.5, c3: 0.4, c4: 0.1, ToolOffset: { x: 0, y: 0, z: 0 } });
  }
  if (opts.tcp === 'ok' || opts.tcp === 'dangling') {
    const tcpPath = 'Robot/GripperTCP';
    extras['TCP'] = tcpPath;
    if (opts.tcp === 'ok') {
      const tcpNode = new Object3D();
      tcpNode.name = 'GripperTCP';
      tcpNode.position.set(0, 0.24, 0);
      axisNodes[axisNodes.length - 1]?.add(tcpNode);
      registry.registerNode(tcpPath, tcpNode);
    }
  }
  robotNode.userData.realvirtual = { RobotIK: extras };

  root.updateMatrixWorld(true);
  const robot = new RVRobotIK(robotNode);
  if (opts.wristType !== undefined) robot.WristType = opts.wristType;
  robot.init({ registry } as unknown as ComponentContext);
  robot.onSceneReady();
  return { robot, robotNode, axisNodes, registry, root };
}

/** A rig with nothing wrong: nested axes, finite OPW, resolvable TCP, WristType set. */
const SOUND: RigOptions = { nested: true, tcp: 'ok', opw: true, wristType: 'NonSpherical' };

describe('robot IK diagnostics — the silent cases reach the Problems panel', () => {
  beforeEach(() => { resetProblemsForTests(); });
  afterEach(() => { resetProblemsForTests(); });

  it('a sound rig reports nothing at all', () => {
    const rig = buildRig(SOUND);
    expect(rig.robot.getJointChain()).not.toBeNull();
    expect(codes()).toEqual([]);
  });

  // ── The flat-axis rig: the case that was measured and reported nothing ────

  it('axes that are siblings instead of nested are reported, naming the axis AND the reason', () => {
    const rig = buildRig({ ...SOUND, nested: false });
    // The precondition of the whole finding: no chain at all.
    expect(rig.robot.getJointChain()).toBeNull();

    const entry = problemOf(IK_PROBLEM_CODES.chainUnresolved);
    expect(entry, 'a rig with no derivable chain must appear in the Problems panel').toBeDefined();
    expect(entry!.severity).toBe('error');
    expect(entry!.nodePath).toBe('Robot');
    // "Chain cannot be derived" without the cause is half an entry: the message
    // must name the axis that broke the series and what it should have hung under.
    expect(entry!.detail).toContain('Axis[1] "J2"');
    expect(entry!.detail).toContain('Axis[0] "J1"');
    expect(entry!.detail).toMatch(/not a descendant/);
  });

  it('a linear axis in the chain is reported as such, not as a generic failure', () => {
    const rig = buildRig({ ...SOUND, direction: DriveDirection.LinearZ });
    expect(rig.robot.getJointChain()).toBeNull();
    const entry = problemOf(IK_PROBLEM_CODES.chainUnresolved);
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain('Axis[0] "J1"');
    expect(entry!.detail).toContain('LinearZ');
  });

  it('a chain that is not six axes names the count it found', () => {
    buildRig({ ...SOUND, axisCount: 4 });
    const entry = problemOf(IK_PROBLEM_CODES.chainUnresolved);
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain('4 drive(s)');
  });

  it('a RobotIK whose Axis[] resolves to nothing is its own error, not a chain reason', () => {
    const registry = new NodeRegistry();
    const robotNode = new Object3D();
    robotNode.name = 'Robot';
    robotNode.userData.realvirtual = { RobotIK: { Axis: [driveRef('Robot/Missing')], a1: 0.1 } };
    const robot = new RVRobotIK(robotNode);
    robot.init({ registry } as unknown as ComponentContext);
    robot.onSceneReady();

    const entry = problemOf(IK_PROBLEM_CODES.axesUnresolved);
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe('error');
    expect(entry!.detail).toContain('1 entry');
    // Not ALSO reported as a chain failure — one cause, one entry.
    expect(problemOf(IK_PROBLEM_CODES.chainUnresolved)).toBeUndefined();
  });

  // ── TCP ───────────────────────────────────────────────────────────────────

  it('a TCP written in the file that resolves to nothing is an error naming the written path', () => {
    const rig = buildRig({ ...SOUND, tcp: 'dangling' });
    const entry = problemOf(IK_PROBLEM_CODES.tcpUnresolved);
    expect(entry, 'a dangling TCP silently collapses the tool pose onto the A6 flange').toBeDefined();
    expect(entry!.severity).toBe('error');
    expect(entry!.detail).toContain('Robot/GripperTCP');
    // And the measurable consequence it warns about is really there.
    expect(rig.robot.getTcpNode()).toBeNull();
    const chain = rig.robot.getJointChain()!;
    expect(Math.hypot(...chain.tcpLocalOffset)).toBe(0);
  });

  it('a rig with NO TCP at all is not reported — that is the supported flange case', () => {
    buildRig({ ...SOUND, tcp: 'none' });
    expect(problemOf(IK_PROBLEM_CODES.tcpUnresolved)).toBeUndefined();
  });

  // ── OPW parameters and wrist type ────────────────────────────────────────

  it('unusable OPW parameters are reported (no LIN, no reachability)', () => {
    const rig = buildRig({ ...SOUND, opw: false });
    expect(rig.robot.getOpwParams()).toBeNull();
    const entry = problemOf(IK_PROBLEM_CODES.opwUnusable);
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe('error');
  });

  it('a missing WristType is a WARNING that names the assumed default', () => {
    const rig = buildRig({ nested: true, tcp: 'ok', opw: true }); // no wristType key
    expect(rig.robot.WristType).toBe('Spherical'); // the silent default
    const entry = problemOf(IK_PROBLEM_CODES.wristTypeMissing);
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe('warning');
    expect(entry!.detail).toContain('Spherical');
  });

  it('re-diagnosing the same robot replaces its entries instead of appending', () => {
    const rig = buildRig({ ...SOUND, nested: false });
    const before = getProblems().length;
    rig.robot.onSceneReady();
    rig.robot.onSceneReady();
    expect(getProblems().length).toBe(before);
  });
});

// ── The cache must not freeze a failure ────────────────────────────────────

describe('getJointChain() — a failed derivation is repeatable', () => {
  beforeEach(() => { resetProblemsForTests(); });
  afterEach(() => { resetProblemsForTests(); });

  it('solves after the axes are nested, although the first attempt failed', () => {
    const rig = buildRig({ ...SOUND, nested: false });
    expect(rig.robot.getJointChain()).toBeNull();

    // Re-parent the flat axes into a serial chain — exactly what a later
    // kinematic pass, a repair or an editor move would do.
    for (let i = 1; i < rig.axisNodes.length; i++) {
      rig.axisNodes[i - 1].add(rig.axisNodes[i]);
    }
    rig.root.updateMatrixWorld(true);

    // Before the fix this stayed null forever: `_jointChainComputed` was set
    // BEFORE the computation, so the null was cached for the robot's lifetime.
    expect(rig.robot.getJointChain()).not.toBeNull();
  });

  it('does not recompute while the rig is unchanged', () => {
    const rig = buildRig({ ...SOUND, nested: false });
    const robot = rig.robot as unknown as { computeJointChain(): unknown };
    const original = robot.computeJointChain.bind(robot);
    let calls = 0;
    robot.computeJointChain = () => { calls++; return original(); };
    for (let i = 0; i < 50; i++) expect(rig.robot.getJointChain()).toBeNull();
    expect(calls, 'an unchanged broken rig must not be re-derived per call').toBe(0);
  });

  it('a successful chain is cached and never re-derived', () => {
    const rig = buildRig(SOUND);
    expect(rig.robot.getJointChain()).not.toBeNull();
    const robot = rig.robot as unknown as { computeJointChain(): unknown };
    let calls = 0;
    robot.computeJointChain = () => { calls++; return null; };
    for (let i = 0; i < 10; i++) expect(rig.robot.getJointChain()).not.toBeNull();
    expect(calls).toBe(0);
  });
});

// ── Reachability markers: "unknown" rather than an optimistic green ────────

interface FakeHandle {
  root: Object3D;
  colors: number[];
  update(o: { color?: number }): void;
  dispose(): void;
}

/** The two viewer members the visualizer touches while building a path visual. */
function fakeViewer() {
  const scene = new Scene();
  const handles: FakeHandle[] = [];
  const gizmoManager = {
    create: (node: Object3D, opts: { color?: number }) => {
      const handle: FakeHandle = {
        root: node,
        colors: opts.color !== undefined ? [opts.color] : [],
        update(o) { if (o.color !== undefined) this.colors.push(o.color); },
        dispose() { /* nothing to free in the stub */ },
      };
      handles.push(handle);
      return handle;
    },
  };
  return { scene, gizmoManager, handles };
}

function fakePathAndRobot(wristType: 'Spherical' | 'NonSpherical', opw: unknown, chain: unknown) {
  const robotNode = new Object3D();
  robotNode.name = 'Robot';
  const targets = [0, 1].map((i) => {
    const node = new Object3D();
    node.name = `T${i}`;
    node.position.set(i, 0, 0);
    robotNode.add(node);
    return { node, InterpolationToTarget: 'Linear' };
  });
  robotNode.updateMatrixWorld(true);
  const robot = { node: robotNode, WristType: wristType, getOpwParams: () => opw, getJointChain: () => chain };
  return { path: { targets }, robot };
}

/** Build one path visual through the real plugin and hand back its `reach` array. */
function reachOf(wristType: 'Spherical' | 'NonSpherical', opw: unknown, chain: unknown): string[] {
  const plugin = new IKPathVisualizerPlugin();
  const view = fakeViewer();
  (plugin as unknown as { viewer: unknown }).viewer = view;
  const { path, robot } = fakePathAndRobot(wristType, opw, chain);
  const create = (plugin as unknown as {
    createVisual(p: unknown, r: unknown): { reach: string[]; line: { geometry: BufferGeometry } };
  }).createVisual.bind(plugin);
  const visual = create(path, robot);
  const reach = [...visual.reach];
  visual.line.geometry.dispose();
  return reach;
}

describe('IK path reachability markers', () => {
  it('stand at "unknown" without OPW parameters instead of claiming reachable', () => {
    // Before the fix: `reach` was initialised to `fill(true)` and
    // `updateReachability` returned early — a permanently green path on exactly
    // the robots where no check had ever run.
    expect(reachOf('Spherical', null, null)).toEqual(['unknown', 'unknown']);
  });

  it('stand at "unknown" for a cobot whose chain could not be derived', () => {
    // The old code fell through to the spherical Pieper solver here, answering
    // from the wrong kinematic model.
    const opw = { a1: 0.1, a2: 0, b: 0, c1: 0.3, c2: 0.5, c3: 0.4, c4: 0.1, elbowInUnityX: false, toolOffset: [0, 0, 0] };
    expect(reachOf('NonSpherical', opw, null)).toEqual(['unknown', 'unknown']);
  });

  it('start grey rather than lavender, so nothing is claimed before it was checked', () => {
    const plugin = new IKPathVisualizerPlugin();
    const view = fakeViewer();
    (plugin as unknown as { viewer: unknown }).viewer = view;
    const { path, robot } = fakePathAndRobot('Spherical', null, null);
    const create = (plugin as unknown as {
      createVisual(p: unknown, r: unknown): { line: { geometry: BufferGeometry } };
    }).createVisual.bind(plugin);
    const visual = create(path, robot);
    // Markers are created with the unknown colour and never recoloured to the
    // reachable lavender (0xce93d8) while nothing can be solved.
    const spheres = view.handles.filter((h) => h.colors.length > 0);
    expect(spheres.length).toBeGreaterThan(0);
    for (const h of spheres) expect(h.colors).not.toContain(0xce93d8);
    visual.line.geometry.dispose();
  });
});

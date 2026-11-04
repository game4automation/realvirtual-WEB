// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ik-path-dynamic-axis.test.ts — plan-673 Phase 4: the IK is REDIRECTED, not
 * switched off.
 *
 * `rv-ik-path.ts` used to move a robot by writing the axis drive's ACTUAL
 * position. On a dynamic axis that is the "last writer in the tick wins" race
 * of 2.4: MuJoCo writes the same field from the physics. The contract makes the
 * planner write the SETPOINT instead and leaves the position to whoever owns the
 * axis physically — so the IK keeps computing poses and the physics answers
 * whether the axis reaches them.
 *
 * Two things this file has to prove, because both are easy to get wrong:
 *
 *  - a KINEMATIC path is byte-for-byte unchanged (the regression that matters
 *    far more than the new feature);
 *  - a dynamic axis is never handed back to its own motion integration
 *    mid-move, and its setpoint RAMPS instead of stepping — `startMove()` would
 *    arm a profile that `positionOverwrite` prevents from ever running, i.e.
 *    the axis would silently never move.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry, type ComponentRef } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { RVIKTarget } from '../src/core/engine/rv-ik-target';
import { RVIKPath } from '../src/core/engine/rv-ik-path';
import { RVDynamicAxis } from '../src/core/engine/rv-dynamic-axis';
import { bindDynamicAxis } from '../src/core/engine/rv-axis-contract';
import { releaseAllAxes } from '../src/core/engine/rv-axis-ownership';

const driveRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.Drive' });
const targetRef = (path: string): ComponentRef => ({ type: 'ComponentReference', path, componentType: 'realvirtual.IKTarget' });

interface Scene {
  ikPath: RVIKPath;
  drives: RVDrive[];
  tick: (dt: number) => void;
  runUntil: (pred: () => boolean, maxFrames?: number, dt?: number) => number;
}

/**
 * One robot, `axisCount` axes, one target. `dynamic` names the axis indices that
 * get a `DynamicAxis` — and, like the real thing, their `positionOverwrite` is
 * already set by the physics authority before the path starts.
 */
function buildScene(axisCount: number, axisPos: number[], dynamic: readonly number[] = []): Scene {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const transportManager = new RVTransportManager();

  const drives: RVDrive[] = [];
  const axisRefs: ComponentRef[] = [];
  for (let i = 0; i < axisCount; i++) {
    const p = `Robot/a${i}`;
    const node = new Object3D();
    node.name = `a${i}`;
    const d = new RVDrive(node);
    d.Direction = DriveDirection.RotationZ;
    d.StartPosition = 0;
    d.TargetSpeed = 100;
    d.UseAcceleration = false;
    d.UseLimits = false;
    d.initDrive();
    registry.register('Drive', p, d);
    drives.push(d);
    axisRefs.push(driveRef(p));

    if (dynamic.includes(i)) {
      const axis = new RVDynamicAxis(node);
      axis.BaseFollowingError = 0.1;
      axis.FollowingErrorLimit = 0.5;
      axis.drive = d;
      bindDynamicAxis(d, axis);
      // What the adapter does on activate(): the physics owns the position.
      d.positionOverwrite = true;
    }
  }

  const robotNode = new Object3D();
  robotNode.name = 'Robot';
  robotNode.userData.realvirtual = { RobotIK: { Axis: axisRefs } };
  const ikPathNode = new Object3D();
  ikPathNode.name = 'Path';
  robotNode.add(ikPathNode);

  const tnode = new Object3D();
  tnode.name = 'T0';
  const target = new RVIKTarget(tnode);
  target.AxisPos = axisPos;
  target.SpeedToTarget = 1;
  target.init({ registry, signalStore: store } as unknown as ComponentContext);
  registry.register('IKTarget', 'Robot/Path/T0', target);

  ikPathNode.userData.realvirtual = { IKPath: { Path: [targetRef('Robot/Path/T0')] } };
  const ikPath = new RVIKPath(ikPathNode);
  ikPath.init({
    registry, signalStore: store, scene: new Object3D() as never, transportManager, root: robotNode,
  } as ComponentContext);
  registry.register('IKPath', 'Robot/Path', ikPath);

  const tick = (dt: number) => {
    ikPath.fixedUpdate(dt);
    for (const d of drives) d.update(dt);
  };
  const runUntil = (pred: () => boolean, maxFrames = 2000, dt = 0.05): number => {
    let n = 0;
    while (n < maxFrames && !pred()) { tick(dt); n++; }
    return n;
  };
  return { ikPath, drives, tick, runUntil };
}

beforeEach(() => {
  releaseAllAxes();
  RVDynamicAxis.clearAll();
});

describe('a kinematic path is unchanged', () => {
  it('still drives the axes to the baked AxisPos and finishes', () => {
    const s = buildScene(3, [90, -45, 30]);
    s.ikPath.startPath();
    s.runUntil(() => s.ikPath.PathIsFinished);
    expect(s.ikPath.PathIsFinished).toBe(true);
    expect(s.drives[0].currentPosition).toBeCloseTo(90, 1);
    expect(s.drives[1].currentPosition).toBeCloseTo(-45, 1);
    expect(s.drives[2].currentPosition).toBeCloseTo(30, 1);
    // And the diagnostic quantities stay at rest on a kinematic axis — they do
    // not exist there, which is the whole reason the dynamic mode is a mode.
    expect(s.drives[0].followingError).toBe(0);
    expect(s.drives[0].actualTorque).toBe(0);
    expect(s.drives[0].saturated).toBe(false);
  });
});

describe('a dynamic axis gets a setpoint', () => {
  it('ramps the setpoint and never writes the position itself', () => {
    const s = buildScene(1, [90], [0]);
    const d = s.drives[0];
    s.ikPath.startPath();
    s.tick(0.05);
    // The command has moved, the position has NOT: nobody is simulating the
    // physics in this test, and that is exactly the point — a planner that
    // wrote the position would have "moved" the axis without any physics.
    expect(d.commandedPosition).toBeGreaterThan(0);
    expect(d.commandedPosition).toBeLessThan(90);
    expect(d.currentPosition).toBe(0);
    // The physics authority keeps the axis.
    expect(d.positionOverwrite).toBe(true);
    // The following error is the real quantity now.
    expect(d.followingError).toBeCloseTo(d.commandedPosition, 9);
  });

  it('does not command the destination in ONE step', () => {
    const s = buildScene(1, [90], [0]);
    s.ikPath.startPath();
    s.tick(0.05);
    const first = s.drives[0].commandedPosition;
    // 100 deg/s · 0.05 s = 5 deg, not 90.
    expect(first).toBeCloseTo(5, 6);
  });

  it('reaches the destination as a COMMAND and then holds it', () => {
    const s = buildScene(1, [90], [0]);
    s.ikPath.startPath();
    for (let i = 0; i < 40; i++) s.tick(0.05);
    expect(s.drives[0].commandedPosition).toBeCloseTo(90, 9);
    // One more tick must not overshoot the destination.
    s.tick(0.05);
    expect(s.drives[0].commandedPosition).toBeCloseTo(90, 9);
  });

  it('does not advance the path while the setpoint ramp is still running', () => {
    // The physics has pushed the axis ONTO the destination while the command is
    // still far away — exactly what a contact does. `isAtTarget` is therefore
    // true on tick one, and without the ramp guard the path would finish
    // before it had commanded the move at all.
    const s = buildScene(1, [90], [0]);
    const d = s.drives[0];
    d.commandPosition(0);
    d.currentPosition = 90;
    s.ikPath.startPath();
    s.tick(0.05);
    expect(s.ikPath.PathIsFinished).toBe(false);
    expect(d.commandedPosition).toBeLessThan(90);
    s.runUntil(() => s.ikPath.PathIsFinished, 200);
    expect(s.ikPath.PathIsFinished).toBe(true);
  });

  it('commands nothing and advances when the axis is already AT the destination', () => {
    // The honest counterpart of the case above: command and position agree, so
    // there is no move to ramp and the path advances on the next tick — the
    // same ≥1-tick-per-target guarantee a kinematic zero-delta target has.
    const s = buildScene(1, [90], [0]);
    s.drives[0].currentPosition = 90;
    s.ikPath.startPath();
    s.tick(0.05);
    expect(s.drives[0].commandedPosition).toBeCloseTo(90, 9);
    expect(s.ikPath.PathIsFinished).toBe(true);
  });

  it('finishes the path once the physics brings the axis inside the arrival tolerance', () => {
    const s = buildScene(1, [90], [0]);
    const d = s.drives[0];
    s.ikPath.startPath();
    // Stand in for the physics: the axis follows its setpoint with a permanent
    // sag of 0.1 deg, i.e. exactly the declared base share.
    for (let i = 0; i < 100 && !s.ikPath.PathIsFinished; i++) {
      s.ikPath.fixedUpdate(0.05);
      d.reportDynamicSample(Math.max(0, d.commandedPosition - 0.1), 12, false);
      d.update(0.05);
    }
    expect(s.ikPath.PathIsFinished).toBe(true);
    // Arrived with 0.1 deg left over: a kinematic 0.01 tolerance would have
    // waited forever here, which is the stumbling block 2.4 names.
    expect(d.currentPosition).toBeCloseTo(89.9, 6);
    expect(Math.abs(d.followingError)).toBeCloseTo(0.1, 6);
  });

  it('a mixed robot moves its kinematic axes and commands its dynamic one', () => {
    const s = buildScene(2, [60, 60], [1]);
    s.ikPath.startPath();
    for (let i = 0; i < 5; i++) s.tick(0.05);
    expect(s.drives[0].currentPosition).toBeGreaterThan(0);   // integrated
    expect(s.drives[0].positionOverwrite).toBe(false);
    expect(s.drives[1].currentPosition).toBe(0);              // physics owns it
    expect(s.drives[1].commandedPosition).toBeGreaterThan(0);
    expect(s.drives[1].positionOverwrite).toBe(true);
  });

  it('startMove() on a dynamic axis ramps the setpoint instead of doing nothing', () => {
    // The hole this closes: with `positionOverwrite` set, `updateMotion()`
    // returns before the motion integration, so a `LogicStep_DriveTo` (or a
    // behavior, or the jog UI) armed a profile that never ran and the axis
    // never moved — silently, with no error anywhere. Every one of those
    // callers goes through `startMove()`, so the ramp belongs in the drive.
    const s = buildScene(1, [90], [0]);
    const d = s.drives[0];
    d.targetSpeed = 100;
    d.startMove(45);
    expect(d.isRunning).toBe(true);
    d.update(0.05);
    expect(d.commandedPosition).toBeCloseTo(5, 6);
    expect(d.currentPosition).toBe(0);               // still the physics' answer
    for (let i = 0; i < 20; i++) d.update(0.05);
    expect(d.commandedPosition).toBeCloseTo(45, 6);
    // `isRunning` falls when the COMMAND arrives; whether the AXIS arrived is
    // `isAtTarget`'s business, with the widened tolerance.
    expect(d.isRunning).toBe(false);
    expect(d.isAtTarget).toBe(false);
    d.reportDynamicSample(44.95, 0, false);
    expect(d.isAtTarget).toBe(true);
  });

  it('leaves a kinematic drive in overwrite mode alone — playback is not a command', () => {
    // The same branch carries recordings and multiuser followers. They are not
    // dynamic axes and must keep streaming positions untouched.
    const s = buildScene(1, [90]);
    const d = s.drives[0];
    d.positionOverwrite = true;
    d.startMove(45);
    d.currentPosition = 12.5;
    d.update(0.05);
    expect(d.currentPosition).toBeCloseTo(12.5, 9);
    expect(Number.isNaN(d.commandedPosition)).toBe(true);
  });

  it('cancel() holds the last setpoint and keeps the physics authority', () => {
    const s = buildScene(1, [90], [0]);
    s.ikPath.startPath();
    for (let i = 0; i < 3; i++) s.tick(0.05);
    const held = s.drives[0].commandedPosition;
    s.ikPath.cancel();
    expect(s.ikPath.PathIsActive).toBe(false);
    // Not handed back to an integration that was never running …
    expect(s.drives[0].positionOverwrite).toBe(true);
    // … and no step input the size of the following error.
    expect(s.drives[0].commandedPosition).toBeCloseTo(held, 9);
    expect(s.drives[0].targetPosition).toBeCloseTo(held, 9);
  });
});

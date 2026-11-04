// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 §9.7b (pose part) — the public pose adapter `withPose` (M6).
 *
 *  - only node transforms change, and they come back EXACTLY — also when the
 *    measured function throws;
 *  - a running acceleration profile proceeds tick for tick identically to an
 *    untouched control run while a pose check is taken every tick;
 *  - nested axes: parents first, the child computed in the posed parent frame,
 *    equal to the drive's own applyToNode result;
 *  - Drive_Gear slaves follow their posed master state-free; any other coupling
 *    to a posed axis is refused (`pose-dependency-unsupported`) unless posed
 *    explicitly; the editor tree refuses a pose (`pose-requires-runtime`).
 *
 * AGPL-only: no private module is involved (runs in the community edition).
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Scene, Vector3 } from 'three';
import { DriveDirection, RVDrive, type IDriveBehavior } from '../src/core/engine/rv-drive';
import { RVDriveGear } from '../src/core/engine/rv-drive-gear';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { PoseError, resolvePose, withPose, type PoseContext } from '../src/core/engine/rv-pose-adapter';

const DT = 1 / 60;

function makeDrive(parent: Object3D, name: string, dir: DriveDirection, over: Partial<RVDrive> = {}): RVDrive {
  const node = new Object3D();
  node.name = name;
  parent.add(node);
  const d = new RVDrive(node);
  d.Direction = dir;
  Object.assign(d, over);
  d.initDrive();
  return d;
}

function ctxOf(drives: RVDrive[], editorTree = false): PoseContext {
  return {
    drives,
    drivePath: (p) => drives.find((d) => NodeRegistry.computeNodePath(d.node) === p) ?? null,
    editorTree,
  };
}

function transformOf(o: Object3D): number[] {
  return [...o.position.toArray(), ...o.quaternion.toArray(), ...o.matrix.elements, ...o.matrixWorld.elements];
}

function driveState(d: RVDrive): unknown[] {
  return [d.currentPosition, d.currentSpeed, d.targetPosition, d.isRunning, d.discontinuityRev, d.travelOdometer];
}

describe('withPose — state-free, exact restore', () => {
  it('sets the axis for fn only and restores position/quaternion/matrices exactly; drive fields untouched', () => {
    const scene = new Scene();
    const lin = makeDrive(scene, 'Slide', DriveDirection.LinearX);
    const rot = makeDrive(scene, 'Turn', DriveDirection.RotationZ);
    lin.currentPosition = 12; lin.applyToNode();
    scene.updateMatrixWorld(true);
    const before = [transformOf(lin.node), transformOf(rot.node)];
    const stateBefore = [driveState(lin), driveState(rot)];
    const seen: Vector3[] = [];
    const { result, axes } = withPose(ctxOf([lin, rot]), { Slide: 100, Turn: 90 }, () => {
      seen.push(lin.node.getWorldPosition(new Vector3()));
      return rot.node.quaternion.clone();
    });
    expect(axes.map((a) => [a.drive, a.position, a.source])).toEqual([['Slide', 100, 'explicit'], ['Turn', 90, 'explicit']]);
    // glTF LinearX travels along -X (rv-coordinate-utils): 100 mm → 0.1 m.
    expect(Math.abs(seen[0].x)).toBeCloseTo(0.1, 9);
    expect(result.angleTo(rot.node.quaternion)).not.toBe(0);
    expect([transformOf(lin.node), transformOf(rot.node)]).toEqual(before);
    expect([driveState(lin), driveState(rot)]).toEqual(stateBefore);
  });

  it('restores exactly when fn throws', () => {
    const scene = new Scene();
    const lin = makeDrive(scene, 'Slide', DriveDirection.LinearY);
    scene.updateMatrixWorld(true);
    const before = transformOf(lin.node);
    expect(() => withPose(ctxOf([lin]), { Slide: 50 }, () => { throw new Error('boom'); })).toThrow('boom');
    expect(transformOf(lin.node)).toEqual(before);
  });

  it('an empty pose just runs fn; an unknown drive or a non-number is refused before anything moves', () => {
    const scene = new Scene();
    const lin = makeDrive(scene, 'Slide', DriveDirection.LinearX);
    expect(withPose(ctxOf([lin]), {}, () => 7)).toEqual({ result: 7, axes: [] });
    expect(() => withPose(ctxOf([lin]), { Nope: 1 }, () => 0)).toThrow(PoseError);
    try { withPose(ctxOf([lin]), { Nope: 1 }, () => 0); } catch (e) { expect((e as PoseError).code).toBe('pose-unknown-drive'); }
    try { withPose(ctxOf([lin]), { Slide: Number.NaN }, () => 0); } catch (e) { expect((e as PoseError).code).toBe('pose-invalid-value'); }
  });

  it('refuses a pose in the editor tree (pose-requires-runtime) but measures without one', () => {
    const scene = new Scene();
    const lin = makeDrive(scene, 'Slide', DriveDirection.LinearX);
    expect(() => resolvePose(ctxOf([lin], true), { Slide: 1 })).toThrow(/runtime/);
    try { withPose(ctxOf([lin], true), { Slide: 1 }, () => 0); } catch (e) { expect((e as PoseError).code).toBe('pose-requires-runtime'); }
    expect(withPose(ctxOf([lin], true), {}, () => 'ok').result).toBe('ok');
  });
});

describe('withPose — a running acceleration profile is not disturbed', () => {
  it('tick for tick identical to an untouched control run', () => {
    const sA = new Scene();
    const sB = new Scene();
    const cfg = { TargetSpeed: 400, Acceleration: 800, UseAcceleration: true };
    const a = makeDrive(sA, 'Axis', DriveDirection.LinearZ, cfg);
    const b = makeDrive(sB, 'Axis', DriveDirection.LinearZ, cfg);
    a.startMove(300);
    b.startMove(300);
    const speeds: number[] = [];
    for (let t = 0; t < 90; t++) {
      a.update(DT);
      b.update(DT);
      // A pose check every tick, at a far-away position, on A only.
      withPose(ctxOf([a]), { Axis: -500 + t }, () => a.node.getWorldPosition(new Vector3()));
      expect(driveState(a)).toEqual(driveState(b));
      expect(a.node.position.toArray()).toEqual(b.node.position.toArray());
      speeds.push(a.currentSpeed);
    }
    expect(a.currentPosition).toBeGreaterThan(0);
    // The checks ran DURING the ramp: intermediate speeds between 0 and TargetSpeed were seen.
    expect(speeds.some((v) => v > 0 && v < 400)).toBe(true);
  });
});

describe('withPose — nested axes', () => {
  it('parents first: the child is computed in the posed parent frame, equal to applyToNode', () => {
    const build = () => {
      const scene = new Scene();
      const base = new Object3D();
      base.scale.set(0.001, 0.001, 0.001); // a CAD subtree in millimetres
      scene.add(base);
      const turn = makeDrive(base, 'Turn', DriveDirection.RotationY);
      const slide = makeDrive(turn.node, 'Slide', DriveDirection.LinearX);
      scene.updateMatrixWorld(true);
      return { scene, turn, slide };
    };
    const posed = build();
    const control = build();
    // Pose keys in "wrong" order: the adapter sorts parents first.
    const { result } = withPose(ctxOf([posed.slide, posed.turn]), { Slide: 250, Turn: 90 }, () =>
      posed.slide.node.getWorldPosition(new Vector3()));
    control.turn.currentPosition = 90; control.turn.applyToNode();
    control.scene.updateMatrixWorld(true);
    control.slide.currentPosition = 250; control.slide.applyToNode();
    control.scene.updateMatrixWorld(true);
    const expected = control.slide.node.getWorldPosition(new Vector3());
    expect(result.distanceTo(expected)).toBeLessThan(1e-9);
    expect(expected.length()).toBeGreaterThan(1e-4);
  });
});

describe('withPose — couplings', () => {
  function gearRig() {
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Root';
    scene.add(root);
    const master = makeDrive(root, 'Master', DriveDirection.LinearX);
    const slave = makeDrive(root, 'Slave', DriveDirection.LinearX);
    const registry = new NodeRegistry();
    for (const d of [master, slave]) {
      const p = NodeRegistry.computeNodePath(d.node);
      registry.registerNode(p, d.node);
      registry.register('Drive', p, d);
    }
    const gear = new RVDriveGear(slave.node);
    gear.MasterDrive = master;
    gear.GearFactor = -2;
    gear.Offset = 5;
    const ctx: ComponentContext = { registry, signalStore: new SignalStore(), scene, transportManager: new RVTransportManager(), root };
    gear.init(ctx);
    scene.updateMatrixWorld(true);
    return { scene, master, slave };
  }

  it('a Drive_Gear slave follows its posed master (master × factor + offset), and is restored', () => {
    const { master, slave } = gearRig();
    const before = transformOf(slave.node);
    const { result, axes } = withPose(ctxOf([master, slave]), { Master: 10 }, () => slave.node.position.x);
    expect(axes).toEqual([
      { drive: 'Master', position: 10, source: 'explicit' },
      { drive: 'Slave', position: -15, source: 'gear' },
    ]);
    // LinearX = -X in glTF space: -15 mm → +0.015 m.
    expect(result).toBeCloseTo(0.015, 9);
    expect(transformOf(slave.node)).toEqual(before);
    expect(slave.currentPosition).toBe(0);
  });

  it('an explicitly posed slave wins over the gear', () => {
    const { master, slave } = gearRig();
    const { axes } = withPose(ctxOf([master, slave]), { Master: 10, Slave: 1 }, () => 0);
    expect(axes.find((a) => a.drive === 'Slave')).toEqual({ drive: 'Slave', position: 1, source: 'explicit' });
  });

  it('another coupling to a posed axis is refused unless that axis is posed too', () => {
    const scene = new Scene();
    const leader = makeDrive(scene, 'Leader', DriveDirection.LinearX);
    const follower = makeDrive(scene, 'Follower', DriveDirection.LinearY);
    class FollowLeader implements IDriveBehavior {
      constructor(readonly Leader: RVDrive) {}
      update(): void { /* would follow at runtime */ }
    }
    follower.driveBehaviors.push(new FollowLeader(leader));
    try {
      withPose(ctxOf([leader, follower]), { Leader: 5 }, () => 0);
      expect.unreachable();
    } catch (e) {
      expect((e as PoseError).code).toBe('pose-dependency-unsupported');
      expect((e as PoseError).details).toMatchObject({ drive: 'Follower', field: 'Leader' });
    }
    expect(withPose(ctxOf([leader, follower]), { Leader: 5, Follower: 0 }, () => 'ok').result).toBe('ok');
  });
});

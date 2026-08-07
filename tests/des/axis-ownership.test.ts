// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { RVDrive, DriveDirection } from '../../src/core/engine/rv-drive';
import { RVIKPath } from '../../src/core/engine/rv-ik-path';
import { RVIKTarget } from '../../src/core/engine/rv-ik-target';
import { NodeRegistry, type ComponentRef } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { ComponentContext } from '../../src/core/engine/rv-component-registry';
import {
  AxisOwnershipError,
  claimAxes,
  claimedAxisCount,
  releaseAllAxes,
  releaseAxes,
} from '../../src/core/engine/rv-axis-ownership';

const ref = (path: string, componentType: string): ComponentRef => ({
  type: 'ComponentReference', path, componentType,
});

function drive(name = 'A1'): RVDrive {
  const node = new Object3D(); node.name = name;
  const result = new RVDrive(node);
  result.Direction = DriveDirection.RotationZ;
  result.TargetSpeed = 30;
  result.initDrive();
  return result;
}

function runningPath() {
  const registry = new NodeRegistry();
  const store = new SignalStore();
  const robot = new Object3D(); robot.name = 'Robot';
  const axis = drive(); robot.add(axis.node);
  registry.register('Drive', 'Robot/A1', axis);
  robot.userData.realvirtual = { RobotIK: { Axis: [ref('Robot/A1', 'realvirtual.Drive')] } };

  const pathNode = new Object3D(); pathNode.name = 'Path'; robot.add(pathNode);
  const targetNode = new Object3D(); targetNode.name = 'Target'; pathNode.add(targetNode);
  const target = new RVIKTarget(targetNode); target.AxisPos = [90];
  target.init({ registry, signalStore: store } as unknown as ComponentContext);
  registry.register('IKTarget', 'Robot/Path/Target', target);
  pathNode.userData.realvirtual = { IKPath: { Path: [ref('Robot/Path/Target', 'realvirtual.IKTarget')] } };
  const path = new RVIKPath(pathNode);
  path.init({ registry, signalStore: store, root: robot } as unknown as ComponentContext);
  path.startPath();
  return { path, axis };
}

afterEach(() => releaseAllAxes());

describe('axis ownership claim/release', () => {
  it('claims a running IKPath, stops physics, pauses once, and resumes on release', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { path, axis } = runningPath();
    expect(axis.isRunning).toBe(true);
    const owner = { name: 'StationA' };
    claimAxes([axis], owner);
    claimAxes([axis], owner); // idempotent; no second warning
    expect(axis.isRunning).toBe(false);
    expect(axis.positionOverwrite).toBe(true);
    expect(path.getLiveState().OwnershipPaused).toBe(true);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('paused'))).toHaveLength(1);

    releaseAxes(owner);
    expect(axis.positionOverwrite).toBe(false);
    expect(path.getLiveState().OwnershipPaused).toBe(false);
    expect(axis.isRunning).toBe(true);
    path.dispose();
    warn.mockRestore();
  });

  it('rejects a competing station atomically and deterministically', () => {
    const a = drive('A1');
    const b = drive('A2');
    const first = { name: 'StationA' };
    const second = { name: 'StationB' };
    claimAxes([b], first);
    expect(() => claimAxes([a, b], second)).toThrow(AxisOwnershipError);
    expect(a.positionOverwrite).toBe(false);
    expect(b.positionOverwrite).toBe(true);
    expect(claimedAxisCount()).toBe(1);
  });

  it.each(['clearMUs', 'reset', 'dispose'] as const)(
    'auto-releases claims/overwrites/tweens on %s',
    (action) => {
      const axis = drive();
      const owner = { name: action };
      const runner = new DESRunner();
      claimAxes([axis], owner);
      runner.getTweenRegistry().addDrive(
        { setPosition(value) { axis.currentPosition = value; } },
        0, 10, 0, 10,
        { writePolicy: 'finalOnly' },
      );
      runner[action]();
      expect(claimedAxisCount()).toBe(0);
      expect(axis.positionOverwrite).toBe(false);
      expect(runner.getTweenRegistry().activeCount).toBe(0);
      if (action !== 'dispose') runner.dispose();
    },
  );
});

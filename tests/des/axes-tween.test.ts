// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import type { TweenSpec } from '../../src/core/material-flow/material-flow-self';

function fixture() {
  const root = new Object3D(); root.name = 'Cell';
  const robot = new Object3D(); robot.name = 'Robot'; root.add(robot);
  const registry = new NodeRegistry();
  const drives = ['A1', 'A2'].map((name) => {
    const node = new Object3D(); node.name = name; robot.add(node);
    const drive = new RVDrive(node); drive.initDrive();
    registry.register('Drive', `Cell/Robot/${name}`, drive);
    return drive;
  });
  const runner = new DESRunner();
  (runner as unknown as { _topology: unknown })._topology = {
    root,
    host: { drives, registry },
  };
  const attach = (tween: TweenSpec['tween'], duration: number) =>
    (runner as unknown as {
      _attachTweensFromData(data: unknown, duration: number): unknown[];
    })._attachTweensFromData({ tween }, duration);
  return { runner, drives, attach };
}

describe('TweenSpec axes', () => {
  it('staggers normalized phase windows while axes in one phase share the window', () => {
    const { runner, drives, attach } = fixture();
    attach({
      kind: 'axes', anchorRef: 'Cell/Robot', ease: 'linear', phases: [
        { at0: 0, at1: 0.25, axes: [
          { driveRef: 'Cell/Robot/A1', from: 0, to: 10 },
          { driveRef: 'Cell/Robot/A2', from: 0, to: 20 },
        ] },
        { at0: 0.5, at1: 1, axes: [
          { driveRef: 'Cell/Robot/A1', from: 10, to: 30 },
          { driveRef: 'Cell/Robot/A2', from: 20, to: 40 },
        ] },
      ],
    }, 4);
    expect(runner.getTweenRegistry().activeCount).toBe(4);
    runner.getTweenRegistry().onRender(0.5, 'animated', false);
    expect(drives[0].currentPosition).toBeCloseTo(5);
    expect(drives[1].currentPosition).toBeCloseTo(10);
    runner.getTweenRegistry().onRender(3, 'animated', false);
    expect(drives[0].currentPosition).toBeCloseTo(20);
    expect(drives[1].currentPosition).toBeCloseTo(30);
  });

  it('is JSON round-trip safe through driveRef paths', () => {
    const spec: TweenSpec = { tween: {
      kind: 'axes', anchorRef: 'Cell/Robot', ease: 'scurve',
      phases: [{ at0: 0, at1: 1, axes: [{ driveRef: 'Cell/Robot/A1', from: 1, to: 2 }] }],
    } };
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec);
  });

  it('skips a dangling driveRef with one warning while other axes still play', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runner, drives, attach } = fixture();
    const tween: TweenSpec['tween'] = {
      kind: 'axes', anchorRef: 'Cell/Robot', phases: [{ at0: 0, at1: 1, axes: [
        { driveRef: 'Cell/Robot/Missing', from: 0, to: 99 },
        { driveRef: 'Cell/Robot/A1', from: 0, to: 10 },
      ] }],
    };
    attach(tween, 1);
    attach(tween, 1);
    runner.getTweenRegistry().onRender(1, 'animated', false);
    expect(drives[0].currentPosition).toBeCloseTo(10);
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('Missing'))).toHaveLength(1);
    warn.mockRestore();
  });
});

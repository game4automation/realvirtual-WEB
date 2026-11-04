// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { getProblems } from '../../src/core/hmi/problems-store';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { runnerFixture } from './runner-fixture';

it.each(['position', 'running', 'speed', 'target'] as const)('refuses an unclaimed viewer drive with %s state; a participant may claim it', state => {
  const scene = new Scene();
  const node = new Object3D(); node.name = 'HiddenLift'; scene.add(node);
  const f = runnerFixture(scene);
  const drive = new RVDrive(node); drive.initDrive();
  if (state === 'position') drive.currentPosition = 482;
  if (state === 'running') { drive.isRunning = true; drive.targetPosition = 100; }
  if (state === 'speed') drive.currentSpeed = 5;
  if (state === 'target') drive.targetPosition = 100;
  // The topology host is deliberately structural in this node fixture.
  (f.host as { drives: RVDrive[] }).drives.push(drive);
  f.runner.start([], { root: scene, host: f.host });
  expect(() => f.runner.fullSnapshot()).toThrow(/des-state-not-declared.*HiddenLift/);
  const off = f.runner.registerSnapshotProvider('claimed-test', () => [{
    key: 'test.drive', version: 1, claimsDrives: () => [drive], capture: () => drive.currentPosition,
    validate: () => [], prepare: x => x, commit: () => {},
  }]);
  try { expect(() => f.runner.fullSnapshot()).not.toThrow(); } finally { off(); }
});

it('refuses restore after an unclaimed drive moves without changing the world', () => {
  const scene = new Scene();
  const node = new Object3D(); node.name = 'HiddenLift'; scene.add(node);
  const f = runnerFixture(scene);
  const drive = new RVDrive(node); drive.initDrive();
  (f.host as { drives: RVDrive[] }).drives.push(drive);
  f.runner.start([], { root: scene, host: f.host });
  const before = f.runner.fullSnapshot();
  drive.currentPosition = drive.StartPosition + 482;
  expect(() => f.runner.restoreFull(before)).toThrow(/des-state-not-declared.*HiddenLift/);
  expect(drive.currentPosition).toBe(drive.StartPosition + 482);
  expect(getProblems().some(p => p.code === 'des-state-not-declared')).toBe(true);
  drive.currentPosition = drive.StartPosition;
  expect(f.runner.fullSnapshot()).toEqual(before);
});

it('does not refuse a parked drive with a pending no-op command (isRunning, target = position = start, speed 0)', () => {
  const scene = new Scene();
  const node = new Object3D(); node.name = 'ParkedLift'; scene.add(node);
  const f = runnerFixture(scene);
  const drive = new RVDrive(node); drive.initDrive();
  drive.startMove(drive.StartPosition); // what ChainTransfer setup does with moveTo(0)
  expect(drive.isRunning).toBe(true);
  (f.host as { drives: RVDrive[] }).drives.push(drive);
  f.runner.start([], { root: scene, host: f.host });
  const snap = f.runner.fullSnapshot();
  expect(() => f.runner.restoreFull(snap)).not.toThrow();
  // Negative probe: the same drive heading somewhere else is refused again.
  drive.startMove(drive.StartPosition + 50);
  expect(() => f.runner.fullSnapshot()).toThrow(/des-state-not-declared.*ParkedLift/);
});

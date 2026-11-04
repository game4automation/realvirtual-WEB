// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { createRobotLoadingDemoScene } from '../../src/plugins/des/material-flow/demo-robot-loading';
import '../../src/behaviors/ChainTransfer';
import '../../src/behaviors/Agv';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { runnerFixture } from './runner-fixture';
import { clearShared } from '../helpers/agv-harness';
afterEach(() => clearShared());
import { robotDemoWorld } from './continuation-world-fixture';

/** Headless demo content available in this checkout. des-course-demo.test.ts
 * loads AGVDemo.glb in WebGL; Agv snapshots are supported in production.
 */
describe('Standard-Demo headless continuation (robot-loading reference)', () => {
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    it.each([0.25, 7, 30])(`${mode}: exact envelope, parts, KPIs and trace at cut %s`, async T => {
      await assertContinuation({ buildWorld: robotDemoWorld, mode, T, TPrime: 80, T2: 120 });
    });
  }
  it.each(['Agv'])('demo with %s allows capture and restore', type => {
    const demo = createRobotLoadingDemoScene({ durationSeconds: 600 });
    {
      const node = new Object3D(); node.name = 'Vehicle';
      node.userData.realvirtual = { [type]: { Active: false } };
      const path = new Object3D(); path.name = 'Path';
      path.userData.realvirtual = { Path: { type: 'Path', id: 'SnapshotProbePath',
        segments: [{ kind: 'line', from: [0, 0, 0], to: [0, 0, 3] }] } };
      node.add(path); demo.root.add(node);
    }
    const { runner, host } = runnerFixture(demo.root);
    runner.start([], { root: demo.root, host });
    expect(runner.liveInstances.some(i => i.def.type === type)).toBe(true);
    const snapshot = runner.fullSnapshot();
    expect(() => runner.restoreFull(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
    // The v4 envelope is the contract (the legacy manager dump keeps a `mu: null`
    // hook field the codec drops; the dispatcher treats null and absent alike).
    expect(JSON.stringify(runner.fullSnapshot())).toBe(JSON.stringify(snapshot));
  });
});

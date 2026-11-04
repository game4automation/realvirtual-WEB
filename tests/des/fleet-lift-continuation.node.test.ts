// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import { Object3D } from 'three';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { DesLift } from '../../src/plugins/des/fleet/des-lift';
import { DesSimClock } from '../../src/plugins/des/fleet/des-sim-clock';
import { fleetClockParticipant } from '../../src/plugins/des/fleet/des-clock-participant';
import { fleetLiftParticipant } from '../../src/plugins/fleet-job-participants';
import { robotDemoWorld, continuationWorld } from './continuation-world-fixture';
import { assertContinuation, ContinuationMismatch } from '../helpers/des-continuation-harness';

function buildWorld(hiddenState = false) {
  const runner = robotDemoWorld().runner as DESRunner;
  const clock = new DesSimClock(runner, () => {});
  // Independent harness worlds need the same initial persisted generation.
  clock.restoreGeneration(1);
  const drive = new RVDrive(new Object3D());
  drive.TargetSpeed = 50;
  drive.initDrive();
  const lift = new DesLift(() => runner, clock, new Map([['V', drive]]));
  let hidden = 0;
  lift.setDoneHandler((v, done) => {
    hidden++;
    lift.move(v, done.cont.k === 'none' ? 100 : 0, 50,
      { e: done.e + 1, hj: 0, cont: { k: done.cont.k === 'none' ? 'finishStay' : 'none' } });
  });
  runner.registerSnapshotProvider('test.lift', () => [fleetClockParticipant(clock), fleetLiftParticipant(lift)]);
  lift.move('V', 100, 50, { e: 1, hj: 0, cont: { k: 'none' } });
  const world = continuationWorld(runner);
  return { ...world, step(toT: number) {
    while (runner.getManager().currentTime < toT) {
      const next = Math.min(toT, runner.getManager().currentTime + 0.25);
      world.step(next); runner.getTweenRegistry().onRender(next, 'animated', false);
    }
  }, kpis: () => ({ ...world.kpis(), 'lift.position': drive.currentPosition, ...(hiddenState ? { 'fleet.lift': hidden } : {}) }),
    dispose: () => { lift.dispose(); clock.dispose(); runner.dispose(); } };
}
describe('fleet lift continuation', () => {
  for (const cancel of [false, true]) {
    it(cancel ? 'restored cancel preserves a foreign tween' : 'restores visual motion at the original end time', () => {
      const runner = robotDemoWorld().runner as DESRunner;
      const clock = new DesSimClock(runner, () => {});
      clock.restoreGeneration(1);
      const drive = new RVDrive(new Object3D());
      drive.initDrive();
      drive.currentPosition = 0;
      const lift = new DesLift(() => runner, clock, new Map([['V', drive]]));
      const world = continuationWorld(runner);
      runner.registerSnapshotProvider('test.lift', () => [fleetClockParticipant(clock), fleetLiftParticipant(lift)]);
      let completed = 0;
      lift.setDoneHandler(() => completed++);
      lift.move('V', 100, 50, { e: 1, hj: 0, cont: { k: 'none' } });
      try {
        world.step(1);
        const saved = runner.fullSnapshot();
        const position = drive.currentPosition;
        world.step(3);
        runner.restoreFull(saved);
        expect(drive.currentPosition).toBe(position);
        const tweens = runner.getTweenRegistry();
        tweens.onRender(1.5, 'animated', false);
        expect(drive.currentPosition).toBeCloseTo(75);
        if (cancel) {
          let foreign = 0;
          tweens.addDrive({ setPosition(v: number) { foreign = v; } }, 0, 10, 1, 1);
          lift.cancel('V');
          tweens.onRender(2, 'animated', false);
          expect(foreign).toBe(10);
          completed = 0;
          world.step(2);
          expect(completed).toBe(0);
        } else {
          completed = 0;
          tweens.onRender(2, 'animated', false);
          expect(drive.currentPosition).toBe(100);
          world.step(2);
          expect(completed).toBe(1);
        }
      } finally { lift.dispose(); clock.dispose(); runner.dispose(); }
    });
  }

  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    it(mode + ': restores chained strokes', async () => {
      await assertContinuation({ buildWorld, mode, T: 1, TPrime: 7, T2: 12 });
    });
    it(mode + ': detects hidden state', async () => {
      await expect(assertContinuation({ buildWorld: () => buildWorld(true), mode, T: 3, TPrime: 9, T2: 12 }))
        .rejects.toBeInstanceOf(ContinuationMismatch);
    });
  }
});

it('captures resting lift positions and refuses unknown vehicles or non-finite positions', () => {
  const runner = robotDemoWorld().runner as DESRunner;
  const clock = new DesSimClock(runner, () => {});
  const drive = new RVDrive(new Object3D()); drive.initDrive();
  const lift = new DesLift(() => runner, clock, new Map([['V', drive]]));
  try {
    drive.currentPosition = 482;
    const saved = lift.exportState();
    drive.currentPosition = 150;
    lift.swapState(lift.prepareState(JSON.parse(JSON.stringify(saved))));
    expect(drive.currentPosition).toBe(482);
    expect(lift.claimsDrives()).toEqual([drive]);
    expect(lift.validateState({ strokes: [], positions: [['foreign', 482]] })).not.toEqual([]);
    expect(lift.validateState({ strokes: [], positions: [['V', Infinity]] })).not.toEqual([]);
  } finally { lift.dispose(); clock.dispose(); runner.dispose(); }
});

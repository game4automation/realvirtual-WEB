// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import { DesSimClock } from '../../src/plugins/des/fleet/des-sim-clock';
import { fleetClockParticipant } from '../../src/plugins/des/fleet/des-clock-participant';
import { fleetDispatcherParticipant } from '../../src/plugins/fleet-job-participants';
import { OrderPool, type PreparedOrderPool } from '../../src/core/fleet/core/orders';
import { dispatcherFixture, dispatchEnv, vehicles } from '../fleet/fleet-dispatcher-fixture';
import { assertContinuation, ContinuationMismatch } from '../helpers/des-continuation-harness';
import { robotDemoWorld, continuationWorld } from './continuation-world-fixture';

function fleetWorld(hiddenState = false) {
  const runner = robotDemoWorld().runner as unknown as DESRunner;
  const clock = new DesSimClock(runner), dispatcher = dispatcherFixture();
  clock.restoreGeneration(1);
  let hidden = 0;
  clock.registerAction('test.dispatcher.tick', data => {
    const n = data as number;
    hidden++;
    if (n % 3 === 1) dispatcher.orders.add({ source: 's0', mu: 'mu' + n }, n);
    dispatcher.dispatch(vehicles, { ...dispatchEnv, t: n });
    if (n % 3 === 2) dispatcher.picked('v', n);
    if (n % 3 === 0) dispatcher.delivered('v', n);
    if (n < 50) clock.scheduleAction(n + 1, 'test.dispatcher.tick', n + 1);
  });
  runner.registerSnapshotProvider('test:fleet', () => [fleetClockParticipant(clock), {
    key: 'fleet.orders', version: 1, owner: dispatcher.orders,
    stateKeys: ['nextId', 'completed', 'open', 'bySource'], services: ['completionListeners'],
    capture: () => dispatcher.orders.exportState(), validate: s => OrderPool.validateState(s),
    prepare: s => dispatcher.orders.prepareState(s),
    commit: p => dispatcher.orders.swapState(p as PreparedOrderPool),
  }, fleetDispatcherParticipant(dispatcher)]);
  clock.scheduleAction(1, 'test.dispatcher.tick', 1);
  const world = continuationWorld(runner);
  return { ...world, kpis: () => ({ ...world.kpis(), 'fleet.test': {
    completed: dispatcher.orders.doneCount, ...(hiddenState ? { hidden } : {}) } }),
    dispose: () => { clock.dispose(); runner.dispose(); } };
}

describe('fleet dispatcher continuation', () => {
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    it.each([7.25, 8.25, 12.25])(`${mode}: continues at %s`, async T => {
      await assertContinuation({ buildWorld: fleetWorld, mode, T, TPrime: T + 5, T2: 30 });
    });
    it(`${mode}: detects undeclared driver state`, async () => {
      await expect(assertContinuation({ buildWorld: () => fleetWorld(true), mode,
        T: 8.25, TPrime: 15, T2: 30 })).rejects.toBeInstanceOf(ContinuationMismatch);
    });
  }
});

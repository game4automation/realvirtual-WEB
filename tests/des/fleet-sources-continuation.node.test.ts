// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import { DesSimClock } from '../../src/plugins/des/fleet/des-sim-clock';
import { fleetClockParticipant } from '../../src/plugins/des/fleet/des-clock-participant';
import { fleetSourceParticipants } from '../../src/plugins/fleet-job-participants';
import { TaktSource, PauseSource } from '../../src/core/fleet/core/order-sources';
import { WaitWatch } from '../../src/core/fleet/exec/wait-watch';
import { SFC32 } from '../../src/core/rv-rng-distribution';
import { assertContinuation, ContinuationMismatch } from '../helpers/des-continuation-harness';
import { robotDemoWorld, continuationWorld } from './continuation-world-fixture';

function sourceWorld(hiddenState = false) {
  const runner = robotDemoWorld().runner as unknown as DESRunner;
  const clock = new DesSimClock(runner);
  clock.restoreGeneration(1);
  let seen: string[] = [], hidden = 0;
  const note = (s: string) => { seen.push(`${clock.now()}:${s}`); hidden++; };
  const wait = new WaitWatch({ clock, defaultLimitSec: 3, problems: { report: () => note('report'), clear: () => note('clear') },
    onTimeout: () => note('timeout') });
  const takt = new TaktSource(clock, { intervalSec: 2, phaseSec: [1], stochastic: true }, 1,
    { headFree: () => true, release: () => { note('release'); wait.end('V', 'fork'); wait.begin('V', 'fork'); }, blocked: () => note('blocked') }, new SFC32(123));
  const pause = new PauseSource(clock, { everySec: 7, durationSec: 2, offsetSec: [2] }, 1,
    { setRun: (_, run) => note(`run:${run}`), wake: () => note('wake'), resumed: () => note('resumed') });
  runner.registerSnapshotProvider('test:sources', () => [fleetClockParticipant(clock),
    ...fleetSourceParticipants({ takt, pause, wait }), {
      key: 'test.driver', version: 1, capture: () => ({ seen }), validate: () => [],
      prepare: json => [...(json as { seen: string[] }).seen], commit: p => { seen = p as string[]; },
    }]);
  takt.start(); pause.start(); wait.begin('V', 'fork');
  const world = continuationWorld(runner);
  return { ...world, kpis: () => ({ ...world.kpis(), 'test.driver': { seen: [...seen], ...(hiddenState ? { hidden } : {}) } }),
    dispose: () => { clock.dispose(); runner.dispose(); } };
}

describe('fleet sources continuation', () => {
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    it(`${mode}: preserves queue, stochastic releases, waits and pauses`, async () => {
      await assertContinuation({ buildWorld: () => sourceWorld(), mode, T: 7.25, TPrime: 12, T2: 25 });
    });
    it(`${mode}: detects hidden driver state`, async () => {
      await expect(assertContinuation({ buildWorld: () => sourceWorld(true), mode,
        T: 7.25, TPrime: 12, T2: 25 })).rejects.toBeInstanceOf(ContinuationMismatch);
    });
  }
});

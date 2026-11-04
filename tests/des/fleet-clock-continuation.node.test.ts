// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import { registerAction } from '../../src/plugins/des/rv-des-named-actions';
import { DesSimClock } from '../../src/plugins/des/fleet/des-sim-clock';
import { fleetClockParticipant } from '../../src/plugins/des/fleet/des-clock-participant';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { robotDemoWorld, continuationWorld } from './continuation-world-fixture';

registerAction('Fleet.Test.Model', () => {});

function clockWorld() {
  const runner = robotDemoWorld().runner as unknown as DESRunner;
  const clock = new DesSimClock(runner);
  // Independent harness worlds need the same initial persisted generation.
  clock.restoreGeneration(1);
  let seen: number[] = [];
  clock.registerAction('test.tick', data => {
    const n = data as number;
    seen.push(n);
    if (n < 40) clock.scheduleAction(n + 1, 'test.tick', n + 1);
  });
  runner.registerSnapshotProvider('test:clock', () => [fleetClockParticipant(clock), {
    key: 'test.driver', version: 1,
    capture: () => ({ seen }),
    validate: () => [],
    prepare: json => [...(json as { seen: number[] }).seen],
    commit: prepared => { seen = prepared as number[]; },
  }]);
  clock.scheduleAction(1, 'test.tick', 1);
  const world = continuationWorld(runner);
  return { ...world, runner, clock, seen: () => seen,
    kpis: () => ({ ...world.kpis(), 'test.driver': [...seen] }),
    dispose: () => { clock.dispose(); runner.dispose(); } };
}

describe('fleet clock continuation', () => {
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    it(`${mode}: continues self-rearming actions exactly`, async () => {
      await assertContinuation({ buildWorld: clockWorld, mode, T: 7.25, TPrime: 12, T2: 20 });
    });
  }
  it('preserves generations and cancels a restored queue handle directly', () => {
    const world = clockWorld();
    try {
      world.step(7.25);
      const timer = world.clock.scheduleAction(10, 'test.tick', 999);
      const saved = world.runner.fullSnapshot();
      const generation = world.clock.generation;
      world.step(9);
      world.runner.restoreFull(saved);
      expect(world.clock.generation).toBe(generation);
      world.clock.cancel(timer);
      world.step(20);
      expect(world.seen()).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    } finally { world.dispose(); }
  });
  it('does not cancel a model event which reuses a discarded handle id', () => {
    const world = clockWorld();
    try {
      const saved = world.runner.fullSnapshot();
      const stale = world.clock.scheduleAction(10, 'test.tick', 999);
      world.runner.restoreFull(saved);
      const manager = world.runner.getManager();
      const id = manager.scheduleEvent(10, 'Fleet.Test.Model', -1, -1);
      expect(id).toBe(stale.id);
      world.clock.cancel(stale);
      expect(manager.actionNameOf(id)).toBe('Fleet.Test.Model');
      world.runner.restoreFull(saved);
      const reused = world.clock.scheduleAction(10, 'test.other', 1);
      expect(reused.id).toBe(stale.id);
      // Documented residual: same-generation Fleet.Action ids remain cancellable.
      world.clock.cancel(stale);
      expect(manager.actionNameOf(reused.id)).toBeUndefined();
      world.runner.restoreFull(saved);
      const foreign = manager.scheduleEvent(10, 'Fleet.Action', -1, -1, 0,
        { g: world.clock.generation + 1, k: 'test.other' });
      world.clock.cancel(stale);
      expect(manager.actionNameOf(foreign)).toBe('Fleet.Action');
    } finally { world.dispose(); }
  });
  it('refuses capture with a pending closure and permits capture after cancellation', () => {
    const world = clockWorld();
    try {
      const h = world.clock.schedule(10, () => {});
      // The queue contract refuses the closure event first (fleet.clock is no replan-on-restore owner);
      // the participant's own refusal is the second line of defence.
      expect(() => world.runner.fullSnapshot()).toThrow(/des-snapshot-contract/);
      expect(() => (world.clock as unknown as { exportState(): unknown }).exportState())
        .toThrow('fleet.clock: 1 non-persistable closure events pending');
      world.clock.cancel(h);
      expect(() => world.runner.fullSnapshot()).not.toThrow();
    } finally { world.dispose(); }
  });
  it('clamps an action in the past to now like scheduleCallback (a rearm after reset used t=0)', () => {
    const world = clockWorld();
    try {
      void world.step(5);
      const h = world.clock.scheduleAction(0, 'test.tick', 99);
      expect(h.id).toBeGreaterThanOrEqual(0);
    } finally { world.dispose(); }
  });
});

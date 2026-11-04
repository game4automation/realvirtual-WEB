// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { BoxGeometry, Mesh, Object3D } from 'three';
import '../../src/behaviors/Conveyor';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import type { SnapshotJson } from '../../src/plugins/des/rv-snapshot-contract';
import { assertContinuation } from '../helpers/des-continuation-harness';
import { runnerFixture } from './runner-fixture';
import { continuationWorld } from './continuation-world-fixture';

function buildWorld(runEdge = false) {
  resetDESMUCounter();
  const root = new Object3D();
  for (const [name, type, props] of [
    ['Source', 'Source', { Interval: 1, LimitNumber: true, MaxNumberMUs: 3 }],
    ['Belt', 'Conveyor', {}], ['Downstream', 'Station', { ProcessingTime: runEdge ? 1 : 1000, MaxCapacity: 1 }],
    ['Sink', 'Sink', {}],
  ] as const) {
    const node = new Object3D(); node.name = name; node.userData.realvirtual = { [type]: props };
    if (name === 'Belt') {
      const belt = new Mesh(new BoxGeometry(1, 0.1, 1)); belt.name = 'Transport-X';
      const sensor = new Object3D(); sensor.name = 'Sensor'; node.add(belt, sensor);
    }
    root.add(node);
  }
  const f = runnerFixture(root);
  const [source, belt, downstream, sink] = ['Source', 'Belt', 'Downstream', 'Sink'].map(n => f.components.find(c => c.node.name === n)!);
  source.nextComponents = [belt]; belt.previousComponents = [source];
  belt.nextComponents = [downstream]; downstream.previousComponents = [belt];
  downstream.nextComponents = [sink]; sink.previousComponents = [downstream];
  f.runner.start([], { root, host: f.host });
  if (runEdge) belt.self.signals.set('Flow.Run', false);
  const base = continuationWorld(f.runner);
  return { ...base, runner: f.runner, belt,
    step(t: number) {
      while (f.manager.currentTime < t) {
        const before = f.manager.currentTime;
        const next = Math.min(before + 0.25, t);
        base.step(next);
        if (runEdge && before < 20 && next === 20) belt.self.signals.set('Flow.Run', true);
        f.runner.tick(0); f.runner.lateTick(0);
      }
    },
  };
}

for (const runEdge of [false, true]) {
  it(`restore preserves parked MU counts and statistics (Run edge: ${runEdge})`, async () => {
    const w = buildWorld(runEdge);
    try {
      w.step(10);
      expect((w.belt.self.local as unknown as { blockedMUs: unknown[] }).blockedMUs.length).toBeGreaterThan(0);
      const before = JSON.parse(JSON.stringify(w.runner.fullSnapshot()));
      const stats = w.belt.getStatistics();
      const raw = w.belt.toSnapshot();
      expect(raw.stateStartTime).toBeLessThan(10);
      expect(stats.states[raw.currentStateName].duration).toBe(
        (raw.stateTimings[raw.currentStateName]?.duration ?? 0) + (10 - raw.stateStartTime));
      // Capturing later must not book any of the still-open interval.
      w.step(10.25);
      expect(w.belt.toSnapshot().stateTimings).toEqual(raw.stateTimings);
      expect(w.belt.toSnapshot().stateStartTime).toBe(raw.stateStartTime);
      w.runner.restoreFull(before);
      expect(w.belt.getStatistics()).toEqual(stats);
      // Includes every MU blockedCount, so even one extra failed release is visible.
      expect(w.runner.fullSnapshot()).toEqual(before);
    } finally { w.dispose?.(); }
    for (const mode of ['A', 'B', 'B-immediate'] as const) {
      await assertContinuation({ buildWorld: () => buildWorld(runEdge), mode, T: 10, TPrime: 15, T2: 30 });
    }
  });
}

it.each([NaN, Infinity, 11])('rejects invalid stateStartTime %s before mutation', stateStartTime => {
  const w = buildWorld();
  try {
    w.step(10);
    const before = w.runner.fullSnapshot();
    const changed = structuredClone(before);
    const part = changed.parts.find(p => p.key.endsWith('@Conveyor'))!;
    part.state = { ...(part.state as Record<string, SnapshotJson>), stateStartTime };
    expect(() => w.runner.restoreFull(changed)).toThrow();
    expect(w.runner.fullSnapshot()).toEqual(before);
  } finally { w.dispose?.(); }
});

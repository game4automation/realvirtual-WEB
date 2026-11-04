// SPDX-License-Identifier: AGPL-3.0-only
import type { DESRunner } from '../../src/plugins/des/des-runner';
import type { DESEventQueue } from '../../src/plugins/des/rv-des-event-queue';
import { ACTION_INDEX } from '../../src/plugins/des/rv-des-named-actions';
import type { ContinuationEvent, ContinuationWorld } from '../helpers/des-continuation-harness';
import { createRobotLoadingDemoScene } from '../../src/plugins/des/material-flow/demo-robot-loading';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { runnerFixture } from './runner-fixture';
import '../../src/plugins/des/material-flow/Downtime';
import { Object3D } from 'three';

export function robotDemoWorld(rich = false, rngVersion?: 1 | 2) {
  resetDESMUCounter();
  const demo = createRobotLoadingDemoScene({ palletCount: 2, durationSeconds: 600 });
  if (rich) {
    // Load the indexing belt before its first failure, with a cycle still
    // reserving downstream capacity while the first load is tweening.
    demo.nodes.get('RobotHandling')!.userData.realvirtual.RobotHandling.timePerCycle = 0.5;
    const downtime = new Object3D(); downtime.name = 'IndexFailure';
    downtime.userData.realvirtual = { Downtime: {
      TargetComponentPath: 'IndexingConveyor', MTBF: 7, MTTR: 10, Stochastic: rngVersion !== undefined,
    } };
    demo.root.add(downtime);
    if (rngVersion !== undefined) {
      const late = new Object3D(); late.name = 'LateFailure';
      late.userData.realvirtual = { Downtime: {
        TargetComponentPath: 'RobotHandling', MTBF: 500, MTTR: 10, Stochastic: true,
      } };
      demo.root.add(late);
    }
  }
  const f = runnerFixture(demo.root, demo.masterSeed);
  const byName = new Map(f.runner.liveInstances.map(i => [i.self.root.name, i.adapter]));
  for (const link of demo.logicalConnections) {
    const from = byName.get(link.from)!, to = byName.get(link.to)!;
    if (!from.nextComponents.includes(to)) from.nextComponents.push(to);
    if (!to.previousComponents.includes(from)) to.previousComponents.push(from);
  }
  // The version is a run parameter: clear what binding queued, then select it before start.
  if (rngVersion !== undefined) { f.manager.reset(); f.manager.setRngVersion(rngVersion); }
  f.manager.statResetTime = 20;
  f.runner.start([], { root: demo.root, host: f.host });
  f.manager.scheduleCheckpoint(25);
  f.manager.onCheckpoint = time => f.manager.scheduleCheckpoint(time + 25);
  if (rich) {
    f.signalStore.set('Continuation.Enabled', true);
    f.signalStore.forceSignal('Continuation.Override', 7);
  }
  return continuationWorld(f.runner);
}

/** Test-only queue observation. Reattach on every step because restore swaps queues.
 * No browser imports: browser callers can use their own dispatch recorder instead.
 */
export function continuationWorld(runner: DESRunner, advance?: (dt: number) => void): ContinuationWorld {
  const manager = runner.getManager();
  const events: ContinuationEvent[] = [];
  return {
    runner,
    step(toT) {
      if (manager.currentTime > toT) throw new Error('Cannot step a continuation world backwards');
      const queue = (manager as unknown as { queue: DESEventQueue }).queue;
      const dequeue = queue.dequeue;
      const names = new Map([...ACTION_INDEX].map(([name, index]) => [index, name]));
      const owners = new Map(runner.liveInstances.map(i => [i.adapter.entityId, i.desId!]));
      queue.dequeue = function () {
        const event = dequeue.call(this);
        if (event) events.push({ time: event.time, action: names.get(event.actionIndex)!,
          componentId: owners.get(event.entityId) ?? null, muId: event.muId });
        return event;
      };
      try {
        // Binary-exact quarter-second grid, no rounding of the captured state.
        while (manager.currentTime < toT) {
          const before = manager.currentTime;
          (advance ?? (dt => manager.processAnimated(dt)))(Math.min(0.25, toT - before));
          if (manager.currentTime === before) throw new Error(`World stopped before ${toT}`);
        }
      } finally { queue.dequeue = dequeue; }
    },
    kpis: () => Object.fromEntries(runner.liveInstances.map(i => [i.desId!, i.adapter.getStatistics()])),
    trace: () => events,
    dispose: () => runner.dispose(),
  };
}

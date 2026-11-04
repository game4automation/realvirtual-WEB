// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { defineMaterialFlow } from '../../src/core/material-flow/define-material-flow';
import type { MaterialFlowSelf } from '../../src/core/material-flow/material-flow-self';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { DES } from '../../src/plugins/des/rv-des-api';
import { assertContinuation, compareFullSnapshots, ContinuationMismatch } from '../helpers/des-continuation-harness';
import { lineFixture, runnerFixture } from './runner-fixture';
import { continuationWorld, robotDemoWorld } from './continuation-world-fixture';
import { componentState, muRecords, reservations, tweenState, storedSnapshot } from './snapshot-test-utils';

function lineWorld() {
  resetDESMUCounter();
  const f = lineFixture({ statResetTime: 20 });
  f.manager.scheduleCheckpoint(25);
  f.manager.onCheckpoint = time => f.manager.scheduleCheckpoint(time + 25);
  return continuationWorld(f.runner);
}

type HiddenSelf = MaterialFlowSelf<{ counter: number }>;
const HiddenCounter = defineMaterialFlow<HiddenSelf>({
  type: 'ContinuationHiddenCounter', kind: 'source',
  schema: { poisonAdapter: { type: 'boolean', default: false } },
  state: () => ({ counter: 0 }), continuous: {},
  des: {
    onGenerate(self) {
      if (self.prop.poisonAdapter) {
        const owner = DES.getManager()!.getComponentByPath('HiddenCounter')!;
        if (!Object.hasOwn(owner, 'undeclaredCounter')) Object.defineProperty(owner, 'undeclaredCounter', { value: 42 });
      }
      self.local.counter++;
      self.in(1, 'Generate');
    },
    // Intentionally omit local.counter. It still affects a visible KPI.
    onSnapshot: () => ({}),
  },
});

function hiddenWorld(ownProperty = false) {
  resetDESMUCounter();
  const scene = new Scene(), node = new Object3D(); node.name = 'HiddenCounter';
  node.userData.realvirtual = { [HiddenCounter.type]: { poisonAdapter: ownProperty } }; scene.add(node);
  const f = runnerFixture(scene);
  f.runner.start([], { root: scene, host: f.host });
  const instance = f.runner.liveInstances.find(i => i.def.type === HiddenCounter.type)!;
  const world = continuationWorld(f.runner);
  return { ...world, kpis: () => ({ ...world.kpis(),
    [instance.desId!]: { hiddenCounter: (instance.self as unknown as HiddenSelf).local.counter } }) };
}

describe('DES continuation harness modes', () => {
  for (const mode of ['A', 'B', 'B-immediate'] as const) {
    for (const [scene, buildWorld] of [
      ['source-station-sink with warm-up/checkpoint', lineWorld],
      ['robot/pallet/indexing/path with downtime and signals', () => robotDemoWorld(true)],
    ] as const) {
      it.each([0.25, 8, 30])(`${mode}: ${scene}, cut %s`, async T => {
        await assertContinuation({ buildWorld, mode, T, TPrime: 80, T2: 120 });
      });
    }
    it(`${mode}: identifies an omitted local counter, including immediate restore`, async () => {
      await expect(assertContinuation({ buildWorld: () => hiddenWorld(), mode,
        T: 3, TPrime: 8, T2: 12 })).rejects.toMatchObject({
        code: 'des-state-not-declared', participant: '#HiddenCounter@ContinuationHiddenCounter',
        path: '$.kpis["hiddenCounter"]',
      });
    });
    it(`${mode}: capture guard refuses undeclared adapter own state`, async () => {
      await expect(assertContinuation({ buildWorld: () => hiddenWorld(true), mode,
        T: 3, TPrime: 8, T2: 12 })).rejects.toThrow(
        /des-state-not-declared.*HiddenCounter.*undeclaredCounter/);
    });
  }

  it('rich fixture actually contains nested loads, reservations, live and frozen tweens', async () => {
    const world = robotDemoWorld(true);
    try {
      await world.step(0.25);
      const moving = world.runner.fullSnapshot();
      expect(muRecords(moving).some(mu => (mu.childMUs?.length ?? 0) > 0)).toBe(true);
      expect(muRecords(moving).some(mu => mu.isLoaded)).toBe(true);
      expect(reservations(moving).length).toBeGreaterThan(0);
      await world.step(6);
      expect(tweenState(world.runner.fullSnapshot()).length).toBeGreaterThan(0);
      await world.step(8);
      const frozen = componentState(world.runner.fullSnapshot(), 'IndexingConveyor');
      expect(frozen.frozen?.length).toBeGreaterThan(0);
    } finally { await world.dispose?.(); }
  });

  it('reports the first participant and exact nested JSON path', () => {
    const expected = storedSnapshot(1, { nested: { count: 2 } });
    const actual = storedSnapshot(1, { nested: { count: 3 } });
    try {
      compareFullSnapshots(expected, actual);
      expect.unreachable('comparison must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuationMismatch);
      expect(error).toMatchObject({ code: 'des-state-not-declared', participant: 'test.payload',
        path: '$["state"]["nested"]["count"]', expected: 2, actual: 3 });
    }
  });
  it('Mode A restores into the same live manager, adapters and scene objects', async () => {
    const world = robotDemoWorld(true);
    try {
      const runner = world.runner as ReturnType<typeof runnerFixture>['runner'];
      const manager = runner.getManager();
      const owners = runner.liveInstances.map(i => ({ adapter: i.adapter, node: i.adapter.node, self: i.self }));
      await world.step(8);
      const saved = runner.fullSnapshot();
      await world.step(80);
      runner.restoreFull(saved);
      expect(runner.getManager()).toBe(manager);
      runner.liveInstances.forEach((instance, i) => {
        expect(instance.adapter).toBe(owners[i].adapter);
        expect(instance.adapter.node).toBe(owners[i].node);
        expect(instance.self).toBe(owners[i].self);
      });
    } finally { await world.dispose?.(); }
  });
  it('compares fingerprint and envelope fields without normalizing them away', () => {
    const expected = storedSnapshot(1), actual = storedSnapshot(1);
    (actual.fingerprint as { modelHash: string }).modelHash = 'different';
    expect(() => compareFullSnapshots(expected, actual)).toThrow('des-state-not-declared: envelope');
  });
});

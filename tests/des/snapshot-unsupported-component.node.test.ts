// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import '../../src/behaviors/ChainTransfer';
import '../../src/behaviors/Agv';
import { componentStateKeys, componentServices } from '../../src/plugins/des/rv-des-component-state';
import { whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';
import { runnerFixture } from './runner-fixture';
import { clearShared } from '../helpers/agv-harness';
afterEach(() => clearShared());
it.each(['Agv'])('allows %s with declared adapter fields', type => {
  const scene = new Scene(), node = new Object3D(); node.name = 'AgvInstance';
  node.userData.realvirtual = { [type]: { Active: false } };
  const path = new Object3D(); path.name = 'Path';
  path.userData.realvirtual = { Path: { type: 'Path', id: 'SnapshotProbePath',
    segments: [{ kind: 'line', from: [0, 0, 0], to: [0, 0, 3] }] } };
  node.add(path); scene.add(node);
  const { runner, manager, host } = runnerFixture(scene);
  runner.start([], { root: scene, host });
  expect(runner.liveInstances.some(i => i.def.type === type)).toBe(true);
  const adapter = runner.liveInstances.find(i => i.def.type === type)!.adapter;
  const keys = Reflect.ownKeys(adapter);
  const declared = new Set<string>([...componentStateKeys, ...componentServices]);
  expect(keys.filter(key => typeof key !== 'string' || !declared.has(key))).toEqual([]);
  console.info(type, JSON.stringify({ state: keys.filter(k => componentStateKeys.includes(k as never)),
    services: keys.filter(k => componentServices.includes(k as never)) }));
  const before = manager.currentTime;
  const snapshot = runner.fullSnapshot();
  expect(() => runner.restoreFull(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();

  expect(manager.currentTime).toBe(before);
});
it('captures declared script state with an empty queue', async () => {
  const capture = vi.fn(() => ({ rng: 1, timers: { next: 1, items: [] }, persist: { hidden: 7 } }));
  const { runner, host } = runnerFixture(new Scene(), 42, null, () => [{ path: 'HiddenScript', desId: '#HiddenScript@ScriptCounter', source: 'function setup(self){return {}}',
    adapter: { captureScriptState: capture, restoreScriptState: () => {} } }]);
  const scene = new Scene();
  runner.start([], { root: scene, host: host as never });
  await whenDocumentHashesSettled();
  expect(runner.fullSnapshot().parts.find(p => p.key === '#HiddenScript@ScriptCounter')?.state)
    .toEqual({ rng: 1, timers: { next: 1, items: [] }, persist: { hidden: 7 } });
});

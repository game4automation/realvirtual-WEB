// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import '../../src/behaviors/Source';
import '../../src/behaviors/Sink';
import '../../src/behaviors/Conveyor';
import '../../src/behaviors/OverheadConveyor';
import '../../src/behaviors/Turntable';
import '../../src/behaviors/ChainTransfer';
import '../../src/behaviors/Agv';
import '../../src/plugins/des/material-flow';
import '../../src/plugins/des/material-flow/demo-robot-loading';
import { pathFromNode } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { allMaterialFlows } from '../../src/core/material-flow/registry';
import { componentStateKeys, componentServices } from '../../src/plugins/des/rv-des-component-state';
import { lineFixture, runnerFixture } from './runner-fixture';

const supported = allMaterialFlows().filter(d => d.des && !['Agv'].includes(d.type));
it.each(supported.map(d => d.type))('%s: all bound and run own keys are declared', type => {
  const scene = new Scene(), node = new Object3D();
  node.name = 'GuardSubject';
  const config = type === 'Downtime' ? { TargetComponentPath: 'Target' }
    : type === 'Processing' ? { targetComponentPath: 'Target' } : {};
  node.userData.realvirtual = { [type]: config }; scene.add(node);
  if (type === 'Downtime' || type === 'Processing') {
    const target = new Object3D(); target.name = 'Target';
    target.userData.realvirtual = { Station: {} }; scene.add(target);
  }
  if (type === 'ChainTransfer') {
    for (const name of ['Transport-Z', 'Transport-X']) {
      const mesh = new Mesh(new BoxGeometry(1, 0.1, 1)); mesh.name = name; node.add(mesh);
    }
    for (const name of ['Drive-Lin-Y', 'Sensor']) {
      const child = new Object3D(); child.name = name; node.add(child);
    }
  }
  if (type === 'Conveyor') {
    const belt = new Mesh(new BoxGeometry(1, 0.1, 0.2)); belt.name = 'Transport-X';
    const sensor = new Object3D(); sensor.name = 'Sensor'; node.add(belt, sensor);
  }
  if (type === 'PathTransport' || type === 'OverheadConveyor') {
    const path = new Object3D(); path.name = 'Path-Guard';
    path.userData.realvirtual = { Path: { type: 'Path', id: 'c3-' + type,
      segments: [{ kind: 'line', from: [0, 0, 0], to: [10, 0, 0] }] } };
    node.add(path);
    getDefaultPathNetwork().register(pathFromNode(path)!);
    const carrier = new Object3D(); carrier.name = 'Carrier-1'; node.add(carrier);
  }
  const { runner, manager, host } = runnerFixture(scene);
  const adapter = runner.liveInstances.find(i => i.def.type === type)!.adapter;
  const declared = new Set<string>([...componentStateKeys, ...componentServices]);
  const check = () => {
    const keys = Reflect.ownKeys(adapter);
    expect(keys.filter(key => typeof key !== 'string' || !declared.has(key))).toEqual([]);
    expect([...declared].filter(key => !keys.includes(key))).toEqual([]);
    console.info(type, JSON.stringify({ state: keys.filter(k => componentStateKeys.includes(k as never)),
      services: keys.filter(k => componentServices.includes(k as never)) }));
  };
  check();
  runner.start([], { root: scene, host });
  if (['Station', 'Storage', 'Conveyor', 'PathTransport'].includes(type)) {
    expect(adapter.acceptMU(runner.createMU())).toBe(true);
  }
  manager.processAnimated(1);
  check();
  expect(() => runner.fullSnapshot()).not.toThrow();
});
it('production capture refuses an added own property with participant and property', () => {
  const f = lineFixture();
  const id = f.runner.desIdentity().entries.find(c => c.type === 'Source')!.desId;
  Object.defineProperty(f.source, 'hiddenCounter', { value: 42, enumerable: false });
  expect(() => f.snapshot()).toThrow(`des-state-not-declared: ${id}.hiddenCounter`);
});
it.each([new Map([['key', 1]]), new Set([1]), () => 1, NaN])(
  'rejects unschematized behaviour state %# with participant and path', value => {
    const f = lineFixture();
    const original = f.source.def.des!.onSnapshot;
    f.source.def.des!.onSnapshot = () => ({ invalid: value });
    try {
      expect(() => f.snapshot()).toThrow(/des-snapshot-contract.*Source.*behaviourState.invalid/);
    } finally { f.source.def.des!.onSnapshot = original; }
  });

it('preflight rejects a saved event handle with the wrong action before mutation', () => {
  const f = lineFixture({ statResetTime: 30 });
  const saved = f.snapshot();
  const state = saved.parts.find(p => p.key === 'des.manager')!.state as Record<string, unknown>;
  state.warmupEventId = saved.eventQueue.find(e => e.action !== '__warmup__')!.id;
  const time = f.manager.currentTime;
  expect(() => f.restore(saved)).toThrow(/des-snapshot-contract.*event handle.*wrong action/);
  expect(f.manager.currentTime).toBe(time);
});
